use crate::{GraphChange, GraphDelta, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION};
use anyhow::{Result, bail};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

#[derive(Clone, Debug)]
pub struct GraphGeneration {
    generation: u64,
    nodes: BTreeMap<String, NodeRecord>,
    references_from: BTreeMap<String, ReferenceRecord>,
    references_to: BTreeMap<String, BTreeSet<ReferenceRecord>>,
    /// parent node id → child node ids (sorted by id, since they are inserted
    /// in `nodes`' BTreeMap iteration order). Built once per generation so
    /// membership queries never materialize a full snapshot (the measured
    /// O(R·N) gate-3 scope-build cost; plan 2026-07-23, Task 1).
    children_of: BTreeMap<String, Vec<String>>,
    digest: String,
}

impl GraphGeneration {
    pub fn from_snapshot(snapshot: GraphSnapshot) -> Result<Self> {
        if snapshot.schema_version != SCHEMA_VERSION {
            bail!(
                "unsupported graph schema {}, expected {}",
                snapshot.schema_version,
                SCHEMA_VERSION
            );
        }

        let mut nodes = BTreeMap::new();
        for node in snapshot.nodes {
            let node_id = node.id.clone();
            if nodes.insert(node_id.clone(), node).is_some() {
                bail!("duplicate node ID {node_id}");
            }
        }

        let mut references_from = BTreeMap::new();
        for reference in snapshot.references {
            let from_node_id = reference.from_node_id.clone();
            if references_from
                .insert(from_node_id.clone(), reference)
                .is_some()
            {
                bail!("duplicate reference from node ID {from_node_id}");
            }
        }

        Self::build(snapshot.generation, nodes, references_from)
    }

    pub fn apply(&self, delta: &GraphDelta) -> Result<Self> {
        if delta.schema_version != SCHEMA_VERSION {
            bail!(
                "unsupported graph schema {}, expected {}",
                delta.schema_version,
                SCHEMA_VERSION
            );
        }
        if delta.base_generation != self.generation {
            bail!(
                "base generation {} does not match current generation {}",
                delta.base_generation,
                self.generation
            );
        }

        let mut nodes = self.nodes.clone();
        let mut references_from = self.references_from.clone();
        for change in &delta.changes {
            match change {
                GraphChange::UpsertNode { node } => {
                    nodes.insert(node.id.clone(), node.clone());
                }
                GraphChange::DeleteNode { node_id } => {
                    nodes.remove(node_id);
                }
                GraphChange::UpsertReference { reference } => {
                    references_from.insert(reference.from_node_id.clone(), reference.clone());
                }
                GraphChange::DeleteReference { from_node_id } => {
                    references_from.remove(from_node_id);
                }
            }
        }

        let generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("graph generation overflow"))?;
        Self::build(generation, nodes, references_from)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn snapshot(&self) -> GraphSnapshot {
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: self.generation,
            nodes: self.nodes.values().cloned().collect(),
            references: self.references_from.values().cloned().collect(),
        }
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn node(&self, node_id: &str) -> Option<&NodeRecord> {
        self.nodes.get(node_id)
    }

    pub fn reference_from(&self, from_node_id: &str) -> Option<&ReferenceRecord> {
        self.references_from.get(from_node_id)
    }

    pub fn references_to(&self, node_id: &str) -> impl Iterator<Item = &ReferenceRecord> {
        self.references_to.get(node_id).into_iter().flatten()
    }

    /// A node's immediate children (index-backed, sorted by child id), without
    /// materializing any snapshot.
    pub fn children_of(&self, parent_id: &str) -> impl Iterator<Item = &NodeRecord> {
        self.children_of
            .get(parent_id)
            .into_iter()
            .flatten()
            .map(|child_id| {
                self.nodes
                    .get(child_id)
                    .expect("children_of index references a node absent from the graph")
            })
    }

    /// Returns an explicitly bounded projection of a node's immediate children.
    ///
    /// This intentionally does not expose or materialize the full graph snapshot.
    pub fn children_bounded(&self, parent_id: &str, limit: usize) -> Result<Vec<&NodeRecord>> {
        if limit == 0 {
            bail!("child projection limit must be positive");
        }
        let mut children = self.children_of(parent_id).take(limit + 1).collect::<Vec<_>>();
        if children.len() > limit {
            bail!("immediate child projection exceeds {limit} item bound");
        }
        children.sort_by_key(|node| node.child_index);
        Ok(children)
    }

    fn build(
        generation: u64,
        nodes: BTreeMap<String, NodeRecord>,
        references_from: BTreeMap<String, ReferenceRecord>,
    ) -> Result<Self> {
        let mut references_to: BTreeMap<String, BTreeSet<ReferenceRecord>> = BTreeMap::new();
        for reference in references_from.values() {
            if !nodes.contains_key(&reference.from_node_id) {
                bail!(
                    "reference from {} has missing endpoint {}",
                    reference.from_node_id,
                    reference.from_node_id
                );
            }
            if !nodes.contains_key(&reference.to_node_id) {
                bail!(
                    "reference from {} has missing endpoint {}",
                    reference.from_node_id,
                    reference.to_node_id
                );
            }
            references_to
                .entry(reference.to_node_id.clone())
                .or_default()
                .insert(reference.clone());
        }

        // BTreeMap iteration is id-ordered, so each child list is sorted by id.
        let mut children_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for node in nodes.values() {
            if let Some(parent_id) = node.parent_id.as_deref() {
                children_of
                    .entry(parent_id.to_owned())
                    .or_default()
                    .push(node.id.clone());
            }
        }

        let mut graph = Self {
            generation,
            nodes,
            references_from,
            references_to,
            children_of,
            digest: String::new(),
        };
        let encoded = serde_json::to_vec(&graph.snapshot())?;
        let hash = Sha256::digest(encoded);
        let mut digest = String::with_capacity(hash.len() * 2);
        for byte in hash {
            write!(&mut digest, "{byte:02x}").expect("writing to a String cannot fail");
        }
        graph.digest = digest;
        Ok(graph)
    }
}
