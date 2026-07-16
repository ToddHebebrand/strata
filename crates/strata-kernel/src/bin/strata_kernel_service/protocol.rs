#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_REQUEST_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_DEADLINE_MS: u64 = 300_000;
pub const DEFAULT_PROTOCOL_CONTEXT_CAPACITY: usize = 1_024;

const MAX_ID_BYTES: usize = 512;
const MAX_REASONING_BYTES: usize = 4_096;
const MAX_TEXT_BYTES: usize = 16_384;
const MAX_ARRAY_ITEMS: usize = 256;
const MAX_DIAGNOSTICS: usize = 64;
const MAX_EVENT_LIMIT: u32 = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct WireU64(u64);

impl WireU64 {
    pub const fn get(self) -> u64 {
        self.0
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
            .map_err(|_| E::custom("unsigned 64-bit decimal string is out of range"))
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalServiceRequest {
    protocol_version: u8,
    request_id: String,
    client_id: String,
    deadline_ms: WireU64,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<String>,
    action: RequestAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RequestAction {
    Hello {},
    InspectNodes {
        node_ids: Vec<String>,
    },
    BeginChangeSet {
        reasoning: String,
    },
    AddIntent {
        change_set_id: String,
        intent: Intent,
    },
    SubmitChangeSet {
        change_set_id: String,
    },
    AdvanceChangeSet {
        change_set_id: String,
    },
    ReadEvents {
        after_sequence: WireU64,
        limit: u32,
    },
    AckEvents {
        through_sequence: WireU64,
    },
    CancelChangeSet {
        change_set_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Intent {
    RenameSymbol {
        declaration_id: String,
        new_name: String,
    },
    AddParameter {
        function_id: String,
        name: String,
        type_text: String,
        position: u32,
        value: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum LocalServiceResponse {
    Success(SuccessResponse),
    Error(ErrorResponse),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuccessResponse {
    protocol_version: u8,
    request_id: String,
    ok: True,
    result: ResponseResult,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorResponse {
    protocol_version: u8,
    request_id: String,
    ok: False,
    error: ErrorPayload,
}

#[derive(Clone, Copy, Debug)]
struct True;

impl Serialize for True {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(de::Error::custom("expected true"))
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct False;

impl Serialize for False {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for False {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if bool::deserialize(deserializer)? {
            Err(de::Error::custom("expected false"))
        } else {
            Ok(Self)
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ResponseResult {
    Ready {},
    Nodes {
        graph_generation: WireU64,
        nodes: Vec<InspectedNode>,
    },
    ChangeSet {
        change_set_id: String,
        state: ChangeSetState,
        ticket_state: Option<TicketState>,
        graph_generation: WireU64,
        operation_id: Option<String>,
        affected_node_ids: Vec<String>,
        diagnostics: Vec<Diagnostic>,
        publication_digest: Option<String>,
    },
    Events {
        events: Vec<ServiceEvent>,
    },
    EventsAcked {
        through_sequence: WireU64,
    },
    Cancelled {
        change_set_id: String,
        state: CancelledState,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectedNode {
    node_id: String,
    kind: String,
    payload: String,
    relationships: Vec<NodeRelationship>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeRelationship {
    kind: String,
    node_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceEvent {
    sequence: WireU64,
    change_set_id: String,
    state: ChangeSetState,
    operation_id: Option<String>,
    affected_node_ids: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    publication_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Diagnostic {
    code: String,
    message: String,
    node_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ErrorPayload {
    code: String,
    message: String,
    retryable: bool,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ChangeSetState {
    Draft,
    Analyzing,
    Queued,
    Ready,
    Claimed,
    Published,
    NeedsDecision,
    ValidationFailed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum TicketState {
    Queued,
    Ready,
    Claimed,
    Completed,
    NeedsDecision,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CancelledState {
    Cancelled,
}

#[derive(Debug)]
pub struct LocalServiceProtocolContext {
    request_capacity: usize,
    change_set_capacity: usize,
    requests: BTreeMap<String, Vec<u8>>,
    owners: BTreeMap<String, String>,
}

impl Default for LocalServiceProtocolContext {
    fn default() -> Self {
        Self::with_capacities(
            DEFAULT_PROTOCOL_CONTEXT_CAPACITY,
            DEFAULT_PROTOCOL_CONTEXT_CAPACITY,
        )
        .expect("default protocol context capacities are valid")
    }
}

impl LocalServiceProtocolContext {
    pub fn with_capacities(request_capacity: usize, change_set_capacity: usize) -> Result<Self> {
        if request_capacity == 0 || change_set_capacity == 0 {
            bail!("protocol context capacity must be positive");
        }
        Ok(Self {
            request_capacity,
            change_set_capacity,
            requests: BTreeMap::new(),
            owners: BTreeMap::new(),
        })
    }

    pub fn record_change_set_owner(&mut self, change_set_id: &str, client_id: &str) -> Result<()> {
        validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
        validate_string(client_id, MAX_ID_BYTES, false, "clientId")?;
        if let Some(owner) = self.owners.get(change_set_id) {
            if owner != client_id {
                bail!("change set belongs to a different client");
            }
            return Ok(());
        }
        if self.owners.len() >= self.change_set_capacity {
            bail!("change-set validation context capacity exceeded");
        }
        self.owners
            .insert(change_set_id.to_owned(), client_id.to_owned());
        Ok(())
    }

    fn validate_request(&mut self, request: &LocalServiceRequest) -> Result<()> {
        if let Some(change_set_id) = request.action.change_set_id()
            && let Some(owner) = self.owners.get(change_set_id)
            && owner != &request.client_id
        {
            bail!("change set belongs to a different client");
        }

        let canonical = serde_json::to_vec(request).context("serialize canonical request body")?;
        if let Some(previous) = self.requests.get(&request.request_id) {
            if previous != &canonical {
                bail!("request ID was already used with a different body");
            }
            return Ok(());
        }
        if self.requests.len() >= self.request_capacity {
            bail!("request validation context capacity exceeded");
        }
        self.requests.insert(request.request_id.clone(), canonical);
        Ok(())
    }
}

impl RequestAction {
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            Self::BeginChangeSet { .. }
                | Self::AddIntent { .. }
                | Self::SubmitChangeSet { .. }
                | Self::AdvanceChangeSet { .. }
                | Self::AckEvents { .. }
                | Self::CancelChangeSet { .. }
        )
    }

    fn change_set_id(&self) -> Option<&str> {
        match self {
            Self::AddIntent { change_set_id, .. }
            | Self::SubmitChangeSet { change_set_id }
            | Self::AdvanceChangeSet { change_set_id }
            | Self::CancelChangeSet { change_set_id } => Some(change_set_id),
            _ => None,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Hello {} => {}
            Self::InspectNodes { node_ids } => {
                bounded_items(node_ids.len(), 1, MAX_ARRAY_ITEMS, "nodeIds")?;
                for node_id in node_ids {
                    validate_string(node_id, MAX_ID_BYTES, false, "nodeId")?;
                }
            }
            Self::BeginChangeSet { reasoning } => {
                validate_string(reasoning, MAX_REASONING_BYTES, true, "reasoning")?;
            }
            Self::AddIntent {
                change_set_id,
                intent,
            } => {
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
                intent.validate()?;
            }
            Self::SubmitChangeSet { change_set_id }
            | Self::AdvanceChangeSet { change_set_id }
            | Self::CancelChangeSet { change_set_id } => {
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
            }
            Self::ReadEvents { limit, .. } => {
                if !(1..=MAX_EVENT_LIMIT).contains(limit) {
                    bail!("read_events limit is outside the supported bound");
                }
            }
            Self::AckEvents { .. } => {}
        }
        Ok(())
    }
}

impl Intent {
    fn validate(&self) -> Result<()> {
        match self {
            Self::RenameSymbol {
                declaration_id,
                new_name,
            } => {
                validate_string(declaration_id, MAX_ID_BYTES, false, "declarationId")?;
                validate_string(new_name, MAX_ID_BYTES, false, "newName")?;
            }
            Self::AddParameter {
                function_id,
                name,
                type_text,
                value,
                ..
            } => {
                validate_string(function_id, MAX_ID_BYTES, false, "functionId")?;
                validate_string(name, MAX_ID_BYTES, false, "name")?;
                validate_string(type_text, MAX_TEXT_BYTES, true, "typeText")?;
                validate_string(value, MAX_TEXT_BYTES, true, "value")?;
            }
        }
        Ok(())
    }
}

impl LocalServiceRequest {
    fn validate(&self) -> Result<()> {
        if self.protocol_version != PROTOCOL_VERSION {
            bail!("unsupported protocol version");
        }
        validate_string(&self.request_id, MAX_ID_BYTES, false, "requestId")?;
        validate_string(&self.client_id, MAX_ID_BYTES, false, "clientId")?;
        if self.deadline_ms.get() == 0 || self.deadline_ms.get() > MAX_DEADLINE_MS {
            bail!("deadlineMs is outside the supported bound");
        }
        match (&self.idempotency_key, self.action.is_mutating()) {
            (Some(key), true) => validate_string(key, MAX_ID_BYTES, false, "idempotencyKey")?,
            (None, true) => bail!("mutating actions require an idempotency key"),
            (Some(_), false) => bail!("read-only actions must not carry an idempotency key"),
            (None, false) => {}
        }
        self.action.validate()
    }
}

impl LocalServiceResponse {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Success(response) => response.validate(),
            Self::Error(response) => response.validate(),
        }
    }
}

impl SuccessResponse {
    fn validate(&self) -> Result<()> {
        validate_response_header(self.protocol_version, &self.request_id)?;
        self.result.validate()
    }
}

impl ErrorResponse {
    fn validate(&self) -> Result<()> {
        validate_response_header(self.protocol_version, &self.request_id)?;
        self.error.validate()
    }
}

impl ResponseResult {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Ready {} => {}
            Self::Nodes { nodes, .. } => {
                bounded_items(nodes.len(), 0, MAX_ARRAY_ITEMS, "nodes")?;
                for node in nodes {
                    node.validate()?;
                }
            }
            Self::ChangeSet {
                change_set_id,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
                ..
            } => {
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
                validate_optional_id(operation_id, "operationId")?;
                validate_ids(affected_node_ids, "affectedNodeIds")?;
                validate_diagnostics(diagnostics)?;
                validate_optional_digest(publication_digest)?;
            }
            Self::Events { events } => {
                bounded_items(events.len(), 0, MAX_ARRAY_ITEMS, "events")?;
                for event in events {
                    event.validate()?;
                }
            }
            Self::EventsAcked { .. } => {}
            Self::Cancelled { change_set_id, .. } => {
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
            }
        }
        Ok(())
    }
}

impl InspectedNode {
    fn validate(&self) -> Result<()> {
        validate_string(&self.node_id, MAX_ID_BYTES, false, "nodeId")?;
        validate_string(&self.kind, MAX_ID_BYTES, false, "kind")?;
        validate_string(&self.payload, MAX_TEXT_BYTES, true, "payload")?;
        bounded_items(
            self.relationships.len(),
            0,
            MAX_ARRAY_ITEMS,
            "relationships",
        )?;
        for relationship in &self.relationships {
            validate_string(&relationship.kind, MAX_ID_BYTES, false, "relationship kind")?;
            validate_string(
                &relationship.node_id,
                MAX_ID_BYTES,
                false,
                "relationship nodeId",
            )?;
        }
        Ok(())
    }
}

impl ServiceEvent {
    fn validate(&self) -> Result<()> {
        validate_string(&self.change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
        validate_optional_id(&self.operation_id, "operationId")?;
        validate_ids(&self.affected_node_ids, "affectedNodeIds")?;
        validate_diagnostics(&self.diagnostics)?;
        validate_optional_digest(&self.publication_digest)
    }
}

impl Diagnostic {
    fn validate(&self) -> Result<()> {
        validate_string(&self.code, MAX_ID_BYTES, false, "diagnostic code")?;
        validate_string(&self.message, MAX_TEXT_BYTES, true, "diagnostic message")?;
        validate_optional_id(&self.node_id, "diagnostic nodeId")
    }
}

impl ErrorPayload {
    fn validate(&self) -> Result<()> {
        validate_string(&self.code, MAX_ID_BYTES, false, "error code")?;
        validate_string(&self.message, MAX_TEXT_BYTES, true, "error message")?;
        validate_diagnostics(&self.diagnostics)
    }
}

pub fn parse_request_frame(
    bytes: &[u8],
    mut context: Option<&mut LocalServiceProtocolContext>,
) -> Result<LocalServiceRequest> {
    let payload = decode_frame(bytes, MAX_REQUEST_FRAME_BYTES)?;
    let request: LocalServiceRequest =
        serde_json::from_str(payload).context("invalid local-service request JSON")?;
    request.validate()?;
    if let Some(context) = context.as_mut() {
        context.validate_request(&request)?;
    }
    Ok(request)
}

pub fn parse_response_frame(bytes: &[u8]) -> Result<LocalServiceResponse> {
    let payload = decode_frame(bytes, MAX_RESPONSE_FRAME_BYTES)?;
    let response: LocalServiceResponse =
        serde_json::from_str(payload).context("invalid local-service response JSON")?;
    response.validate()?;
    Ok(response)
}

pub fn serialize_request_frame(request: &LocalServiceRequest) -> Result<Vec<u8>> {
    request.validate()?;
    encode_frame(request, MAX_REQUEST_FRAME_BYTES)
}

pub fn serialize_response_frame(response: &LocalServiceResponse) -> Result<Vec<u8>> {
    response.validate()?;
    encode_frame(response, MAX_RESPONSE_FRAME_BYTES)
}

fn decode_frame(bytes: &[u8], max_bytes: usize) -> Result<&str> {
    if bytes.len() > max_bytes {
        bail!("frame exceeds {max_bytes} byte bound");
    }
    if bytes.len() < 2 || bytes.last() != Some(&b'\n') {
        bail!("frame must contain one non-empty JSON object terminated by LF");
    }
    let payload = &bytes[..bytes.len() - 1];
    if payload.contains(&b'\n') {
        bail!("connection contains multiple frames");
    }
    std::str::from_utf8(payload).context("frame is not valid UTF-8")
}

fn encode_frame<T: Serialize>(value: &T, max_bytes: usize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).context("serialize local-service frame")?;
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        bail!("frame exceeds {max_bytes} byte bound");
    }
    Ok(bytes)
}

fn validate_response_header(protocol_version: u8, request_id: &str) -> Result<()> {
    if protocol_version != PROTOCOL_VERSION {
        bail!("unsupported protocol version");
    }
    validate_string(request_id, MAX_ID_BYTES, false, "requestId")
}

fn validate_string(value: &str, max_bytes: usize, allow_empty: bool, field: &str) -> Result<()> {
    if !allow_empty && value.is_empty() {
        bail!("{field} must not be empty");
    }
    if value.len() > max_bytes {
        bail!("{field} exceeds {max_bytes} UTF-8 bytes");
    }
    Ok(())
}

fn bounded_items(len: usize, min: usize, max: usize, field: &str) -> Result<()> {
    if len < min || len > max {
        bail!("{field} item count is outside the supported bound");
    }
    Ok(())
}

fn validate_optional_id(value: &Option<String>, field: &str) -> Result<()> {
    if let Some(value) = value {
        validate_string(value, MAX_ID_BYTES, false, field)?;
    }
    Ok(())
}

fn validate_ids(values: &[String], field: &str) -> Result<()> {
    bounded_items(values.len(), 0, MAX_ARRAY_ITEMS, field)?;
    for value in values {
        validate_string(value, MAX_ID_BYTES, false, field)?;
    }
    Ok(())
}

fn validate_diagnostics(diagnostics: &[Diagnostic]) -> Result<()> {
    bounded_items(diagnostics.len(), 0, MAX_DIAGNOSTICS, "diagnostics")?;
    for diagnostic in diagnostics {
        diagnostic.validate()?;
    }
    Ok(())
}

fn validate_optional_digest(value: &Option<String>) -> Result<()> {
    if let Some(value) = value
        && (value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        bail!("publicationDigest must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}
