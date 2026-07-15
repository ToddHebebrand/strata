use super::{
    DynamicExpansionPolicy, IdempotencyClass, InferredScope, IntentRecord, ResourceVersion,
    SemanticProvider,
};
use crate::{GraphChange, GraphDelta, GraphGeneration};
use anyhow::{Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentAnalysis {
    pub read_set: Vec<ResourceVersion>,
    pub write_set: Vec<ResourceVersion>,
    pub validation_set: Vec<ResourceVersion>,
    pub reservation_keys: Vec<String>,
    pub dynamic_expansion_policy: DynamicExpansionPolicy,
    pub idempotency_class: IdempotencyClass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeChange {
    Unchanged,
    Expanded,
    MateriallyChanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeltaAuthority {
    pub write_resources: Vec<String>,
    pub reservation_coverage: Vec<String>,
}

pub(crate) fn analyze_change_set(
    graph: &GraphGeneration,
    intents: &[IntentRecord],
    provider: &dyn SemanticProvider,
) -> Result<InferredScope> {
    if intents.is_empty() {
        bail!("change-set analysis requires at least one intent");
    }

    let mut read_set = Vec::new();
    let mut write_set = Vec::new();
    let mut validation_set = Vec::new();
    let mut reservation_keys = Vec::new();
    let mut dynamic_expansion_policy = None;
    let mut idempotency_class = IdempotencyClass::ReplaySafe;

    for intent in intents {
        let analysis = provider.analyze(graph, intent)?;
        read_set.extend(analysis.read_set);
        write_set.extend(analysis.write_set);
        validation_set.extend(analysis.validation_set);
        reservation_keys.extend(analysis.reservation_keys);
        dynamic_expansion_policy = Some(strictest_policy(
            dynamic_expansion_policy,
            analysis.dynamic_expansion_policy,
        ));
        if analysis.idempotency_class == IdempotencyClass::RequiresDecision {
            idempotency_class = IdempotencyClass::RequiresDecision;
        }
    }

    canonicalize_resources(&mut read_set);
    canonicalize_resources(&mut write_set);
    canonicalize_resources(&mut validation_set);
    reservation_keys.sort();
    reservation_keys.dedup();

    let mut scope = InferredScope {
        read_set,
        write_set,
        validation_set,
        reservation_keys,
        scope_fingerprint: String::new(),
        dynamic_expansion_policy: dynamic_expansion_policy
            .expect("non-empty intents always produce a policy"),
        idempotency_class,
    };
    scope.scope_fingerprint = canonical_scope_fingerprint(&scope)?;
    Ok(scope)
}

pub fn canonical_scope_fingerprint(scope: &InferredScope) -> Result<String> {
    let mut read_set = scope.read_set.clone();
    let mut write_set = scope.write_set.clone();
    let mut validation_set = scope.validation_set.clone();
    let mut reservation_keys = scope.reservation_keys.clone();
    canonicalize_resources(&mut read_set);
    canonicalize_resources(&mut write_set);
    canonicalize_resources(&mut validation_set);
    reservation_keys.sort();
    reservation_keys.dedup();

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CanonicalScope<'a> {
        read_set: &'a [ResourceVersion],
        write_set: &'a [ResourceVersion],
        validation_set: &'a [ResourceVersion],
        reservation_keys: &'a [String],
        dynamic_expansion_policy: &'a DynamicExpansionPolicy,
        idempotency_class: &'a IdempotencyClass,
    }

    let encoded = serde_json::to_vec(&CanonicalScope {
        read_set: &read_set,
        write_set: &write_set,
        validation_set: &validation_set,
        reservation_keys: &reservation_keys,
        dynamic_expansion_policy: &scope.dynamic_expansion_policy,
        idempotency_class: &scope.idempotency_class,
    })?;
    let hash = Sha256::digest(encoded);
    let mut fingerprint = String::with_capacity(hash.len() * 2);
    for byte in hash {
        write!(&mut fingerprint, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(fingerprint)
}

pub fn classify_scope_change(old: &InferredScope, new: &InferredScope) -> ScopeChange {
    if old.scope_fingerprint == new.scope_fingerprint {
        return ScopeChange::Unchanged;
    }

    let old_read = canonical_resources(&old.read_set);
    let new_read = canonical_resources(&new.read_set);
    let old_write = canonical_resources(&old.write_set);
    let new_write = canonical_resources(&new.write_set);
    let old_validation = canonical_resources(&old.validation_set);
    let new_validation = canonical_resources(&new.validation_set);
    let old_reservations: BTreeSet<_> = old.reservation_keys.iter().collect();
    let new_reservations: BTreeSet<_> = new.reservation_keys.iter().collect();

    let all_old_entries_remain = old_read.is_subset(&new_read)
        && old_write.is_subset(&new_write)
        && old_validation.is_subset(&new_validation)
        && old_reservations.is_subset(&new_reservations);
    let adds_scope = old_read != new_read
        || old_write != new_write
        || old_validation != new_validation
        || old_reservations != new_reservations;

    let governance_unchanged = old.dynamic_expansion_policy == new.dynamic_expansion_policy
        && old.idempotency_class == new.idempotency_class;

    if all_old_entries_remain && adds_scope && governance_unchanged {
        ScopeChange::Expanded
    } else {
        ScopeChange::MateriallyChanged
    }
}

pub fn required_delta_authority(
    current: &GraphGeneration,
    delta: &GraphDelta,
) -> Result<DeltaAuthority> {
    let snapshot = current.snapshot();
    let references: BTreeMap<_, _> = snapshot
        .references
        .into_iter()
        .map(|reference| (reference.from_node_id.clone(), reference))
        .collect();
    let mut write_resources = BTreeSet::new();
    let mut reservation_coverage = BTreeSet::new();

    for change in &delta.changes {
        match change {
            GraphChange::UpsertNode { node } => {
                add_node_write(&mut write_resources, &mut reservation_coverage, &node.id);
                if let Some(parent_id) = current
                    .node(&node.id)
                    .and_then(|old_node| old_node.parent_id.as_deref())
                {
                    reservation_coverage.insert(node_key(parent_id));
                }
                if let Some(parent_id) = &node.parent_id {
                    reservation_coverage.insert(node_key(parent_id));
                }
            }
            GraphChange::DeleteNode { node_id } => {
                add_node_write(&mut write_resources, &mut reservation_coverage, node_id);
                if let Some(parent_id) = current
                    .node(node_id)
                    .and_then(|old_node| old_node.parent_id.as_deref())
                {
                    reservation_coverage.insert(node_key(parent_id));
                }
            }
            GraphChange::UpsertReference { reference } => {
                write_resources.insert(edge_key(&reference.from_node_id));
                reservation_coverage.insert(node_key(&reference.from_node_id));
                reservation_coverage.insert(node_key(&reference.to_node_id));
                if let Some(old_reference) = references.get(&reference.from_node_id) {
                    reservation_coverage.insert(node_key(&old_reference.from_node_id));
                    reservation_coverage.insert(node_key(&old_reference.to_node_id));
                }
            }
            GraphChange::DeleteReference { from_node_id } => {
                write_resources.insert(edge_key(from_node_id));
                reservation_coverage.insert(node_key(from_node_id));
                if let Some(old_reference) = references.get(from_node_id) {
                    reservation_coverage.insert(node_key(&old_reference.from_node_id));
                    reservation_coverage.insert(node_key(&old_reference.to_node_id));
                }
            }
        }
    }

    Ok(DeltaAuthority {
        write_resources: write_resources.into_iter().collect(),
        reservation_coverage: reservation_coverage.into_iter().collect(),
    })
}

pub fn validate_delta_containment(
    current: &GraphGeneration,
    delta: &GraphDelta,
    scope: &InferredScope,
) -> Result<()> {
    let required = required_delta_authority(current, delta)?;
    let allowed_writes: BTreeSet<_> = scope
        .write_set
        .iter()
        .map(|resource| resource.resource_key.as_str())
        .collect();
    let allowed_reservations: BTreeSet<_> =
        scope.reservation_keys.iter().map(String::as_str).collect();

    let missing_writes: Vec<_> = required
        .write_resources
        .iter()
        .filter(|resource| !allowed_writes.contains(resource.as_str()))
        .cloned()
        .collect();
    let missing_reservations: Vec<_> = required
        .reservation_coverage
        .iter()
        .filter(|resource| !allowed_reservations.contains(resource.as_str()))
        .cloned()
        .collect();

    if !missing_writes.is_empty() || !missing_reservations.is_empty() {
        bail!(
            "graph delta exceeds inferred scope: missing write resources {missing_writes:?}; missing reservation coverage {missing_reservations:?}"
        );
    }
    Ok(())
}

fn strictest_policy(
    current: Option<DynamicExpansionPolicy>,
    next: DynamicExpansionPolicy,
) -> DynamicExpansionPolicy {
    match (current, next) {
        (Some(DynamicExpansionPolicy::NeedsDecision), _)
        | (_, DynamicExpansionPolicy::NeedsDecision) => DynamicExpansionPolicy::NeedsDecision,
        (
            Some(DynamicExpansionPolicy::Requeue {
                max_expansions: current,
            }),
            DynamicExpansionPolicy::Requeue {
                max_expansions: next,
            },
        ) => DynamicExpansionPolicy::Requeue {
            max_expansions: current.min(next),
        },
        (None, policy) => policy,
    }
}

fn canonicalize_resources(resources: &mut Vec<ResourceVersion>) {
    resources.sort_by(|left, right| {
        (&left.resource_key, &left.version).cmp(&(&right.resource_key, &right.version))
    });
    resources.dedup();
}

fn canonical_resources(resources: &[ResourceVersion]) -> BTreeSet<(String, String)> {
    resources
        .iter()
        .map(|resource| (resource.resource_key.clone(), resource.version.clone()))
        .collect()
}

fn add_node_write(writes: &mut BTreeSet<String>, coverage: &mut BTreeSet<String>, node_id: &str) {
    let key = node_key(node_id);
    writes.insert(key.clone());
    coverage.insert(key);
}

fn node_key(node_id: &str) -> String {
    format!("node:{node_id}")
}

fn edge_key(from_node_id: &str) -> String {
    format!("edge:{from_node_id}")
}
