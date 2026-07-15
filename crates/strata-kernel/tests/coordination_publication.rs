#![cfg(feature = "coordination-test-api")]

#[cfg(feature = "redb-spike-api")]
use std::collections::{BTreeMap, BTreeSet};
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

struct EmptyBuilder;

impl CandidateBuilder for EmptyBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph.generation(),
            changes: Vec::new(),
        })
    }
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
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            self.entered.wait();
            self.release.wait();
        }
        CandidateEnvelope::from_delta(self.delta.clone())
    }
}

struct PassiveBuilder(GraphDelta);

impl CandidateBuilder for PassiveBuilder {
    fn build_candidate(&self, _prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(self.0.clone())
    }
}

struct PanickingReplayBuilder;

impl CandidateBuilder for PanickingReplayBuilder {
    fn build_candidate(&self, _prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        panic!("committed replay builder panic")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PreparedObservation {
    graph_generation: u64,
    scope_fingerprint: String,
    attempt_id: String,
}

struct InspectingBuilder {
    delta: GraphDelta,
    observations: Mutex<Vec<PreparedObservation>>,
}

impl InspectingBuilder {
    fn new(delta: GraphDelta) -> Self {
        Self {
            delta,
            observations: Mutex::new(Vec::new()),
        }
    }

    fn observations(&self) -> Vec<PreparedObservation> {
        self.observations.lock().unwrap().clone()
    }
}

impl CandidateBuilder for InspectingBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        self.observations.lock().unwrap().push(PreparedObservation {
            graph_generation: prepared.graph.generation(),
            scope_fingerprint: prepared.scope_fingerprint.clone(),
            attempt_id: prepared.attempt_id.clone(),
        });
        CandidateEnvelope::from_delta(self.delta.clone())
    }
}

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

fn resource(key: &str) -> ResourceVersion {
    ResourceVersion::new(key, "v0").unwrap()
}

fn published(outcome: PublishClaimOutcome) -> PublicationReport {
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("expected published outcome")
    };
    report
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

#[cfg(feature = "redb-spike-api")]
#[derive(Clone, Debug, Eq, PartialEq)]
struct AtomicState {
    graph_generation: u64,
    graph_digest: String,
    operation_count: u64,
    graph_event_count: u64,
    operation: Option<serde_json::Value>,
    graph_event: Option<serde_json::Value>,
    graph_ticket: Option<serde_json::Value>,
    graph_idempotency: Option<(String, u64)>,
    coordination_events: Vec<serde_json::Value>,
    change_set: serde_json::Value,
    ticket: serde_json::Value,
    offer: Option<serde_json::Value>,
    claim: Option<serde_json::Value>,
    metadata: strata_kernel::RecoveryMetadataState,
    resource_clocks: BTreeMap<String, u64>,
    attempt: Option<serde_json::Value>,
    fence_states: BTreeMap<String, (Option<u64>, Option<u64>)>,
    referential_consistency: BTreeMap<String, bool>,
    live_generation: u64,
    live_digest: String,
    live_resource_clocks: BTreeMap<String, u64>,
}

#[cfg(feature = "redb-spike-api")]
fn normalize_atomic_record<T: serde::Serialize>(
    record: &T,
    replacements: &BTreeMap<String, String>,
) -> serde_json::Value {
    fn normalize(value: &mut serde_json::Value, replacements: &BTreeMap<String, String>) {
        match value {
            serde_json::Value::String(text) => {
                if let Some(replacement) = replacements.get(text) {
                    *text = replacement.clone();
                } else if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(text) {
                    // Payload JSON is structural state too. Parsing it prevents a changed linked
                    // ID or payload field from hiding inside an opaque string.
                    normalize(&mut payload, replacements);
                    *value = payload;
                }
            }
            serde_json::Value::Array(values) => {
                for value in values {
                    normalize(value, replacements);
                }
            }
            serde_json::Value::Object(fields) => {
                for value in fields.values_mut() {
                    normalize(value, replacements);
                }
            }
            _ => {}
        }
    }

    let mut value = serde_json::to_value(record).unwrap();
    normalize(&mut value, replacements);
    value
}

#[cfg(feature = "redb-spike-api")]
impl AtomicState {
    fn read(
        kernel: &Kernel,
        resource_keys: &BTreeSet<String>,
        change_set_id: &str,
        attempt_id: &str,
    ) -> anyhow::Result<Self> {
        let snapshot = kernel.snapshot();
        let (graph_generation, graph_digest, operation_count, graph_event_count) =
            kernel.test_graph_table_counts()?;
        let (live_scheduler_revision, scheduler_revision) = kernel.test_scheduler_revisions()?;
        assert_eq!(live_scheduler_revision, scheduler_revision);
        let change_set = kernel
            .change_set(change_set_id)?
            .context("atomic-state change set is missing")?;
        let ticket = kernel
            .ticket_for_change_set(change_set_id)?
            .context("atomic-state ticket is missing")?;
        let offer = kernel.ready_offer_for_change_set(change_set_id)?;
        let claim = kernel
            .test_active_claims()?
            .into_iter()
            .find(|claim| claim.change_set_id == change_set_id);
        let attempt = kernel.publication_attempt(attempt_id)?;
        let operation = (graph_generation > 0)
            .then(|| kernel.operation(graph_generation))
            .transpose()?
            .flatten();
        let graph_event = (graph_generation > 0)
            .then(|| kernel.test_graph_event(graph_generation))
            .transpose()?
            .flatten();
        let graph_ticket = kernel.test_graph_ticket(&ticket.ticket_id)?;
        let idempotency_key = format!("coordination-commit:{change_set_id}");
        let graph_idempotency = kernel
            .test_graph_idempotency_generation(&idempotency_key)?
            .map(|generation| (idempotency_key, generation));
        let coordination_events = kernel.events_after("atomic-state-reader", 0, 1_000)?;

        // Independent control databases generate different UUID-backed identities. Normalize
        // exactly those volatile IDs (operation, graph/coordination event, ticket, offer/token,
        // claim/attempt, and intent IDs) to relationship-preserving aliases. Stable identities,
        // generations, states, scopes, clocks, payload fields, and all other record contents stay
        // byte-for-byte comparable.
        let mut replacements = BTreeMap::new();
        replacements.insert(ticket.ticket_id.clone(), "<ticket-id>".into());
        for (index, intent_id) in change_set.intent_ids.iter().enumerate() {
            replacements.insert(intent_id.clone(), format!("<intent-id:{index}>"));
        }
        if let Some(offer) = &offer {
            replacements.insert(offer.offer_id.clone(), "<offer-id>".into());
            replacements.insert(offer.claim_token.clone(), "<claim-token>".into());
        }
        if let Some(claim) = &claim {
            replacements.insert(claim.claim_id.clone(), "<claim-id>".into());
            replacements.insert(claim.offer_id.clone(), "<offer-id>".into());
            replacements.insert(claim.attempt_id.clone(), "<attempt-id>".into());
        }
        if let Some(attempt) = &attempt {
            replacements.insert(attempt.attempt_id.clone(), "<attempt-id>".into());
        }
        if let Some(operation) = &operation {
            // Operation ID is the sole ignored OperationRecord value; linkage remains explicit
            // below and inside the normalized graph event payload.
            replacements.insert(operation.operation_id.clone(), "<operation-id>".into());
        }
        if let Some(event) = &graph_event {
            replacements.insert(event.event_id.clone(), "<graph-event-id>".into());
        }
        for event in &coordination_events {
            replacements.insert(
                event.event_id.clone(),
                format!("<coordination-event-id:{}>", event.sequence),
            );
        }

        let graph_payload = graph_event
            .as_ref()
            .and_then(|event| serde_json::from_str::<serde_json::Value>(&event.payload_json).ok());
        let mut referential_consistency = BTreeMap::from([
            (
                "operation-change-set".into(),
                operation
                    .as_ref()
                    .is_some_and(|operation| operation.change_set_id == change_set_id),
            ),
            (
                "graph-event-change-set".into(),
                graph_payload
                    .as_ref()
                    .is_some_and(|payload| payload["changeSetId"].as_str() == Some(change_set_id)),
            ),
            (
                "graph-event-operation".into(),
                operation.as_ref().is_some_and(|operation| {
                    graph_payload.as_ref().is_some_and(|payload| {
                        payload["operationId"].as_str() == Some(operation.operation_id.as_str())
                    })
                }),
            ),
            (
                "graph-ticket-coordination-ticket".into(),
                graph_ticket
                    .as_ref()
                    .is_some_and(|graph_ticket| graph_ticket.ticket_id == ticket.ticket_id),
            ),
            (
                "graph-ticket-scope".into(),
                graph_ticket.as_ref().is_some_and(|graph_ticket| {
                    graph_ticket.scope_fingerprint == ticket.scope_fingerprint
                }),
            ),
            (
                "idempotency-generation".into(),
                graph_idempotency
                    .as_ref()
                    .is_some_and(|(_, generation)| *generation == graph_generation),
            ),
            (
                "attempt-change-set".into(),
                attempt
                    .as_ref()
                    .is_some_and(|attempt| attempt.change_set_id == change_set_id),
            ),
            (
                "attempt-generation".into(),
                attempt
                    .as_ref()
                    .is_some_and(|attempt| attempt.generation == graph_generation),
            ),
        ]);
        for event in &coordination_events {
            referential_consistency.insert(
                format!("coordination-event-sequence:{}", event.sequence),
                event.sequence > 0 && event.change_set_id == change_set_id,
            );
        }
        Ok(Self {
            graph_generation,
            graph_digest,
            operation_count,
            graph_event_count,
            operation: operation
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            graph_event: graph_event
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            graph_ticket: graph_ticket
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            graph_idempotency,
            coordination_events: coordination_events
                .iter()
                .map(|record| normalize_atomic_record(record, &replacements))
                .collect(),
            change_set: normalize_atomic_record(&change_set, &replacements),
            ticket: normalize_atomic_record(&ticket, &replacements),
            offer: offer
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            claim: claim
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            metadata: kernel.test_recovery_metadata()?,
            resource_clocks: kernel.test_durable_resource_clocks(resource_keys)?,
            attempt: attempt
                .as_ref()
                .map(|record| normalize_atomic_record(record, &replacements)),
            fence_states: resource_keys
                .iter()
                .map(|key| Ok((key.clone(), kernel.fence_state(key)?)))
                .collect::<anyhow::Result<_>>()?,
            referential_consistency,
            live_generation: snapshot.generation(),
            live_digest: snapshot.digest().to_owned(),
            live_resource_clocks: kernel.test_resource_clocks(resource_keys)?,
        })
    }
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn atomic_state_distinguishes_wrong_graph_publication_content() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let resource_keys = atomic_resource_keys(&snapshot);
    let (kernel, analyzer, claim, builder) = atomic_case(&path);
    let attempt_id = claim.attempt_id.clone();
    kernel.publish_claimed(&claim, &builder, 2).unwrap();
    drop(kernel);
    let state = recovered_atomic_state(&path, analyzer, &resource_keys, &attempt_id);

    for mutate in ["operation", "event", "ticket", "idempotency"] {
        let mut wrong = state.clone();
        match mutate {
            "operation" => wrong.operation.as_mut().unwrap()["kind"] = "wrong".into(),
            "event" => wrong.graph_event.as_mut().unwrap()["kind"] = "wrong".into(),
            "ticket" => wrong.graph_ticket.as_mut().unwrap()["state"] = "wrong".into(),
            "idempotency" => wrong.graph_idempotency.as_mut().unwrap().1 += 1,
            _ => unreachable!(),
        }
        assert_ne!(state, wrong, "AtomicState ignored mutated {mutate} content");
    }
}

#[cfg(feature = "redb-spike-api")]
fn atomic_resource_keys(snapshot: &GraphSnapshot) -> BTreeSet<String> {
    let user = snapshot
        .nodes
        .iter()
        .find(|node| node.id == "fc98295bca9efc3e")
        .unwrap();
    let parent = user.parent_id.as_deref().unwrap();
    [
        "node:fc98295bca9efc3e".to_owned(),
        format!("node:{parent}"),
        format!("children:{parent}"),
    ]
    .into_iter()
    .collect()
}

#[cfg(feature = "redb-spike-api")]
fn atomic_case(
    path: &std::path::Path,
) -> (
    Kernel,
    Arc<SequencedAnalyzer>,
    ClaimHandle,
    RecordingBuilder,
) {
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = Arc::new(SequencedAnalyzer::new(vec![analysis(&scope); 8]));
    let (kernel, _) =
        Kernel::create_with_test_semantics(path, snapshot.clone(), analyzer.clone()).unwrap();
    let claim = begin_submit_claim(&kernel, "atomic", 0);
    let builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    (kernel, analyzer, claim, builder)
}

#[cfg(feature = "redb-spike-api")]
fn recovered_atomic_state(
    path: &std::path::Path,
    analyzer: Arc<SequencedAnalyzer>,
    resource_keys: &BTreeSet<String>,
    attempt_id: &str,
) -> AtomicState {
    let (kernel, _) = Kernel::open_with_test_semantics(path, analyzer).unwrap();
    AtomicState::read(&kernel, resource_keys, "atomic", attempt_id).unwrap()
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
fn empty_delta_publication_reopens_without_a_false_clock_marker() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = Arc::new(SequencedAnalyzer::new(vec![analysis(&scope); 4]));
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot, analyzer.clone()).unwrap();
    let claim = begin_submit_claim(&kernel, "empty-delta", 0);

    let PublishClaimOutcome::Published(report) =
        kernel.publish_claimed(&claim, &EmptyBuilder, 2).unwrap()
    else {
        panic!("empty delta did not publish")
    };
    assert_eq!(report.generation, 1);
    assert!(
        kernel
            .test_durable_resource_clocks(&BTreeSet::new())
            .unwrap()
            .is_empty()
    );
    drop(kernel);

    let (reopened, _) = Kernel::open_with_test_semantics(&path, analyzer).unwrap();
    assert_eq!(reopened.snapshot().generation(), 1);
    assert!(
        reopened
            .test_durable_resource_clocks(&BTreeSet::new())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn changed_builder_output_for_same_attempt_is_rejected() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "builder-attempt-replay", 0);
    let first_builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    let first = published(kernel.publish_claimed(&claim, &first_builder, 2).unwrap());

    let same_builder = RecordingBuilder::new(user_delta(&snapshot, "export interface Account {}"));
    let replay = published(kernel.publish_claimed(&claim, &same_builder, 3).unwrap());
    assert_eq!(replay.generation, first.generation);
    assert_eq!(replay.digest, first.digest);
    assert!(replay.already_published);
    assert_eq!(
        same_builder.calls(),
        1,
        "builder replay must bind its digest"
    );

    let changed_builder =
        RecordingBuilder::new(user_delta(&snapshot, "export interface Customer {}"));
    let error = kernel
        .publish_claimed(&claim, &changed_builder, 4)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::AttemptDigestMismatch),
    );
    assert_eq!(
        changed_builder.calls(),
        1,
        "changed builder output must be digested"
    );
}

#[test]
fn committed_builder_replay_uses_only_durable_prepared_authority() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "durable-replay-authority", 0);
    let delta = user_delta(&snapshot, "export interface Account {}");
    let first = published(
        kernel
            .publish_claimed(&claim, &PassiveBuilder(delta.clone()), 2)
            .unwrap(),
    );
    let durable_scope = kernel
        .change_set(&claim.change_set_id)
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap()
        .scope_fingerprint;
    let tampered_claim = ClaimHandle {
        graph_generation: first.generation,
        scope_fingerprint: "caller-controlled-scope".into(),
        ..claim.clone()
    };
    let replay_builder = InspectingBuilder::new(delta);

    let replay = published(
        kernel
            .publish_claimed(&tampered_claim, &replay_builder, 3)
            .unwrap(),
    );

    assert!(replay.already_published);
    assert_eq!(replay.generation, first.generation);
    assert_eq!(replay.digest, first.digest);
    assert_eq!(
        replay_builder.observations(),
        vec![PreparedObservation {
            graph_generation: first.generation.checked_sub(1).unwrap(),
            scope_fingerprint: durable_scope,
            attempt_id: claim.attempt_id,
        }],
        "caller-controlled claim fields must not select replay authority"
    );
}

#[test]
fn committed_envelope_replays_without_semantic_provider() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "provider-free-replay", 0);
    let envelope =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Account {}"))
            .unwrap();
    let PublishClaimOutcome::Published(first) = kernel
        .publish_claimed_envelope(&claim, envelope.clone(), 2)
        .unwrap()
    else {
        panic!("first attempt did not publish")
    };
    drop(kernel);

    let (reopened, recovered) = Kernel::open(&path).unwrap();
    assert_eq!(recovered.generation, first.generation);
    let PublishClaimOutcome::Published(replay) = reopened
        .publish_claimed_envelope(&claim, envelope, 3)
        .unwrap()
    else {
        panic!("provider-free replay did not return the publication")
    };
    assert!(replay.already_published);
    assert_eq!(replay.generation, first.generation);
    assert_eq!(replay.digest, first.digest);

    let changed =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Customer {}"))
            .unwrap();
    let error = reopened
        .publish_claimed_envelope(&claim, changed, 4)
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
fn external_envelope_with_unbound_base_generation_is_rejected_without_side_effects() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "external-stale-base", 0);
    let before_change_set = kernel.change_set("external-stale-base").unwrap().unwrap();
    let before_ticket = kernel
        .ticket_for_change_set("external-stale-base")
        .unwrap()
        .unwrap();
    let before_events = kernel.events_after("stale-base-audit", 0, 20).unwrap();
    let mut stale = user_delta(&snapshot, "export interface Account {}");
    stale.base_generation = 99;
    let envelope = CandidateEnvelope::from_delta(stale).unwrap();

    let error = kernel
        .publish_claimed_envelope(&claim, envelope, 2)
        .unwrap_err();

    assert!(error.to_string().contains("base generation"));
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(
        kernel.change_set("external-stale-base").unwrap().unwrap(),
        before_change_set
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("external-stale-base")
            .unwrap()
            .unwrap(),
        before_ticket
    );
    assert_eq!(
        kernel.events_after("stale-base-audit", 0, 20).unwrap(),
        before_events
    );
}

#[test]
fn envelope_digest_validation_runs_once_with_both_global_mutexes_free() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let kernel = Arc::new(kernel);
    let claim = begin_submit_claim(&kernel, "digest-lock-freedom", 0);
    let envelope =
        CandidateEnvelope::from_delta(user_delta(&snapshot, "export interface Account {}"))
            .unwrap();
    let validations = AtomicUsize::new(0);
    let validation_hook = || {
        validations.fetch_add(1, Ordering::SeqCst);
        assert!(
            kernel.test_publication_mutexes_available(),
            "candidate digest validation must run outside both global mutexes"
        );
    };

    let outcome = kernel
        .publish_claimed_envelope_with_validation_hook(&claim, envelope, 2, &validation_hook)
        .unwrap();

    assert!(matches!(outcome, PublishClaimOutcome::Published(_)));
    assert_eq!(validations.load(Ordering::SeqCst), 1);
}

#[test]
fn committed_replay_builder_panic_returns_error_without_changing_committed_state() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let snapshot = fixture();
    let scope = user_scope(&snapshot);
    let analyzer = SequencedAnalyzer::new(vec![analysis(&scope); 6]);
    let (kernel, _) =
        Kernel::create_with_test_semantics(&path, snapshot.clone(), Arc::new(analyzer)).unwrap();
    let claim = begin_submit_claim(&kernel, "replay-panic", 0);
    let first = published(
        kernel
            .publish_claimed(
                &claim,
                &PassiveBuilder(user_delta(&snapshot, "export interface Account {}")),
                2,
            )
            .unwrap(),
    );
    let before_events = kernel.events_after("replay-panic-audit", 0, 20).unwrap();

    let error = kernel
        .publish_claimed(&claim, &PanickingReplayBuilder, 3)
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("committed replay builder panicked")
    );
    assert_eq!(kernel.snapshot().generation(), first.generation);
    assert_eq!(
        kernel.change_set("replay-panic").unwrap().unwrap().state,
        ChangeSetState::Committed
    );
    assert_eq!(
        kernel.events_after("replay-panic-audit", 0, 20).unwrap(),
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

    let report = published(kernel.publish_claimed(&claim, &builder, 20).unwrap());
    assert_eq!(report.generation, 1);
    assert!(!report.already_published);
    assert_eq!(builder.calls(), 1);
    assert_eq!(kernel.snapshot().generation(), 1);

    let retry = published(kernel.publish_claimed(&claim, &builder, 21).unwrap());
    assert_eq!(retry.generation, report.generation);
    assert_eq!(retry.digest, report.digest);
    assert!(retry.already_published);
    assert_eq!(
        builder.calls(),
        2,
        "committed builder retries must rebuild to bind the candidate digest"
    );
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
    let retry_after_reopen = published(reopened.publish_claimed(&claim, &builder, 30).unwrap());
    assert_eq!(retry_after_reopen.generation, 1);
    assert_eq!(retry_after_reopen.digest, report.digest);
    assert!(retry_after_reopen.already_published);
    assert_eq!(builder.calls(), 3);
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

    let first = published(first.join().unwrap().unwrap());
    let second = second.join().unwrap().unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 1);
    assert_eq!(first.digest, second.digest);
    assert_ne!(first.already_published, second.already_published);
    assert_eq!(
        builder.calls.load(Ordering::SeqCst),
        2,
        "the racing retry must rebuild and verify the recorded candidate digest"
    );
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
    let first = published(
        kernel
            .publish_claimed(&first_claim, &first_builder, 2)
            .unwrap(),
    );

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
    let second = published(
        kernel
            .publish_claimed(
                &second_claim,
                &PassiveBuilder(GraphDelta {
                    schema_version: SCHEMA_VERSION,
                    base_generation: 1,
                    changes: vec![GraphChange::UpsertNode { node: second_node }],
                }),
                5,
            )
            .unwrap(),
    );
    assert_eq!(second.generation, 2);
    let events_before_retry = kernel.events_after("later-audit", 0, 50).unwrap();
    drop(kernel);
    let (kernel, recovered) = Kernel::open(&path).unwrap();
    assert_eq!(recovered.generation, 2);

    let retry = published(
        kernel
            .publish_claimed(&first_claim, &first_builder, 6)
            .unwrap(),
    );
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

    let outcome = kernel.publish_claimed(&claim, &builder, 2).unwrap();
    assert!(matches!(outcome, PublishClaimOutcome::Requeued { .. }));
    assert_eq!(
        analyzer.calls(),
        5,
        "invalidation must repeat fresh analysis before its locked commit"
    );
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
    let outcome = kernel.publish_claimed(&claim, &builder, 10).unwrap();
    assert!(matches!(outcome, PublishClaimOutcome::NeedsDecision { .. }));
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
    let PublishClaimOutcome::Published(PublicationReport { generation, .. }) =
        kernel.publish_claimed(&claim, &builder, 2).unwrap()
    else {
        panic!("composite change set did not publish")
    };
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
    let snapshot = fixture();
    let resource_keys = atomic_resource_keys(&snapshot);

    let old_directory = tempdir().unwrap();
    let old_path = old_directory.path().join("kernel.redb");
    let (old_kernel, old_analyzer, old_claim, _) = atomic_case(&old_path);
    let attempt_id = old_claim.attempt_id.clone();
    drop(old_kernel);
    let complete_old_state =
        recovered_atomic_state(&old_path, old_analyzer, &resource_keys, &attempt_id);

    let new_directory = tempdir().unwrap();
    let new_path = new_directory.path().join("kernel.redb");
    let (new_kernel, new_analyzer, new_claim, new_builder) = atomic_case(&new_path);
    let new_attempt_id = new_claim.attempt_id.clone();
    new_kernel
        .publish_claimed(&new_claim, &new_builder, 2)
        .unwrap();
    drop(new_kernel);
    let complete_new_state =
        recovered_atomic_state(&new_path, new_analyzer, &resource_keys, &new_attempt_id);

    let failpoints = std::iter::once(CoordinatedPublishFailpoint::AfterFenceMutation)
        .chain((1..=18).map(CoordinatedPublishFailpoint::AfterInsert))
        .chain(std::iter::once(
            CoordinatedPublishFailpoint::AfterResourceClockWrite,
        ))
        .chain(std::iter::once(
            CoordinatedPublishFailpoint::AfterAttemptWrite,
        ))
        .chain(std::iter::once(CoordinatedPublishFailpoint::BeforeCommit));
    for failpoint in failpoints {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let (kernel, analyzer, claim, builder) = atomic_case(&path);
        let attempt_id = claim.attempt_id.clone();
        kernel
            .publish_claimed_with_failpoint(&claim, &builder, 2, failpoint)
            .unwrap_err();
        drop(kernel);
        let observed = recovered_atomic_state(&path, analyzer, &resource_keys, &attempt_id);
        let expected_new = complete_new_state.clone();
        assert!(
            observed == complete_old_state || observed == expected_new,
            "{failpoint:?}: observed {observed:#?}\nold {complete_old_state:#?}\nnew {expected_new:#?}"
        );
    }
}
