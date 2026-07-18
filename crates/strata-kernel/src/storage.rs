use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition, WriteTransaction};
use serde::Serialize;
use serde::de::DeserializeOwned;
#[cfg(feature = "coordination-test-api")]
use sha2::{Digest, Sha256};

#[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
use crate::TicketRecord;
use crate::coordination::{
    CoordinationDurable, RecoveryMigrationPlan, ensure_coordination_schema,
    initialize_coordination_validation_metadata,
};
use crate::coordination::{CoordinationError, LifecycleTransition, PublicationAttemptRecord};
#[cfg(feature = "redb-spike-api")]
use crate::kernel::PublishFailpoint;
use crate::model::{FenceClaim, Publication};
use crate::{EventRecord, GraphDelta, GraphGeneration, GraphSnapshot, OperationRecord};

pub(crate) const META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");
const OPERATIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("operations");
const DELTAS: TableDefinition<u64, &[u8]> = TableDefinition::new("deltas");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("events");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("tickets");
const IDEMPOTENCY: TableDefinition<&str, u64> = TableDefinition::new("idempotency_keys");
const FENCES: TableDefinition<&str, u64> = TableDefinition::new("fence_tokens");
const CONSUMED_FENCES: TableDefinition<&str, u64> = TableDefinition::new("consumed_fence_tokens");
const GENERATION_DIGESTS: TableDefinition<u64, &str> = TableDefinition::new("generation_digests");

const CURRENT_GENERATION: &str = "current_generation";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";
pub(crate) const SERVICE_EPOCH: &str = "service_epoch";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    Published { generation: u64 },
    AlreadyPublished { generation: u64 },
}

pub struct DurableStore {
    database: Database,
}

pub(crate) struct CoordinatedCommit {
    pub publication: Publication,
    pub lifecycle: LifecycleTransition,
    pub service_epoch: u64,
    pub reservation_keys: Vec<String>,
    pub resource_clock_updates: BTreeMap<String, u64>,
    pub publication_attempt: PublicationAttemptRecord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoordinatedPublishFailpoint {
    None,
    AfterFenceMutation,
    AfterInsert(usize),
    AfterResourceClockWrite,
    AfterAttemptWrite,
    BeforeCommit,
}

impl DurableStore {
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        let store = Self {
            database: Database::create(path).context("create redb database")?,
        };
        ensure_coordination_schema(&store.database)?;
        initialize_coordination_validation_metadata(&store.database)?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            database: Database::open(path).context("open redb database")?,
        })
    }

    pub fn seed(&self, snapshot: &GraphSnapshot) -> Result<()> {
        ensure_coordination_schema(&self.database)?;
        if snapshot.generation != 0 {
            bail!("initial snapshot must be generation 0");
        }
        let digest = GraphGeneration::from_snapshot(snapshot.clone())?
            .digest()
            .to_owned();

        let write = self
            .database
            .begin_write()
            .context("begin seed transaction")?;

        {
            let mut metadata = write.open_table(META).context("open metadata table")?;
            if metadata
                .get(CURRENT_GENERATION)
                .context("read current generation")?
                .is_some()
            {
                bail!("durable store is already seeded");
            }

            let zero = 0_u64.to_le_bytes();
            metadata
                .insert(CURRENT_GENERATION, zero.as_slice())
                .context("write current generation")?;
            metadata
                .insert(CURRENT_EVENT_SEQUENCE, zero.as_slice())
                .context("write current event sequence")?;
            metadata
                .insert(SERVICE_EPOCH, zero.as_slice())
                .context("write service epoch")?;
        }

        let snapshot_bytes = encode(snapshot, "snapshot")?;
        write
            .open_table(SNAPSHOTS)
            .context("open snapshots table")?
            .insert(0, snapshot_bytes.as_slice())
            .context("write generation-zero snapshot")?;
        write
            .open_table(GENERATION_DIGESTS)
            .context("open generation digests table")?
            .insert(0, digest.as_str())
            .context("write generation-zero digest")?;

        // Opening a table in a write transaction creates it if absent. Seed establishes the
        // complete graph-publication schema atomically; coordination uses isolated tables.
        drop(
            write
                .open_table(OPERATIONS)
                .context("create operations table")?,
        );
        drop(write.open_table(DELTAS).context("create deltas table")?);
        drop(write.open_table(EVENTS).context("create events table")?);
        drop(write.open_table(TICKETS).context("create tickets table")?);
        drop(
            write
                .open_table(IDEMPOTENCY)
                .context("create idempotency table")?,
        );
        drop(write.open_table(FENCES).context("create fences table")?);
        drop(
            write
                .open_table(CONSUMED_FENCES)
                .context("create consumed fences table")?,
        );

        write.commit().context("commit seed transaction")?;
        Ok(())
    }

    pub fn coordination(&self) -> CoordinationDurable<'_> {
        CoordinationDurable::new(&self.database)
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn publish(
        &self,
        publication: &Publication,
        expected_digest: &str,
    ) -> Result<PublishOutcome> {
        self.publish_inner(publication, expected_digest, PublishFailpoint::None)
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn publish_with_failpoint(
        &self,
        publication: &Publication,
        expected_digest: &str,
        failpoint: PublishFailpoint,
    ) -> Result<PublishOutcome> {
        self.publish_inner(publication, expected_digest, failpoint)
    }

    #[cfg(feature = "redb-spike-api")]
    fn publish_inner(
        &self,
        publication: &Publication,
        expected_digest: &str,
        failpoint: PublishFailpoint,
    ) -> Result<PublishOutcome> {
        if failpoint == PublishFailpoint::BeforeRedbTransaction {
            std::process::abort();
        }
        let write = self
            .database
            .begin_write()
            .context("begin publication transaction")?;

        {
            let idempotency = write
                .open_table(IDEMPOTENCY)
                .context("open idempotency table")?;
            if let Some(generation) = idempotency
                .get(publication.idempotency_key.as_str())
                .context("read idempotency key")?
            {
                return Ok(PublishOutcome::AlreadyPublished {
                    generation: generation.value(),
                });
            }
        }

        self.validate_graph_publication_in_txn(&write, publication)?;
        self.verify_fence_in_write_txn(&write, &publication.fence)?;
        let next_generation = self.write_graph_publication_in_txn_with_hook(
            &write,
            publication,
            expected_digest,
            &mut || Ok(()),
        )?;

        if failpoint == PublishFailpoint::InsideRedbTransaction {
            std::process::abort();
        }
        write.commit().context("commit publication transaction")?;
        if failpoint == PublishFailpoint::AfterRedbCommitBeforeMemoryPublish {
            std::process::abort();
        }
        Ok(PublishOutcome::Published {
            generation: next_generation,
        })
    }

    pub(crate) fn publish_coordinated(
        &self,
        commit: &CoordinatedCommit,
        expected_digest: &str,
        failpoint: CoordinatedPublishFailpoint,
        #[cfg(feature = "redb-spike-api")] crash_failpoint: PublishFailpoint,
    ) -> Result<PublishOutcome> {
        #[cfg(feature = "redb-spike-api")]
        if crash_failpoint == PublishFailpoint::BeforeRedbTransaction {
            std::process::abort();
        }
        let write = self
            .database
            .begin_write()
            .context("begin coordinated publication transaction")?;
        {
            let attempts = write
                .open_table(crate::coordination::PUBLICATION_ATTEMPTS)
                .context("open publication attempts table")?;
            if let Some(value) = attempts
                .get(commit.publication_attempt.attempt_id.as_str())
                .context("read publication attempt")?
            {
                let existing: PublicationAttemptRecord =
                    decode(value.value(), "publication attempt")?;
                if existing.change_set_id != commit.publication_attempt.change_set_id
                    || existing.candidate_digest != commit.publication_attempt.candidate_digest
                {
                    return Err(anyhow::Error::new(CoordinationError::AttemptDigestMismatch));
                }
                return Ok(PublishOutcome::AlreadyPublished {
                    generation: existing.generation,
                });
            }
        }
        {
            let idempotency = write.open_table(IDEMPOTENCY)?;
            if let Some(generation) =
                idempotency.get(commit.publication.idempotency_key.as_str())?
            {
                return Ok(PublishOutcome::AlreadyPublished {
                    generation: generation.value(),
                });
            }
        }
        let (_, next_generation, _) =
            self.validate_graph_publication_in_txn(&write, &commit.publication)?;
        self.issue_and_consume_fences_in_write_txn(
            &write,
            commit.service_epoch,
            &commit.reservation_keys,
        )?;
        if failpoint == CoordinatedPublishFailpoint::AfterFenceMutation {
            bail!("coordinated publication failpoint after fence mutation");
        }
        self.coordination()
            .persist_resource_clock_updates_in_write_txn(&write, &commit.resource_clock_updates)?;
        if !commit.resource_clock_updates.is_empty() {
            self.coordination()
                .mark_clocked_publication_in_write_txn(&write, next_generation)?;
        }
        if failpoint == CoordinatedPublishFailpoint::AfterResourceClockWrite {
            bail!("coordinated publication failpoint after resource clock write");
        }
        let mut insert_count = 0_usize;
        let mut after_insert = || {
            insert_count = insert_count
                .checked_add(1)
                .context("coordinated insert boundary overflow")?;
            if failpoint == CoordinatedPublishFailpoint::AfterInsert(insert_count) {
                bail!("coordinated publication failpoint after insert {insert_count}");
            }
            Ok(())
        };
        let generation = self.write_graph_publication_in_txn_with_hook(
            &write,
            &commit.publication,
            expected_digest,
            &mut after_insert,
        )?;
        self.coordination()
            .persist_lifecycle_in_write_txn_with_hook(
                &write,
                &commit.lifecycle,
                &mut after_insert,
            )?;
        self.coordination()
            .persist_publication_attempt_in_write_txn(
                &write,
                &commit.publication_attempt,
                &mut after_insert,
            )?;
        if failpoint == CoordinatedPublishFailpoint::AfterAttemptWrite {
            bail!("coordinated publication failpoint after attempt write");
        }
        if failpoint == CoordinatedPublishFailpoint::BeforeCommit {
            bail!("coordinated publication failpoint before commit");
        }
        #[cfg(feature = "redb-spike-api")]
        if crash_failpoint == PublishFailpoint::InsideRedbTransaction {
            std::process::abort();
        }
        write
            .commit()
            .context("commit coordinated publication transaction")?;
        #[cfg(feature = "redb-spike-api")]
        if crash_failpoint == PublishFailpoint::AfterRedbCommitBeforeMemoryPublish {
            std::process::abort();
        }
        Ok(PublishOutcome::Published { generation })
    }

    fn write_graph_publication_in_txn_with_hook(
        &self,
        write: &WriteTransaction,
        publication: &Publication,
        expected_digest: &str,
        on_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<u64> {
        let (_, next_generation, next_event_sequence) =
            self.validate_graph_publication_in_txn(write, publication)?;
        let operation = encode(&publication.operation, "operation")?;
        let delta = encode(&publication.delta, "delta")?;
        let ticket = encode(&publication.ticket, "ticket")?;
        let event = encode(&publication.event, "event")?;
        write
            .open_table(OPERATIONS)?
            .insert(next_generation, operation.as_slice())?;
        on_write()?;
        write
            .open_table(DELTAS)?
            .insert(next_generation, delta.as_slice())?;
        on_write()?;
        write
            .open_table(TICKETS)?
            .insert(publication.ticket.ticket_id.as_str(), ticket.as_slice())?;
        on_write()?;
        write
            .open_table(EVENTS)?
            .insert(next_event_sequence, event.as_slice())?;
        on_write()?;
        write
            .open_table(IDEMPOTENCY)?
            .insert(publication.idempotency_key.as_str(), next_generation)?;
        on_write()?;
        write
            .open_table(GENERATION_DIGESTS)?
            .insert(next_generation, expected_digest)?;
        on_write()?;
        {
            let mut metadata = write.open_table(META)?;
            let generation_bytes = next_generation.to_le_bytes();
            let sequence_bytes = next_event_sequence.to_le_bytes();
            metadata.insert(CURRENT_GENERATION, generation_bytes.as_slice())?;
            on_write()?;
            metadata.insert(CURRENT_EVENT_SEQUENCE, sequence_bytes.as_slice())?;
            on_write()?;
        }
        Ok(next_generation)
    }

    fn validate_graph_publication_in_txn(
        &self,
        write: &WriteTransaction,
        publication: &Publication,
    ) -> Result<(u64, u64, u64)> {
        let (current_generation, current_event_sequence) = {
            let metadata = write.open_table(META).context("open metadata table")?;
            (
                read_u64_metadata(&metadata, CURRENT_GENERATION)?,
                read_u64_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
            )
        };
        if publication.delta.base_generation != current_generation {
            bail!(
                "publication base generation {} does not match current generation {}",
                publication.delta.base_generation,
                current_generation
            );
        }
        let next_generation = current_generation
            .checked_add(1)
            .context("graph generation overflow")?;
        let next_event_sequence = current_event_sequence
            .checked_add(1)
            .context("event sequence overflow")?;
        if publication.event.sequence != next_event_sequence {
            bail!(
                "publication event sequence {} does not match next sequence {}",
                publication.event.sequence,
                next_event_sequence
            );
        }
        if publication.event.graph_generation != next_generation {
            bail!(
                "publication event generation {} does not match next generation {}",
                publication.event.graph_generation,
                next_generation
            );
        }
        Ok((current_generation, next_generation, next_event_sequence))
    }

    fn issue_and_consume_fences_in_write_txn(
        &self,
        write: &WriteTransaction,
        service_epoch: u64,
        reservation_keys: &[String],
    ) -> Result<FenceClaim> {
        let current_epoch = {
            let metadata = write.open_table(META)?;
            read_u64_metadata(&metadata, SERVICE_EPOCH)?
        };
        if service_epoch != current_epoch {
            bail!("stale service epoch {service_epoch}; current service epoch is {current_epoch}");
        }
        let resources = reservation_keys
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if resources.is_empty() {
            bail!("coordinated publication requires a non-empty reservation scope");
        }
        let mut resource_tokens = std::collections::BTreeMap::new();
        {
            let mut fences = write.open_table(FENCES)?;
            let mut consumed = write.open_table(CONSUMED_FENCES)?;
            for resource in resources {
                let current = fences
                    .get(resource.as_str())?
                    .map(|value| value.value())
                    .unwrap_or(0);
                let next = current
                    .checked_add(1)
                    .with_context(|| format!("fence token overflow for {resource}"))?;
                fences.insert(resource.as_str(), next)?;
                consumed.insert(resource.as_str(), next)?;
                resource_tokens.insert(resource, next);
            }
        }
        Ok(FenceClaim {
            service_epoch,
            resource_tokens,
        })
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn issue_fence(&self, service_epoch: u64, resources: &[String]) -> Result<FenceClaim> {
        let mut resources = resources.to_vec();
        resources.sort();
        resources.dedup();

        let write = self
            .database
            .begin_write()
            .context("begin fence issuance transaction")?;
        {
            let metadata = write.open_table(META).context("open metadata table")?;
            let current_epoch = read_u64_metadata(&metadata, SERVICE_EPOCH)?;
            if service_epoch != current_epoch {
                bail!(
                    "stale service epoch {service_epoch}; current service epoch is {current_epoch}"
                );
            }
        }

        let mut resource_tokens = std::collections::BTreeMap::new();
        {
            let mut fences = write.open_table(FENCES).context("open fences table")?;
            for resource in resources {
                let current = fences
                    .get(resource.as_str())
                    .with_context(|| format!("read fence token for {resource}"))?
                    .map(|token| token.value())
                    .unwrap_or(0);
                let next = current
                    .checked_add(1)
                    .with_context(|| format!("fence token overflow for {resource}"))?;
                fences
                    .insert(resource.as_str(), next)
                    .with_context(|| format!("write fence token for {resource}"))?;
                resource_tokens.insert(resource, next);
            }
        }

        write
            .commit()
            .context("commit fence issuance transaction")?;
        Ok(FenceClaim {
            service_epoch,
            resource_tokens,
        })
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn verify_fence_in_write_txn(
        &self,
        write_txn: &WriteTransaction,
        claim: &FenceClaim,
    ) -> Result<()> {
        {
            let metadata = write_txn.open_table(META).context("open metadata table")?;
            let current_epoch = read_u64_metadata(&metadata, SERVICE_EPOCH)?;
            if claim.service_epoch != current_epoch {
                bail!(
                    "stale service epoch {}; current service epoch is {current_epoch}",
                    claim.service_epoch
                );
            }
        }

        if claim.resource_tokens.is_empty() {
            bail!("publication fence must claim at least one resource");
        }

        {
            let fences = write_txn.open_table(FENCES).context("open fences table")?;
            let consumed = write_txn
                .open_table(CONSUMED_FENCES)
                .context("open consumed fences table")?;
            for (resource, claimed_token) in &claim.resource_tokens {
                let current_token = fences
                    .get(resource.as_str())
                    .with_context(|| format!("read fence token for {resource}"))?
                    .map(|token| token.value())
                    .unwrap_or(0);
                if *claimed_token != current_token {
                    bail!(
                        "stale fence for {resource}: claimed token {claimed_token}, current token {current_token}"
                    );
                }

                let consumed_token = consumed
                    .get(resource.as_str())
                    .with_context(|| format!("read consumed fence token for {resource}"))?
                    .map(|token| token.value())
                    .unwrap_or(0);
                if *claimed_token <= consumed_token {
                    bail!(
                        "consumed fence for {resource}: claimed token {claimed_token}, consumed through {consumed_token}"
                    );
                }
            }
        }

        let mut consumed = write_txn
            .open_table(CONSUMED_FENCES)
            .context("open consumed fences table")?;
        for (resource, claimed_token) in &claim.resource_tokens {
            consumed
                .insert(resource.as_str(), *claimed_token)
                .with_context(|| format!("consume fence token for {resource}"))?;
        }
        Ok(())
    }

    pub fn current_generation(&self) -> Result<u64> {
        let read = self
            .database
            .begin_read()
            .context("begin read transaction")?;
        let metadata = read.open_table(META).context("open metadata table")?;
        read_u64_metadata(&metadata, CURRENT_GENERATION)
    }

    pub fn begin_service_epoch(&self) -> Result<u64> {
        let write = self
            .database
            .begin_write()
            .context("begin service epoch transaction")?;
        let next_epoch = {
            let mut metadata = write.open_table(META).context("open metadata table")?;
            let current_epoch = read_u64_metadata(&metadata, SERVICE_EPOCH)?;
            let next_epoch = current_epoch
                .checked_add(1)
                .context("service epoch overflow")?;
            let bytes = next_epoch.to_le_bytes();
            metadata
                .insert(SERVICE_EPOCH, bytes.as_slice())
                .context("advance service epoch")?;
            next_epoch
        };
        write.commit().context("commit service epoch transaction")?;
        Ok(next_epoch)
    }

    pub(crate) fn begin_service_epoch_and_recover_coordination_with_validation(
        &self,
        migration: Option<RecoveryMigrationPlan>,
    ) -> Result<u64> {
        self.coordination()
            .begin_service_epoch_and_recover_coordination(migration)
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn begin_service_epoch_and_recover_coordination_with_failpoint(
        &self,
        failpoint: crate::CoordinationFailpoint,
    ) -> Result<u64> {
        self.coordination()
            .begin_service_epoch_and_recover_coordination_with_failpoint(failpoint)
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn begin_service_epoch_and_recover_coordination_with_migration_and_failpoint(
        &self,
        migration: crate::coordination::RecoveryValidationMigration,
        failpoint: crate::CoordinationFailpoint,
    ) -> Result<u64> {
        self.coordination()
            .begin_service_epoch_and_recover_coordination_with_migration_and_failpoint(
                migration, failpoint,
            )
    }

    pub fn latest_snapshot(&self) -> Result<GraphSnapshot> {
        let read = self
            .database
            .begin_read()
            .context("begin snapshot read transaction")?;
        let table = read.open_table(SNAPSHOTS).context("open snapshots table")?;
        let entry = table
            .iter()
            .context("iterate snapshots")?
            .next_back()
            .context("durable store has no graph snapshot")?
            .context("read latest snapshot")?;
        let key_generation = entry.0.value();
        let snapshot: GraphSnapshot = decode(entry.1.value(), "snapshot")?;
        if snapshot.generation != key_generation {
            bail!(
                "snapshot key generation {key_generation} does not match payload generation {}",
                snapshot.generation
            );
        }
        Ok(snapshot)
    }

    pub fn deltas_after(&self, generation: u64) -> Result<Vec<(u64, GraphDelta)>> {
        let read = self
            .database
            .begin_read()
            .context("begin delta scan transaction")?;
        let metadata = read.open_table(META).context("open metadata table")?;
        let current_generation = read_u64_metadata(&metadata, CURRENT_GENERATION)?;
        if generation > current_generation {
            bail!(
                "delta scan starts at generation {generation}, beyond current generation {current_generation}"
            );
        }

        let table = read.open_table(DELTAS).context("open deltas table")?;
        let mut expected_generation = generation
            .checked_add(1)
            .context("graph generation overflow")?;
        let mut deltas = Vec::new();
        for entry in table.iter().context("iterate deltas")? {
            let (key, value) = entry.context("read delta entry")?;
            let delta_generation = key.value();
            if delta_generation <= generation {
                continue;
            }
            if delta_generation != expected_generation {
                bail!(
                    "delta log gap: expected generation {expected_generation}, found generation {delta_generation}"
                );
            }
            let delta = decode(value.value(), "delta")?;
            deltas.push((delta_generation, delta));
            expected_generation = expected_generation
                .checked_add(1)
                .context("graph generation overflow")?;
        }

        if expected_generation <= current_generation {
            bail!("delta log gap: expected generation {expected_generation}");
        }
        Ok(deltas)
    }

    pub(crate) fn graph_generation(&self, generation: u64) -> Result<GraphGeneration> {
        let current_generation = self.current_generation()?;
        if generation > current_generation {
            bail!(
                "requested graph generation {generation} exceeds current generation {current_generation}"
            );
        }
        let read = self
            .database
            .begin_read()
            .context("begin historical snapshot read")?;
        let snapshots = read.open_table(SNAPSHOTS).context("open snapshots table")?;
        let mut selected = None;
        for entry in snapshots.iter().context("iterate historical snapshots")? {
            let (key, value) = entry.context("read historical snapshot")?;
            if key.value() > generation {
                break;
            }
            selected = Some(decode::<GraphSnapshot>(value.value(), "snapshot")?);
        }
        let snapshot = selected.with_context(|| {
            format!("no durable snapshot exists at or before generation {generation}")
        })?;
        let snapshot_generation = snapshot.generation;
        let mut graph = GraphGeneration::from_snapshot(snapshot)?;
        let expected_snapshot_digest = self.generation_digest(snapshot_generation)?;
        if graph.digest() != expected_snapshot_digest {
            bail!(
                "historical snapshot digest {} does not match durable digest {expected_snapshot_digest}",
                graph.digest()
            );
        }
        for (delta_generation, delta) in self.deltas_after(snapshot_generation)? {
            if delta_generation > generation {
                break;
            }
            if delta.base_generation != graph.generation() {
                bail!(
                    "historical delta at generation {delta_generation} has base generation {}, expected {}",
                    delta.base_generation,
                    graph.generation()
                );
            }
            graph = graph.apply(&delta)?;
            let expected_digest = self.generation_digest(delta_generation)?;
            if graph.digest() != expected_digest {
                bail!(
                    "historical replay digest {} does not match durable digest {expected_digest} for generation {delta_generation}",
                    graph.digest()
                );
            }
        }
        if graph.generation() != generation {
            bail!(
                "historical replay ended at generation {}, expected {generation}",
                graph.generation()
            );
        }
        Ok(graph)
    }

    pub fn write_snapshot(&self, snapshot: &GraphSnapshot) -> Result<()> {
        let snapshot_digest = GraphGeneration::from_snapshot(snapshot.clone())?
            .digest()
            .to_owned();
        let snapshot_bytes = encode(snapshot, "snapshot")?;
        let write = self
            .database
            .begin_write()
            .context("begin snapshot write transaction")?;
        {
            let metadata = write.open_table(META).context("open metadata table")?;
            let current_generation = read_u64_metadata(&metadata, CURRENT_GENERATION)?;
            if snapshot.generation > current_generation {
                bail!(
                    "snapshot generation {} exceeds current generation {current_generation}",
                    snapshot.generation
                );
            }
        }
        {
            let digests = write
                .open_table(GENERATION_DIGESTS)
                .context("open generation digests table")?;
            let expected_digest = digests
                .get(snapshot.generation)
                .context("read generation digest")?
                .with_context(|| {
                    format!(
                        "missing durable digest for snapshot generation {}",
                        snapshot.generation
                    )
                })?;
            if snapshot_digest != expected_digest.value() {
                bail!(
                    "snapshot digest {snapshot_digest} does not match durable digest {} for generation {}",
                    expected_digest.value(),
                    snapshot.generation
                );
            }
        }
        write
            .open_table(SNAPSHOTS)
            .context("open snapshots table")?
            .insert(snapshot.generation, snapshot_bytes.as_slice())
            .context("write snapshot")?;
        write.commit().context("commit snapshot transaction")?;
        Ok(())
    }

    pub fn operation(&self, generation: u64) -> Result<Option<OperationRecord>> {
        self.read_structured(OPERATIONS, generation, "operation")
    }

    /// Finds one committed operation by its opaque operation ID, scanning the
    /// durable operations table from earliest to latest generation and
    /// returning the first match with its generation key. Linear in history:
    /// acceptable because operation lookups are an infrequent audit read, not
    /// a hot coordination path.
    pub fn operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>> {
        let read = self
            .database
            .begin_read()
            .context("begin operation lookup transaction")?;
        let table = read
            .open_table(OPERATIONS)
            .context("open operations table")?;
        for entry in table.iter().context("iterate operations")? {
            let (key, value) = entry.context("read operation entry")?;
            let record: OperationRecord = decode(value.value(), "operation")?;
            if record.operation_id == operation_id {
                return Ok(Some((key.value(), record)));
            }
        }
        Ok(None)
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn test_canonical_graph_digest(&self) -> Result<String> {
        let read = self
            .database
            .begin_read()
            .context("begin canonical graph read")?;
        let mut digest = Sha256::new();
        macro_rules! hash_str_bytes {
            ($definition:expr) => {{
                digest.update(stringify!($definition).as_bytes());
                let table = read.open_table($definition)?;
                for entry in table.iter()? {
                    let (key, value) = entry?;
                    digest.update(key.value().as_bytes());
                    digest.update([0]);
                    digest.update(value.value());
                    digest.update([0]);
                }
            }};
        }
        macro_rules! hash_u64_bytes {
            ($definition:expr) => {{
                digest.update(stringify!($definition).as_bytes());
                let table = read.open_table($definition)?;
                for entry in table.iter()? {
                    let (key, value) = entry?;
                    digest.update(key.value().to_le_bytes());
                    digest.update(value.value());
                    digest.update([0]);
                }
            }};
        }
        macro_rules! hash_str_u64 {
            ($definition:expr) => {{
                digest.update(stringify!($definition).as_bytes());
                let table = read.open_table($definition)?;
                for entry in table.iter()? {
                    let (key, value) = entry?;
                    digest.update(key.value().as_bytes());
                    digest.update([0]);
                    digest.update(value.value().to_le_bytes());
                }
            }};
        }
        hash_str_bytes!(META);
        hash_u64_bytes!(SNAPSHOTS);
        hash_u64_bytes!(OPERATIONS);
        hash_u64_bytes!(DELTAS);
        hash_u64_bytes!(EVENTS);
        hash_str_bytes!(TICKETS);
        hash_str_u64!(IDEMPOTENCY);
        hash_str_u64!(FENCES);
        hash_str_u64!(CONSUMED_FENCES);
        digest.update(stringify!(GENERATION_DIGESTS).as_bytes());
        let table = read.open_table(GENERATION_DIGESTS)?;
        for entry in table.iter()? {
            let (key, value) = entry?;
            digest.update(key.value().to_le_bytes());
            digest.update(value.value().as_bytes());
            digest.update([0]);
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn atomic_graph_table_counts(&self) -> Result<(u64, String, u64, u64)> {
        use redb::ReadableTableMetadata;

        let read = self
            .database
            .begin_read()
            .context("begin atomic graph count transaction")?;
        let generation = self.current_generation()?;
        Ok((
            generation,
            self.generation_digest(generation)?,
            read.open_table(OPERATIONS)?.len()?,
            read.open_table(EVENTS)?.len()?,
        ))
    }

    pub fn delta(&self, generation: u64) -> Result<Option<GraphDelta>> {
        self.read_structured(DELTAS, generation, "delta")
    }

    pub fn event(&self, sequence: u64) -> Result<Option<EventRecord>> {
        self.read_structured(EVENTS, sequence, "event")
    }

    #[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub fn ticket(&self, ticket_id: &str) -> Result<Option<TicketRecord>> {
        let read = self
            .database
            .begin_read()
            .context("begin read transaction")?;
        let table = read.open_table(TICKETS).context("open tickets table")?;
        let Some(value) = table.get(ticket_id).context("read ticket")? else {
            return Ok(None);
        };
        decode(value.value(), "ticket").map(Some)
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn was_published(&self, idempotency_key: &str) -> Result<bool> {
        let read = self
            .database
            .begin_read()
            .context("begin read transaction")?;
        let table = read
            .open_table(IDEMPOTENCY)
            .context("open idempotency table")?;
        Ok(table
            .get(idempotency_key)
            .context("read idempotency key")?
            .is_some())
    }

    #[doc(hidden)]
    #[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub fn idempotency_generation(&self, idempotency_key: &str) -> Result<Option<u64>> {
        let read = self
            .database
            .begin_read()
            .context("begin idempotency read transaction")?;
        let table = read
            .open_table(IDEMPOTENCY)
            .context("open idempotency table")?;
        Ok(table
            .get(idempotency_key)
            .context("read idempotency generation")?
            .map(|generation| generation.value()))
    }

    #[doc(hidden)]
    #[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub fn fence_state(&self, resource: &str) -> Result<(Option<u64>, Option<u64>)> {
        let read = self
            .database
            .begin_read()
            .context("begin fence state read transaction")?;
        let fences = read.open_table(FENCES).context("open fences table")?;
        let consumed = read
            .open_table(CONSUMED_FENCES)
            .context("open consumed fences table")?;
        let current = fences
            .get(resource)
            .with_context(|| format!("read fence token for {resource}"))?
            .map(|token| token.value());
        let consumed = consumed
            .get(resource)
            .with_context(|| format!("read consumed fence token for {resource}"))?
            .map(|token| token.value());
        Ok((current, consumed))
    }

    pub fn generation_digest(&self, generation: u64) -> Result<String> {
        let read = self
            .database
            .begin_read()
            .context("begin generation digest read transaction")?;
        let table = read
            .open_table(GENERATION_DIGESTS)
            .context("open generation digests table")?;
        let digest = table
            .get(generation)
            .context("read generation digest")?
            .with_context(|| format!("missing durable digest for generation {generation}"))?;
        Ok(digest.value().to_owned())
    }

    fn read_structured<T: DeserializeOwned>(
        &self,
        definition: TableDefinition<u64, &[u8]>,
        key: u64,
        label: &'static str,
    ) -> Result<Option<T>> {
        let read = self
            .database
            .begin_read()
            .context("begin read transaction")?;
        let table = read.open_table(definition).context("open durable table")?;
        let Some(value) = table.get(key).with_context(|| format!("read {label}"))? else {
            return Ok(None);
        };
        decode(value.value(), label).map(Some)
    }
}

fn encode<T: Serialize>(value: &T, label: &str) -> Result<Vec<u8>> {
    serde_json::to_vec(value).with_context(|| format!("encode {label}"))
}

fn decode<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T> {
    serde_json::from_slice(bytes).with_context(|| format!("decode {label}"))
}

pub(crate) fn read_u64_metadata(
    table: &impl ReadableTable<&'static str, &'static [u8]>,
    key: &'static str,
) -> Result<u64> {
    let value = table
        .get(key)
        .with_context(|| format!("read metadata key {key}"))?
        .with_context(|| format!("missing metadata key {key}"))?;
    let bytes = value.value();
    let bytes: [u8; 8] = bytes
        .try_into()
        .with_context(|| format!("metadata key {key} must contain exactly eight bytes"))?;
    Ok(u64::from_le_bytes(bytes))
}

pub(crate) fn read_current_generation_in_write_txn(write: &WriteTransaction) -> Result<u64> {
    let metadata = write
        .open_table(META)
        .context("open graph metadata table")?;
    read_u64_metadata(&metadata, CURRENT_GENERATION)
}

#[cfg(all(test, feature = "redb-spike-api"))]
#[derive(Debug, Eq, PartialEq)]
struct TableCounts {
    operations: u64,
    deltas: u64,
    events: u64,
    tickets: u64,
    idempotency: u64,
    generation_digests: u64,
}

#[cfg(all(test, feature = "redb-spike-api"))]
impl DurableStore {
    fn table_counts(&self) -> Result<TableCounts> {
        use redb::ReadableTableMetadata;

        let read = self
            .database
            .begin_read()
            .context("begin count transaction")?;
        Ok(TableCounts {
            operations: read.open_table(OPERATIONS)?.len()?,
            deltas: read.open_table(DELTAS)?.len()?,
            events: read.open_table(EVENTS)?.len()?,
            tickets: read.open_table(TICKETS)?.len()?,
            idempotency: read.open_table(IDEMPOTENCY)?.len()?,
            generation_digests: read.open_table(GENERATION_DIGESTS)?.len()?,
        })
    }

    fn test_current_generation(&self) -> Result<u64> {
        self.current_generation()
    }
}

#[cfg(all(test, feature = "redb-spike-api"))]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{FenceClaim, OperationRecord, SCHEMA_VERSION, TicketRecord};
    use tempfile::tempdir;

    fn empty_snapshot() -> GraphSnapshot {
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        }
    }

    fn invalid_sequence_publication() -> Publication {
        Publication {
            schema_version: SCHEMA_VERSION,
            idempotency_key: "publish:invalid-sequence".into(),
            delta: GraphDelta {
                schema_version: SCHEMA_VERSION,
                base_generation: 0,
                changes: vec![],
            },
            operation: OperationRecord {
                operation_id: "operation:invalid".into(),
                change_set_id: "change-set:invalid".into(),
                actor: "agent:test".into(),
                kind: "RenameSymbol".into(),
                reasoning: "exercise atomic rejection".into(),
                affected_node_ids: vec!["node:clock".into()],
                renames: Vec::new(),
                intents: Vec::new(),
            },
            ticket: TicketRecord {
                ticket_id: "ticket:invalid".into(),
                state: "published".into(),
                scope_fingerprint: "scope:clock".into(),
            },
            event: EventRecord {
                event_id: "event:invalid".into(),
                sequence: 2,
                kind: "PublicationCommitted".into(),
                graph_generation: 1,
                payload_json: "{}".into(),
            },
            fence: FenceClaim {
                service_epoch: 0,
                resource_tokens: BTreeMap::new(),
            },
        }
    }

    #[test]
    fn seed_creates_empty_publication_tables_and_generation_zero() {
        let directory = tempdir().unwrap();
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        store.seed(&empty_snapshot()).unwrap();

        assert_eq!(store.test_current_generation().unwrap(), 0);
        assert_eq!(
            store.table_counts().unwrap(),
            TableCounts {
                operations: 0,
                deltas: 0,
                events: 0,
                tickets: 0,
                idempotency: 0,
                generation_digests: 1,
            }
        );
    }

    #[test]
    fn metadata_values_must_be_exactly_eight_bytes() {
        let directory = tempdir().unwrap();
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        store.seed(&empty_snapshot()).unwrap();

        let write = store.database.begin_write().unwrap();
        {
            let mut metadata = write.open_table(META).unwrap();
            metadata
                .insert(CURRENT_GENERATION, [0_u8; 7].as_slice())
                .unwrap();
        }
        write.commit().unwrap();

        let error = store.current_generation().unwrap_err();
        assert!(error.to_string().contains("exactly eight bytes"));
    }

    #[test]
    fn rejected_publication_preserves_generation_and_every_table_count() {
        let directory = tempdir().unwrap();
        let store = DurableStore::create(directory.path().join("kernel.redb")).unwrap();
        store.seed(&empty_snapshot()).unwrap();
        let generation_before = store.test_current_generation().unwrap();
        let counts_before = store.table_counts().unwrap();

        let error = store
            .publish(&invalid_sequence_publication(), "must-not-be-written")
            .unwrap_err();

        assert!(error.to_string().contains("event sequence"));
        assert_eq!(store.test_current_generation().unwrap(), generation_before);
        assert_eq!(store.table_counts().unwrap(), counts_before);
    }

    /// Canonical history predates the `intents` field on `OperationRecord`.
    /// A durable operations-table entry written before this field existed
    /// must still recover as a valid record with empty `intents`, not a
    /// decode failure, once the store is reopened.
    #[test]
    fn old_operation_record_without_intents_field_recovers_with_empty_intents() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let legacy_operation_json = br#"{"operationId":"op-1","changeSetId":"cs-1","actor":"a",
            "kind":"RenameSymbol","reasoning":"r","affectedNodeIds":[],"renames":[]}"#;

        {
            let store = DurableStore::create(&path).unwrap();
            store.seed(&empty_snapshot()).unwrap();
            let write = store.database.begin_write().unwrap();
            {
                let mut operations = write.open_table(OPERATIONS).unwrap();
                operations
                    .insert(1_u64, legacy_operation_json.as_slice())
                    .unwrap();
            }
            write.commit().unwrap();
        }

        let reopened = DurableStore::open(&path).unwrap();
        let record = reopened
            .operation(1)
            .unwrap()
            .expect("legacy operation record recovers");
        assert!(record.intents.is_empty());
        assert_eq!(record.operation_id, "op-1");
    }
}
