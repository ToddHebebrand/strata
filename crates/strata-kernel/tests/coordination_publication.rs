use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;
#[cfg(feature = "redb-spike-api")]
use strata_kernel::CoordinatedPublishFailpoint;
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome,
    CoordinationEventKind, DynamicExpansionPolicy, GraphChange, GraphDelta, GraphGeneration,
    GraphSnapshot, IdempotencyClass, IntentAnalysis, IntentAnalyzer, IntentParameters,
    IntentRecord, Kernel, PublicationReport, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome,
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
}

impl IntentAnalyzer for SequencedAnalyzer {
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
    fn build_candidate(
        &self,
        graph: &GraphGeneration,
        change_set: &ChangeSetRecord,
        intents: &[IntentRecord],
    ) -> anyhow::Result<GraphDelta> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(graph.generation(), 0);
        assert_eq!(change_set.state, ChangeSetState::Executing);
        assert!(!intents.is_empty());
        Ok(self.delta.clone())
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

fn begin_submit_claim(
    kernel: &Kernel,
    id: &str,
    analyzer: &dyn IntentAnalyzer,
    tick: u64,
) -> ClaimHandle {
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: id.into(),
            actor: "agent:test".into(),
            reasoning: "rename User as one coordinated change set".into(),
            submission_idempotency_key: format!("submission:{id}"),
        })
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
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(id, analyzer, tick).unwrap()
    else {
        panic!("expected ready change set")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, analyzer, tick + 1)
        .unwrap()
    else {
        panic!("expected claimed change set")
    };
    claim
}

#[test]
fn claimed_composite_publication_is_kernel_owned_atomic_and_idempotent_after_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let claim = begin_submit_claim(&kernel, "rename-user", &analyzer, 10);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));

    let report = kernel
        .publish_claimed(&claim, &analyzer, &builder, 20)
        .unwrap();
    assert_eq!(report.generation, 1);
    assert!(!report.already_published);
    assert_eq!(builder.calls(), 1);
    assert_eq!(kernel.snapshot().generation(), 1);

    let retry = kernel
        .publish_claimed(&claim, &analyzer, &builder, 21)
        .unwrap();
    assert_eq!(retry.generation, report.generation);
    assert_eq!(retry.digest, report.digest);
    assert!(retry.already_published);
    assert_eq!(builder.calls(), 1, "committed retries must not rebuild");
    drop(kernel);

    let (reopened, recovered) = Kernel::open(&path).unwrap();
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
    let retry_after_reopen = reopened
        .publish_claimed(&claim, &analyzer, &builder, 30)
        .unwrap();
    assert_eq!(retry_after_reopen.generation, 1);
    assert_eq!(retry_after_reopen.digest, report.digest);
    assert!(retry_after_reopen.already_published);
}

#[test]
fn stale_claim_and_rogue_delta_are_rejected_without_side_effects() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 8]);
    let claim = begin_submit_claim(&kernel, "contained", &analyzer, 0);

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
        assert!(
            kernel
                .publish_claimed(&stale, &analyzer, &builder, 2)
                .is_err()
        );
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
        let error = kernel
            .publish_claimed(&claim, &analyzer, &builder, 3)
            .unwrap_err();
        assert!(error.to_string().contains("outside inferred scope"));
        assert_eq!(kernel.snapshot().generation(), 0);
        assert_eq!(
            kernel.change_set("contained").unwrap().unwrap().state,
            ChangeSetState::Executing
        );
    }
}

#[test]
fn publication_reanalysis_happens_before_builder_and_changed_scope_needs_decision() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let old_scope = user_scope(&snapshot);
    let mut changed_scope = old_scope.clone();
    changed_scope.push("node:308079c405a147d0".into());
    let analyzer = SequencedAnalyzer::new(vec![
        analysis(&old_scope),
        analysis(&old_scope),
        analysis(&changed_scope),
    ]);
    let claim = begin_submit_claim(&kernel, "reanalyze", &analyzer, 0);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));

    let error = kernel
        .publish_claimed(&claim, &analyzer, &builder, 2)
        .unwrap_err();
    assert!(error.to_string().contains("scope changed"));
    assert_eq!(analyzer.calls(), 3);
    assert_eq!(builder.calls(), 0);
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(
        kernel.change_set("reanalyze").unwrap().unwrap().state,
        ChangeSetState::Queued
    );
}

#[test]
fn two_intents_publish_one_aggregate_operation_and_generation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 10]);
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: "composite".into(),
            actor: "agent:composite".into(),
            reasoning: "two intents must land together".into(),
            submission_idempotency_key: "submission:composite".into(),
        })
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
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set("composite", &analyzer, 0).unwrap()
    else {
        panic!("expected ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, &analyzer, 1)
        .unwrap()
    else {
        panic!("expected claim")
    };
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Customer {}"));
    let PublicationReport { generation, .. } = kernel
        .publish_claimed(&claim, &analyzer, &builder, 2)
        .unwrap();
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
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let scope = user_scope(&snapshot);
    let blocker_analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 4]);
    let blocker = begin_submit_claim(&kernel, "blocker", &blocker_analyzer, 0);

    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: "successor".into(),
            actor: "agent:successor".into(),
            reasoning: "wait for the rename".into(),
            submission_idempotency_key: "submission:successor".into(),
        })
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
    let successor_analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 2]);
    assert!(matches!(
        kernel
            .submit_change_set("successor", &successor_analyzer, 2)
            .unwrap(),
        SubmissionOutcome::Queued { .. }
    ));

    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    kernel
        .publish_claimed(&blocker, &blocker_analyzer, &builder, 100)
        .unwrap();
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
    assert_eq!(offer.expires_at_tick, 130);
    assert_eq!(offer.blocking_event_sequence, Some(ready.sequence - 1));
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn failure_after_in_transaction_fence_mutation_rolls_back_fences_graph_and_coordination() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let (kernel, _) = Kernel::create(&path, snapshot.clone()).unwrap();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 5]);
    let claim = begin_submit_claim(&kernel, "rollback", &analyzer, 0);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));

    let failpoints = std::iter::once(CoordinatedPublishFailpoint::AfterFenceMutation)
        .chain((1..=15).map(CoordinatedPublishFailpoint::AfterInsert))
        .chain(std::iter::once(CoordinatedPublishFailpoint::BeforeCommit));
    for failpoint in failpoints {
        kernel
            .publish_claimed_with_failpoint(&claim, &analyzer, &builder, 2, failpoint)
            .unwrap_err();
        assert_eq!(kernel.snapshot().generation(), 0);
        assert_eq!(
            kernel.change_set("rollback").unwrap().unwrap().state,
            ChangeSetState::Executing
        );
        for key in &scope {
            assert_eq!(kernel.fence_state(key).unwrap(), (None, None));
        }
    }

    kernel
        .publish_claimed(&claim, &analyzer, &builder, 3)
        .unwrap();
    for key in &scope {
        assert_eq!(kernel.fence_state(key).unwrap(), (Some(1), Some(1)));
    }
}
