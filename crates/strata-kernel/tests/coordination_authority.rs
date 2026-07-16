use strata_kernel::{
    BeginChangeSet, ChangeSetState, CoordinationError, GraphSnapshot, IntentParameters, Kernel,
};
use tempfile::tempdir;

#[cfg(feature = "coordination-test-api")]
#[path = "support/coordination.rs"]
#[allow(dead_code)]
mod coordination_support;

fn fixture() -> GraphSnapshot {
    serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap()
}

#[test]
fn default_kernel_rejects_semantic_execution_without_side_effects() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("kernel.redb");
    let snapshot = fixture();
    let declaration_id = snapshot
        .nodes
        .iter()
        .find(|node| node.payload.contains("interface User"))
        .unwrap()
        .id
        .clone();
    let (kernel, _) = Kernel::create(&path, snapshot).unwrap();
    assert!(
        !kernel.snapshot().snapshot().nodes.is_empty(),
        "the default-authority acceptance must run on the committed examples/medium fixture"
    );
    let initial_generation = kernel.snapshot().generation();
    let initial_digest = kernel.snapshot().digest().to_owned();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:sealed".into(),
                actor: "agent:a".into(),
                reasoning: "prove default authority is sealed".into(),
                submission_idempotency_key: "submit:sealed".into(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            "change:sealed",
            IntentParameters::RenameSymbol {
                declaration_id,
                new_name: "Renamed".into(),
            },
        )
        .unwrap();

    let error = kernel.submit_change_set("change:sealed", 1).unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::SemanticProviderUnavailable),
    );
    assert_eq!(
        kernel.change_set("change:sealed").unwrap().unwrap().state,
        ChangeSetState::Draft,
    );
    assert!(kernel.events_after("audit", 0, 10).unwrap().is_empty());
    assert_eq!(kernel.snapshot().generation(), initial_generation);
    assert_eq!(kernel.snapshot().digest(), initial_digest);
    drop(kernel);

    let (reopened, recovered) = Kernel::open(&path).unwrap();
    assert_eq!(recovered.generation, initial_generation);
    assert_eq!(reopened.snapshot().digest(), initial_digest);
    assert_eq!(
        reopened.change_set("change:sealed").unwrap().unwrap().state,
        ChangeSetState::Draft,
    );
    assert!(
        reopened
            .events_after("reopen-audit", 0, 10)
            .unwrap()
            .is_empty()
    );
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn claimed_execution_without_installed_executor_is_side_effect_free() {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    use coordination_support::{GraphDerivedAnalyzer, MediumCoordinationFixture};
    use strata_kernel::{ClaimOutcome, SubmissionOutcome};

    let fixture = MediumCoordinationFixture::load();
    let user = fixture.declaration_named("User");
    let dir = tempdir().unwrap();
    let path = dir.path().join("kernel.redb");
    let (kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:missing-executor".into(),
                actor: "agent:a".into(),
                reasoning: "prove executor absence is sealed".into(),
                submission_idempotency_key: "submit:missing-executor".into(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            "change:missing-executor",
            IntentParameters::RenameSymbol {
                declaration_id: user.id.clone(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { ticket, offer } = kernel
        .submit_change_set("change:missing-executor", 1)
        .unwrap()
    else {
        panic!("expected ready submission")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("expected claimed execution")
    };
    let scope = kernel
        .change_set("change:missing-executor")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    let fence_keys = scope.reservation_keys.clone();
    let resource_keys: BTreeSet<String> = scope
        .read_set
        .iter()
        .chain(&scope.write_set)
        .chain(&scope.validation_set)
        .map(|resource| resource.resource_key.clone())
        .collect();
    let before_graph = kernel.test_graph_table_counts().unwrap();
    let before_coordination = kernel.test_coordination_table_counts().unwrap();
    let before_revisions = kernel.test_scheduler_revisions().unwrap();
    let before_clocks = kernel.test_resource_clocks(&resource_keys).unwrap();
    let before_claims = kernel.test_active_claims().unwrap();
    let before_change_set = kernel
        .change_set("change:missing-executor")
        .unwrap()
        .unwrap();
    let before_ticket = kernel
        .test_scheduler_ticket_for_change_set("change:missing-executor")
        .unwrap();
    let before_events = kernel.events_after("audit", 0, 100).unwrap();
    let before_fences: BTreeMap<_, _> = fence_keys
        .iter()
        .map(|key| (key.clone(), kernel.test_fence_state(key).unwrap()))
        .collect();

    let error = kernel.execute_claimed(&claim, 3).unwrap_err();
    assert_eq!(error.to_string(), "candidate executor is unavailable");

    assert_eq!(kernel.test_graph_table_counts().unwrap(), before_graph);
    assert_eq!(
        kernel.test_coordination_table_counts().unwrap(),
        before_coordination
    );
    assert_eq!(kernel.test_scheduler_revisions().unwrap(), before_revisions);
    assert_eq!(
        kernel.test_resource_clocks(&resource_keys).unwrap(),
        before_clocks
    );
    assert_eq!(kernel.test_active_claims().unwrap(), before_claims);
    assert_eq!(
        kernel
            .change_set("change:missing-executor")
            .unwrap()
            .unwrap(),
        before_change_set
    );
    assert_eq!(
        kernel
            .test_scheduler_ticket_for_change_set("change:missing-executor")
            .unwrap(),
        before_ticket
    );
    assert_eq!(kernel.events_after("audit", 0, 100).unwrap(), before_events);
    assert_eq!(
        fence_keys
            .iter()
            .map(|key| (key.clone(), kernel.test_fence_state(key).unwrap()))
            .collect::<BTreeMap<_, _>>(),
        before_fences
    );
    assert_eq!(ticket.ticket_id, before_ticket.ticket_id);
}
