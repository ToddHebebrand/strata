use std::path::Path;

use anyhow::{Context, Result, bail};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition, WriteTransaction};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{
    EventRecord, FenceClaim, GraphDelta, GraphGeneration, GraphSnapshot, OperationRecord,
    Publication, PublishFailpoint, TicketRecord,
};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
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
const SERVICE_EPOCH: &str = "service_epoch";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    Published { generation: u64 },
    AlreadyPublished { generation: u64 },
}

pub struct DurableStore {
    database: Database,
}

impl DurableStore {
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            database: Database::create(path).context("create redb database")?,
        })
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            database: Database::open(path).context("open redb database")?,
        })
    }

    pub fn seed(&self, snapshot: &GraphSnapshot) -> Result<()> {
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
        // complete schema atomically, including tables used by later coordination tasks.
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

    pub fn publish(
        &self,
        publication: &Publication,
        expected_digest: &str,
    ) -> Result<PublishOutcome> {
        self.publish_inner(publication, expected_digest, PublishFailpoint::None)
    }

    #[doc(hidden)]
    pub fn publish_with_failpoint(
        &self,
        publication: &Publication,
        expected_digest: &str,
        failpoint: PublishFailpoint,
    ) -> Result<PublishOutcome> {
        self.publish_inner(publication, expected_digest, failpoint)
    }

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

        let (current_generation, current_event_sequence) = {
            let metadata = write.open_table(META).context("open metadata table")?;
            (
                read_metadata(&metadata, CURRENT_GENERATION)?,
                read_metadata(&metadata, CURRENT_EVENT_SEQUENCE)?,
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

        self.verify_fence_in_write_txn(&write, &publication.fence)?;

        let operation = encode(&publication.operation, "operation")?;
        let delta = encode(&publication.delta, "delta")?;
        let ticket = encode(&publication.ticket, "ticket")?;
        let event = encode(&publication.event, "event")?;

        write
            .open_table(OPERATIONS)
            .context("open operations table")?
            .insert(next_generation, operation.as_slice())
            .context("write operation")?;
        write
            .open_table(DELTAS)
            .context("open deltas table")?
            .insert(next_generation, delta.as_slice())
            .context("write delta")?;
        write
            .open_table(TICKETS)
            .context("open tickets table")?
            .insert(publication.ticket.ticket_id.as_str(), ticket.as_slice())
            .context("write ticket")?;
        write
            .open_table(EVENTS)
            .context("open events table")?
            .insert(next_event_sequence, event.as_slice())
            .context("write event")?;
        write
            .open_table(IDEMPOTENCY)
            .context("open idempotency table")?
            .insert(publication.idempotency_key.as_str(), next_generation)
            .context("write idempotency key")?;
        write
            .open_table(GENERATION_DIGESTS)
            .context("open generation digests table")?
            .insert(next_generation, expected_digest)
            .context("write generation digest")?;

        {
            let mut metadata = write.open_table(META).context("open metadata table")?;
            let generation_bytes = next_generation.to_le_bytes();
            let sequence_bytes = next_event_sequence.to_le_bytes();
            metadata
                .insert(CURRENT_GENERATION, generation_bytes.as_slice())
                .context("advance current generation")?;
            metadata
                .insert(CURRENT_EVENT_SEQUENCE, sequence_bytes.as_slice())
                .context("advance event sequence")?;
        }

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
            let current_epoch = read_metadata(&metadata, SERVICE_EPOCH)?;
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

    pub fn verify_fence_in_write_txn(
        &self,
        write_txn: &WriteTransaction,
        claim: &FenceClaim,
    ) -> Result<()> {
        {
            let metadata = write_txn.open_table(META).context("open metadata table")?;
            let current_epoch = read_metadata(&metadata, SERVICE_EPOCH)?;
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
        read_metadata(&metadata, CURRENT_GENERATION)
    }

    pub fn begin_service_epoch(&self) -> Result<u64> {
        let write = self
            .database
            .begin_write()
            .context("begin service epoch transaction")?;
        let next_epoch = {
            let mut metadata = write.open_table(META).context("open metadata table")?;
            let current_epoch = read_metadata(&metadata, SERVICE_EPOCH)?;
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
        let current_generation = read_metadata(&metadata, CURRENT_GENERATION)?;
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
            let current_generation = read_metadata(&metadata, CURRENT_GENERATION)?;
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

    pub fn delta(&self, generation: u64) -> Result<Option<GraphDelta>> {
        self.read_structured(DELTAS, generation, "delta")
    }

    pub fn event(&self, sequence: u64) -> Result<Option<EventRecord>> {
        self.read_structured(EVENTS, sequence, "event")
    }

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

fn read_metadata(
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

#[cfg(test)]
#[derive(Debug, Eq, PartialEq)]
struct TableCounts {
    operations: u64,
    deltas: u64,
    events: u64,
    tickets: u64,
    idempotency: u64,
    generation_digests: u64,
}

#[cfg(test)]
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

#[cfg(test)]
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
}
