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
                if let Some(old) = graph.node(&node.id) {
                    add_parent_bucket(&mut keys, old);
                }
                add_parent_bucket(&mut keys, node);
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

pub(crate) fn node_resource(node: &NodeRecord) -> Result<ResourceVersion> {
    hashed_resource(format!("node:{}", node.id), node)
}

pub(crate) fn edge_resource(reference: &ReferenceRecord) -> Result<ResourceVersion> {
    hashed_resource(format!("edge:{}", reference.from_node_id), reference)
}

pub(crate) fn children_resource(
    graph: &GraphGeneration,
    parent_id: &str,
) -> Result<ResourceVersion> {
    let members: Vec<_> = graph
        .snapshot()
        .nodes
        .into_iter()
        .filter(|node| node.parent_id.as_deref() == Some(parent_id))
        .collect();
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
