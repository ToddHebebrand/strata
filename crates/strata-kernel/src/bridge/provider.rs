use std::collections::BTreeSet;
use std::sync::Arc;

use anyhow::{Context, Result, bail, ensure};

use super::process::NodeBridgeClient;
use super::protocol::{
    AnalyzeIntentRequest, BridgeBinding, BridgeKind, BridgeRequest, Hash64,
    IntentParameters as WireIntentParameters, IntentRecord as WireIntentRecord, PROTOCOL_VERSION,
    SemanticFacts, WireReference, WireSnapshot, WireU64,
};
use crate::coordination::{
    IntentAnalysis, IntentParameters, IntentRecord, ResourceVersion, SemanticProvider,
    children_resource, edge_resource, expansion_policy_for_intent, idempotency_for_intent,
    membership_resource, node_resource, references_to_resource,
};
use crate::{GraphGeneration, NodeRecord, ReferenceRecord};

pub(crate) struct NodeSemanticProvider {
    client: Arc<NodeBridgeClient>,
    service_epoch: u64,
}

impl NodeSemanticProvider {
    pub(crate) fn new(client: Arc<NodeBridgeClient>, service_epoch: u64) -> Self {
        Self {
            client,
            service_epoch,
        }
    }
}

impl SemanticProvider for NodeSemanticProvider {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        let request = analyze_request(self.service_epoch, graph, intent)?;
        let facts = self.client.run(&request)?.into_analyze_result()?;
        intent_analysis_from_facts(graph, intent, facts)
    }
}

fn analyze_request(
    service_epoch: u64,
    graph: &GraphGeneration,
    intent: &IntentRecord,
) -> Result<BridgeRequest> {
    ensure!(
        intent.base_generation == graph.generation(),
        "intent base generation does not match analyzed graph"
    );
    let snapshot = WireSnapshot::from_graph_snapshot(&graph.snapshot())?;
    Ok(BridgeRequest::AnalyzeIntent(AnalyzeIntentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: format!(
            "analyze:{}:{}:{}",
            service_epoch,
            graph.generation(),
            intent.intent_id
        ),
        kind: BridgeKind::AnalyzeIntent,
        binding: BridgeBinding {
            service_epoch: WireU64::new(service_epoch),
            graph_generation: WireU64::new(graph.generation()),
            graph_digest: Hash64::parse(graph.digest())?,
        },
        snapshot,
        intent: wire_intent(intent),
    }))
}

fn wire_intent(intent: &IntentRecord) -> WireIntentRecord {
    let parameters = match &intent.parameters {
        IntentParameters::RenameSymbol {
            declaration_id,
            new_name,
        } => WireIntentParameters::RenameSymbol {
            declaration_id: declaration_id.clone(),
            new_name: new_name.clone(),
        },
        IntentParameters::AddParameter {
            function_id,
            name,
            type_text,
            position,
            default_value,
        } => WireIntentParameters::AddParameter {
            function_id: function_id.clone(),
            name: name.clone(),
            type_text: type_text.clone(),
            position: *position,
            default_value: default_value.clone(),
        },
    };
    WireIntentRecord {
        schema_version: intent.schema_version,
        intent_id: intent.intent_id.clone(),
        change_set_id: intent.change_set_id.clone(),
        base_generation: WireU64::new(intent.base_generation),
        parameters,
    }
}

pub(crate) fn intent_analysis_from_facts(
    graph: &GraphGeneration,
    intent: &IntentRecord,
    facts: SemanticFacts,
) -> Result<IntentAnalysis> {
    facts.validate()?;
    let mut scope = ScopeBuilder::new(graph);
    match (&intent.parameters, facts) {
        (
            IntentParameters::RenameSymbol {
                declaration_id,
                new_name,
            },
            SemanticFacts::RenameSymbol {
                declaration_id: fact_declaration_id,
                declaration_name_identifier_id,
                references,
                writable_statement_ids,
                validation_dependency_node_ids,
                validation_dependency_reference_from_node_ids,
            },
        ) => {
            ensure!(
                fact_declaration_id == *declaration_id,
                "rename fact declaration does not match intent"
            );
            let target = scope.require_node(declaration_id)?.clone();
            ensure!(
                is_declaration(&target),
                "rename target is not a declaration"
            );
            let name = scope
                .require_direct_identifier(&declaration_name_identifier_id, declaration_id)?
                .clone();
            let old_name = identifier_text(&name)
                .with_context(|| format!("identifier {} has no text", name.id))?;
            ensure!(!new_name.is_empty(), "rename new name must not be empty");
            let references = scope.resolve_references(&references, Some(&name.id))?;
            ensure_exact_reverse_membership(graph, &name.id, &references)?;
            ensure_writable_membership(
                graph,
                &writable_statement_ids,
                std::iter::once(declaration_id.as_str()).chain(
                    references
                        .iter()
                        .map(|reference| reference.from_node_id.as_str())
                        .map(|source| {
                            graph
                                .node(source)
                                .and_then(|node| node.parent_id.as_deref())
                                .expect("resolved references have parented sources")
                        }),
                ),
            )?;

            scope.read_write_node(&target)?;
            scope.read_write_node(&name)?;
            for statement_id in &writable_statement_ids {
                scope.read_write_statement(statement_id)?;
            }
            for reference in &references {
                scope.read_reference(reference)?;
                let source = scope.require_node(&reference.from_node_id)?.clone();
                scope.read_write_node(&source)?;
            }
            scope.add_validation_facts(
                &validation_dependency_node_ids,
                &validation_dependency_reference_from_node_ids,
            )?;
            scope.reserve(format!("symbol:{declaration_id}"));

            let container = target.parent_id.as_deref().unwrap_or("root");
            for semantic in
                semantic_name_resources(graph, container, &target.kind, [&old_name, new_name])?
            {
                scope.write_and_validate(semantic);
            }
        }
        (
            IntentParameters::AddParameter { function_id, .. },
            SemanticFacts::AddParameter {
                function_id: fact_function_id,
                declaration_name_identifier_id,
                direct_call_references,
                writable_statement_ids,
                arity_risk_references,
                arity_risk_statement_ids,
                unresolved_reference_diagnostics,
                function_body_read_references,
                validation_dependency_node_ids,
                validation_dependency_reference_from_node_ids,
            },
        ) => {
            ensure!(
                fact_function_id == *function_id,
                "add-parameter fact function does not match intent"
            );
            ensure!(
                unresolved_reference_diagnostics.is_empty(),
                "add-parameter facts contain unresolved references"
            );
            let function = scope.require_node(function_id)?.clone();
            ensure!(
                function.kind == "FunctionDeclaration",
                "add-parameter target is not a FunctionDeclaration"
            );
            let name = scope
                .require_direct_identifier(&declaration_name_identifier_id, function_id)?
                .clone();
            let direct_calls = scope.resolve_references(&direct_call_references, Some(&name.id))?;
            let arity_risks = scope.resolve_references(&arity_risk_references, Some(&name.id))?;
            let body_reads = scope.resolve_references(&function_body_read_references, None)?;
            let mut incoming = direct_calls.clone();
            incoming.extend(arity_risks.clone());
            incoming.sort();
            ensure_exact_reverse_membership(graph, &name.id, &incoming)?;
            ensure_writable_membership(
                graph,
                &writable_statement_ids,
                std::iter::once(function_id.as_str()).chain(direct_calls.iter().map(|reference| {
                    graph
                        .node(&reference.from_node_id)
                        .and_then(|node| node.parent_id.as_deref())
                        .expect("resolved direct calls have parented sources")
                })),
            )?;
            ensure_statement_parents(graph, &arity_risks, &arity_risk_statement_ids)?;
            ensure_function_body_references(graph, function_id, &body_reads)?;

            scope.read_write_node(&function)?;
            scope.read_write_node(&name)?;
            for statement_id in &writable_statement_ids {
                scope.read_write_statement(statement_id)?;
            }
            for reference in &direct_calls {
                scope.read_reference(reference)?;
                let source = scope.require_node(&reference.from_node_id)?.clone();
                scope.read_write_node(&source)?;
            }
            for statement_id in &arity_risk_statement_ids {
                scope.read_statement(statement_id)?;
            }
            for reference in arity_risks.iter().chain(&body_reads) {
                scope.read_reference(reference)?;
                let source = scope.require_node(&reference.from_node_id)?.clone();
                scope.read_node(&source)?;
                let target = scope.require_node(&reference.to_node_id)?.clone();
                scope.read_node(&target)?;
            }
            scope.add_validation_facts(
                &validation_dependency_node_ids,
                &validation_dependency_reference_from_node_ids,
            )?;
            scope.reserve(format!("symbol:{function_id}"));
        }
        _ => bail!("semantic fact kind does not match intent kind"),
    }
    scope.finish(&intent.parameters)
}

struct ScopeBuilder<'a> {
    graph: &'a GraphGeneration,
    read_set: Vec<ResourceVersion>,
    write_set: Vec<ResourceVersion>,
    validation_set: Vec<ResourceVersion>,
    reservation_keys: BTreeSet<String>,
}

impl<'a> ScopeBuilder<'a> {
    fn new(graph: &'a GraphGeneration) -> Self {
        Self {
            graph,
            read_set: vec![],
            write_set: vec![],
            validation_set: vec![],
            reservation_keys: BTreeSet::new(),
        }
    }

    fn require_node(&self, id: &str) -> Result<&'a NodeRecord> {
        self.graph
            .node(id)
            .with_context(|| format!("unknown fact node {id}"))
    }

    fn require_direct_identifier(&self, id: &str, parent_id: &str) -> Result<&'a NodeRecord> {
        let node = self.require_node(id)?;
        ensure!(
            node.kind == "Identifier" && node.parent_id.as_deref() == Some(parent_id),
            "fact node {id} is not a direct Identifier child of {parent_id}"
        );
        Ok(node)
    }

    fn reserve_node_and_parent(&mut self, node: &NodeRecord) {
        self.reserve(format!("node:{}", node.id));
        if let Some(parent_id) = &node.parent_id {
            self.reserve(format!("node:{parent_id}"));
        }
    }

    fn read_node(&mut self, node: &NodeRecord) -> Result<()> {
        let resource = node_resource(node)?;
        self.read_set.push(resource.clone());
        self.validation_set.push(resource);
        self.reserve_node_and_parent(node);
        if let Some(parent_id) = &node.parent_id {
            let membership = children_resource(self.graph, parent_id)?;
            self.read_set.push(membership.clone());
            self.validation_set.push(membership);
        }
        Ok(())
    }

    fn read_write_node(&mut self, node: &NodeRecord) -> Result<()> {
        self.read_node(node)?;
        self.write_set.push(node_resource(node)?);
        Ok(())
    }

    fn require_statement(&self, id: &str) -> Result<&'a NodeRecord> {
        let node = self.require_node(id)?;
        ensure!(
            is_writable_statement(node),
            "fact node {id} is not a writable statement"
        );
        Ok(node)
    }

    fn read_statement(&mut self, id: &str) -> Result<()> {
        let statement = self.require_statement(id)?.clone();
        self.read_node(&statement)?;
        let children = children_resource(self.graph, id)?;
        self.read_set.push(children.clone());
        self.validation_set.push(children);
        Ok(())
    }

    fn read_write_statement(&mut self, id: &str) -> Result<()> {
        let statement = self.require_statement(id)?.clone();
        self.read_write_node(&statement)?;
        let children = children_resource(self.graph, id)?;
        self.read_set.push(children.clone());
        self.write_set.push(children.clone());
        self.validation_set.push(children);
        Ok(())
    }

    fn resolve_references(
        &self,
        facts: &[WireReference],
        expected_target: Option<&str>,
    ) -> Result<Vec<ReferenceRecord>> {
        facts
            .iter()
            .map(|fact| {
                let exact = self
                    .graph
                    .reference_from(&fact.from_node_id)
                    .with_context(|| format!("unknown fact reference {}", fact.from_node_id))?;
                ensure!(
                    exact == &fact.to_reference_record(),
                    "fact reference {} does not match the exact graph reference",
                    fact.from_node_id
                );
                if let Some(target) = expected_target {
                    ensure!(
                        exact.to_node_id == target,
                        "fact reference {} has an unexpected target",
                        fact.from_node_id
                    );
                }
                let source = self.require_node(&exact.from_node_id)?;
                ensure!(
                    source.kind == "Identifier",
                    "reference source is not an Identifier"
                );
                ensure!(
                    source.parent_id.is_some(),
                    "reference source has no statement parent"
                );
                self.require_node(&exact.to_node_id)?;
                Ok(exact.clone())
            })
            .collect()
    }

    fn read_reference(&mut self, reference: &ReferenceRecord) -> Result<()> {
        let edge = edge_resource(reference)?;
        self.read_set.push(edge.clone());
        self.validation_set.push(edge);
        let membership = references_to_resource(self.graph, &reference.to_node_id)?;
        self.read_set.push(membership.clone());
        self.validation_set.push(membership);
        self.reserve(format!("node:{}", reference.from_node_id));
        self.reserve(format!("node:{}", reference.to_node_id));
        Ok(())
    }

    fn add_validation_facts(&mut self, node_ids: &[String], edge_ids: &[String]) -> Result<()> {
        for id in node_ids {
            let node = self.require_node(id)?.clone();
            self.validation_set.push(node_resource(&node)?);
            self.validation_set.push(children_resource(self.graph, id)?);
            if let Some(parent_id) = &node.parent_id {
                self.validation_set
                    .push(children_resource(self.graph, parent_id)?);
            }
            self.reserve_node_and_parent(&node);
        }
        for from_id in edge_ids {
            let reference = self
                .graph
                .reference_from(from_id)
                .with_context(|| format!("unknown fact reference {from_id}"))?
                .clone();
            self.validation_set.push(edge_resource(&reference)?);
            self.validation_set
                .push(references_to_resource(self.graph, &reference.to_node_id)?);
            self.reserve(format!("node:{}", reference.from_node_id));
            self.reserve(format!("node:{}", reference.to_node_id));
        }
        Ok(())
    }

    fn write_and_validate(&mut self, resource: ResourceVersion) {
        self.write_set.push(resource.clone());
        self.validation_set.push(resource);
    }

    fn reserve(&mut self, key: String) {
        self.reservation_keys.insert(key);
    }

    fn finish(mut self, parameters: &IntentParameters) -> Result<IntentAnalysis> {
        canonicalize(&mut self.read_set);
        canonicalize(&mut self.write_set);
        canonicalize(&mut self.validation_set);
        Ok(IntentAnalysis {
            read_set: self.read_set,
            write_set: self.write_set,
            validation_set: self.validation_set,
            reservation_keys: self.reservation_keys.into_iter().collect(),
            dynamic_expansion_policy: expansion_policy_for_intent(parameters),
            idempotency_class: idempotency_for_intent(parameters),
        })
    }
}

fn canonicalize(resources: &mut Vec<ResourceVersion>) {
    resources.sort_by(|left, right| {
        (&left.resource_key, &left.version).cmp(&(&right.resource_key, &right.version))
    });
    resources.dedup();
}

fn ensure_exact_reverse_membership(
    graph: &GraphGeneration,
    target_id: &str,
    reported: &[ReferenceRecord],
) -> Result<()> {
    let actual: Vec<_> = graph.references_to(target_id).cloned().collect();
    ensure!(
        actual == reported,
        "semantic facts omit or add reverse-reference members"
    );
    Ok(())
}

fn ensure_writable_membership<'a>(
    graph: &GraphGeneration,
    reported: &[String],
    expected: impl Iterator<Item = &'a str>,
) -> Result<()> {
    for id in reported {
        let node = graph
            .node(id)
            .with_context(|| format!("unknown writable statement {id}"))?;
        ensure!(
            is_writable_statement(node),
            "fact node {id} is not a writable statement"
        );
    }
    let expected: BTreeSet<_> = expected.map(str::to_owned).collect();
    let reported: BTreeSet<_> = reported.iter().cloned().collect();
    ensure!(
        reported == expected,
        "writable statement facts are incomplete or unrelated"
    );
    Ok(())
}

fn ensure_statement_parents(
    graph: &GraphGeneration,
    references: &[ReferenceRecord],
    statements: &[String],
) -> Result<()> {
    let expected: BTreeSet<_> = references
        .iter()
        .map(|reference| {
            graph
                .node(&reference.from_node_id)
                .and_then(|node| node.parent_id.clone())
                .expect("resolved references have parented sources")
        })
        .collect();
    let actual: BTreeSet<_> = statements.iter().cloned().collect();
    ensure!(
        actual == expected,
        "arity-risk statement facts do not match references"
    );
    Ok(())
}

fn ensure_function_body_references(
    graph: &GraphGeneration,
    function_id: &str,
    references: &[ReferenceRecord],
) -> Result<()> {
    let actual: Vec<_> = graph
        .snapshot()
        .references
        .into_iter()
        .filter(|reference| {
            graph
                .node(&reference.from_node_id)
                .is_some_and(|node| node.parent_id.as_deref() == Some(function_id))
        })
        .collect();
    ensure!(
        actual == references,
        "function-body read-reference facts are incomplete"
    );
    Ok(())
}

fn semantic_name_resources<'a>(
    graph: &GraphGeneration,
    container: &str,
    kind: &str,
    names: impl IntoIterator<Item = &'a String>,
) -> Result<Vec<ResourceVersion>> {
    let snapshot = graph.snapshot();
    let mut resources = Vec::new();
    for name in names {
        let namespace_members: Vec<_> = snapshot
            .nodes
            .iter()
            .filter(|node| {
                node.parent_id.as_deref() == Some(container)
                    && is_declaration(node)
                    && declaration_name(graph, node).as_deref() == Some(name.as_str())
            })
            .cloned()
            .collect();
        let absence_members: Vec<_> = namespace_members
            .iter()
            .filter(|node| node.kind == kind)
            .cloned()
            .collect();
        resources.push(membership_resource(
            format!("namespace:{container}:{name}"),
            &namespace_members,
        )?);
        resources.push(membership_resource(
            format!("absence:{kind}:{container}:{name}"),
            &absence_members,
        )?);
    }
    Ok(resources)
}

fn declaration_name(graph: &GraphGeneration, declaration: &NodeRecord) -> Option<String> {
    graph
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.kind == "Identifier" && node.parent_id.as_deref() == Some(&declaration.id)
        })
        .and_then(|node| identifier_text(&node))
}

fn identifier_text(node: &NodeRecord) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&node.payload)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_owned)
}

fn is_declaration(node: &NodeRecord) -> bool {
    node.kind.ends_with("Declaration") || node.kind == "VariableStatement"
}

fn is_writable_statement(node: &NodeRecord) -> bool {
    node.kind.ends_with("Statement") || node.kind.ends_with("Declaration")
}

#[cfg(test)]
mod tests {
    use super::intent_analysis_from_facts;
    use crate::bridge::protocol::{BridgeDiagnostic, SemanticFacts, WireReference};
    use crate::coordination::{
        DynamicExpansionPolicy, IdempotencyClass, IntentParameters, IntentRecord,
    };
    use crate::{GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION};
    use sha2::{Digest, Sha256};

    fn node(
        id: &str,
        kind: &str,
        parent_id: Option<&str>,
        child_index: Option<i64>,
        payload: &str,
    ) -> NodeRecord {
        NodeRecord {
            id: id.into(),
            kind: kind.into(),
            parent_id: parent_id.map(str::to_owned),
            child_index,
            payload: payload.into(),
        }
    }

    fn reference(from: &str, to: &str) -> ReferenceRecord {
        ReferenceRecord {
            from_node_id: from.into(),
            to_node_id: to.into(),
            kind: "reference".into(),
        }
    }

    fn wire_reference(from: &str, to: &str) -> WireReference {
        WireReference {
            from_node_id: from.into(),
            to_node_id: to.into(),
            kind: "reference".into(),
        }
    }

    fn graph(extra_callsite: bool) -> GraphGeneration {
        let mut nodes = vec![
            node("module", "Module", None, None, "src/app.ts"),
            node(
                "greet",
                "FunctionDeclaration",
                Some("module"),
                Some(0),
                "export function greet(name: string) { return name; }",
            ),
            node(
                "greet-name",
                "Identifier",
                Some("greet"),
                Some(0),
                r#"{"text":"greet"}"#,
            ),
            node(
                "body-name",
                "Identifier",
                Some("greet"),
                Some(1),
                r#"{"text":"name"}"#,
            ),
            node(
                "call-statement",
                "ExpressionStatement",
                Some("module"),
                Some(1),
                "greet('Ada');",
            ),
            node(
                "call-name",
                "Identifier",
                Some("call-statement"),
                Some(0),
                r#"{"text":"greet"}"#,
            ),
            node(
                "risk-statement",
                "VariableStatement",
                Some("module"),
                Some(2),
                "const callback = greet;",
            ),
            node(
                "risk-name",
                "Identifier",
                Some("risk-statement"),
                Some(0),
                r#"{"text":"greet"}"#,
            ),
        ];
        let mut references = vec![
            reference("call-name", "greet-name"),
            reference("risk-name", "greet-name"),
        ];
        if extra_callsite {
            nodes.extend([
                node(
                    "new-call-statement",
                    "ExpressionStatement",
                    Some("module"),
                    Some(3),
                    "greet('Grace');",
                ),
                node(
                    "new-call-name",
                    "Identifier",
                    Some("new-call-statement"),
                    Some(0),
                    r#"{"text":"greet"}"#,
                ),
            ]);
            references.push(reference("new-call-name", "greet-name"));
        }
        GraphGeneration::from_snapshot(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: u64::from(extra_callsite),
            nodes,
            references,
        })
        .unwrap()
    }

    fn add_parameter_intent(generation: u64) -> IntentRecord {
        IntentRecord::new(
            SCHEMA_VERSION,
            "intent:add-parameter",
            "change:1",
            generation,
            IntentParameters::AddParameter {
                function_id: "greet".into(),
                name: "traceId".into(),
                type_text: "string".into(),
                position: 1,
                default_value: None,
            },
        )
        .unwrap()
    }

    fn add_parameter_facts(extra_callsite: bool) -> SemanticFacts {
        let mut direct = vec![wire_reference("call-name", "greet-name")];
        let mut writable = vec!["call-statement".to_owned(), "greet".to_owned()];
        let mut validation_nodes = vec![
            "body-name".to_owned(),
            "call-name".to_owned(),
            "call-statement".to_owned(),
            "greet".to_owned(),
            "greet-name".to_owned(),
            "module".to_owned(),
            "risk-name".to_owned(),
            "risk-statement".to_owned(),
        ];
        let mut validation_edges = vec!["call-name".to_owned(), "risk-name".to_owned()];
        if extra_callsite {
            direct.push(wire_reference("new-call-name", "greet-name"));
            writable.push("new-call-statement".into());
            validation_nodes.extend(["new-call-name".to_owned(), "new-call-statement".to_owned()]);
            validation_edges.push("new-call-name".into());
        }
        direct.sort_by(|left, right| left.from_node_id.cmp(&right.from_node_id));
        writable.sort();
        validation_nodes.sort();
        validation_edges.sort();
        SemanticFacts::AddParameter {
            function_id: "greet".into(),
            declaration_name_identifier_id: "greet-name".into(),
            direct_call_references: direct,
            writable_statement_ids: writable,
            arity_risk_references: vec![wire_reference("risk-name", "greet-name")],
            arity_risk_statement_ids: vec!["risk-statement".into()],
            unresolved_reference_diagnostics: Vec::<BridgeDiagnostic>::new(),
            function_body_read_references: vec![],
            validation_dependency_node_ids: validation_nodes,
            validation_dependency_reference_from_node_ids: validation_edges,
        }
    }

    fn version<'a>(resources: &'a [crate::coordination::ResourceVersion], key: &str) -> &'a str {
        resources
            .iter()
            .find(|resource| resource.resource_key == key)
            .unwrap_or_else(|| panic!("missing resource {key}"))
            .version
            .as_str()
    }

    fn hash_json(value: &impl serde::Serialize) -> String {
        format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
    }

    #[test]
    fn facts_resolve_to_exact_records_memberships_and_fresh_scope() {
        let initial = graph(false);
        let initial_analysis = intent_analysis_from_facts(
            &initial,
            &add_parameter_intent(0),
            add_parameter_facts(false),
        )
        .unwrap();

        assert_eq!(
            version(&initial_analysis.read_set, "node:greet"),
            hash_json(initial.node("greet").unwrap())
        );
        assert_eq!(
            version(&initial_analysis.read_set, "edge:call-name"),
            hash_json(initial.reference_from("call-name").unwrap())
        );
        for key in [
            "children:greet",
            "children:module",
            "references-to:greet-name",
        ] {
            assert!(
                initial_analysis
                    .read_set
                    .iter()
                    .chain(&initial_analysis.validation_set)
                    .any(|resource| resource.resource_key == key),
                "missing membership resource {key}"
            );
        }
        assert_eq!(
            initial_analysis.idempotency_class,
            IdempotencyClass::ReplaySafe
        );
        assert_eq!(
            initial_analysis.dynamic_expansion_policy,
            DynamicExpansionPolicy::Requeue { max_expansions: 3 }
        );
        assert!(
            initial_analysis
                .reservation_keys
                .contains(&"node:call-name".into())
        );
        assert!(
            initial_analysis
                .reservation_keys
                .contains(&"node:risk-statement".into())
        );

        let fresh = graph(true);
        let fresh_analysis =
            intent_analysis_from_facts(&fresh, &add_parameter_intent(1), add_parameter_facts(true))
                .unwrap();
        assert_ne!(
            version(&initial_analysis.read_set, "references-to:greet-name"),
            version(&fresh_analysis.read_set, "references-to:greet-name")
        );
        assert_ne!(
            version(&initial_analysis.read_set, "children:module"),
            version(&fresh_analysis.read_set, "children:module")
        );
        assert!(
            fresh_analysis
                .write_set
                .iter()
                .any(|resource| resource.resource_key == "node:new-call-statement")
        );
    }

    #[test]
    fn rename_namespace_and_absence_resources_are_derived_only_from_rust_inputs() {
        let graph = graph(false);
        let intent = IntentRecord::new(
            SCHEMA_VERSION,
            "intent:rename",
            "change:rename",
            0,
            IntentParameters::RenameSymbol {
                declaration_id: "greet".into(),
                new_name: "welcome".into(),
            },
        )
        .unwrap();
        let facts = SemanticFacts::RenameSymbol {
            declaration_id: "greet".into(),
            declaration_name_identifier_id: "greet-name".into(),
            references: vec![
                wire_reference("call-name", "greet-name"),
                wire_reference("risk-name", "greet-name"),
            ],
            writable_statement_ids: vec![
                "call-statement".into(),
                "greet".into(),
                "risk-statement".into(),
            ],
            validation_dependency_node_ids: vec![
                "call-name".into(),
                "call-statement".into(),
                "greet".into(),
                "greet-name".into(),
                "module".into(),
                "risk-name".into(),
                "risk-statement".into(),
            ],
            validation_dependency_reference_from_node_ids: vec![
                "call-name".into(),
                "risk-name".into(),
            ],
        };
        let analysis = intent_analysis_from_facts(&graph, &intent, facts).unwrap();
        for key in [
            "namespace:module:greet",
            "namespace:module:welcome",
            "absence:FunctionDeclaration:module:greet",
            "absence:FunctionDeclaration:module:welcome",
        ] {
            assert!(
                analysis
                    .write_set
                    .iter()
                    .any(|resource| resource.resource_key == key),
                "missing Rust-derived semantic resource {key}"
            );
        }
        assert_eq!(
            analysis.idempotency_class,
            IdempotencyClass::RequiresDecision
        );
    }

    #[test]
    fn facts_reject_unknown_mistyped_mismatched_and_unresolved_members() {
        let graph = graph(false);
        let intent = add_parameter_intent(0);

        let mut unknown = add_parameter_facts(false);
        if let SemanticFacts::AddParameter {
            writable_statement_ids,
            ..
        } = &mut unknown
        {
            writable_statement_ids.push("unknown".into());
            writable_statement_ids.sort();
        }
        assert!(
            intent_analysis_from_facts(&graph, &intent, unknown)
                .unwrap_err()
                .to_string()
                .contains("unknown")
        );

        let mut mistyped = add_parameter_facts(false);
        if let SemanticFacts::AddParameter {
            writable_statement_ids,
            ..
        } = &mut mistyped
        {
            *writable_statement_ids = vec!["call-name".into(), "greet".into()];
        }
        assert!(
            intent_analysis_from_facts(&graph, &intent, mistyped)
                .unwrap_err()
                .to_string()
                .contains("writable statement")
        );

        let mut mismatched = add_parameter_facts(false);
        if let SemanticFacts::AddParameter {
            direct_call_references,
            ..
        } = &mut mismatched
        {
            direct_call_references[0].to_node_id = "risk-name".into();
        }
        assert!(
            intent_analysis_from_facts(&graph, &intent, mismatched)
                .unwrap_err()
                .to_string()
                .contains("exact graph reference")
        );

        let mut unresolved = add_parameter_facts(false);
        if let SemanticFacts::AddParameter {
            unresolved_reference_diagnostics,
            ..
        } = &mut unresolved
        {
            unresolved_reference_diagnostics.push(BridgeDiagnostic {
                node_id: Some("call-name".into()),
                module_path: Some("src/app.ts".into()),
                message: "unresolved".into(),
                code: 2304,
            });
        }
        assert!(
            intent_analysis_from_facts(&graph, &intent, unresolved)
                .unwrap_err()
                .to_string()
                .contains("unresolved")
        );
    }
}
