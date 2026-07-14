use std::path::Path;

use anyhow::{Context, Result, bail};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{EventRecord, GraphDelta, GraphSnapshot, OperationRecord, Publication, TicketRecord};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");
const OPERATIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("operations");
const DELTAS: TableDefinition<u64, &[u8]> = TableDefinition::new("deltas");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("events");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("tickets");
const IDEMPOTENCY: TableDefinition<&str, u64> = TableDefinition::new("idempotency_keys");
const FENCES: TableDefinition<&str, u64> = TableDefinition::new("fence_tokens");
const CONSUMED_FENCES: TableDefinition<&str, u64> = TableDefinition::new("consumed_fence_tokens");

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

    pub fn publish(&self, publication: &Publication) -> Result<PublishOutcome> {
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

        write.commit().context("commit publication transaction")?;
        Ok(PublishOutcome::Published {
            generation: next_generation,
        })
    }

    pub fn current_generation(&self) -> Result<u64> {
        let read = self
            .database
            .begin_read()
            .context("begin read transaction")?;
        let metadata = read.open_table(META).context("open metadata table")?;
        read_metadata(&metadata, CURRENT_GENERATION)
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
        })
    }

    fn test_current_generation(&self) -> Result<u64> {
        self.current_generation()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SCHEMA_VERSION;
    use tempfile::tempdir;

    fn empty_snapshot() -> GraphSnapshot {
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
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
}
