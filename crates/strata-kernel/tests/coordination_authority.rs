use strata_kernel::{
    BeginChangeSet, ChangeSetState, CoordinationError, GraphSnapshot, IntentParameters, Kernel,
    NodeRecord, SCHEMA_VERSION,
};
use tempfile::tempdir;

fn empty_snapshot() -> GraphSnapshot {
    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: Vec::<NodeRecord>::new(),
        references: Vec::new(),
    }
}

#[test]
fn default_kernel_rejects_semantic_execution_without_side_effects() {
    let dir = tempdir().unwrap();
    let (kernel, _) = Kernel::create(dir.path().join("kernel.redb"), empty_snapshot()).unwrap();
    kernel
        .begin_change_set(BeginChangeSet {
            change_set_id: "change:sealed".into(),
            actor: "agent:a".into(),
            reasoning: "prove default authority is sealed".into(),
            submission_idempotency_key: "submit:sealed".into(),
        })
        .unwrap();
    kernel
        .add_intent(
            "change:sealed",
            IntentParameters::RenameSymbol {
                declaration_id: "decl:missing".into(),
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
}
