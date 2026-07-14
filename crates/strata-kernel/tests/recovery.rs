use redb::{Database, ReadableTable, TableDefinition};
use strata_kernel::{
    EventRecord, FenceClaim, GraphChange, GraphDelta, GraphSnapshot, Kernel, NodeRecord,
    OperationRecord, Publication, ReferenceRecord, SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir;

const DELTAS: TableDefinition<u64, &[u8]> = TableDefinition::new("deltas");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");

fn initial_snapshot() -> GraphSnapshot {
    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![
            NodeRecord {
                id: "node:clock".into(),
                kind: "InterfaceDeclaration".into(),
                parent_id: None,
                child_index: Some(0),
                payload: "export interface Clock {}".into(),
            },
            NodeRecord {
                id: "node:use-clock".into(),
                kind: "Identifier".into(),
                parent_id: None,
                child_index: Some(1),
                payload: "Clock".into(),
            },
        ],
        references: vec![ReferenceRecord {
            from_node_id: "node:use-clock".into(),
            to_node_id: "node:clock".into(),
            kind: "symbol".into(),
        }],
    }
}

fn publication(generation: u64, payload: &str, fence: FenceClaim) -> Publication {
    let next_generation = generation + 1;
    Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: format!("publish:{next_generation}"),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: generation,
            changes: vec![GraphChange::UpsertNode {
                node: NodeRecord {
                    id: "node:clock".into(),
                    kind: "InterfaceDeclaration".into(),
                    parent_id: None,
                    child_index: Some(0),
                    payload: payload.into(),
                },
            }],
        },
        operation: OperationRecord {
            operation_id: format!("operation:{next_generation}"),
            change_set_id: format!("change-set:{next_generation}"),
            actor: "agent:test".into(),
            kind: "RenameSymbol".into(),
            reasoning: "exercise recovery".into(),
            affected_node_ids: vec!["node:clock".into()],
        },
        ticket: TicketRecord {
            ticket_id: format!("ticket:{next_generation}"),
            state: "published".into(),
            scope_fingerprint: "scope:clock".into(),
        },
        event: EventRecord {
            event_id: format!("event:{next_generation}"),
            sequence: next_generation,
            kind: "PublicationCommitted".into(),
            graph_generation: next_generation,
            payload_json: format!(r#"{{"operationId":"operation:{next_generation}"}}"#),
        },
        fence,
    }
}

fn seed_two_generations(database_path: &std::path::Path) -> (GraphSnapshot, GraphSnapshot) {
    let (kernel, create_report) = Kernel::create(database_path, initial_snapshot()).unwrap();
    assert_eq!(create_report.service_epoch, 1);

    let first_fence = kernel.issue_fence(&["symbol:Clock".into()]).unwrap();
    kernel
        .publish(publication(
            0,
            "export interface TimeSource {}",
            first_fence,
        ))
        .unwrap();
    let generation_one = kernel.snapshot().snapshot();
    let second_fence = kernel.issue_fence(&["symbol:Clock".into()]).unwrap();
    kernel
        .publish(publication(
            1,
            "export interface SystemClock {}",
            second_fence,
        ))
        .unwrap();
    let generation_two = kernel.snapshot().snapshot();
    kernel.write_snapshot(&generation_one).unwrap();
    (generation_one, generation_two)
}

#[test]
fn restart_recovers_latest_snapshot_and_replays_later_deltas() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (_, expected) = seed_two_generations(&database_path);

    let (reopened, report) = Kernel::open(&database_path).unwrap();

    assert_eq!(report.snapshot_generation, 1);
    assert_eq!(report.replayed_operations, 1);
    assert_eq!(report.generation, 2);
    assert_eq!(report.service_epoch, 2);
    assert_eq!(report.digest, reopened.snapshot().digest());
    assert_eq!(reopened.snapshot().snapshot(), expected);
    assert_eq!(
        reopened.snapshot().node("node:clock").unwrap().payload,
        "export interface SystemClock {}"
    );
    assert_eq!(reopened.snapshot().references_to("node:clock").count(), 1);
}

#[test]
fn restart_rejects_a_missing_delta_with_the_expected_generation() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    seed_two_generations(&database_path);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut deltas = write.open_table(DELTAS).unwrap();
        deltas.remove(2).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open(&database_path)
        .err()
        .expect("opening must fail");
    assert!(
        error.to_string().contains("expected generation 2"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn restart_rejects_a_delta_whose_base_does_not_match_replay_generation() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    seed_two_generations(&database_path);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut deltas = write.open_table(DELTAS).unwrap();
        let encoded = deltas.get(2).unwrap().unwrap().value().to_vec();
        let mut delta: GraphDelta = serde_json::from_slice(&encoded).unwrap();
        delta.base_generation = 0;
        let corrupted = serde_json::to_vec(&delta).unwrap();
        deltas.insert(2, corrupted.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open(&database_path)
        .err()
        .expect("opening must fail");
    assert!(
        error.to_string().contains("expected generation 1"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn restart_rejects_a_structurally_valid_delta_that_changes_the_committed_digest() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    seed_two_generations(&database_path);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut deltas = write.open_table(DELTAS).unwrap();
        let encoded = deltas.get(2).unwrap().unwrap().value().to_vec();
        let mut delta: GraphDelta = serde_json::from_slice(&encoded).unwrap();
        delta.changes = vec![GraphChange::UpsertNode {
            node: NodeRecord {
                id: "node:clock".into(),
                kind: "InterfaceDeclaration".into(),
                parent_id: None,
                child_index: Some(0),
                payload: "export interface CorruptedButValid {}".into(),
            },
        }];
        let corrupted = serde_json::to_vec(&delta).unwrap();
        deltas.insert(2, corrupted.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open(&database_path)
        .err()
        .expect("opening must fail");
    assert!(
        error.to_string().contains("recovered digest"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn restart_rejects_a_structurally_valid_snapshot_with_the_wrong_digest() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    seed_two_generations(&database_path);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut snapshots = write.open_table(SNAPSHOTS).unwrap();
        let encoded = snapshots.get(1).unwrap().unwrap().value().to_vec();
        let mut snapshot: GraphSnapshot = serde_json::from_slice(&encoded).unwrap();
        snapshot.nodes[0].payload = "export interface CorruptedSnapshot {}".into();
        let corrupted = serde_json::to_vec(&snapshot).unwrap();
        snapshots.insert(1, corrupted.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open(&database_path)
        .err()
        .expect("opening must fail");
    assert!(
        error.to_string().contains("snapshot digest"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn write_snapshot_rejects_a_valid_historical_snapshot_with_uncommitted_content() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (mut generation_one, _) = seed_two_generations(&database_path);
    generation_one.nodes[0].payload = "export interface UncommittedHistory {}".into();

    let (kernel, _) = Kernel::open(&database_path).unwrap();
    let error = kernel.write_snapshot(&generation_one).unwrap_err();

    assert!(
        error.to_string().contains("snapshot digest"),
        "unexpected error: {error:#}"
    );
}

#[test]
fn restart_rejects_a_snapshot_whose_key_and_payload_generations_differ() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    seed_two_generations(&database_path);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut snapshots = write.open_table(SNAPSHOTS).unwrap();
        let generation_one = snapshots.get(1).unwrap().unwrap().value().to_vec();
        snapshots.insert(2, generation_one.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open(&database_path)
        .err()
        .expect("opening must fail");
    assert!(
        error
            .to_string()
            .contains("snapshot key generation 2 does not match payload generation 1"),
        "unexpected error: {error:#}"
    );
}
