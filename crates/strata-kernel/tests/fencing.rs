#![cfg(feature = "redb-spike-api")]

use std::collections::BTreeMap;

use redb::{Database, ReadableDatabase, TableDefinition};
use strata_kernel::{
    DurableStore, EventRecord, FenceClaim, GraphChange, GraphDelta, GraphSnapshot, Kernel,
    NodeRecord, OperationRecord, Publication, SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir;

const FENCES: TableDefinition<&str, u64> = TableDefinition::new("fence_tokens");

fn initial_snapshot() -> GraphSnapshot {
    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![NodeRecord {
            id: "node:clock".into(),
            kind: "InterfaceDeclaration".into(),
            parent_id: None,
            child_index: Some(0),
            payload: "export interface Clock {}".into(),
        }],
        references: vec![],
    }
}

fn publication_with(claim: FenceClaim, idempotency_key: &str) -> Publication {
    publication_at(claim, idempotency_key, 0, 1, "TimeSource")
}

fn publication_at(
    claim: FenceClaim,
    idempotency_key: &str,
    base_generation: u64,
    sequence: u64,
    name: &str,
) -> Publication {
    Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: idempotency_key.into(),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation,
            changes: vec![GraphChange::UpsertNode {
                node: NodeRecord {
                    id: "node:clock".into(),
                    kind: "InterfaceDeclaration".into(),
                    parent_id: None,
                    child_index: Some(0),
                    payload: format!("export interface {name} {{}}"),
                },
            }],
        },
        operation: OperationRecord {
            operation_id: format!("operation:{idempotency_key}"),
            change_set_id: format!("change-set:{idempotency_key}"),
            actor: "agent:test".into(),
            kind: "RenameSymbol".into(),
            reasoning: "exercise fenced publication".into(),
            affected_node_ids: vec!["node:clock".into()],
            renames: Vec::new(),
        },
        ticket: TicketRecord {
            ticket_id: format!("ticket:{idempotency_key}"),
            state: "published".into(),
            scope_fingerprint: "scope:clock".into(),
        },
        event: EventRecord {
            event_id: format!("event:{idempotency_key}"),
            sequence,
            kind: "PublicationCommitted".into(),
            graph_generation: base_generation + 1,
            payload_json: "{}".into(),
        },
        fence: claim,
    }
}

#[test]
fn newer_resource_token_supersedes_an_older_claim() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&database_path, initial_snapshot()).unwrap();
    let resources = ["symbol:User".to_string()];

    let first = kernel.issue_fence(&resources).unwrap();
    let newer = kernel.issue_fence(&resources).unwrap();

    assert!(
        kernel
            .publish(publication_with(first, "first-attempt"))
            .unwrap_err()
            .to_string()
            .contains("stale fence")
    );
    assert!(
        kernel
            .publish(publication_with(newer, "newer-attempt"))
            .is_ok()
    );
}

#[test]
fn restart_increments_the_epoch_and_invalidates_an_old_claim() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, first_report) = Kernel::create(&database_path, initial_snapshot()).unwrap();
    let old_claim = kernel.issue_fence(&["symbol:User".into()]).unwrap();
    drop(kernel);

    let (reopened, second_report) = Kernel::open(&database_path).unwrap();
    assert_eq!(second_report.service_epoch, first_report.service_epoch + 1);
    let error = reopened
        .publish(publication_with(old_claim, "old-process"))
        .unwrap_err();
    assert!(error.to_string().contains("stale service epoch"));
}

#[test]
fn durable_issuance_rejects_a_non_current_service_epoch() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&database_path).unwrap();
    store.seed(&initial_snapshot()).unwrap();
    let current_epoch = store.begin_service_epoch().unwrap();

    let error = store
        .issue_fence(current_epoch - 1, &["symbol:User".into()])
        .unwrap_err();
    assert!(error.to_string().contains("stale service epoch"));
}

#[test]
fn issuing_resources_is_sorted_deduplicated_and_atomic_on_failure() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&database_path, initial_snapshot()).unwrap();

    let claim = kernel
        .issue_fence(&[
            "symbol:User".into(),
            "node:caller".into(),
            "symbol:User".into(),
        ])
        .unwrap();
    assert_eq!(
        claim.resource_tokens,
        BTreeMap::from([("node:caller".into(), 1), ("symbol:User".into(), 1)])
    );
    drop(kernel);

    let database = Database::open(&database_path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut fences = write.open_table(FENCES).unwrap();
        fences.insert("symbol:User", u64::MAX).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let (kernel, _) = Kernel::open(&database_path).unwrap();
    let error = kernel
        .issue_fence(&["node:caller".into(), "symbol:User".into()])
        .unwrap_err();
    assert!(error.to_string().contains("fence token overflow"));
    drop(kernel);

    let database = Database::open(&database_path).unwrap();
    let read = database.begin_read().unwrap();
    let fences = read.open_table(FENCES).unwrap();
    assert_eq!(fences.get("node:caller").unwrap().unwrap().value(), 1);
    assert_eq!(
        fences.get("symbol:User").unwrap().unwrap().value(),
        u64::MAX
    );
}

#[test]
fn a_new_publication_requires_a_non_empty_claim() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&database_path, initial_snapshot()).unwrap();
    let empty = FenceClaim {
        service_epoch: kernel.service_epoch(),
        resource_tokens: BTreeMap::new(),
    };

    let error = kernel
        .publish(publication_with(empty, "empty-claim"))
        .unwrap_err();
    assert!(error.to_string().contains("at least one resource"));
}

#[test]
fn a_claim_is_consumed_once_but_an_idempotent_retry_still_succeeds() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&database_path, initial_snapshot()).unwrap();
    let claim = kernel.issue_fence(&["symbol:User".into()]).unwrap();
    let first = publication_with(claim.clone(), "first-publication");
    kernel.publish(first.clone()).unwrap();

    let reused = publication_at(claim.clone(), "different-publication", 1, 2, "Scheduler");
    let error = kernel.publish(reused).unwrap_err();
    assert!(error.to_string().contains("consumed fence"));

    drop(kernel);
    let (reopened, _) = Kernel::open(&database_path).unwrap();
    let retry = reopened.publish(first).unwrap();
    assert!(retry.already_published);
    assert_eq!(retry.generation, 1);
}
