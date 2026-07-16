#![cfg(feature = "coordination-test-api")]

#[path = "support/coordination.rs"]
#[allow(dead_code)]
mod coordination_support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use anyhow::Result;
use coordination_support::{
    GraphDerivedAnalyzer, MediumCoordinationFixture, NodePatchBuilder, begin_with_intents, rename,
};
#[cfg(feature = "redb-spike-api")]
use strata_kernel::DurableStore;
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, CandidateEnvelope, ChangeSetState, ClaimHandle, ClaimOutcome,
    CoordinationError, DynamicExpansionPolicy, GraphChange, GraphDelta, GraphGeneration,
    IdempotencyClass, IntentAnalysis, IntentRecord, Kernel, PreparedCandidate, PublicationReport,
    PublishClaimOutcome, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome, TestSemanticProvider,
    TicketState, required_delta_authority,
};
use tempfile::tempdir;

fn ready(outcome: SubmissionOutcome) -> strata_kernel::ReadyOffer {
    let SubmissionOutcome::Ready { offer, .. } = outcome else {
        panic!("expected ready offer")
    };
    offer
}

fn claimed(outcome: ClaimOutcome) -> ClaimHandle {
    let ClaimOutcome::Claimed(claim) = outcome else {
        panic!("expected claimed change set")
    };
    claim
}

fn published(outcome: PublishClaimOutcome) -> PublicationReport {
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("expected published outcome")
    };
    report
}

struct LockInspectingBuilder {
    kernel: Arc<Kernel>,
    inner: NodePatchBuilder,
}

struct LifecycleProbeBuilder {
    kernel: Arc<Kernel>,
    inner: NodePatchBuilder,
}

impl CandidateBuilder for LifecycleProbeBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        let disjoint_offer = ready(self.kernel.submit_change_set("disjoint", 52)?);
        let disjoint_claim = claimed(self.kernel.claim_ready(
            &disjoint_offer.offer_id,
            &disjoint_offer.claim_token,
            53,
        )?);
        assert_eq!(disjoint_claim.change_set_id, "disjoint");
        assert!(self.kernel.reconsider_tickets(54)?.is_empty());
        let cancelled = self.kernel.cancel_change_set("other", 55)?;
        assert_eq!(cancelled.change_set.state, ChangeSetState::Cancelled);
        let expired = self.kernel.expire_leases(61)?;
        assert!(
            expired.iter().any(|outcome| {
                outcome.change_set_id == "expiring" && outcome.authority_kind == "claim"
            }),
            "builder progress must exercise an actually due claim expiry"
        );
        assert!(!self.kernel.events_after("observer", 0, 100)?.is_empty());
        self.inner.build_candidate(prepared)
    }
}

struct PanickingBuilder;

impl CandidateBuilder for PanickingBuilder {
    fn build_candidate(&self, _prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        panic!("deterministic candidate panic")
    }
}

#[derive(Clone)]
struct RoleProvider {
    analyses: Arc<BTreeMap<String, IntentAnalysis>>,
}

#[derive(Clone)]
struct RecordingGraphProvider {
    inner: GraphDerivedAnalyzer,
    generations: Arc<Mutex<Vec<u64>>>,
    kernel: Arc<Mutex<Option<Weak<Kernel>>>>,
}

impl TestSemanticProvider for RecordingGraphProvider {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        if let Some(kernel) = self.kernel.lock().unwrap().as_ref().and_then(Weak::upgrade) {
            assert!(
                kernel.test_publication_mutexes_available(),
                "semantic planning must run outside both global mutexes"
            );
        }
        self.generations.lock().unwrap().push(graph.generation());
        self.inner.analyze(graph, intent)
    }
}

impl TestSemanticProvider for RoleProvider {
    fn analyze(&self, _graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        let strata_kernel::IntentParameters::RenameSymbol { declaration_id, .. } =
            &intent.parameters
        else {
            panic!("role provider only accepts rename intents")
        };
        Ok(self.analyses.get(declaration_id).unwrap().clone())
    }
}

fn fixed_analysis(write_keys: Vec<String>, reservation_keys: Vec<String>) -> IntentAnalysis {
    let resources = write_keys
        .into_iter()
        .map(|key| ResourceVersion::new(key, "stable").unwrap())
        .collect::<Vec<_>>();
    IntentAnalysis {
        read_set: resources.clone(),
        write_set: resources.clone(),
        validation_set: resources,
        reservation_keys,
        dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
        idempotency_class: IdempotencyClass::ReplaySafe,
    }
}

struct DeltaBuilder(Vec<GraphChange>);

struct CountingDeltaBuilder {
    calls: AtomicUsize,
    changes: Vec<GraphChange>,
}

struct RecordingGenerationBuilder {
    generations: Arc<Mutex<Vec<u64>>>,
    changes: Vec<GraphChange>,
}

#[derive(Clone)]
struct FailingContractingProvider {
    inner: GraphDerivedAnalyzer,
    blocker_id: String,
    contracting_change_set_id: String,
    failing_change_set_id: String,
    stable_change_set_id: String,
    fail_queued: Arc<AtomicBool>,
    contracting_calls: Arc<AtomicUsize>,
    stable_analysis: Arc<Mutex<Option<IntentAnalysis>>>,
}

impl TestSemanticProvider for FailingContractingProvider {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        if intent.change_set_id == self.failing_change_set_id
            && self.fail_queued.load(Ordering::SeqCst)
        {
            anyhow::bail!("deterministic queued semantic failure")
        }
        if intent.change_set_id == self.stable_change_set_id {
            let mut stable = self.stable_analysis.lock().unwrap();
            if let Some(analysis) = stable.as_ref() {
                return Ok(analysis.clone());
            }
            let analysis = self.inner.analyze(graph, intent)?;
            *stable = Some(analysis.clone());
            return Ok(analysis);
        }
        let mut analysis = self.inner.analyze(graph, intent)?;
        if intent.change_set_id == self.contracting_change_set_id
            && self.contracting_calls.fetch_add(1, Ordering::SeqCst) < 2
        {
            analysis
                .reservation_keys
                .push(format!("symbol:{}", self.blocker_id));
        }
        Ok(analysis)
    }
}

struct ProviderFailureScenario {
    kernel: Kernel,
    provider: Arc<FailingContractingProvider>,
    trigger_claim: ClaimHandle,
    trigger_node_id: String,
}

fn provider_failure_scenario(path: &std::path::Path) -> ProviderFailureScenario {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let provider = Arc::new(FailingContractingProvider {
        inner: GraphDerivedAnalyzer::new(),
        blocker_id: user_id.clone(),
        contracting_change_set_id: "disjoint".into(),
        failing_change_set_id: "failed".into(),
        stable_change_set_id: "younger".into(),
        fail_queued: Arc::new(AtomicBool::new(false)),
        contracting_calls: Arc::new(AtomicUsize::new(0)),
        stable_analysis: Arc::new(Mutex::new(None)),
    });
    let (kernel, _) =
        Kernel::create_with_test_semantics(path, fixture.snapshot().clone(), provider.clone())
            .unwrap();
    begin_with_intents(&kernel, "trigger", [rename(&user_id, "Account")]).unwrap();
    let trigger_offer = ready(kernel.submit_change_set("trigger", 0).unwrap());
    let trigger_claim = claimed(
        kernel
            .claim_ready(&trigger_offer.offer_id, &trigger_offer.claim_token, 1)
            .unwrap(),
    );
    begin_with_intents(&kernel, "failed", [rename(&user_id, "Customer")]).unwrap();
    assert!(matches!(
        kernel.submit_change_set("failed", 2).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));
    begin_with_intents(&kernel, "disjoint", [rename(&parse_id, "parseTokens")]).unwrap();
    assert!(matches!(
        kernel.submit_change_set("disjoint", 3).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));
    begin_with_intents(&kernel, "younger", [rename(&user_id, "Member")]).unwrap();
    assert!(matches!(
        kernel.submit_change_set("younger", 3).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));
    provider.fail_queued.store(true, Ordering::SeqCst);
    ProviderFailureScenario {
        kernel,
        provider,
        trigger_claim,
        trigger_node_id: user_id,
    }
}

fn assert_provider_failure_release_state(kernel: &Kernel, trigger_state: ChangeSetState) {
    assert_eq!(
        kernel.change_set("trigger").unwrap().unwrap().state,
        trigger_state
    );
    assert_eq!(
        kernel.change_set("failed").unwrap().unwrap().state,
        ChangeSetState::Queued
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("failed")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Queued,
        "a ticket whose provider failed must never receive Ready authority"
    );
    assert_eq!(
        kernel.change_set("disjoint").unwrap().unwrap().state,
        ChangeSetState::Ready,
        "fresh disjoint work must continue through the same planner pass"
    );
    assert_eq!(
        kernel.change_set("younger").unwrap().unwrap().state,
        ChangeSetState::Queued,
        "a failed older ticket must remain a FIFO blocker for younger overlapping work"
    );
}

impl CandidateBuilder for RecordingGenerationBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        self.generations
            .lock()
            .unwrap()
            .push(prepared.graph().generation());
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph().generation(),
            changes: self.changes.clone(),
        })
    }
}

impl CountingDeltaBuilder {
    fn new(changes: Vec<GraphChange>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            changes,
        }
    }
}

impl CandidateBuilder for CountingDeltaBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph().generation(),
            changes: self.changes.clone(),
        })
    }
}

#[derive(Clone)]
struct ContractingSuccessorProvider {
    blocker_id: String,
    blocker: IntentAnalysis,
    active_id: String,
    active: IntentAnalysis,
    successor_id: String,
    successor_stale: IntentAnalysis,
    successor_fresh: IntentAnalysis,
    successor_calls: Arc<AtomicUsize>,
}

impl TestSemanticProvider for ContractingSuccessorProvider {
    fn analyze(&self, _graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        let strata_kernel::IntentParameters::RenameSymbol { declaration_id, .. } =
            &intent.parameters
        else {
            panic!("contracting provider only accepts rename intents")
        };
        if declaration_id == &self.blocker_id {
            return Ok(self.blocker.clone());
        }
        if declaration_id == &self.active_id {
            return Ok(self.active.clone());
        }
        assert_eq!(declaration_id, &self.successor_id);
        let call = self.successor_calls.fetch_add(1, Ordering::SeqCst);
        Ok(if call < 2 {
            self.successor_stale.clone()
        } else {
            self.successor_fresh.clone()
        })
    }
}

impl CandidateBuilder for DeltaBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph().generation(),
            changes: self.0.clone(),
        })
    }
}

impl CandidateBuilder for LockInspectingBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        assert!(
            self.kernel.test_publication_mutexes_available(),
            "candidate builders must run without either global mutex held"
        );
        self.inner.build_candidate(prepared)
    }
}

#[test]
fn two_disjoint_claims_captured_before_publication_both_commit_in_either_order() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();

    for order in [[0usize, 1usize], [1usize, 0usize]] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let (kernel, _) = Kernel::create_with_test_semantics(
            &path,
            fixture.snapshot().clone(),
            Arc::new(GraphDerivedAnalyzer::new()),
        )
        .unwrap();
        begin_with_intents(&kernel, "user", [rename(&user_id, "Account")]).unwrap();
        begin_with_intents(&kernel, "parse", [rename(&parse_id, "parseTokens")]).unwrap();
        let offers = [
            ready(kernel.submit_change_set("user", 0).unwrap()),
            ready(kernel.submit_change_set("parse", 0).unwrap()),
        ];
        let claims = [
            claimed(
                kernel
                    .claim_ready(&offers[0].offer_id, &offers[0].claim_token, 1)
                    .unwrap(),
            ),
            claimed(
                kernel
                    .claim_ready(&offers[1].offer_id, &offers[1].claim_token, 1)
                    .unwrap(),
            ),
        ];
        assert_eq!(claims[0].graph_generation, 0);
        assert_eq!(claims[1].graph_generation, 0);
        let builders = [
            NodePatchBuilder::new(vec![(user_id.clone(), "\n// Account".into())]),
            NodePatchBuilder::new(vec![(parse_id.clone(), "\n// parseTokens".into())]),
        ];

        let first = published(
            kernel
                .publish_claimed(&claims[order[0]], &builders[order[0]], 2)
                .unwrap(),
        );
        let second = published(
            kernel
                .publish_claimed(&claims[order[1]], &builders[order[1]], 3)
                .unwrap(),
        );
        assert_eq!((first.generation, second.generation), (1, 2));
        assert_eq!(kernel.snapshot().generation(), 2);
        assert_eq!(
            kernel.change_set("user").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
        assert_eq!(
            kernel.change_set("parse").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
        assert!(
            kernel
                .snapshot()
                .node(&user_id)
                .unwrap()
                .payload
                .contains("// Account")
        );
        assert!(
            kernel
                .snapshot()
                .node(&parse_id)
                .unwrap()
                .payload
                .contains("// parseTokens")
        );
        let live_digest = kernel.snapshot().digest().to_owned();
        drop(kernel);

        let (reopened, recovered) =
            Kernel::open_with_test_semantics(&path, Arc::new(GraphDerivedAnalyzer::new())).unwrap();
        assert_eq!(recovered.generation, 2);
        assert_eq!(reopened.snapshot().digest(), live_digest);
        assert_eq!(
            reopened.change_set("user").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
        assert_eq!(
            reopened.change_set("parse").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
    }
}

#[test]
fn queued_provider_failure_does_not_abort_claimed_publication_or_disjoint_readiness() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let ProviderFailureScenario {
        kernel,
        provider,
        trigger_claim,
        trigger_node_id,
    } = provider_failure_scenario(&path);

    let report = published(
        kernel
            .publish_claimed(
                &trigger_claim,
                &NodePatchBuilder::new(vec![(
                    trigger_node_id,
                    "\n// provider failure publication".into(),
                )]),
                4,
            )
            .unwrap(),
    );
    assert_eq!(report.generation, 1);
    assert_provider_failure_release_state(&kernel, ChangeSetState::Committed);
    let live_digest = kernel.snapshot().digest().to_owned();
    drop(kernel);

    let (reopened, recovered) = Kernel::open_with_test_semantics(&path, provider).unwrap();
    assert_eq!(recovered.generation, 1);
    assert_eq!(reopened.snapshot().digest(), live_digest);
    assert_provider_failure_release_state(&reopened, ChangeSetState::Committed);
}

#[test]
fn queued_provider_failure_does_not_abort_claimed_cancellation_or_disjoint_readiness() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let ProviderFailureScenario {
        kernel, provider, ..
    } = provider_failure_scenario(&path);

    let outcome = kernel.cancel_change_set("trigger", 4).unwrap();
    assert_eq!(outcome.change_set.state, ChangeSetState::Cancelled);
    assert_provider_failure_release_state(&kernel, ChangeSetState::Cancelled);
    let live_digest = kernel.snapshot().digest().to_owned();
    drop(kernel);

    let (reopened, recovered) = Kernel::open_with_test_semantics(&path, provider).unwrap();
    assert_eq!(recovered.generation, 0);
    assert_eq!(reopened.snapshot().digest(), live_digest);
    assert_provider_failure_release_state(&reopened, ChangeSetState::Cancelled);
}

#[test]
fn queued_provider_failure_does_not_abort_due_claim_expiry_or_disjoint_readiness() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let ProviderFailureScenario {
        kernel,
        provider,
        trigger_claim,
        ..
    } = provider_failure_scenario(&path);

    let outcomes = kernel.expire_leases(trigger_claim.expires_at_tick).unwrap();
    assert!(outcomes.iter().any(|outcome| {
        outcome.change_set_id == "trigger" && outcome.authority_kind == "claim"
    }));
    assert_provider_failure_release_state(&kernel, ChangeSetState::Queued);
    assert!(
        kernel
            .test_active_claims()
            .unwrap()
            .iter()
            .all(|claim| claim.change_set_id != "trigger")
    );
    let live_digest = kernel.snapshot().digest().to_owned();
    drop(kernel);

    let (reopened, recovered) = Kernel::open_with_test_semantics(&path, provider).unwrap();
    assert_eq!(recovered.generation, 0);
    assert_eq!(reopened.snapshot().digest(), live_digest);
    assert_provider_failure_release_state(&reopened, ChangeSetState::Ready);
    assert!(reopened.test_active_claims().unwrap().is_empty());
}

#[test]
fn candidate_builder_observes_both_global_mutexes_unlocked() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "user", [rename(&user_id, "Account")]).unwrap();
    let offer = ready(kernel.submit_change_set("user", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );
    let builder = LockInspectingBuilder {
        kernel: kernel.clone(),
        inner: NodePatchBuilder::new(vec![(user_id, "\n// Account".into())]),
    };

    kernel.publish_claimed(&claim, &builder, 2).unwrap();
}

#[test]
fn builder_can_run_disjoint_lifecycle_and_event_replay_without_global_lock_blocking() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let format_id = fixture.declaration_named("formatTimestamp").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "expiring", [rename(&parse_id, "parseExpired")]).unwrap();
    let expiring_offer = ready(kernel.submit_change_set("expiring", 0).unwrap());
    let expiring_claim = claimed(
        kernel
            .claim_ready(&expiring_offer.offer_id, &expiring_offer.claim_token, 1)
            .unwrap(),
    );
    assert_eq!(expiring_claim.expires_at_tick, 61);
    begin_with_intents(&kernel, "publishing", [rename(&user_id, "Account")]).unwrap();
    begin_with_intents(
        &kernel,
        "disjoint",
        [rename(&format_id, "formatTimelineTimestamp")],
    )
    .unwrap();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "other".into(),
                actor: "agent:other".into(),
                reasoning: "cancel while builder is active".into(),
                submission_idempotency_key: "submission:other".into(),
            },
            0,
        )
        .unwrap();
    let offer = ready(kernel.submit_change_set("publishing", 50).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 51)
            .unwrap(),
    );
    assert_eq!(claim.expires_at_tick, 111);
    let builder = LifecycleProbeBuilder {
        kernel: kernel.clone(),
        inner: NodePatchBuilder::new(vec![(user_id, "\n// Account".into())]),
    };

    let report = published(kernel.publish_claimed(&claim, &builder, 60).unwrap());
    assert_eq!(report.generation, 1);
    assert_eq!(kernel.snapshot().generation(), 1);
    assert!(
        kernel
            .snapshot()
            .node(fixture.declaration_named("User").id.as_str())
            .unwrap()
            .payload
            .contains("// Account")
    );
    assert_eq!(
        kernel.change_set("publishing").unwrap().unwrap().state,
        ChangeSetState::Committed
    );
    assert_eq!(
        kernel.change_set("disjoint").unwrap().unwrap().state,
        ChangeSetState::Executing
    );
    assert_eq!(
        kernel.change_set("other").unwrap().unwrap().state,
        ChangeSetState::Cancelled
    );
    assert_eq!(
        kernel.change_set("expiring").unwrap().unwrap().state,
        ChangeSetState::Ready
    );
    assert!(
        kernel
            .test_active_claims()
            .unwrap()
            .iter()
            .any(|claim| { claim.change_set_id == "disjoint" })
    );
    assert!(
        kernel.test_active_claims().unwrap().iter().all(|claim| {
            claim.change_set_id != "expiring" && claim.change_set_id != "publishing"
        })
    );
    let live_digest = kernel.snapshot().digest().to_owned();
    drop(builder);
    drop(kernel);

    let (reopened, recovered) =
        Kernel::open_with_test_semantics(&path, Arc::new(GraphDerivedAnalyzer::new())).unwrap();
    assert_eq!(recovered.generation, 1);
    assert_eq!(reopened.snapshot().digest(), live_digest);
    assert_eq!(
        reopened.change_set("publishing").unwrap().unwrap().state,
        ChangeSetState::Committed
    );
    assert_eq!(
        reopened.change_set("disjoint").unwrap().unwrap().state,
        ChangeSetState::Ready
    );
    assert_eq!(
        reopened.change_set("expiring").unwrap().unwrap().state,
        ChangeSetState::Ready
    );
    assert_eq!(
        reopened.change_set("other").unwrap().unwrap().state,
        ChangeSetState::Cancelled
    );
    assert!(reopened.test_active_claims().unwrap().is_empty());
}

#[test]
fn panicking_builder_leaves_claim_active_until_explicit_release() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    begin_with_intents(&kernel, "panic", [rename(&user_id, "Account")]).unwrap();
    let offer = ready(kernel.submit_change_set("panic", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );

    let error = kernel
        .publish_claimed(&claim, &PanickingBuilder, 2)
        .unwrap_err();
    assert!(error.to_string().contains("candidate builder panicked"));
    assert_eq!(
        kernel.change_set("panic").unwrap().unwrap().state,
        ChangeSetState::Executing
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("panic")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Claimed
    );
    assert_eq!(kernel.test_active_claims().unwrap(), vec![claim.clone()]);
    #[cfg(feature = "redb-spike-api")]
    {
        drop(kernel);
        let store = DurableStore::open(&path).unwrap();
        assert_eq!(
            store.coordination().active_claims().unwrap(),
            vec![claim.clone()]
        );
        drop(store);
        let (reopened, _) =
            Kernel::open_with_test_semantics(&path, Arc::new(GraphDerivedAnalyzer::new())).unwrap();
        assert!(reopened.test_active_claims().unwrap().is_empty());
        assert_eq!(
            reopened.change_set("panic").unwrap().unwrap().state,
            ChangeSetState::Ready
        );
        let late = reopened
            .publish_claimed(&claim, &PanickingBuilder, 3)
            .unwrap_err();
        assert_eq!(
            late.downcast_ref::<CoordinationError>(),
            Some(&CoordinationError::LeaseExpired)
        );
    }
    #[cfg(not(feature = "redb-spike-api"))]
    kernel.cancel_change_set("panic", 3).unwrap();
    #[cfg(not(feature = "redb-spike-api"))]
    assert_eq!(
        kernel.change_set("panic").unwrap().unwrap().state,
        ChangeSetState::Cancelled
    );
}

#[test]
fn every_dependency_clock_class_invalidates_affected_work_but_unrelated_work_rebases() {
    let fixture = MediumCoordinationFixture::load();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let user = fixture.declaration_named("User").clone();
    let parse = fixture.declaration_named("parseArgs").clone();
    let reference_source = fixture.reference_source_for("User").id.clone();
    let reference = fixture
        .snapshot()
        .references
        .iter()
        .find(|reference| reference.from_node_id == reference_source)
        .unwrap()
        .clone();
    let mut changed_user = user.clone();
    changed_user.payload.push_str("\n// clock publisher");
    let node_changes = vec![GraphChange::UpsertNode { node: changed_user }];
    let edge_changes = vec![GraphChange::DeleteReference {
        from_node_id: reference.from_node_id.clone(),
    }];
    let cases = vec![
        ("node", format!("node:{}", user.id), node_changes.clone()),
        (
            "children",
            format!("children:{}", user.parent_id.as_deref().unwrap_or("root")),
            node_changes.clone(),
        ),
        (
            "edge",
            format!("edge:{}", reference.from_node_id),
            edge_changes.clone(),
        ),
        (
            "references-to",
            format!("references-to:{}", reference.to_node_id),
            edge_changes,
        ),
        (
            "namespace",
            "namespace:test:User".into(),
            node_changes.clone(),
        ),
        (
            "absence",
            "absence:InterfaceDeclaration:test:Account".into(),
            node_changes.clone(),
        ),
    ];

    for (case, dependency_key, publisher_changes) in cases {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let stale_changes = {
            let mut node = parse.clone();
            node.payload.push_str("\n// stale candidate");
            vec![GraphChange::UpsertNode { node }]
        };
        let stale_delta = GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: stale_changes.clone(),
        };
        let publisher_delta = GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: publisher_changes.clone(),
        };
        let stale_authority = required_delta_authority(&graph, &stale_delta).unwrap();
        let publisher_authority = required_delta_authority(&graph, &publisher_delta).unwrap();
        let mut stale_keys = stale_authority.write_resources;
        stale_keys.push(dependency_key.clone());
        stale_keys.sort();
        stale_keys.dedup();
        let mut publisher_keys = publisher_authority.write_resources;
        publisher_keys.push(dependency_key.clone());
        publisher_keys.sort();
        publisher_keys.dedup();
        let provider = RoleProvider {
            analyses: Arc::new(BTreeMap::from([
                (
                    parse.id.clone(),
                    fixed_analysis(stale_keys, stale_authority.reservation_coverage),
                ),
                (
                    user.id.clone(),
                    fixed_analysis(publisher_keys, publisher_authority.reservation_coverage),
                ),
            ])),
        };
        let (kernel, _) = Kernel::create_with_test_semantics(
            &path,
            fixture.snapshot().clone(),
            Arc::new(provider),
        )
        .unwrap();
        begin_with_intents(&kernel, "stale", [rename(&parse.id, "parseStale")]).unwrap();
        begin_with_intents(&kernel, "publisher", [rename(&user.id, "UserClock")]).unwrap();
        let stale_offer = ready(kernel.submit_change_set("stale", 0).unwrap());
        let publisher_offer = ready(kernel.submit_change_set("publisher", 0).unwrap());
        let stale_claim = claimed(
            kernel
                .claim_ready(&stale_offer.offer_id, &stale_offer.claim_token, 1)
                .unwrap(),
        );
        let publisher_claim = claimed(
            kernel
                .claim_ready(&publisher_offer.offer_id, &publisher_offer.claim_token, 1)
                .unwrap(),
        );
        let PublishClaimOutcome::Published(_) = kernel
            .publish_claimed(&publisher_claim, &DeltaBuilder(publisher_changes), 2)
            .unwrap()
        else {
            panic!("{case}: clock publisher did not publish")
        };
        let stale_outcome = kernel
            .publish_claimed(&stale_claim, &DeltaBuilder(stale_changes), 3)
            .unwrap();
        assert!(
            matches!(
                stale_outcome,
                PublishClaimOutcome::Requeued { .. } | PublishClaimOutcome::NeedsDecision { .. }
            ),
            "{case}: affected stale candidate published"
        );
        assert_ne!(
            kernel.change_set("stale").unwrap().unwrap().state,
            ChangeSetState::Executing,
            "{case}: invalidated claim was stranded"
        );
        assert_eq!(kernel.snapshot().generation(), 1, "{case}");
        assert_eq!(
            kernel.snapshot().node(&parse.id).unwrap().payload,
            parse.payload,
            "{case}: invalidated candidate leaked into the live graph"
        );
    }

    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let stale_changes = {
        let mut node = parse.clone();
        node.payload.push_str("\n// rebase control");
        vec![GraphChange::UpsertNode { node }]
    };
    let publisher_changes = node_changes;
    let stale_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: stale_changes.clone(),
        },
    )
    .unwrap();
    let publisher_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: publisher_changes.clone(),
        },
    )
    .unwrap();
    let provider = RoleProvider {
        analyses: Arc::new(BTreeMap::from([
            (
                parse.id.clone(),
                fixed_analysis(
                    stale_authority.write_resources,
                    stale_authority.reservation_coverage,
                ),
            ),
            (
                user.id.clone(),
                fixed_analysis(
                    publisher_authority.write_resources,
                    publisher_authority.reservation_coverage,
                ),
            ),
        ])),
    };
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, fixture.snapshot().clone(), Arc::new(provider))
            .unwrap();
    begin_with_intents(
        &kernel,
        "control-stale",
        [rename(&parse.id, "parseRebased")],
    )
    .unwrap();
    begin_with_intents(
        &kernel,
        "control-publisher",
        [rename(&user.id, "UserClock")],
    )
    .unwrap();
    let stale_offer = ready(kernel.submit_change_set("control-stale", 0).unwrap());
    let publisher_offer = ready(kernel.submit_change_set("control-publisher", 0).unwrap());
    let stale_claim = claimed(
        kernel
            .claim_ready(&stale_offer.offer_id, &stale_offer.claim_token, 1)
            .unwrap(),
    );
    let publisher_claim = claimed(
        kernel
            .claim_ready(&publisher_offer.offer_id, &publisher_offer.claim_token, 1)
            .unwrap(),
    );
    kernel
        .publish_claimed(&publisher_claim, &DeltaBuilder(publisher_changes), 2)
        .unwrap();
    let PublishClaimOutcome::Published(report) = kernel
        .publish_claimed(&stale_claim, &DeltaBuilder(stale_changes), 3)
        .unwrap()
    else {
        panic!("unrelated control did not rebase")
    };
    assert_eq!(report.generation, 2);
    assert_eq!(
        kernel.change_set("control-stale").unwrap().unwrap().state,
        ChangeSetState::Committed
    );
    assert!(
        kernel
            .snapshot()
            .node(&parse.id)
            .unwrap()
            .payload
            .contains("// rebase control")
    );
}

#[test]
fn publication_successor_offer_uses_fresh_unlocked_analysis_on_committed_graph() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let generations = Arc::new(Mutex::new(Vec::new()));
    let kernel_slot = Arc::new(Mutex::new(None));
    let provider = RecordingGraphProvider {
        inner: GraphDerivedAnalyzer::new(),
        generations: generations.clone(),
        kernel: kernel_slot.clone(),
    };
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, fixture.snapshot().clone(), Arc::new(provider))
            .unwrap();
    let kernel = Arc::new(kernel);
    *kernel_slot.lock().unwrap() = Some(Arc::downgrade(&kernel));
    begin_with_intents(&kernel, "blocker", [rename(&user_id, "Account")]).unwrap();
    let offer = ready(kernel.submit_change_set("blocker", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );
    begin_with_intents(&kernel, "successor", [rename(&user_id, "Customer")]).unwrap();
    let SubmissionOutcome::Queued { .. } = kernel.submit_change_set("successor", 1).unwrap() else {
        panic!("overlapping successor was not queued")
    };
    let before_calls = generations.lock().unwrap().len();

    kernel
        .publish_claimed(
            &claim,
            &NodePatchBuilder::new(vec![(user_id, "\n// Account".into())]),
            2,
        )
        .unwrap();

    let observed = generations.lock().unwrap().clone();
    assert!(
        observed.len() > before_calls,
        "publication did not reanalyze its successor"
    );
    assert_eq!(
        observed.last(),
        Some(&1),
        "successor analysis did not see committed graph"
    );
    assert_ne!(
        kernel.change_set("successor").unwrap().unwrap().state,
        ChangeSetState::Queued,
        "freshly analyzed successor remained stranded"
    );
}

#[test]
fn third_final_check_dependency_drift_atomically_requeues_and_fences_the_stale_claim() {
    let fixture = MediumCoordinationFixture::load();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let user = fixture.declaration_named("User").clone();
    let parse = fixture.declaration_named("parseArgs").clone();
    let format = fixture.declaration_named("formatTimestamp").clone();
    let mut changed_user = user.clone();
    changed_user.payload.push_str("\n// dependency drift");
    let publisher_changes = vec![GraphChange::UpsertNode { node: changed_user }];
    let mut changed_parse = parse.clone();
    changed_parse.payload.push_str("\n// stale candidate");
    let stale_changes = vec![GraphChange::UpsertNode {
        node: changed_parse,
    }];
    let stale_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: stale_changes.clone(),
        },
    )
    .unwrap();
    let publisher_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: publisher_changes.clone(),
        },
    )
    .unwrap();
    let dependency_key = format!("node:{}", user.id);
    let mut stale_keys = stale_authority.write_resources;
    stale_keys.push(dependency_key.clone());
    let loss_scope = vec![format!("node:{}", format.id)];
    let provider = RoleProvider {
        analyses: Arc::new(BTreeMap::from([
            (
                parse.id.clone(),
                fixed_analysis(stale_keys, stale_authority.reservation_coverage),
            ),
            (
                user.id.clone(),
                fixed_analysis(
                    publisher_authority.write_resources,
                    publisher_authority.reservation_coverage,
                ),
            ),
            (
                format.id.clone(),
                fixed_analysis(loss_scope.clone(), loss_scope),
            ),
        ])),
    };
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, fixture.snapshot().clone(), Arc::new(provider))
            .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "stale-third", [rename(&parse.id, "parseStale")]).unwrap();
    begin_with_intents(
        &kernel,
        "dependency-publisher",
        [rename(&user.id, "Account")],
    )
    .unwrap();
    let stale_offer = ready(kernel.submit_change_set("stale-third", 0).unwrap());
    let publisher_offer = ready(kernel.submit_change_set("dependency-publisher", 0).unwrap());
    let stale_claim = claimed(
        kernel
            .claim_ready(&stale_offer.offer_id, &stale_offer.claim_token, 1)
            .unwrap(),
    );
    let publisher_claim = claimed(
        kernel
            .claim_ready(&publisher_offer.offer_id, &publisher_offer.claim_token, 1)
            .unwrap(),
    );
    for index in 0..2 {
        let new_name = format!("formatLoss{index}");
        begin_with_intents(
            &kernel,
            &format!("loss-{index}"),
            [rename(&format.id, &new_name)],
        )
        .unwrap();
    }
    let stale_builder = CountingDeltaBuilder::new(stale_changes);
    let publisher_builder = DeltaBuilder(publisher_changes);
    let before_final_check = |attempt: u32| match attempt {
        0 | 1 => {
            let id = format!("loss-{attempt}");
            kernel.submit_change_set(&id, 10 + attempt as u64).unwrap();
        }
        2 => {
            let PublishClaimOutcome::Published(_) = kernel
                .publish_claimed(&publisher_claim, &publisher_builder, 20)
                .unwrap()
            else {
                panic!("dependency publisher did not publish")
            };
        }
        _ => panic!("unexpected optimistic attempt {attempt}"),
    };
    let invalidation_commits = AtomicUsize::new(0);
    let before_redb = || {
        assert!(kernel.test_publication_mutexes_held());
        invalidation_commits.fetch_add(1, Ordering::SeqCst);
    };
    let outcome = kernel
        .publish_claimed_with_test_hooks(
            &stale_claim,
            &stale_builder,
            30,
            &before_final_check,
            &before_redb,
        )
        .unwrap();

    assert!(matches!(outcome, PublishClaimOutcome::Requeued { .. }));
    assert_eq!(invalidation_commits.load(Ordering::SeqCst), 1);
    assert_eq!(stale_builder.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        kernel.change_set("stale-third").unwrap().unwrap().state,
        ChangeSetState::Queued
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("stale-third")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Queued
    );
    assert!(
        kernel
            .test_active_claims()
            .unwrap()
            .iter()
            .all(|active| active.claim_id != stale_claim.claim_id)
    );
    let late = kernel
        .publish_claimed(&stale_claim, &stale_builder, 31)
        .unwrap_err();
    assert!(late.downcast_ref::<CoordinationError>().is_some());
}

#[test]
fn known_dependency_drift_survives_three_invalidation_losses_without_stranding_authority() {
    let fixture = MediumCoordinationFixture::load();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let user = fixture.declaration_named("User").clone();
    let parse = fixture.declaration_named("parseArgs").clone();
    let format = fixture.declaration_named("formatTimestamp").clone();
    let mut changed_user = user.clone();
    changed_user.payload.push_str("\n// dependency drift");
    let publisher_changes = vec![GraphChange::UpsertNode { node: changed_user }];
    let mut changed_parse = parse.clone();
    changed_parse.payload.push_str("\n// stale candidate");
    let stale_changes = vec![GraphChange::UpsertNode {
        node: changed_parse,
    }];
    let stale_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: stale_changes.clone(),
        },
    )
    .unwrap();
    let publisher_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: publisher_changes.clone(),
        },
    )
    .unwrap();
    let mut stale_keys = stale_authority.write_resources;
    stale_keys.push(format!("node:{}", user.id));
    let loss_scope = vec![format!("node:{}", format.id)];
    let provider = RoleProvider {
        analyses: Arc::new(BTreeMap::from([
            (
                parse.id.clone(),
                fixed_analysis(stale_keys, stale_authority.reservation_coverage),
            ),
            (
                user.id.clone(),
                fixed_analysis(
                    publisher_authority.write_resources,
                    publisher_authority.reservation_coverage,
                ),
            ),
            (
                format.id.clone(),
                fixed_analysis(loss_scope.clone(), loss_scope),
            ),
        ])),
    };
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, fixture.snapshot().clone(), Arc::new(provider))
            .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(
        &kernel,
        "stale-invalidation",
        [rename(&parse.id, "parseStale")],
    )
    .unwrap();
    begin_with_intents(
        &kernel,
        "invalidation-dependency-publisher",
        [rename(&user.id, "Account")],
    )
    .unwrap();
    for attempt in 0..3 {
        begin_with_intents(
            &kernel,
            &format!("invalidation-loss-{attempt}"),
            [rename(&format.id, &format!("formatLoss{attempt}"))],
        )
        .unwrap();
    }
    let stale_offer = ready(kernel.submit_change_set("stale-invalidation", 0).unwrap());
    let publisher_offer = ready(
        kernel
            .submit_change_set("invalidation-dependency-publisher", 0)
            .unwrap(),
    );
    let stale_claim = claimed(
        kernel
            .claim_ready(&stale_offer.offer_id, &stale_offer.claim_token, 1)
            .unwrap(),
    );
    let publisher_claim = claimed(
        kernel
            .claim_ready(&publisher_offer.offer_id, &publisher_offer.claim_token, 1)
            .unwrap(),
    );
    let stale_builder = CountingDeltaBuilder::new(stale_changes);
    let publisher_builder = DeltaBuilder(publisher_changes);
    let before_final_check = |attempt: u32| {
        assert_eq!(
            attempt, 0,
            "dependency drift should enter invalidation immediately"
        );
        assert!(matches!(
            kernel
                .publish_claimed(&publisher_claim, &publisher_builder, 20)
                .unwrap(),
            PublishClaimOutcome::Published(_)
        ));
    };
    let invalidation_checks = AtomicUsize::new(0);
    let before_invalidation_final_check = |attempt: u32| {
        assert!(kernel.test_publication_mutexes_available());
        invalidation_checks.fetch_add(1, Ordering::SeqCst);
        if attempt < 3 {
            kernel
                .submit_change_set(
                    &format!("invalidation-loss-{attempt}"),
                    21 + u64::from(attempt),
                )
                .unwrap();
        } else {
            assert_eq!(attempt, 3, "unexpected extra invalidation retry");
        }
    };
    let invalidation_commits = AtomicUsize::new(0);
    let before_redb = || {
        assert!(kernel.test_publication_mutexes_held());
        invalidation_commits.fetch_add(1, Ordering::SeqCst);
    };

    let outcome = kernel
        .publish_claimed_with_invalidation_test_hooks(
            &stale_claim,
            &stale_builder,
            30,
            &before_final_check,
            &before_invalidation_final_check,
            &before_redb,
        )
        .unwrap();

    assert!(matches!(outcome, PublishClaimOutcome::Requeued { .. }));
    assert_eq!(invalidation_checks.load(Ordering::SeqCst), 4);
    assert_eq!(invalidation_commits.load(Ordering::SeqCst), 1);
    assert_eq!(stale_builder.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        kernel
            .change_set("stale-invalidation")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Queued
    );
    let durable_ticket = kernel
        .ticket_for_change_set("stale-invalidation")
        .unwrap()
        .unwrap();
    assert_eq!(durable_ticket.state, TicketState::Queued);
    assert_eq!(
        kernel
            .test_scheduler_ticket_for_change_set("stale-invalidation")
            .unwrap(),
        durable_ticket
    );
    assert!(
        kernel
            .test_active_claims()
            .unwrap()
            .iter()
            .all(|active| active.claim_id != stale_claim.claim_id)
    );
    let late = kernel
        .publish_claimed(&stale_claim, &stale_builder, 31)
        .unwrap_err();
    assert_eq!(
        late.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::LeaseExpired)
    );
}

#[test]
fn three_unrelated_final_state_losses_exhaust_once_without_rebuilding() {
    let fixture = MediumCoordinationFixture::load();
    let user = fixture.declaration_named("User").clone();
    let format = fixture.declaration_named("formatTimestamp").clone();
    let mut changed_user = user.clone();
    changed_user.payload.push_str("\n// optimistic candidate");
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "retry-target", [rename(&user.id, "Account")]).unwrap();
    let offer = ready(kernel.submit_change_set("retry-target", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );
    for attempt in 0..3 {
        let new_name = format!("formatRevision{attempt}");
        begin_with_intents(
            &kernel,
            &format!("revision-loss-{attempt}"),
            [rename(&format.id, &new_name)],
        )
        .unwrap();
    }
    let builder = CountingDeltaBuilder::new(vec![GraphChange::UpsertNode { node: changed_user }]);
    let before_final_check = |attempt: u32| {
        kernel
            .submit_change_set(&format!("revision-loss-{attempt}"), 10 + attempt as u64)
            .unwrap();
    };

    let error = kernel
        .publish_claimed_with_test_hooks(&claim, &builder, 20, &before_final_check, &|| {})
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::OptimisticRetryExhausted { attempts: 3 })
    );
    assert_eq!(builder.calls.load(Ordering::SeqCst), 1);
    assert_eq!(kernel.test_active_claims().unwrap(), vec![claim]);
}

#[test]
fn final_lifecycle_commit_holds_publication_then_scheduler_before_redb() {
    let fixture = MediumCoordinationFixture::load();
    let user = fixture.declaration_named("User").clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "lock-order", [rename(&user.id, "Account")]).unwrap();
    let offer = ready(kernel.submit_change_set("lock-order", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );
    let before_redb = || {
        assert!(
            kernel.test_publication_mutexes_held(),
            "redb lifecycle commit must run under publication then scheduler"
        );
    };
    let outcome = kernel
        .publish_claimed_with_test_hooks(
            &claim,
            &NodePatchBuilder::new(vec![(user.id, "\n// Account".into())]),
            2,
            &|_| {},
            &before_redb,
        )
        .unwrap();
    assert!(matches!(outcome, PublishClaimOutcome::Published(_)));
}

#[test]
fn central_planner_requires_decision_when_a_stale_resource_member_disappears() {
    let fixture = MediumCoordinationFixture::load();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let blocker = fixture.declaration_named("User").clone();
    let active = fixture.declaration_named("parseArgs").clone();
    let successor = fixture.declaration_named("formatTimestamp").clone();
    let mut changed_blocker = blocker.clone();
    changed_blocker.payload.push_str("\n// committed blocker");
    let blocker_changes = vec![GraphChange::UpsertNode {
        node: changed_blocker,
    }];
    let blocker_authority = required_delta_authority(
        &graph,
        &GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: blocker_changes.clone(),
        },
    )
    .unwrap();
    let active_scope = vec![format!("node:{}", active.id)];
    let fresh_scope = vec![format!("node:{}", successor.id)];
    let mut stale_scope = active_scope.clone();
    stale_scope.extend(fresh_scope.clone());
    let successor_calls = Arc::new(AtomicUsize::new(0));
    let provider = ContractingSuccessorProvider {
        blocker_id: blocker.id.clone(),
        blocker: fixed_analysis(
            blocker_authority.write_resources,
            blocker_authority.reservation_coverage,
        ),
        active_id: active.id.clone(),
        active: fixed_analysis(active_scope.clone(), active_scope.clone()),
        successor_id: successor.id.clone(),
        successor_stale: fixed_analysis(stale_scope.clone(), stale_scope),
        successor_fresh: fixed_analysis(fresh_scope.clone(), fresh_scope),
        successor_calls: successor_calls.clone(),
    };
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, fixture.snapshot().clone(), Arc::new(provider))
            .unwrap();
    begin_with_intents(&kernel, "planner-blocker", [rename(&blocker.id, "Account")]).unwrap();
    begin_with_intents(&kernel, "active-other", [rename(&active.id, "parseTokens")]).unwrap();
    let blocker_offer = ready(kernel.submit_change_set("planner-blocker", 0).unwrap());
    let active_offer = ready(kernel.submit_change_set("active-other", 0).unwrap());
    let blocker_claim = claimed(
        kernel
            .claim_ready(&blocker_offer.offer_id, &blocker_offer.claim_token, 1)
            .unwrap(),
    );
    let _active_claim = claimed(
        kernel
            .claim_ready(&active_offer.offer_id, &active_offer.claim_token, 1)
            .unwrap(),
    );
    begin_with_intents(
        &kernel,
        "contracting-successor",
        [rename(&successor.id, "formatContracted")],
    )
    .unwrap();
    let successor_submission = kernel
        .submit_change_set("contracting-successor", 2)
        .unwrap();
    assert!(
        matches!(successor_submission, SubmissionOutcome::Queued { .. }),
        "stale successor scope must initially conflict: {successor_submission:?}"
    );

    kernel
        .publish_claimed(&blocker_claim, &DeltaBuilder(blocker_changes), 3)
        .unwrap();

    assert_eq!(successor_calls.load(Ordering::SeqCst), 3);
    let durable_change_set = kernel.change_set("contracting-successor").unwrap().unwrap();
    let durable_ticket = kernel
        .ticket_for_change_set("contracting-successor")
        .unwrap()
        .unwrap();
    assert_eq!(durable_change_set.state, ChangeSetState::NeedsDecision);
    assert_eq!(durable_ticket.state, TicketState::NeedsDecision);
    assert!(
        kernel
            .ready_offer_for_change_set("contracting-successor")
            .unwrap()
            .is_none()
    );
    assert_eq!(durable_ticket.ready_offer_id, None);
}

#[test]
fn rebased_builder_replay_uses_durable_original_prepared_generation_after_reopen() {
    let fixture = MediumCoordinationFixture::load();
    let user = fixture.declaration_named("User").clone();
    let parse = fixture.declaration_named("parseArgs").clone();
    let format = fixture.declaration_named("formatTimestamp").clone();
    let mut changed_user = user.clone();
    changed_user.payload.push_str("\n// outer candidate");
    let mut changed_parse = parse.clone();
    changed_parse.payload.push_str("\n// drift one");
    let mut changed_format = format.clone();
    changed_format.payload.push_str("\n// drift two");
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    for (id, declaration, new_name) in [
        ("replay-outer", &user, "Account"),
        ("drift-one", &parse, "parseTokens"),
        ("drift-two", &format, "formatClock"),
    ] {
        begin_with_intents(&kernel, id, [rename(&declaration.id, new_name)]).unwrap();
    }
    let outer_offer = ready(kernel.submit_change_set("replay-outer", 0).unwrap());
    let first_offer = ready(kernel.submit_change_set("drift-one", 0).unwrap());
    let second_offer = ready(kernel.submit_change_set("drift-two", 0).unwrap());
    let outer_claim = claimed(
        kernel
            .claim_ready(&outer_offer.offer_id, &outer_offer.claim_token, 1)
            .unwrap(),
    );
    let first_claim = claimed(
        kernel
            .claim_ready(&first_offer.offer_id, &first_offer.claim_token, 1)
            .unwrap(),
    );
    let second_claim = claimed(
        kernel
            .claim_ready(&second_offer.offer_id, &second_offer.claim_token, 1)
            .unwrap(),
    );
    let observed = Arc::new(Mutex::new(Vec::new()));
    let outer_builder = RecordingGenerationBuilder {
        generations: observed.clone(),
        changes: vec![GraphChange::UpsertNode { node: changed_user }],
    };
    let before_final = |attempt: u32| {
        if attempt == 0 {
            kernel
                .publish_claimed(
                    &first_claim,
                    &DeltaBuilder(vec![GraphChange::UpsertNode {
                        node: changed_parse.clone(),
                    }]),
                    2,
                )
                .unwrap();
            kernel
                .publish_claimed(
                    &second_claim,
                    &DeltaBuilder(vec![GraphChange::UpsertNode {
                        node: changed_format.clone(),
                    }]),
                    3,
                )
                .unwrap();
        }
    };
    let first = published(
        kernel
            .publish_claimed_with_test_hooks(&outer_claim, &outer_builder, 4, &before_final, &|| {})
            .unwrap(),
    );
    assert_eq!(first.generation, 3);
    assert_eq!(*observed.lock().unwrap(), vec![0]);
    drop(kernel);

    let (reopened, recovered) = Kernel::open(&path).unwrap();
    assert_eq!(recovered.generation, 3);
    let replay_observed = Arc::new(Mutex::new(Vec::new()));
    let replay = published(
        reopened
            .publish_claimed(
                &outer_claim,
                &RecordingGenerationBuilder {
                    generations: replay_observed.clone(),
                    changes: outer_builder.changes.clone(),
                },
                5,
            )
            .unwrap(),
    );
    assert!(replay.already_published);
    assert_eq!(replay.generation, 3);
    assert_eq!(*replay_observed.lock().unwrap(), vec![0]);
}
