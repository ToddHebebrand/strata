#![cfg(feature = "redb-spike-api")]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use redb::{ReadableDatabase, TableDefinition};
use serde_json::Value;
use strata_kernel::{
    BeginChangeSet, ChangeSetState, ClaimOutcome, CoordinationEventKind, CoordinationFailpoint,
    DurableStore, DynamicExpansionPolicy, GraphGeneration, GraphSnapshot, IdempotencyClass,
    IntentAnalysis, IntentParameters, IntentRecord, Kernel, ResourceVersion, SCHEMA_VERSION,
    SubmissionOutcome, TestSemanticProvider, TicketState,
};
use tempfile::tempdir;

const GRAPH_META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");

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
    Kernel::create_with_test_semantics(
        path,
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        },
        Arc::new(TargetAnalyzer),
    )
    .unwrap()
    .0
}

fn begin_and_submit(kernel: &Kernel, id: &str, target: &str, now_tick: u64) -> SubmissionOutcome {
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: id.into(),
            actor: "agent:test".into(),
            reasoning: "exercise restart recovery".into(),
            submission_idempotency_key: format!("submission:{id}"),
        })
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
