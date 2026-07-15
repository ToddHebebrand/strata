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

fn declaration_named<'a>(snapshot: &'a GraphSnapshot, name: &str) -> &'a NodeRecord {
    snapshot
        .nodes
        .iter()
        .find(|node| {
            node.kind.ends_with("Declaration")
                && snapshot.nodes.iter().any(|candidate| {
                    candidate.parent_id.as_deref() == Some(node.id.as_str())
                        && candidate.kind == "Identifier"
                        && serde_json::from_str::<serde_json::Value>(&candidate.payload)
                            .ok()
                            .and_then(|value| value.get("text")?.as_str().map(str::to_owned))
                            .as_deref()
                            == Some(name)
                })
        })
        .unwrap_or_else(|| panic!("missing declaration {name}"))
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
    let user = declaration_named(&snapshot, "User");
    let scope = analyze(IntentParameters::RenameSymbol {
        declaration_id: user.id.clone(),
        new_name: "Account".into(),
    });

    let validation_node_count = scope
        .validation_set
        .iter()
        .filter(|resource| resource.resource_key.starts_with("node:"))
        .count();
    assert!(
        validation_node_count >= 30,
        "expected wide User validation closure, got {validation_node_count}"
    );
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
    let greet = declaration_named(&snapshot, "greet");
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
