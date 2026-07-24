use crate::{GraphChange, GraphDelta, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION};
use anyhow::{Context, Result, bail, ensure};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fmt;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
const MAX_ARRAY_ITEMS: usize = 1_000_000;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct WireU64(u64);

impl WireU64 {
    pub(crate) const fn new(value: u64) -> Self {
        Self(value)
    }

    pub(crate) const fn get(self) -> u64 {
        self.0
    }
}

impl From<u64> for WireU64 {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl Serialize for WireU64 {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

struct WireU64Visitor;

impl Visitor<'_> for WireU64Visitor {
    type Value = WireU64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a canonical unsigned 64-bit decimal string")
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(E::custom(
                "expected a canonical unsigned 64-bit decimal string",
            ));
        }
        value
            .parse::<u64>()
            .map(WireU64)
            .map_err(|_| E::custom("unsigned decimal string exceeds u64"))
    }
}

impl<'de> Deserialize<'de> for WireU64 {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(WireU64Visitor)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hash64(String);

impl Hash64 {
    pub(crate) fn parse(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        ensure!(
            Self::validate(&value),
            "expected exactly 64 lowercase hexadecimal characters"
        );
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    fn validate(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

impl Serialize for Hash64 {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

struct Hash64Visitor;

impl Visitor<'_> for Hash64Visitor {
    type Value = Hash64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("exactly 64 lowercase hexadecimal characters")
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: de::Error,
    {
        if Hash64::validate(value) {
            Ok(Hash64(value.to_owned()))
        } else {
            Err(E::custom(
                "expected exactly 64 lowercase hexadecimal characters",
            ))
        }
    }
}

impl<'de> Deserialize<'de> for Hash64 {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(Hash64Visitor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct True;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct False;

macro_rules! literal_bool {
    ($name:ty, $value:expr) => {
        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_bool($value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = bool::deserialize(deserializer)?;
                if value == $value {
                    Ok(Self)
                } else {
                    Err(de::Error::custom(concat!("expected ", stringify!($value))))
                }
            }
        }
    };
}

literal_bool!(True, true);
literal_bool!(False, false);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BridgeKind {
    AnalyzeIntent,
    BuildValidateCandidate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BridgeBinding {
    pub(crate) service_epoch: WireU64,
    pub(crate) graph_generation: WireU64,
    pub(crate) graph_digest: Hash64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateBinding {
    pub(crate) service_epoch: WireU64,
    pub(crate) graph_generation: WireU64,
    pub(crate) graph_digest: Hash64,
    pub(crate) attempt_id: String,
    pub(crate) scope_fingerprint: Hash64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireNode {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) child_index: Option<u64>,
    pub(crate) payload: String,
}

impl WireNode {
    fn validate(&self, context: &str) -> Result<()> {
        non_empty(&self.id, &format!("{context}.id"))?;
        non_empty(&self.kind, &format!("{context}.kind"))?;
        if let Some(parent_id) = &self.parent_id {
            non_empty(parent_id, &format!("{context}.parentId"))?;
        }
        if let Some(child_index) = self.child_index {
            ensure!(
                child_index <= MAX_SAFE_JSON_INTEGER,
                "{context}.childIndex is not a safe JSON integer"
            );
        }
        Ok(())
    }

    fn to_node_record(&self) -> NodeRecord {
        NodeRecord {
            id: self.id.clone(),
            kind: self.kind.clone(),
            parent_id: self.parent_id.clone(),
            child_index: self.child_index.map(|value| value as i64),
            payload: self.payload.clone(),
        }
    }

    fn from_node_record(node: &NodeRecord) -> Result<Self> {
        let child_index = node
            .child_index
            .map(|value| u64::try_from(value).context("node childIndex must not be negative"))
            .transpose()?;
        Ok(Self {
            id: node.id.clone(),
            kind: node.kind.clone(),
            parent_id: node.parent_id.clone(),
            child_index,
            payload: node.payload.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireReference {
    pub(crate) from_node_id: String,
    pub(crate) to_node_id: String,
    pub(crate) kind: String,
}

impl WireReference {
    fn validate(&self, context: &str) -> Result<()> {
        non_empty(&self.from_node_id, &format!("{context}.fromNodeId"))?;
        non_empty(&self.to_node_id, &format!("{context}.toNodeId"))?;
        non_empty(&self.kind, &format!("{context}.kind"))
    }

    pub(crate) fn to_reference_record(&self) -> ReferenceRecord {
        ReferenceRecord {
            from_node_id: self.from_node_id.clone(),
            to_node_id: self.to_node_id.clone(),
            kind: self.kind.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireSnapshot {
    pub(crate) schema_version: u32,
    pub(crate) generation: WireU64,
    pub(crate) nodes: Vec<WireNode>,
    pub(crate) references: Vec<WireReference>,
}

impl WireSnapshot {
    pub(crate) fn from_graph_snapshot(snapshot: &GraphSnapshot) -> Result<Self> {
        let nodes = snapshot
            .nodes
            .iter()
            .map(WireNode::from_node_record)
            .collect::<Result<Vec<_>>>()?;
        let wire = Self {
            schema_version: snapshot.schema_version,
            generation: snapshot.generation.into(),
            nodes,
            references: snapshot
                .references
                .iter()
                .map(|reference| WireReference {
                    from_node_id: reference.from_node_id.clone(),
                    to_node_id: reference.to_node_id.clone(),
                    kind: reference.kind.clone(),
                })
                .collect(),
        };
        wire.validate()?;
        Ok(wire)
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == SCHEMA_VERSION,
            "unsupported snapshot schema version {}",
            self.schema_version
        );
        bounded_len("snapshot.nodes", self.nodes.len())?;
        bounded_len("snapshot.references", self.references.len())?;

        let mut node_ids = BTreeSet::new();
        for (index, node) in self.nodes.iter().enumerate() {
            node.validate(&format!("snapshot.nodes[{index}]"))?;
            ensure!(
                node_ids.insert(node.id.clone()),
                "duplicate node ID {}",
                node.id
            );
            if let Some(previous) = index.checked_sub(1).map(|value| &self.nodes[value]) {
                ensure!(
                    compare_code_units(&previous.id, &node.id) == Ordering::Less,
                    "snapshot nodes are not in canonical ID order"
                );
            }
        }
        for node in &self.nodes {
            if let Some(parent_id) = &node.parent_id {
                ensure!(
                    node_ids.contains(parent_id),
                    "node {} has dangling parent {parent_id}",
                    node.id
                );
            }
        }

        let mut reference_sources = BTreeSet::new();
        for (index, reference) in self.references.iter().enumerate() {
            reference.validate(&format!("snapshot.references[{index}]"))?;
            ensure!(
                reference_sources.insert(reference.from_node_id.clone()),
                "duplicate reference source {}",
                reference.from_node_id
            );
            ensure!(
                node_ids.contains(&reference.from_node_id)
                    && node_ids.contains(&reference.to_node_id),
                "reference {} has a dangling endpoint",
                reference.from_node_id
            );
            if let Some(previous) = index.checked_sub(1).map(|value| &self.references[value]) {
                ensure!(
                    compare_references(previous, reference) == Ordering::Less,
                    "snapshot references are not in canonical order"
                );
            }
        }
        Ok(())
    }

    pub(crate) fn to_graph_snapshot(&self) -> Result<GraphSnapshot> {
        self.validate()?;
        Ok(GraphSnapshot {
            schema_version: self.schema_version,
            generation: self.generation.get(),
            nodes: self.nodes.iter().map(WireNode::to_node_record).collect(),
            references: self
                .references
                .iter()
                .map(WireReference::to_reference_record)
                .collect(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum IntentParameters {
    RenameSymbol {
        declaration_id: String,
        new_name: String,
    },
    AddParameter {
        function_id: String,
        name: String,
        type_text: String,
        position: u32,
        default_value: Option<String>,
    },
}

impl IntentParameters {
    fn validate(&self, context: &str) -> Result<()> {
        match self {
            Self::RenameSymbol { declaration_id, .. } => {
                non_empty(declaration_id, &format!("{context}.declarationId"))
            }
            Self::AddParameter { function_id, .. } => {
                non_empty(function_id, &format!("{context}.functionId"))
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntentRecord {
    pub(crate) schema_version: u32,
    pub(crate) intent_id: String,
    pub(crate) change_set_id: String,
    pub(crate) base_generation: WireU64,
    pub(crate) parameters: IntentParameters,
}

impl IntentRecord {
    fn validate(&self, context: &str) -> Result<()> {
        ensure!(
            self.schema_version == SCHEMA_VERSION,
            "{context}.schemaVersion is unsupported"
        );
        non_empty(&self.intent_id, &format!("{context}.intentId"))?;
        non_empty(&self.change_set_id, &format!("{context}.changeSetId"))?;
        self.parameters.validate(&format!("{context}.parameters"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ValidationProfile {
    TscOnly {
        source_root: String,
        corpus_root: String,
        behavioral_fixtures: Vec<String>,
        strict_src_only_tsc_scope: bool,
    },
    Behavioral {
        source_root: String,
        corpus_root: String,
        behavioral_fixtures: Vec<String>,
        strict_src_only_tsc_scope: bool,
    },
}

impl ValidationProfile {
    pub(crate) fn tsc_only(
        source_root: impl Into<String>,
        corpus_root: impl Into<String>,
        strict_src_only_tsc_scope: bool,
    ) -> Self {
        Self::TscOnly {
            source_root: source_root.into(),
            corpus_root: corpus_root.into(),
            behavioral_fixtures: Vec::new(),
            strict_src_only_tsc_scope,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::TscOnly {
                source_root,
                corpus_root,
                behavioral_fixtures,
                ..
            } => {
                non_empty(source_root, "validationProfile.sourceRoot")?;
                non_empty(corpus_root, "validationProfile.corpusRoot")?;
                ensure!(
                    behavioral_fixtures.is_empty(),
                    "tscOnly validation profile cannot contain behavioral fixtures"
                );
            }
            Self::Behavioral {
                source_root,
                corpus_root,
                behavioral_fixtures,
                ..
            } => {
                non_empty(source_root, "validationProfile.sourceRoot")?;
                non_empty(corpus_root, "validationProfile.corpusRoot")?;
                bounded_len(
                    "validationProfile.behavioralFixtures",
                    behavioral_fixtures.len(),
                )?;
                for (index, fixture) in behavioral_fixtures.iter().enumerate() {
                    non_empty(
                        fixture,
                        &format!("validationProfile.behavioralFixtures[{index}]"),
                    )?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangeSet {
    pub(crate) change_set_id: String,
    pub(crate) actor: String,
    pub(crate) reasoning: String,
    pub(crate) ordered_intents: Vec<IntentRecord>,
}

impl ChangeSet {
    fn validate(&self, generation: WireU64) -> Result<()> {
        non_empty(&self.change_set_id, "changeSet.changeSetId")?;
        non_empty(&self.actor, "changeSet.actor")?;
        ensure!(
            !self.ordered_intents.is_empty(),
            "changeSet.orderedIntents must not be empty"
        );
        bounded_len("changeSet.orderedIntents", self.ordered_intents.len())?;
        let mut intent_ids = BTreeSet::new();
        for (index, intent) in self.ordered_intents.iter().enumerate() {
            intent.validate(&format!("changeSet.orderedIntents[{index}]"))?;
            ensure!(
                intent_ids.insert(intent.intent_id.clone()),
                "duplicate intent ID {}",
                intent.intent_id
            );
            ensure!(
                intent.change_set_id == self.change_set_id,
                "intent change set ID does not match enclosing change set"
            );
            ensure!(
                intent.base_generation == generation,
                "intent base generation does not match snapshot"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalyzeIntentRequest {
    pub(crate) protocol_version: u32,
    pub(crate) request_id: String,
    pub(crate) kind: BridgeKind,
    pub(crate) binding: BridgeBinding,
    pub(crate) snapshot: WireSnapshot,
    pub(crate) intent: IntentRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BuildValidateCandidateRequest {
    pub(crate) protocol_version: u32,
    pub(crate) request_id: String,
    pub(crate) kind: BridgeKind,
    pub(crate) binding: BridgeBinding,
    pub(crate) snapshot: WireSnapshot,
    pub(crate) attempt_id: String,
    pub(crate) scope_fingerprint: Hash64,
    pub(crate) change_set: ChangeSet,
    pub(crate) validation_profile: ValidationProfile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum BridgeRequest {
    AnalyzeIntent(AnalyzeIntentRequest),
    BuildValidateCandidate(BuildValidateCandidateRequest),
}

impl BridgeRequest {
    fn validate(&self) -> Result<()> {
        match self {
            Self::AnalyzeIntent(request) => {
                validate_request_header(
                    request.protocol_version,
                    &request.request_id,
                    request.kind,
                    BridgeKind::AnalyzeIntent,
                    &request.binding,
                    &request.snapshot,
                )?;
                request.intent.validate("intent")?;
                ensure!(
                    request.intent.base_generation == request.snapshot.generation,
                    "intent base generation does not match snapshot"
                );
            }
            Self::BuildValidateCandidate(request) => {
                validate_request_header(
                    request.protocol_version,
                    &request.request_id,
                    request.kind,
                    BridgeKind::BuildValidateCandidate,
                    &request.binding,
                    &request.snapshot,
                )?;
                non_empty(&request.attempt_id, "attemptId")?;
                request.change_set.validate(request.snapshot.generation)?;
                request.validation_profile.validate()?;
            }
        }
        Ok(())
    }

    /// The request's own correlation id. `pub(crate)` for the persistent
    /// scaffold transport, which correlates frames on this id so the wire
    /// request body stays byte-identical to the one-shot path's.
    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::AnalyzeIntent(request) => &request.request_id,
            Self::BuildValidateCandidate(request) => &request.request_id,
        }
    }

    fn kind(&self) -> BridgeKind {
        match self {
            Self::AnalyzeIntent(_) => BridgeKind::AnalyzeIntent,
            Self::BuildValidateCandidate(_) => BridgeKind::BuildValidateCandidate,
        }
    }

    /// Observability label for the request kind: `"analyzeIntent"` or
    /// `"buildValidateCandidate"`. Purely for run records; never used by
    /// binding or protocol validation.
    pub(crate) fn observed_kind(&self) -> &'static str {
        match self {
            Self::AnalyzeIntent(_) => "analyzeIntent",
            Self::BuildValidateCandidate(_) => "buildValidateCandidate",
        }
    }

    /// The change set the request belongs to: the intent's change set for an
    /// analyze request, the candidate's change set for a build request.
    pub(crate) fn change_set_id(&self) -> &str {
        match self {
            Self::AnalyzeIntent(request) => &request.intent.change_set_id,
            Self::BuildValidateCandidate(request) => &request.change_set.change_set_id,
        }
    }

    fn binding(&self) -> &BridgeBinding {
        match self {
            Self::AnalyzeIntent(request) => &request.binding,
            Self::BuildValidateCandidate(request) => &request.binding,
        }
    }
}

fn validate_request_header(
    protocol_version: u32,
    request_id: &str,
    actual_kind: BridgeKind,
    expected_kind: BridgeKind,
    binding: &BridgeBinding,
    snapshot: &WireSnapshot,
) -> Result<()> {
    ensure!(
        protocol_version == PROTOCOL_VERSION,
        "unsupported bridge protocol version {protocol_version}"
    );
    non_empty(request_id, "requestId")?;
    ensure!(
        actual_kind == expected_kind,
        "request kind does not match schema"
    );
    snapshot.validate()?;
    ensure!(
        binding.graph_generation == snapshot.generation,
        "snapshot generation does not match binding"
    );
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BridgeDiagnostic {
    pub(crate) node_id: Option<String>,
    pub(crate) module_path: Option<String>,
    pub(crate) message: String,
    pub(crate) code: i64,
}

impl BridgeDiagnostic {
    fn validate(&self, context: &str) -> Result<()> {
        if let Some(node_id) = &self.node_id {
            non_empty(node_id, &format!("{context}.nodeId"))?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SemanticFacts {
    RenameSymbol {
        declaration_id: String,
        declaration_name_identifier_id: String,
        references: Vec<WireReference>,
        writable_statement_ids: Vec<String>,
        validation_dependency_node_ids: Vec<String>,
        validation_dependency_reference_from_node_ids: Vec<String>,
    },
    AddParameter {
        function_id: String,
        declaration_name_identifier_id: String,
        direct_call_references: Vec<WireReference>,
        writable_statement_ids: Vec<String>,
        arity_risk_references: Vec<WireReference>,
        arity_risk_statement_ids: Vec<String>,
        unresolved_reference_diagnostics: Vec<BridgeDiagnostic>,
        function_body_read_references: Vec<WireReference>,
        /// Module-level declarations the intent's typeText/defaultValue will
        /// reference once executed (spec 2026-07-17 Change 2). Default keeps
        /// pre-narrowing analyzers parseable.
        #[serde(default)]
        content_dependency_declaration_ids: Vec<String>,
        validation_dependency_node_ids: Vec<String>,
        validation_dependency_reference_from_node_ids: Vec<String>,
    },
}

impl SemanticFacts {
    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::RenameSymbol {
                declaration_id,
                declaration_name_identifier_id,
                references,
                writable_statement_ids,
                validation_dependency_node_ids,
                validation_dependency_reference_from_node_ids,
            } => {
                non_empty(declaration_id, "facts.declarationId")?;
                non_empty(
                    declaration_name_identifier_id,
                    "facts.declarationNameIdentifierId",
                )?;
                validate_reference_array("facts.references", references)?;
                validate_id_array("facts.writableStatementIds", writable_statement_ids)?;
                validate_id_array(
                    "facts.validationDependencyNodeIds",
                    validation_dependency_node_ids,
                )?;
                validate_id_array(
                    "facts.validationDependencyReferenceFromNodeIds",
                    validation_dependency_reference_from_node_ids,
                )?;
            }
            Self::AddParameter {
                function_id,
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
            } => {
                non_empty(function_id, "facts.functionId")?;
                non_empty(
                    declaration_name_identifier_id,
                    "facts.declarationNameIdentifierId",
                )?;
                validate_reference_array("facts.directCallReferences", direct_call_references)?;
                validate_id_array("facts.writableStatementIds", writable_statement_ids)?;
                validate_reference_array("facts.arityRiskReferences", arity_risk_references)?;
                validate_id_array("facts.arityRiskStatementIds", arity_risk_statement_ids)?;
                bounded_len(
                    "facts.unresolvedReferenceDiagnostics",
                    unresolved_reference_diagnostics.len(),
                )?;
                for (index, diagnostic) in unresolved_reference_diagnostics.iter().enumerate() {
                    diagnostic
                        .validate(&format!("facts.unresolvedReferenceDiagnostics[{index}]"))?;
                }
                validate_reference_array(
                    "facts.functionBodyReadReferences",
                    function_body_read_references,
                )?;
                validate_id_array(
                    "facts.contentDependencyDeclarationIds",
                    content_dependency_declaration_ids,
                )?;
                validate_id_array(
                    "facts.validationDependencyNodeIds",
                    validation_dependency_node_ids,
                )?;
                validate_id_array(
                    "facts.validationDependencyReferenceFromNodeIds",
                    validation_dependency_reference_from_node_ids,
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WireGraphChange {
    UpsertNode { node: WireNode },
    DeleteNode { node_id: String },
    UpsertReference { reference: WireReference },
    DeleteReference { from_node_id: String },
}

impl WireGraphChange {
    fn validate(&self, context: &str) -> Result<()> {
        match self {
            Self::UpsertNode { node } => node.validate(context),
            Self::DeleteNode { node_id } => non_empty(node_id, context),
            Self::UpsertReference { reference } => reference.validate(context),
            Self::DeleteReference { from_node_id } => non_empty(from_node_id, context),
        }
    }

    fn to_graph_change(&self) -> GraphChange {
        match self {
            Self::UpsertNode { node } => GraphChange::UpsertNode {
                node: node.to_node_record(),
            },
            Self::DeleteNode { node_id } => GraphChange::DeleteNode {
                node_id: node_id.clone(),
            },
            Self::UpsertReference { reference } => GraphChange::UpsertReference {
                reference: reference.to_reference_record(),
            },
            Self::DeleteReference { from_node_id } => GraphChange::DeleteReference {
                from_node_id: from_node_id.clone(),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WireGraphDelta {
    pub(crate) schema_version: u32,
    pub(crate) base_generation: WireU64,
    pub(crate) changes: Vec<WireGraphChange>,
}

impl WireGraphDelta {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == SCHEMA_VERSION,
            "unsupported delta schema version {}",
            self.schema_version
        );
        bounded_len("delta.changes", self.changes.len())?;
        for (index, change) in self.changes.iter().enumerate() {
            change.validate(&format!("delta.changes[{index}]"))?;
        }
        Ok(())
    }

    pub(crate) fn to_graph_delta(&self) -> Result<GraphDelta> {
        self.validate()?;
        Ok(GraphDelta {
            schema_version: self.schema_version,
            base_generation: self.base_generation.get(),
            changes: self
                .changes
                .iter()
                .map(WireGraphChange::to_graph_change)
                .collect(),
        })
    }

    /// Wire-shape conversion of an internal delta, used by the published
    /// delta log (Task 6): the serialized form is exactly the
    /// `KernelGraphDeltaV1` JSON the Node worker's sync path parses.
    pub(crate) fn from_graph_delta(delta: &GraphDelta) -> Result<Self> {
        let changes = delta
            .changes
            .iter()
            .map(|change| {
                Ok(match change {
                    GraphChange::UpsertNode { node } => WireGraphChange::UpsertNode {
                        node: WireNode::from_node_record(node)?,
                    },
                    GraphChange::DeleteNode { node_id } => WireGraphChange::DeleteNode {
                        node_id: node_id.clone(),
                    },
                    GraphChange::UpsertReference { reference } => {
                        WireGraphChange::UpsertReference {
                            reference: WireReference {
                                from_node_id: reference.from_node_id.clone(),
                                to_node_id: reference.to_node_id.clone(),
                                kind: reference.kind.clone(),
                            },
                        }
                    }
                    GraphChange::DeleteReference { from_node_id } => {
                        WireGraphChange::DeleteReference {
                            from_node_id: from_node_id.clone(),
                        }
                    }
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let wire = Self {
            schema_version: delta.schema_version,
            base_generation: WireU64::new(delta.base_generation),
            changes,
        };
        wire.validate()?;
        Ok(wire)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ErrorStage {
    Protocol,
    Hydrate,
    Analyze,
    Mutate,
    Validate,
    Export,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BridgeErrorPayload {
    pub(crate) stage: ErrorStage,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) diagnostics: Vec<BridgeDiagnostic>,
}

impl BridgeErrorPayload {
    fn validate(&self, max_diagnostic_bytes: usize) -> Result<()> {
        non_empty(&self.code, "error.code")?;
        bounded_len("error.diagnostics", self.diagnostics.len())?;
        for (index, diagnostic) in self.diagnostics.iter().enumerate() {
            diagnostic.validate(&format!("error.diagnostics[{index}]"))?;
        }
        let bytes = serde_json::to_vec(&self.diagnostics)
            .context("serialize bridge diagnostics for bound check")?;
        ensure!(
            bytes.len() <= max_diagnostic_bytes,
            "bridge diagnostics exceed configured byte limit"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalyzeResult {
    pub(crate) facts: SemanticFacts,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateResult {
    pub(crate) delta: WireGraphDelta,
    pub(crate) diagnostics: Vec<BridgeDiagnostic>,
}

/// Per-stage timings and peak memory a worker self-reports for a bridge call.
/// Absent when a worker does not (yet) report metrics; purely observational —
/// never consulted by protocol validation or binding checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSelfMetrics {
    pub hydrate_ns: Option<u64>,
    pub analyze_ns: Option<u64>,
    pub mutate_ns: Option<u64>,
    pub validate_ns: Option<u64>,
    pub export_ns: Option<u64>,
    pub total_ns: u64,
    pub peak_rss_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalyzeSuccessResponse {
    protocol_version: u32,
    request_id: String,
    kind: BridgeKind,
    binding: BridgeBinding,
    ok: True,
    result: AnalyzeResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metrics: Option<WorkerSelfMetrics>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateSuccessResponse {
    protocol_version: u32,
    request_id: String,
    kind: BridgeKind,
    binding: CandidateBinding,
    ok: True,
    result: CandidateResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metrics: Option<WorkerSelfMetrics>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalyzeErrorResponse {
    protocol_version: u32,
    request_id: String,
    kind: BridgeKind,
    binding: BridgeBinding,
    ok: False,
    error: BridgeErrorPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metrics: Option<WorkerSelfMetrics>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateErrorResponse {
    protocol_version: u32,
    request_id: String,
    kind: BridgeKind,
    binding: CandidateBinding,
    ok: False,
    error: BridgeErrorPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metrics: Option<WorkerSelfMetrics>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum BridgeResponse {
    AnalyzeSuccess(AnalyzeSuccessResponse),
    CandidateSuccess(CandidateSuccessResponse),
    AnalyzeError(AnalyzeErrorResponse),
    CandidateError(CandidateErrorResponse),
}

impl BridgeResponse {
    pub(crate) fn into_analyze_result(self) -> Result<SemanticFacts> {
        match self {
            Self::AnalyzeSuccess(response) => Ok(response.result.facts),
            Self::AnalyzeError(response) => bail!(
                "Node bridge analysis failed at {:?}/{}: {}",
                response.error.stage,
                response.error.code,
                response.error.message
            ),
            _ => bail!("Node bridge response is not an analyzeIntent response"),
        }
    }

    pub(crate) fn into_candidate_result(self) -> Result<WireGraphDelta> {
        match self {
            Self::CandidateSuccess(response) => Ok(response.result.delta),
            Self::CandidateError(response) => bail!(
                "Node bridge candidate failed at {:?}/{}: {}",
                response.error.stage,
                response.error.code,
                response.error.message
            ),
            _ => bail!("Node bridge response is not a buildValidateCandidate response"),
        }
    }

    pub(crate) fn metrics_ref(&self) -> Option<&WorkerSelfMetrics> {
        match self {
            Self::AnalyzeSuccess(response) => response.metrics.as_ref(),
            Self::CandidateSuccess(response) => response.metrics.as_ref(),
            Self::AnalyzeError(response) => response.metrics.as_ref(),
            Self::CandidateError(response) => response.metrics.as_ref(),
        }
    }

    fn validate_binding(&self, request: &BridgeRequest) -> Result<()> {
        let (protocol_version, request_id, kind, binding) = match self {
            Self::AnalyzeSuccess(response) => (
                response.protocol_version,
                response.request_id.as_str(),
                response.kind,
                ResponseBinding::Analyze(&response.binding),
            ),
            Self::CandidateSuccess(response) => (
                response.protocol_version,
                response.request_id.as_str(),
                response.kind,
                ResponseBinding::Candidate(&response.binding),
            ),
            Self::AnalyzeError(response) => (
                response.protocol_version,
                response.request_id.as_str(),
                response.kind,
                ResponseBinding::Analyze(&response.binding),
            ),
            Self::CandidateError(response) => (
                response.protocol_version,
                response.request_id.as_str(),
                response.kind,
                ResponseBinding::Candidate(&response.binding),
            ),
        };
        ensure!(
            protocol_version == PROTOCOL_VERSION,
            "unsupported response protocol version {protocol_version}"
        );
        ensure!(
            request_id == request.request_id(),
            "response requestId mismatch"
        );
        ensure!(kind == request.kind(), "response kind mismatch");

        match (request, binding) {
            (BridgeRequest::AnalyzeIntent(expected), ResponseBinding::Analyze(actual)) => {
                ensure!(actual == &expected.binding, "response binding mismatch");
            }
            (
                BridgeRequest::BuildValidateCandidate(expected),
                ResponseBinding::Candidate(actual),
            ) => {
                ensure!(
                    actual.service_epoch == expected.binding.service_epoch
                        && actual.graph_generation == expected.binding.graph_generation
                        && actual.graph_digest == expected.binding.graph_digest
                        && actual.attempt_id == expected.attempt_id
                        && actual.scope_fingerprint == expected.scope_fingerprint,
                    "candidate response binding mismatch"
                );
            }
            _ => bail!("response schema does not match request kind"),
        }
        Ok(())
    }

    fn validate_payload(&self, request: &BridgeRequest, max_diagnostic_bytes: usize) -> Result<()> {
        match self {
            Self::AnalyzeSuccess(response) => response.result.facts.validate(),
            Self::CandidateSuccess(response) => {
                response.result.delta.validate()?;
                ensure!(
                    response.result.delta.base_generation == request.binding().graph_generation,
                    "candidate delta base generation does not match request"
                );
                ensure!(
                    response.result.diagnostics.is_empty(),
                    "successful candidate response contains diagnostics"
                );
                Ok(())
            }
            Self::AnalyzeError(response) => response.error.validate(max_diagnostic_bytes),
            Self::CandidateError(response) => response.error.validate(max_diagnostic_bytes),
        }
    }
}

enum ResponseBinding<'a> {
    Analyze(&'a BridgeBinding),
    Candidate(&'a CandidateBinding),
}

pub(crate) fn parse_bridge_request(bytes: &[u8]) -> Result<BridgeRequest> {
    let request: BridgeRequest =
        serde_json::from_slice(bytes).context("invalid bridge request JSON")?;
    request.validate()?;
    Ok(request)
}

pub(crate) fn serialize_bridge_request(request: &BridgeRequest) -> Result<Vec<u8>> {
    request.validate()?;
    serde_json::to_vec(request).context("serialize bridge request")
}

pub(crate) fn parse_bridge_response(
    bytes: &[u8],
    request: &BridgeRequest,
    max_diagnostic_bytes: usize,
) -> Result<BridgeResponse> {
    let response: BridgeResponse =
        serde_json::from_slice(bytes).context("invalid bridge response JSON or extra frame")?;
    // Bind opaque output to its exact request before validating or exposing facts/delta.
    response.validate_binding(request)?;
    response.validate_payload(request, max_diagnostic_bytes)?;
    Ok(response)
}

pub(crate) fn serialize_bridge_response(response: &BridgeResponse) -> Result<Vec<u8>> {
    serde_json::to_vec(response).context("serialize bridge response")
}

/// Binds a mirror-served analyze response (Task 6: `analyzeIntentMirror`
/// frames carry no snapshot; the worker analyzes its attested mirror) before
/// exposing the facts. The transport (`request_at`) has already correlated
/// the `requestId`; this validates protocol version, kind, the exact binding
/// echo, and the facts payload — the same checks `parse_bridge_response`
/// runs for the snapshot-carrying request, minus the request struct it
/// binds against (a mirror frame deliberately has no `WireSnapshot`).
pub(crate) fn parse_mirror_analyze_facts(
    value: serde_json::Value,
    expected_binding: &BridgeBinding,
) -> Result<SemanticFacts> {
    let response: BridgeResponse =
        serde_json::from_value(value).context("invalid mirror analyze response")?;
    match response {
        BridgeResponse::AnalyzeSuccess(inner) => {
            ensure!(
                inner.protocol_version == PROTOCOL_VERSION,
                "unsupported response protocol version {}",
                inner.protocol_version
            );
            ensure!(
                inner.kind == BridgeKind::AnalyzeIntent,
                "mirror analyze response kind mismatch"
            );
            ensure!(
                &inner.binding == expected_binding,
                "mirror analyze response binding mismatch"
            );
            inner.result.facts.validate()?;
            Ok(inner.result.facts)
        }
        BridgeResponse::AnalyzeError(inner) => {
            ensure!(
                &inner.binding == expected_binding,
                "mirror analyze error binding mismatch"
            );
            bail!(
                "Node bridge mirror analysis failed at {:?}/{}: {}",
                inner.error.stage,
                inner.error.code,
                inner.error.message
            )
        }
        _ => bail!("mirror analyze response is not an analyzeIntent response"),
    }
}

/// The two SEMANTIC outcomes of a mirror-served candidate: a validated delta,
/// or a worker-reported candidate failure (mutation/validation) — the same
/// terminal outcome the one-shot path surfaces via [`BridgeResponse::into_candidate_result`].
/// Transport/parse problems are `Err` instead, so callers can distinguish
/// "fall back one-shot" (transport) from "this candidate failed" (semantic).
pub(crate) enum MirrorCandidateResponse {
    Delta(WireGraphDelta),
    Failed {
        stage: ErrorStage,
        code: String,
        message: String,
    },
}

/// Binds a mirror-served candidate response (Task 7: `buildValidateCandidateMirror`
/// frames carry no snapshot; the worker executes on its attested mirror under
/// savepoint isolation) before exposing the delta. The transport (`request_at`)
/// has already correlated the `requestId`; this validates protocol version,
/// kind, the exact candidate binding echo (epoch/generation/digest/attempt/
/// scope), and the payload — the same checks `parse_bridge_response` runs for
/// the snapshot-carrying request, minus the request struct it binds against.
pub(crate) fn parse_mirror_candidate_delta(
    value: serde_json::Value,
    expected_binding: &CandidateBinding,
    max_diagnostic_bytes: usize,
) -> Result<MirrorCandidateResponse> {
    let response: BridgeResponse =
        serde_json::from_value(value).context("invalid mirror candidate response")?;
    match response {
        BridgeResponse::CandidateSuccess(inner) => {
            ensure!(
                inner.protocol_version == PROTOCOL_VERSION,
                "unsupported response protocol version {}",
                inner.protocol_version
            );
            ensure!(
                inner.kind == BridgeKind::BuildValidateCandidate,
                "mirror candidate response kind mismatch"
            );
            ensure!(
                &inner.binding == expected_binding,
                "mirror candidate response binding mismatch"
            );
            inner.result.delta.validate()?;
            ensure!(
                inner.result.delta.base_generation == expected_binding.graph_generation,
                "candidate delta base generation does not match request"
            );
            ensure!(
                inner.result.diagnostics.is_empty(),
                "successful candidate response contains diagnostics"
            );
            Ok(MirrorCandidateResponse::Delta(inner.result.delta))
        }
        BridgeResponse::CandidateError(inner) => {
            ensure!(
                inner.protocol_version == PROTOCOL_VERSION,
                "unsupported response protocol version {}",
                inner.protocol_version
            );
            ensure!(
                &inner.binding == expected_binding,
                "mirror candidate error binding mismatch"
            );
            inner.error.validate(max_diagnostic_bytes)?;
            Ok(MirrorCandidateResponse::Failed {
                stage: inner.error.stage,
                code: inner.error.code,
                message: inner.error.message,
            })
        }
        _ => bail!("mirror candidate response is not a buildValidateCandidate response"),
    }
}

fn validate_id_array(context: &str, values: &[String]) -> Result<()> {
    bounded_len(context, values.len())?;
    for (index, value) in values.iter().enumerate() {
        non_empty(value, &format!("{context}[{index}]"))?;
        if let Some(previous) = index.checked_sub(1).map(|value| &values[value]) {
            ensure!(
                compare_code_units(previous, value) == Ordering::Less,
                "{context} is not uniquely sorted"
            );
        }
    }
    Ok(())
}

fn validate_reference_array(context: &str, values: &[WireReference]) -> Result<()> {
    bounded_len(context, values.len())?;
    for (index, value) in values.iter().enumerate() {
        value.validate(&format!("{context}[{index}]"))?;
        if let Some(previous) = index.checked_sub(1).map(|value| &values[value]) {
            ensure!(
                compare_references(previous, value) == Ordering::Less,
                "{context} is not uniquely sorted"
            );
        }
    }
    Ok(())
}

fn bounded_len(context: &str, len: usize) -> Result<()> {
    ensure!(
        len <= MAX_ARRAY_ITEMS,
        "{context} exceeds the protocol item limit"
    );
    Ok(())
}

fn non_empty(value: &str, context: &str) -> Result<()> {
    ensure!(!value.is_empty(), "{context} must not be empty");
    Ok(())
}

fn compare_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn compare_references(left: &WireReference, right: &WireReference) -> Ordering {
    compare_code_units(&left.from_node_id, &right.from_node_id)
        .then_with(|| compare_code_units(&left.to_node_id, &right.to_node_id))
        .then_with(|| compare_code_units(&left.kind, &right.kind))
}
