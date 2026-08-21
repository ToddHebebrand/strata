#![allow(dead_code)]

use anyhow::{Context, Result, bail};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;
use strata_kernel::{
    MAX_DECLARATION_MATCHES, MAX_MODULE_DECLARATION_PAGE_ITEMS, MAX_MODULE_PAGE_ITEMS,
    MAX_REFERENCE_PAGE_ITEMS,
};

/// Protocol v2 (D-2). A connection is a session: the FIRST frame is an
/// `open_session` handshake, and every request frame afterwards carries this
/// same version as a consistency check — NOT as a second negotiation point.
/// There is no v1 compatibility mode; a v1 frame is refused and the
/// connection closed.
pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_REQUEST_FRAME_BYTES: usize = 64 * 1024;
/// The handshake is small and fixed-shape, so it gets a far tighter bound than
/// a request frame: an un-handshaken connection must not be able to make the
/// daemon buffer 64 KiB before it has proven who it is.
pub const MAX_HANDSHAKE_FRAME_BYTES: usize = 4 * 1024;
pub const MAX_RESPONSE_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_DEADLINE_MS: u64 = 300_000;
pub const DEFAULT_PROTOCOL_CONTEXT_CAPACITY: usize = 1_024;

const MAX_ID_BYTES: usize = 512;
const MAX_REASONING_BYTES: usize = 4_096;
const MAX_TEXT_BYTES: usize = 16_384;
const MAX_ARRAY_ITEMS: usize = 256;
const MAX_DIAGNOSTICS: usize = 64;
const MAX_EVENT_LIMIT: u32 = 256;
// Must stay >= session.rs's MAX_INTENTS (currently 256) cap on intents per
// change set, or a legitimately committed change set at that cap would
// produce a `read_operation` response that this validator rejects forever.
// Not imported directly: `tests/local_service.rs` compiles this module
// standalone via `#[path] mod protocol;` without a sibling `session` module,
// so the two constants are kept in sync by hand instead.
const MAX_OPERATION_INTENTS: usize = 256;
/// Largest fixture slice one `read_validation_fixture` call may return. The
/// reader is deliberately chunked: a registered fixture is read in bounded
/// pieces like every other collection on this wire, never streamed whole.
pub(super) const MAX_FIXTURE_CHUNK_BYTES: u32 = 8_192;
/// Base64 of `MAX_FIXTURE_CHUNK_BYTES` raw bytes: 4 characters per 3-byte
/// group, padded up. Bounding the encoded field as well as the requested
/// length keeps a malformed response from smuggling past the raw-length cap.
const MAX_FIXTURE_CHUNK_BASE64_BYTES: usize =
    (MAX_FIXTURE_CHUNK_BYTES as usize).div_ceil(3) * 4;
/// Registered fixtures per manifest, and therefore per listing — the listing
/// is single-page by construction, so it carries no cursor.
pub(super) const MAX_VALIDATION_FIXTURES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct WireU64(u64);

impl WireU64 {
    pub(super) const fn new(value: u64) -> Self {
        Self(value)
    }

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

/// The two serial lanes a client opens. They are an ordering authority, not a
/// permission: see `lane_for_action`. Kept a closed enum on the wire so an
/// unknown lane name is a handshake rejection rather than a silent default.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub(super) enum SessionRole {
    Work,
    Observation,
}

impl SessionRole {
    pub(super) fn as_label(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Observation => "observation",
        }
    }
}

/// Enforces the literal `"type":"open_session"` tag. A bare `String` field
/// would let any tag through to a later hand-rolled comparison; a unit-variant
/// enum makes the tag part of the schema, in the same spirit as `True`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum OpenSessionTag {
    OpenSession,
}

/// The first frame on every v2 connection, and the SOLE negotiation point.
///
/// `clientInstance` is stable across BOTH lanes for one client lifetime;
/// `connectionGeneration` is monotonic per role lane. Together they are what
/// Task 5's ownership rule decides on — which is why they are established here,
/// before any request, rather than asserted per request.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OpenSession {
    pub(super) protocol_version: u8,
    #[serde(rename = "type")]
    pub(super) frame_type: OpenSessionTag,
    pub(super) actor: String,
    pub(super) role: SessionRole,
    pub(super) client_instance: String,
    pub(super) connection_generation: WireU64,
}

/// The handshake reply. `session_opened` carries the session identity the
/// client would otherwise have to ask for with a `hello`; `session_rejected`
/// is the fail-fast direction — written and followed by a close, so neither
/// side ever waits on EOF to learn the handshake failed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum SessionReply {
    SessionOpened {
        protocol_version: u8,
        service_epoch: WireU64,
        validation_mode: ValidationMode,
        #[serde(deserialize_with = "required_nullable_digest")]
        validation_manifest_digest: Option<String>,
        actor: String,
        role: SessionRole,
    },
    SessionRejected {
        protocol_version: u8,
        error: ErrorPayload,
    },
}

impl SessionReply {
    pub(super) fn rejected(code: &str, message: &str, retryable: bool) -> Self {
        Self::SessionRejected {
            protocol_version: PROTOCOL_VERSION,
            error: ErrorPayload {
                code: code.to_owned(),
                message: message.to_owned(),
                retryable,
                diagnostics: Vec::new(),
            },
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::SessionOpened {
                protocol_version,
                validation_manifest_digest,
                actor,
                ..
            } => {
                if *protocol_version != PROTOCOL_VERSION {
                    bail!("unsupported protocol version");
                }
                validate_string(actor, MAX_ID_BYTES, false, "actor")?;
                if let Some(digest) = validation_manifest_digest {
                    validate_digest_field(digest, "validationManifestDigest")?;
                }
                Ok(())
            }
            Self::SessionRejected {
                protocol_version,
                error,
            } => {
                if *protocol_version != PROTOCOL_VERSION {
                    bail!("unsupported protocol version");
                }
                error.validate()
            }
        }
    }
}

impl OpenSession {
    fn validate(&self) -> Result<()> {
        if self.protocol_version != PROTOCOL_VERSION {
            bail!("unsupported protocol version");
        }
        validate_string(&self.actor, MAX_ID_BYTES, false, "actor")?;
        validate_string(&self.client_instance, MAX_ID_BYTES, false, "clientInstance")?;
        if self.connection_generation.get() == 0 {
            bail!("connectionGeneration must be a positive canonical integer");
        }
        Ok(())
    }
}

/// What a connection may say first.
///
/// `health` is a FIRST FRAME, never an action, and that placement is the whole
/// point: D-2 proved the handshake never reaches `bind_request`, so health
/// inherits that property. A health probe on the journalled request path would
/// make ordinary monitoring generate durable fsync traffic forever.
///
/// `open_session`'s wire bytes are unchanged — the D-2 golden corpus asserts
/// them. This is an addition, not a reshape.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum FirstFrame {
    #[serde(rename_all = "camelCase")]
    OpenSession {
        protocol_version: u8,
        actor: String,
        role: SessionRole,
        client_instance: String,
        connection_generation: WireU64,
    },
    #[serde(rename_all = "camelCase")]
    Health { protocol_version: u8 },
}

/// The health reply.
///
/// The COMPLETE shape is defined in D-3a, including `draining` and
/// `active_requests`, which are constants here. D-3b makes them vary but
/// changes no shape — a frame that gained fields between slices would be
/// exactly the wire-freeze problem the D-3 split had to answer for.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(super) enum HealthReply {
    HealthOk {
        protocol_version: u8,
        service_epoch: WireU64,
        recovered: bool,
        validation_mode: ValidationMode,
        #[serde(deserialize_with = "required_nullable_digest")]
        validation_manifest_digest: Option<String>,
        /// The request-admission state. Always false in D-3a.
        draining: bool,
        /// Requests between the request-start boundary and response flush.
        /// Always "0" in D-3a.
        active_requests: WireU64,
    },
}

pub(super) fn serialize_health_reply(reply: &HealthReply) -> Result<Vec<u8>> {
    encode_frame(reply, MAX_HANDSHAKE_FRAME_BYTES)
}

pub(super) fn parse_health_reply_frame(bytes: &[u8]) -> Result<HealthReply> {
    let payload = decode_frame(bytes, MAX_HANDSHAKE_FRAME_BYTES)?;
    serde_json::from_str(payload).context("invalid health reply JSON")
}

/// Parses the first frame of a connection. Deliberately NOT a variant of
/// `parse_request_frame`: the first frame never reaches the journalled request
/// path, so it must not share a validator that a request context can mutate.
pub(super) fn parse_first_frame(bytes: &[u8]) -> Result<FirstFrame> {
    let payload = decode_frame(bytes, MAX_HANDSHAKE_FRAME_BYTES)?;
    let frame: FirstFrame =
        serde_json::from_str(payload).context("invalid first frame JSON")?;
    match &frame {
        FirstFrame::OpenSession {
            protocol_version,
            actor,
            client_instance,
            connection_generation,
            ..
        } => {
            if *protocol_version != PROTOCOL_VERSION {
                bail!("unsupported protocol version");
            }
            validate_string(actor, MAX_ID_BYTES, false, "actor")?;
            validate_string(client_instance, MAX_ID_BYTES, false, "clientInstance")?;
            if connection_generation.get() == 0 {
                bail!("connectionGeneration must be a positive canonical integer");
            }
        }
        FirstFrame::Health { protocol_version } => {
            if *protocol_version != PROTOCOL_VERSION {
                bail!("unsupported protocol version");
            }
        }
    }
    Ok(frame)
}

pub(super) fn parse_open_session_frame(bytes: &[u8]) -> Result<OpenSession> {
    let payload = decode_frame(bytes, MAX_HANDSHAKE_FRAME_BYTES)?;
    let handshake: OpenSession =
        serde_json::from_str(payload).context("invalid open_session handshake JSON")?;
    handshake.validate()?;
    Ok(handshake)
}

pub(super) fn serialize_session_reply(reply: &SessionReply) -> Result<Vec<u8>> {
    reply.validate()?;
    encode_frame(reply, MAX_HANDSHAKE_FRAME_BYTES)
}

pub(super) fn parse_session_reply_frame(bytes: &[u8]) -> Result<SessionReply> {
    let payload = decode_frame(bytes, MAX_HANDSHAKE_FRAME_BYTES)?;
    let reply: SessionReply =
        serde_json::from_str(payload).context("invalid session handshake reply JSON")?;
    reply.validate()?;
    Ok(reply)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalServiceRequest {
    pub(super) protocol_version: u8,
    pub(super) request_id: String,
    pub(super) client_id: String,
    pub(super) deadline_ms: WireU64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) idempotency_key: Option<String>,
    pub(super) action: RequestAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum RequestAction {
    Hello {},
    InspectNodes {
        node_ids: Vec<String>,
    },
    FindDeclarations {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        module_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_node_id: Option<String>,
    },
    ListModules {
        #[serde(skip_serializing_if = "Option::is_none")]
        after_module_id: Option<String>,
        limit: u32,
    },
    ListModuleDeclarations {
        module_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_node_id: Option<String>,
        limit: u32,
    },
    GetReferences {
        node_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_reference_key: Option<String>,
        limit: u32,
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
    ReadOperation {
        operation_id: String,
    },
    ListValidationFixtures {},
    ReadValidationFixture {
        fixture_id: String,
        offset: WireU64,
        length: u32,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Intent {
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
    pub(super) protocol_version: u8,
    pub(super) request_id: String,
    pub(super) ok: True,
    pub(super) result: ResponseResult,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorResponse {
    pub(super) protocol_version: u8,
    pub(super) request_id: String,
    pub(super) ok: False,
    pub(super) error: ErrorPayload,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct True;

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
pub(super) struct False;

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

/// The daemon's validation regime, as published on the readiness line, the
/// start audit event and the `hello` response. One vocabulary for all three so
/// the three surfaces cannot drift.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ValidationMode {
    TscOnly,
    Behavioral,
}

impl ValidationMode {
    pub(super) fn as_label(self) -> &'static str {
        match self {
            Self::TscOnly => "tscOnly",
            Self::Behavioral => "behavioral",
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
pub(super) enum ResponseResult {
    /// `hello`. Both fields are REQUIRED on the wire (B-2 Task 7): a client
    /// must be able to read the daemon's validation regime off its first
    /// response rather than infer it from a key's absence. The digest is
    /// NULLABLE, not optional — `null` states "no operator manifest", which is
    /// a different claim from "this daemon predates the field".
    Ready {
        validation_mode: ValidationMode,
        #[serde(deserialize_with = "required_nullable_digest")]
        validation_manifest_digest: Option<String>,
    },
    Nodes {
        graph_generation: WireU64,
        nodes: Vec<InspectedNode>,
    },
    Declarations {
        graph_generation: WireU64,
        declarations: Vec<DeclarationSummary>,
        has_more: bool,
    },
    Modules {
        graph_generation: WireU64,
        modules: Vec<ModuleSummary>,
        has_more: bool,
    },
    ModuleDeclarations {
        graph_generation: WireU64,
        declarations: Vec<ModuleDeclarationSummary>,
        has_more: bool,
    },
    References {
        graph_generation: WireU64,
        references: Vec<ReferenceSummary>,
        has_more: bool,
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
        /// Net renamed-symbol transitions committed after this change set's
        /// base analysis. Populated only when `state` is `needs_decision`, so
        /// a fresh decision can rewrite stale intent content to current names.
        renamed_symbols: Vec<RenamedSymbol>,
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
    Operation {
        graph_generation: WireU64,
        operation_id: String,
        change_set_id: String,
        actor: String,
        kind: String,
        reasoning: String,
        affected_node_ids: Vec<String>,
        renames: Vec<OperationRenameTransition>,
        intents: Vec<OperationIntentSummary>,
        publication_digest: String,
    },
    /// `list_validation_fixtures`. Carries the daemon's validation regime with
    /// the listing so a client can tell "this daemon runs no behavioral
    /// fixtures" (tsc-only: empty list, `null` digest) apart from "this
    /// behavioral daemon happens to have none" — which the manifest loader
    /// makes unconstructible, but the wire still states rather than implies.
    ValidationFixtures {
        validation_mode: ValidationMode,
        #[serde(deserialize_with = "required_nullable_digest")]
        validation_manifest_digest: Option<String>,
        fixtures: Vec<FixtureSummary>,
    },
    ValidationFixtureChunk {
        fixture_id: String,
        offset: WireU64,
        content_base64: String,
        eof: bool,
    },
}

/// One registered behavioral fixture. `fixture_id` IS the fixture's sha256 —
/// the manifest registers content, not a name, so an id that no longer hashes
/// the file on disk is a drifted fixture rather than a different one.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FixtureSummary {
    pub(super) fixture_id: String,
    pub(super) path: String,
    pub(super) bytes: WireU64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectedNode {
    pub(super) node_id: String,
    pub(super) kind: String,
    pub(super) payload: String,
    pub(super) relationships: Vec<NodeRelationship>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeclarationSummary {
    pub(super) node_id: String,
    pub(super) kind: String,
    pub(super) name: String,
    pub(super) module_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModuleSummary {
    pub(super) module_id: String,
    pub(super) path: String,
    pub(super) declaration_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ModuleDeclarationSummary {
    pub(super) node_id: String,
    pub(super) name: Option<String>,
    pub(super) kind: String,
    pub(super) exported: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReferenceSummary {
    pub(super) from_node_id: String,
    pub(super) kind: String,
    pub(super) module_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeRelationship {
    pub(super) kind: String,
    pub(super) node_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServiceEvent {
    pub(super) sequence: WireU64,
    pub(super) change_set_id: String,
    pub(super) kind: ServiceEventKind,
    pub(super) state: ChangeSetState,
    pub(super) operation_id: Option<String>,
    pub(super) affected_node_ids: Vec<String>,
    pub(super) diagnostics: Vec<Diagnostic>,
    pub(super) publication_digest: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ServiceEventKind {
    IntentQueued,
    IntentReady,
    IntentNeedsDecision,
    IntentCommitted,
    IntentCancelled,
    IntentFailed,
    LeaseExpired,
    ScopeExpanded,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OperationRenameTransition {
    pub(super) node_id: String,
    pub(super) from_name: String,
    pub(super) to_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OperationIntentSummary {
    pub(super) kind: String,
    pub(super) parameters_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RenamedSymbol {
    pub(super) node_id: String,
    pub(super) previous_name: String,
    pub(super) current_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Diagnostic {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) node_id: Option<String>,
    /// Corpus-relative POSIX display path of the module the diagnostic
    /// points at, when the service could project one. NEVER a raw payload
    /// path — the session projects (B-1 `project_module_path`) and drops
    /// to absent on failure. Optional on the wire (absent when None) so
    /// every pre-B-2 frame stays valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) module_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ErrorPayload {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) retryable: bool,
    pub(super) diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ChangeSetState {
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
pub(super) enum TicketState {
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
pub(super) enum CancelledState {
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

    pub(super) fn forget_request(&mut self, request_id: &str) {
        self.requests.remove(request_id);
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
    pub(super) fn is_mutating(&self) -> bool {
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

    /// Which serial lane this action travels on.
    ///
    /// Its OWN authority, deliberately NOT derived from `is_mutating`. The two
    /// answer different questions: `ack_events` is mutating (it needs an
    /// idempotency key for exactly-once semantics) but observational (it is
    /// the back half of the read/ack cycle), and keeping read and ack on the
    /// SAME serial lane preserves their natural ordering. Deriving lanes from
    /// mutation would split them onto different lanes and lose that ordering.
    ///
    /// Exhaustive by construction -- adding an action forces a decision here
    /// rather than defaulting -- and asserted against `action-lane.json`, the
    /// same fixture the TypeScript client asserts its own mapping against.
    pub(super) const fn lane(&self) -> SessionRole {
        match self {
            Self::BeginChangeSet { .. }
            | Self::AddIntent { .. }
            | Self::SubmitChangeSet { .. }
            | Self::AdvanceChangeSet { .. }
            | Self::CancelChangeSet { .. } => SessionRole::Work,
            Self::Hello { .. }
            | Self::InspectNodes { .. }
            | Self::FindDeclarations { .. }
            | Self::ListModules { .. }
            | Self::ListModuleDeclarations { .. }
            | Self::GetReferences { .. }
            | Self::ReadEvents { .. }
            | Self::AckEvents { .. }
            | Self::ReadOperation { .. }
            | Self::ListValidationFixtures { .. }
            | Self::ReadValidationFixture { .. } => SessionRole::Observation,
        }
    }

    pub(super) fn change_set_id(&self) -> Option<&str> {
        match self {
            Self::AddIntent { change_set_id, .. }
            | Self::SubmitChangeSet { change_set_id }
            | Self::AdvanceChangeSet { change_set_id }
            | Self::CancelChangeSet { change_set_id } => Some(change_set_id),
            _ => None,
        }
    }

    pub(super) const fn name(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::InspectNodes { .. } => "inspect_nodes",
            Self::FindDeclarations { .. } => "find_declarations",
            Self::ListModules { .. } => "list_modules",
            Self::ListModuleDeclarations { .. } => "list_module_declarations",
            Self::GetReferences { .. } => "get_references",
            Self::BeginChangeSet { .. } => "begin_change_set",
            Self::AddIntent { .. } => "add_intent",
            Self::SubmitChangeSet { .. } => "submit_change_set",
            Self::AdvanceChangeSet { .. } => "advance_change_set",
            Self::ReadEvents { .. } => "read_events",
            Self::AckEvents { .. } => "ack_events",
            Self::CancelChangeSet { .. } => "cancel_change_set",
            Self::ReadOperation { .. } => "read_operation",
            Self::ListValidationFixtures { .. } => "list_validation_fixtures",
            Self::ReadValidationFixture { .. } => "read_validation_fixture",
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
            Self::FindDeclarations {
                name,
                kind,
                module_id,
                after_node_id,
            } => {
                validate_string(name, MAX_ID_BYTES, false, "name")?;
                if let Some(kind) = kind {
                    validate_string(kind, MAX_ID_BYTES, false, "kind")?;
                }
                validate_optional_id(module_id, "moduleId")?;
                validate_optional_id(after_node_id, "afterNodeId")?;
            }
            Self::ListModules {
                after_module_id,
                limit,
            } => {
                validate_optional_id(after_module_id, "afterModuleId")?;
                validate_page_limit(*limit, MAX_MODULE_PAGE_ITEMS, "list_modules")?;
            }
            Self::ListModuleDeclarations {
                module_id,
                after_node_id,
                limit,
            } => {
                validate_string(module_id, MAX_ID_BYTES, false, "moduleId")?;
                validate_optional_id(after_node_id, "afterNodeId")?;
                validate_page_limit(
                    *limit,
                    MAX_MODULE_DECLARATION_PAGE_ITEMS,
                    "list_module_declarations",
                )?;
            }
            Self::GetReferences {
                node_id,
                after_reference_key,
                limit,
            } => {
                validate_string(node_id, MAX_ID_BYTES, false, "nodeId")?;
                validate_optional_id(after_reference_key, "afterReferenceKey")?;
                validate_page_limit(*limit, MAX_REFERENCE_PAGE_ITEMS, "get_references")?;
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
            Self::ReadOperation { operation_id } => {
                validate_string(operation_id, MAX_ID_BYTES, false, "operationId")?;
            }
            Self::ListValidationFixtures {} => {}
            Self::ReadValidationFixture {
                fixture_id,
                offset: _,
                length,
            } => {
                // The id IS a content digest, so the digest rule is the id
                // rule: 64 lowercase hex, rejected here rather than looked up
                // and missed. Any offset is representable — a read past EOF is
                // an empty terminal chunk, not a bad request.
                validate_digest_field(fixture_id, "fixtureId")?;
                validate_page_limit(
                    *length,
                    MAX_FIXTURE_CHUNK_BYTES as usize,
                    "read_validation_fixture",
                )?;
            }
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
    pub(super) fn success(request_id: impl Into<String>, result: ResponseResult) -> Self {
        Self::Success(SuccessResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: True,
            result,
        })
    }

    pub(super) fn error(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
        diagnostics: Vec<Diagnostic>,
    ) -> Self {
        Self::Error(ErrorResponse {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: False,
            error: ErrorPayload {
                code: code.into(),
                message: message.into(),
                retryable,
                diagnostics,
            },
        })
    }

    pub(super) fn with_request_id(&self, request_id: impl Into<String>) -> Self {
        let request_id = request_id.into();
        match self {
            Self::Success(response) => Self::success(request_id, response.result.clone()),
            Self::Error(response) => Self::Error(ErrorResponse {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                ok: False,
                error: response.error.clone(),
            }),
        }
    }

    pub(super) fn request_id(&self) -> &str {
        match self {
            Self::Success(response) => &response.request_id,
            Self::Error(response) => &response.request_id,
        }
    }

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
            Self::Ready {
                validation_manifest_digest,
                ..
            } => validate_optional_digest(validation_manifest_digest)?,
            Self::Nodes { nodes, .. } => {
                bounded_items(nodes.len(), 0, MAX_ARRAY_ITEMS, "nodes")?;
                for node in nodes {
                    node.validate()?;
                }
            }
            Self::Declarations { declarations, .. } => {
                bounded_items(
                    declarations.len(),
                    0,
                    MAX_DECLARATION_MATCHES,
                    "declarations",
                )?;
                for declaration in declarations {
                    declaration.validate()?;
                }
            }
            Self::Modules { modules, .. } => {
                bounded_items(modules.len(), 0, MAX_MODULE_PAGE_ITEMS, "modules")?;
                for module in modules {
                    module.validate()?;
                }
            }
            Self::ModuleDeclarations { declarations, .. } => {
                bounded_items(
                    declarations.len(),
                    0,
                    MAX_MODULE_DECLARATION_PAGE_ITEMS,
                    "declarations",
                )?;
                for declaration in declarations {
                    declaration.validate()?;
                }
            }
            Self::References { references, .. } => {
                bounded_items(references.len(), 0, MAX_REFERENCE_PAGE_ITEMS, "references")?;
                for reference in references {
                    reference.validate()?;
                }
            }
            Self::ChangeSet {
                change_set_id,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
                renamed_symbols,
                ..
            } => {
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
                validate_optional_id(operation_id, "operationId")?;
                validate_ids(affected_node_ids, "affectedNodeIds")?;
                validate_diagnostics(diagnostics)?;
                validate_optional_digest(publication_digest)?;
                bounded_items(renamed_symbols.len(), 0, MAX_ARRAY_ITEMS, "renamedSymbols")?;
                for renamed in renamed_symbols {
                    validate_string(
                        &renamed.node_id,
                        MAX_ID_BYTES,
                        false,
                        "renamedSymbol nodeId",
                    )?;
                    validate_string(
                        &renamed.previous_name,
                        MAX_ID_BYTES,
                        false,
                        "renamedSymbol previousName",
                    )?;
                    validate_string(
                        &renamed.current_name,
                        MAX_ID_BYTES,
                        false,
                        "renamedSymbol currentName",
                    )?;
                }
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
            Self::Operation {
                operation_id,
                change_set_id,
                actor,
                kind,
                reasoning,
                affected_node_ids,
                renames,
                intents,
                publication_digest,
                ..
            } => {
                validate_string(operation_id, MAX_ID_BYTES, false, "operationId")?;
                validate_string(change_set_id, MAX_ID_BYTES, false, "changeSetId")?;
                validate_string(actor, MAX_ID_BYTES, false, "actor")?;
                validate_string(kind, MAX_ID_BYTES, false, "kind")?;
                validate_string(reasoning, MAX_REASONING_BYTES, true, "reasoning")?;
                validate_ids(affected_node_ids, "affectedNodeIds")?;
                bounded_items(renames.len(), 0, MAX_ARRAY_ITEMS, "renames")?;
                for rename in renames {
                    rename.validate()?;
                }
                bounded_items(intents.len(), 0, MAX_OPERATION_INTENTS, "intents")?;
                for intent in intents {
                    intent.validate()?;
                }
                validate_digest(publication_digest)?;
            }
            Self::ValidationFixtures {
                validation_manifest_digest,
                fixtures,
                ..
            } => {
                validate_optional_digest(validation_manifest_digest)?;
                bounded_items(fixtures.len(), 0, MAX_VALIDATION_FIXTURES, "fixtures")?;
                for fixture in fixtures {
                    fixture.validate()?;
                }
            }
            Self::ValidationFixtureChunk {
                fixture_id,
                content_base64,
                ..
            } => {
                validate_digest_field(fixture_id, "fixtureId")?;
                // Empty is legal and meaningful: a read at or past EOF returns
                // no bytes with `eof: true`.
                validate_string(
                    content_base64,
                    MAX_FIXTURE_CHUNK_BASE64_BYTES,
                    true,
                    "contentBase64",
                )?;
                validate_base64(content_base64)?;
            }
        }
        Ok(())
    }
}

impl OperationRenameTransition {
    fn validate(&self) -> Result<()> {
        validate_string(&self.node_id, MAX_ID_BYTES, false, "rename nodeId")?;
        validate_string(&self.from_name, MAX_ID_BYTES, false, "rename fromName")?;
        validate_string(&self.to_name, MAX_ID_BYTES, false, "rename toName")
    }
}

impl OperationIntentSummary {
    fn validate(&self) -> Result<()> {
        validate_string(&self.kind, MAX_ID_BYTES, false, "intent kind")?;
        validate_string(
            &self.parameters_json,
            MAX_TEXT_BYTES,
            false,
            "parametersJson",
        )
    }
}

impl DeclarationSummary {
    fn validate(&self) -> Result<()> {
        validate_string(&self.node_id, MAX_ID_BYTES, false, "nodeId")?;
        validate_string(&self.kind, MAX_ID_BYTES, false, "kind")?;
        validate_string(&self.name, MAX_ID_BYTES, false, "name")?;
        validate_string(&self.module_id, MAX_ID_BYTES, false, "moduleId")
    }
}

impl ModuleSummary {
    fn validate(&self) -> Result<()> {
        validate_string(&self.module_id, MAX_ID_BYTES, false, "moduleId")?;
        validate_module_path(&self.path)
    }
}

impl FixtureSummary {
    fn validate(&self) -> Result<()> {
        validate_digest_field(&self.fixture_id, "fixtureId")?;
        validate_module_path(&self.path)
    }
}

impl ModuleDeclarationSummary {
    fn validate(&self) -> Result<()> {
        validate_string(&self.node_id, MAX_ID_BYTES, false, "nodeId")?;
        validate_optional_id(&self.name, "name")?;
        if !DISCOVERY_STATEMENT_KINDS.contains(&self.kind.as_str()) {
            bail!("kind is not a supported discovery statement kind");
        }
        Ok(())
    }
}

impl ReferenceSummary {
    fn validate(&self) -> Result<()> {
        validate_string(&self.from_node_id, MAX_ID_BYTES, false, "fromNodeId")?;
        validate_string(&self.kind, MAX_ID_BYTES, false, "kind")?;
        validate_string(&self.module_id, MAX_ID_BYTES, false, "moduleId")
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
        validate_optional_id(&self.node_id, "diagnostic nodeId")?;
        if let Some(module_path) = &self.module_path {
            validate_module_path(module_path)?;
        }
        Ok(())
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

/// Deserializes a NULLABLE-but-REQUIRED digest.
///
/// serde treats a bare `Option<T>` field as implicitly defaulted, so a
/// `hello` response that simply omitted `validationManifestDigest` would parse
/// as `None` and silently read as "no manifest". Naming a `deserialize_with`
/// suppresses that implicit default, so the key must be present — `null` or a
/// digest, never absent.
fn required_nullable_digest<'de, D>(deserializer: D) -> std::result::Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

fn validate_optional_digest(value: &Option<String>) -> Result<()> {
    if let Some(value) = value {
        validate_digest(value)?;
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<()> {
    validate_digest_field(value, "publicationDigest")
}

/// Standard padded base64 (RFC 4648), the only encoding this wire emits for
/// fixture bytes. Validated structurally — length a multiple of four, padding
/// only in the final group — so a malformed chunk is refused at the protocol
/// boundary instead of decoding to something surprising client-side.
fn validate_base64(value: &str) -> Result<()> {
    if value.len() % 4 != 0 {
        bail!("contentBase64 length must be a multiple of four");
    }
    let unpadded = value.trim_end_matches('=');
    if value.len() - unpadded.len() > 2 {
        bail!("contentBase64 has more than two padding characters");
    }
    if !unpadded.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'
    }) {
        bail!("contentBase64 contains a character outside the base64 alphabet");
    }
    Ok(())
}

fn validate_digest_field(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

pub const MAX_MODULE_PATH_BYTES: usize = 512;

/// Persisted top-level statement kinds the discovery surface counts and
/// lists — the same set `PRODUCT_KINDS` maps to in kernel.rs, mirrored from
/// `packages/store/src/discovery.ts` DISCOVERY_KINDS.
const DISCOVERY_STATEMENT_KINDS: [&str; 5] = [
    "InterfaceDeclaration",
    "TypeAliasDeclaration",
    "ClassDeclaration",
    "FunctionDeclaration",
    "FirstStatement",
];

fn validate_page_limit(limit: u32, max: usize, action: &str) -> Result<()> {
    if limit == 0 || limit as usize > max {
        bail!("{action} limit is outside the supported bound");
    }
    Ok(())
}

pub(super) fn validate_module_path(value: &str) -> Result<()> {
    if value.is_empty() {
        bail!("module path must not be empty");
    }
    if value.len() > MAX_MODULE_PATH_BYTES {
        bail!("module path exceeds {MAX_MODULE_PATH_BYTES} UTF-8 bytes");
    }
    if value.starts_with('/') || value.contains('\\') {
        bail!("module path must be corpus-relative POSIX");
    }
    if value
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        bail!("module path contains an invalid segment");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A legitimately committed change set may carry up to the session's
    /// `MAX_INTENTS` (256) intents; the `read_operation` response validator
    /// must accept exactly that many and reject one more. This pins the
    /// finding that `MAX_OPERATION_INTENTS` must track `MAX_INTENTS`.
    fn operation_result_with_intents(count: usize) -> ResponseResult {
        ResponseResult::Operation {
            graph_generation: WireU64::new(1),
            operation_id: "operation:test".to_string(),
            change_set_id: "changeset:test".to_string(),
            actor: "actor:test".to_string(),
            kind: "RenameSymbol".to_string(),
            reasoning: "test".to_string(),
            affected_node_ids: Vec::new(),
            renames: Vec::new(),
            intents: (0..count)
                .map(|i| OperationIntentSummary {
                    kind: format!("Intent{i}"),
                    parameters_json: "{}".to_string(),
                })
                .collect(),
            publication_digest: "a".repeat(64),
        }
    }

    /// Mirrors session.rs's `MAX_INTENTS`; see the comment on
    /// `MAX_OPERATION_INTENTS` for why this is a hand-kept literal rather
    /// than a shared import.
    const SESSION_MAX_INTENTS: usize = 256;

    #[test]
    fn read_operation_response_accepts_max_intents_boundary() {
        assert_eq!(MAX_OPERATION_INTENTS, SESSION_MAX_INTENTS);
        operation_result_with_intents(SESSION_MAX_INTENTS)
            .validate()
            .expect("response at the MAX_INTENTS boundary must validate");
    }

    #[test]
    fn read_operation_response_rejects_one_past_max_intents() {
        let error = operation_result_with_intents(SESSION_MAX_INTENTS + 1)
            .validate()
            .expect_err("response one past MAX_INTENTS must be rejected");
        assert!(error.to_string().contains("intents"));
    }

    #[test]
    fn list_modules_request_rejects_zero_and_over_bound_limits() {
        for limit in [0u32, 65] {
            let action = RequestAction::ListModules {
                after_module_id: None,
                limit,
            };
            assert!(action.validate().is_err(), "limit {limit} must be rejected");
        }
        let action = RequestAction::ListModules {
            after_module_id: None,
            limit: 64,
        };
        action.validate().expect("limit 64 must validate");
    }

    #[test]
    fn module_path_validator_fails_closed() {
        for bad in [
            "",
            "/abs/path.ts",
            "src\\win.ts",
            "src/../escape.ts",
            "src//x.ts",
            "./src/x.ts",
            "src/./x.ts",
        ] {
            assert!(
                validate_module_path(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        validate_module_path("src/types/user.ts").expect("relative POSIX path must validate");
    }

    #[test]
    fn diagnostic_module_path_is_optional_but_validated() {
        let bare = Diagnostic {
            code: "c".into(),
            message: "m".into(),
            node_id: None,
            module_path: None,
        };
        bare.validate().expect("absent modulePath must validate");
        assert!(!serde_json::to_string(&bare).unwrap().contains("modulePath"));
        let good = Diagnostic {
            module_path: Some("src/x.ts".into()),
            ..bare.clone()
        };
        good.validate()
            .expect("relative POSIX modulePath must validate");
        for bad in ["/abs/x.ts", "src/../x.ts", ""] {
            let diagnostic = Diagnostic {
                module_path: Some(bad.into()),
                ..bare.clone()
            };
            assert!(diagnostic.validate().is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn module_declarations_response_rejects_unknown_kind() {
        let result = ResponseResult::ModuleDeclarations {
            graph_generation: WireU64::new(1),
            declarations: vec![ModuleDeclarationSummary {
                node_id: "n1".into(),
                name: None,
                kind: "EnumDeclaration".into(),
                exported: false,
            }],
            has_more: false,
        };
        assert!(result.validate().is_err());
    }

    #[test]
    fn get_references_request_bounds_limit_at_256() {
        let ok = RequestAction::GetReferences {
            node_id: "n".into(),
            after_reference_key: None,
            limit: 256,
        };
        ok.validate().expect("limit 256 must validate");
        let over = RequestAction::GetReferences {
            node_id: "n".into(),
            after_reference_key: None,
            limit: 257,
        };
        assert!(over.validate().is_err());
    }

    #[test]
    fn read_validation_fixture_request_bounds_length_at_8192() {
        let digest = "a".repeat(64);
        let ok = RequestAction::ReadValidationFixture {
            fixture_id: digest.clone(),
            offset: WireU64::new(0),
            length: MAX_FIXTURE_CHUNK_BYTES,
        };
        ok.validate().expect("length 8192 must validate");
        for bad_length in [0, MAX_FIXTURE_CHUNK_BYTES + 1] {
            let over = RequestAction::ReadValidationFixture {
                fixture_id: digest.clone(),
                offset: WireU64::new(0),
                length: bad_length,
            };
            assert!(
                over.validate().is_err(),
                "length {bad_length} must be rejected"
            );
        }
    }

    #[test]
    fn read_validation_fixture_request_requires_a_digest_shaped_id() {
        for bad_id in [
            "".to_owned(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            format!("{}g", "a".repeat(63)),
        ] {
            let action = RequestAction::ReadValidationFixture {
                fixture_id: bad_id.clone(),
                offset: WireU64::new(0),
                length: 64,
            };
            assert!(
                action.validate().is_err(),
                "fixtureId {bad_id:?} must be rejected"
            );
        }
    }

    /// An offset past the end of a fixture is a legal request — the daemon
    /// answers it with the terminal empty chunk — so the validator must not
    /// invent a bound the reader does not enforce.
    #[test]
    fn read_validation_fixture_request_accepts_any_offset() {
        let action = RequestAction::ReadValidationFixture {
            fixture_id: "a".repeat(64),
            offset: WireU64::new(u64::MAX),
            length: 1,
        };
        action.validate().expect("any offset must validate");
    }

    #[test]
    fn validation_fixture_chunk_response_bounds_and_alphabet() {
        let chunk = |content: &str| ResponseResult::ValidationFixtureChunk {
            fixture_id: "a".repeat(64),
            offset: WireU64::new(0),
            content_base64: content.to_owned(),
            eof: true,
        };
        chunk("").validate().expect("an empty terminal chunk is legal");
        chunk("Zm9vYmFy").validate().expect("base64 must validate");
        chunk("+/+/").validate().expect("62/63 symbols must validate");
        chunk("Zg==").validate().expect("padding must validate");
        for bad in ["Zm9vYmF", "Zm9*YmFy", "Z===", "Zm9vYmFy="] {
            assert!(chunk(bad).validate().is_err(), "{bad:?} must be rejected");
        }
        let oversized = "A".repeat(MAX_FIXTURE_CHUNK_BASE64_BYTES + 4);
        assert!(chunk(&oversized).validate().is_err());
    }

    #[test]
    fn validation_fixtures_response_bounds_the_listing_and_its_items() {
        let summary = |path: &str| FixtureSummary {
            fixture_id: "a".repeat(64),
            path: path.to_owned(),
            bytes: WireU64::new(10),
        };
        ResponseResult::ValidationFixtures {
            validation_mode: ValidationMode::Behavioral,
            validation_manifest_digest: Some("b".repeat(64)),
            fixtures: vec![summary("tests/greet.test.ts")],
        }
        .validate()
        .expect("a registered fixture listing must validate");
        // tsc-only states its emptiness rather than implying it.
        ResponseResult::ValidationFixtures {
            validation_mode: ValidationMode::TscOnly,
            validation_manifest_digest: None,
            fixtures: Vec::new(),
        }
        .validate()
        .expect("an empty tsc-only listing must validate");
        for bad_path in ["/abs/x.test.ts", "tests/../x.test.ts", ""] {
            let result = ResponseResult::ValidationFixtures {
                validation_mode: ValidationMode::Behavioral,
                validation_manifest_digest: Some("b".repeat(64)),
                fixtures: vec![summary(bad_path)],
            };
            assert!(result.validate().is_err(), "{bad_path:?} must be rejected");
        }
        let over = ResponseResult::ValidationFixtures {
            validation_mode: ValidationMode::Behavioral,
            validation_manifest_digest: Some("b".repeat(64)),
            fixtures: vec![summary("tests/greet.test.ts"); MAX_VALIDATION_FIXTURES + 1],
        };
        assert!(over.validate().is_err());
    }

    /// Pins the frame-headroom assumption from the plan review: a maximal
    /// modules page (64 items, 512-byte paths) serializes well inside
    /// MAX_RESPONSE_FRAME_BYTES.
    #[test]
    fn maximal_modules_page_fits_the_response_frame() {
        let response = LocalServiceResponse::success(
            "request:max-page",
            ResponseResult::Modules {
                graph_generation: WireU64::new(1),
                modules: (0..64)
                    .map(|index| ModuleSummary {
                        module_id: format!("{index:016x}"),
                        path: format!("src/{}.ts", "a".repeat(MAX_MODULE_PATH_BYTES - 7)),
                        declaration_count: u32::MAX,
                    })
                    .collect(),
                has_more: true,
            },
        );
        serialize_response_frame(&response).expect("maximal modules page must fit the frame");
    }
}

