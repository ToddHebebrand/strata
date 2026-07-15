use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use redb::{
    Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition,
    WriteTransaction,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use uuid::Uuid;

#[cfg(feature = "coordination-test-api")]
use super::PublicationAttemptRecord;
use super::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, CoordinationEvent, CoordinationEventKind,
    CoordinationTicket, DRAFT_TTL_TICKS, EventCursor, IntentRecord, ReadyOffer, TicketState,
};
use crate::SCHEMA_VERSION;
use crate::storage::{
    META as GRAPH_META, SERVICE_EPOCH, read_current_generation_in_write_txn, read_u64_metadata,
};

const CHANGE_SETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_change_sets");
const INTENTS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_intents");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_tickets");
const READY_OFFERS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_ready_offers");
const ACTIVE_CLAIMS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_active_claims");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("coordination_events");
const EVENT_IDS: TableDefinition<&str, u64> = TableDefinition::new("coordination_event_ids");
const EVENT_CURSORS: TableDefinition<&str, u64> =
    TableDefinition::new("coordination_event_cursors");
const SUBMISSION_IDEMPOTENCY: TableDefinition<&str, &str> =
    TableDefinition::new("coordination_submission_idempotency");
const RESOURCE_CLOCKS: TableDefinition<&str, u64> =
    TableDefinition::new("coordination_resource_clocks");
pub(crate) const PUBLICATION_ATTEMPTS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_publication_attempts");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_metadata");
const NEXT_QUEUE_SEQUENCE: &str = "next_queue_sequence";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";
const SCHEDULER_REVISION: &str = "scheduler_revision";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreateDraftOutcome {
    Created { change_set: ChangeSetRecord },
    Duplicate { change_set: ChangeSetRecord },
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoordinationFailpoint {
    None,
    BeforeCommit,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CoordinationMetadataState {
    pub next_queue_sequence: u64,
    pub current_event_sequence: u64,
    pub scheduler_revision: u64,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CoordinationTableCounts {
    pub change_sets: u64,
    pub intents: u64,
    pub tickets: u64,
    pub ready_offers: u64,
    pub active_claims: u64,
    pub events: u64,
    pub event_ids: u64,
    pub event_cursors: u64,
    pub submission_idempotency: u64,
    pub publication_attempts: u64,
    pub metadata: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct LifecycleTransition {
    pub change_sets: Vec<(Option<ChangeSetRecord>, Option<ChangeSetRecord>)>,
    pub tickets: Vec<(Option<CoordinationTicket>, Option<CoordinationTicket>)>,
    pub offers: Vec<(Option<ReadyOffer>, Option<ReadyOffer>)>,
    pub claims: Vec<(Option<ClaimHandle>, Option<ClaimHandle>)>,
    pub events: Vec<CoordinationEvent>,
    pub expected_metadata: CoordinationMetadataState,
    pub next_metadata: CoordinationMetadataState,
}

pub struct CoordinationDurable<'a> {
    pub(crate) database: &'a Database,
}

impl<'a> CoordinationDurable<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub(crate) fn resource_clocks(&self) -> Result<BTreeMap<String, u64>> {
        let read = self
            .database
            .begin_read()
            .context("begin resource clock read")?;
        let table = read
            .open_table(RESOURCE_CLOCKS)
            .context("open resource clocks table")?;
        let mut clocks = BTreeMap::new();
        for entry in table.iter().context("iterate resource clocks")? {
            let (key, clock) = entry.context("read resource clock entry")?;
            clocks.insert(key.value().to_owned(), clock.value());
        }
        Ok(clocks)
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn publication_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<PublicationAttemptRecord>> {
        let read = self
            .database
            .begin_read()
            .context("begin publication attempt read")?;
        let table = read
            .open_table(PUBLICATION_ATTEMPTS)
            .context("open publication attempts table")?;
        table
            .get(attempt_id)
            .context("read publication attempt")?
            .map(|value| decode(value.value(), "publication attempt"))
            .transpose()
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn persist_publication_attempt_in_write_txn(
        &self,
        write: &WriteTransaction,
        record: &PublicationAttemptRecord,
        on_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        if record.change_set_id.is_empty()
            || record.attempt_id.is_empty()
            || record.candidate_digest.is_empty()
            || record.graph_digest.is_empty()
        {
            bail!("publication attempt fields must be non-empty");
        }
        let mut table = write
            .open_table(PUBLICATION_ATTEMPTS)
            .context("open publication attempts table")?;
        if table
            .get(record.attempt_id.as_str())
            .context("read publication attempt before insert")?
            .is_some()
        {
            bail!("publication attempt already exists: {}", record.attempt_id);
        }
        let bytes = encode(record, "publication attempt")?;
        table
            .insert(record.attempt_id.as_str(), bytes.as_slice())
            .context("persist publication attempt")?;
        on_write()
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn next_resource_clock_updates(
        &self,
        keys: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, u64>> {
        let clocks = self.resource_clocks()?;
        keys.iter()
            .map(|key| {
                let next = clocks
                    .get(key)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(1)
                    .with_context(|| format!("resource clock overflow for {key}"))?;
                Ok((key.clone(), next))
            })
            .collect()
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn persist_resource_clock_updates_in_write_txn(
        &self,
        write: &WriteTransaction,
        updates: &BTreeMap<String, u64>,
    ) -> Result<()> {
        let mut clocks = write
            .open_table(RESOURCE_CLOCKS)
            .context("open resource clocks table")?;
        for (key, update) in updates {
            let current = clocks
                .get(key.as_str())
                .with_context(|| format!("read resource clock for {key}"))?
                .map(|clock| clock.value())
                .unwrap_or(0);
            let expected = current
                .checked_add(1)
                .with_context(|| format!("resource clock overflow for {key}"))?;
            if *update != expected {
                bail!("resource clock update for {key} is {update}, expected exactly {expected}");
            }
            clocks
                .insert(key.as_str(), *update)
                .with_context(|| format!("write resource clock for {key}"))?;
        }
        Ok(())
    }

    pub fn events_after(
        &self,
        client_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<CoordinationEvent>> {
        if limit == 0 {
            bail!("coordination event limit must be greater than zero");
        }
        EventCursor::new(client_id, 0).map_err(anyhow::Error::msg)?;
        let read = self
            .database
            .begin_read()
            .context("begin event replay read")?;
        let acknowledged_sequence = read
            .open_table(EVENT_CURSORS)
            .context("open event cursors table")?
            .get(client_id)
            .context("read event cursor")?
            .map(|cursor| cursor.value())
            .unwrap_or(0);
        let start = after_sequence.max(acknowledged_sequence);
        let events = read.open_table(EVENTS).context("open events table")?;
        let mut replay = Vec::new();
        for entry in events.iter().context("iterate coordination events")? {
            let (sequence, value) = entry.context("read coordination event entry")?;
            if sequence.value() <= start {
                continue;
            }
            replay.push(decode(value.value(), "coordination event")?);
            if replay.len() == limit {
                break;
            }
        }
        Ok(replay)
    }

    pub fn ack_events(&self, client_id: &str, sequence: u64) -> Result<EventCursor> {
        EventCursor::new(client_id, sequence).map_err(anyhow::Error::msg)?;
        let write = self
            .database
            .begin_write()
            .context("begin event acknowledgement transaction")?;
        let current_sequence = {
            let metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?
        };
        if sequence > current_sequence {
            bail!(
                "cannot acknowledge coordination event sequence {sequence} beyond current sequence {current_sequence}"
            );
        }
        let acknowledged_sequence = {
            let mut cursors = write
                .open_table(EVENT_CURSORS)
                .context("open event cursors table")?;
            let existing = cursors
                .get(client_id)
                .context("read event cursor")?
                .map(|cursor| cursor.value())
                .unwrap_or(0);
            let acknowledged = existing.max(sequence);
            cursors
                .insert(client_id, acknowledged)
                .context("write event cursor")?;
            acknowledged
        };
        write
            .commit()
            .context("commit event acknowledgement transaction")?;
        EventCursor::new(client_id, acknowledged_sequence).map_err(anyhow::Error::msg)
    }

    pub(crate) fn begin_service_epoch_and_recover_coordination(&self) -> Result<u64> {
        self.begin_service_epoch_and_recover_coordination_inner(CoordinationFailpoint::None)
    }

    #[doc(hidden)]
    pub fn begin_service_epoch_and_recover_coordination_with_failpoint(
        &self,
        failpoint: CoordinationFailpoint,
    ) -> Result<u64> {
        self.begin_service_epoch_and_recover_coordination_inner(failpoint)
    }

    fn begin_service_epoch_and_recover_coordination_inner(
        &self,
        failpoint: CoordinationFailpoint,
    ) -> Result<u64> {
        let write = self
            .database
            .begin_write()
            .context("begin service epoch and coordination recovery transaction")?;
        let (old_epoch, next_epoch) = {
            let metadata = write
                .open_table(GRAPH_META)
                .context("open metadata table")?;
            let old_epoch = read_u64_metadata(&metadata, SERVICE_EPOCH)?;
            let next_epoch = old_epoch.checked_add(1).context("service epoch overflow")?;
            (old_epoch, next_epoch)
        };
        let graph_generation = read_current_generation_in_write_txn(&write)?;
        let coordination_metadata = {
            let metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            CoordinationMetadataState {
                next_queue_sequence: read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?,
                current_event_sequence: read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
                scheduler_revision: read_u64_metadata(&metadata, SCHEDULER_REVISION)?,
            }
        };
        let mut transition = LifecycleTransition {
            change_sets: Vec::new(),
            tickets: Vec::new(),
            offers: Vec::new(),
            claims: Vec::new(),
            events: Vec::new(),
            expected_metadata: coordination_metadata,
            next_metadata: coordination_metadata,
        };

        let recoverable = {
            let change_sets = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            let mut recoverable = BTreeMap::new();
            for entry in change_sets.iter().context("iterate change sets")? {
                let (_, value) = entry.context("read change set entry")?;
                let change_set: ChangeSetRecord = decode(value.value(), "change set")?;
                if change_set.state == ChangeSetState::Draft && change_set.expires_at_tick.is_none()
                {
                    let mut migrated = change_set.clone();
                    migrated.expires_at_tick = Some(
                        migrated
                            .created_at_tick
                            .checked_add(DRAFT_TTL_TICKS)
                            .context("legacy draft expiry overflow")?,
                    );
                    transition
                        .change_sets
                        .push((Some(change_set.clone()), Some(migrated)));
                }
                if matches!(
                    change_set.state,
                    ChangeSetState::Ready | ChangeSetState::Executing
                ) {
                    recoverable.insert(change_set.change_set_id.clone(), change_set);
                }
            }
            recoverable
        };

        let mut tickets_by_change_set = BTreeMap::new();
        {
            let tickets = write.open_table(TICKETS).context("open tickets table")?;
            for entry in tickets.iter().context("iterate tickets")? {
                let (_, value) = entry.context("read ticket entry")?;
                let ticket: CoordinationTicket = decode(value.value(), "ticket")?;
                if recoverable.contains_key(&ticket.change_set_id)
                    && tickets_by_change_set
                        .insert(ticket.change_set_id.clone(), ticket)
                        .is_some()
                {
                    bail!("recoverable change set has more than one ticket");
                }
            }
        }
        if recoverable.len() != tickets_by_change_set.len() {
            bail!("recoverable change set is missing its ticket");
        }

        let offers = {
            let table = write
                .open_table(READY_OFFERS)
                .context("open ready offers table")?;
            let mut records = BTreeMap::new();
            for entry in table.iter().context("iterate ready offers")? {
                let (_, value) = entry.context("read ready offer entry")?;
                let offer: ReadyOffer = decode(value.value(), "ready offer")?;
                records.insert(offer.offer_id.clone(), offer);
            }
            records
        };
        let claims = {
            let table = write
                .open_table(ACTIVE_CLAIMS)
                .context("open active claims table")?;
            let mut records = BTreeMap::new();
            for entry in table.iter().context("iterate active claims")? {
                let (_, value) = entry.context("read active claim entry")?;
                let claim: ClaimHandle = decode(value.value(), "active claim")?;
                records.insert(claim.claim_id.clone(), claim);
            }
            records
        };

        let mut consumed_offers = BTreeSet::new();
        let mut consumed_claims = BTreeSet::new();
        for (change_set_id, change_set) in &recoverable {
            let ticket = tickets_by_change_set
                .get(change_set_id)
                .context("recoverable change set is missing its ticket")?;
            match change_set.state {
                ChangeSetState::Ready => {
                    if ticket.state != TicketState::Ready || ticket.active_claim_id.is_some() {
                        bail!("Ready change set does not have a matching Ready ticket");
                    }
                    let offer_id = ticket
                        .ready_offer_id
                        .as_ref()
                        .context("Ready ticket has no ready offer ID")?;
                    let offer = offers
                        .get(offer_id)
                        .context("Ready ticket refers to a missing offer")?;
                    if offer.change_set_id != *change_set_id || offer.service_epoch != old_epoch {
                        bail!("Ready offer does not match its prior-epoch change set");
                    }
                    consumed_offers.insert(offer_id.clone());
                    transition.offers.push((Some(offer.clone()), None));
                }
                ChangeSetState::Executing => {
                    if ticket.state != TicketState::Claimed || ticket.ready_offer_id.is_some() {
                        bail!("Executing change set does not have a matching Claimed ticket");
                    }
                    let claim_id = ticket
                        .active_claim_id
                        .as_ref()
                        .context("Claimed ticket has no active claim ID")?;
                    let claim = claims
                        .get(claim_id)
                        .context("Claimed ticket refers to a missing active claim")?;
                    if claim.change_set_id != *change_set_id || claim.service_epoch != old_epoch {
                        bail!("active claim does not match its prior-epoch change set");
                    }
                    consumed_claims.insert(claim_id.clone());
                    transition.claims.push((Some(claim.clone()), None));
                }
                _ => unreachable!("recoverable states were filtered above"),
            }

            let mut next_change_set = change_set.clone();
            next_change_set.state = ChangeSetState::Queued;
            let mut next_ticket = ticket.clone();
            next_ticket.state = TicketState::Queued;
            next_ticket.ready_offer_id = None;
            next_ticket.active_claim_id = None;
            transition
                .change_sets
                .push((Some(change_set.clone()), Some(next_change_set)));
            transition
                .tickets
                .push((Some(ticket.clone()), Some(next_ticket)));

            let event_sequence = transition
                .next_metadata
                .current_event_sequence
                .checked_add(1)
                .context("coordination event sequence overflow")?;
            let payload_json = serde_json::json!({
                "oldServiceEpoch": old_epoch,
                "newServiceEpoch": next_epoch,
            })
            .to_string();
            transition.events.push(
                CoordinationEvent::new(
                    SCHEMA_VERSION,
                    Uuid::new_v4().to_string(),
                    event_sequence,
                    CoordinationEventKind::LeaseExpired,
                    change_set_id,
                    graph_generation,
                    payload_json,
                )
                .map_err(anyhow::Error::msg)?,
            );
            transition.next_metadata.current_event_sequence = event_sequence;
        }
        if consumed_offers.len() != offers.len() || consumed_claims.len() != claims.len() {
            bail!("coordination authority table contains an orphaned record");
        }
        if !transition.change_sets.is_empty()
            || !transition.tickets.is_empty()
            || !transition.offers.is_empty()
            || !transition.claims.is_empty()
        {
            transition.next_metadata.scheduler_revision = transition
                .expected_metadata
                .scheduler_revision
                .checked_add(1)
                .context("scheduler revision overflow")?;
        }

        self.persist_lifecycle_in_write_txn(&write, &transition)?;
        {
            let mut metadata = write
                .open_table(GRAPH_META)
                .context("open metadata table")?;
            let bytes = next_epoch.to_le_bytes();
            metadata
                .insert(SERVICE_EPOCH, bytes.as_slice())
                .context("advance service epoch")?;
        }
        if failpoint == CoordinationFailpoint::BeforeCommit {
            bail!("coordination failpoint before commit");
        }
        write
            .commit()
            .context("commit service epoch and coordination recovery transaction")?;
        Ok(next_epoch)
    }

    pub fn create_draft(&self, record: &ChangeSetRecord) -> Result<CreateDraftOutcome> {
        self.create_draft_inner(record, CoordinationFailpoint::None)
    }

    #[doc(hidden)]
    pub fn create_draft_with_failpoint(
        &self,
        record: &ChangeSetRecord,
        failpoint: CoordinationFailpoint,
    ) -> Result<CreateDraftOutcome> {
        self.create_draft_inner(record, failpoint)
    }

    fn create_draft_inner(
        &self,
        record: &ChangeSetRecord,
        failpoint: CoordinationFailpoint,
    ) -> Result<CreateDraftOutcome> {
        let write = self
            .database
            .begin_write()
            .context("begin create-draft transaction")?;

        let duplicate_change_set_id = {
            let idempotency = write
                .open_table(SUBMISSION_IDEMPOTENCY)
                .context("open submission idempotency table")?;
            idempotency
                .get(record.submission_idempotency_key.as_str())
                .context("read submission idempotency key")?
                .map(|id| id.value().to_owned())
        };
        if let Some(change_set_id) = duplicate_change_set_id {
            let change_sets = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            let value = change_sets
                .get(change_set_id.as_str())
                .context("read idempotent change set")?
                .with_context(|| {
                    format!(
                        "submission idempotency key {} refers to missing change set {change_set_id}",
                        record.submission_idempotency_key
                    )
                })?;
            return Ok(CreateDraftOutcome::Duplicate {
                change_set: decode(value.value(), "change set")?,
            });
        }

        record.validate().map_err(anyhow::Error::msg)?;
        if record.state != ChangeSetState::Draft
            || !record.intent_ids.is_empty()
            || record.inferred_scope.is_some()
            || record.queue_sequence.is_some()
            || record.expansion_count != 0
            || record.blocking_change_set_id.is_some()
            || record.committed_generation.is_some()
        {
            bail!("new change set must be a pristine Draft");
        }
        let encoded = encode(record, "change set")?;
        {
            let mut change_sets = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            if change_sets
                .get(record.change_set_id.as_str())
                .context("read change set")?
                .is_some()
            {
                bail!("change set {} already exists", record.change_set_id);
            }
            change_sets
                .insert(record.change_set_id.as_str(), encoded.as_slice())
                .context("write change set")?;
        }
        write
            .open_table(SUBMISSION_IDEMPOTENCY)
            .context("open submission idempotency table")?
            .insert(
                record.submission_idempotency_key.as_str(),
                record.change_set_id.as_str(),
            )
            .context("write submission idempotency key")?;
        advance_scheduler_revision_in_write_txn(&write)?;
        if failpoint == CoordinationFailpoint::BeforeCommit {
            bail!("coordination failpoint before commit");
        }
        write.commit().context("commit create-draft transaction")?;
        Ok(CreateDraftOutcome::Created {
            change_set: record.clone(),
        })
    }

    pub fn append_intent(&self, intent: &IntentRecord) -> Result<()> {
        intent.validate().map_err(anyhow::Error::msg)?;
        let write = self
            .database
            .begin_write()
            .context("begin append-intent transaction")?;
        let mut change_set: ChangeSetRecord = {
            let change_sets = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            let value = change_sets
                .get(intent.change_set_id.as_str())
                .context("read intent change set")?
                .with_context(|| format!("missing change set {}", intent.change_set_id))?;
            decode(value.value(), "change set")?
        };
        if change_set.state != ChangeSetState::Draft {
            bail!(
                "change set {} is {:?}, not Draft",
                change_set.change_set_id,
                change_set.state
            );
        }
        if intent.base_generation != change_set.base_generation {
            bail!(
                "intent {} base generation {} does not match change set base generation {}",
                intent.intent_id,
                intent.base_generation,
                change_set.base_generation
            );
        }
        {
            let intents = write.open_table(INTENTS).context("open intents table")?;
            if intents
                .get(intent.intent_id.as_str())
                .context("read intent")?
                .is_some()
            {
                bail!("intent {} already exists", intent.intent_id);
            }
        }
        if !change_set.intent_ids.contains(&intent.intent_id) {
            change_set.intent_ids.push(intent.intent_id.clone());
        }
        change_set.validate().map_err(anyhow::Error::msg)?;
        let intent_bytes = encode(intent, "intent")?;
        let change_set_bytes = encode(&change_set, "change set")?;
        write
            .open_table(INTENTS)
            .context("open intents table")?
            .insert(intent.intent_id.as_str(), intent_bytes.as_slice())
            .context("write intent")?;
        write
            .open_table(CHANGE_SETS)
            .context("open change sets table")?
            .insert(
                change_set.change_set_id.as_str(),
                change_set_bytes.as_slice(),
            )
            .context("write change set intent list")?;
        advance_scheduler_revision_in_write_txn(&write)?;
        write.commit().context("commit append-intent transaction")?;
        Ok(())
    }

    pub fn submit(
        &self,
        change_set: &ChangeSetRecord,
        ticket: &CoordinationTicket,
        event: &CoordinationEvent,
    ) -> Result<()> {
        self.submit_inner(change_set, ticket, event, CoordinationFailpoint::None)
    }

    #[doc(hidden)]
    pub fn submit_with_failpoint(
        &self,
        change_set: &ChangeSetRecord,
        ticket: &CoordinationTicket,
        event: &CoordinationEvent,
        failpoint: CoordinationFailpoint,
    ) -> Result<()> {
        self.submit_inner(change_set, ticket, event, failpoint)
    }

    fn submit_inner(
        &self,
        change_set: &ChangeSetRecord,
        ticket: &CoordinationTicket,
        event: &CoordinationEvent,
        failpoint: CoordinationFailpoint,
    ) -> Result<()> {
        change_set.validate().map_err(anyhow::Error::msg)?;
        ticket.validate().map_err(anyhow::Error::msg)?;
        event.validate().map_err(anyhow::Error::msg)?;
        let scope = change_set
            .inferred_scope
            .as_ref()
            .context("submitted change set has no inferred scope")?;
        if change_set.state != ChangeSetState::Queued {
            bail!("submitted change set must be Queued");
        }
        if ticket.state != TicketState::Queued {
            bail!("submitted ticket must be Queued");
        }
        if event.kind != CoordinationEventKind::IntentQueued {
            bail!("submitted event must be IntentQueued");
        }
        if ticket.change_set_id != change_set.change_set_id
            || event.change_set_id != change_set.change_set_id
        {
            bail!("submitted ticket and event must belong to the change set");
        }
        if ticket.scope_fingerprint != scope.scope_fingerprint
            || ticket.reservation_keys != scope.reservation_keys
        {
            bail!("submitted ticket does not match the inferred scope");
        }
        if change_set.queue_sequence != Some(ticket.queue_sequence) {
            bail!("change set and ticket queue sequences do not match");
        }

        let write = self
            .database
            .begin_write()
            .context("begin submit transaction")?;
        let durable_change_set: ChangeSetRecord = {
            let change_sets = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            let value = change_sets
                .get(change_set.change_set_id.as_str())
                .context("read submitted change set")?
                .with_context(|| format!("missing change set {}", change_set.change_set_id))?;
            decode(value.value(), "change set")?
        };
        if durable_change_set.state != ChangeSetState::Draft {
            bail!(
                "change set {} is {:?}, not Draft",
                durable_change_set.change_set_id,
                durable_change_set.state
            );
        }
        if durable_change_set.actor != change_set.actor
            || durable_change_set.reasoning != change_set.reasoning
            || durable_change_set.base_generation != change_set.base_generation
            || durable_change_set.submission_idempotency_key
                != change_set.submission_idempotency_key
            || durable_change_set.intent_ids != change_set.intent_ids
        {
            bail!("submitted change set does not match its durable draft");
        }

        {
            let intents = write.open_table(INTENTS).context("open intents table")?;
            for intent_id in &change_set.intent_ids {
                let value = intents
                    .get(intent_id.as_str())
                    .with_context(|| format!("read intent {intent_id}"))?
                    .with_context(|| format!("missing referenced intent {intent_id}"))?;
                let intent: IntentRecord = decode(value.value(), "intent")?;
                if intent.change_set_id != change_set.change_set_id
                    || intent.base_generation != change_set.base_generation
                {
                    bail!("intent {intent_id} does not match its change set");
                }
            }
        }

        let (next_queue_sequence, current_event_sequence, scheduler_revision) = {
            let metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            (
                read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?,
                read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
                read_u64_metadata(&metadata, SCHEDULER_REVISION)?,
            )
        };
        let current_graph_generation = read_current_generation_in_write_txn(&write)?;
        if ticket.queue_sequence != next_queue_sequence {
            bail!(
                "ticket queue sequence {} does not match next queue sequence {next_queue_sequence}",
                ticket.queue_sequence
            );
        }
        let next_event_sequence = current_event_sequence
            .checked_add(1)
            .context("coordination event sequence overflow")?;
        if event.sequence != next_event_sequence {
            bail!(
                "event sequence {} does not match next event sequence {next_event_sequence}",
                event.sequence
            );
        }
        let canonical_change_set = ChangeSetRecord {
            schema_version: durable_change_set.schema_version,
            change_set_id: durable_change_set.change_set_id.clone(),
            actor: durable_change_set.actor.clone(),
            reasoning: durable_change_set.reasoning.clone(),
            base_generation: durable_change_set.base_generation,
            state: ChangeSetState::Queued,
            submission_idempotency_key: durable_change_set.submission_idempotency_key.clone(),
            intent_ids: durable_change_set.intent_ids.clone(),
            inferred_scope: Some(scope.clone()),
            queue_sequence: Some(next_queue_sequence),
            expansion_count: 0,
            blocking_change_set_id: None,
            committed_generation: None,
            created_at_tick: durable_change_set.created_at_tick,
            expires_at_tick: None,
        };
        let canonical_ticket = CoordinationTicket {
            schema_version: ticket.schema_version,
            ticket_id: ticket.ticket_id.clone(),
            change_set_id: change_set.change_set_id.clone(),
            state: TicketState::Queued,
            scope_fingerprint: scope.scope_fingerprint.clone(),
            reservation_keys: scope.reservation_keys.clone(),
            queue_sequence: next_queue_sequence,
            age_rounds: 0,
            ready_offer_id: None,
            active_claim_id: None,
        };
        if *change_set != canonical_change_set
            || *ticket != canonical_ticket
            || event.graph_generation != current_graph_generation
        {
            bail!("records do not describe a canonical Draft-to-Queued transition");
        }
        let following_queue_sequence = next_queue_sequence
            .checked_add(1)
            .context("coordination queue sequence overflow")?;
        let next_scheduler_revision = scheduler_revision
            .checked_add(1)
            .context("scheduler revision overflow")?;
        {
            let tickets = write.open_table(TICKETS).context("open tickets table")?;
            if tickets
                .get(ticket.ticket_id.as_str())
                .context("read ticket")?
                .is_some()
            {
                bail!("ticket {} already exists", ticket.ticket_id);
            }
        }
        {
            let events = write.open_table(EVENTS).context("open events table")?;
            if events
                .get(event.sequence)
                .context("read coordination event")?
                .is_some()
            {
                bail!(
                    "coordination event sequence {} already exists",
                    event.sequence
                );
            }
        }
        {
            let event_ids = write.open_table(EVENT_IDS).context("open event ID table")?;
            if event_ids
                .get(event.event_id.as_str())
                .context("read coordination event ID")?
                .is_some()
            {
                bail!("coordination event ID already exists: {}", event.event_id);
            }
        }

        let change_set_bytes = encode(change_set, "change set")?;
        let ticket_bytes = encode(ticket, "ticket")?;
        let event_bytes = encode(event, "coordination event")?;
        write
            .open_table(CHANGE_SETS)
            .context("open change sets table")?
            .insert(
                change_set.change_set_id.as_str(),
                change_set_bytes.as_slice(),
            )
            .context("write submitted change set")?;
        write
            .open_table(TICKETS)
            .context("open tickets table")?
            .insert(ticket.ticket_id.as_str(), ticket_bytes.as_slice())
            .context("write ticket")?;
        write
            .open_table(EVENTS)
            .context("open events table")?
            .insert(event.sequence, event_bytes.as_slice())
            .context("write coordination event")?;
        write
            .open_table(EVENT_IDS)
            .context("open event ID table")?
            .insert(event.event_id.as_str(), event.sequence)
            .context("write coordination event ID")?;
        {
            let mut metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            let queue_bytes = following_queue_sequence.to_le_bytes();
            let event_bytes = next_event_sequence.to_le_bytes();
            let revision_bytes = next_scheduler_revision.to_le_bytes();
            metadata
                .insert(NEXT_QUEUE_SEQUENCE, queue_bytes.as_slice())
                .context("advance queue sequence")?;
            metadata
                .insert(CURRENT_EVENT_SEQUENCE, event_bytes.as_slice())
                .context("advance coordination event sequence")?;
            metadata
                .insert(SCHEDULER_REVISION, revision_bytes.as_slice())
                .context("advance scheduler revision")?;
        }

        if failpoint == CoordinationFailpoint::BeforeCommit {
            bail!("coordination failpoint before commit");
        }
        write.commit().context("commit submit transaction")?;
        Ok(())
    }

    pub(crate) fn persist_lifecycle(&self, transition: &LifecycleTransition) -> Result<()> {
        let write = self
            .database
            .begin_write()
            .context("begin coordination lifecycle transaction")?;
        self.persist_lifecycle_in_write_txn(&write, transition)?;
        write
            .commit()
            .context("commit coordination lifecycle transaction")
    }

    pub(crate) fn persist_lifecycle_in_write_txn(
        &self,
        write: &WriteTransaction,
        transition: &LifecycleTransition,
    ) -> Result<()> {
        self.persist_lifecycle_in_write_txn_with_hook(write, transition, &mut || Ok(()))
    }

    pub(crate) fn persist_lifecycle_in_write_txn_with_hook(
        &self,
        write: &WriteTransaction,
        transition: &LifecycleTransition,
        on_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        let durable_metadata = {
            let metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            CoordinationMetadataState {
                next_queue_sequence: read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?,
                current_event_sequence: read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
                scheduler_revision: read_u64_metadata(&metadata, SCHEDULER_REVISION)?,
            }
        };
        if durable_metadata != transition.expected_metadata {
            bail!("coordination metadata changed while preparing lifecycle transition");
        }
        if transition.next_metadata.next_queue_sequence
            < transition.expected_metadata.next_queue_sequence
            || transition.next_metadata.current_event_sequence
                < transition.expected_metadata.current_event_sequence
        {
            bail!("coordination metadata cannot move backward");
        }
        let lifecycle_changed = !transition.change_sets.is_empty()
            || !transition.tickets.is_empty()
            || !transition.offers.is_empty()
            || !transition.claims.is_empty();
        let expected_next_revision = if lifecycle_changed {
            transition
                .expected_metadata
                .scheduler_revision
                .checked_add(1)
                .context("scheduler revision overflow")?
        } else {
            transition.expected_metadata.scheduler_revision
        };
        if transition.next_metadata.scheduler_revision != expected_next_revision {
            bail!("scheduler revision must advance exactly once per lifecycle transition");
        }

        {
            let table = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            for (before, after) in &transition.change_sets {
                let id = update_id(
                    before.as_ref().map(|record| record.change_set_id.as_str()),
                    after.as_ref().map(|record| record.change_set_id.as_str()),
                    "change set",
                )?;
                if let Some(record) = after {
                    record.validate().map_err(anyhow::Error::msg)?;
                }
                let current = table
                    .get(id)
                    .context("read lifecycle change set")?
                    .map(|value| decode(value.value(), "change set"))
                    .transpose()?;
                if current != *before {
                    bail!("change set {id} changed while preparing lifecycle transition");
                }
            }
        }
        {
            let table = write.open_table(TICKETS).context("open tickets table")?;
            for (before, after) in &transition.tickets {
                let id = update_id(
                    before.as_ref().map(|record| record.ticket_id.as_str()),
                    after.as_ref().map(|record| record.ticket_id.as_str()),
                    "ticket",
                )?;
                if let Some(record) = after {
                    record.validate().map_err(anyhow::Error::msg)?;
                }
                let current = table
                    .get(id)
                    .context("read lifecycle ticket")?
                    .map(|value| decode(value.value(), "ticket"))
                    .transpose()?;
                if current != *before {
                    bail!("ticket {id} changed while preparing lifecycle transition");
                }
            }
        }
        {
            let table = write
                .open_table(READY_OFFERS)
                .context("open ready offers table")?;
            for (before, after) in &transition.offers {
                let id = update_id(
                    before.as_ref().map(|record| record.offer_id.as_str()),
                    after.as_ref().map(|record| record.offer_id.as_str()),
                    "ready offer",
                )?;
                if let Some(record) = after {
                    record.validate().map_err(anyhow::Error::msg)?;
                }
                let current = table
                    .get(id)
                    .context("read lifecycle ready offer")?
                    .map(|value| decode(value.value(), "ready offer"))
                    .transpose()?;
                if current != *before {
                    bail!("ready offer {id} changed while preparing lifecycle transition");
                }
            }
        }
        {
            let table = write
                .open_table(ACTIVE_CLAIMS)
                .context("open active claims table")?;
            for (before, after) in &transition.claims {
                let id = update_id(
                    before.as_ref().map(|record| record.claim_id.as_str()),
                    after.as_ref().map(|record| record.claim_id.as_str()),
                    "active claim",
                )?;
                if let Some(record) = after {
                    record.validate().map_err(anyhow::Error::msg)?;
                }
                let current = table
                    .get(id)
                    .context("read lifecycle active claim")?
                    .map(|value| decode(value.value(), "active claim"))
                    .transpose()?;
                if current != *before {
                    bail!("active claim {id} changed while preparing lifecycle transition");
                }
            }
        }

        let current_graph_generation = read_current_generation_in_write_txn(write)?;
        let mut expected_sequence = transition
            .expected_metadata
            .current_event_sequence
            .checked_add(1)
            .context("coordination event sequence overflow")?;
        {
            let events = write.open_table(EVENTS).context("open events table")?;
            let event_ids = write.open_table(EVENT_IDS).context("open event ID table")?;
            for event in &transition.events {
                event.validate().map_err(anyhow::Error::msg)?;
                if event.sequence != expected_sequence {
                    bail!(
                        "coordination event sequence {} does not match expected {expected_sequence}",
                        event.sequence
                    );
                }
                if event.graph_generation != current_graph_generation {
                    bail!("coordination event graph generation is not current");
                }
                if events.get(event.sequence)?.is_some()
                    || event_ids.get(event.event_id.as_str())?.is_some()
                {
                    bail!("coordination event already exists: {}", event.event_id);
                }
                expected_sequence = expected_sequence
                    .checked_add(1)
                    .context("coordination event sequence overflow")?;
            }
        }
        let final_event_sequence = expected_sequence - 1;
        if transition.next_metadata.current_event_sequence != final_event_sequence {
            bail!("next coordination event sequence does not match lifecycle events");
        }

        {
            let mut table = write
                .open_table(CHANGE_SETS)
                .context("open change sets table")?;
            for (before, after) in &transition.change_sets {
                let id = update_id(
                    before.as_ref().map(|record| record.change_set_id.as_str()),
                    after.as_ref().map(|record| record.change_set_id.as_str()),
                    "change set",
                )?;
                if let Some(record) = after {
                    let bytes = encode(record, "change set")?;
                    table.insert(id, bytes.as_slice())?;
                } else {
                    table.remove(id)?;
                }
                on_write()?;
            }
        }
        {
            let mut table = write.open_table(TICKETS).context("open tickets table")?;
            for (before, after) in &transition.tickets {
                let id = update_id(
                    before.as_ref().map(|record| record.ticket_id.as_str()),
                    after.as_ref().map(|record| record.ticket_id.as_str()),
                    "ticket",
                )?;
                if let Some(record) = after {
                    let bytes = encode(record, "ticket")?;
                    table.insert(id, bytes.as_slice())?;
                } else {
                    table.remove(id)?;
                }
                on_write()?;
            }
        }
        {
            let mut table = write
                .open_table(READY_OFFERS)
                .context("open ready offers table")?;
            for (before, after) in &transition.offers {
                let id = update_id(
                    before.as_ref().map(|record| record.offer_id.as_str()),
                    after.as_ref().map(|record| record.offer_id.as_str()),
                    "ready offer",
                )?;
                if let Some(record) = after {
                    let bytes = encode(record, "ready offer")?;
                    table.insert(id, bytes.as_slice())?;
                } else {
                    table.remove(id)?;
                }
                on_write()?;
            }
        }
        {
            let mut table = write
                .open_table(ACTIVE_CLAIMS)
                .context("open active claims table")?;
            for (before, after) in &transition.claims {
                let id = update_id(
                    before.as_ref().map(|record| record.claim_id.as_str()),
                    after.as_ref().map(|record| record.claim_id.as_str()),
                    "active claim",
                )?;
                if let Some(record) = after {
                    let bytes = encode(record, "active claim")?;
                    table.insert(id, bytes.as_slice())?;
                } else {
                    table.remove(id)?;
                }
                on_write()?;
            }
        }
        {
            let mut events = write.open_table(EVENTS).context("open events table")?;
            let mut event_ids = write.open_table(EVENT_IDS).context("open event ID table")?;
            for event in &transition.events {
                let bytes = encode(event, "coordination event")?;
                events.insert(event.sequence, bytes.as_slice())?;
                on_write()?;
                event_ids.insert(event.event_id.as_str(), event.sequence)?;
                on_write()?;
            }
        }
        {
            let mut metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            let queue = transition.next_metadata.next_queue_sequence.to_le_bytes();
            let events = transition
                .next_metadata
                .current_event_sequence
                .to_le_bytes();
            let revision = transition.next_metadata.scheduler_revision.to_le_bytes();
            metadata.insert(NEXT_QUEUE_SEQUENCE, queue.as_slice())?;
            on_write()?;
            metadata.insert(CURRENT_EVENT_SEQUENCE, events.as_slice())?;
            on_write()?;
            metadata.insert(SCHEDULER_REVISION, revision.as_slice())?;
            on_write()?;
        }
        Ok(())
    }

    pub fn change_set(&self, id: &str) -> Result<Option<ChangeSetRecord>> {
        let read = self
            .database
            .begin_read()
            .context("begin change-set read")?;
        let table = read
            .open_table(CHANGE_SETS)
            .context("open change sets table")?;
        let Some(value) = table.get(id).context("read change set")? else {
            return Ok(None);
        };
        decode(value.value(), "change set").map(Some)
    }

    pub(crate) fn all_change_sets(&self) -> Result<Vec<ChangeSetRecord>> {
        let read = self
            .database
            .begin_read()
            .context("begin change-set scan")?;
        let table = read
            .open_table(CHANGE_SETS)
            .context("open change sets table")?;
        let mut change_sets: Vec<ChangeSetRecord> = Vec::new();
        for entry in table.iter().context("iterate change sets")? {
            let (_, value) = entry.context("read change set entry")?;
            change_sets.push(decode(value.value(), "change set")?);
        }
        change_sets.sort_by(|left, right| left.change_set_id.cmp(&right.change_set_id));
        Ok(change_sets)
    }

    pub fn intents_for(&self, change_set_id: &str) -> Result<Vec<IntentRecord>> {
        let read = self.database.begin_read().context("begin intent read")?;
        let change_sets = read
            .open_table(CHANGE_SETS)
            .context("open change sets table")?;
        let Some(change_set_value) = change_sets
            .get(change_set_id)
            .context("read intent change set")?
        else {
            return Ok(Vec::new());
        };
        let change_set: ChangeSetRecord = decode(change_set_value.value(), "change set")?;
        let intents = read.open_table(INTENTS).context("open intents table")?;
        let mut ordered = Vec::with_capacity(change_set.intent_ids.len());
        for intent_id in change_set.intent_ids {
            let value = intents
                .get(intent_id.as_str())
                .with_context(|| format!("read intent {intent_id}"))?
                .with_context(|| {
                    format!("change set {change_set_id} references missing intent {intent_id}")
                })?;
            ordered.push(decode(value.value(), "intent")?);
        }
        Ok(ordered)
    }

    pub fn active_tickets(&self) -> Result<Vec<CoordinationTicket>> {
        let read = self.database.begin_read().context("begin ticket scan")?;
        let table = read.open_table(TICKETS).context("open tickets table")?;
        let mut tickets: Vec<CoordinationTicket> = Vec::new();
        for entry in table.iter().context("iterate tickets")? {
            let (_, value) = entry.context("read ticket entry")?;
            let ticket: CoordinationTicket = decode(value.value(), "ticket")?;
            if !matches!(
                ticket.state,
                TicketState::Completed
                    | TicketState::NeedsDecision
                    | TicketState::Cancelled
                    | TicketState::Failed
            ) {
                tickets.push(ticket);
            }
        }
        tickets.sort_by(|left, right| {
            (left.queue_sequence, &left.ticket_id).cmp(&(right.queue_sequence, &right.ticket_id))
        });
        Ok(tickets)
    }

    pub(crate) fn all_tickets(&self) -> Result<Vec<CoordinationTicket>> {
        let read = self.database.begin_read().context("begin ticket scan")?;
        let table = read.open_table(TICKETS).context("open tickets table")?;
        let mut tickets: Vec<CoordinationTicket> = Vec::new();
        for entry in table.iter().context("iterate tickets")? {
            let (_, value) = entry.context("read ticket entry")?;
            tickets.push(decode(value.value(), "ticket")?);
        }
        tickets.sort_by(|left, right| {
            (left.queue_sequence, &left.ticket_id).cmp(&(right.queue_sequence, &right.ticket_id))
        });
        Ok(tickets)
    }

    pub fn ready_offers(&self) -> Result<Vec<ReadyOffer>> {
        let read = self
            .database
            .begin_read()
            .context("begin ready-offer scan")?;
        let table = read
            .open_table(READY_OFFERS)
            .context("open ready offers table")?;
        let mut offers = Vec::new();
        for entry in table.iter().context("iterate ready offers")? {
            let (_, value) = entry.context("read ready-offer entry")?;
            offers.push(decode(value.value(), "ready offer")?);
        }
        offers.sort_by(|left: &ReadyOffer, right| left.offer_id.cmp(&right.offer_id));
        Ok(offers)
    }

    #[doc(hidden)]
    pub fn ticket(&self, id: &str) -> Result<Option<CoordinationTicket>> {
        let read = self.database.begin_read().context("begin ticket read")?;
        let table = read.open_table(TICKETS).context("open tickets table")?;
        let Some(value) = table.get(id).context("read ticket")? else {
            return Ok(None);
        };
        decode(value.value(), "ticket").map(Some)
    }

    pub fn active_claims(&self) -> Result<Vec<ClaimHandle>> {
        let read = self
            .database
            .begin_read()
            .context("begin active-claim scan")?;
        let table = read
            .open_table(ACTIVE_CLAIMS)
            .context("open active claims table")?;
        let mut claims = Vec::new();
        for entry in table.iter().context("iterate active claims")? {
            let (_, value) = entry.context("read active-claim entry")?;
            claims.push(decode(value.value(), "active claim")?);
        }
        claims.sort_by(|left: &ClaimHandle, right| left.claim_id.cmp(&right.claim_id));
        Ok(claims)
    }

    #[doc(hidden)]
    pub fn event(&self, sequence: u64) -> Result<Option<CoordinationEvent>> {
        let read = self.database.begin_read().context("begin event read")?;
        let table = read.open_table(EVENTS).context("open events table")?;
        let Some(value) = table.get(sequence).context("read coordination event")? else {
            return Ok(None);
        };
        decode(value.value(), "coordination event").map(Some)
    }

    #[doc(hidden)]
    pub fn submission_change_set_id(&self, key: &str) -> Result<Option<String>> {
        let read = self
            .database
            .begin_read()
            .context("begin submission idempotency read")?;
        let table = read
            .open_table(SUBMISSION_IDEMPOTENCY)
            .context("open submission idempotency table")?;
        Ok(table
            .get(key)
            .context("read submission idempotency key")?
            .map(|id| id.value().to_owned()))
    }

    #[doc(hidden)]
    pub fn metadata_state(&self) -> Result<CoordinationMetadataState> {
        let read = self
            .database
            .begin_read()
            .context("begin coordination metadata read")?;
        let metadata = read
            .open_table(META)
            .context("open coordination metadata")?;
        Ok(CoordinationMetadataState {
            next_queue_sequence: read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?,
            current_event_sequence: read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
            scheduler_revision: read_u64_metadata(&metadata, SCHEDULER_REVISION)?,
        })
    }

    #[doc(hidden)]
    pub fn table_counts(&self) -> Result<CoordinationTableCounts> {
        let read = self
            .database
            .begin_read()
            .context("begin coordination count transaction")?;
        Ok(CoordinationTableCounts {
            change_sets: read.open_table(CHANGE_SETS)?.len()?,
            intents: read.open_table(INTENTS)?.len()?,
            tickets: read.open_table(TICKETS)?.len()?,
            ready_offers: read.open_table(READY_OFFERS)?.len()?,
            active_claims: read.open_table(ACTIVE_CLAIMS)?.len()?,
            events: read.open_table(EVENTS)?.len()?,
            event_ids: read.open_table(EVENT_IDS)?.len()?,
            event_cursors: read.open_table(EVENT_CURSORS)?.len()?,
            submission_idempotency: read.open_table(SUBMISSION_IDEMPOTENCY)?.len()?,
            publication_attempts: read.open_table(PUBLICATION_ATTEMPTS)?.len()?,
            metadata: read.open_table(META)?.len()?,
        })
    }
}

fn advance_scheduler_revision_in_write_txn(write: &WriteTransaction) -> Result<u64> {
    let mut metadata = write
        .open_table(META)
        .context("open coordination metadata")?;
    let current = read_u64_metadata(&metadata, SCHEDULER_REVISION)?;
    let next = current
        .checked_add(1)
        .context("scheduler revision overflow")?;
    let bytes = next.to_le_bytes();
    metadata
        .insert(SCHEDULER_REVISION, bytes.as_slice())
        .context("advance scheduler revision")?;
    Ok(next)
}

pub(crate) fn ensure_coordination_schema(database: &Database) -> Result<()> {
    let write = database
        .begin_write()
        .context("begin coordination schema transaction")?;
    {
        let mut metadata = write
            .open_table(META)
            .context("open coordination metadata")?;
        if metadata
            .get(NEXT_QUEUE_SEQUENCE)
            .context("read next queue sequence")?
            .is_none()
        {
            let first = 1_u64.to_le_bytes();
            metadata
                .insert(NEXT_QUEUE_SEQUENCE, first.as_slice())
                .context("initialize next queue sequence")?;
        } else {
            read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?;
        }
        if metadata
            .get(CURRENT_EVENT_SEQUENCE)
            .context("read current event sequence")?
            .is_none()
        {
            let zero = 0_u64.to_le_bytes();
            metadata
                .insert(CURRENT_EVENT_SEQUENCE, zero.as_slice())
                .context("initialize current event sequence")?;
        } else {
            read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?;
        }
        if metadata
            .get(SCHEDULER_REVISION)
            .context("read scheduler revision")?
            .is_none()
        {
            let zero = 0_u64.to_le_bytes();
            metadata
                .insert(SCHEDULER_REVISION, zero.as_slice())
                .context("initialize scheduler revision")?;
        } else {
            read_u64_metadata(&metadata, SCHEDULER_REVISION)?;
        }
    }
    drop(
        write
            .open_table(CHANGE_SETS)
            .context("create change sets table")?,
    );
    drop(write.open_table(INTENTS).context("create intents table")?);
    drop(write.open_table(TICKETS).context("create tickets table")?);
    drop(
        write
            .open_table(READY_OFFERS)
            .context("create ready offers table")?,
    );
    drop(
        write
            .open_table(ACTIVE_CLAIMS)
            .context("create active claims table")?,
    );
    drop(
        write
            .open_table(PUBLICATION_ATTEMPTS)
            .context("create publication attempts table")?,
    );
    drop(
        write
            .open_table(EVENTS)
            .context("create coordination events table")?,
    );
    {
        let events = write
            .open_table(EVENTS)
            .context("open coordination events table")?;
        let mut event_ids = write
            .open_table(EVENT_IDS)
            .context("create coordination event ID table")?;
        for entry in events.iter().context("iterate coordination events")? {
            let (sequence, value) = entry.context("read coordination event entry")?;
            let sequence = sequence.value();
            let event: CoordinationEvent = decode(value.value(), "coordination event")?;
            if let Some(existing) = event_ids
                .get(event.event_id.as_str())
                .context("read coordination event ID")?
            {
                if existing.value() != sequence {
                    bail!(
                        "coordination event ID {} maps to both sequences {} and {sequence}",
                        event.event_id,
                        existing.value()
                    );
                }
            } else {
                event_ids
                    .insert(event.event_id.as_str(), sequence)
                    .context("backfill coordination event ID")?;
            }
        }
    }
    drop(
        write
            .open_table(EVENT_CURSORS)
            .context("create event cursors table")?,
    );
    drop(
        write
            .open_table(SUBMISSION_IDEMPOTENCY)
            .context("create submission idempotency table")?,
    );
    drop(
        write
            .open_table(RESOURCE_CLOCKS)
            .context("create resource clocks table")?,
    );
    write
        .commit()
        .context("commit coordination schema transaction")?;
    Ok(())
}

fn encode<T: Serialize>(value: &T, label: &str) -> Result<Vec<u8>> {
    serde_json::to_vec(value).with_context(|| format!("encode {label}"))
}

fn update_id<'a>(before: Option<&'a str>, after: Option<&'a str>, label: &str) -> Result<&'a str> {
    match (before, after) {
        (Some(before), Some(after)) if before == after => Ok(before),
        (Some(id), None) | (None, Some(id)) => Ok(id),
        (Some(before), Some(after)) => {
            bail!("{label} update changes identity from {before} to {after}")
        }
        (None, None) => bail!("{label} update has no before or after record"),
    }
}

fn decode<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T> {
    serde_json::from_slice(bytes).with_context(|| format!("decode {label}"))
}
