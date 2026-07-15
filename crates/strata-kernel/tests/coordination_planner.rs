#![cfg(feature = "coordination-test-api")]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
#[cfg(feature = "redb-spike-api")]
use std::time::Duration;

use strata_kernel::{
    BeginChangeSet, ClaimOutcome, DynamicExpansionPolicy, GraphGeneration, GraphSnapshot,
    IdempotencyClass, InferredScope, IntentAnalysis, IntentParameters, IntentRecord, Kernel,
    ReadyOffer, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome, TestSemanticProvider,
    canonical_scope_fingerprint,
};
#[cfg(feature = "redb-spike-api")]
use strata_kernel::{
    EventRecord, GraphChange, GraphDelta, NodeRecord, OperationRecord, Publication, TicketRecord,
};
use tempfile::tempdir;

#[derive(Clone, Copy, Debug)]
enum TestCause {
    Submission,
    Reconsideration,
    Restart,
}

#[derive(Clone)]
struct RecordingProvider {
    calls: Arc<AtomicUsize>,
    width: Arc<AtomicUsize>,
    latest_scope_fingerprint: Arc<Mutex<String>>,
}

impl RecordingProvider {
    fn new() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            width: Arc::new(AtomicUsize::new(1)),
            latest_scope_fingerprint: Arc::new(Mutex::new(String::new())),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn expand(&self) {
        self.width.store(2, Ordering::SeqCst);
    }

    fn latest_scope_fingerprint(&self) -> String {
        self.latest_scope_fingerprint.lock().unwrap().clone()
    }
}

impl TestSemanticProvider for RecordingProvider {
    fn analyze(
        &self,
        _graph: &GraphGeneration,
        _intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let keys = if self.width.load(Ordering::SeqCst) == 1 {
            vec!["symbol:target".to_owned()]
        } else {
            vec!["node:dependent".to_owned(), "symbol:target".to_owned()]
        };
        let resources = keys
            .iter()
            .map(|key| ResourceVersion::new(key, "v0").unwrap())
            .collect::<Vec<_>>();
        let analysis = IntentAnalysis {
            read_set: resources.clone(),
            write_set: resources.clone(),
            validation_set: resources.clone(),
            reservation_keys: keys,
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        };
        let mut scope = InferredScope {
            read_set: analysis.read_set.clone(),
            write_set: analysis.write_set.clone(),
            validation_set: analysis.validation_set.clone(),
            reservation_keys: analysis.reservation_keys.clone(),
            scope_fingerprint: String::new(),
            dynamic_expansion_policy: analysis.dynamic_expansion_policy.clone(),
            idempotency_class: analysis.idempotency_class.clone(),
        };
        scope.scope_fingerprint = canonical_scope_fingerprint(&scope)?;
        *self.latest_scope_fingerprint.lock().unwrap() = scope.scope_fingerprint;
        Ok(analysis)
    }
}

fn create_kernel(path: &std::path::Path, provider: RecordingProvider) -> Kernel {
    Kernel::create_with_test_semantics(
        path,
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: Vec::new(),
            references: Vec::new(),
        },
        Arc::new(provider),
    )
    .unwrap()
    .0
}

fn begin_and_add(kernel: &Kernel, id: &str) {
    begin_and_add_target(kernel, id, "target");
}

fn begin_and_add_target(kernel: &Kernel, id: &str, declaration_id: &str) {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: id.to_owned(),
                actor: "agent:planner-test".to_owned(),
                reasoning: "prove fresh readiness".to_owned(),
                submission_idempotency_key: format!("submission:{id}"),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: declaration_id.to_owned(),
                new_name: format!("renamed_{id}"),
            },
        )
        .unwrap();
}

#[cfg(feature = "redb-spike-api")]
#[derive(Clone)]
struct SubmissionRaceProvider {
    calls_by_declaration: Arc<Mutex<BTreeMap<String, usize>>>,
    fingerprints: Arc<Mutex<BTreeMap<(String, u64), String>>>,
    gate: Arc<(Mutex<(usize, bool)>, Condvar)>,
}

#[cfg(feature = "redb-spike-api")]
impl SubmissionRaceProvider {
    fn new() -> Self {
        Self {
            calls_by_declaration: Arc::new(Mutex::new(BTreeMap::new())),
            fingerprints: Arc::new(Mutex::new(BTreeMap::new())),
            gate: Arc::new((Mutex::new((0, false)), Condvar::new())),
        }
    }

    fn wait_until_planners_are_blocked(&self, expected: usize) -> bool {
        let (lock, changed) = &*self.gate;
        let mut state = lock.lock().unwrap();
        while state.0 < expected {
            let (next, timeout) = changed.wait_timeout(state, Duration::from_secs(2)).unwrap();
            state = next;
            if timeout.timed_out() {
                return false;
            }
        }
        true
    }

    fn release(&self) {
        let (lock, changed) = &*self.gate;
        lock.lock().unwrap().1 = true;
        changed.notify_all();
    }

    fn fingerprint(&self, declaration_id: &str, generation: u64) -> String {
        self.fingerprints
            .lock()
            .unwrap()
            .get(&(declaration_id.to_owned(), generation))
            .cloned()
            .unwrap_or_else(|| {
                panic!("missing {declaration_id} analysis at generation {generation}")
            })
    }
}

#[cfg(feature = "redb-spike-api")]
impl TestSemanticProvider for SubmissionRaceProvider {
    fn analyze(
        &self,
        graph: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let IntentParameters::RenameSymbol { declaration_id, .. } = &intent.parameters else {
            anyhow::bail!("test provider only supports rename")
        };
        let call = {
            let mut calls = self.calls_by_declaration.lock().unwrap();
            let count = calls.entry(declaration_id.clone()).or_default();
            *count += 1;
            *count
        };
        if matches!(declaration_id.as_str(), "caller-a" | "caller-b") && call >= 2 {
            let (lock, changed) = &*self.gate;
            let mut state = lock.lock().unwrap();
            if !state.1 {
                state.0 += 1;
                changed.notify_all();
                while !state.1 {
                    state = changed.wait(state).unwrap();
                }
            }
        }

        let key = format!("symbol:{declaration_id}");
        let resources = vec![ResourceVersion::new(&key, "v0").map_err(anyhow::Error::msg)?];
        let analysis = IntentAnalysis {
            read_set: resources.clone(),
            write_set: resources.clone(),
            validation_set: resources,
            reservation_keys: vec![key],
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        };
        let mut scope = InferredScope {
            read_set: analysis.read_set.clone(),
            write_set: analysis.write_set.clone(),
            validation_set: analysis.validation_set.clone(),
            reservation_keys: analysis.reservation_keys.clone(),
            scope_fingerprint: String::new(),
            dynamic_expansion_policy: analysis.dynamic_expansion_policy.clone(),
            idempotency_class: analysis.idempotency_class.clone(),
        };
        scope.scope_fingerprint = canonical_scope_fingerprint(&scope)?;
        self.fingerprints.lock().unwrap().insert(
            (declaration_id.clone(), graph.generation()),
            scope.scope_fingerprint,
        );
        Ok(analysis)
    }
}

#[cfg(feature = "redb-spike-api")]
fn publication_after_blocked_submissions(kernel: &Kernel) -> Publication {
    let changed_node = NodeRecord {
        id: "node:clock".to_owned(),
        kind: "InterfaceDeclaration".to_owned(),
        parent_id: None,
        child_index: Some(0),
        payload: "export interface Clock { readonly advanced: true }".to_owned(),
    };
    Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: "publication:between-submissions".to_owned(),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: changed_node }],
        },
        operation: OperationRecord {
            operation_id: "operation:between-submissions".to_owned(),
            change_set_id: "change-set:publication".to_owned(),
            actor: "agent:planner-test".to_owned(),
            kind: "UpdateClock".to_owned(),
            reasoning: "advance the graph while readiness planning is blocked".to_owned(),
            affected_node_ids: vec!["node:clock".to_owned()],
        },
        ticket: TicketRecord {
            ticket_id: "ticket:publication".to_owned(),
            state: "published".to_owned(),
            scope_fingerprint: "scope:publication".to_owned(),
        },
        event: EventRecord {
            event_id: "event:publication".to_owned(),
            sequence: 1,
            kind: "PublicationCommitted".to_owned(),
            graph_generation: 1,
            payload_json: "{}".to_owned(),
        },
        fence: kernel.issue_fence(&["symbol:Clock".to_owned()]).unwrap(),
    }
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn concurrent_submissions_retry_after_publication_without_scope_crossing() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let provider = SubmissionRaceProvider::new();
    let kernel = Arc::new(
        Kernel::create_with_test_semantics(
            &path,
            GraphSnapshot {
                schema_version: SCHEMA_VERSION,
                generation: 0,
                nodes: vec![NodeRecord {
                    id: "node:clock".to_owned(),
                    kind: "InterfaceDeclaration".to_owned(),
                    parent_id: None,
                    child_index: Some(0),
                    payload: "export interface Clock {}".to_owned(),
                }],
                references: Vec::new(),
            },
            Arc::new(provider.clone()),
        )
        .unwrap()
        .0,
    );

    begin_and_add_target(&kernel, "submission-a", "caller-a");
    let submitting_a = {
        let kernel = kernel.clone();
        std::thread::spawn(move || kernel.submit_change_set("submission-a", 10))
    };

    if !provider.wait_until_planners_are_blocked(1) {
        let outcome = submitting_a.join().unwrap().unwrap();
        panic!("submission planner did not perform fresh analysis: {outcome:?}");
    }

    begin_and_add_target(&kernel, "submission-b", "caller-b");
    let submitting_b = {
        let kernel = kernel.clone();
        std::thread::spawn(move || kernel.submit_change_set("submission-b", 11))
    };
    if !provider.wait_until_planners_are_blocked(2) {
        provider.release();
        let _ = submitting_a.join();
        let _ = submitting_b.join();
        panic!("both submission planners did not reach fresh analysis");
    }

    let report = kernel
        .publish(publication_after_blocked_submissions(&kernel))
        .unwrap();
    assert_eq!(report.generation, 1);
    provider.release();

    let outcomes = [
        (
            "submission-a",
            "caller-a",
            submitting_a.join().unwrap().unwrap(),
        ),
        (
            "submission-b",
            "caller-b",
            submitting_b.join().unwrap().unwrap(),
        ),
    ];
    for (change_set_id, declaration_id, outcome) in outcomes {
        let SubmissionOutcome::Ready { ticket, offer } = outcome else {
            panic!("{change_set_id} was stranded instead of Ready: {outcome:?}")
        };
        assert_eq!(ticket.change_set_id, change_set_id);
        assert_eq!(offer.change_set_id, change_set_id);
        assert_eq!(offer.graph_generation, 1);
        assert_eq!(
            offer.scope_fingerprint,
            provider.fingerprint(declaration_id, 1)
        );
    }
    assert_eq!(kernel.snapshot().generation(), 1);
    assert!(
        ["submission-a", "submission-b"]
            .into_iter()
            .all(|id| kernel.ready_offer_for_change_set(id).unwrap().is_some())
    );
}

fn submit_ready(kernel: &Kernel, id: &str, now_tick: u64) -> ReadyOffer {
    begin_and_add(kernel, id);
    match kernel.submit_change_set(id, now_tick).unwrap() {
        SubmissionOutcome::Ready { offer, .. } => offer,
        outcome => panic!("expected Ready submission, got {outcome:?}"),
    }
}

#[test]
fn every_ready_transition_uses_fresh_analysis() {
    for cause in [
        TestCause::Submission,
        TestCause::Reconsideration,
        TestCause::Restart,
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let provider = RecordingProvider::new();
        let kernel = create_kernel(&path, provider.clone());

        let (kernel, before_calls, offer) = match cause {
            TestCause::Submission => {
                begin_and_add(&kernel, "submission");
                let before_calls = provider.calls();
                let offer = match kernel.submit_change_set("submission", 10).unwrap() {
                    SubmissionOutcome::Ready { offer, .. } => offer,
                    outcome => panic!("expected Ready submission, got {outcome:?}"),
                };
                (kernel, before_calls, offer)
            }
            TestCause::Reconsideration => {
                let offer = submit_ready(&kernel, "reconsideration", 10);
                provider.expand();
                let ClaimOutcome::Requeued { .. } = kernel
                    .claim_ready(&offer.offer_id, &offer.claim_token, 11)
                    .unwrap()
                else {
                    panic!("expanded claim should requeue")
                };
                let before_calls = provider.calls();
                let offer = kernel
                    .reconsider_tickets(12)
                    .unwrap()
                    .into_iter()
                    .next()
                    .expect("reconsideration should create an offer");
                (kernel, before_calls, offer)
            }
            TestCause::Restart => {
                submit_ready(&kernel, "restart", 10);
                drop(kernel);
                let before_calls = provider.calls();
                let (reopened, _) =
                    Kernel::open_with_test_semantics(&path, Arc::new(provider.clone())).unwrap();
                let offer = reopened
                    .ready_offer_for_change_set("restart")
                    .unwrap()
                    .expect("restart planning should create an offer");
                (reopened, before_calls, offer)
            }
        };

        assert!(provider.calls() > before_calls, "{cause:?}");
        assert_eq!(
            offer.scope_fingerprint,
            provider.latest_scope_fingerprint(),
            "{cause:?}"
        );
        assert_eq!(
            offer.graph_generation,
            kernel.snapshot().generation(),
            "{cause:?}"
        );
    }
}

#[test]
fn ready_offer_cannot_be_constructed_outside_planner() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/ready_offer_is_planner_private.rs");
}

#[derive(Clone)]
struct ContendedProvider {
    expanded: Arc<AtomicBool>,
    block_next_target: Arc<AtomicBool>,
    target_calls: Arc<AtomicUsize>,
    gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
}

impl ContendedProvider {
    fn new() -> Self {
        Self {
            expanded: Arc::new(AtomicBool::new(false)),
            block_next_target: Arc::new(AtomicBool::new(false)),
            target_calls: Arc::new(AtomicUsize::new(0)),
            gate: Arc::new((Mutex::new((false, false)), Condvar::new())),
        }
    }

    fn wait_until_blocked(&self) {
        let (lock, changed) = &*self.gate;
        let mut state = lock.lock().unwrap();
        while !state.0 {
            state = changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let (lock, changed) = &*self.gate;
        lock.lock().unwrap().1 = true;
        changed.notify_all();
    }
}

impl TestSemanticProvider for ContendedProvider {
    fn analyze(
        &self,
        _graph: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        let IntentParameters::RenameSymbol { declaration_id, .. } = &intent.parameters else {
            anyhow::bail!("test provider only supports rename")
        };
        if declaration_id == "target" {
            self.target_calls.fetch_add(1, Ordering::SeqCst);
            if self.block_next_target.swap(false, Ordering::SeqCst) {
                let (lock, changed) = &*self.gate;
                let mut state = lock.lock().unwrap();
                state.0 = true;
                changed.notify_all();
                while !state.1 {
                    state = changed.wait(state).unwrap();
                }
            }
        }
        let mut keys = vec![format!("symbol:{declaration_id}")];
        if declaration_id == "target" && self.expanded.load(Ordering::SeqCst) {
            keys.push("node:dependent".to_owned());
            keys.sort();
        }
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

#[test]
fn scheduler_revision_discards_a_stale_readiness_plan_and_retries() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let provider = ContendedProvider::new();
    let kernel = Arc::new(
        Kernel::create_with_test_semantics(
            &path,
            GraphSnapshot {
                schema_version: SCHEMA_VERSION,
                generation: 0,
                nodes: Vec::new(),
                references: Vec::new(),
            },
            Arc::new(provider.clone()),
        )
        .unwrap()
        .0,
    );
    let first_offer = submit_ready(&kernel, "target-work", 1);
    provider.expanded.store(true, Ordering::SeqCst);
    let ClaimOutcome::Requeued { .. } = kernel
        .claim_ready(&first_offer.offer_id, &first_offer.claim_token, 2)
        .unwrap()
    else {
        panic!("expanded claim should requeue")
    };

    provider.block_next_target.store(true, Ordering::SeqCst);
    let reconsidering = {
        let kernel = kernel.clone();
        std::thread::spawn(move || kernel.reconsider_tickets(3))
    };
    provider.wait_until_blocked();

    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "disjoint".to_owned(),
                actor: "agent:planner-test".to_owned(),
                reasoning: "advance the scheduler revision".to_owned(),
                submission_idempotency_key: "submission:disjoint".to_owned(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            "disjoint",
            IntentParameters::RenameSymbol {
                declaration_id: "other".to_owned(),
                new_name: "renamed_other".to_owned(),
            },
        )
        .unwrap();
    assert!(matches!(
        kernel.submit_change_set("disjoint", 4).unwrap(),
        SubmissionOutcome::Ready { .. }
    ));

    provider.release();
    let retried_offers = reconsidering.join().unwrap().unwrap();
    assert!(
        retried_offers.is_empty(),
        "the competing fresh submission plan already readied all eligible work"
    );
    let durable_offers = ["target-work", "disjoint"]
        .into_iter()
        .map(|id| (id, kernel.ready_offer_for_change_set(id).unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert!(durable_offers.values().all(Option::is_some));
    assert_eq!(provider.target_calls.load(Ordering::SeqCst), 5);
    assert_eq!(
        kernel.test_scheduler_revisions().unwrap(),
        (9, 9),
        "the discarded plan must not consume a durable revision"
    );
}
