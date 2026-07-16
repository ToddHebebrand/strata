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
    Contracted,
    MateriallyChanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeltaAuthority {
    pub write_resources: Vec<String>,
    pub reservation_coverage: Vec<String>,
}

pub(crate) fn idempotency_for_intent(parameters: &super::IntentParameters) -> IdempotencyClass {
    match parameters {
        super::IntentParameters::RenameSymbol { .. } => IdempotencyClass::RequiresDecision,
        super::IntentParameters::AddParameter { .. } => IdempotencyClass::ReplaySafe,
    }
}

pub(crate) fn expansion_policy_for_intent(
    _parameters: &super::IntentParameters,
) -> DynamicExpansionPolicy {
    DynamicExpansionPolicy::Requeue { max_expansions: 3 }
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

    let Some(old_read) = resources_by_key(&old.read_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let Some(new_read) = resources_by_key(&new.read_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let Some(old_write) = resources_by_key(&old.write_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let Some(new_write) = resources_by_key(&new.write_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let Some(old_validation) = resources_by_key(&old.validation_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let Some(new_validation) = resources_by_key(&new.validation_set) else {
        return ScopeChange::MateriallyChanged;
    };
    let old_reservations: BTreeSet<_> = old.reservation_keys.iter().collect();
    let new_reservations: BTreeSet<_> = new.reservation_keys.iter().collect();

    let all_old_keys_remain = common_resources_allow_only_membership_drift(&old_read, &new_read)
        && common_resources_allow_only_membership_drift(&old_write, &new_write)
        && common_resources_allow_only_membership_drift(&old_validation, &new_validation)
        && old_reservations.is_subset(&new_reservations);
    let adds_scope_key = old_read.len() < new_read.len()
        || old_write.len() < new_write.len()
        || old_validation.len() < new_validation.len()
        || old_reservations.len() < new_reservations.len();

    let governance_unchanged = old.dynamic_expansion_policy == new.dynamic_expansion_policy
        && old.idempotency_class == new.idempotency_class;
    let reservation_only_contraction = old_read == new_read
        && old_write == new_write
        && old_validation == new_validation
        && new_reservations.is_subset(&old_reservations)
        && new_reservations.len() < old_reservations.len();

    if all_old_keys_remain && adds_scope_key && governance_unchanged {
        ScopeChange::Expanded
    } else if reservation_only_contraction && governance_unchanged {
        ScopeChange::Contracted
    } else {
        ScopeChange::MateriallyChanged
    }
}

fn resources_by_key(resources: &[ResourceVersion]) -> Option<BTreeMap<&str, &str>> {
    let mut by_key = BTreeMap::new();
    for resource in resources {
        if by_key
            .insert(resource.resource_key.as_str(), resource.version.as_str())
            .is_some()
        {
            return None;
        }
    }
    Some(by_key)
}

fn common_resources_allow_only_membership_drift(
    old: &BTreeMap<&str, &str>,
    new: &BTreeMap<&str, &str>,
) -> bool {
    old.iter().all(|(key, old_version)| {
        new.get(key).is_some_and(|new_version| {
            old_version == new_version
                || key.starts_with("children:")
                || key.starts_with("references-to:")
        })
    })
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

    let materialized_children = materialized_identifier_children(current, delta, &allowed_writes);
    let missing_writes: Vec<_> = required
        .write_resources
        .iter()
        .filter(|resource| {
            !allowed_writes.contains(resource.as_str())
                && !materialized_children.contains(resource.as_str())
        })
        .cloned()
        .collect();
    let missing_reservations: Vec<_> = required
        .reservation_coverage
        .iter()
        .filter(|resource| {
            !allowed_reservations.contains(resource.as_str())
                && !materialized_children.contains(resource.as_str())
        })
        .cloned()
        .collect();

    if !missing_writes.is_empty() || !missing_reservations.is_empty() {
        bail!(
            "graph delta exceeds inferred scope: missing write resources {missing_writes:?}; missing reservation coverage {missing_reservations:?}"
        );
    }
    Ok(())
}

fn materialized_identifier_children(
    current: &GraphGeneration,
    delta: &GraphDelta,
    allowed_writes: &BTreeSet<&str>,
) -> BTreeSet<String> {
    let upserted: BTreeMap<_, _> = delta
        .changes
        .iter()
        .filter_map(|change| match change {
            GraphChange::UpsertNode { node } => Some((node.id.as_str(), node)),
            _ => None,
        })
        .collect();
    let mut allowed = BTreeSet::new();

    for change in &delta.changes {
        let candidate = match change {
            GraphChange::UpsertNode { node } => match current.node(&node.id) {
                Some(existing)
                    if existing.kind == "Identifier"
                        && node.kind == "Identifier"
                        && existing.parent_id == node.parent_id
                        && existing.child_index == node.child_index =>
                {
                    Some(existing)
                }
                None if node.kind == "Identifier" => Some(node),
                _ => None,
            },
            GraphChange::DeleteNode { node_id } => current
                .node(node_id)
                .filter(|node| node.kind == "Identifier"),
            GraphChange::UpsertReference { reference } => {
                match current.node(&reference.from_node_id) {
                    Some(existing) => (existing.kind == "Identifier").then_some(existing),
                    None => upserted
                        .get(reference.from_node_id.as_str())
                        .copied()
                        .filter(|node| node.kind == "Identifier"),
                }
            }
            GraphChange::DeleteReference { from_node_id } => current
                .node(from_node_id)
                .filter(|node| node.kind == "Identifier"),
        };
        let Some(identifier) = candidate else {
            continue;
        };
        let Some(parent_id) = identifier.parent_id.as_deref() else {
            continue;
        };
        if current.node(parent_id).is_some_and(is_writable_container)
            && allowed_writes.contains(format!("node:{parent_id}").as_str())
        {
            allowed.insert(format!("node:{}", identifier.id));
            allowed.insert(format!("edge:{}", identifier.id));
        }
    }
    allowed
}

fn is_writable_container(node: &crate::NodeRecord) -> bool {
    node.kind.ends_with("Statement") || node.kind.ends_with("Declaration")
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

#[cfg(test)]
mod tests {
    use super::{expansion_policy_for_intent, idempotency_for_intent, validate_delta_containment};
    use crate::coordination::{
        DynamicExpansionPolicy, IdempotencyClass, InferredScope, IntentParameters, ResourceVersion,
    };
    use crate::{
        GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord,
        SCHEMA_VERSION,
    };

    #[test]
    fn production_idempotency_and_expansion_policy_are_rust_owned() {
        let rename = IntentParameters::RenameSymbol {
            declaration_id: "declaration:user".into(),
            new_name: "Account".into(),
        };
        let add_parameter = IntentParameters::AddParameter {
            function_id: "function:greet".into(),
            name: "traceId".into(),
            type_text: "string".into(),
            position: 1,
            default_value: None,
        };

        assert_eq!(
            idempotency_for_intent(&rename),
            IdempotencyClass::RequiresDecision
        );
        assert_eq!(
            idempotency_for_intent(&add_parameter),
            IdempotencyClass::ReplaySafe
        );
        assert_eq!(
            expansion_policy_for_intent(&rename),
            DynamicExpansionPolicy::Requeue { max_expansions: 3 }
        );
        assert_eq!(
            expansion_policy_for_intent(&add_parameter),
            DynamicExpansionPolicy::Requeue { max_expansions: 3 }
        );
    }

    fn record(id: &str, kind: &str, parent_id: Option<&str>, child_index: i64) -> NodeRecord {
        NodeRecord {
            id: id.into(),
            kind: kind.into(),
            parent_id: parent_id.map(str::to_owned),
            child_index: Some(child_index),
            payload: id.into(),
        }
    }

    fn containment_graph() -> GraphGeneration {
        GraphGeneration::from_snapshot(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 4,
            nodes: vec![
                record("module", "Module", None, 0),
                record("writable", "ExpressionStatement", Some("module"), 0),
                record("direct", "Identifier", Some("writable"), 0),
                record("non-writable", "ExpressionStatement", Some("module"), 1),
                record("other-direct", "Identifier", Some("non-writable"), 0),
                record("target", "Identifier", Some("module"), 2),
                record("unrelated", "Identifier", Some("module"), 3),
            ],
            references: vec![ReferenceRecord {
                from_node_id: "direct".into(),
                to_node_id: "target".into(),
                kind: "reference".into(),
            }],
        })
        .unwrap()
    }

    fn containment_scope() -> InferredScope {
        InferredScope {
            read_set: vec![],
            write_set: vec![ResourceVersion::new("node:writable", "v").unwrap()],
            validation_set: vec![],
            reservation_keys: vec![
                "node:direct".into(),
                "node:target".into(),
                "node:writable".into(),
            ],
            scope_fingerprint: "scope".into(),
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        }
    }

    fn delta(changes: Vec<GraphChange>) -> GraphDelta {
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 4,
            changes,
        }
    }

    #[test]
    fn writable_statement_narrowly_authorizes_materialized_identifier_children_and_edges() {
        let graph = containment_graph();
        let scope = containment_scope();

        validate_delta_containment(
            &graph,
            &delta(vec![
                GraphChange::UpsertNode {
                    node: record("direct", "Identifier", Some("writable"), 0),
                },
                GraphChange::UpsertReference {
                    reference: ReferenceRecord {
                        from_node_id: "direct".into(),
                        to_node_id: "target".into(),
                        kind: "reference".into(),
                    },
                },
            ]),
            &scope,
        )
        .unwrap();

        validate_delta_containment(
            &graph,
            &delta(vec![
                GraphChange::UpsertNode {
                    node: record("fresh-direct", "Identifier", Some("writable"), 1),
                },
                GraphChange::UpsertReference {
                    reference: ReferenceRecord {
                        from_node_id: "fresh-direct".into(),
                        to_node_id: "target".into(),
                        kind: "reference".into(),
                    },
                },
            ]),
            &scope,
        )
        .unwrap();

        for rogue in [
            record("other-kind", "CallExpression", Some("writable"), 1),
            record("grandchild", "Identifier", Some("direct"), 0),
            record("other-direct", "Identifier", Some("non-writable"), 0),
        ] {
            let error = validate_delta_containment(
                &graph,
                &delta(vec![GraphChange::UpsertNode {
                    node: rogue.clone(),
                }]),
                &scope,
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains(&format!("node:{}", rogue.id)), "{error}");
        }

        let unrelated_endpoint = delta(vec![GraphChange::UpsertReference {
            reference: ReferenceRecord {
                from_node_id: "direct".into(),
                to_node_id: "unrelated".into(),
                kind: "reference".into(),
            },
        }]);
        let error = validate_delta_containment(&graph, &unrelated_endpoint, &scope)
            .unwrap_err()
            .to_string();
        assert!(error.contains("node:unrelated"), "{error}");
    }

    #[test]
    fn existing_identifier_cannot_gain_write_authority_by_reparenting_into_a_writable_statement() {
        let graph = containment_graph();
        let mut scope = containment_scope();
        scope.validation_set = vec![ResourceVersion::new("node:non-writable", "v").unwrap()];
        scope.reservation_keys = vec![
            "node:non-writable".into(),
            "node:other-direct".into(),
            "node:target".into(),
            "node:writable".into(),
        ];

        let malicious_reparent = delta(vec![
            GraphChange::UpsertNode {
                node: record("other-direct", "Identifier", Some("writable"), 0),
            },
            GraphChange::UpsertReference {
                reference: ReferenceRecord {
                    from_node_id: "other-direct".into(),
                    to_node_id: "target".into(),
                    kind: "reference".into(),
                },
            },
        ]);

        let error = validate_delta_containment(&graph, &malicious_reparent, &scope)
            .unwrap_err()
            .to_string();
        assert!(error.contains("node:other-direct"), "{error}");
    }
}
