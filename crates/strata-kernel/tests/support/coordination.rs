use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use strata_kernel::{
    BeginChangeSet, CandidateBuilder, ChangeSetRecord, DynamicExpansionPolicy, GraphChange,
    GraphDelta, GraphGeneration, GraphSnapshot, IdempotencyClass, IntentAnalysis, IntentParameters,
    IntentRecord, Kernel, NodeRecord, ReferenceRecord, ResourceVersion, SCHEMA_VERSION,
    TestSemanticProvider,
};

const SNAPSHOT_JSON: &str = include_str!("../fixtures/examples-medium.snapshot.json");

#[derive(Clone)]
pub struct MediumCoordinationFixture {
    snapshot: GraphSnapshot,
}

impl MediumCoordinationFixture {
    pub fn load() -> Self {
        Self {
            snapshot: serde_json::from_str(SNAPSHOT_JSON)
                .expect("examples/medium Rust snapshot must remain valid"),
        }
    }

    pub fn snapshot(&self) -> &GraphSnapshot {
        &self.snapshot
    }

    pub fn declaration_named(&self, name: &str) -> &NodeRecord {
        self.snapshot
            .nodes
            .iter()
            .find(|node| declaration_name(node).as_deref() == Some(name))
            .unwrap_or_else(|| panic!("missing declaration {name} in examples/medium"))
    }

    pub fn top_level_declarations(&self) -> impl Iterator<Item = &NodeRecord> {
        self.snapshot.nodes.iter().filter(|node| {
            matches!(
                node.kind.as_str(),
                "FunctionDeclaration" | "InterfaceDeclaration" | "ClassDeclaration"
            )
        })
    }

    pub fn reference_source_for(&self, name: &str) -> &NodeRecord {
        let declaration = self.declaration_named(name);
        let declaration_name = declaration_name(declaration).unwrap();
        let identifier = self
            .snapshot
            .nodes
            .iter()
            .find(|node| {
                node.parent_id.as_deref() == Some(declaration.id.as_str())
                    && identifier_text(node).as_deref() == Some(declaration_name.as_str())
            })
            .unwrap();
        let source_id = &self
            .snapshot
            .references
            .iter()
            .find(|reference| reference.to_node_id == identifier.id)
            .unwrap_or_else(|| panic!("{name} has no real reference source"))
            .from_node_id;
        self.snapshot
            .nodes
            .iter()
            .find(|node| node.id == *source_id)
            .unwrap()
    }
}

#[derive(Clone, Debug)]
pub struct ScriptedCallsite {
    pub function_id: String,
    pub node_id: String,
    pub appears_after_generation: u64,
}

#[derive(Clone, Default)]
pub struct GraphDerivedAnalyzer {
    scripted_callsite: Option<ScriptedCallsite>,
}

impl GraphDerivedAnalyzer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_scripted_callsite(scripted_callsite: ScriptedCallsite) -> Self {
        Self {
            scripted_callsite: Some(scripted_callsite),
        }
    }
}

impl TestSemanticProvider for GraphDerivedAnalyzer {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        match &intent.parameters {
            IntentParameters::RenameSymbol {
                declaration_id,
                new_name,
            } => self.analyze_rename(graph, declaration_id, new_name),
            IntentParameters::AddParameter { function_id, .. } => {
                self.analyze_add_parameter(graph, function_id)
            }
        }
    }
}

impl GraphDerivedAnalyzer {
    fn analyze_rename(
        &self,
        graph: &GraphGeneration,
        declaration_id: &str,
        new_name: &str,
    ) -> Result<IntentAnalysis> {
        let target = graph
            .node(declaration_id)
            .with_context(|| format!("unknown declaration ID {declaration_id}"))?;
        ensure_declaration(target, declaration_id)?;
        let declaration_identifier = declaration_identifier(graph, target)?;

        let mut scope = ScopeParts::default();
        scope.read_node(graph, target)?;
        scope.write_node(graph, target)?;
        scope.read_node(graph, declaration_identifier)?;
        scope.write_node(graph, declaration_identifier)?;
        scope.reserve(format!("symbol:{declaration_id}"));

        let old_name = declaration_name(target)
            .with_context(|| format!("cannot derive declaration name for {declaration_id}"))?;
        let container = target.parent_id.as_deref().unwrap_or("root");
        for name in [old_name.as_str(), new_name] {
            scope.write_semantic_index(format!("namespace:{container}:{name}"))?;
            scope.write_semantic_index(format!("absence:{}:{container}:{name}", target.kind))?;
        }

        for reference in graph.references_to(&declaration_identifier.id) {
            scope.read_reference(reference)?;
            let source = graph.node(&reference.from_node_id).with_context(|| {
                format!("reference source {} is missing", reference.from_node_id)
            })?;
            scope.read_node(graph, source)?;
            scope.write_node(graph, source)?;
        }
        Ok(scope.finish(IdempotencyClass::RequiresDecision))
    }

    fn analyze_add_parameter(
        &self,
        graph: &GraphGeneration,
        function_id: &str,
    ) -> Result<IntentAnalysis> {
        let function = graph
            .node(function_id)
            .with_context(|| format!("unknown function ID {function_id}"))?;
        if function.kind != "FunctionDeclaration" {
            bail!(
                "node {function_id} is {}, not a function declaration",
                function.kind
            );
        }
        let function_identifier = declaration_identifier(graph, function)?;

        let snapshot = graph.snapshot();
        let outgoing: BTreeMap<_, _> = snapshot
            .references
            .iter()
            .map(|reference| (reference.from_node_id.as_str(), reference))
            .collect();
        let children: Vec<_> = snapshot
            .nodes
            .iter()
            .filter(|node| node.parent_id.as_deref() == Some(function_id))
            .collect();

        let mut scope = ScopeParts::default();
        scope.read_node(graph, function)?;
        scope.write_node(graph, function)?;
        scope.read_node(graph, function_identifier)?;
        scope.write_node(graph, function_identifier)?;
        scope.reserve(format!("symbol:{function_id}"));

        // Call sites are discovered from the graph's reverse reference index, never from an
        // intent-ID fixture or a client-provided key list.
        for reference in graph.references_to(&function_identifier.id) {
            scope.read_reference(reference)?;
            let source = graph.node(&reference.from_node_id).with_context(|| {
                format!("callsite source {} is missing", reference.from_node_id)
            })?;
            scope.read_node(graph, source)?;
            scope.write_node(graph, source)?;
        }

        // References originating inside the function body are read dependencies. Including their
        // endpoint nodes is what makes AddParameter(function-with-User-reference) overlap a User
        // rename without either client naming the shared resource.
        for child in children {
            if let Some(reference) = outgoing.get(child.id.as_str()) {
                scope.read_reference(reference)?;
                scope.read_node(graph, child)?;
                let target = graph.node(&reference.to_node_id).with_context(|| {
                    format!("reference target {} is missing", reference.to_node_id)
                })?;
                scope.read_node(graph, target)?;
            }
        }

        if let Some(scripted) = self.scripted_callsite.as_ref().filter(|scripted| {
            scripted.function_id == function_id
                && graph.generation() >= scripted.appears_after_generation
        }) {
            let source = graph.node(&scripted.node_id).with_context(|| {
                format!("scripted callsite node {} is missing", scripted.node_id)
            })?;
            scope.read_node_at_generation(graph, source, scripted.appears_after_generation)?;
            scope.write_node_at_generation(graph, source, scripted.appears_after_generation)?;
        }

        Ok(scope.finish(IdempotencyClass::ReplaySafe))
    }
}

#[derive(Default)]
struct ScopeParts {
    read_set: Vec<ResourceVersion>,
    write_set: Vec<ResourceVersion>,
    validation_set: Vec<ResourceVersion>,
    reservation_keys: BTreeSet<String>,
}

impl ScopeParts {
    fn read_node(&mut self, graph: &GraphGeneration, node: &NodeRecord) -> Result<()> {
        self.read_node_at_generation(graph, node, 0)
    }

    fn read_node_at_generation(
        &mut self,
        graph: &GraphGeneration,
        node: &NodeRecord,
        appeared_at_generation: u64,
    ) -> Result<()> {
        let resource = node_resource(node, appeared_at_generation)?;
        self.read_set.push(resource.clone());
        self.validation_set.push(resource);
        self.reserve_node_and_parent(graph, node);
        Ok(())
    }

    fn write_node(&mut self, graph: &GraphGeneration, node: &NodeRecord) -> Result<()> {
        self.write_node_at_generation(graph, node, 0)
    }

    fn write_node_at_generation(
        &mut self,
        graph: &GraphGeneration,
        node: &NodeRecord,
        appeared_at_generation: u64,
    ) -> Result<()> {
        self.write_set
            .push(node_resource(node, appeared_at_generation)?);
        self.reserve_node_and_parent(graph, node);
        Ok(())
    }

    fn read_reference(&mut self, reference: &ReferenceRecord) -> Result<()> {
        let resource = ResourceVersion::new(
            format!("edge:{}", reference.from_node_id),
            hash_json(reference)?,
        )
        .map_err(anyhow::Error::msg)?;
        self.read_set.push(resource.clone());
        self.validation_set.push(resource);
        self.reserve(format!("node:{}", reference.from_node_id));
        self.reserve(format!("node:{}", reference.to_node_id));
        Ok(())
    }

    fn write_semantic_index(&mut self, resource_key: String) -> Result<()> {
        let resource =
            ResourceVersion::new(resource_key, "semantic-index").map_err(anyhow::Error::msg)?;
        self.write_set.push(resource.clone());
        self.validation_set.push(resource);
        Ok(())
    }

    fn reserve_node_and_parent(&mut self, _graph: &GraphGeneration, node: &NodeRecord) {
        self.reserve(format!("node:{}", node.id));
        if let Some(parent_id) = &node.parent_id {
            self.reserve(format!("node:{parent_id}"));
        }
    }

    fn reserve(&mut self, key: String) {
        self.reservation_keys.insert(key);
    }

    fn finish(self, idempotency_class: IdempotencyClass) -> IntentAnalysis {
        IntentAnalysis {
            read_set: self.read_set,
            write_set: self.write_set,
            validation_set: self.validation_set,
            reservation_keys: self.reservation_keys.into_iter().collect(),
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class,
        }
    }
}

fn node_resource(node: &NodeRecord, appeared_at_generation: u64) -> Result<ResourceVersion> {
    // Existing resources keep content-addressed versions across unrelated generations. The only
    // allowed scripted interleaving records the generation at which a real extra callsite becomes
    // visible, so expansion is additive rather than a global-version replacement.
    let version = hash_json(&(node, appeared_at_generation))?;
    ResourceVersion::new(format!("node:{}", node.id), version).map_err(anyhow::Error::msg)
}

fn hash_json(value: &impl serde::Serialize) -> Result<String> {
    let digest = Sha256::digest(serde_json::to_vec(value)?);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn ensure_declaration(node: &NodeRecord, node_id: &str) -> Result<()> {
    if !matches!(
        node.kind.as_str(),
        "FunctionDeclaration" | "InterfaceDeclaration" | "ClassDeclaration"
    ) {
        bail!(
            "node {node_id} is {}, not a supported declaration",
            node.kind
        );
    }
    Ok(())
}

fn declaration_identifier<'a>(
    graph: &'a GraphGeneration,
    declaration: &NodeRecord,
) -> Result<&'a NodeRecord> {
    let name = declaration_name(declaration)
        .with_context(|| format!("cannot derive declaration name for {}", declaration.id))?;
    graph
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.parent_id.as_deref() == Some(declaration.id.as_str())
                && node.kind == "Identifier"
                && identifier_text(node).as_deref() == Some(name.as_str())
        })
        .and_then(|node| graph.node(&node.id))
        .with_context(|| format!("declaration {} has no identifier child", declaration.id))
}

pub fn declaration_name(node: &NodeRecord) -> Option<String> {
    for marker in ["interface ", "function ", "class "] {
        let Some((_, rest)) = node.payload.split_once(marker) else {
            continue;
        };
        let rest = rest.trim_start();
        let name: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '$')
            .collect();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

fn identifier_text(node: &NodeRecord) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&node.payload)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_owned)
}

pub fn begin_with_intents(
    kernel: &Kernel,
    change_set_id: &str,
    intents: impl IntoIterator<Item = IntentParameters>,
) -> Result<ChangeSetRecord> {
    let change_set = kernel.begin_change_set(BeginChangeSet {
        change_set_id: change_set_id.to_owned(),
        actor: format!("agent:{change_set_id}"),
        reasoning: format!("deterministic acceptance scenario {change_set_id}"),
        submission_idempotency_key: format!("submission:{change_set_id}"),
    })?;
    for parameters in intents {
        kernel.add_intent(change_set_id, parameters)?;
    }
    Ok(change_set)
}

pub fn rename(declaration_id: &str, new_name: &str) -> IntentParameters {
    IntentParameters::RenameSymbol {
        declaration_id: declaration_id.to_owned(),
        new_name: new_name.to_owned(),
    }
}

pub fn add_parameter(function_id: &str) -> IntentParameters {
    IntentParameters::AddParameter {
        function_id: function_id.to_owned(),
        name: "traceId".into(),
        type_text: "string".into(),
        position: 0,
        default_value: Some("\"test\"".into()),
    }
}

pub struct NodePatchBuilder {
    patches: Vec<(String, String)>,
    calls: Arc<AtomicUsize>,
}

impl NodePatchBuilder {
    pub fn new(patches: Vec<(String, String)>) -> Self {
        Self {
            patches,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CandidateBuilder for NodePatchBuilder {
    fn build_candidate(
        &self,
        graph: &GraphGeneration,
        _change_set: &ChangeSetRecord,
        _intents: &[IntentRecord],
    ) -> Result<GraphDelta> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let changes = self
            .patches
            .iter()
            .map(|(node_id, marker)| {
                let mut node = graph
                    .node(node_id)
                    .with_context(|| format!("patch node {node_id} does not exist"))?
                    .clone();
                node.payload.push_str(marker);
                Ok(GraphChange::UpsertNode { node })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: graph.generation(),
            changes,
        })
    }
}

pub struct FixedDeltaBuilder(pub GraphDelta);

impl CandidateBuilder for FixedDeltaBuilder {
    fn build_candidate(
        &self,
        _graph: &GraphGeneration,
        _change_set: &ChangeSetRecord,
        _intents: &[IntentRecord],
    ) -> Result<GraphDelta> {
        Ok(self.0.clone())
    }
}

pub struct FailingProbeBuilder {
    calls: AtomicUsize,
}

impl FailingProbeBuilder {
    pub fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CandidateBuilder for FailingProbeBuilder {
    fn build_candidate(
        &self,
        _graph: &GraphGeneration,
        _change_set: &ChangeSetRecord,
        _intents: &[IntentRecord],
    ) -> Result<GraphDelta> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        bail!("probe candidate reached after claim validation")
    }
}
