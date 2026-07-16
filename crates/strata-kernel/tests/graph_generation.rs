use strata_kernel::{
    GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord,
    SCHEMA_VERSION,
};

fn seed() -> GraphGeneration {
    GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![NodeRecord {
            id: "n1".into(),
            kind: "Identifier".into(),
            parent_id: Some("s1".into()),
            child_index: Some(0),
            payload: r#"{"text":"Old","offset":0}"#.into(),
        }],
        references: vec![],
    })
    .unwrap()
}

#[test]
fn applying_a_delta_publishes_a_new_generation_without_mutating_the_old_one() {
    let old = seed();
    let mut renamed = old.node("n1").unwrap().clone();
    renamed.payload = r#"{"text":"New","offset":0}"#.into();
    let next = old
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: renamed }],
        })
        .unwrap();

    assert_eq!(old.generation(), 0);
    assert!(old.node("n1").unwrap().payload.contains("Old"));
    assert_eq!(next.generation(), 1);
    assert!(next.node("n1").unwrap().payload.contains("New"));
    assert_ne!(old.digest(), next.digest());
}

#[test]
fn wrong_base_generation_is_rejected() {
    let err = seed()
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 9,
            changes: vec![],
        })
        .unwrap_err();
    assert!(err.to_string().contains("base generation 9"));
}

#[test]
fn reverse_reference_index_is_immutable_across_deletion() {
    let old = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![
            NodeRecord {
                id: "use".into(),
                kind: "Identifier".into(),
                parent_id: None,
                child_index: None,
                payload: "use".into(),
            },
            NodeRecord {
                id: "decl".into(),
                kind: "Identifier".into(),
                parent_id: None,
                child_index: None,
                payload: "decl".into(),
            },
        ],
        references: vec![ReferenceRecord {
            from_node_id: "use".into(),
            to_node_id: "decl".into(),
            kind: "symbol".into(),
        }],
    })
    .unwrap();

    let next = old
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::DeleteReference {
                from_node_id: "use".into(),
            }],
        })
        .unwrap();

    let old_references: Vec<_> = old.references_to("decl").collect();
    assert_eq!(old_references.len(), 1);
    assert_eq!(old_references[0].from_node_id, "use");
    assert_eq!(next.references_to("decl").count(), 0);
}

#[test]
fn snapshot_and_digest_are_deterministic_regardless_of_input_order() {
    let node_a = NodeRecord {
        id: "a".into(),
        kind: "Identifier".into(),
        parent_id: None,
        child_index: None,
        payload: "a".into(),
    };
    let node_b = NodeRecord {
        id: "b".into(),
        kind: "Identifier".into(),
        parent_id: None,
        child_index: None,
        payload: "b".into(),
    };
    let reference = ReferenceRecord {
        from_node_id: "b".into(),
        to_node_id: "a".into(),
        kind: "symbol".into(),
    };

    let forward = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 7,
        nodes: vec![node_a.clone(), node_b.clone()],
        references: vec![reference.clone()],
    })
    .unwrap();
    let reverse = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 7,
        nodes: vec![node_b, node_a],
        references: vec![reference],
    })
    .unwrap();

    assert_eq!(forward.digest(), reverse.digest());
    assert_eq!(
        forward
            .snapshot()
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
fn invalid_snapshots_report_their_specific_integrity_failure() {
    let wrong_schema = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION + 1,
        generation: 0,
        nodes: vec![],
        references: vec![],
    })
    .unwrap_err();
    assert!(wrong_schema.to_string().contains("schema 2"));

    let node = NodeRecord {
        id: "n".into(),
        kind: "Identifier".into(),
        parent_id: None,
        child_index: None,
        payload: "n".into(),
    };
    let duplicate_node = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![node.clone(), node.clone()],
        references: vec![],
    })
    .unwrap_err();
    assert!(duplicate_node.to_string().contains("duplicate node ID n"));

    let reference = ReferenceRecord {
        from_node_id: "n".into(),
        to_node_id: "n".into(),
        kind: "symbol".into(),
    };
    let duplicate_reference = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![node.clone()],
        references: vec![reference.clone(), reference],
    })
    .unwrap_err();
    assert!(
        duplicate_reference
            .to_string()
            .contains("duplicate reference from node ID n")
    );

    let missing_endpoint = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![node],
        references: vec![ReferenceRecord {
            from_node_id: "n".into(),
            to_node_id: "missing".into(),
            kind: "symbol".into(),
        }],
    })
    .unwrap_err();
    assert!(
        missing_endpoint
            .to_string()
            .contains("missing endpoint missing")
    );
}
