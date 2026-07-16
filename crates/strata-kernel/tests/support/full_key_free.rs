use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strata_kernel::{
    BeginChangeSet, ChangeSetRecord, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationTicket, EventCursor, GraphSnapshot, IntentParameters, IntentRecord, Kernel,
    NodeBridgeConfig, NodeRecord, OperationRecord, PublishClaimOutcome, ReadyOffer, RecoveryReport,
    ReferenceRecord, SubmissionOutcome,
};
use tempfile::tempdir_in;

const SNAPSHOT_JSON: &str = include_str!("../fixtures/examples-medium.snapshot.json");
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

    pub fn event_client_id(&self) -> &str {
        &self.event_client_id
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

    pub fn resume_event_cursor(&mut self, kernel: &Kernel) -> Result<EventCursor> {
        self.acknowledge_events(kernel, self.acknowledged_event_sequence)
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
    let target_root = repo_root().join("target");
    fs::create_dir_all(&target_root).unwrap();
    let rendered = tempdir_in(&target_root).unwrap();
    fs::copy(
        repo_root().join("examples/medium/tsconfig.json"),
        rendered.path().join("tsconfig.json"),
    )
    .unwrap();

    let corpus_root = repo_root().join("examples/medium");
    for module in snapshot.nodes.iter().filter(|node| node.kind == "Module") {
        let relative = Path::new(&module.payload)
            .strip_prefix(&corpus_root)
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
