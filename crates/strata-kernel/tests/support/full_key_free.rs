use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strata_kernel::{
    BeginChangeSet, CancellationOutcome, ChangeSetRecord, ClaimHandle, ClaimOutcome,
    CoordinationEvent, CoordinationTicket, EventCursor, GraphSnapshot, IntentParameters,
    IntentRecord, Kernel, NodeBridgeConfig, NodeRecord, OperationRecord, PublishClaimOutcome,
    ReadyOffer, RecoveryReport, ReferenceRecord, SubmissionOutcome,
};
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
use strata_kernel::{
    EventRecord, GraphChange, GraphDelta, GraphGeneration, OperationRecord as RawOperationRecord,
    Publication, SCHEMA_VERSION, TicketRecord,
};
use tempfile::tempdir_in;

const SNAPSHOT_JSON: &str = include_str!("../fixtures/examples-medium.snapshot.json");
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
const ADD_PARAMETER_G1_SNAPSHOT_JSON: &str =
    include_str!("../fixtures/examples-medium-add-parameter-g1.snapshot.json");
const CANONICAL_AUDIT_CLIENT_ID: &str = "events:full-key-free-canonical-audit";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn worker_config() -> NodeBridgeConfig {
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

pub fn portable_medium_snapshot() -> GraphSnapshot {
    serde_json::from_str(SNAPSHOT_JSON).unwrap()
}

pub fn trusted_medium_snapshot() -> GraphSnapshot {
    trusted_source_projection(portable_medium_snapshot())
}

pub fn trusted_source_projection(mut snapshot: GraphSnapshot) -> GraphSnapshot {
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
                    .is_some_and(|parent_id| retained_ids.contains(parent_id))
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
        let relative = module
            .payload
            .strip_prefix("/project/")
            .unwrap_or_else(|| panic!("unexpected portable module path {}", module.payload));
        module.payload = corpus_root.join(relative).to_string_lossy().into_owned();
    }
    snapshot
}

pub fn create_projected_kernel(path: impl AsRef<Path>) -> Result<(Kernel, RecoveryReport)> {
    Kernel::create_with_node_bridge(path, trusted_medium_snapshot(), worker_config())
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn create_classified_projected_kernel(
    path: impl AsRef<Path>,
    directory: &Path,
) -> Result<(Kernel, RecoveryReport, PathBuf)> {
    let corpus_root = repo_root().join("examples/medium");
    let (config, request_counts) = classified_worker_config(directory, &corpus_root);
    let (kernel, report) =
        Kernel::create_with_node_bridge(path, trusted_medium_snapshot(), config)?;
    Ok((kernel, report, request_counts))
}

pub fn reopen_projected_kernel(path: impl AsRef<Path>) -> Result<(Kernel, RecoveryReport)> {
    Kernel::open_with_node_bridge(path, worker_config())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientActor {
    actor_id: String,
    event_client_id: String,
    acknowledged_event_sequence: u64,
}

impl ClientActor {
    pub fn new(actor_id: impl Into<String>, event_client_id: impl Into<String>) -> Self {
        let actor_id = actor_id.into();
        let event_client_id = event_client_id.into();
        assert!(!actor_id.is_empty(), "client actor ID must not be empty");
        assert!(
            !event_client_id.is_empty(),
            "client event cursor ID must not be empty"
        );
        Self {
            actor_id,
            event_client_id,
            acknowledged_event_sequence: 0,
        }
    }

    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    pub fn acknowledged_event_sequence(&self) -> u64 {
        self.acknowledged_event_sequence
    }

    pub fn begin_change_set(
        &self,
        kernel: &Kernel,
        change_set_id: &str,
        reasoning: &str,
        now_tick: u64,
    ) -> Result<ChangeSetRecord> {
        kernel.begin_change_set(
            BeginChangeSet {
                change_set_id: change_set_id.into(),
                actor: self.actor_id.clone(),
                reasoning: reasoning.into(),
                submission_idempotency_key: format!("submission:{}:{change_set_id}", self.actor_id),
            },
            now_tick,
        )
    }

    pub fn add_intent(
        &self,
        kernel: &Kernel,
        change_set_id: &str,
        parameters: IntentParameters,
    ) -> Result<IntentRecord> {
        kernel.add_intent(change_set_id, parameters)
    }

    pub fn submit_change_set(
        &self,
        kernel: &Kernel,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<SubmissionOutcome> {
        kernel.submit_change_set(change_set_id, now_tick)
    }

    pub fn claim_ready(
        &self,
        kernel: &Kernel,
        offer: &ReadyOffer,
        now_tick: u64,
    ) -> Result<ClaimOutcome> {
        kernel.claim_ready(&offer.offer_id, &offer.claim_token, now_tick)
    }

    pub fn execute_claimed(
        &self,
        kernel: &Kernel,
        claim: &ClaimHandle,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        kernel.execute_claimed(claim, now_tick)
    }

    pub fn cancel_change_set(
        &self,
        kernel: &Kernel,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<CancellationOutcome> {
        kernel.cancel_change_set(change_set_id, now_tick)
    }

    pub fn read_events(&self, kernel: &Kernel, limit: usize) -> Result<Vec<CoordinationEvent>> {
        kernel.events_after(
            &self.event_client_id,
            self.acknowledged_event_sequence,
            limit,
        )
    }

    pub fn acknowledge_events(&mut self, kernel: &Kernel, sequence: u64) -> Result<EventCursor> {
        let cursor = kernel.ack_events(&self.event_client_id, sequence)?;
        self.acknowledged_event_sequence = cursor.acknowledged_sequence;
        Ok(cursor)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalFinalState {
    pub schema_version: u32,
    pub graph_generation: u64,
    pub graph_digest: String,
    pub nodes: Vec<NodeRecord>,
    pub references: Vec<ReferenceRecord>,
    pub operations: Vec<OperationRecord>,
    pub tickets: Vec<CoordinationTicket>,
    pub events: Vec<CoordinationEvent>,
    pub event_cursors: BTreeMap<String, u64>,
}

impl CanonicalFinalState {
    pub fn capture(
        kernel: &Kernel,
        change_set_ids: &[&str],
        actors: &[&ClientActor],
    ) -> Result<Self> {
        let graph = kernel.snapshot();
        let snapshot = graph.snapshot();
        let mut operations = Vec::new();
        for generation in 1..=graph.generation() {
            if let Some(operation) = kernel.operation(generation)? {
                operations.push(operation);
            }
        }
        let mut tickets = change_set_ids
            .iter()
            .map(|change_set_id| {
                kernel
                    .ticket_for_change_set(change_set_id)
                    .with_context(|| format!("read ticket for {change_set_id}"))?
                    .with_context(|| format!("missing ticket for {change_set_id}"))
            })
            .collect::<Result<Vec<_>>>()?;
        tickets.sort_by(|left, right| left.ticket_id.cmp(&right.ticket_id));
        let events = kernel.events_after(CANONICAL_AUDIT_CLIENT_ID, 0, usize::MAX)?;
        let mut event_cursors = BTreeMap::new();
        for actor in actors {
            if event_cursors
                .insert(
                    actor.event_client_id.clone(),
                    actor.acknowledged_event_sequence,
                )
                .is_some()
            {
                bail!(
                    "duplicate acceptance event cursor ID {}",
                    actor.event_client_id
                );
            }
        }
        Ok(Self {
            schema_version: snapshot.schema_version,
            graph_generation: snapshot.generation,
            graph_digest: graph.digest().to_owned(),
            nodes: snapshot.nodes,
            references: snapshot.references,
            operations,
            tickets,
            events,
            event_cursors,
        })
    }

    pub fn graph_snapshot(&self) -> GraphSnapshot {
        GraphSnapshot {
            schema_version: self.schema_version,
            generation: self.graph_generation,
            nodes: self.nodes.clone(),
            references: self.references.clone(),
        }
    }
}

pub fn assert_canonical_final_state(expected: &CanonicalFinalState, actual: &CanonicalFinalState) {
    assert_eq!(actual.schema_version, expected.schema_version, "schema");
    assert_eq!(
        actual.graph_generation, expected.graph_generation,
        "graph generation"
    );
    assert_eq!(actual.graph_digest, expected.graph_digest, "graph digest");
    assert_eq!(actual.nodes, expected.nodes, "canonical nodes");
    assert_eq!(
        actual.references, expected.references,
        "canonical references"
    );
    assert_eq!(actual.operations, expected.operations, "operation history");
    assert_eq!(actual.tickets, expected.tickets, "coordination tickets");
    assert_eq!(actual.events, expected.events, "coordination events");
    assert_eq!(
        actual.event_cursors, expected.event_cursors,
        "client event cursors"
    );
}

pub fn assert_projected_typescript_green(snapshot: &GraphSnapshot) {
    assert_typescript_green(snapshot, &repo_root().join("examples/medium"));
}

pub fn assert_typescript_green(snapshot: &GraphSnapshot, corpus_root: &Path) {
    let target_root = repo_root().join("target");
    fs::create_dir_all(&target_root).unwrap();
    let rendered = tempdir_in(&target_root).unwrap();
    fs::copy(
        corpus_root.join("tsconfig.json"),
        rendered.path().join("tsconfig.json"),
    )
    .unwrap();

    for module in snapshot.nodes.iter().filter(|node| node.kind == "Module") {
        let relative = Path::new(&module.payload)
            .strip_prefix(corpus_root)
            .unwrap_or_else(|_| panic!("module is outside projected corpus: {}", module.payload));
        let output_path = rendered.path().join(relative);
        fs::create_dir_all(output_path.parent().unwrap()).unwrap();
        let mut children = snapshot
            .nodes
            .iter()
            .filter(|node| {
                node.parent_id.as_deref() == Some(module.id.as_str()) && node.kind != "Identifier"
            })
            .collect::<Vec<_>>();
        children.sort_by_key(|node| node.child_index);
        let source = children
            .into_iter()
            .map(|node| node.payload.as_str())
            .collect::<String>();
        fs::write(output_path, source).unwrap();
    }

    let output = Command::new(repo_root().join("node_modules/.bin/tsc"))
        .args(["--noEmit", "--project"])
        .arg(rendered.path().join("tsconfig.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "projected TypeScript validation failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub struct LocalizedAddParameterFixture {
    pub corpus_root: PathBuf,
    pub g0: GraphSnapshot,
    pub g1: GraphSnapshot,
    pub greet_id: String,
    pub new_callsite_id: String,
    pub worker_config: NodeBridgeConfig,
    pub request_counts: PathBuf,
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub struct LocalizedOnlyGreenTogetherFixture {
    pub corpus_root: PathBuf,
    pub g0: GraphSnapshot,
    pub user_id: String,
    pub greet_id: String,
    pub new_callsite_id: String,
    pub worker_config: NodeBridgeConfig,
    pub request_counts: PathBuf,
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub struct ClassifiedWorkerExchange {
    pub request: serde_json::Value,
    pub response: serde_json::Value,
}

/// Builds the mechanically ingested G/G+1 fixture used to exercise dynamic expansion.
///
/// This support exists only when both test features are enabled. The returned G+1 snapshot may
/// be injected only by `inject_validated_add_parameter_g1`; no `ClientActor` method exposes that
/// raw publication path.
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn localized_add_parameter_fixture(directory: &Path) -> LocalizedAddParameterFixture {
    let corpus_root = directory.join("medium");
    copy_add_parameter_corpus(&corpus_root);
    let g0 = localized_source_projection(portable_medium_snapshot(), &corpus_root);
    let portable_g1: GraphSnapshot = serde_json::from_str(ADD_PARAMETER_G1_SNAPSHOT_JSON).unwrap();
    let g1 = localized_source_projection(portable_g1, &corpus_root);
    let greet_id = g1
        .nodes
        .iter()
        .find(|node| node.kind == "FunctionDeclaration" && node.payload.contains("function greet("))
        .expect("G+1 greet declaration")
        .id
        .clone();
    let new_callsite_id = g1
        .nodes
        .iter()
        .find(|node| node.payload.contains("kernelBridgeGreeting = greet("))
        .expect("G+1 callsite")
        .id
        .clone();
    let (worker_config, request_counts) = classified_worker_config(directory, &corpus_root);
    LocalizedAddParameterFixture {
        corpus_root,
        g0,
        g1,
        greet_id,
        new_callsite_id,
        worker_config,
        request_counts,
    }
}

/// Builds the row-10 source projection from a fresh localized ingest.
///
/// The deterministic extra callsite is part of the initial source here. Its mechanically ingested
/// G+1 fixture is deliberately normalized to generation zero so the two accepted intents are the
/// only canonical publication exercised by the acceptance scenario.
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn localized_only_green_together_fixture(
    directory: &Path,
) -> LocalizedOnlyGreenTogetherFixture {
    let LocalizedAddParameterFixture {
        corpus_root,
        g0: _,
        mut g1,
        greet_id,
        new_callsite_id,
        worker_config,
        request_counts,
    } = localized_add_parameter_fixture(directory);
    g1.generation = 0;
    assert_eq!(g1.nodes.len(), 1_212, "localized row-10 node count");
    assert_eq!(g1.references.len(), 594, "localized row-10 reference count");

    let user_id = g1
        .nodes
        .iter()
        .find(|node| {
            node.kind == "InterfaceDeclaration" && node.payload.contains("export interface User {")
        })
        .expect("localized row-10 User declaration")
        .id
        .clone();
    for (label, id) in [
        ("User", &user_id),
        ("greet", &greet_id),
        ("deterministic callsite", &new_callsite_id),
    ] {
        assert!(
            g1.nodes.iter().any(|node| &node.id == id),
            "localized row-10 {label} ID must exist"
        );
    }
    assert_eq!(
        BTreeSet::from([
            user_id.as_str(),
            greet_id.as_str(),
            new_callsite_id.as_str(),
        ])
        .len(),
        3,
        "row-10 target IDs must be distinct"
    );

    LocalizedOnlyGreenTogetherFixture {
        corpus_root,
        g0: g1,
        user_id,
        greet_id,
        new_callsite_id,
        worker_config,
        request_counts,
    }
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn classified_request_count(prefix: &Path, kind: &str) -> usize {
    fs::read_to_string(format!("{}.{}", prefix.display(), kind))
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn classified_worker_exchange(prefix: &Path, kind: &str) -> ClassifiedWorkerExchange {
    let request_path = format!("{}.{}.last-request", prefix.display(), kind);
    let response_path = format!("{}.{}.last-response", prefix.display(), kind);
    ClassifiedWorkerExchange {
        request: serde_json::from_slice(&fs::read(&request_path).unwrap_or_else(|error| {
            panic!("read classified worker request {request_path}: {error}")
        }))
        .unwrap_or_else(|error| panic!("parse classified worker request {request_path}: {error}")),
        response: serde_json::from_slice(&fs::read(&response_path).unwrap_or_else(|error| {
            panic!("read classified worker response {response_path}: {error}")
        }))
        .unwrap_or_else(|error| {
            panic!("parse classified worker response {response_path}: {error}")
        }),
    }
}

/// Publishes the validated ingest-derived G+1 fixture through the raw redb spike surface.
///
/// This is deliberately combined-feature-gated test setup. It is not callable through
/// `ClientActor` and is not evidence of a client canonical-storage path.
#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
pub fn inject_validated_add_parameter_g1(kernel: &Kernel, g0: &GraphSnapshot, g1: &GraphSnapshot) {
    let delta = add_parameter_fixture_delta(g0, g1);
    let fence = kernel
        .issue_fence(&["fixture:add-parameter-g1".into()])
        .unwrap();
    let report = kernel
        .publish(Publication {
            schema_version: SCHEMA_VERSION,
            idempotency_key: "fixture:add-parameter-g1".into(),
            operation: RawOperationRecord {
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
                intents: Vec::new(),
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

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn copy_add_parameter_corpus(corpus_root: &Path) {
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
        "import { greet } from \"./users/greet.ts\";\n\
\n\
export const kernelBridgeGreeting = greet({\n\
  id: \"kernel-bridge\",\n\
  email: \"bridge@example.test\"\n\
});\n",
    )
    .unwrap();
}

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn classified_worker_config(directory: &Path, corpus_root: &Path) -> (NodeBridgeConfig, PathBuf) {
    let wrapper = directory.join("count-node-request-kinds.sh");
    let counter_prefix = directory.join("node-request-count");
    fs::write(
        &wrapper,
        r#"input=$(mktemp)
output=$(mktemp)
cat > "$input"
kind=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).kind)' "$input")
counter="$1.$kind"
count=$(cat "$counter" 2>/dev/null || printf 0)
printf '%s\n' "$((count + 1))" > "$counter"
cp "$input" "$1.$kind.last-request"
node "$2" < "$input" > "$output"
status=$?
cp "$output" "$1.$kind.last-response"
cat "$output"
rm -f "$input" "$output"
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

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn localized_source_projection(snapshot: GraphSnapshot, corpus_root: &Path) -> GraphSnapshot {
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

#[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
fn add_parameter_fixture_delta(g0: &GraphSnapshot, g1: &GraphSnapshot) -> GraphDelta {
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
