use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use strata_kernel::{
    BeginChangeSet, GraphSnapshot, IntentParameters, Kernel, NodeBridgeConfig, NodeRecord,
};
use tempfile::tempdir;

const SNAPSHOT_JSON: &str = include_str!("fixtures/examples-medium.snapshot.json");

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn worker_config() -> NodeBridgeConfig {
    let root = repo_root();
    NodeBridgeConfig::tsc_only(
        "node",
        vec![OsString::from(
            root.join("packages/kernel-bridge/dist/worker.js"),
        )],
        Duration::from_secs(30),
        root.join("examples/medium/src"),
        root.join("examples/medium"),
        true,
    )
}

fn fixture_declaration<'a>(
    snapshot: &'a GraphSnapshot,
    name: &str,
) -> (&'a NodeRecord, &'a NodeRecord) {
    let (declaration_id, name_id) = match name {
        "User" => ("fc98295bca9efc3e", "f5e93472d89a054d"),
        "greet" => ("603b2ae524ee3c70", "c88199f537b34a1b"),
        _ => panic!("fixture declaration {name} has no pinned identity"),
    };
    let declaration = snapshot
        .nodes
        .iter()
        .find(|node| node.id == declaration_id)
        .unwrap_or_else(|| panic!("missing declaration {declaration_id}"));
    let name_identifier = snapshot
        .nodes
        .iter()
        .find(|node| node.id == name_id)
        .unwrap_or_else(|| panic!("missing declaration name {name_id}"));
    assert_eq!(name_identifier.parent_id.as_deref(), Some(declaration_id));
    assert_eq!(name_identifier.kind, "Identifier");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&name_identifier.payload)
            .unwrap()
            .get("text")
            .and_then(serde_json::Value::as_str),
        Some(name)
    );
    (declaration, name_identifier)
}

#[test]
fn fixture_helper_selects_the_actual_user_declaration() {
    let snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let (user, name) = fixture_declaration(&snapshot, "User");
    assert_eq!(user.id, "fc98295bca9efc3e");
    assert_eq!(name.id, "f5e93472d89a054d");
}

fn analyze(parameters: IntentParameters) -> strata_kernel::InferredScope {
    let snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let directory = tempdir().unwrap();
    let (kernel, _) = Kernel::create_with_node_bridge(
        directory.path().join("kernel.redb"),
        snapshot,
        worker_config(),
    )
    .unwrap();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "bridge-analysis".into(),
                actor: "agent:bridge-test".into(),
                reasoning: "prove real worker scope".into(),
                submission_idempotency_key: "submission:bridge-analysis".into(),
            },
            0,
        )
        .unwrap();
    kernel.add_intent("bridge-analysis", parameters).unwrap();
    kernel.submit_change_set("bridge-analysis", 1).unwrap();
    kernel
        .change_set("bridge-analysis")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap()
}

fn raw_worker_analysis(
    snapshot: &GraphSnapshot,
    parameters: serde_json::Value,
) -> serde_json::Value {
    let graph = strata_kernel::GraphGeneration::from_snapshot(snapshot.clone()).unwrap();
    let request = serde_json::json!({
        "protocolVersion": 1,
        "requestId": "raw-authority-check",
        "kind": "analyzeIntent",
        "binding": {
            "serviceEpoch": "1",
            "graphGeneration": snapshot.generation.to_string(),
            "graphDigest": graph.digest(),
        },
        "snapshot": {
            "schemaVersion": snapshot.schema_version,
            "generation": snapshot.generation.to_string(),
            "nodes": snapshot.nodes,
            "references": snapshot.references,
        },
        "intent": {
            "schemaVersion": 1,
            "intentId": "raw-intent",
            "changeSetId": "raw-change",
            "baseGeneration": snapshot.generation.to_string(),
            "parameters": parameters,
        }
    });
    let mut child = Command::new("node")
        .arg(repo_root().join("packages/kernel-bridge/dist/worker.js"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
fn real_worker_derives_wide_user_rename_without_node_authority_fields() {
    let snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let (user, user_name) = fixture_declaration(&snapshot, "User");
    assert_eq!(user.id, "fc98295bca9efc3e");
    assert_eq!(user_name.id, "f5e93472d89a054d");
    let scope = analyze(IntentParameters::RenameSymbol {
        declaration_id: user.id.clone(),
        new_name: "Account".into(),
    });

    let validation_node_count = scope
        .validation_set
        .iter()
        .filter(|resource| resource.resource_key.starts_with("node:"))
        .count();
    assert_eq!(validation_node_count, 1065);
    assert!(
        scope
            .write_set
            .iter()
            .any(|resource| resource.resource_key.starts_with("namespace:"))
    );
    assert!(
        scope
            .write_set
            .iter()
            .any(|resource| resource.resource_key.starts_with("absence:"))
    );

    let response = raw_worker_analysis(
        &snapshot,
        serde_json::json!({
            "type": "renameSymbol",
            "declarationId": user.id,
            "newName": "Account",
        }),
    );
    let facts = response
        .pointer("/result/facts")
        .unwrap()
        .as_object()
        .unwrap();
    assert_eq!(facts["references"].as_array().unwrap().len(), 15);
    assert_eq!(
        facts["validationDependencyNodeIds"]
            .as_array()
            .unwrap()
            .len(),
        1065
    );
    assert_eq!(
        facts["validationDependencyReferenceFromNodeIds"]
            .as_array()
            .unwrap()
            .len(),
        558
    );
    assert_eq!(facts["writableStatementIds"].as_array().unwrap().len(), 11);
    assert_eq!(
        facts
            .get("declarationNameIdentifierId")
            .and_then(serde_json::Value::as_str),
        Some(user_name.id.as_str())
    );
    for authority_field in [
        "resourceVersions",
        "reservationKeys",
        "scopeFingerprint",
        "dynamicExpansionPolicy",
        "idempotencyClass",
        "fencingTokens",
    ] {
        assert!(
            !facts.contains_key(authority_field),
            "Node returned {authority_field}"
        );
    }
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
fn real_worker_derives_greet_callsites_with_production_policy() {
    let snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let (greet, greet_name) = fixture_declaration(&snapshot, "greet");
    assert_eq!(greet.id, "603b2ae524ee3c70");
    assert_eq!(greet_name.id, "c88199f537b34a1b");
    let scope = analyze(IntentParameters::AddParameter {
        function_id: greet.id.clone(),
        name: "traceId".into(),
        type_text: "string".into(),
        position: 1,
        default_value: None,
    });

    assert!(
        scope
            .read_set
            .iter()
            .any(|resource| resource.resource_key.starts_with("references-to:"))
    );
    assert!(scope.reservation_keys.len() > 4);
    assert_eq!(
        scope.idempotency_class,
        strata_kernel::IdempotencyClass::ReplaySafe
    );
}
