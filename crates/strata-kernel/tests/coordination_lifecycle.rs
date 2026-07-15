#![cfg(feature = "redb-spike-api")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;
use strata_kernel::{
    BeginChangeSet, ChangeSetState, ClaimOutcome, CoordinationEventKind, DurableStore,
    DynamicExpansionPolicy, GraphGeneration, GraphSnapshot, IdempotencyClass, IntentAnalysis,
    IntentParameters, IntentRecord, Kernel, READY_OFFER_TTL_TICKS, ResourceVersion, SCHEMA_VERSION,
    SubmissionOutcome, TestSemanticProvider, TicketState,
};
use tempfile::tempdir;
use uuid::Uuid;

#[derive(Clone)]
struct SequencedAnalyzer {
    analyses: Arc<Mutex<Vec<IntentAnalysis>>>,
    calls: Arc<AtomicUsize>,
}

impl SequencedAnalyzer {
    fn new(analyses: Vec<IntentAnalysis>) -> Self {
        Self {
            analyses: Arc::new(Mutex::new(analyses)),
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl TestSemanticProvider for SequencedAnalyzer {
    fn analyze(
        &self,
        _graph: &GraphGeneration,
        _intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let analyses = self.analyses.lock().unwrap();
        analyses
            .get(index)
            .cloned()
            .or_else(|| analyses.last().cloned())
            .context("missing sequenced analysis")
    }
}

fn analysis(keys: &[&str], max_expansions: u32) -> IntentAnalysis {
    let resources = keys
        .iter()
        .map(|key| ResourceVersion::new(*key, "v0").unwrap())
        .collect::<Vec<_>>();
    IntentAnalysis {
        read_set: resources.clone(),
        write_set: resources.clone(),
        validation_set: resources,
        reservation_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
        dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions },
        idempotency_class: IdempotencyClass::ReplaySafe,
    }
}

fn kernel(path: &std::path::Path, analyzer: SequencedAnalyzer) -> Kernel {
    Kernel::create_with_test_semantics(
        path,
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        },
        Arc::new(analyzer),
    )
    .unwrap()
    .0
}

fn begin_and_add(kernel: &Kernel, id: &str) {
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: id.into(),
            actor: "agent:test".into(),
            reasoning: "exercise lifecycle".into(),
            submission_idempotency_key: format!("submission:{id}"),
        })
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: format!("declaration:{id}"),
                new_name: format!("renamed:{id}"),
            },
        )
        .unwrap();
}

fn submit_ready(
    kernel: &Kernel,
    id: &str,
    now_tick: u64,
) -> (strata_kernel::CoordinationTicket, strata_kernel::ReadyOffer) {
    begin_and_add(kernel, id);
    match kernel.submit_change_set(id, now_tick).unwrap() {
        SubmissionOutcome::Ready { ticket, offer } => (ticket, offer),
        other => panic!("expected ready submission, got {other:?}"),
    }
}

#[test]
fn submit_atomically_persists_ready_offer_and_holds_full_priority_scope() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![
        analysis(&["symbol:A", "node:X"], 3),
        analysis(&["symbol:A", "node:X"], 3),
        analysis(&["node:X"], 3),
        analysis(&["node:X"], 3),
        analysis(&["symbol:B"], 3),
        analysis(&["node:X"], 3),
        analysis(&["symbol:B"], 3),
    ]);
    let kernel = kernel(&path, analyzer.clone());
    let (first_ticket, first_offer) = submit_ready(&kernel, "first", 10);

    assert_eq!(first_ticket.state, TicketState::Ready);
    assert_eq!(
        first_ticket.ready_offer_id.as_deref(),
        Some(first_offer.offer_id.as_str())
    );
    assert!(first_ticket.active_claim_id.is_none());
    assert_eq!(first_offer.graph_generation, 0);
    assert_eq!(first_offer.service_epoch, kernel.service_epoch());
    assert_eq!(
        first_offer.scope_fingerprint,
        first_ticket.scope_fingerprint
    );
    assert_eq!(first_offer.expires_at_tick, 10 + READY_OFFER_TTL_TICKS);
    Uuid::parse_str(&first_offer.claim_token).expect("claim token must be opaque UUID data");

    begin_and_add(&kernel, "overlap");
    let overlap_ticket = match kernel.submit_change_set("overlap", 11).unwrap() {
        SubmissionOutcome::Queued { ticket } => ticket,
        other => panic!("expected queued overlap, got {other:?}"),
    };
    assert_eq!(overlap_ticket.state, TicketState::Queued);
    assert!(overlap_ticket.ready_offer_id.is_none());
    assert!(overlap_ticket.active_claim_id.is_none());

    let (disjoint_ticket, _) = submit_ready(&kernel, "disjoint", 12);
    assert_eq!(disjoint_ticket.state, TicketState::Ready);

    drop(kernel);
    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    let offers = durable.ready_offers().unwrap();
    assert_eq!(offers.len(), 2);
    assert!(offers.iter().any(|offer| offer == &first_offer));
    assert_eq!(
        durable.change_set("first").unwrap().unwrap().state,
        ChangeSetState::Ready
    );
    assert_eq!(
        durable.event(1).unwrap().unwrap().kind,
        CoordinationEventKind::IntentQueued
    );
    assert_eq!(
        durable.event(2).unwrap().unwrap().kind,
        CoordinationEventKind::IntentReady
    );
}

#[test]
fn claim_validation_failures_leave_the_offer_claimable_exactly_once() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![analysis(&["symbol:A"], 3); 3]);
    let kernel = kernel(&path, analyzer.clone());
    let (_, offer) = submit_ready(&kernel, "claimable", 5);

    let wrong = kernel
        .claim_ready(&offer.offer_id, "wrong-token", 6)
        .unwrap_err();
    assert!(wrong.to_string().contains("claim token"));
    let expired = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, offer.expires_at_tick)
        .unwrap_err();
    assert!(expired.to_string().contains("expired"));

    let claimed = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 6)
        .unwrap();
    let ClaimOutcome::Claimed(claim) = claimed else {
        panic!("expected claim")
    };
    Uuid::parse_str(&claim.claim_id).expect("claim ID must be fresh opaque UUID data");
    assert_eq!(claim.reservation_keys, vec!["symbol:A"]);
    let duplicate = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 6)
        .unwrap_err();
    assert!(duplicate.to_string().contains("does not exist"));
    assert_eq!(analyzer.calls(), 3, "invalid claims must not run analysis");

    drop(kernel);
    let store = DurableStore::open(&path).unwrap();
    let durable = store.coordination();
    assert_eq!(durable.active_claims().unwrap(), vec![claim.clone()]);
    let claimed_ticket = durable.active_tickets().unwrap().pop().unwrap();
    assert_eq!(claimed_ticket.state, TicketState::Claimed);
    assert_eq!(
        claimed_ticket.active_claim_id.as_deref(),
        Some(claim.claim_id.as_str())
    );
}

#[test]
fn reopening_invalidates_prior_epoch_offers_before_exposing_the_kernel() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![analysis(&["symbol:A"], 3)]);
    let first = kernel(&path, analyzer.clone());
    let (_, offer) = submit_ready(&first, "stale", 1);
    let old_epoch = first.service_epoch();
    drop(first);

    let (reopened, _) =
        Kernel::open_with_test_semantics(&path, Arc::new(analyzer.clone())).unwrap();
    assert!(reopened.service_epoch() > old_epoch);
    let error = reopened
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap_err();
    assert!(error.to_string().contains("does not exist"));
}

#[test]
fn expiry_consumes_old_offer_and_atomically_reoffers_the_oldest_ticket() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![analysis(&["symbol:A"], 3)]);
    let kernel = kernel(&path, analyzer.clone());
    let (_, offer) = submit_ready(&kernel, "expiring", 10);

    assert!(kernel.expire_ready_offers(39).unwrap().is_empty());
    assert_eq!(
        kernel.expire_ready_offers(offer.expires_at_tick).unwrap(),
        vec![offer.offer_id.clone()]
    );
    let stale = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, offer.expires_at_tick)
        .unwrap_err();
    assert!(stale.to_string().contains("does not exist"));
    assert!(
        kernel
            .reconsider_tickets(offer.expires_at_tick)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn claim_reanalyzes_and_strict_expansion_requeues_three_times_then_needs_decision() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![
        analysis(&["symbol:A"], 3),
        analysis(&["symbol:A"], 3),
        analysis(&["symbol:A", "node:1"], 3),
        analysis(&["symbol:A", "node:1"], 3),
        analysis(&["symbol:A", "node:1", "node:2"], 3),
        analysis(&["symbol:A", "node:1", "node:2"], 3),
        analysis(&["symbol:A", "node:1", "node:2", "node:3"], 3),
        analysis(&["symbol:A", "node:1", "node:2", "node:3"], 3),
        analysis(&["symbol:A", "node:1", "node:2", "node:3", "node:4"], 3),
    ]);
    let kernel = kernel(&path, analyzer.clone());
    let (expanding_ticket, mut offer) = submit_ready(&kernel, "expanding", 0);

    for expansion_count in 1..=3 {
        let outcome = kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, expansion_count)
            .unwrap();
        let ClaimOutcome::Requeued { ticket, event } = outcome else {
            panic!("expansion {expansion_count} should requeue")
        };
        assert_eq!(ticket.state, TicketState::Queued);
        assert_eq!(event.kind, CoordinationEventKind::ScopeExpanded);
        let offers = kernel.reconsider_tickets(expansion_count + 10).unwrap();
        assert_eq!(offers.len(), 1);
        offer = offers.into_iter().next().unwrap();
    }

    let outcome = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 20)
        .unwrap();
    let ClaimOutcome::NeedsDecision { change_set, event } = outcome else {
        panic!("fourth expansion should require a decision")
    };
    assert_eq!(change_set.state, ChangeSetState::NeedsDecision);
    assert_eq!(change_set.expansion_count, 3);
    assert_eq!(event.kind, CoordinationEventKind::IntentNeedsDecision);
    assert_eq!(analyzer.calls(), 9);
    drop(kernel);
    let store = DurableStore::open(&path).unwrap();
    assert_eq!(
        store
            .coordination()
            .ticket(&expanding_ticket.ticket_id)
            .unwrap()
            .unwrap()
            .state,
        TicketState::NeedsDecision
    );
}

#[test]
fn material_scope_change_needs_decision_and_cancellation_unblocks_waiters() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let changing = SequencedAnalyzer::new(vec![
        analysis(&["symbol:A"], 3),
        analysis(&["symbol:A"], 3),
        analysis(&["symbol:B"], 3),
        analysis(&["node:X"], 3),
        analysis(&["node:X"], 3),
        analysis(&["node:X"], 3),
    ]);
    let kernel = kernel(&path, changing.clone());
    let (changing_ticket, offer) = submit_ready(&kernel, "changing", 0);
    let outcome = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 1)
        .unwrap();
    let ClaimOutcome::NeedsDecision { change_set, event } = outcome else {
        panic!("material change should require a decision")
    };
    assert_eq!(change_set.state, ChangeSetState::NeedsDecision);
    assert_eq!(event.kind, CoordinationEventKind::IntentNeedsDecision);

    let _ = submit_ready(&kernel, "blocker", 2);
    begin_and_add(&kernel, "waiting");
    assert!(matches!(
        kernel.submit_change_set("waiting", 3).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));
    let cancellation = kernel.cancel_change_set("blocker", 4).unwrap();
    assert_eq!(cancellation.change_set.state, ChangeSetState::Cancelled);
    assert_eq!(cancellation.ready_offers.len(), 1);
    let waiting_offer = &cancellation.ready_offers[0];
    assert_eq!(waiting_offer.change_set_id, "waiting");
    let claim = kernel
        .claim_ready(&waiting_offer.offer_id, &waiting_offer.claim_token, 5)
        .unwrap();
    assert!(matches!(claim, ClaimOutcome::Claimed(_)));
    assert!(kernel.reconsider_tickets(5).unwrap().is_empty());
    drop(kernel);
    let store = DurableStore::open(&path).unwrap();
    assert_eq!(
        store
            .coordination()
            .ticket(&changing_ticket.ticket_id)
            .unwrap()
            .unwrap()
            .state,
        TicketState::NeedsDecision
    );
}

#[test]
fn begin_reuses_the_submission_key_without_creating_a_second_draft() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let kernel = kernel(&path, SequencedAnalyzer::new(Vec::new()));
    let input = BeginChangeSet {
        change_set_id: "original".into(),
        actor: "agent:test".into(),
        reasoning: "idempotent".into(),
        submission_idempotency_key: "submission:stable".into(),
    };
    let original = kernel.begin_change_set(input.clone()).unwrap();
    let duplicate = kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: "different".into(),
            ..input
        })
        .unwrap();
    assert_eq!(duplicate, original);
}

#[test]
fn claim_handle_serialization_contains_scope_but_no_fencing_or_publication_data() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = SequencedAnalyzer::new(vec![analysis(&["symbol:A"], 3); 2]);
    let kernel = kernel(&path, analyzer);
    let (_, offer) = submit_ready(&kernel, "serialized", 0);
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 1)
        .unwrap()
    else {
        panic!("expected claim")
    };
    let value = serde_json::to_value(claim).unwrap();
    assert!(value.get("reservationKeys").is_some());
    for forbidden in [
        "fenceClaim",
        "resourceTokens",
        "delta",
        "publication",
        "publish",
    ] {
        assert!(value.get(forbidden).is_none(), "unexpected {forbidden}");
    }
}

#[test]
fn claim_handle_has_no_fencing_or_raw_publication_capability() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/claim_has_no_fence.rs");
}
