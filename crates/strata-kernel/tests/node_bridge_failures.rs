use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use strata_kernel::{
    BeginChangeSet, ClaimHandle, ClaimOutcome, CoordinationEvent, CoordinationTableCounts,
    CoordinationTicket, EventRecord, GraphSnapshot, IntentParameters, Kernel, NodeBridgeConfig,
    OperationRecord, SubmissionOutcome,
};
use tempfile::tempdir;

const SNAPSHOT_JSON: &str = include_str!("fixtures/examples-medium.snapshot.json");

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn trusted_medium_snapshot() -> GraphSnapshot {
    let mut snapshot: GraphSnapshot = serde_json::from_str(SNAPSHOT_JSON).unwrap();
    let corpus_root = repo_root().join("examples/medium");
    let mut retained_ids = snapshot
        .nodes
        .iter()
        .filter(|node| node.kind == "Module" && node.payload.starts_with("/project/src/"))
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    loop {
        let before = retained_ids.len();
        let descendants = snapshot
            .nodes
            .iter()
            .filter(|node| {
                node.parent_id
                    .as_ref()
                    .is_some_and(|parent| retained_ids.contains(parent))
            })
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        retained_ids.extend(descendants);
        if retained_ids.len() == before {
            break;
        }
    }
    snapshot
        .nodes
        .retain(|node| retained_ids.contains(&node.id));
    snapshot.references.retain(|reference| {
        retained_ids.contains(&reference.from_node_id)
            && retained_ids.contains(&reference.to_node_id)
    });
    for module in snapshot
        .nodes
        .iter_mut()
        .filter(|node| node.kind == "Module")
    {
        let relative = module.payload.strip_prefix("/project/").unwrap();
        module.payload = corpus_root.join(relative).to_string_lossy().into_owned();
    }
    snapshot
}

fn mutating_worker_config(directory: &Path) -> (NodeBridgeConfig, PathBuf, PathBuf) {
    let wrapper = directory.join("mutate-candidate-response.mjs");
    let mode = directory.join("response-mode");
    let counter = directory.join("candidate-count");
    fs::write(&mode, "pass").unwrap();
    fs::write(&counter, "0").unwrap();
    fs::write(
        &wrapper,
        r#"import fs from "node:fs";
import { spawnSync } from "node:child_process";

const modePath = process.argv[2];
const realWorker = process.argv[3];
const counterPath = process.argv[4];
const input = fs.readFileSync(0);
const request = JSON.parse(input.toString("utf8"));
const mode = fs.readFileSync(modePath, "utf8").trim();

if (request.kind === "analyzeIntent" || mode === "pass") {
  const child = spawnSync(process.execPath, [realWorker], { input });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
}
fs.writeFileSync(counterPath, String(Number(fs.readFileSync(counterPath, "utf8")) + 1));
if (mode === "nonzero") {
  process.stderr.write("intentional candidate crash\n");
  process.exit(17);
}
if (mode === "timeout") {
  setTimeout(() => {}, 10_000);
} else if (mode === "truncated") {
  process.stdout.write('{"protocolVersion":1');
} else {
  const binding = {
    ...request.binding,
    attemptId: request.attemptId,
    scopeFingerprint: request.scopeFingerprint
  };
  const response = {
    protocolVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    binding,
    ok: true,
    result: {
      delta: { schemaVersion: 1, baseGeneration: request.binding.graphGeneration, changes: [] },
      diagnostics: []
    }
  };
  if (mode === "extra") {
    process.stdout.write(JSON.stringify(response) + "\n{}\n");
  } else if (mode === "unknown-field") {
    response.unexpected = true;
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "unknown-version") {
    response.protocolVersion = 2;
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "request-id") {
    response.requestId += ":stale";
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "kind") {
    response.kind = "analyzeIntent";
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "epoch") {
    response.binding.serviceEpoch = String(BigInt(response.binding.serviceEpoch) + 1n);
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "generation") {
    response.binding.graphGeneration = String(BigInt(response.binding.graphGeneration) + 1n);
    response.result.delta.baseGeneration = response.binding.graphGeneration;
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "digest") {
    response.binding.graphDigest = "0".repeat(64);
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "attempt") {
    response.binding.attemptId += ":stale";
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "scope") {
    response.binding.scopeFingerprint = "0".repeat(64);
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "hydrate" || mode === "validate" || mode === "diagnostics") {
    response.ok = false;
    delete response.result;
    response.error = {
      stage: mode === "hydrate" ? "hydrate" : "validate",
      code: mode === "hydrate" ? "snapshotMismatch" : "typescriptFailed",
      message: mode + " rejected",
      diagnostics: mode === "diagnostics"
        ? [{ nodeId: null, modulePath: null, message: "x".repeat(70_000), code: 1 }]
        : []
    };
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "out-of-scope") {
    const node = request.snapshot.nodes.find((candidate) => candidate.kind === "Module");
    response.result.delta.changes = [{
      type: "upsertNode",
      node: { ...node, payload: node.payload + ".rogue" }
    }];
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "empty") {
    process.stdout.write(JSON.stringify(response) + "\n");
  } else if (mode === "stderr") {
    process.stderr.write("x".repeat(70_000));
    process.exit(17);
  } else {
    throw new Error(`unknown response mode ${mode}`);
  }
}
"#,
    )
    .unwrap();
    let root = repo_root();
    let corpus = root.join("examples/medium");
    (
        NodeBridgeConfig::tsc_only(
            "node",
            vec![
                wrapper.into_os_string(),
                mode.clone().into_os_string(),
                root.join("packages/kernel-bridge/dist/worker.js")
                    .into_os_string(),
                counter.clone().into_os_string(),
            ],
            Duration::from_secs(10),
            corpus.join("src"),
            corpus,
            true,
        ),
        mode,
        counter,
    )
}

fn claim_user_rename(kernel: &Kernel, change_set_id: &str) -> ClaimHandle {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: "agent:bridge-failures".into(),
                reasoning: "prove candidate failure isolation".into(),
                submission_idempotency_key: format!("submission:{change_set_id}"),
            },
            0,
        )
        .unwrap();
    kernel
        .add_intent(
            change_set_id,
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(change_set_id, 1).unwrap()
    else {
        panic!("rename must be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    else {
        panic!("rename must be claimed")
    };
    claim
}

#[derive(Debug, PartialEq, Eq)]
struct CanonicalState {
    live_graph: GraphSnapshot,
    canonical_digests: (String, String, String),
    graph: (u64, String, u64, u64),
    latest_operation: Option<OperationRecord>,
    latest_graph_event: Option<EventRecord>,
    coordination_counts: CoordinationTableCounts,
    scheduler_revisions: (u64, u64),
    durable_ticket: CoordinationTicket,
    ticket: CoordinationTicket,
    claims: Vec<ClaimHandle>,
    latest_coordination_event: Option<CoordinationEvent>,
    fences: BTreeMap<String, (Option<u64>, Option<u64>)>,
    resource_clocks: (BTreeMap<String, u64>, BTreeMap<String, u64>),
}

impl CanonicalState {
    fn capture(kernel: &Kernel, claim: &ClaimHandle) -> Self {
        let graph = kernel.test_graph_table_counts().unwrap();
        let latest_operation = (graph.0 > 0)
            .then(|| kernel.operation(graph.0).unwrap())
            .flatten();
        let latest_graph_event = (graph.3 > 0)
            .then(|| kernel.test_graph_event(graph.3).unwrap())
            .flatten();
        let events = kernel
            .events_after("bridge-failure-audit", 0, 1_024)
            .unwrap();
        Self {
            live_graph: kernel.snapshot().snapshot(),
            canonical_digests: kernel.test_canonical_digests().unwrap(),
            graph,
            latest_operation,
            latest_graph_event,
            coordination_counts: kernel.test_coordination_table_counts().unwrap(),
            scheduler_revisions: kernel.test_scheduler_revisions().unwrap(),
            durable_ticket: kernel
                .ticket_for_change_set(&claim.change_set_id)
                .unwrap()
                .unwrap(),
            ticket: kernel
                .test_scheduler_ticket_for_change_set(&claim.change_set_id)
                .unwrap(),
            claims: kernel.test_active_claims().unwrap(),
            latest_coordination_event: events.last().cloned(),
            fences: claim
                .reservation_keys
                .iter()
                .map(|key| (key.clone(), kernel.test_fence_state(key).unwrap()))
                .collect(),
            resource_clocks: kernel.test_all_resource_clocks().unwrap(),
        }
    }

    fn assert_unchanged(&self, kernel: &Kernel, claim: &ClaimHandle, case: &str) {
        assert_eq!(Self::capture(kernel, claim), *self, "{case}");
        assert!(
            kernel.test_active_claims().unwrap().contains(claim),
            "{case}: candidate failure must leave the active claim unchanged"
        );
    }
}

#[test]
fn candidate_process_protocol_binding_and_containment_failures_are_side_effect_free() {
    let directory = tempdir().unwrap();
    let (config, mode_path, counter_path) = mutating_worker_config(directory.path());
    let (mut kernel, _) = Kernel::create_with_node_bridge(
        directory.path().join("kernel.redb"),
        trusted_medium_snapshot(),
        config.clone(),
    )
    .unwrap();
    let claim = claim_user_rename(&kernel, "bridge-failure-matrix");
    let before = CanonicalState::capture(&kernel, &claim);

    let cases = [
        ("nonzero", "nonzero status"),
        ("timeout", "deadline exceeded"),
        ("truncated", "invalid bridge response JSON or extra frame"),
        ("extra", "invalid bridge response JSON or extra frame"),
        (
            "unknown-field",
            "invalid bridge response JSON or extra frame",
        ),
        ("unknown-version", "unsupported response protocol version 2"),
        ("request-id", "response requestId mismatch"),
        ("kind", "response kind mismatch"),
        ("epoch", "candidate response binding mismatch"),
        ("generation", "candidate response binding mismatch"),
        ("digest", "candidate response binding mismatch"),
        ("attempt", "candidate response binding mismatch"),
        ("scope", "candidate response binding mismatch"),
        ("hydrate", "snapshotMismatch"),
        ("validate", "typescriptFailed"),
        ("diagnostics", "diagnostics exceed configured byte limit"),
        ("out-of-scope", "node:"),
    ];
    let mut executed = Vec::new();
    for (index, (case, expected_error)) in cases.iter().enumerate() {
        fs::write(&mode_path, case).unwrap();
        kernel.test_replace_node_candidate_executor(if *case == "timeout" {
            config
                .clone()
                .test_with_deadline(Duration::from_millis(250))
        } else {
            config.clone()
        });
        let error = kernel.execute_claimed(&claim, 3).unwrap_err();
        let error_chain = format!("{error:#}");
        assert!(error_chain.contains(expected_error), "{case}: {error:#}");
        assert_eq!(
            fs::read_to_string(&counter_path).unwrap().trim(),
            (index + 1).to_string(),
            "{case}: exactly one candidate process must run"
        );
        before.assert_unchanged(&kernel, &claim, case);
        executed.push(*case);
    }

    let process_cases = [
        ("spawn", "spawn Node bridge executable", 17_usize),
        (
            "request-limit",
            "bridge request exceeds configured byte limit",
            17,
        ),
        (
            "response-limit",
            "stdout response exceeded configured byte limit",
            18,
        ),
        ("stderr-limit", "stderr exceeded configured byte limit", 19),
    ];
    for (case, expected_error, expected_count) in process_cases {
        let candidate_config = match case {
            "spawn" => config
                .clone()
                .test_with_executable(directory.path().join("missing-node-bridge")),
            "request-limit" => config
                .clone()
                .test_with_limits(1, 16 * 1024 * 1024, 64 * 1024),
            "response-limit" => config
                .clone()
                .test_with_limits(32 * 1024 * 1024, 128, 64 * 1024),
            "stderr-limit" => {
                config
                    .clone()
                    .test_with_limits(32 * 1024 * 1024, 16 * 1024 * 1024, 64)
            }
            _ => unreachable!(),
        };
        fs::write(
            &mode_path,
            if case == "stderr-limit" {
                "stderr"
            } else {
                "empty"
            },
        )
        .unwrap();
        kernel.test_replace_node_candidate_executor(candidate_config);
        let error = kernel.execute_claimed(&claim, 3).unwrap_err();
        assert!(
            error.to_string().contains(expected_error),
            "{case}: {error:#}"
        );
        assert_eq!(
            fs::read_to_string(&counter_path).unwrap().trim(),
            expected_count.to_string(),
            "{case}: candidate invocation count"
        );
        before.assert_unchanged(&kernel, &claim, case);
        executed.push(case);
    }
    let expected_labels = cases
        .map(|(case, _)| case)
        .into_iter()
        .chain(process_cases.map(|(case, _, _)| case))
        .collect::<Vec<_>>();
    assert_eq!(executed, expected_labels);
}
