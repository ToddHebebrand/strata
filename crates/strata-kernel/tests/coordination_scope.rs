#![cfg(feature = "coordination-test-api")]

use anyhow::Context;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use strata_kernel::{
    DynamicExpansionPolicy, GraphChange, GraphDelta, GraphGeneration, GraphSnapshot,
    IdempotencyClass, InferredScope, IntentAnalysis, IntentParameters, IntentRecord, NodeRecord,
    ReferenceRecord, ResourceVersion, SCHEMA_VERSION, ScopeChange, TestSemanticProvider,
    analyze_change_set, canonical_scope_fingerprint, classify_scope_change,
    required_delta_authority, validate_delta_containment,
};

struct StaticAnalyzer(BTreeMap<String, IntentAnalysis>);

impl TestSemanticProvider for StaticAnalyzer {
    fn analyze(
        &self,
        _: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        self.0
            .get(&intent.intent_id)
            .cloned()
            .context("missing static analysis")
    }
}

fn resource(resource_key: &str, version: &str) -> ResourceVersion {
    ResourceVersion::new(resource_key, version).unwrap()
}

fn node(id: &str, parent_id: Option<&str>, payload: &str) -> NodeRecord {
    NodeRecord {
        id: id.into(),
        kind: "Identifier".into(),
        parent_id: parent_id.map(str::to_owned),
        child_index: Some(0),
        payload: payload.into(),
    }
}

fn seed_graph() -> GraphGeneration {
    GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 7,
        nodes: vec![
            node("old-parent", None, "old parent"),
            node("new-parent", None, "new parent"),
            node("caller", Some("old-parent"), "call User"),
            node("old-target", None, "User"),
            node("new-target", None, "Account"),
            node("rogue", None, "rogue"),
        ],
        references: vec![ReferenceRecord {
            from_node_id: "caller".into(),
            to_node_id: "old-target".into(),
            kind: "reference".into(),
        }],
    })
    .unwrap()
}

fn rename() -> IntentRecord {
    IntentRecord::new(
        SCHEMA_VERSION,
        "rename",
        "change-set:1",
        7,
        IntentParameters::RenameSymbol {
            declaration_id: "User".into(),
            new_name: "Account".into(),
        },
    )
    .unwrap()
}

fn add_parameter() -> IntentRecord {
    IntentRecord::new(
        SCHEMA_VERSION,
        "add-parameter",
        "change-set:1",
        7,
        IntentParameters::AddParameter {
            function_id: "caller".into(),
            name: "timezone".into(),
            type_text: "string".into(),
            position: 1,
            default_value: None,
        },
    )
    .unwrap()
}

fn analyzer() -> StaticAnalyzer {
    StaticAnalyzer(BTreeMap::from([
        (
            "rename".into(),
            IntentAnalysis {
                read_set: vec![resource("symbol:User", "7"), resource("node:caller", "2")],
                write_set: vec![resource("node:user", "7"), resource("node:caller", "2")],
                validation_set: vec![resource("module-structure:app", "3")],
                reservation_keys: vec!["symbol:User".into(), "node:caller".into()],
                dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
                idempotency_class: IdempotencyClass::ReplaySafe,
            },
        ),
        (
            "add-parameter".into(),
            IntentAnalysis {
                read_set: vec![resource("node:caller", "2"), resource("symbol:User", "7")],
                write_set: vec![resource("node:caller", "2"), resource("node:caller", "2")],
                validation_set: vec![
                    resource("node:caller", "2"),
                    resource("module-structure:app", "3"),
                ],
                reservation_keys: vec!["node:caller".into(), "node:caller".into()],
                dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 2 },
                idempotency_class: IdempotencyClass::RequiresDecision,
            },
        ),
    ]))
}

#[test]
fn composite_scope_is_canonical_and_order_independent() {
    let graph = seed_graph();
    let scope = analyze_change_set(&graph, &[rename(), add_parameter()], &analyzer()).unwrap();

    assert_eq!(
        scope.read_set,
        vec![resource("node:caller", "2"), resource("symbol:User", "7")]
    );
    assert_eq!(
        scope.write_set,
        vec![resource("node:caller", "2"), resource("node:user", "7")]
    );
    assert_eq!(
        scope.validation_set,
        vec![
            resource("module-structure:app", "3"),
            resource("node:caller", "2")
        ]
    );
    assert_eq!(scope.reservation_keys, vec!["node:caller", "symbol:User"]);
    assert_eq!(
        scope.dynamic_expansion_policy,
        DynamicExpansionPolicy::Requeue { max_expansions: 2 }
    );
    assert_eq!(scope.idempotency_class, IdempotencyClass::RequiresDecision);
    assert_eq!(scope.scope_fingerprint.len(), 64);
    assert!(
        scope
            .scope_fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    );

    let reversed = analyze_change_set(&graph, &[add_parameter(), rename()], &analyzer()).unwrap();
    assert_eq!(scope, reversed);
    assert_eq!(
        canonical_scope_fingerprint(&scope).unwrap(),
        scope.scope_fingerprint
    );

    let mut changed_version = scope.clone();
    changed_version.read_set[0].version = "3".into();
    assert_ne!(
        canonical_scope_fingerprint(&changed_version).unwrap(),
        scope.scope_fingerprint
    );
}

#[test]
fn change_set_analysis_rejects_empty_intents_and_uses_strictest_modes() {
    let error = analyze_change_set(&seed_graph(), &[], &analyzer()).unwrap_err();
    assert!(error.to_string().contains("at least one intent"));

    let mut strict = analyzer();
    strict.0.get_mut("rename").unwrap().dynamic_expansion_policy =
        DynamicExpansionPolicy::NeedsDecision;
    let scope = analyze_change_set(&seed_graph(), &[rename(), add_parameter()], &strict).unwrap();
    assert_eq!(
        scope.dynamic_expansion_policy,
        DynamicExpansionPolicy::NeedsDecision
    );
}

#[test]
fn scope_change_classifies_unchanged_expanded_and_material_replacements() {
    let old = analyze_change_set(&seed_graph(), &[rename()], &analyzer()).unwrap();
    assert_eq!(classify_scope_change(&old, &old), ScopeChange::Unchanged);

    let mut expanded = old.clone();
    expanded
        .validation_set
        .push(resource("node:additional", "1"));
    expanded.reservation_keys.push("node:additional".into());
    expanded.scope_fingerprint = canonical_scope_fingerprint(&expanded).unwrap();
    assert_eq!(
        classify_scope_change(&old, &expanded),
        ScopeChange::Expanded
    );

    let mut replaced_version = expanded.clone();
    replaced_version.read_set[0].version = "99".into();
    replaced_version.scope_fingerprint = canonical_scope_fingerprint(&replaced_version).unwrap();
    assert_eq!(
        classify_scope_change(&expanded, &replaced_version),
        ScopeChange::MateriallyChanged
    );

    let mut removed_key = expanded.clone();
    removed_key.reservation_keys.remove(0);
    removed_key.scope_fingerprint = canonical_scope_fingerprint(&removed_key).unwrap();
    assert_eq!(
        classify_scope_change(&expanded, &removed_key),
        ScopeChange::Contracted
    );
}

#[test]
fn membership_only_version_drift_is_expansion_only_with_new_scope_keys() {
    let mut old = analyze_change_set(&seed_graph(), &[rename()], &analyzer()).unwrap();
    old.read_set
        .push(resource("children:parent", "membership-v1"));
    old.scope_fingerprint = canonical_scope_fingerprint(&old).unwrap();
    let mut expanded = old.clone();
    let membership = expanded
        .read_set
        .iter_mut()
        .find(|resource| resource.resource_key.starts_with("children:"))
        .expect("fixture scope has children membership");
    membership.version = "membership-v2".into();
    expanded.read_set.push(resource("node:new-callsite", "1"));
    expanded
        .validation_set
        .push(resource("edge:new-callsite-name", "1"));
    expanded.reservation_keys.push("node:new-callsite".into());
    expanded.scope_fingerprint = canonical_scope_fingerprint(&expanded).unwrap();

    assert_eq!(
        classify_scope_change(&old, &expanded),
        ScopeChange::Expanded
    );

    let mut membership_drift_only = old.clone();
    membership_drift_only
        .read_set
        .iter_mut()
        .find(|resource| resource.resource_key.starts_with("children:"))
        .unwrap()
        .version = "membership-v2".into();
    membership_drift_only.scope_fingerprint =
        canonical_scope_fingerprint(&membership_drift_only).unwrap();
    assert_eq!(
        classify_scope_change(&old, &membership_drift_only),
        ScopeChange::MateriallyChanged
    );
}

#[test]
fn removals_replacements_and_unrelated_common_version_drift_are_material() {
    let old = analyze_change_set(&seed_graph(), &[rename()], &analyzer()).unwrap();

    let mut removed = old.clone();
    removed.read_set.pop();
    removed.scope_fingerprint = canonical_scope_fingerprint(&removed).unwrap();
    assert_eq!(
        classify_scope_change(&old, &removed),
        ScopeChange::MateriallyChanged
    );

    let mut replaced = old.clone();
    replaced.read_set.pop();
    replaced.read_set.push(resource("node:replacement", "1"));
    replaced.reservation_keys.push("node:replacement".into());
    replaced.scope_fingerprint = canonical_scope_fingerprint(&replaced).unwrap();
    assert_eq!(
        classify_scope_change(&old, &replaced),
        ScopeChange::MateriallyChanged
    );

    let mut unrelated_drift = old.clone();
    unrelated_drift
        .read_set
        .iter_mut()
        .find(|resource| resource.resource_key.starts_with("node:"))
        .expect("fixture scope has node resource")
        .version = "node-v2".into();
    unrelated_drift
        .validation_set
        .push(resource("node:new-callsite", "1"));
    unrelated_drift
        .reservation_keys
        .push("node:new-callsite".into());
    unrelated_drift.scope_fingerprint = canonical_scope_fingerprint(&unrelated_drift).unwrap();
    assert_eq!(
        classify_scope_change(&old, &unrelated_drift),
        ScopeChange::MateriallyChanged
    );
}

#[test]
fn scope_expansion_with_a_policy_change_is_material() {
    let old = analyze_change_set(&seed_graph(), &[rename()], &analyzer()).unwrap();
    let mut expanded = old.clone();
    expanded.reservation_keys.push("node:additional".into());
    expanded.dynamic_expansion_policy = DynamicExpansionPolicy::NeedsDecision;
    expanded.scope_fingerprint = canonical_scope_fingerprint(&expanded).unwrap();

    assert_eq!(
        classify_scope_change(&old, &expanded),
        ScopeChange::MateriallyChanged
    );
}

#[test]
fn scope_expansion_with_an_idempotency_change_is_material() {
    let old = analyze_change_set(&seed_graph(), &[rename()], &analyzer()).unwrap();
    let mut expanded = old.clone();
    expanded.reservation_keys.push("node:additional".into());
    expanded.idempotency_class = IdempotencyClass::RequiresDecision;
    expanded.scope_fingerprint = canonical_scope_fingerprint(&expanded).unwrap();

    assert_eq!(
        classify_scope_change(&old, &expanded),
        ScopeChange::MateriallyChanged
    );
}

fn delta(change: GraphChange) -> GraphDelta {
    GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 7,
        changes: vec![change],
    }
}

#[test]
fn node_delta_authority_includes_node_and_old_and_new_parent_coverage() {
    let graph = seed_graph();
    let payload_only = required_delta_authority(
        &graph,
        &delta(GraphChange::UpsertNode {
            node: node("caller", Some("old-parent"), "changed call"),
        }),
    )
    .unwrap();
    assert_eq!(payload_only.write_resources, vec!["node:caller"]);
    assert_eq!(
        payload_only.reservation_coverage,
        vec!["node:caller", "node:old-parent"]
    );

    let parent_move = required_delta_authority(
        &graph,
        &delta(GraphChange::UpsertNode {
            node: node("caller", Some("new-parent"), "call User"),
        }),
    )
    .unwrap();
    assert_eq!(parent_move.write_resources, vec!["node:caller"]);
    assert_eq!(
        parent_move.reservation_coverage,
        vec!["node:caller", "node:new-parent", "node:old-parent"]
    );
}

#[test]
fn reference_delta_authority_uses_edge_identity_but_node_endpoint_coverage() {
    let graph = seed_graph();
    let retarget = required_delta_authority(
        &graph,
        &delta(GraphChange::UpsertReference {
            reference: ReferenceRecord {
                from_node_id: "caller".into(),
                to_node_id: "new-target".into(),
                kind: "reference".into(),
            },
        }),
    )
    .unwrap();
    assert_eq!(retarget.write_resources, vec!["edge:caller"]);
    assert_eq!(
        retarget.reservation_coverage,
        vec!["node:caller", "node:new-target", "node:old-target"]
    );
    assert!(
        retarget
            .reservation_coverage
            .iter()
            .all(|key| !key.starts_with("edge:"))
    );

    let deletion = required_delta_authority(
        &graph,
        &delta(GraphChange::DeleteReference {
            from_node_id: "caller".into(),
        }),
    )
    .unwrap();
    assert_eq!(deletion.write_resources, vec!["edge:caller"]);
    assert_eq!(
        deletion.reservation_coverage,
        vec!["node:caller", "node:old-target"]
    );
}

#[test]
fn delta_containment_rejects_a_rogue_write_outside_inferred_scope() {
    let graph = seed_graph();
    let scope = InferredScope {
        read_set: vec![],
        write_set: vec![resource("node:caller", "7")],
        validation_set: vec![],
        reservation_keys: vec!["node:caller".into(), "node:old-parent".into()],
        scope_fingerprint: "will-be-replaced".into(),
        dynamic_expansion_policy: DynamicExpansionPolicy::NeedsDecision,
        idempotency_class: IdempotencyClass::RequiresDecision,
    };
    let allowed = delta(GraphChange::UpsertNode {
        node: node("caller", Some("old-parent"), "changed call"),
    });
    validate_delta_containment(&graph, &allowed, &scope).unwrap();

    let rogue = delta(GraphChange::DeleteNode {
        node_id: "rogue".into(),
    });
    let error = validate_delta_containment(&graph, &rogue, &scope).unwrap_err();
    assert!(error.to_string().contains("node:rogue"));
}

fn collect_rust_sources(directory: &Path, sources: &mut Vec<String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_rust_sources(&path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(fs::read_to_string(path).unwrap());
        }
    }
}

#[test]
fn production_coordination_has_no_fake_analyzer_or_candidate_builder() {
    let mut sources = Vec::new();
    collect_rust_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/coordination"),
        &mut sources,
    );
    let production = sources.join("\n");
    for forbidden in [
        "struct StaticAnalyzer",
        "struct FakeAnalyzer",
        "struct TestAnalyzer",
        "struct StaticCandidateBuilder",
        "struct FakeCandidateBuilder",
    ] {
        assert!(
            !production.contains(forbidden),
            "production contains forbidden test double {forbidden}"
        );
    }
}
