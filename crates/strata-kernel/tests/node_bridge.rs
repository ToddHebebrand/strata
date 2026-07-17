use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "redb-spike-api")]
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(feature = "coordination-test-api")]
use std::sync::Arc;
#[cfg(feature = "coordination-test-api")]
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::time::Duration;

use serde::Deserialize;
use strata_kernel::{
    BeginChangeSet, ChangeSetState, ClaimHandle, ClaimOutcome, GraphSnapshot, IntentParameters,
    Kernel, NodeBridgeConfig, NodeRecord, PublishClaimOutcome, SubmissionOutcome, TicketState,
};
#[cfg(feature = "redb-spike-api")]
use strata_kernel::{
    EventRecord, GraphChange, GraphDelta, GraphGeneration, OperationRecord, Publication,
    SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir;

#[allow(dead_code)]
#[path = "support/full_key_free.rs"]
mod full_key_free_support;
#[cfg(feature = "coordination-test-api")]
use full_key_free_support::portable_medium_snapshot;
use full_key_free_support::{repo_root, trusted_medium_snapshot, worker_config};

const SNAPSHOT_JSON: &str = include_str!("fixtures/examples-medium.snapshot.json");
#[cfg(feature = "redb-spike-api")]
const ADD_PARAMETER_G1_SNAPSHOT_JSON: &str =
    include_str!("fixtures/examples-medium-add-parameter-g1.snapshot.json");
const EXPECTED_USER_RENAME_OPERATION_IDS: &[&str] = &[
    "04e15410e873a763",
    "08d0bc3e0e44778c",
    "0ae14af110db20ba",
    "0e2c7cfde27056c2",
    "1d615f59f6308080",
    "262006165d44666a",
    "2cc8af56bfb37704",
    "308079c405a147d0",
    "33983e7cf7832b05",
    "36800edc3c98b8c6",
    "377b9df8fddd8a92",
    "3e3440b8b3113e27",
    "4204fef17a252429",
    "47235dd7c111c2cb",
    "496788d1e4395164",
    "49bf0209167f4d8e",
    "50fe82244899de4c",
    "590ad09040fd2c80",
    "5a73149a7f81096f",
    "603b2ae524ee3c70",
    "603e582e13230875",
    "606bb39bd7c03e51",
    "63078ec878351a71",
    "6a4c23ea54e76ce3",
    "709df15be8921f09",
    "773e6478f776d139",
    "817adfc06b50b902",
    "8ad77b3700a42fdc",
    "8b2e686f41b6c2dc",
    "944a17e60a02b7f3",
    "9c9c369c0e34ff01",
    "a97dace3917e2865",
    "abeea112ffe37690",
    "b5a8637dc14d529d",
    "b9da61b286b0252e",
    "bc19fdbf43183413",
    "c4d3f7a11a8eca4a",
    "c69e729085f5a46e",
    "c88199f537b34a1b",
    "c95c1a5621233c6c",
    "cdd3224640ac99fd",
    "cfb665569c1e3467",
    "d46351108520b937",
    "d71b637db69a61e2",
    "d9cd2f08262f637c",
    "e66e22279a3a70ee",
    "e8bce1f743b8fc45",
    "e90ea9407bcf7982",
    "eb4f831a10079c70",
    "f03bfc31ecdb0819",
    "f0fcbcd1bece1b98",
    "f5e93472d89a054d",
    "f8f462e63f347114",
    "fc6d488f4091643c",
    "fc98295bca9efc3e",
];

fn counted_worker_config(directory: &Path) -> (NodeBridgeConfig, PathBuf) {
    let root = repo_root();
    let corpus_root = root.join("examples/medium");
    let wrapper = directory.join("count-node-launches.sh");
    let counter = directory.join("node-launch-count");
    fs::write(
        &wrapper,
        r#"counter=$1
worker=$2
count=$(cat "$counter" 2>/dev/null || printf 0)
printf '%s\n' "$((count + 1))" > "$counter"
exec node "$worker"
"#,
    )
    .unwrap();
    (
        NodeBridgeConfig::tsc_only(
            "sh",
            vec![
                wrapper.into_os_string(),
                counter.clone().into_os_string(),
                root.join("packages/kernel-bridge/dist/worker.js")
                    .into_os_string(),
            ],
            Duration::from_secs(30),
            corpus_root.join("src"),
            corpus_root,
            true,
        ),
        counter,
    )
}

#[cfg(feature = "redb-spike-api")]
fn classified_worker_config(directory: &Path, corpus_root: &Path) -> (NodeBridgeConfig, PathBuf) {
    let wrapper = directory.join("count-node-request-kinds.sh");
    let counter_prefix = directory.join("node-request-count");
    fs::write(
        &wrapper,
        r#"input=$(mktemp)
cat > "$input"
kind=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).kind)' "$input")
counter="$1.$kind"
count=$(cat "$counter" 2>/dev/null || printf 0)
printf '%s\n' "$((count + 1))" > "$counter"
node "$2" < "$input"
status=$?
rm -f "$input"
exit "$status"
"#,
    )
    .unwrap();
    (
        NodeBridgeConfig::tsc_only(
            "sh",
            vec![
                wrapper.into_os_string(),
                counter_prefix.clone().into_os_string(),
                repo_root()
                    .join("packages/kernel-bridge/dist/worker.js")
                    .into_os_string(),
            ],
            Duration::from_secs(30),
            corpus_root.join("src"),
            corpus_root,
            true,
        ),
        counter_prefix,
    )
}

#[cfg(feature = "redb-spike-api")]
fn classified_request_count(prefix: &Path, kind: &str) -> usize {
    launch_count(Path::new(&format!("{}.{}", prefix.display(), kind)))
}

#[cfg(feature = "redb-spike-api")]
fn portable_add_parameter_g1_snapshot() -> GraphSnapshot {
    serde_json::from_str(ADD_PARAMETER_G1_SNAPSHOT_JSON).unwrap()
}

#[cfg(feature = "redb-spike-api")]
fn task10_corpus(corpus_root: &Path) {
    let source = repo_root().join("examples/medium");
    let status = Command::new("cp")
        .args([
            OsString::from("-R"),
            source.into_os_string(),
            corpus_root.into(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    fs::write(
        corpus_root.join("src/kernel-bridge-callsite.ts"),
        "import { greet } from \"./users/greet.ts\";\n\n\
export const kernelBridgeGreeting = greet({\n\
  id: \"kernel-bridge\",\n\
  email: \"bridge@example.test\"\n\
});\n",
    )
    .unwrap();
}

#[cfg(feature = "redb-spike-api")]
fn task10_worker_config(corpus_root: &Path) -> NodeBridgeConfig {
    NodeBridgeConfig::tsc_only(
        "node",
        vec![OsString::from(
            repo_root().join("packages/kernel-bridge/dist/worker.js"),
        )],
        Duration::from_secs(30),
        corpus_root.join("src"),
        corpus_root,
        true,
    )
}

#[cfg(feature = "redb-spike-api")]
fn task10_localized_source_projection(
    snapshot: GraphSnapshot,
    corpus_root: &Path,
) -> GraphSnapshot {
    const HELPER: &str = r#"
import fs from "node:fs";
import path from "node:path";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const { ingestBatch } = await import("./packages/ingest/dist/batch.js");
const { parseCanonicalU64, toKernelSnapshot } = await import("./packages/ingest/dist/kernelSnapshot.js");

const sourceModules = input.snapshot.nodes
  .filter((node) => node.kind === "Module" && node.payload.startsWith("/project/src/"))
  .sort((left, right) => left.payload < right.payload ? -1 : left.payload > right.payload ? 1 : 0);
const inputs = sourceModules.map((module) => {
  const children = input.snapshot.nodes
    .filter((node) => node.parentId === module.id && node.kind !== "Identifier")
    .sort((left, right) => left.childIndex - right.childIndex);
  return {
    path: path.join(input.corpusRoot, module.payload.slice("/project/".length)),
    text: children.map((child) => child.payload).join("")
  };
});
const localized = toKernelSnapshot(
  ingestBatch(inputs),
  parseCanonicalU64(String(input.snapshot.generation))
);
process.stdout.write(JSON.stringify({ ...localized, generation: Number(localized.generation) }));
"#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", HELPER])
        .current_dir(repo_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(
        child.stdin.as_mut().unwrap(),
        &serde_json::json!({ "snapshot": snapshot, "corpusRoot": corpus_root }),
    )
    .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "localized re-ingest failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn launch_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .map_or(0, |value| value.trim().parse().unwrap())
}

#[cfg(feature = "redb-spike-api")]
fn fixture_delta(g0: &GraphSnapshot, g1: &GraphSnapshot) -> GraphDelta {
    assert_eq!(g0.generation, 0);
    assert_eq!(g1.generation, 1);
    let g0_nodes = g0
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    for node in &g0.nodes {
        assert_eq!(
            g1.nodes.iter().find(|candidate| candidate.id == node.id),
            Some(node),
            "G+1 changed or deleted existing node {}",
            node.id
        );
    }
    for reference in &g0.references {
        assert!(
            g1.references.contains(reference),
            "G+1 deleted existing reference {reference:?}"
        );
    }
    let added_nodes = g1
        .nodes
        .iter()
        .filter(|node| !g0_nodes.contains_key(node.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let added_references = g1
        .references
        .iter()
        .filter(|reference| !g0.references.contains(reference))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(added_nodes.len(), 9);
    assert_eq!(added_references.len(), 2);
    let changes = added_nodes
        .into_iter()
        .map(|node| GraphChange::UpsertNode { node })
        .chain(
            added_references
                .into_iter()
                .map(|reference| GraphChange::UpsertReference { reference }),
        )
        .collect();
    let delta = GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes,
    };
    assert_eq!(
        GraphGeneration::from_snapshot(g0.clone())
            .unwrap()
            .apply(&delta)
            .unwrap()
            .snapshot(),
        *g1
    );
    delta
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn inject_validated_g1(kernel: &Kernel, g0: &GraphSnapshot, g1: &GraphSnapshot) {
    let delta = fixture_delta(g0, g1);
    let fence = kernel
        .issue_fence(&["fixture:add-parameter-g1".into()])
        .unwrap();
    let report = kernel
        .publish(Publication {
            schema_version: SCHEMA_VERSION,
            idempotency_key: "fixture:add-parameter-g1".into(),
            operation: OperationRecord {
                operation_id: "fixture-operation:add-parameter-g1".into(),
                change_set_id: "fixture-change-set:add-parameter-g1".into(),
                actor: "fixture:ingest-exporter".into(),
                kind: "FixtureGraphInjection".into(),
                reasoning: "publish the mechanically verified ingest-derived G+1 fixture".into(),
                affected_node_ids: delta
                    .changes
                    .iter()
                    .filter_map(|change| match change {
                        GraphChange::UpsertNode { node } => Some(node.id.clone()),
                        _ => None,
                    })
                    .collect(),
                renames: Vec::new(),
            },
            ticket: TicketRecord {
                ticket_id: "fixture-ticket:add-parameter-g1".into(),
                state: "published".into(),
                scope_fingerprint: "fixture-scope:add-parameter-g1".into(),
            },
            event: EventRecord {
                event_id: "fixture-event:add-parameter-g1".into(),
                sequence: 1,
                kind: "FixtureGraphInjected".into(),
                graph_generation: 1,
                payload_json: "{}".into(),
            },
            delta,
            fence,
        })
        .unwrap();
    assert_eq!(report.generation, 1);
    assert_eq!(kernel.snapshot().snapshot(), *g1);
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RenderedSnapshot {
    modules: BTreeMap<String, String>,
    target_texts: BTreeMap<String, String>,
}

fn render_snapshot(snapshot: &GraphSnapshot, target_ids: &[String]) -> RenderedSnapshot {
    const HELPER: &str = r#"
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const { hydrateSnapshot } = await import("./packages/kernel-bridge/dist/snapshot.js");
const { findNodeById, listChildren, listModules, loadModule } = await import("./packages/store/dist/index.js");
const { renderWithSourceMap } = await import("./packages/render/dist/index.js");

const snapshot = { ...input.snapshot, generation: String(input.snapshot.generation) };
const targets = new Set(input.targetIds);
const targetTexts = {};
const modules = {};
const db = hydrateSnapshot(snapshot);
try {
  for (const module of listModules(db)) {
    const loaded = loadModule(db, module.id);
    const children = [...loaded.children];
    for (const child of loaded.children) {
      if (child.kind !== "Identifier") {
        children.push(...listChildren(db, child.id).filter((node) => node.kind === "Identifier"));
      }
    }
    const rendered = renderWithSourceMap(loaded.module, children);
    modules[module.payload] = rendered.text;

    for (const targetId of targets) {
      const identifier = findNodeById(db, targetId);
      if (!identifier || identifier.kind !== "Identifier" || !identifier.parentId) continue;
      const source = rendered.sourceMap.find((entry) => entry.nodeId === identifier.parentId);
      if (!source) continue;
      const payload = JSON.parse(identifier.payload);
      targetTexts[targetId] = rendered.text.slice(
        source.renderedStart + payload.offset,
        source.renderedStart + payload.offset + payload.text.length
      );
    }
  }
  if (Object.keys(targetTexts).length !== targets.size) {
    throw new Error(`rendered ${Object.keys(targetTexts).length} of ${targets.size} target identifiers`);
  }
  process.stdout.write(JSON.stringify({ modules, targetTexts }));
} finally {
  db.close();
}
"#;

    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", HELPER])
        .current_dir(repo_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(
        child.stdin.as_mut().unwrap(),
        &serde_json::json!({ "snapshot": snapshot, "targetIds": target_ids }),
    )
    .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "render helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn fixture_declaration<'a>(
    snapshot: &'a GraphSnapshot,
    name: &str,
) -> (&'a NodeRecord, &'a NodeRecord) {
    let (declaration_id, name_id) = match name {
        "User" => ("fc98295bca9efc3e", "f5e93472d89a054d"),
        "formatTimestamp" => ("9a25d67ed4b74807", "08ac77e5918b0150"),
        "parseArgs" => ("d3ac2648b7fa1e59", "e7ce70f7c2548d5d"),
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

#[cfg(feature = "coordination-test-api")]
fn published(outcome: PublishClaimOutcome) -> strata_kernel::PublicationReport {
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("expected publication")
    };
    report
}

#[cfg(feature = "coordination-test-api")]
fn await_leader_publication(
    receiver: &Receiver<Result<(), String>>,
    timeout: Duration,
) -> Result<(), String> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            Err("timed out waiting for leader publication".to_owned())
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err("leader publication channel disconnected".to_owned())
        }
    }
}

#[cfg(feature = "coordination-test-api")]
fn await_peer_candidate(receiver: &Receiver<()>, timeout: Duration) -> Result<(), String> {
    match receiver.recv_timeout(timeout) {
        Ok(()) => Ok(()),
        Err(RecvTimeoutError::Timeout) => Err("timed out waiting for peer candidate".to_owned()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("peer candidate channel disconnected".to_owned())
        }
    }
}

#[test]
#[cfg(feature = "coordination-test-api")]
fn bounded_leader_wait_propagates_failure_and_timeout() {
    let (sender, receiver) = sync_channel(1);
    sender
        .send(Err("leader publication failed".to_owned()))
        .unwrap();
    assert_eq!(
        await_leader_publication(&receiver, Duration::from_millis(10)),
        Err("leader publication failed".to_owned())
    );

    let (_sender, receiver) = sync_channel(1);
    assert_eq!(
        await_leader_publication(&receiver, Duration::from_millis(10)),
        Err("timed out waiting for leader publication".to_owned())
    );

    let (_sender, receiver) = sync_channel(1);
    assert_eq!(
        await_peer_candidate(&receiver, Duration::from_millis(10)),
        Err("timed out waiting for peer candidate".to_owned())
    );
}

#[cfg(feature = "coordination-test-api")]
fn execute_real_claim_in_order(
    kernel: &Kernel,
    claim: &ClaimHandle,
    ready_sender: SyncSender<()>,
    peer_ready_receiver: Receiver<()>,
    leader_sender: Option<SyncSender<Result<(), String>>>,
    follower_receiver: Option<Receiver<Result<(), String>>>,
) -> anyhow::Result<PublishClaimOutcome> {
    let before_final = |attempt| {
        if attempt != 0 {
            return;
        }
        ready_sender
            .send(())
            .expect("peer must retain the candidate-ready receiver");
        await_peer_candidate(&peer_ready_receiver, Duration::from_secs(30))
            .unwrap_or_else(|error| panic!("{error}"));
        if let Some(receiver) = &follower_receiver {
            await_leader_publication(receiver, Duration::from_secs(30))
                .unwrap_or_else(|error| panic!("{error}"));
        }
    };
    let outcome = kernel.execute_claimed_with_test_hooks(claim, 10, &before_final);
    if let Some(sender) = leader_sender {
        sender
            .send(outcome.as_ref().map(|_| ()).map_err(ToString::to_string))
            .expect("follower must retain the publication receiver");
    }
    outcome
}

#[cfg(feature = "coordination-test-api")]
fn run_real_disjoint_rename_order(format_first: bool) {
    let snapshot = trusted_medium_snapshot();
    let directory = tempdir().unwrap();
    let (kernel, _) = Kernel::create_with_node_bridge(
        directory.path().join("kernel.redb"),
        snapshot,
        worker_config(),
    )
    .unwrap();
    let kernel = Arc::new(kernel);
    let user_claim = claim_rename(
        &kernel,
        "bridge-concurrent-user",
        "fc98295bca9efc3e",
        "Account",
        "agent:user",
        "rename User concurrently",
        0,
    );
    let format_claim = claim_rename(
        &kernel,
        "bridge-concurrent-format",
        "9a25d67ed4b74807",
        "renderTimestamp",
        "agent:format",
        "rename formatTimestamp concurrently",
        0,
    );
    assert_eq!(user_claim.graph_generation, 0);
    assert_eq!(format_claim.graph_generation, 0);
    let user_attempt_id = user_claim.attempt_id.clone();
    let format_attempt_id = format_claim.attempt_id.clone();

    let (user_ready_sender, format_ready_receiver) = sync_channel(1);
    let (format_ready_sender, user_ready_receiver) = sync_channel(1);
    let (leader_sender, follower_receiver) = sync_channel(1);
    let user_sender = (!format_first).then(|| leader_sender.clone());
    let format_sender = format_first.then_some(leader_sender);
    let (user_receiver, format_receiver) = if format_first {
        (Some(follower_receiver), None)
    } else {
        (None, Some(follower_receiver))
    };
    let (user_outcome, format_outcome) = std::thread::scope(|scope| {
        let user_kernel = kernel.clone();
        let user = scope.spawn(move || {
            execute_real_claim_in_order(
                &user_kernel,
                &user_claim,
                user_ready_sender,
                user_ready_receiver,
                user_sender,
                user_receiver,
            )
        });
        let format_kernel = kernel.clone();
        let format = scope.spawn(move || {
            execute_real_claim_in_order(
                &format_kernel,
                &format_claim,
                format_ready_sender,
                format_ready_receiver,
                format_sender,
                format_receiver,
            )
        });
        (user.join().unwrap(), format.join().unwrap())
    });

    let format_report = published(format_outcome.unwrap());
    let user_report = published(user_outcome.unwrap());
    assert_eq!(format_report.generation, if format_first { 1 } else { 2 });
    assert_eq!(user_report.generation, if format_first { 2 } else { 1 });
    assert_eq!(kernel.snapshot().generation(), 2);
    let user_attempt = kernel
        .publication_attempt(&user_attempt_id)
        .unwrap()
        .unwrap();
    let format_attempt = kernel
        .publication_attempt(&format_attempt_id)
        .unwrap()
        .unwrap();
    assert_eq!(user_attempt.prepared_graph_generation, Some(0));
    assert_eq!(format_attempt.prepared_graph_generation, Some(0));
    assert_eq!(user_attempt.generation, user_report.generation);
    assert_eq!(format_attempt.generation, format_report.generation);
}

#[cfg(feature = "coordination-test-api")]
fn worker_validation_slice(
    snapshot: &GraphSnapshot,
    declaration_id: &str,
    new_name: &str,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let response = raw_worker_analysis(
        snapshot,
        serde_json::json!({
            "type": "renameSymbol",
            "declarationId": declaration_id,
            "newName": new_name,
        }),
    );
    let facts = response.pointer("/result/facts").unwrap();
    let nodes = facts["validationDependencyNodeIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    let references = facts["validationDependencyReferenceFromNodeIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    (nodes, references)
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(feature = "coordination-test-api")]
fn real_disjoint_renames_build_at_g0_and_publish_in_both_orders() {
    let full_snapshot = portable_medium_snapshot();
    let user_slice = worker_validation_slice(&full_snapshot, "fc98295bca9efc3e", "Account");
    let format_slice =
        worker_validation_slice(&full_snapshot, "9a25d67ed4b74807", "renderTimestamp");
    assert!(user_slice.0.is_disjoint(&format_slice.0));
    assert!(user_slice.1.is_disjoint(&format_slice.1));

    run_real_disjoint_rename_order(true);
    run_real_disjoint_rename_order(false);
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(feature = "coordination-test-api")]
fn trusted_source_projection_has_explicit_counts_and_cross_boundary_exclusions() {
    let portable = portable_medium_snapshot();
    let trusted = trusted_medium_snapshot();
    assert_eq!(portable.nodes.len(), 1_282);
    assert_eq!(portable.references.len(), 614);
    assert_eq!(trusted.nodes.len(), 1_203);
    assert_eq!(trusted.references.len(), 592);

    let trusted_ids = trusted
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let excluded_format_references = portable
        .references
        .iter()
        .filter(|reference| {
            reference.to_node_id == "08ac77e5918b0150"
                && !trusted_ids.contains(reference.from_node_id.as_str())
        })
        .map(|reference| reference.from_node_id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        excluded_format_references,
        BTreeSet::from([
            "7c6f5211c022bc27",
            "9f36e72694da9581",
            "e42c8d4899cb6c1e",
            "ff17f3448091a13f",
        ])
    );

    let corpus_root = repo_root().join("examples/medium");
    assert!(
        trusted
            .nodes
            .iter()
            .filter(|node| node.kind == "Module")
            .all(|module| Path::new(&module.payload).starts_with(&corpus_root))
    );
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(feature = "coordination-test-api")]
fn real_validation_dependency_drift_requeues_and_rebuilds_instead_of_reusing() {
    let snapshot = trusted_medium_snapshot();
    let user_slice = worker_validation_slice(&snapshot, "fc98295bca9efc3e", "Account");
    assert!(
        user_slice.0.contains("d3ac2648b7fa1e59"),
        "parseArgs must be a Node-returned member of the stale User validation slice"
    );
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (config, counter) = counted_worker_config(directory.path());
    let (kernel, _) = Kernel::create_with_node_bridge(&path, snapshot, config.clone()).unwrap();
    let format_claim = claim_rename(
        &kernel,
        "bridge-invalidation-format",
        "9a25d67ed4b74807",
        "renderTimestamp",
        "agent:format",
        "keep the disjoint format claim active",
        0,
    );
    let user_claim = claim_rename(
        &kernel,
        "bridge-invalidation-user",
        "fc98295bca9efc3e",
        "Account",
        "agent:user",
        "rebuild User after a validation dependency changes",
        0,
    );
    assert_eq!(format_claim.graph_generation, 0);
    assert_eq!(user_claim.graph_generation, 0);
    let dependency_key = "node:d3ac2648b7fa1e59";
    assert_eq!(
        user_claim
            .dependency_versions
            .iter()
            .find(|dependency| dependency.resource_key == dependency_key)
            .unwrap()
            .clock,
        0
    );
    let dependency_keys = BTreeSet::from([dependency_key.to_owned()]);
    let durable_clocks_before = kernel
        .test_durable_resource_clocks(&dependency_keys)
        .unwrap();
    let graph_before_fault = kernel.snapshot().snapshot();

    let before_final = |attempt| {
        assert_eq!(attempt, 0);
        assert_eq!(
            kernel
                .test_inject_claim_dependency_clock_advance(&user_claim, dependency_key)
                .unwrap(),
            1
        );
    };
    let outcome = kernel
        .execute_claimed_with_test_hooks(&user_claim, 10, &before_final)
        .unwrap();
    assert!(matches!(outcome, PublishClaimOutcome::Requeued { .. }));
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(kernel.snapshot().snapshot(), graph_before_fault);
    assert!(kernel.operation(1).unwrap().is_none());
    assert_eq!(
        kernel
            .test_durable_resource_clocks(&dependency_keys)
            .unwrap(),
        durable_clocks_before
    );
    assert_eq!(
        kernel.test_resource_clocks(&dependency_keys).unwrap()[dependency_key],
        1
    );
    assert!(
        kernel
            .publication_attempt(&user_claim.attempt_id)
            .unwrap()
            .is_none(),
        "the stale validated User candidate must not be reused or recorded"
    );
    assert_eq!(
        kernel
            .change_set("bridge-invalidation-user")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Queued
    );
    drop(kernel);

    let (reopened, recovered) = Kernel::open_with_node_bridge(&path, config).unwrap();
    assert_eq!(recovered.generation, 0);
    assert_eq!(reopened.snapshot().snapshot(), graph_before_fault);
    assert_eq!(
        reopened.test_resource_clocks(&dependency_keys).unwrap()[dependency_key],
        0,
        "reopen must restore the durable pre-fault clock"
    );
    reopened.reconsider_tickets(11).unwrap();
    let offer = reopened
        .ready_offer_for_change_set("bridge-invalidation-user")
        .unwrap()
        .expect("restart reconsideration must make the invalidated User rename ready");
    let ClaimOutcome::Claimed(rebuild_claim) = reopened
        .claim_ready(&offer.offer_id, &offer.claim_token, 12)
        .unwrap()
    else {
        panic!("expected rebuilt User claim")
    };
    assert_eq!(rebuild_claim.graph_generation, 0);
    let launches_before_rebuild = launch_count(&counter);
    let report = published(reopened.execute_claimed(&rebuild_claim, 13).unwrap());
    assert_eq!(
        launch_count(&counter) - launches_before_rebuild,
        3,
        "fresh execution must run pre-build analysis, one candidate build, and final analysis"
    );
    assert_eq!(report.generation, 1);
    let rebuilt_attempt = reopened
        .publication_attempt(&rebuild_claim.attempt_id)
        .unwrap()
        .unwrap();
    assert_eq!(rebuilt_attempt.prepared_graph_generation, Some(0));
    assert_eq!(rebuilt_attempt.generation, 1);
}

#[test]
fn fixture_helper_selects_the_actual_user_declaration() {
    let snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let (user, name) = fixture_declaration(&snapshot, "User");
    assert_eq!(user.id, "fc98295bca9efc3e");
    assert_eq!(name.id, "f5e93472d89a054d");
}

fn claim_rename(
    kernel: &Kernel,
    change_set_id: &str,
    declaration_id: &str,
    new_name: &str,
    actor: &str,
    reasoning: &str,
    now_tick: u64,
) -> ClaimHandle {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: actor.into(),
                reasoning: reasoning.into(),
                submission_idempotency_key: format!("submission:{change_set_id}"),
            },
            now_tick,
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::RenameSymbol {
                declaration_id: declaration_id.into(),
                new_name: new_name.into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } = kernel
        .submit_change_set(change_set_id, now_tick + 1)
        .unwrap()
    else {
        panic!("expected {change_set_id} to be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, now_tick + 2)
        .unwrap()
    else {
        panic!("expected {change_set_id} to be claimed")
    };
    claim
}

#[cfg(feature = "redb-spike-api")]
fn claim_add_parameter(
    kernel: &Kernel,
    change_set_id: &str,
    function_id: &str,
    actor: &str,
    reasoning: &str,
    now_tick: u64,
) -> ClaimHandle {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: actor.into(),
                reasoning: reasoning.into(),
                submission_idempotency_key: format!("submission:{change_set_id}"),
            },
            now_tick,
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::AddParameter {
                function_id: function_id.into(),
                name: "excited".into(),
                type_text: "boolean".into(),
                position: 1,
                default_value: Some("false".into()),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } = kernel
        .submit_change_set(change_set_id, now_tick + 1)
        .unwrap()
    else {
        panic!("expected {change_set_id} to be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, now_tick + 2)
        .unwrap()
    else {
        panic!("expected {change_set_id} to be claimed")
    };
    claim
}

#[cfg(feature = "redb-spike-api")]
fn claim_composite(
    kernel: &Kernel,
    change_set_id: &str,
    user_id: &str,
    greet_id: &str,
    parameter_name: &str,
    actor: &str,
    reasoning: &str,
) -> ClaimHandle {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: actor.into(),
                reasoning: reasoning.into(),
                submission_idempotency_key: format!("submission:{change_set_id}"),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::RenameSymbol {
                declaration_id: user_id.into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::AddParameter {
                function_id: greet_id.into(),
                name: parameter_name.into(),
                type_text: "boolean".into(),
                position: 1,
                default_value: Some("false".into()),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(change_set_id, 1).unwrap()
    else {
        panic!("composite {change_set_id} must be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("composite {change_set_id} must be claimed")
    };
    claim
}

fn expected_rename_affected_ids(
    snapshot: &GraphSnapshot,
    declaration_name_id: &str,
) -> Vec<String> {
    let mut ids = BTreeSet::from([declaration_name_id.to_owned()]);
    ids.extend(
        snapshot
            .references
            .iter()
            .filter(|reference| reference.to_node_id == declaration_name_id)
            .map(|reference| reference.from_node_id.clone()),
    );
    ids.into_iter().collect()
}

fn identifier_text(node: &NodeRecord) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&node.payload)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_owned)
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn real_add_parameter_on_g1_publishes_declaration_and_new_callsite_once() {
    let directory = tempdir().unwrap();
    let corpus_root = directory.path().join("medium");
    task10_corpus(&corpus_root);
    let initial = task10_localized_source_projection(portable_medium_snapshot(), &corpus_root);
    let g1 = task10_localized_source_projection(portable_add_parameter_g1_snapshot(), &corpus_root);
    assert_eq!(initial.generation, 0);
    assert_eq!(g1.generation, 1);
    let greet_id = g1
        .nodes
        .iter()
        .find(|node| node.kind == "FunctionDeclaration" && node.payload.contains("function greet("))
        .unwrap()
        .id
        .clone();
    let new_callsite_id = g1
        .nodes
        .iter()
        .find(|node| node.payload.contains("kernelBridgeGreeting = greet("))
        .unwrap()
        .id
        .clone();
    let greet_before = g1
        .nodes
        .iter()
        .find(|node| node.id == greet_id)
        .unwrap()
        .payload
        .clone();
    let new_callsite_before = g1
        .nodes
        .iter()
        .find(|node| node.id == new_callsite_id)
        .unwrap()
        .payload
        .clone();
    assert!(!greet_before.contains("excited"));
    assert!(!new_callsite_before.contains("false"));

    let (kernel, created) = Kernel::create_with_node_bridge(
        directory.path().join("kernel.redb"),
        initial.clone(),
        task10_worker_config(&corpus_root),
    )
    .unwrap();
    assert_eq!(created.generation, 0);
    inject_validated_g1(&kernel, &initial, &g1);
    let claim = claim_add_parameter(
        &kernel,
        "bridge-real-add-parameter-g1",
        &greet_id,
        "agent:bridge-parameter",
        "publish one validated uniform parameter expansion",
        0,
    );

    let PublishClaimOutcome::Published(report) = kernel.execute_claimed(&claim, 3).unwrap() else {
        panic!("real add-parameter did not publish")
    };
    assert_eq!(report.generation, 2);
    assert!(!report.already_published);
    let graph = kernel.snapshot();
    let greet_after = &graph.node(&greet_id).unwrap().payload;
    let new_callsite_after = &graph.node(&new_callsite_id).unwrap().payload;
    assert_ne!(greet_after, &greet_before);
    assert!(greet_after.contains("excited: boolean = false"));
    assert_ne!(new_callsite_after, &new_callsite_before);
    assert_eq!(new_callsite_after.matches("false").count(), 1);
    assert!(new_callsite_after.contains("greet({"));

    let operation = kernel.operation(2).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "bridge-real-add-parameter-g1");
    assert_eq!(operation.kind, "AddParameter");
    assert_eq!(operation.actor, "agent:bridge-parameter");
    assert_eq!(
        operation.reasoning,
        "publish one validated uniform parameter expansion"
    );
    assert!(operation.affected_node_ids.contains(&greet_id));
    assert!(operation.affected_node_ids.contains(&new_callsite_id));
    assert!(kernel.operation(3).unwrap().is_none());
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn add_parameter_claim_reanalyzes_g1_and_requeues_before_candidate_construction() {
    let directory = tempdir().unwrap();
    let corpus_root = directory.path().join("medium");
    task10_corpus(&corpus_root);
    let g0 = task10_localized_source_projection(portable_medium_snapshot(), &corpus_root);
    let g1 = task10_localized_source_projection(portable_add_parameter_g1_snapshot(), &corpus_root);
    let greet_id = g1
        .nodes
        .iter()
        .find(|node| node.kind == "FunctionDeclaration" && node.payload.contains("function greet("))
        .unwrap()
        .id
        .clone();
    let new_callsite_id = g1
        .nodes
        .iter()
        .find(|node| node.payload.contains("kernelBridgeGreeting = greet("))
        .unwrap()
        .id
        .clone();
    let (config, request_counts) = classified_worker_config(directory.path(), &corpus_root);
    let (kernel, _) =
        Kernel::create_with_node_bridge(directory.path().join("kernel.redb"), g0.clone(), config)
            .unwrap();
    let change_set_id = "bridge-claim-time-add-parameter";
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: "agent:claim-time-parameter".into(),
                reasoning: "discover a callsite added after submission".into(),
                submission_idempotency_key: "submission:claim-time-parameter".into(),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::AddParameter {
                function_id: greet_id.clone(),
                name: "excited".into(),
                type_text: "boolean".into(),
                position: 1,
                default_value: Some("false".into()),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(change_set_id, 1).unwrap()
    else {
        panic!("G0 add-parameter must initially be ready")
    };
    let submitted_scope = kernel
        .change_set(change_set_id)
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert!(
        !submitted_scope
            .write_set
            .iter()
            .any(|resource| { resource.resource_key == format!("node:{new_callsite_id}") })
    );
    let analyses_before_claim = classified_request_count(&request_counts, "analyzeIntent");
    assert!(analyses_before_claim >= 1);
    assert_eq!(
        classified_request_count(&request_counts, "buildValidateCandidate"),
        0
    );

    inject_validated_g1(&kernel, &g0, &g1);
    let ClaimOutcome::Requeued { ticket, event } = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("G1 callsite must expand and requeue during fresh claim analysis")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert_eq!(
        event.kind,
        strata_kernel::CoordinationEventKind::ScopeExpanded
    );
    assert_eq!(kernel.snapshot().generation(), 1);
    assert!(classified_request_count(&request_counts, "analyzeIntent") > analyses_before_claim);
    assert_eq!(
        classified_request_count(&request_counts, "buildValidateCandidate"),
        0,
        "scope expansion must requeue before candidate construction"
    );
    let expanded = kernel.change_set(change_set_id).unwrap().unwrap();
    assert_eq!(expanded.state, ChangeSetState::Queued);
    let expanded_scope = expanded.inferred_scope.unwrap();
    assert!(
        expanded_scope
            .write_set
            .iter()
            .any(|resource| { resource.resource_key == format!("node:{new_callsite_id}") })
    );
    assert_ne!(
        expanded_scope.scope_fingerprint,
        submitted_scope.scope_fingerprint
    );
    assert_eq!(event.change_set_id, change_set_id);

    kernel.reconsider_tickets(3).unwrap();
    let next_offer = kernel
        .ready_offer_for_change_set(change_set_id)
        .unwrap()
        .expect("expanded replay-safe intent must receive fresh ready authority");
    let ClaimOutcome::Claimed(fresh_claim) = kernel
        .claim_ready(&next_offer.offer_id, &next_offer.claim_token, 4)
        .unwrap()
    else {
        panic!("expected fresh G1 claim")
    };
    let report = published(kernel.execute_claimed(&fresh_claim, 5).unwrap());
    assert_eq!(report.generation, 2);
    assert_eq!(
        classified_request_count(&request_counts, "buildValidateCandidate"),
        1
    );
    let published_graph = kernel.snapshot();
    let callsite = &published_graph.node(&new_callsite_id).unwrap().payload;
    assert_eq!(callsite.matches("false").count(), 1);
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn ordered_composite_publishes_once_and_a_failing_second_intent_publishes_nothing() {
    let directory = tempdir().unwrap();
    let corpus_root = directory.path().join("medium");
    task10_corpus(&corpus_root);
    let g0 = task10_localized_source_projection(portable_medium_snapshot(), &corpus_root);
    let g1 = task10_localized_source_projection(portable_add_parameter_g1_snapshot(), &corpus_root);
    let user_id = g1
        .nodes
        .iter()
        .find(|node| node.kind == "InterfaceDeclaration" && node.payload.contains("interface User"))
        .unwrap()
        .id
        .clone();
    let greet_id = g1
        .nodes
        .iter()
        .find(|node| node.kind == "FunctionDeclaration" && node.payload.contains("function greet("))
        .unwrap()
        .id
        .clone();
    let new_callsite_id = g1
        .nodes
        .iter()
        .find(|node| node.payload.contains("kernelBridgeGreeting = greet("))
        .unwrap()
        .id
        .clone();
    let (config, request_counts) = classified_worker_config(directory.path(), &corpus_root);
    let (kernel, _) =
        Kernel::create_with_node_bridge(directory.path().join("kernel.redb"), g0.clone(), config)
            .unwrap();
    inject_validated_g1(&kernel, &g0, &g1);
    let claim = claim_composite(
        &kernel,
        "bridge-real-composite",
        &user_id,
        &greet_id,
        "excited",
        "agent:composite",
        "rename User and expand greet atomically",
    );

    let report = published(kernel.execute_claimed(&claim, 3).unwrap());
    assert_eq!(report.generation, 2);
    assert_eq!(
        classified_request_count(&request_counts, "buildValidateCandidate"),
        1
    );
    let operation = kernel.operation(2).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "bridge-real-composite");
    assert_eq!(operation.kind, "CompositeChangeSet(2)");
    assert_eq!(operation.actor, "agent:composite");
    assert_eq!(
        operation.reasoning,
        "rename User and expand greet atomically"
    );
    for expected in [&user_id, &greet_id, &new_callsite_id] {
        assert!(operation.affected_node_ids.contains(expected));
    }
    assert!(kernel.operation(3).unwrap().is_none());
    let graph = kernel.snapshot();
    assert!(
        graph
            .node(&user_id)
            .unwrap()
            .payload
            .contains("interface Account")
    );
    assert!(
        graph
            .node(&greet_id)
            .unwrap()
            .payload
            .contains("excited: boolean = false")
    );
    assert_eq!(
        graph
            .node(&new_callsite_id)
            .unwrap()
            .payload
            .matches("false")
            .count(),
        1
    );

    let failed_directory = tempdir().unwrap();
    let failed_corpus_root = failed_directory.path().join("medium");
    task10_corpus(&failed_corpus_root);
    let failed_g0 =
        task10_localized_source_projection(portable_medium_snapshot(), &failed_corpus_root);
    let failed_g1 = task10_localized_source_projection(
        portable_add_parameter_g1_snapshot(),
        &failed_corpus_root,
    );
    let failed_user_id = failed_g1
        .nodes
        .iter()
        .find(|node| node.kind == "InterfaceDeclaration" && node.payload.contains("interface User"))
        .unwrap()
        .id
        .clone();
    let failed_greet_id = failed_g1
        .nodes
        .iter()
        .find(|node| node.kind == "FunctionDeclaration" && node.payload.contains("function greet("))
        .unwrap()
        .id
        .clone();
    let (failed_config, failed_counts) =
        classified_worker_config(failed_directory.path(), &failed_corpus_root);
    let (failed_kernel, _) = Kernel::create_with_node_bridge(
        failed_directory.path().join("kernel.redb"),
        failed_g0.clone(),
        failed_config,
    )
    .unwrap();
    inject_validated_g1(&failed_kernel, &failed_g0, &failed_g1);
    let failed_claim = claim_composite(
        &failed_kernel,
        "bridge-failing-composite",
        &failed_user_id,
        &failed_greet_id,
        "not-valid",
        "agent:failing-composite",
        "the invalid second intent must roll back the first",
    );
    let before_failure = failed_kernel.snapshot().snapshot();

    let error = failed_kernel.execute_claimed(&failed_claim, 3).unwrap_err();
    assert!(error.to_string().contains("mutationFailed"), "{error:#}");
    assert_eq!(
        classified_request_count(&failed_counts, "buildValidateCandidate"),
        1
    );
    assert_eq!(failed_kernel.snapshot().snapshot(), before_failure);
    assert!(failed_kernel.operation(2).unwrap().is_none());
    assert_eq!(
        failed_kernel
            .change_set("bridge-failing-composite")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Executing
    );
}

#[test]
#[ignore = "requires pnpm kernel:bridge:build"]
fn real_user_rename_publishes_one_rust_operation_and_recovers_without_node() {
    let initial = trusted_medium_snapshot();
    let (user, user_name) = fixture_declaration(&initial, "User");
    assert_eq!(user.id, "fc98295bca9efc3e");
    let expected_affected = expected_rename_affected_ids(&initial, &user_name.id);
    assert_eq!(expected_affected.len(), 16);

    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (config, counter) = counted_worker_config(directory.path());
    let (kernel, created) =
        Kernel::create_with_node_bridge(&path, initial, config.clone()).unwrap();
    assert_eq!(created.generation, 0);
    let claim = claim_rename(
        &kernel,
        "bridge-real-rename",
        "fc98295bca9efc3e",
        "Account",
        "agent:bridge-publication",
        "publish and recover the real wide rename",
        0,
    );

    let PublishClaimOutcome::Published(report) = kernel.execute_claimed(&claim, 3).unwrap() else {
        panic!("real rename did not publish")
    };
    assert_eq!(report.generation, 1);
    assert!(!report.already_published);
    let published_graph = kernel.snapshot();
    assert_eq!(published_graph.generation(), 1);
    assert_eq!(published_graph.digest(), report.digest);
    let published_snapshot = published_graph.snapshot();
    let rendered_before_reopen = render_snapshot(&published_snapshot, &expected_affected);
    assert_eq!(rendered_before_reopen.modules.len(), 22);
    assert_eq!(rendered_before_reopen.target_texts.len(), 16);
    assert!(
        rendered_before_reopen
            .target_texts
            .values()
            .all(|text| text == "Account")
    );

    let operation = kernel.operation(1).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "bridge-real-rename");
    assert_eq!(operation.kind, "RenameSymbol");
    assert_eq!(operation.actor, "agent:bridge-publication");
    assert_eq!(
        operation.reasoning,
        "publish and recover the real wide rename"
    );
    assert_eq!(
        operation.affected_node_ids,
        EXPECTED_USER_RENAME_OPERATION_IDS
    );
    assert!(kernel.operation(2).unwrap().is_none());
    for node_id in &expected_affected {
        let node = published_graph.node(node_id).unwrap();
        assert_eq!(node.kind, "Identifier");
        assert_eq!(identifier_text(node).as_deref(), Some("Account"));
    }
    assert!(!published_snapshot.nodes.iter().any(|node| {
        node.kind == "Identifier" && identifier_text(node).as_deref() == Some("User")
    }));

    let launches_before_reopen = launch_count(&counter);
    assert!(launches_before_reopen >= 3);
    let expected_digest = published_graph.digest().to_owned();
    let expected_graph = published_snapshot;
    drop(kernel);

    let (reopened, recovered) = Kernel::open_with_node_bridge(&path, config).unwrap();
    assert_eq!(launch_count(&counter), launches_before_reopen);
    assert_eq!(recovered.generation, 1);
    assert_eq!(recovered.digest, expected_digest);
    assert_eq!(reopened.snapshot().snapshot(), expected_graph);
    let rendered_after_reopen =
        render_snapshot(&reopened.snapshot().snapshot(), &expected_affected);
    assert_eq!(rendered_after_reopen, rendered_before_reopen);
    assert_eq!(reopened.operation(1).unwrap().unwrap(), operation);
    assert!(reopened.operation(2).unwrap().is_none());
    assert_eq!(
        reopened
            .change_set("bridge-real-rename")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Committed
    );
    assert_eq!(
        reopened
            .ticket_for_change_set("bridge-real-rename")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Completed
    );
    assert!(
        reopened
            .ready_offer_for_change_set("bridge-real-rename")
            .unwrap()
            .is_none()
    );
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
