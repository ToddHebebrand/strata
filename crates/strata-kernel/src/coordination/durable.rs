use anyhow::{Context, Result, bail};
use redb::{Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::{
    ChangeSetRecord, ChangeSetState, CoordinationEvent, CoordinationEventKind, CoordinationTicket,
    IntentRecord, ReadyOffer, TicketState,
};
use crate::storage::{read_current_generation_in_write_txn, read_u64_metadata};

const CHANGE_SETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_change_sets");
const INTENTS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_intents");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_tickets");
const READY_OFFERS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_ready_offers");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("coordination_events");
const EVENT_IDS: TableDefinition<&str, u64> = TableDefinition::new("coordination_event_ids");
const EVENT_CURSORS: TableDefinition<&str, u64> =
    TableDefinition::new("coordination_event_cursors");
const SUBMISSION_IDEMPOTENCY: TableDefinition<&str, &str> =
    TableDefinition::new("coordination_submission_idempotency");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_metadata");
const NEXT_QUEUE_SEQUENCE: &str = "next_queue_sequence";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";

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
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CoordinationTableCounts {
    pub change_sets: u64,
    pub intents: u64,
    pub tickets: u64,
    pub ready_offers: u64,
    pub events: u64,
    pub event_ids: u64,
    pub event_cursors: u64,
    pub submission_idempotency: u64,
    pub metadata: u64,
}

pub struct CoordinationDurable<'a> {
    pub(crate) database: &'a Database,
}

impl<'a> CoordinationDurable<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
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

        let (next_queue_sequence, current_event_sequence) = {
            let metadata = write
                .open_table(META)
                .context("open coordination metadata")?;
            (
                read_u64_metadata(&metadata, NEXT_QUEUE_SEQUENCE)?,
                read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
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
            metadata
                .insert(NEXT_QUEUE_SEQUENCE, queue_bytes.as_slice())
                .context("advance queue sequence")?;
            metadata
                .insert(CURRENT_EVENT_SEQUENCE, event_bytes.as_slice())
                .context("advance coordination event sequence")?;
        }

        if failpoint == CoordinationFailpoint::BeforeCommit {
            bail!("coordination failpoint before commit");
        }
        write.commit().context("commit submit transaction")?;
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
        let mut tickets = Vec::new();
        for entry in table.iter().context("iterate tickets")? {
            let (_, value) = entry.context("read ticket entry")?;
            let ticket: CoordinationTicket = decode(value.value(), "ticket")?;
            if !matches!(
                ticket.state,
                TicketState::Completed | TicketState::Cancelled | TicketState::Failed
            ) {
                tickets.push(ticket);
            }
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
            events: read.open_table(EVENTS)?.len()?,
            event_ids: read.open_table(EVENT_IDS)?.len()?,
            event_cursors: read.open_table(EVENT_CURSORS)?.len()?,
            submission_idempotency: read.open_table(SUBMISSION_IDEMPOTENCY)?.len()?,
            metadata: read.open_table(META)?.len()?,
        })
    }
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
    write
        .commit()
        .context("commit coordination schema transaction")?;
    Ok(())
}

fn encode<T: Serialize>(value: &T, label: &str) -> Result<Vec<u8>> {
    serde_json::to_vec(value).with_context(|| format!("encode {label}"))
}

fn decode<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T> {
    serde_json::from_slice(bytes).with_context(|| format!("decode {label}"))
}
