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
    // Index-backed (plan 2026-07-23 Task 1): clones only the children's own
    // id/kind, never the full graph. The members list, its sort, and the hash
    // input are byte-identical to the previous snapshot-clone implementation
    // (equivalence-gated in this module's tests).
    let mut members: Vec<(String, String, Option<i64>)> = graph
        .children_of(parent_id)
        .map(|node| (node.id.clone(), node.kind.clone(), node.child_index))
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

    use super::{affected_resource_keys, children_resource, membership_resource, references_to_resource};
    use super::ResourceVersion;
    use crate::{
        GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord,
        SCHEMA_VERSION,
    };

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

    // ---- Task 1 equivalence gate (plan 2026-07-23-bridge-persistence-slice) ----
    //
    // The pre-Task-1 `children_resource` cloned the FULL graph snapshot per
    // call (the measured O(R·N) gate-3 cost). These reference copies preserve
    // that exact old computation so the index-backed implementation is proven
    // byte-identical on every resource-version string — synthetic hostile
    // shapes, the real medium-corpus fixture, and post-`apply` states.

    fn children_resource_reference(graph: &GraphGeneration, parent_id: &str) -> ResourceVersion {
        let mut members: Vec<(String, String, Option<i64>)> = graph
            .snapshot()
            .nodes
            .into_iter()
            .filter(|node| node.parent_id.as_deref() == Some(parent_id))
            .map(|node| (node.id, node.kind, node.child_index))
            .collect();
        members.sort();
        membership_resource(format!("children:{parent_id}"), &members).unwrap()
    }

    fn references_to_resource_reference(graph: &GraphGeneration, target_id: &str) -> ResourceVersion {
        let mut members: Vec<ReferenceRecord> = graph
            .snapshot()
            .references
            .into_iter()
            .filter(|reference| reference.to_node_id == target_id)
            .collect();
        members.sort();
        membership_resource(format!("references-to:{target_id}"), &members).unwrap()
    }

    /// Every node id (plus "root" and a nonexistent parent) as a membership
    /// parent, and every node id as a references-to target.
    fn assert_full_equivalence(graph: &GraphGeneration, label: &str) {
        let snapshot = graph.snapshot();
        let mut parents: Vec<String> = snapshot.nodes.iter().map(|node| node.id.clone()).collect();
        parents.push("root".into());
        parents.push("no-such-parent".into());
        for parent in &parents {
            assert_eq!(
                children_resource(graph, parent).unwrap(),
                children_resource_reference(graph, parent),
                "{label}: children:{parent} diverged from the snapshot-clone reference"
            );
        }
        for node in &snapshot.nodes {
            assert_eq!(
                references_to_resource(graph, &node.id).unwrap(),
                references_to_resource_reference(graph, &node.id),
                "{label}: references-to:{} diverged from the snapshot-clone reference",
                node.id
            );
        }
    }

    fn raw_node(
        id: &str,
        kind: &str,
        parent_id: Option<&str>,
        child_index: Option<i64>,
    ) -> NodeRecord {
        NodeRecord {
            id: id.into(),
            kind: kind.into(),
            parent_id: parent_id.map(str::to_owned),
            child_index,
            payload: format!("payload:{id}:\u{2028}\"esc\\ape\""),
        }
    }

    /// ≥3 parents with ≥5 children each, equal child_index collisions, None
    /// child_index, non-ASCII identifiers, a parentless orphan, and a
    /// zero-children parent.
    fn hostile_snapshot() -> GraphSnapshot {
        let mut nodes = vec![
            raw_node("module", "Module", None, Some(0)),
            raw_node("モジュール", "Module", None, Some(1)),
            raw_node("parent-β", "ClassDeclaration", Some("module"), Some(0)),
            raw_node("empty-parent", "ClassDeclaration", Some("module"), Some(1)),
            raw_node("orphan", "FunctionDeclaration", None, None),
        ];
        for index in 0..6i64 {
            nodes.push(raw_node(
                &format!("m-child-{index}"),
                "FunctionDeclaration",
                Some("module"),
                Some(index / 2), // equal child_index collisions
            ));
            nodes.push(raw_node(
                &format!("う-child-{index}"),
                "FunctionDeclaration",
                Some("モジュール"),
                if index == 5 { None } else { Some(index) },
            ));
            nodes.push(raw_node(
                &format!("β-child-{index}"),
                "PropertyDeclaration",
                Some("parent-β"),
                Some(0),
            ));
        }
        let references = vec![
            ReferenceRecord {
                from_node_id: "m-child-0".into(),
                to_node_id: "parent-β".into(),
                kind: "identifier".into(),
            },
            ReferenceRecord {
                from_node_id: "m-child-1".into(),
                to_node_id: "parent-β".into(),
                kind: "identifier".into(),
            },
            ReferenceRecord {
                from_node_id: "う-child-2".into(),
                to_node_id: "orphan".into(),
                kind: "identifier".into(),
            },
        ];
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes,
            references,
        }
    }

    #[test]
    fn children_of_index_matches_filter_scan() {
        let graph = GraphGeneration::from_snapshot(hostile_snapshot()).unwrap();
        let ids: Vec<&str> = graph.children_of("module").map(|node| node.id.as_str()).collect();
        let mut expected: Vec<&str> = vec![
            "parent-β",
            "empty-parent",
            "m-child-0",
            "m-child-1",
            "m-child-2",
            "m-child-3",
            "m-child-4",
            "m-child-5",
        ];
        expected.sort();
        assert_eq!(ids, expected, "children_of must return all children sorted by id");
        assert_eq!(graph.children_of("empty-parent").count(), 0);
        assert_eq!(graph.children_of("no-such-parent").count(), 0);
        assert_eq!(graph.children_of("orphan").count(), 0);
    }

    #[test]
    fn equivalence_on_hostile_synthetic_graph() {
        let graph = GraphGeneration::from_snapshot(hostile_snapshot()).unwrap();
        assert_full_equivalence(&graph, "hostile");
    }

    #[test]
    fn equivalence_on_post_apply_state() {
        let graph = GraphGeneration::from_snapshot(hostile_snapshot()).unwrap();
        let mut moved = graph.node("m-child-3").unwrap().clone();
        moved.parent_id = Some("モジュール".into());
        moved.child_index = Some(9);
        let next = graph
            .apply(&GraphDelta {
                schema_version: SCHEMA_VERSION,
                base_generation: 0,
                changes: vec![
                    GraphChange::UpsertNode { node: moved },
                    GraphChange::UpsertNode {
                        node: raw_node("new-child", "FunctionDeclaration", Some("empty-parent"), Some(0)),
                    },
                    GraphChange::DeleteNode {
                        node_id: "β-child-5".into(),
                    },
                    GraphChange::UpsertReference {
                        reference: ReferenceRecord {
                            from_node_id: "new-child".into(),
                            to_node_id: "module".into(),
                            kind: "identifier".into(),
                        },
                    },
                    GraphChange::DeleteReference {
                        from_node_id: "う-child-2".into(),
                    },
                ],
            })
            .unwrap();
        assert_full_equivalence(&next, "post-apply");
    }

    #[test]
    fn equivalence_on_medium_corpus_fixture() {
        let raw = include_str!("../../tests/fixtures/medium-graph-snapshot.json");
        let snapshot: GraphSnapshot = serde_json::from_str(raw).unwrap();
        let graph = GraphGeneration::from_snapshot(snapshot).unwrap();
        assert_full_equivalence(&graph, "medium-fixture");

        // Post-apply on the real corpus: payload-only edit + a child_index
        // move + a fresh parentless node (reference-safe changes only).
        let some_parented = graph
            .snapshot()
            .nodes
            .into_iter()
            .find(|node| node.parent_id.is_some())
            .unwrap();
        let mut payload_edit = some_parented.clone();
        payload_edit.payload.push_str("\n// equivalence probe");
        let mut moved = some_parented.clone();
        moved.child_index = Some(moved.child_index.unwrap_or(0) + 1000);
        let next = graph
            .apply(&GraphDelta {
                schema_version: SCHEMA_VERSION,
                base_generation: 0,
                changes: vec![
                    GraphChange::UpsertNode { node: payload_edit },
                    GraphChange::UpsertNode { node: moved },
                    GraphChange::UpsertNode {
                        node: raw_node("equivalence-probe", "Module", None, None),
                    },
                ],
            })
            .unwrap();
        assert_full_equivalence(&next, "medium-fixture-post-apply");
    }

    /// big1k-scale spot check (sampled parents; the full cross-product against
    /// the O(N) reference would be quadratic). `--ignored` only.
    #[test]
    #[ignore = "big1k-scale spot check; run explicitly with --ignored"]
    fn equivalence_sampled_at_big1k_scale() {
        let mut nodes = Vec::new();
        for module in 0..1012 {
            let module_id = format!("module-{module:04}");
            nodes.push(raw_node(&module_id, "Module", None, Some(0)));
            for child in 0..20i64 {
                nodes.push(raw_node(
                    &format!("{module_id}/stmt-{child:02}"),
                    "Statement",
                    Some(&module_id),
                    Some(child % 7),
                ));
            }
        }
        let graph = GraphGeneration::from_snapshot(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes,
            references: vec![],
        })
        .unwrap();
        for module in (0..1012).step_by(11) {
            let parent = format!("module-{module:04}");
            assert_eq!(
                children_resource(&graph, &parent).unwrap(),
                children_resource_reference(&graph, &parent),
                "big1k-scale: children:{parent}"
            );
        }
    }
}
