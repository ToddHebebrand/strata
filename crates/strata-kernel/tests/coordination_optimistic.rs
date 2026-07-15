#![cfg(feature = "coordination-test-api")]

#[path = "support/coordination.rs"]
#[allow(dead_code)]
mod coordination_support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Weak};

use anyhow::Result;
use coordination_support::{
    GraphDerivedAnalyzer, MediumCoordinationFixture, NodePatchBuilder, begin_with_intents, rename,
};
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, CandidateEnvelope, ChangeSetState, ClaimHandle, ClaimOutcome,
    DynamicExpansionPolicy, GraphChange, GraphDelta, GraphGeneration, IdempotencyClass,
    IntentAnalysis, IntentRecord, Kernel, PreparedCandidate, PublicationReport,
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
        let _ = ready(self.kernel.submit_change_set("disjoint", 4)?);
        self.kernel.cancel_change_set("other", 5)?;
        self.kernel.expire_leases(6)?;
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

impl CandidateBuilder for DeltaBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph.generation(),
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
    }
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
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    begin_with_intents(&kernel, "publishing", [rename(&user_id, "Account")]).unwrap();
    begin_with_intents(&kernel, "disjoint", [rename(&parse_id, "parseTokens")]).unwrap();
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
    let offer = ready(kernel.submit_change_set("publishing", 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, 1)
            .unwrap(),
    );
    let builder = LifecycleProbeBuilder {
        kernel: kernel.clone(),
        inner: NodePatchBuilder::new(vec![(user_id, "\n// Account".into())]),
    };

    kernel.publish_claimed(&claim, &builder, 2).unwrap();
    assert_eq!(
        kernel.change_set("other").unwrap().unwrap().state,
        ChangeSetState::Cancelled
    );
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
    kernel.cancel_change_set("panic", 3).unwrap();
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
