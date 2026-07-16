#![cfg(feature = "redb-spike-api")]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use redb::{ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition, TableHandle};
use serde_json::Value;
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, CandidateEnvelope, ChangeSetState, ClaimOutcome,
    CoordinationEventKind, CoordinationFailpoint, DurableStore, DynamicExpansionPolicy,
    GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, IdempotencyClass, IntentAnalysis,
    IntentParameters, IntentRecord, Kernel, PreparedCandidate, ResourceVersion, SCHEMA_VERSION,
    SubmissionOutcome, TestSemanticProvider, TicketState,
};
use tempfile::tempdir;

const GRAPH_META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const CHANGE_SETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_change_sets");
const ACTIVE_CLAIMS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_active_claims");
const RESOURCE_CLOCKS: TableDefinition<&str, u64> =
    TableDefinition::new("coordination_resource_clocks");
const PUBLICATION_ATTEMPTS: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_publication_attempts");
const GRAPH_OPERATIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("operations");
const GRAPH_EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("events");
const COORDINATION_META: TableDefinition<&str, &[u8]> =
    TableDefinition::new("coordination_metadata");
const COORDINATION_EVENTS: TableDefinition<u64, &[u8]> =
    TableDefinition::new("coordination_events");
const COORDINATION_EVENT_IDS: TableDefinition<&str, u64> =
    TableDefinition::new("coordination_event_ids");

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

struct TargetAnalyzer;

impl TestSemanticProvider for TargetAnalyzer {
    fn analyze(
        &self,
        _graph: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let IntentParameters::RenameSymbol { declaration_id, .. } = &intent.parameters else {
            anyhow::bail!("test analyzer only supports rename intents")
        };
        let key = format!("symbol:{declaration_id}");
        let resource = ResourceVersion::new(&key, "v0").unwrap();
        Ok(IntentAnalysis {
            read_set: vec![resource.clone()],
            write_set: vec![resource.clone()],
            validation_set: vec![resource],
            reservation_keys: vec![key],
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        })
    }
}

fn create_kernel(path: &Path) -> Kernel {
    Kernel::create_with_test_semantics(path, fixture(), Arc::new(TargetAnalyzer))
        .unwrap()
        .0
}

struct UserBuilder;

impl CandidateBuilder for UserBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        let mut user = prepared.graph().node("fc98295bca9efc3e").unwrap().clone();
        user.payload = "export interface Account {}".into();
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph().generation(),
            changes: vec![GraphChange::UpsertNode { node: user }],
        })
    }
}

struct UserAnalyzer;

impl TestSemanticProvider for UserAnalyzer {
    fn analyze(
        &self,
        graph: &GraphGeneration,
        _intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let user = graph.node("fc98295bca9efc3e").unwrap();
        let keys = vec![
            "node:fc98295bca9efc3e".to_owned(),
            format!("node:{}", user.parent_id.as_deref().unwrap()),
        ];
        let resources = keys
            .iter()
            .map(|key| ResourceVersion::new(key, "v0").unwrap())
            .collect::<Vec<_>>();
        Ok(IntentAnalysis {
            read_set: resources.clone(),
            write_set: resources.clone(),
            validation_set: resources,
            reservation_keys: keys,
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        })
    }
}

fn begin_and_submit(kernel: &Kernel, id: &str, target: &str, now_tick: u64) -> SubmissionOutcome {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: id.into(),
                actor: "agent:test".into(),
                reasoning: "exercise restart recovery".into(),
                submission_idempotency_key: format!("submission:{id}"),
            },
            now_tick,
        )
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: target.into(),
                new_name: format!("{target}Renamed"),
            },
        )
        .unwrap();
    kernel.submit_change_set(id, now_tick).unwrap()
}

fn raw_service_epoch(path: &Path) -> u64 {
    let database = redb::Database::open(path).unwrap();
    let read = database.begin_read().unwrap();
    let metadata = read.open_table(GRAPH_META).unwrap();
    let value = metadata.get("service_epoch").unwrap().unwrap();
    u64::from_le_bytes(value.value().try_into().unwrap())
}

#[test]
fn legacy_serialized_draft_gets_one_deterministic_expiry_on_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change-set:legacy-draft".into(),
                actor: "agent:legacy".into(),
                reasoning: "migrate a pre-lease draft".into(),
                submission_idempotency_key: "submission:legacy-draft".into(),
            },
            17,
        )
        .unwrap();
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut table = write.open_table(CHANGE_SETS).unwrap();
        let bytes = table
            .get("change-set:legacy-draft")
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut legacy: Value = serde_json::from_slice(&bytes).unwrap();
        let object = legacy.as_object_mut().unwrap();
        object.remove("createdAtTick");
        object.remove("expiresAtTick");
        let encoded = serde_json::to_vec(&legacy).unwrap();
        table
            .insert("change-set:legacy-draft", encoded.as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let (reopened, _) = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    let migrated = reopened
        .change_set("change-set:legacy-draft")
        .unwrap()
        .unwrap();
    assert_eq!(migrated.created_at_tick, 0);
    assert_eq!(
        migrated.expires_at_tick,
        Some(strata_kernel::DRAFT_TTL_TICKS)
    );
    drop(reopened);

    let (reopened_again, _) =
        Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(
        reopened_again
            .change_set("change-set:legacy-draft")
            .unwrap()
            .unwrap()
            .expires_at_tick,
        Some(strata_kernel::DRAFT_TTL_TICKS),
        "the deterministic legacy expiry must not move on a second reopen"
    );
}

#[test]
fn events_replay_with_stable_ids_and_monotonic_isolated_client_cursors() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:ready", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));

    let first = kernel.events_after("client:A", 0, 100).unwrap();
    assert_eq!(
        first.iter().map(|event| event.sequence).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        first.iter().map(|event| &event.kind).collect::<Vec<_>>(),
        vec![
            &CoordinationEventKind::IntentQueued,
            &CoordinationEventKind::IntentReady,
        ]
    );
    assert_eq!(kernel.events_after("client:A", 0, 100).unwrap(), first);

    assert_eq!(
        kernel
            .ack_events("client:A", 2)
            .unwrap()
            .acknowledged_sequence,
        2
    );
    assert_eq!(
        kernel
            .ack_events("client:A", 1)
            .unwrap()
            .acknowledged_sequence,
        2
    );
    assert!(kernel.events_after("client:A", 0, 100).unwrap().is_empty());

    assert_eq!(
        kernel.events_after("client:B", 1, 100).unwrap(),
        vec![first[1].clone()]
    );
    assert_eq!(
        kernel.events_after("client:B", 0, 100).unwrap(),
        first,
        "client B must not inherit client A's cursor"
    );
    assert!(kernel.events_after("client:A", 0, 0).is_err());
    assert!(kernel.ack_events("client:A", 3).is_err());

    drop(kernel);
    let (reopened, _) = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    let client_a_after_restart = reopened.events_after("client:A", 0, 100).unwrap();
    assert_eq!(client_a_after_restart.len(), 2);
    assert_eq!(
        client_a_after_restart[0].kind,
        CoordinationEventKind::LeaseExpired
    );
    assert_eq!(
        client_a_after_restart[1].kind,
        CoordinationEventKind::IntentReady
    );
    let client_b_after_restart = reopened.events_after("client:B", 0, 100).unwrap();
    assert_eq!(&client_b_after_restart[..first.len()], first.as_slice());
}

#[test]
fn queued_tickets_and_unacknowledged_events_survive_restart() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    let ready = begin_and_submit(&kernel, "change-set:first", "Clock", 1);
    assert!(matches!(ready, SubmissionOutcome::Ready { .. }));
    let queued_ticket = match begin_and_submit(&kernel, "change-set:second", "Clock", 2) {
        SubmissionOutcome::Queued { ticket } => ticket,
        other => panic!("expected queued overlap, got {other:?}"),
    };
    let before = kernel.events_after("client:reader", 0, 100).unwrap();
    assert_eq!(before.len(), 3);
    drop(kernel);

    let (reopened, _) = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    let after = reopened.events_after("client:reader", 0, 100).unwrap();
    drop(reopened);
    let store = DurableStore::open(&path).unwrap();
    let tickets = store.coordination().active_tickets().unwrap();
    assert_eq!(tickets.len(), 2);
    assert_eq!(
        tickets
            .iter()
            .find(|ticket| ticket.change_set_id == "change-set:first")
            .unwrap()
            .state,
        TicketState::Ready
    );
    let recovered_queued = tickets
        .iter()
        .find(|ticket| ticket.change_set_id == "change-set:second")
        .unwrap();
    assert_eq!(
        recovered_queued.queue_sequence,
        queued_ticket.queue_sequence
    );
    assert_eq!(
        recovered_queued.scope_fingerprint,
        queued_ticket.scope_fingerprint
    );
    assert!(recovered_queued.age_rounds >= queued_ticket.age_rounds);

    assert_eq!(&after[..before.len()], before.as_slice());
    assert_eq!(
        after[before.len()].kind,
        CoordinationEventKind::LeaseExpired
    );
    assert_eq!(
        after.last().unwrap().kind,
        CoordinationEventKind::IntentReady
    );
}

#[test]
fn restart_requeues_ready_and_executing_work_once_and_leaves_terminal_records_untouched() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);

    let (ready_ticket_id, ready_offer) =
        match begin_and_submit(&kernel, "change-set:ready", "Clock", 1) {
            SubmissionOutcome::Ready { ticket, offer } => (ticket.ticket_id, offer),
            other => panic!("expected ready work, got {other:?}"),
        };
    let (executing_ticket_id, executing_offer) =
        match begin_and_submit(&kernel, "change-set:executing", "User", 2) {
            SubmissionOutcome::Ready { ticket, offer } => (ticket.ticket_id, offer),
            other => panic!("expected ready work, got {other:?}"),
        };
    let ClaimOutcome::Claimed(_) = kernel
        .claim_ready(&executing_offer.offer_id, &executing_offer.claim_token, 3)
        .unwrap()
    else {
        panic!("expected executing claim")
    };
    let terminal_ticket_id = match begin_and_submit(&kernel, "change-set:terminal", "Logger", 4) {
        SubmissionOutcome::Ready { ticket, .. } => ticket.ticket_id,
        other => panic!("expected ready work, got {other:?}"),
    };
    let terminal = kernel.cancel_change_set("change-set:terminal", 5).unwrap();
    assert_eq!(terminal.change_set.state, ChangeSetState::Cancelled);

    let event_sequence_before = kernel
        .events_after("client:before", 0, 100)
        .unwrap()
        .last()
        .unwrap()
        .sequence;
    let old_epoch = kernel.service_epoch();
    drop(kernel);

    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    let prior_tickets = durable
        .ticket(&ready_ticket_id)
        .unwrap()
        .into_iter()
        .chain(durable.ticket(&executing_ticket_id).unwrap())
        .map(|ticket| (ticket.change_set_id.clone(), ticket))
        .collect::<BTreeMap<_, _>>();
    let prior_terminal = durable.change_set("change-set:terminal").unwrap().unwrap();
    let prior_terminal_ticket = durable.ticket(&terminal_ticket_id).unwrap().unwrap();
    drop(store);

    let (reopened, report) =
        Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(report.service_epoch, old_epoch + 1);
    assert!(
        reopened
            .claim_ready(&ready_offer.offer_id, &ready_offer.claim_token, 6,)
            .is_err()
    );
    let recovery_events = reopened
        .events_after("client:recovery", event_sequence_before, 100)
        .unwrap();
    drop(reopened);

    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    assert_eq!(durable.ready_offers().unwrap().len(), 2);
    assert!(durable.active_claims().unwrap().is_empty());

    for change_set_id in ["change-set:ready", "change-set:executing"] {
        assert_eq!(
            durable.change_set(change_set_id).unwrap().unwrap().state,
            ChangeSetState::Ready
        );
        let before = prior_tickets.get(change_set_id).unwrap();
        let mut expected = before.clone();
        expected.state = TicketState::Ready;
        expected.active_claim_id = None;
        let after = durable
            .active_tickets()
            .unwrap()
            .into_iter()
            .find(|ticket| ticket.change_set_id == change_set_id)
            .unwrap();
        assert_eq!(after.queue_sequence, expected.queue_sequence);
        assert_eq!(after.scope_fingerprint, expected.scope_fingerprint);
        assert_eq!(after.reservation_keys, expected.reservation_keys);
        assert!(after.ready_offer_id.is_some());
    }
    assert_eq!(
        durable.change_set("change-set:terminal").unwrap().unwrap(),
        prior_terminal
    );
    assert_eq!(
        durable.ticket(&terminal_ticket_id).unwrap().unwrap(),
        prior_terminal_ticket,
    );
    assert_eq!(recovery_events.len(), 4);
    assert!(
        recovery_events
            .iter()
            .take(2)
            .all(|event| event.kind == CoordinationEventKind::LeaseExpired)
    );
    assert!(
        recovery_events
            .iter()
            .skip(2)
            .all(|event| event.kind == CoordinationEventKind::IntentReady)
    );
    assert_eq!(
        recovery_events[..2]
            .iter()
            .map(|event| event.change_set_id.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from(["change-set:executing", "change-set:ready"])
    );
    for event in recovery_events.into_iter().take(2) {
        let payload: Value = serde_json::from_str(&event.payload_json).unwrap();
        assert_eq!(payload["oldServiceEpoch"], old_epoch);
        assert_eq!(payload["newServiceEpoch"], report.service_epoch);
    }
}

#[test]
fn failed_restart_recovery_is_atomic_and_the_next_open_applies_it_once() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:ready", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));
    let executing_offer = match begin_and_submit(&kernel, "change-set:executing", "User", 2) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected ready work, got {other:?}"),
    };
    assert!(matches!(
        kernel
            .claim_ready(&executing_offer.offer_id, &executing_offer.claim_token, 3,)
            .unwrap(),
        ClaimOutcome::Claimed(_)
    ));
    let old_epoch = kernel.service_epoch();
    drop(kernel);

    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    let counts = durable.table_counts().unwrap();
    let metadata = durable.metadata_state().unwrap();
    let change_sets = ["change-set:ready", "change-set:executing"]
        .into_iter()
        .map(|id| (id.to_owned(), durable.change_set(id).unwrap().unwrap()))
        .collect::<BTreeMap<_, _>>();
    let tickets = durable.active_tickets().unwrap();
    let offer = durable.ready_offers().unwrap().pop().unwrap();
    let claim = durable.active_claims().unwrap().pop().unwrap();

    let error = store
        .begin_service_epoch_and_recover_coordination_with_failpoint(
            CoordinationFailpoint::BeforeCommit,
        )
        .unwrap_err();
    assert!(error.to_string().contains("coordination failpoint"));
    drop(store);
    assert_eq!(raw_service_epoch(&path), old_epoch);
    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    assert_eq!(durable.table_counts().unwrap(), counts);
    assert_eq!(durable.metadata_state().unwrap(), metadata);
    for (id, change_set) in change_sets {
        assert_eq!(durable.change_set(&id).unwrap(), Some(change_set));
    }
    assert_eq!(durable.active_tickets().unwrap(), tickets);
    assert_eq!(durable.ready_offers().unwrap(), vec![offer]);
    assert_eq!(durable.active_claims().unwrap(), vec![claim]);
    drop(store);

    let (reopened, report) =
        Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(report.service_epoch, old_epoch + 1);
    let recovery_events = reopened.events_after("client:retry", 4, 100).unwrap();
    assert_eq!(recovery_events.len(), 4);
    assert!(
        recovery_events
            .iter()
            .take(2)
            .all(|event| event.kind == CoordinationEventKind::LeaseExpired)
    );
    assert!(
        recovery_events
            .iter()
            .skip(2)
            .all(|event| event.kind == CoordinationEventKind::IntentReady)
    );
    drop(reopened);

    let (reopened_again, second_report) =
        Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(second_report.service_epoch, report.service_epoch + 1);
    let events_after_second_restart = reopened_again
        .events_after("client:retry-again", 4, 100)
        .unwrap();
    assert_eq!(
        &events_after_second_restart[..4],
        recovery_events.as_slice()
    );
    assert_eq!(events_after_second_restart.len(), 8);
    assert!(
        events_after_second_restart[4..6]
            .iter()
            .all(|event| event.kind == CoordinationEventKind::LeaseExpired)
    );
    assert!(
        events_after_second_restart[6..]
            .iter()
            .all(|event| event.kind == CoordinationEventKind::IntentReady)
    );
}

#[test]
fn reopen_rejects_a_missing_resource_clock_for_a_nonzero_dependency() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    let SubmissionOutcome::Ready { offer, .. } =
        begin_and_submit(&kernel, "change-set:clock-corruption", "Clock", 1)
    else {
        panic!("expected ready change set")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("expected claimed change set")
    };
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut claims = write.open_table(ACTIVE_CLAIMS).unwrap();
        let bytes = claims
            .get(claim.claim_id.as_str())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        json["dependencyVersions"][0]["clock"] = Value::from(1_u64);
        let encoded = serde_json::to_vec(&json).unwrap();
        claims
            .insert(claim.claim_id.as_str(), encoded.as_slice())
            .unwrap();
    }
    write
        .open_table(RESOURCE_CLOCKS)
        .unwrap()
        .remove("symbol:Clock")
        .unwrap();
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
        .err()
        .expect("missing nonzero dependency clock must reject reopen");
    assert!(
        error.to_string().contains("missing resource clock"),
        "{error:#}"
    );
}

fn publish_user_change(path: &Path) -> String {
    let (kernel, _) =
        Kernel::create_with_test_semantics(path, fixture(), Arc::new(UserAnalyzer)).unwrap();
    let SubmissionOutcome::Ready { offer, .. } = begin_and_submit(
        &kernel,
        "change-set:attempt-corruption",
        "fc98295bca9efc3e",
        1,
    ) else {
        panic!("expected ready change set")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("expected claimed change set")
    };
    kernel.publish_claimed(&claim, &UserBuilder, 3).unwrap();
    let attempt_id = claim.attempt_id;
    drop(kernel);
    attempt_id
}

fn raw_coordination_metadata(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let database = redb::Database::open(path).unwrap();
    let read = database.begin_read().unwrap();
    let metadata = read.open_table(COORDINATION_META).unwrap();
    metadata
        .iter()
        .unwrap()
        .map(|entry| {
            let (key, value) = entry.unwrap();
            (key.value().to_owned(), value.value().to_vec())
        })
        .collect()
}

fn raw_coordination_event_ids(path: &Path) -> BTreeMap<String, u64> {
    let database = redb::Database::open(path).unwrap();
    let read = database.begin_read().unwrap();
    let event_ids = read.open_table(COORDINATION_EVENT_IDS).unwrap();
    event_ids
        .iter()
        .unwrap()
        .map(|entry| {
            let (key, value) = entry.unwrap();
            (key.value().to_owned(), value.value())
        })
        .collect()
}

fn raw_coordination_table_names(path: &Path) -> BTreeSet<String> {
    let database = redb::Database::open(path).unwrap();
    let read = database.begin_read().unwrap();
    read.list_tables()
        .unwrap()
        .map(|table| table.name().to_owned())
        .filter(|name| name.starts_with("coordination_"))
        .collect()
}

fn strip_to_8422f4e_coordination_schema(path: &Path) {
    let database = redb::Database::open(path).unwrap();
    let write = database.begin_write().unwrap();
    assert!(write.delete_table(RESOURCE_CLOCKS).unwrap());
    assert!(write.delete_table(PUBLICATION_ATTEMPTS).unwrap());
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        for key in [
            "scheduler_revision",
            "recovery_validation_version",
            "latest_lifecycle_revision",
            "clocked_publication_generation",
        ] {
            metadata.remove(key).unwrap();
        }
    }
    write.commit().unwrap();
}

fn metadata_u64(metadata: &BTreeMap<String, Vec<u8>>, key: &str) -> Option<u64> {
    metadata
        .get(key)
        .map(|bytes| u64::from_le_bytes(bytes.as_slice().try_into().unwrap()))
}

#[test]
fn marker_absent_8422f4e_schema_without_clock_or_attempt_tables_migrates_atomically() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    let old_epoch = kernel.service_epoch();
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:8422f4e", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));
    drop(kernel);

    strip_to_8422f4e_coordination_schema(&path);
    assert_eq!(
        raw_coordination_table_names(&path),
        [
            "coordination_active_claims",
            "coordination_change_sets",
            "coordination_event_cursors",
            "coordination_event_ids",
            "coordination_events",
            "coordination_intents",
            "coordination_metadata",
            "coordination_ready_offers",
            "coordination_submission_idempotency",
            "coordination_tickets",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    let legacy_metadata = raw_coordination_metadata(&path);
    assert_eq!(metadata_u64(&legacy_metadata, "scheduler_revision"), None);
    assert_eq!(
        metadata_u64(&legacy_metadata, "recovery_validation_version"),
        None
    );

    let (kernel, _) = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(kernel.service_epoch(), old_epoch + 1);
    drop(kernel);

    let migrated_tables = raw_coordination_table_names(&path);
    assert!(migrated_tables.contains(RESOURCE_CLOCKS.name()));
    assert!(migrated_tables.contains(PUBLICATION_ATTEMPTS.name()));
    let migrated_metadata = raw_coordination_metadata(&path);
    assert_eq!(
        metadata_u64(&migrated_metadata, "recovery_validation_version"),
        Some(1)
    );
    assert!(metadata_u64(&migrated_metadata, "scheduler_revision").is_some());

    let (kernel, _) = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
    assert_eq!(kernel.service_epoch(), old_epoch + 2);
}

#[test]
fn failed_open_does_not_recreate_missing_required_versioned_tables() {
    for missing_table in [RESOURCE_CLOCKS.name(), PUBLICATION_ATTEMPTS.name()] {
        let directory = tempdir().unwrap();
        let path = directory.path().join(format!("{missing_table}.redb"));
        let kernel = create_kernel(&path);
        let old_epoch = kernel.service_epoch();
        drop(kernel);

        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        match missing_table {
            name if name == RESOURCE_CLOCKS.name() => {
                assert!(write.delete_table(RESOURCE_CLOCKS).unwrap());
            }
            name if name == PUBLICATION_ATTEMPTS.name() => {
                assert!(write.delete_table(PUBLICATION_ATTEMPTS).unwrap());
            }
            _ => unreachable!(),
        }
        write.commit().unwrap();
        drop(database);
        let before_metadata = raw_coordination_metadata(&path);

        let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
            .err()
            .expect("missing versioned coordination table must reject reopen");
        assert!(error.to_string().contains(missing_table), "{error:#}");
        assert!(!raw_coordination_table_names(&path).contains(missing_table));
        assert_eq!(raw_coordination_metadata(&path), before_metadata);
        assert_eq!(raw_service_epoch(&path), old_epoch);
    }
}

#[test]
fn legacy_validation_markers_are_backfilled_after_read_only_validation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        metadata.remove("recovery_validation_version").unwrap();
        metadata.remove("latest_lifecycle_revision").unwrap();
        metadata.remove("clocked_publication_generation").unwrap();
    }
    write.commit().unwrap();
    drop(database);
    let legacy = raw_coordination_metadata(&path);
    assert_eq!(metadata_u64(&legacy, "recovery_validation_version"), None);

    let (kernel, _) = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer)).unwrap();
    drop(kernel);
    let migrated = raw_coordination_metadata(&path);
    assert_eq!(
        metadata_u64(&migrated, "recovery_validation_version"),
        Some(1)
    );
    assert_eq!(
        metadata_u64(&migrated, "latest_lifecycle_revision"),
        metadata_u64(&migrated, "scheduler_revision")
    );
    assert_eq!(
        metadata_u64(&migrated, "clocked_publication_generation"),
        Some(1)
    );
}

#[test]
fn failed_legacy_validation_migration_rolls_back_schema_markers_and_service_epoch() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    let old_epoch = kernel.service_epoch();
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    assert!(write.delete_table(RESOURCE_CLOCKS).unwrap());
    assert!(write.delete_table(PUBLICATION_ATTEMPTS).unwrap());
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        metadata.remove("recovery_validation_version").unwrap();
        metadata.remove("latest_lifecycle_revision").unwrap();
        metadata.remove("clocked_publication_generation").unwrap();
    }
    write.commit().unwrap();
    drop(database);
    let before = raw_coordination_metadata(&path);
    let before_tables = raw_coordination_table_names(&path);

    let store = DurableStore::open(&path).unwrap();
    let error = store
        .begin_service_epoch_and_recover_coordination_with_migration_and_failpoint(
            strata_kernel::RecoveryValidationMigration {
                latest_lifecycle_revision: 0,
                clocked_publication_generation: 0,
            },
            CoordinationFailpoint::BeforeCommit,
        )
        .unwrap_err();
    assert!(error.to_string().contains("coordination failpoint"));
    drop(store);

    assert_eq!(raw_coordination_metadata(&path), before);
    assert_eq!(raw_coordination_table_names(&path), before_tables);
    assert_eq!(raw_service_epoch(&path), old_epoch);
}

#[test]
fn failed_open_does_not_self_heal_a_missing_versioned_lifecycle_marker() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:marker-corruption", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        let version = metadata
            .get("recovery_validation_version")
            .unwrap()
            .map(|value| u64::from_le_bytes(value.value().try_into().unwrap()));
        assert_eq!(version, Some(1));
        metadata.remove("latest_lifecycle_revision").unwrap();
        metadata
            .insert("scheduler_revision", 0_u64.to_le_bytes().as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let before = raw_coordination_metadata(&path);
    let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
        .err()
        .expect("missing versioned lifecycle marker must reject reopen");
    assert!(error.to_string().contains("lifecycle marker"), "{error:#}");
    assert_eq!(raw_coordination_metadata(&path), before);
}

#[test]
fn failed_open_does_not_self_heal_a_missing_versioned_clock_marker_or_clocks() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        metadata.remove("clocked_publication_generation").unwrap();
        let mut clocks = write.open_table(RESOURCE_CLOCKS).unwrap();
        let keys = clocks
            .iter()
            .unwrap()
            .map(|entry| entry.unwrap().0.value().to_owned())
            .collect::<Vec<_>>();
        for key in keys {
            clocks.remove(key.as_str()).unwrap();
        }
    }
    write.commit().unwrap();
    drop(database);

    let before = raw_coordination_metadata(&path);
    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("missing versioned clock marker must reject reopen");
    assert!(error.to_string().contains("clock marker"), "{error:#}");
    assert_eq!(raw_coordination_metadata(&path), before);
    let database = redb::Database::open(&path).unwrap();
    let read = database.begin_read().unwrap();
    assert_eq!(read.open_table(RESOURCE_CLOCKS).unwrap().len().unwrap(), 0);
}

#[test]
fn failed_open_does_not_recreate_missing_versioned_event_sequence_metadata() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:event-sequence-corruption", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    write
        .open_table(COORDINATION_META)
        .unwrap()
        .remove("current_event_sequence")
        .unwrap();
    write.commit().unwrap();
    drop(database);
    let before_metadata = raw_coordination_metadata(&path);
    let before_event_ids = raw_coordination_event_ids(&path);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
        .err()
        .expect("missing versioned current event sequence must reject reopen");
    assert!(
        error.to_string().contains("current_event_sequence"),
        "{error:#}"
    );
    assert_eq!(raw_coordination_metadata(&path), before_metadata);
    assert_eq!(raw_coordination_event_ids(&path), before_event_ids);
}

#[test]
fn failed_open_does_not_recreate_missing_versioned_queue_or_revision_metadata() {
    for missing_key in ["next_queue_sequence", "scheduler_revision"] {
        let directory = tempdir().unwrap();
        let path = directory.path().join(format!("{missing_key}.redb"));
        let kernel = create_kernel(&path);
        assert!(matches!(
            begin_and_submit(&kernel, "change-set:metadata-corruption", "Clock", 1),
            SubmissionOutcome::Ready { .. }
        ));
        drop(kernel);

        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        write
            .open_table(COORDINATION_META)
            .unwrap()
            .remove(missing_key)
            .unwrap();
        write.commit().unwrap();
        drop(database);
        let before_metadata = raw_coordination_metadata(&path);
        let before_event_ids = raw_coordination_event_ids(&path);

        let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
            .err()
            .unwrap_or_else(|| panic!("missing versioned {missing_key} must reject reopen"));
        assert!(error.to_string().contains(missing_key), "{error:#}");
        assert_eq!(raw_coordination_metadata(&path), before_metadata);
        assert_eq!(raw_coordination_event_ids(&path), before_event_ids);
    }
}

#[test]
fn failed_open_does_not_backfill_or_rewrite_versioned_event_id_mappings() {
    for wrong_sequence in [None, Some(999_u64)] {
        let directory = tempdir().unwrap();
        let path = directory
            .path()
            .join(format!("event-id-{wrong_sequence:?}.redb"));
        let kernel = create_kernel(&path);
        assert!(matches!(
            begin_and_submit(&kernel, "change-set:event-id-corruption", "Clock", 1),
            SubmissionOutcome::Ready { .. }
        ));
        drop(kernel);

        let database = redb::Database::open(&path).unwrap();
        let read = database.begin_read().unwrap();
        let events = read.open_table(COORDINATION_EVENTS).unwrap();
        let event_id = {
            let (_, first_event_bytes) = events.iter().unwrap().next().unwrap().unwrap();
            let first_event: Value = serde_json::from_slice(first_event_bytes.value()).unwrap();
            first_event["eventId"].as_str().unwrap().to_owned()
        };
        drop(events);
        drop(read);
        let write = database.begin_write().unwrap();
        let mut ids = write.open_table(COORDINATION_EVENT_IDS).unwrap();
        ids.remove(event_id.as_str()).unwrap();
        if let Some(sequence) = wrong_sequence {
            ids.insert(event_id.as_str(), sequence).unwrap();
        }
        drop(ids);
        write.commit().unwrap();
        drop(database);
        let before_metadata = raw_coordination_metadata(&path);
        let before_event_ids = raw_coordination_event_ids(&path);

        let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
            .err()
            .expect("missing or wrong versioned event-ID mapping must reject reopen");
        assert!(error.to_string().contains("event ID"), "{error:#}");
        assert_eq!(raw_coordination_metadata(&path), before_metadata);
        assert_eq!(raw_coordination_event_ids(&path), before_event_ids);
    }
}

#[test]
fn reopen_rejects_a_publication_attempt_bound_to_a_different_change_set() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let attempt_id = publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut attempts = write.open_table(PUBLICATION_ATTEMPTS).unwrap();
        let bytes = attempts
            .get(attempt_id.as_str())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        json["changeSetId"] = Value::String("change-set:different".into());
        let encoded = serde_json::to_vec(&json).unwrap();
        attempts
            .insert(attempt_id.as_str(), encoded.as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("attempt bound to another change set must reject reopen");
    assert!(error.to_string().contains("change set"), "{error:#}");
}

#[test]
fn reopen_rejects_an_attempt_whose_graph_operation_has_another_change_set() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut operations = write.open_table(GRAPH_OPERATIONS).unwrap();
        let bytes = operations.get(1).unwrap().unwrap().value().to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        json["changeSetId"] = Value::String("change-set:different".into());
        let encoded = serde_json::to_vec(&json).unwrap();
        operations.insert(1, encoded.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("operation/change-set mismatch must reject reopen");
    assert!(error.to_string().contains("graph operation"), "{error:#}");
}

#[test]
fn reopen_rejects_an_attempt_whose_graph_event_has_another_operation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut events = write.open_table(GRAPH_EVENTS).unwrap();
        let bytes = events.get(1).unwrap().unwrap().value().to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        let mut payload: Value =
            serde_json::from_str(json["payloadJson"].as_str().unwrap()).unwrap();
        payload["operationId"] = Value::String("operation:different".into());
        json["payloadJson"] = Value::String(payload.to_string());
        let encoded = serde_json::to_vec(&json).unwrap();
        events.insert(1, encoded.as_slice()).unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("event/operation mismatch must reject reopen");
    assert!(
        error.to_string().contains("graph event identity"),
        "{error:#}"
    );
}

#[test]
fn reopen_rejects_a_changed_candidate_digest_for_the_same_attempt_id() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let attempt_id = publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut attempts = write.open_table(PUBLICATION_ATTEMPTS).unwrap();
        let bytes = attempts
            .get(attempt_id.as_str())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        json["candidateDigest"] = Value::String("corrupt-candidate-digest".into());
        let encoded = serde_json::to_vec(&json).unwrap();
        attempts
            .insert(attempt_id.as_str(), encoded.as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("changed candidate digest must reject reopen");
    assert!(error.to_string().contains("candidate digest"), "{error:#}");
}

#[test]
fn reopen_rejects_a_changed_graph_digest_for_a_publication_attempt() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let attempt_id = publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut attempts = write.open_table(PUBLICATION_ATTEMPTS).unwrap();
        let bytes = attempts
            .get(attempt_id.as_str())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        let mut json: Value = serde_json::from_slice(&bytes).unwrap();
        json["graphDigest"] = Value::String("corrupt-graph-digest".into());
        let encoded = serde_json::to_vec(&json).unwrap();
        attempts
            .insert(attempt_id.as_str(), encoded.as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("changed graph digest must reject reopen");
    assert!(error.to_string().contains("graph digest"), "{error:#}");
}

#[test]
fn reopen_rejects_scheduler_revision_behind_latest_lifecycle_revision() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    assert!(matches!(
        begin_and_submit(&kernel, "change-set:revision-corruption", "Clock", 1),
        SubmissionOutcome::Ready { .. }
    ));
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut metadata = write.open_table(COORDINATION_META).unwrap();
        metadata
            .insert("scheduler_revision", 0_u64.to_le_bytes().as_slice())
            .unwrap();
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer))
        .err()
        .expect("scheduler revision behind lifecycle must reject reopen");
    assert!(
        error.to_string().contains("lifecycle revision"),
        "{error:#}"
    );
}

#[test]
fn empty_pre_clock_database_remains_compatible_before_first_clocked_publication() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = create_kernel(&path);
    drop(kernel);

    let database = redb::Database::open(&path).unwrap();
    let read = database.begin_read().unwrap();
    assert_eq!(read.open_table(RESOURCE_CLOCKS).unwrap().len().unwrap(), 0);
    drop(read);
    drop(database);

    Kernel::open_with_test_semantics(&path, Arc::new(TargetAnalyzer)).unwrap();
}

#[test]
fn empty_clock_table_is_rejected_after_first_clocked_publication() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    publish_user_change(&path);

    let database = redb::Database::open(&path).unwrap();
    let write = database.begin_write().unwrap();
    {
        let mut clocks = write.open_table(RESOURCE_CLOCKS).unwrap();
        let keys = clocks
            .iter()
            .unwrap()
            .map(|entry| entry.unwrap().0.value().to_owned())
            .collect::<Vec<_>>();
        for key in keys {
            clocks.remove(key.as_str()).unwrap();
        }
    }
    write.commit().unwrap();
    drop(database);

    let error = Kernel::open_with_test_semantics(&path, Arc::new(UserAnalyzer))
        .err()
        .expect("empty post-publication clock table must reject reopen");
    assert!(
        error.to_string().contains("first clocked publication"),
        "{error:#}"
    );
}
