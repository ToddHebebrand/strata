use strata_kernel::{
    GraphChange, GraphDelta, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION,
};

#[test]
fn snapshot_and_delta_json_are_versioned_camel_case_and_round_trip() {
    let snapshot = GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![NodeRecord {
            id: "decl".into(),
            kind: "FunctionDeclaration".into(),
            parent_id: Some("module".into()),
            child_index: Some(0),
            payload: "export function f() {}".into(),
        }],
        references: vec![ReferenceRecord {
            from_node_id: "use".into(),
            to_node_id: "decl".into(),
            kind: "value".into(),
        }],
    };
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(encoded.contains("\"schemaVersion\":1"));
    assert!(encoded.contains("\"parentId\":\"module\""));
    assert_eq!(
        serde_json::from_str::<GraphSnapshot>(&encoded).unwrap(),
        snapshot
    );

    let delta = GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes: vec![GraphChange::UpsertNode {
            node: snapshot.nodes[0].clone(),
        }],
    };
    assert_eq!(
        serde_json::from_slice::<GraphDelta>(&serde_json::to_vec(&delta).unwrap()).unwrap(),
        delta
    );
}
