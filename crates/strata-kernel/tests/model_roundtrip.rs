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

#[test]
fn delete_change_fields_serialize_as_camel_case() {
    assert_eq!(
        serde_json::to_string(&GraphChange::DeleteNode {
            node_id: "decl".into(),
        })
        .unwrap(),
        r#"{"type":"deleteNode","nodeId":"decl"}"#
    );
    assert_eq!(
        serde_json::to_string(&GraphChange::DeleteReference {
            from_node_id: "use".into(),
        })
        .unwrap(),
        r#"{"type":"deleteReference","fromNodeId":"use"}"#
    );
}

#[test]
fn operation_records_round_trip_renames_and_accept_legacy_records_without_them() {
    use strata_kernel::{OperationRecord, OperationRename};

    let operation = OperationRecord {
        operation_id: "operation:1".into(),
        change_set_id: "change:1".into(),
        actor: "client:alpha".into(),
        kind: "RenameSymbol".into(),
        reasoning: "rename displayUser".into(),
        affected_node_ids: vec!["node:display-user".into()],
        renames: vec![OperationRename {
            node_id: "node:display-user".into(),
            from_name: "displayUser".into(),
            to_name: "formatUser".into(),
        }],
        intents: Vec::new(),
    };
    let encoded = serde_json::to_string(&operation).unwrap();
    assert!(encoded.contains("\"renames\":[{\"nodeId\":\"node:display-user\""));
    assert!(encoded.contains("\"fromName\":\"displayUser\""));
    assert!(encoded.contains("\"toName\":\"formatUser\""));
    assert_eq!(
        serde_json::from_str::<OperationRecord>(&encoded).unwrap(),
        operation
    );

    let legacy = r#"{"operationId":"operation:0","changeSetId":"change:0","actor":"client:alpha","kind":"AddParameter","reasoning":"","affectedNodeIds":[]}"#;
    let decoded = serde_json::from_str::<OperationRecord>(legacy).unwrap();
    assert!(decoded.renames.is_empty());
}

#[test]
fn folding_operation_renames_nets_chains_and_drops_round_trips() {
    use strata_kernel::{OperationRecord, OperationRename, fold_operation_renames};

    let operation = |renames: Vec<OperationRename>| OperationRecord {
        operation_id: "operation".into(),
        change_set_id: "change".into(),
        actor: "actor".into(),
        kind: "RenameSymbol".into(),
        reasoning: String::new(),
        affected_node_ids: vec![],
        renames,
        intents: Vec::new(),
    };
    let rename = |node_id: &str, from: &str, to: &str| OperationRename {
        node_id: node_id.into(),
        from_name: from.into(),
        to_name: to.into(),
    };

    let operations = vec![
        operation(vec![rename("node:a", "alpha", "beta")]),
        operation(vec![
            rename("node:a", "beta", "gamma"),
            rename("node:b", "left", "right"),
        ]),
        operation(vec![rename("node:c", "same", "other")]),
        operation(vec![rename("node:c", "other", "same")]),
    ];
    let folded = fold_operation_renames(operations.iter());
    assert_eq!(
        folded,
        vec![
            rename("node:a", "alpha", "gamma"),
            rename("node:b", "left", "right"),
        ]
    );
}
