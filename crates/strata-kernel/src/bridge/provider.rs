use std::collections::BTreeSet;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Deserialize;

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
        intent: wire_intent(intent, graph.generation()),
    }))
}

pub(crate) fn wire_intent(intent: &IntentRecord, analysis_generation: u64) -> WireIntentRecord {
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
        base_generation: WireU64::new(analysis_generation),
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
            let reported_name = scope
                .require_direct_identifier(&declaration_name_identifier_id, declaration_id)?
                .clone();
            identifier_payload(&reported_name).with_context(|| {
                format!("malformed declaration name identifier {}", reported_name.id)
            })?;
            let name = declaration_name_identifier(graph, &target)?.clone();
            ensure!(
                reported_name.id == name.id,
                "fact declaration name identifier {} does not match canonical declaration name {}",
                reported_name.id,
                name.id
            );
            let old_name = identifier_payload(&name)?.text;
            ensure!(!new_name.is_empty(), "rename new name must not be empty");
            let references = scope.resolve_references(&references, Some(&name.id))?;
            ensure_exact_reverse_membership(graph, &name.id, &references)?;
            scope.read_reference_membership(&name.id)?;
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
                content_dependency_declaration_ids,
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
            let reported_name = scope
                .require_direct_identifier(&declaration_name_identifier_id, function_id)?
                .clone();
            identifier_payload(&reported_name).with_context(|| {
                format!("malformed declaration name identifier {}", reported_name.id)
            })?;
            let name = declaration_name_identifier(graph, &function)?.clone();
            ensure!(
                reported_name.id == name.id,
                "fact declaration name identifier {} does not match canonical declaration name {}",
                reported_name.id,
                name.id
            );
            let direct_calls = scope.resolve_references(&direct_call_references, Some(&name.id))?;
            let arity_risks = scope.resolve_references(&arity_risk_references, Some(&name.id))?;
            let body_reads = scope.resolve_references(&function_body_read_references, None)?;
            let mut incoming = direct_calls.clone();
            incoming.extend(arity_risks.clone());
            let reported_sources = incoming
                .iter()
                .map(|reference| reference.from_node_id.as_str())
                .collect::<BTreeSet<_>>();
            let import_reads = graph
                .references_to(&name.id)
                .filter(|reference| !reported_sources.contains(reference.from_node_id.as_str()))
                .filter_map(|reference| {
                    let source = graph.node(&reference.from_node_id)?;
                    let parent = graph.node(source.parent_id.as_deref()?)?;
                    (parent.kind == "ImportDeclaration").then(|| reference.clone())
                })
                .collect::<Vec<_>>();
            incoming.extend(import_reads.clone());
            incoming.sort();
            ensure_exact_reverse_membership(graph, &name.id, &incoming)?;
            scope.read_reference_membership(&name.id)?;
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
            for reference in &import_reads {
                scope.read_reference(reference)?;
                let source = scope.require_node(&reference.from_node_id)?.clone();
                scope.read_node(&source)?;
                let statement_id = source
                    .parent_id
                    .as_deref()
                    .context("resolved import reference has no statement parent")?;
                scope.read_statement(statement_id)?;
            }
            scope.add_validation_facts(
                &validation_dependency_node_ids,
                &validation_dependency_reference_from_node_ids,
            )?;
            for declaration_id in &content_dependency_declaration_ids {
                scope.validate_content_declaration(declaration_id)?;
            }
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
        self.read_reference_membership(&reference.to_node_id)?;
        self.reserve(format!("node:{}", reference.from_node_id));
        Ok(())
    }

    fn read_reference_membership(&mut self, target_id: &str) -> Result<()> {
        let membership = references_to_resource(self.graph, target_id)?;
        self.read_set.push(membership.clone());
        self.validation_set.push(membership);
        self.reserve(format!("node:{target_id}"));
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

    /// Validation-only pins for an intent-content dependency (spec 2026-07-17
    /// Changes 2/2a): the declaration node, its name identifier, its child
    /// membership, and its semantic namespace/absence membership — observed,
    /// never reserved or written, so independent siblings stay concurrent
    /// while a rename that touches or merges into the name still drifts the
    /// claim (`MateriallyChanged`) and its write-set clock bump invalidates
    /// at publish.
    fn validate_content_declaration(&mut self, declaration_id: &str) -> Result<()> {
        let node = self.require_node(declaration_id)?.clone();
        ensure!(
            is_declaration(&node),
            "content dependency {} is not a declaration",
            node.id
        );
        self.validation_set.push(node_resource(&node)?);
        self.validation_set
            .push(children_resource(self.graph, &node.id)?);
        let name = declaration_name_identifier(self.graph, &node)?.clone();
        self.validation_set.push(node_resource(&name)?);
        let text = identifier_payload(&name)?.text;
        let container = node.parent_id.as_deref().unwrap_or("root").to_owned();
        for semantic in
            semantic_name_resources(self.graph, &container, &node.kind, [&text])?
        {
            self.validation_set.push(semantic);
        }
        Ok(())
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
        let mut namespace_members = Vec::new();
        for node in &snapshot.nodes {
            if node.parent_id.as_deref() != Some(container) || !is_declaration(node) {
                continue;
            }
            if declaration_name(graph, node)?.as_deref() == Some(name.as_str()) {
                namespace_members.push(node.clone());
            }
        }
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

pub(crate) fn declaration_name(
    graph: &GraphGeneration,
    declaration: &NodeRecord,
) -> Result<Option<String>> {
    if !is_supported_named_declaration_kind(&declaration.kind) {
        return Ok(None);
    }
    Ok(Some(
        identifier_payload(declaration_name_identifier(graph, declaration)?)?.text,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentifierPayload {
    text: String,
    offset: u64,
}

fn identifier_payload(node: &NodeRecord) -> Result<IdentifierPayload> {
    serde_json::from_str(&node.payload)
        .with_context(|| format!("identifier {} has a malformed payload", node.id))
}

fn declaration_name_identifier<'a>(
    graph: &'a GraphGeneration,
    declaration: &NodeRecord,
) -> Result<&'a NodeRecord> {
    let (expected_text, expected_offset) = declaration_name_token(declaration)?;
    let mut matches = graph.snapshot().nodes.into_iter().filter_map(|node| {
        if node.kind != "Identifier" || node.parent_id.as_deref() != Some(&declaration.id) {
            return None;
        }
        let payload = identifier_payload(&node).ok()?;
        (payload.text == expected_text && payload.offset == expected_offset).then_some(node.id)
    });
    let first = matches.next().with_context(|| {
        format!(
            "declaration {} has no exact declaration name identifier for {expected_text}@{expected_offset}",
            declaration.id
        )
    })?;
    ensure!(
        matches.next().is_none(),
        "declaration {} has ambiguous declaration name identifiers for {expected_text}@{expected_offset}",
        declaration.id
    );
    graph
        .node(&first)
        .with_context(|| format!("declaration name identifier {first} disappeared"))
}

fn declaration_name_token(declaration: &NodeRecord) -> Result<(String, u64)> {
    let tokens = source_tokens(&declaration.payload)?;
    if matches!(
        declaration.kind.as_str(),
        "FirstStatement" | "VariableStatement"
    ) {
        return first_simple_variable_binding(declaration, &tokens);
    }
    let keyword = declaration_keyword(&declaration.kind)
        .with_context(|| format!("unsupported named declaration kind {}", declaration.kind))?;
    let keyword_index = tokens
        .iter()
        .position(|token| token.text == keyword)
        .with_context(|| {
            format!(
                "{} payload has no canonical {keyword} declaration token",
                declaration.id
            )
        })?;
    let mut name_index = keyword_index + 1;
    if declaration.kind == "FunctionDeclaration"
        && tokens
            .get(name_index)
            .is_some_and(|token| token.text == "*")
    {
        name_index += 1;
    }
    let name = tokens
        .get(name_index)
        .with_context(|| format!("{} payload has no declaration name token", declaration.id))?;
    ensure!(
        name.is_identifier,
        "{} payload declaration name is not an identifier",
        declaration.id
    );
    Ok((name.text.clone(), name.utf16_offset))
}

fn first_simple_variable_binding(
    declaration: &NodeRecord,
    tokens: &[SourceToken],
) -> Result<(String, u64)> {
    let keyword_index = tokens
        .iter()
        .position(|token| matches!(token.text.as_str(), "const" | "let" | "var"))
        .with_context(|| {
            format!(
                "{} payload has no canonical variable declaration token",
                declaration.id
            )
        })?;
    let mut cursor = keyword_index + 1;
    while let Some(binding) = tokens.get(cursor) {
        if binding.is_identifier {
            return Ok((binding.text.clone(), binding.utf16_offset));
        }
        ensure!(
            matches!(binding.text.as_str(), "{" | "["),
            "{} payload has an unsupported variable binding",
            declaration.id
        );
        cursor = skip_balanced_binding(tokens, cursor)
            .with_context(|| format!("{} payload has malformed destructuring", declaration.id))?;
        let mut paren_depth = 0_u32;
        let mut brace_depth = 0_u32;
        let mut bracket_depth = 0_u32;
        let mut angle_depth = 0_u32;
        let mut found_next = false;
        while let Some(token) = tokens.get(cursor) {
            match token.text.as_str() {
                "(" => paren_depth += 1,
                ")" => paren_depth = paren_depth.saturating_sub(1),
                "{" => brace_depth += 1,
                "}" => brace_depth = brace_depth.saturating_sub(1),
                "[" => bracket_depth += 1,
                "]" => bracket_depth = bracket_depth.saturating_sub(1),
                "<" => angle_depth += 1,
                ">" => angle_depth = angle_depth.saturating_sub(1),
                "," if paren_depth == 0
                    && brace_depth == 0
                    && bracket_depth == 0
                    && angle_depth == 0 =>
                {
                    cursor += 1;
                    found_next = true;
                    break;
                }
                ";" if paren_depth == 0
                    && brace_depth == 0
                    && bracket_depth == 0
                    && angle_depth == 0 =>
                {
                    break;
                }
                _ => {}
            }
            cursor += 1;
        }
        if !found_next {
            break;
        }
    }
    bail!(
        "{} payload has no simple variable declaration name",
        declaration.id
    )
}

fn skip_balanced_binding(tokens: &[SourceToken], start: usize) -> Option<usize> {
    let open = tokens.get(start)?.text.as_str();
    let close = match open {
        "{" => "}",
        "[" => "]",
        _ => return None,
    };
    let mut depth = 0_u32;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        if token.text == open {
            depth = depth.checked_add(1)?;
        } else if token.text == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index + 1);
            }
        }
    }
    None
}

fn declaration_keyword(kind: &str) -> Option<&'static str> {
    match kind {
        "FunctionDeclaration" => Some("function"),
        "InterfaceDeclaration" => Some("interface"),
        "ClassDeclaration" => Some("class"),
        "TypeAliasDeclaration" => Some("type"),
        _ => None,
    }
}

fn is_supported_named_declaration_kind(kind: &str) -> bool {
    declaration_keyword(kind).is_some() || matches!(kind, "FirstStatement" | "VariableStatement")
}

struct SourceToken {
    text: String,
    utf16_offset: u64,
    is_identifier: bool,
}

fn source_tokens(source: &str) -> Result<Vec<SourceToken>> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index..].starts_with(b"//") {
            index = bytes[index..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |offset| index + offset + 1);
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            let end = bytes[index + 2..]
                .windows(2)
                .position(|window| window == b"*/")
                .map(|offset| index + 2 + offset + 2)
                .ok_or_else(|| anyhow!("unterminated block comment in declaration payload"))?;
            index = end;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            let quote = byte;
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index = (index + 2).min(bytes.len());
                } else if bytes[index] == quote {
                    index += 1;
                    closed = true;
                    break;
                } else {
                    index += 1;
                }
            }
            ensure!(closed, "unterminated string in declaration payload");
            continue;
        }
        let start = index;
        let Some(first) = source[index..].chars().next() else {
            break;
        };
        let is_identifier = first == '_' || first == '$' || first.is_alphabetic();
        if is_identifier {
            index += first.len_utf8();
            while index < bytes.len() {
                let Some(character) = source[index..].chars().next() else {
                    break;
                };
                if character == '_'
                    || character == '$'
                    || character.is_alphanumeric()
                    || character == '\u{200c}'
                    || character == '\u{200d}'
                {
                    index += character.len_utf8();
                } else {
                    break;
                }
            }
        } else {
            index += first.len_utf8();
        }
        tokens.push(SourceToken {
            text: source[start..index].to_owned(),
            utf16_offset: u64::try_from(source[..start].encode_utf16().count())
                .context("declaration identifier offset overflow")?,
            is_identifier,
        });
    }
    Ok(tokens)
}

fn is_declaration(node: &NodeRecord) -> bool {
    node.kind.ends_with("Declaration")
        || matches!(node.kind.as_str(), "FirstStatement" | "VariableStatement")
}

fn is_writable_statement(node: &NodeRecord) -> bool {
    node.kind.ends_with("Statement") || node.kind.ends_with("Declaration")
}

#[cfg(test)]
mod tests {
    use super::{
        NodeSemanticProvider, analyze_request, declaration_name_token, intent_analysis_from_facts,
    };
    use crate::bridge::process::{NodeBridgeClient, NodeBridgeConfig};
    use crate::bridge::protocol::{BridgeDiagnostic, BridgeRequest, SemanticFacts, WireReference};
    use crate::coordination::{
        DynamicExpansionPolicy, IdempotencyClass, InferredScope, IntentAnalysis, IntentParameters,
        IntentRecord, ScopeChange, SemanticProvider, canonical_scope_fingerprint,
        classify_scope_change,
    };
    use crate::{GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION};
    use sha2::{Digest, Sha256};
    use std::ffi::OsString;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

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
                r#"{"text":"greet","offset":16}"#,
            ),
            node(
                "body-name",
                "Identifier",
                Some("greet"),
                Some(1),
                r#"{"text":"name","offset":22}"#,
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
            node(
                "callback-name",
                "Identifier",
                Some("risk-statement"),
                Some(1),
                r#"{"text":"callback","offset":6}"#,
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
            content_dependency_declaration_ids: vec![],
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

    fn inferred_scope(analysis: IntentAnalysis) -> InferredScope {
        let mut scope = InferredScope {
            read_set: analysis.read_set,
            write_set: analysis.write_set,
            validation_set: analysis.validation_set,
            reservation_keys: analysis.reservation_keys,
            scope_fingerprint: String::new(),
            dynamic_expansion_policy: analysis.dynamic_expansion_policy,
            idempotency_class: analysis.idempotency_class,
        };
        scope.scope_fingerprint = canonical_scope_fingerprint(&scope).unwrap();
        scope
    }

    #[test]
    #[ignore = "requires pnpm kernel:bridge:build"]
    fn provider_reanalyzes_a_durable_intent_once_against_fresh_g1_scope() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let snapshot: GraphSnapshot = serde_json::from_str(include_str!(
            "../../tests/fixtures/examples-medium.snapshot.json"
        ))
        .unwrap();
        let initial = GraphGeneration::from_snapshot(snapshot.clone()).unwrap();
        let mut fresh_snapshot = snapshot;
        fresh_snapshot.generation = 1;
        fresh_snapshot.nodes.extend([
            node(
                "fresh-call-statement",
                "ExpressionStatement",
                Some("2afe993be8a95549"),
                Some(999),
                "greet({ id: 'fresh', email: 'fresh@example.com' });",
            ),
            node(
                "fresh-call-name",
                "Identifier",
                Some("fresh-call-statement"),
                None,
                r#"{"text":"greet","offset":0}"#,
            ),
        ]);
        fresh_snapshot.references.push(ReferenceRecord {
            from_node_id: "fresh-call-name".into(),
            to_node_id: "c88199f537b34a1b".into(),
            kind: "value".into(),
        });
        let fresh = GraphGeneration::from_snapshot(fresh_snapshot).unwrap();
        let durable_intent = IntentRecord::new(
            SCHEMA_VERSION,
            "intent:fresh-provider",
            "change:fresh-provider",
            0,
            IntentParameters::AddParameter {
                function_id: "603b2ae524ee3c70".into(),
                name: "traceId".into(),
                type_text: "string".into(),
                position: 1,
                default_value: None,
            },
        )
        .unwrap();
        let durable_before = durable_intent.clone();
        let client = Arc::new(NodeBridgeClient::new(NodeBridgeConfig::tsc_only(
            "node",
            vec![OsString::from(
                root.join("packages/kernel-bridge/dist/worker.js"),
            )],
            Duration::from_secs(30),
            root.join("examples/medium/src"),
            root.join("examples/medium"),
            true,
        )));
        let provider = NodeSemanticProvider::new(client.clone(), 17);

        let initial_analysis = inferred_scope(provider.analyze(&initial, &durable_intent).unwrap());
        let calls_before_fresh_analysis = client.run_count();
        let fresh_analysis = inferred_scope(provider.analyze(&fresh, &durable_intent).unwrap());

        assert_eq!(client.run_count() - calls_before_fresh_analysis, 1);
        assert_eq!(
            classify_scope_change(&initial_analysis, &fresh_analysis),
            ScopeChange::Expanded
        );
        assert_ne!(
            version(&initial_analysis.read_set, "references-to:c88199f537b34a1b"),
            version(&fresh_analysis.read_set, "references-to:c88199f537b34a1b")
        );
        assert_ne!(
            version(&initial_analysis.read_set, "children:2afe993be8a95549"),
            version(&fresh_analysis.read_set, "children:2afe993be8a95549")
        );
        assert!(
            fresh_analysis
                .read_set
                .iter()
                .any(|resource| { resource.resource_key == "references-to:c88199f537b34a1b" })
        );
        assert_ne!(initial_analysis.write_set, fresh_analysis.write_set);
        assert!(
            fresh_analysis
                .write_set
                .iter()
                .any(|resource| { resource.resource_key == "node:fresh-call-statement" })
        );
        assert_eq!(
            fresh_analysis.dynamic_expansion_policy,
            DynamicExpansionPolicy::Requeue { max_expansions: 3 }
        );
        assert_eq!(durable_intent, durable_before);
    }

    fn merged_interface_graph() -> GraphGeneration {
        let mut snapshot = graph(false).snapshot();
        snapshot.nodes.extend([
            node(
                "shape-a-one",
                "InterfaceDeclaration",
                Some("module"),
                Some(10),
                "export interface A { x: number }",
            ),
            node(
                "shape-a-one-name",
                "Identifier",
                Some("shape-a-one"),
                None,
                r#"{"text":"A","offset":17}"#,
            ),
            node(
                "shape-a-two",
                "InterfaceDeclaration",
                Some("module"),
                Some(11),
                "export interface A { y: string }",
            ),
            node(
                "shape-a-two-name",
                "Identifier",
                Some("shape-a-two"),
                None,
                r#"{"text":"A","offset":17}"#,
            ),
        ]);
        GraphGeneration::from_snapshot(snapshot).unwrap()
    }

    fn with_content_dependencies(mut facts: SemanticFacts, ids: &[&str]) -> SemanticFacts {
        if let SemanticFacts::AddParameter {
            content_dependency_declaration_ids,
            ..
        } = &mut facts
        {
            *content_dependency_declaration_ids =
                ids.iter().map(|id| (*id).to_owned()).collect();
        }
        facts
    }

    #[test]
    fn content_dependencies_pin_namespace_membership_without_reserving() {
        // Interface-merging regression (spec 2026-07-17 Change 2a, review
        // finding 4): an addParameter whose typeText mentions `A` pins every
        // merged declaration of A plus `namespace:module:A` — the exact key a
        // concurrent rename B→A WRITES via semantic_name_resources — so the
        // merge drifts this analysis at claim/publish. The pins are
        // observations: reservations and the write set must stay identical.
        let graph = merged_interface_graph();
        let intent = add_parameter_intent(0);
        let baseline =
            intent_analysis_from_facts(&graph, &intent, add_parameter_facts(false)).unwrap();
        let pinned = intent_analysis_from_facts(
            &graph,
            &intent,
            with_content_dependencies(
                add_parameter_facts(false),
                &["shape-a-one", "shape-a-two"],
            ),
        )
        .unwrap();

        assert_eq!(baseline.reservation_keys, pinned.reservation_keys);
        assert_eq!(baseline.write_set, pinned.write_set);
        let validation_keys: std::collections::BTreeSet<&str> = pinned
            .validation_set
            .iter()
            .map(|resource| resource.resource_key.as_str())
            .collect();
        for key in [
            "node:shape-a-one",
            "node:shape-a-one-name",
            "node:shape-a-two",
            "node:shape-a-two-name",
            "namespace:module:A",
            "absence:InterfaceDeclaration:module:A",
        ] {
            assert!(validation_keys.contains(key), "missing {key}");
        }

        let error = intent_analysis_from_facts(
            &graph,
            &intent,
            with_content_dependencies(add_parameter_facts(false), &["call-statement"]),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("not a declaration"), "{error}");
    }

    #[test]
    fn declaration_name_tokens_match_persisted_kinds_and_typescript_offsets() {
        let cases = [
            (
                "FunctionDeclaration",
                "export async function run(value: string) {}",
                "run",
            ),
            (
                "InterfaceDeclaration",
                "export interface User { id: string }",
                "User",
            ),
            (
                "ClassDeclaration",
                "export default class Account {}",
                "Account",
            ),
            (
                "TypeAliasDeclaration",
                "export type UserId = string;",
                "UserId",
            ),
            ("FirstStatement", "export const zone = 'utc';", "zone"),
            ("FirstStatement", "let mutable = 1;", "mutable"),
            ("FirstStatement", "var legacy = true;", "legacy"),
            (
                "FirstStatement",
                "const { skipped } = source, selected = 1;",
                "selected",
            ),
            (
                "FirstStatement",
                "const { skipped }: Map<string, number> = source, selected = 1;",
                "selected",
            ),
            (
                "FirstStatement",
                "const first = 1, { later } = source;",
                "first",
            ),
            (
                "InterfaceDeclaration",
                "/** 😀 */ export interface Café { valeur: string }",
                "Café",
            ),
        ];

        for (index, (kind, payload, expected_name)) in cases.into_iter().enumerate() {
            let declaration = node(
                &format!("declaration-{index}"),
                kind,
                Some("module"),
                Some(index as i64),
                payload,
            );
            let (name, offset) = declaration_name_token(&declaration).unwrap();
            let byte_offset = payload.find(expected_name).unwrap();
            let expected_offset = payload[..byte_offset].encode_utf16().count() as u64;
            assert_eq!(name, expected_name, "{kind}: {payload}");
            assert_eq!(offset, expected_offset, "{kind}: {payload}");
        }
    }

    #[test]
    fn declaration_name_tokens_reject_destructuring_malformed_and_escaped_bindings() {
        for payload in [
            "const { only } = source;",
            "const [only] = source;",
            "const = broken;",
            r"const \u0061 = 1;",
        ] {
            let declaration = node(
                "unsupported-binding",
                "FirstStatement",
                Some("module"),
                Some(0),
                payload,
            );
            assert!(
                declaration_name_token(&declaration).is_err(),
                "unexpectedly accepted {payload}"
            );
        }
    }

    #[test]
    fn analysis_request_rebinds_a_durable_intent_to_the_current_graph_without_mutation() {
        let current = graph(true);
        let durable_intent = add_parameter_intent(0);
        let before = durable_intent.clone();

        let BridgeRequest::AnalyzeIntent(request) =
            analyze_request(7, &current, &durable_intent).unwrap()
        else {
            panic!("expected analyze-intent request")
        };

        assert_eq!(request.binding.graph_generation.get(), 1);
        assert_eq!(request.snapshot.generation.get(), 1);
        assert_eq!(request.intent.base_generation.get(), 1);
        assert_eq!(durable_intent, before);
    }

    fn declaration_graph(name_children: Vec<NodeRecord>) -> GraphGeneration {
        let mut nodes = vec![
            node("module", "Module", None, None, "src/user.ts"),
            node(
                "user",
                "InterfaceDeclaration",
                Some("module"),
                Some(0),
                "/** User is documented here. */\nexport interface User { id: string; }",
            ),
        ];
        nodes.extend(name_children);
        GraphGeneration::from_snapshot(GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes,
            references: vec![],
        })
        .unwrap()
    }

    fn rename_facts(name_id: &str) -> SemanticFacts {
        let mut validation_dependency_node_ids =
            vec!["module".into(), "user".into(), name_id.into()];
        validation_dependency_node_ids.sort();
        SemanticFacts::RenameSymbol {
            declaration_id: "user".into(),
            declaration_name_identifier_id: name_id.into(),
            references: vec![],
            writable_statement_ids: vec!["user".into()],
            validation_dependency_node_ids,
            validation_dependency_reference_from_node_ids: vec![],
        }
    }

    fn rename_user_intent() -> IntentRecord {
        IntentRecord::new(
            SCHEMA_VERSION,
            "intent:rename-user",
            "change:rename-user",
            0,
            IntentParameters::RenameSymbol {
                declaration_id: "user".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn declaration_name_uses_the_exact_payload_token_not_a_colliding_child() {
        let payload = "/** User is documented here. */\nexport interface User { id: string; }";
        let name_offset = payload.rfind("User").unwrap();
        let graph = declaration_graph(vec![
            node(
                "a-decoy",
                "Identifier",
                Some("user"),
                None,
                r#"{"text":"User","offset":4}"#,
            ),
            node(
                "name",
                "Identifier",
                Some("user"),
                None,
                &format!(r#"{{"text":"User","offset":{name_offset}}}"#),
            ),
            node(
                "member",
                "Identifier",
                Some("user"),
                None,
                r#"{"text":"id","offset":60}"#,
            ),
        ]);

        let error =
            intent_analysis_from_facts(&graph, &rename_user_intent(), rename_facts("a-decoy"))
                .unwrap_err();
        assert!(
            error.to_string().contains("declaration name"),
            "unexpected error: {error:#}"
        );

        let analysis =
            intent_analysis_from_facts(&graph, &rename_user_intent(), rename_facts("name"))
                .unwrap();
        assert!(
            analysis
                .write_set
                .iter()
                .any(|resource| { resource.resource_key == "namespace:module:User" })
        );
    }

    #[test]
    fn declaration_name_rejects_malformed_and_ambiguous_identifier_payloads() {
        let payload = "/** User is documented here. */\nexport interface User { id: string; }";
        let name_offset = payload.rfind("User").unwrap();
        let malformed = declaration_graph(vec![node(
            "name",
            "Identifier",
            Some("user"),
            None,
            r#"{"text":"User","offset":"not-a-number"}"#,
        )]);
        let error =
            intent_analysis_from_facts(&malformed, &rename_user_intent(), rename_facts("name"))
                .unwrap_err();
        assert!(
            error.to_string().contains("malformed"),
            "unexpected error: {error:#}"
        );

        let exact_payload = format!(r#"{{"text":"User","offset":{name_offset}}}"#);
        let ambiguous = declaration_graph(vec![
            node("name-a", "Identifier", Some("user"), None, &exact_payload),
            node("name-b", "Identifier", Some("user"), None, &exact_payload),
        ]);
        let error =
            intent_analysis_from_facts(&ambiguous, &rename_user_intent(), rename_facts("name-a"))
                .unwrap_err();
        assert!(
            error.to_string().contains("ambiguous"),
            "unexpected error: {error:#}"
        );
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
