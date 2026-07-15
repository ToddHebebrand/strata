use strata_kernel::{
    BeginChangeSet, ChangeSetState, CoordinationError, GraphSnapshot, IntentParameters, Kernel,
};
use tempfile::tempdir;

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
