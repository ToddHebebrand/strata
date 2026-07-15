#![cfg(feature = "coordination-test-api")]

#[cfg(feature = "redb-spike-api")]
use std::sync::Barrier;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;
#[cfg(feature = "redb-spike-api")]
use strata_kernel::CoordinatedPublishFailpoint;
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, CandidateEnvelope, ChangeSetState, ClaimHandle, ClaimOutcome,
    CoordinationError, CoordinationEventKind, DynamicExpansionPolicy, GraphChange, GraphDelta,
    GraphGeneration, GraphSnapshot, IdempotencyClass, IntentAnalysis, IntentParameters,
    IntentRecord, Kernel, MAX_WAKE_AFFECTED_NODE_IDS, PreparedCandidate, PublicationReport,
    PublishClaimOutcome, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome, TestSemanticProvider,
    TicketState,
};
use tempfile::tempdir;

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

    fn extend(&self, analyses: impl IntoIterator<Item = IntentAnalysis>) {
        self.analyses.lock().unwrap().extend(analyses);
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
            .context("missing analysis")
    }
}

struct RecordingBuilder {
    calls: AtomicUsize,
    delta: GraphDelta,
}

impl RecordingBuilder {
    fn new(delta: GraphDelta) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            delta,
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CandidateBuilder for RecordingBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(prepared.graph.generation(), 0);
        assert_eq!(prepared.change_set.state, ChangeSetState::Executing);
        assert!(!prepared.intents.is_empty());
        assert!(!prepared.attempt_id.is_empty());
        assert!(!prepared.scope_fingerprint.is_empty());
        CandidateEnvelope::from_delta(self.delta.clone())
    }
}

#[cfg(feature = "redb-spike-api")]
struct BlockingBuilder {
    calls: AtomicUsize,
    delta: GraphDelta,
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}

#[cfg(feature = "redb-spike-api")]
impl CandidateBuilder for BlockingBuilder {
    fn build_candidate(&self, _prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.wait();
        self.release.wait();
        CandidateEnvelope::from_delta(self.delta.clone())
    }
}

struct PassiveBuilder(GraphDelta);

impl CandidateBuilder for PassiveBuilder {
    fn build_candidate(&self, _prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(self.0.clone())
    }
}

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

fn resource(key: &str) -> ResourceVersion {
    ResourceVersion::new(key, "v0").unwrap()
}

fn analysis(keys: &[String]) -> IntentAnalysis {
    let resources = keys.iter().map(|key| resource(key)).collect::<Vec<_>>();
    IntentAnalysis {
        read_set: resources.clone(),
        write_set: resources.clone(),
        validation_set: resources,
        reservation_keys: keys.to_vec(),
        dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
        idempotency_class: IdempotencyClass::ReplaySafe,
    }
}

fn user_delta(snapshot: &GraphSnapshot, payload: &str) -> GraphDelta {
    let mut user = snapshot
        .nodes
        .iter()
        .find(|node| node.id == "fc98295bca9efc3e")
        .unwrap()
        .clone();
    user.payload = payload.into();
    GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes: vec![GraphChange::UpsertNode { node: user }],
    }
}

fn user_scope(snapshot: &GraphSnapshot) -> Vec<String> {
    let user = snapshot
        .nodes
        .iter()
        .find(|node| node.id == "fc98295bca9efc3e")
        .unwrap();
    vec![
        "node:fc98295bca9efc3e".into(),
        format!("node:{}", user.parent_id.as_deref().unwrap()),
    ]
}

fn begin_submit_claim(kernel: &Kernel, id: &str, tick: u64) -> ClaimHandle {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: id.into(),
                actor: "agent:test".into(),
                reasoning: "rename User as one coordinated change set".into(),
                submission_idempotency_key: format!("submission:{id}"),
            },
            tick,
        )
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } = kernel.submit_change_set(id, tick).unwrap() else {
        panic!("expected ready change set")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, tick + 1)
        .unwrap()
    else {
        panic!("expected claimed change set")
    };
    claim
}

#[test]
fn same_attempt_same_digest_replays_but_changed_digest_is_rejected() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = Arc::new(SequencedAnalyzer::new(vec![analysis(&scope); 6]));
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), analyzer.clone()).unwrap();
    let claim = begin_submit_claim(&kernel, "attempt-replay", 0);
    let envelope =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Account {}"))
            .unwrap();

    let PublishClaimOutcome::Published(first) = kernel
        .publish_claimed_envelope(&claim, envelope.clone(), 2)
        .unwrap()
    else {
        panic!("first attempt did not publish")
    };
    let committed_envelope = envelope.clone();
    let PublishClaimOutcome::Published(replay) = kernel
        .publish_claimed_envelope(&claim, envelope, 3)
        .unwrap()
    else {
        panic!("duplicate attempt did not replay publication")
    };
    assert_eq!(
        (replay.generation, replay.digest.as_str()),
        (first.generation, first.digest.as_str())
    );
    assert!(replay.already_published);
    let attempt = kernel
        .publication_attempt(&claim.attempt_id)
        .unwrap()
        .unwrap();
    assert_eq!(attempt.change_set_id, claim.change_set_id);
    assert_eq!(attempt.attempt_id, claim.attempt_id);
    assert_eq!(
        attempt.candidate_digest,
        committed_envelope.candidate_digest
    );
    assert_eq!(attempt.generation, first.generation);
    assert_eq!(attempt.graph_digest, first.digest);
    drop(kernel);

    let (kernel, recovered) = Kernel::open_with_test_semantics(&path, analyzer).unwrap();
    assert_eq!(recovered.generation, first.generation);
    let PublishClaimOutcome::Published(reopened_replay) = kernel
        .publish_claimed_envelope(&claim, committed_envelope, 4)
        .unwrap()
    else {
        panic!("reopened duplicate attempt did not replay publication")
    };
    assert!(reopened_replay.already_published);
    assert_eq!(reopened_replay.generation, first.generation);
    assert_eq!(reopened_replay.digest, first.digest);

    let changed =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Customer {}"))
            .unwrap();
    let error = kernel
        .publish_claimed_envelope(&claim, changed, 5)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::AttemptDigestMismatch),
    );
}

#[test]
fn malicious_candidate_digest_is_rejected_before_graph_or_lifecycle_state_changes() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "malicious-digest", 0);
    let before_change_set = kernel.change_set("malicious-digest").unwrap().unwrap();
    let before_ticket = kernel
        .ticket_for_change_set("malicious-digest")
        .unwrap()
        .unwrap();
    let before_events = kernel.events_after("malicious-audit", 0, 20).unwrap();
    let digest_for_other_delta =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Customer {}"))
            .unwrap()
            .candidate_digest;
    let malicious = CandidateEnvelope {
        delta: user_delta(&snapshot, "export interface Account {}"),
        candidate_digest: digest_for_other_delta,
    };

    let error = kernel
        .publish_claimed_envelope(&claim, malicious, 2)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::CandidateDigestMismatch),
    );
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(
        kernel.change_set("malicious-digest").unwrap().unwrap(),
        before_change_set
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("malicious-digest")
            .unwrap()
            .unwrap(),
        before_ticket
    );
    assert_eq!(
        kernel.events_after("malicious-audit", 0, 20).unwrap(),
        before_events
    );
}

#[test]
fn claimed_composite_publication_is_kernel_owned_atomic_and_idempotent_after_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "rename-user", 10);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));

    let report = kernel.publish_claimed(&claim, &builder, 20).unwrap();
    assert_eq!(report.generation, 1);
    assert!(!report.already_published);
    assert_eq!(builder.calls(), 1);
    assert_eq!(kernel.snapshot().generation(), 1);

    let retry = kernel.publish_claimed(&claim, &builder, 21).unwrap();
    assert_eq!(retry.generation, report.generation);
    assert_eq!(retry.digest, report.digest);
    assert!(retry.already_published);
    assert_eq!(builder.calls(), 1, "committed retries must not rebuild");
    drop(kernel);

    let (reopened, recovered) =
        Kernel::open_with_test_semantics(&path, Arc::new(analyzer.clone())).unwrap();
    assert_eq!(recovered.generation, 1);
    let durable = reopened.change_set("rename-user").unwrap().unwrap();
    assert_eq!(durable.state, ChangeSetState::Committed);
    assert_eq!(durable.committed_generation, Some(1));
    assert_eq!(
        reopened
            .ticket_for_change_set("rename-user")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Completed
    );
    let events = reopened.events_after("audit", 0, 20).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == CoordinationEventKind::IntentCommitted)
            .count(),
        1
    );
    let retry_after_reopen = reopened.publish_claimed(&claim, &builder, 30).unwrap();
    assert_eq!(retry_after_reopen.generation, 1);
    assert_eq!(retry_after_reopen.digest, report.digest);
    assert!(retry_after_reopen.already_published);
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn concurrent_duplicate_racing_a_finishing_publication_returns_the_same_original_commit() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = Arc::new(SequencedAnalyzer::new(vec![analysis(&scope); 5]));
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), analyzer.clone()).unwrap();
    let kernel = Arc::new(kernel);
    let claim = begin_submit_claim(&kernel, "concurrent-duplicate", 0);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let builder = Arc::new(BlockingBuilder {
        calls: AtomicUsize::new(0),
        delta: user_delta(&snapshot, "export interface Account {}"),
        entered: entered.clone(),
        release: release.clone(),
    });

    let first = {
        let kernel = kernel.clone();
        let builder = builder.clone();
        let claim = claim.clone();
        std::thread::spawn(move || kernel.publish_claimed(&claim, builder.as_ref(), 2))
    };
    entered.wait();
    let duplicate_inside = Arc::new(Barrier::new(2));
    let allow_duplicate_to_lock = Arc::new(Barrier::new(2));
    let second = {
        let kernel = kernel.clone();
        let builder = builder.clone();
        let claim = claim.clone();
        let duplicate_inside = duplicate_inside.clone();
        let allow_duplicate_to_lock = allow_duplicate_to_lock.clone();
        std::thread::spawn(move || {
            let after_outer_idempotency_lookup = || {
                duplicate_inside.wait();
                allow_duplicate_to_lock.wait();
            };
            kernel.publish_claimed_with_entry_hook(
                &claim,
                builder.as_ref(),
                3,
                &after_outer_idempotency_lookup,
            )
        })
    };
    duplicate_inside.wait();
    release.wait();
    allow_duplicate_to_lock.wait();

    let first = first.join().unwrap().unwrap();
    let second = second.join().unwrap().unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 1);
    assert_eq!(first.digest, second.digest);
    assert_ne!(first.already_published, second.already_published);
    assert_eq!(builder.calls.load(Ordering::SeqCst), 1);
    assert_eq!(kernel.snapshot().generation(), 1);
    assert_eq!(
        kernel
            .events_after("concurrent-audit", 0, 20)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == CoordinationEventKind::IntentCommitted)
            .count(),
        1
    );
}

#[test]
fn retry_after_a_later_disjoint_generation_returns_the_earlier_generation_and_digest() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let first_scope = user_scope(&snapshot);
    let first_analyzer = SequencedAnalyzer::new(vec![analysis(&first_scope); 3]);
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        snapshot.clone(),
        Arc::new(first_analyzer.clone()),
    )
    .unwrap();
    let first_claim = begin_submit_claim(&kernel, "earlier", 0);
    let first_builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    let first = kernel
        .publish_claimed(&first_claim, &first_builder, 2)
        .unwrap();

    let second_id = "308079c405a147d0";
    let mut second_node = snapshot
        .nodes
        .iter()
        .find(|node| node.id == second_id)
        .unwrap()
        .clone();
    second_node.payload.push_str("\n// generation two");
    let mut second_scope = vec![format!("node:{second_id}")];
    if let Some(parent_id) = &second_node.parent_id {
        second_scope.push(format!("node:{parent_id}"));
    }
    first_analyzer.extend(vec![analysis(&second_scope); 3]);
    let second_claim = begin_submit_claim(&kernel, "later", 3);
    let second = kernel
        .publish_claimed(
            &second_claim,
            &PassiveBuilder(GraphDelta {
                schema_version: SCHEMA_VERSION,
                base_generation: 1,
                changes: vec![GraphChange::UpsertNode { node: second_node }],
            }),
            5,
        )
        .unwrap();
    assert_eq!(second.generation, 2);
    let events_before_retry = kernel.events_after("later-audit", 0, 50).unwrap();

    let retry = kernel
        .publish_claimed(&first_claim, &first_builder, 6)
        .unwrap();
    assert!(retry.already_published);
    assert_eq!(retry.generation, 1);
    assert_eq!(retry.digest, first.digest);
    assert_eq!(kernel.snapshot().generation(), 2);
    assert_eq!(
        kernel.events_after("later-audit", 0, 50).unwrap(),
        events_before_retry
    );
}

#[test]
fn stale_claim_and_rogue_delta_are_rejected_without_side_effects() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 8]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "contained", 0);

    for stale in [
        ClaimHandle {
            service_epoch: claim.service_epoch + 1,
            ..claim.clone()
        },
        ClaimHandle {
            graph_generation: claim.graph_generation + 1,
            ..claim.clone()
        },
        ClaimHandle {
            offer_id: "wrong-offer".into(),
            ..claim.clone()
        },
        ClaimHandle {
            scope_fingerprint: "wrong-scope".into(),
            ..claim.clone()
        },
    ] {
        let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
        assert!(kernel.publish_claimed(&stale, &builder, 2).is_err());
        assert_eq!(builder.calls(), 0);
        assert_eq!(kernel.snapshot().generation(), 0);
    }

    let mut moved_user = snapshot
        .nodes
        .iter()
        .find(|node| node.id == "fc98295bca9efc3e")
        .unwrap()
        .clone();
    moved_user.parent_id = Some("60905407496bedc7".into());
    let rogue_deltas = [
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::DeleteNode {
                node_id: "308079c405a147d0".into(),
            }],
        },
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: moved_user }],
        },
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertReference {
                reference: strata_kernel::ReferenceRecord {
                    from_node_id: "fc98295bca9efc3e".into(),
                    to_node_id: "308079c405a147d0".into(),
                    kind: "reference".into(),
                },
            }],
        },
    ];
    for rogue in rogue_deltas {
        let builder = RecordingBuilder::new(rogue);
        let error = kernel.publish_claimed(&claim, &builder, 3).unwrap_err();
        assert!(error.to_string().contains("outside inferred scope"));
        assert_eq!(kernel.snapshot().generation(), 0);
        assert_eq!(
            kernel.change_set("contained").unwrap().unwrap().state,
            ChangeSetState::Executing
        );
    }
}

#[test]
fn builder_wrong_schema_and_base_are_rejected_before_graph_coordination_or_fences_change() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "bad-candidate", 0);

    let mut wrong_schema = user_delta(&snapshot, "export interface Account {}");
    wrong_schema.schema_version = SCHEMA_VERSION + 1;
    let mut wrong_base = user_delta(&snapshot, "export interface Account {}");
    wrong_base.base_generation = 99;
    for (delta, expected) in [
        (wrong_schema, "unsupported schema version"),
        (wrong_base, "base generation"),
    ] {
        let error = kernel
            .publish_claimed(&claim, &PassiveBuilder(delta), 2)
            .unwrap_err();
        assert!(error.to_string().contains(expected));
        assert_eq!(kernel.snapshot().generation(), 0);
        assert_eq!(
            kernel.change_set("bad-candidate").unwrap().unwrap().state,
            ChangeSetState::Executing
        );
        assert!(
            kernel
                .events_after("bad-candidate-audit", 0, 20)
                .unwrap()
                .iter()
                .all(|event| event.kind != CoordinationEventKind::IntentCommitted)
        );
        #[cfg(feature = "redb-spike-api")]
        for key in &scope {
            assert_eq!(kernel.fence_state(key).unwrap(), (None, None));
        }
    }
}

#[test]
fn publication_reanalysis_happens_before_builder_and_changed_scope_needs_decision() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let old_scope = user_scope(&snapshot);
    let mut changed_scope = old_scope.clone();
    changed_scope.push("node:308079c405a147d0".into());
    let analyzer = SequencedAnalyzer::new(vec![
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&changed_scope),
    ]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "reanalyze", 0);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));

    let error = kernel.publish_claimed(&claim, &builder, 2).unwrap_err();
    assert!(error.to_string().contains("scope changed"));
    assert_eq!(analyzer.calls(), 4);
    assert_eq!(builder.calls(), 0);
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(
        kernel.change_set("reanalyze").unwrap().unwrap().state,
        ChangeSetState::Queued
    );
}

#[test]
fn material_publication_scope_change_atomically_wakes_and_offers_blocked_waiter() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let old_scope = user_scope(&snapshot);
    let material_scope = vec!["node:308079c405a147d0".into()];
    let changing = SequencedAnalyzer::new(vec![
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&material_scope),
        analysis(&old_scope),
    ]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(changing.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "material", 0);

    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "material-waiter".into(),
                actor: "agent:waiter".into(),
                reasoning: "wait for terminal release".into(),
                submission_idempotency_key: "submission:material-waiter".into(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            "material-waiter",
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Customer".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        kernel.submit_change_set("material-waiter", 1).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));

    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    let error = kernel.publish_claimed(&claim, &builder, 10).unwrap_err();
    assert!(error.to_string().contains("scope changed"));
    assert_eq!(builder.calls(), 0);
    assert_eq!(
        kernel.change_set("material").unwrap().unwrap().state,
        ChangeSetState::NeedsDecision
    );
    assert_eq!(
        kernel.change_set("material-waiter").unwrap().unwrap().state,
        ChangeSetState::Ready
    );
    let offer = kernel
        .ready_offer_for_change_set("material-waiter")
        .unwrap()
        .unwrap();
    assert_eq!(
        offer.expires_at_tick,
        10 + strata_kernel::READY_OFFER_TTL_TICKS
    );
    let ClaimOutcome::Claimed(_) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 11)
        .unwrap()
    else {
        panic!("terminal release successor should be immediately claimable")
    };
}

#[test]
fn two_intents_publish_one_aggregate_operation_and_generation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 10]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "composite".into(),
                actor: "agent:composite".into(),
                reasoning: "two intents must land together".into(),
                submission_idempotency_key: "submission:composite".into(),
            },
            0,
        )
        .unwrap();
    for name in ["Account", "Customer"] {
        kernel
            .add_intent(
                "composite",
                IntentParameters::RenameSymbol {
                    declaration_id: "fc98295bca9efc3e".into(),
                    new_name: name.into(),
                },
            )
            .unwrap();
    }
    let SubmissionOutcome::Ready { offer, .. } = kernel.submit_change_set("composite", 0).unwrap()
    else {
        panic!("expected ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 1)
        .unwrap()
    else {
        panic!("expected claim")
    };
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Customer {}"));
    let PublicationReport { generation, .. } = kernel.publish_claimed(&claim, &builder, 2).unwrap();
    assert_eq!(generation, 1);
    let operation = kernel.operation(1).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "composite");
    assert_eq!(operation.actor, "agent:composite");
    assert_eq!(operation.reasoning, "two intents must land together");
    assert_eq!(operation.kind, "CompositeChangeSet(2)");
}

#[test]
fn commit_atomically_wakes_successor_with_a_fresh_thirty_tick_offer() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let blocker_analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 4]);
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        snapshot.clone(),
        Arc::new(blocker_analyzer.clone()),
    )
    .unwrap();
    let blocker = begin_submit_claim(&kernel, "blocker", 0);

    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "successor".into(),
                actor: "agent:successor".into(),
                reasoning: "wait for the rename".into(),
                submission_idempotency_key: "submission:successor".into(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            "successor",
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Customer".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        kernel.submit_change_set("successor", 2).unwrap(),
        SubmissionOutcome::Queued { .. }
    ));

    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    kernel.publish_claimed(&blocker, &builder, 50).unwrap();
    let successor = kernel.change_set("successor").unwrap().unwrap();
    assert_eq!(successor.state, ChangeSetState::Ready);
    assert_eq!(successor.blocking_change_set_id.as_deref(), Some("blocker"));
    let ready = kernel
        .events_after("successor-client", 0, 20)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.change_set_id == "successor" && event.kind == CoordinationEventKind::IntentReady
        })
        .next_back()
        .unwrap();
    let ticket = kernel.ticket_for_change_set("successor").unwrap().unwrap();
    assert_eq!(ticket.state, TicketState::Ready);
    let offer = kernel
        .ready_offer_for_change_set("successor")
        .unwrap()
        .unwrap();
    assert_eq!(offer.graph_generation, 1);
    assert_eq!(offer.expires_at_tick, 80);
    assert_eq!(offer.blocking_event_sequence, Some(ready.sequence - 1));
}

#[test]
fn wake_event_context_is_bounded_while_canonical_operation_keeps_every_affected_node() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let selected = snapshot
        .nodes
        .iter()
        .take(MAX_WAKE_AFFECTED_NODE_IDS + 1)
        .cloned()
        .collect::<Vec<_>>();
    let mut scope = std::collections::BTreeSet::new();
    let changes = selected
        .iter()
        .cloned()
        .map(|mut node| {
            scope.insert(format!("node:{}", node.id));
            if let Some(parent_id) = &node.parent_id {
                scope.insert(format!("node:{parent_id}"));
            }
            node.payload.push_str("\n// coordinated");
            GraphChange::UpsertNode { node }
        })
        .collect();
    let scope = scope.into_iter().collect::<Vec<_>>();
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 4]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
            .unwrap();
    let claim = begin_submit_claim(&kernel, "bounded-context", 0);
    let builder = RecordingBuilder::new(GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes,
    });

    kernel.publish_claimed(&claim, &builder, 2).unwrap();
    let operation = kernel.operation(1).unwrap().unwrap();
    assert_eq!(
        operation.affected_node_ids.len(),
        MAX_WAKE_AFFECTED_NODE_IDS + 1
    );
    let committed = kernel
        .events_after("bounded-audit", 0, 20)
        .unwrap()
        .into_iter()
        .find(|event| event.kind == CoordinationEventKind::IntentCommitted)
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&committed.payload_json).unwrap();
    assert_eq!(
        payload["affectedNodeIds"].as_array().unwrap().len(),
        MAX_WAKE_AFFECTED_NODE_IDS
    );
    assert_eq!(
        payload["totalAffectedNodeCount"].as_u64(),
        Some((MAX_WAKE_AFFECTED_NODE_IDS + 1) as u64)
    );
    assert_eq!(payload["affectedNodeIdsTruncated"].as_bool(), Some(true));
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn failure_after_in_transaction_fence_mutation_rolls_back_fences_graph_and_coordination() {
    let failpoints = std::iter::once(CoordinatedPublishFailpoint::AfterFenceMutation)
        .chain((1..=20).map(CoordinatedPublishFailpoint::AfterInsert))
        .chain(std::iter::once(CoordinatedPublishFailpoint::BeforeCommit));
    for (case, failpoint) in failpoints.enumerate() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let snapshot = fixture();
        let scope = user_scope(&snapshot);
        let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 4]);
        let (kernel, _) =
            Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer.clone()))
                .unwrap();
        let claim = begin_submit_claim(&kernel, "rollback", 0);
        kernel
            .begin_change_set(
                BeginChangeSet {
                    change_set_id: "rollback-successor".into(),
                    actor: "agent:successor".into(),
                    reasoning: "exercise successor rollback".into(),
                    submission_idempotency_key: "submission:rollback-successor".into(),
                },
                0,
            )
            .unwrap();
        kernel
            .add_intent(
                "rollback-successor",
                IntentParameters::RenameSymbol {
                    declaration_id: "fc98295bca9efc3e".into(),
                    new_name: "Customer".into(),
                },
            )
            .unwrap();
        assert!(matches!(
            kernel.submit_change_set("rollback-successor", 1).unwrap(),
            SubmissionOutcome::Queued { .. }
        ));
        let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
        kernel
            .publish_claimed_with_failpoint(&claim, &builder, 2, failpoint)
            .unwrap_err();
        drop(kernel);

        let (reopened, recovered) =
            Kernel::open_with_test_semantics(&path, Arc::new(analyzer.clone())).unwrap();
        assert_eq!(recovered.generation, 0, "failpoint case {case}");
        assert_eq!(
            reopened.change_set("rollback").unwrap().unwrap().state,
            ChangeSetState::Ready,
            "failpoint case {case}"
        );
        assert!(
            reopened
                .ready_offer_for_change_set("rollback")
                .unwrap()
                .is_some(),
            "failpoint case {case}"
        );
        assert_eq!(
            reopened
                .change_set("rollback-successor")
                .unwrap()
                .unwrap()
                .state,
            ChangeSetState::Queued,
            "failpoint case {case}"
        );
        assert!(
            reopened
                .ready_offer_for_change_set("rollback-successor")
                .unwrap()
                .is_none(),
            "failpoint case {case}"
        );
        assert!(
            reopened
                .events_after("rollback-audit", 0, 50)
                .unwrap()
                .iter()
                .all(|event| {
                    event.kind != CoordinationEventKind::IntentCommitted
                        && !(event.change_set_id == "rollback-successor"
                            && event.kind == CoordinationEventKind::IntentReady)
                }),
            "failpoint case {case}"
        );
        for key in &scope {
            assert_eq!(
                reopened.fence_state(key).unwrap(),
                (None, None),
                "failpoint case {case}"
            );
        }
    }
}
