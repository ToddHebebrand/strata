use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{GraphChange, GraphDelta, GraphGeneration, NodeRecord, ReferenceRecord};

use super::ResourceVersion;

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVersion {
    pub resource_key: String,
    pub clock: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ResourceClockSnapshot {
    clocks: BTreeMap<String, u64>,
}

impl ResourceClockSnapshot {
    pub(crate) fn from_clocks(clocks: BTreeMap<String, u64>) -> Self {
        Self { clocks }
    }

    pub(crate) fn clock(&self, key: &str) -> u64 {
        self.clocks.get(key).copied().unwrap_or(0)
    }

    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn all(&self) -> BTreeMap<String, u64> {
        self.clocks.clone()
    }

    pub(crate) fn dependencies(&self, keys: &BTreeSet<String>) -> Vec<DependencyVersion> {
        keys.iter()
            .map(|key| DependencyVersion {
                resource_key: key.clone(),
                clock: self.clock(key),
            })
            .collect()
    }

    #[allow(dead_code)]
    pub(crate) fn matches(&self, dependencies: &[DependencyVersion]) -> bool {
        dependencies
            .iter()
            .all(|dependency| self.clock(&dependency.resource_key) == dependency.clock)
    }

    pub(crate) fn apply(&self, updates: &BTreeMap<String, u64>) -> Self {
        let mut next = self.clone();
        next.clocks.extend(updates.clone());
        next
    }
}

#[allow(dead_code)] // Production candidate publication consumes this in Task 8.
pub fn affected_resource_keys(
    graph: &GraphGeneration,
    delta: &GraphDelta,
    semantic_index_keys: &BTreeSet<String>,
) -> Result<BTreeSet<String>> {
    let mut keys = BTreeSet::new();
    for change in &delta.changes {
        match change {
            GraphChange::UpsertNode { node } => {
                keys.insert(format!("node:{}", node.id));
                if !payload_only_upsert(graph, node) {
                    if let Some(old) = graph.node(&node.id) {
                        add_parent_bucket(&mut keys, old);
                    }
                    add_parent_bucket(&mut keys, node);
                }
            }
            GraphChange::DeleteNode { node_id } => {
                keys.insert(format!("node:{node_id}"));
                if let Some(old) = graph.node(node_id) {
                    add_parent_bucket(&mut keys, old);
                }
            }
            GraphChange::UpsertReference { reference } => {
                keys.insert(format!("edge:{}", reference.from_node_id));
                if let Some(old) = graph.reference_from(&reference.from_node_id) {
                    keys.insert(format!("references-to:{}", old.to_node_id));
                }
                keys.insert(format!("references-to:{}", reference.to_node_id));
            }
            GraphChange::DeleteReference { from_node_id } => {
                keys.insert(format!("edge:{from_node_id}"));
                if let Some(old) = graph.reference_from(from_node_id) {
                    keys.insert(format!("references-to:{}", old.to_node_id));
                }
            }
        }
    }
    for key in semantic_index_keys {
        if !key.starts_with("namespace:") && !key.starts_with("absence:") {
            anyhow::bail!("semantic index key has unsupported class: {key}");
        }
        keys.insert(key.clone());
    }
    Ok(keys)
}

#[allow(dead_code)]
fn add_parent_bucket(keys: &mut BTreeSet<String>, node: &NodeRecord) {
    let parent = node.parent_id.as_deref().unwrap_or("root");
    keys.insert(format!("children:{parent}"));
}

/// True when the upsert leaves the node's shape — parent, position, kind —
/// untouched, so sibling membership is provably unaffected.
pub(crate) fn payload_only_upsert(graph: &GraphGeneration, node: &NodeRecord) -> bool {
    graph.node(&node.id).is_some_and(|old| {
        old.parent_id == node.parent_id
            && old.child_index == node.child_index
            && old.kind == node.kind
    })
}

pub(crate) fn node_resource(node: &NodeRecord) -> Result<ResourceVersion> {
    hashed_resource(format!("node:{}", node.id), node)
}

pub(crate) fn edge_resource(reference: &ReferenceRecord) -> Result<ResourceVersion> {
    hashed_resource(format!("edge:{}", reference.from_node_id), reference)
}

/// Membership means sibling *shape* — ids, kinds, and positions — never
/// payloads. Content drift is carried by per-node `node:{id}` resources, so
/// a sibling payload edit must not drift the lists it renders beside
/// (spec: 2026-07-17 validation-circle narrowing, Change 5).
pub(crate) fn children_resource(
    graph: &GraphGeneration,
    parent_id: &str,
) -> Result<ResourceVersion> {
    let mut members: Vec<(String, String, Option<i64>)> = graph
        .snapshot()
        .nodes
        .into_iter()
        .filter(|node| node.parent_id.as_deref() == Some(parent_id))
        .map(|node| (node.id, node.kind, node.child_index))
        .collect();
    members.sort();
    hashed_resource(format!("children:{parent_id}"), &members)
}

pub(crate) fn references_to_resource(
    graph: &GraphGeneration,
    target_id: &str,
) -> Result<ResourceVersion> {
    let members: Vec<_> = graph.references_to(target_id).cloned().collect();
    hashed_resource(format!("references-to:{target_id}"), &members)
}

pub(crate) fn membership_resource<T: Serialize>(
    resource_key: String,
    canonical_members: &[T],
) -> Result<ResourceVersion> {
    hashed_resource(resource_key, canonical_members)
}

fn hashed_resource(key: String, value: &(impl Serialize + ?Sized)) -> Result<ResourceVersion> {
    let digest = Sha256::digest(serde_json::to_vec(value)?);
    ResourceVersion::new(key, format!("{digest:x}")).map_err(anyhow::Error::msg)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{affected_resource_keys, children_resource};
    use crate::{GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, SCHEMA_VERSION};

    fn record(id: &str, kind: &str, parent_id: Option<&str>, child_index: i64) -> NodeRecord {
        NodeRecord {
            id: id.into(),
            kind: kind.into(),
            parent_id: parent_id.map(str::to_owned),
            child_index: Some(child_index),
            payload: format!("payload:{id}"),
        }
    }

    fn graph(nodes: Vec<NodeRecord>) -> GraphGeneration {
        GraphGeneration::from_snapshot(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes,
            references: vec![],
        })
        .unwrap()
    }

    fn base_nodes() -> Vec<NodeRecord> {
        vec![
            record("module", "Module", None, 0),
            record("alpha", "FunctionDeclaration", Some("module"), 0),
            record("beta", "FunctionDeclaration", Some("module"), 1),
        ]
    }

    fn delta(changes: Vec<GraphChange>) -> GraphDelta {
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes,
        }
    }

    #[test]
    fn children_resource_is_payload_insensitive_but_shape_sensitive() {
        let before = graph(base_nodes());
        let mut patched_nodes = base_nodes();
        patched_nodes[1].payload.push_str("\n// sibling payload edit");
        let patched = graph(patched_nodes);
        assert_eq!(
            children_resource(&before, "module").unwrap(),
            children_resource(&patched, "module").unwrap(),
            "a payload-only sibling edit must not drift statement-list membership"
        );

        let mut grown_nodes = base_nodes();
        grown_nodes.push(record("gamma", "FunctionDeclaration", Some("module"), 2));
        let grown = graph(grown_nodes);
        assert_ne!(
            children_resource(&before, "module").unwrap().version,
            children_resource(&grown, "module").unwrap().version,
            "an inserted sibling must drift statement-list membership"
        );
    }

    #[test]
    fn payload_only_upsert_does_not_bump_parent_membership() {
        let before = graph(base_nodes());
        let mut patched = before.node("alpha").unwrap().clone();
        patched.payload.push_str("\n// payload only");
        let keys = affected_resource_keys(
            &before,
            &delta(vec![GraphChange::UpsertNode { node: patched }]),
            &BTreeSet::new(),
        )
        .unwrap();
        assert!(keys.contains("node:alpha"));
        assert!(
            !keys.contains("children:module"),
            "payload-only upsert must not bump the parent membership clock: {keys:?}"
        );
    }

    #[test]
    fn shape_changes_still_bump_parent_membership() {
        let before = graph(base_nodes());

        let inserted = affected_resource_keys(
            &before,
            &delta(vec![GraphChange::UpsertNode {
                node: record("gamma", "FunctionDeclaration", Some("module"), 2),
            }]),
            &BTreeSet::new(),
        )
        .unwrap();
        assert!(inserted.contains("children:module"), "insert: {inserted:?}");

        let mut reindexed = before.node("alpha").unwrap().clone();
        reindexed.child_index = Some(7);
        let moved = affected_resource_keys(
            &before,
            &delta(vec![GraphChange::UpsertNode { node: reindexed }]),
            &BTreeSet::new(),
        )
        .unwrap();
        assert!(moved.contains("children:module"), "reindex: {moved:?}");

        let deleted = affected_resource_keys(
            &before,
            &delta(vec![GraphChange::DeleteNode {
                node_id: "alpha".into(),
            }]),
            &BTreeSet::new(),
        )
        .unwrap();
        assert!(deleted.contains("children:module"), "delete: {deleted:?}");
    }
}
