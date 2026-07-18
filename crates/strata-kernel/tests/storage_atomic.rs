#![cfg(feature = "redb-spike-api")]

use std::collections::BTreeMap;

use strata_kernel::{
    DurableStore, EventRecord, FenceClaim, GraphChange, GraphDelta, GraphGeneration, GraphSnapshot,
    NodeRecord, OperationRecord, Publication, PublishOutcome, SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir;

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

fn publication(idempotency_key: &str) -> Publication {
    let changed_node = NodeRecord {
        id: "node:clock".into(),
        kind: "InterfaceDeclaration".into(),
        parent_id: None,
        child_index: Some(0),
        payload: "export interface TimeSource {}".into(),
    };

    Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: idempotency_key.into(),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: changed_node }],
        },
        operation: OperationRecord {
            operation_id: "operation:1".into(),
            change_set_id: "change-set:1".into(),
            actor: "agent:test".into(),
            kind: "RenameSymbol".into(),
            reasoning: "rename the shared clock abstraction".into(),
            affected_node_ids: vec!["node:clock".into()],
            renames: Vec::new(),
            intents: Vec::new(),
        },
        ticket: TicketRecord {
            ticket_id: "ticket:1".into(),
            state: "published".into(),
            scope_fingerprint: "scope:clock".into(),
        },
        event: EventRecord {
            event_id: "event:1".into(),
            sequence: 1,
            kind: "PublicationCommitted".into(),
            graph_generation: 1,
            payload_json: r#"{"operationId":"operation:1"}"#.into(),
        },
        fence: FenceClaim {
            service_epoch: 0,
            resource_tokens: BTreeMap::new(),
        },
    }
}

fn expected_digest(publication: &Publication) -> String {
    GraphGeneration::from_snapshot(initial_snapshot())
        .unwrap()
        .apply(&publication.delta)
        .unwrap()
        .digest()
        .to_owned()
}

fn issue_clock_fence(store: &DurableStore, service_epoch: u64) -> FenceClaim {
    store
        .issue_fence(service_epoch, &["symbol:Clock".into()])
        .unwrap()
}

#[test]
fn publication_is_atomic_and_durable_across_reopen() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let mut publication = publication("publish:1");

    {
        let store = DurableStore::create(&database_path).unwrap();
        store.seed(&initial_snapshot()).unwrap();
        let service_epoch = store.begin_service_epoch().unwrap();
        publication.fence = issue_clock_fence(&store, service_epoch);
        assert_eq!(
            store
                .publish(&publication, &expected_digest(&publication))
                .unwrap(),
            PublishOutcome::Published { generation: 1 }
        );
    }

    let reopened = DurableStore::open(&database_path).unwrap();
    assert_eq!(reopened.current_generation().unwrap(), 1);
    assert_eq!(
        reopened.operation(1).unwrap().unwrap(),
        publication.operation
    );
    assert_eq!(
        reopened
            .ticket(&publication.ticket.ticket_id)
            .unwrap()
            .unwrap(),
        publication.ticket
    );
    assert_eq!(reopened.event(1).unwrap().unwrap(), publication.event);
    assert!(
        reopened
            .was_published(&publication.idempotency_key)
            .unwrap()
    );
    assert_eq!(reopened.delta(1).unwrap().unwrap(), publication.delta);
}

#[test]
fn duplicate_idempotency_key_returns_original_generation_without_appending() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&database_path).unwrap();
    store.seed(&initial_snapshot()).unwrap();
    let service_epoch = store.begin_service_epoch().unwrap();

    let mut publication = publication("publish:duplicate");
    publication.fence = issue_clock_fence(&store, service_epoch);
    assert_eq!(
        store
            .publish(&publication, &expected_digest(&publication))
            .unwrap(),
        PublishOutcome::Published { generation: 1 }
    );

    let mut duplicate = publication.clone();
    duplicate.operation.operation_id = "operation:must-not-be-written".into();
    duplicate.event.event_id = "event:must-not-be-written".into();
    duplicate.ticket.ticket_id = "ticket:must-not-be-written".into();
    store.begin_service_epoch().unwrap();

    assert_eq!(
        store
            .publish(&duplicate, &expected_digest(&duplicate))
            .unwrap(),
        PublishOutcome::AlreadyPublished { generation: 1 }
    );
    assert_eq!(store.current_generation().unwrap(), 1);
    assert!(store.operation(2).unwrap().is_none());
    assert!(store.event(2).unwrap().is_none());
    assert!(
        store
            .ticket("ticket:must-not-be-written")
            .unwrap()
            .is_none()
    );
}

#[test]
fn failed_validation_leaves_all_publication_tables_unchanged() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&database_path).unwrap();
    store.seed(&initial_snapshot()).unwrap();

    let mut invalid = publication("publish:invalid-sequence");
    invalid.event.sequence = 2;

    let error = store
        .publish(&invalid, &expected_digest(&invalid))
        .unwrap_err();
    assert!(error.to_string().contains("event sequence"));
    assert_eq!(store.current_generation().unwrap(), 0);
    assert!(store.operation(1).unwrap().is_none());
    assert!(store.event(1).unwrap().is_none());
    assert!(store.ticket(&invalid.ticket.ticket_id).unwrap().is_none());
    assert!(!store.was_published(&invalid.idempotency_key).unwrap());
    assert!(store.delta(1).unwrap().is_none());
}

#[test]
fn seed_refuses_to_replace_an_existing_generation_zero_snapshot() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let store = DurableStore::create(&database_path).unwrap();
    store.seed(&initial_snapshot()).unwrap();

    let error = store.seed(&initial_snapshot()).unwrap_err();
    assert!(error.to_string().contains("already seeded"));
    assert_eq!(store.current_generation().unwrap(), 0);
}
