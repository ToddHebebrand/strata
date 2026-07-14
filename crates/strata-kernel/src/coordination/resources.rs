use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;

use crate::{GraphChange, GraphDelta, GraphGeneration, NodeRecord};

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

fn add_parent_bucket(keys: &mut BTreeSet<String>, node: &NodeRecord) {
    let parent = node.parent_id.as_deref().unwrap_or("root");
    keys.insert(format!("children:{parent}"));
}
