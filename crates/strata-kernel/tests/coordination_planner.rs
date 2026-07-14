#![cfg(feature = "coordination-test-api")]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use strata_kernel::{
    BeginChangeSet, ClaimOutcome, DynamicExpansionPolicy, GraphGeneration, GraphSnapshot,
    IdempotencyClass, InferredScope, IntentAnalysis, IntentParameters, IntentRecord, Kernel,
    ReadyOffer, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome, TestSemanticProvider,
    canonical_scope_fingerprint,
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
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: id.to_owned(),
            actor: "agent:planner-test".to_owned(),
            reasoning: "prove fresh readiness".to_owned(),
            submission_idempotency_key: format!("submission:{id}"),
        })
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: "target".to_owned(),
                new_name: format!("renamed_{id}"),
            },
        )
        .unwrap();
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
        .begin_change_set(BeginChangeSet {
            change_set_id: "disjoint".to_owned(),
            actor: "agent:planner-test".to_owned(),
            reasoning: "advance the scheduler revision".to_owned(),
            submission_idempotency_key: "submission:disjoint".to_owned(),
        })
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
        retried_offers
            .iter()
            .any(|offer| offer.change_set_id == "target-work")
    );
    let durable_offers = ["target-work", "disjoint"]
        .into_iter()
        .map(|id| (id, kernel.ready_offer_for_change_set(id).unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert!(durable_offers.values().all(Option::is_some));
    assert_eq!(provider.target_calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        kernel.test_scheduler_revisions().unwrap(),
        (6, 6),
        "the discarded plan must not consume a durable revision"
    );
}
