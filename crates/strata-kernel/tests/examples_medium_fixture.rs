use strata_kernel::{GraphGeneration, GraphSnapshot};

#[test]
fn examples_medium_snapshot_is_rust_compatible() {
    let snapshot: GraphSnapshot =
        serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap();
    let generation = GraphGeneration::from_snapshot(snapshot.clone()).unwrap();

    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.generation, 0);
    assert!(snapshot.nodes.len() > 100);
    assert!(!snapshot.references.is_empty());
    assert!(
        snapshot
            .nodes
            .iter()
            .all(|node| !node.payload.contains(env!("CARGO_MANIFEST_DIR")))
    );
    assert_eq!(generation.snapshot(), snapshot);
}
