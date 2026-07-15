use crate::SCHEMA_VERSION;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoordinationError {
    SemanticProviderUnavailable,
    OptimisticRetryExhausted { attempts: u32 },
    CandidateDigestMismatch,
    AttemptDigestMismatch,
    LeaseExpired,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationAttemptRecord {
    pub change_set_id: String,
    pub attempt_id: String,
    pub candidate_digest: String,
    pub generation: u64,
    pub graph_digest: String,
}

impl std::fmt::Display for CoordinationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SemanticProviderUnavailable => {
                write!(formatter, "semantic provider is unavailable")
            }
            Self::OptimisticRetryExhausted { attempts } => {
                write!(
                    formatter,
                    "optimistic coordination retry exhausted after {attempts} attempts"
                )
            }
            Self::CandidateDigestMismatch => {
                write!(formatter, "candidate digest does not match its delta")
            }
            Self::AttemptDigestMismatch => write!(
                formatter,
                "attempt id was reused with a different change set or candidate digest"
            ),
            Self::LeaseExpired => write!(formatter, "coordination authority lease has expired"),
        }
    }
}

impl std::error::Error for CoordinationError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IntentParameters {
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
    fn validate(&self, intent_id: &str) -> Result<(), String> {
        match self {
            Self::RenameSymbol { declaration_id, .. } if declaration_id.is_empty() => {
                Err(format!("intent {intent_id} has an empty declaration_id"))
            }
            Self::AddParameter { function_id, .. } if function_id.is_empty() => {
                Err(format!("intent {intent_id} has an empty function_id"))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeSetState {
    Draft,
    Queued,
    Ready,
    Executing,
    Committed,
    NeedsDecision,
    Cancelled,
    Failed,
}

impl ChangeSetState {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Committed | Self::NeedsDecision | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketState {
    Queued,
    Ready,
    Claimed,
    Completed,
    NeedsDecision,
    Cancelled,
    Failed,
}

impl TicketState {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::NeedsDecision | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoordinationEventKind {
    IntentQueued,
    IntentReady,
    IntentNeedsDecision,
    IntentCommitted,
    IntentCancelled,
    IntentFailed,
    LeaseExpired,
    ScopeExpanded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdempotencyClass {
    ReplaySafe,
    RequiresDecision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DynamicExpansionPolicy {
    Requeue { max_expansions: u32 },
    NeedsDecision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceVersion {
    pub resource_key: String,
    pub version: String,
}

impl ResourceVersion {
    pub fn new(
        resource_key: impl Into<String>,
        version: impl Into<String>,
    ) -> Result<Self, String> {
        let record = Self {
            resource_key: resource_key.into(),
            version: version.into(),
        };
        if record.resource_key.is_empty() {
            return Err("resource version has an empty resource_key".into());
        }
        Ok(record)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredScope {
    pub read_set: Vec<ResourceVersion>,
    pub write_set: Vec<ResourceVersion>,
    pub validation_set: Vec<ResourceVersion>,
    pub reservation_keys: Vec<String>,
    pub scope_fingerprint: String,
    pub dynamic_expansion_policy: DynamicExpansionPolicy,
    pub idempotency_class: IdempotencyClass,
}

impl InferredScope {
    pub fn validate(&self) -> Result<(), String> {
        for resource in self
            .read_set
            .iter()
            .chain(&self.write_set)
            .chain(&self.validation_set)
        {
            if resource.resource_key.is_empty() {
                return Err("inferred scope has an empty resource_key".into());
            }
        }
        if self.reservation_keys.iter().any(String::is_empty) {
            return Err("inferred scope has an empty reservation key".into());
        }
        if self.scope_fingerprint.is_empty() {
            return Err("inferred scope has an empty scope_fingerprint".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentRecord {
    pub schema_version: u32,
    pub intent_id: String,
    pub change_set_id: String,
    pub base_generation: u64,
    pub parameters: IntentParameters,
}

impl IntentRecord {
    pub fn new(
        schema_version: u32,
        intent_id: impl Into<String>,
        change_set_id: impl Into<String>,
        base_generation: u64,
        parameters: IntentParameters,
    ) -> Result<Self, String> {
        let record = Self {
            schema_version,
            intent_id: intent_id.into(),
            change_set_id: change_set_id.into(),
            base_generation,
            parameters,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_schema(self.schema_version, "intent", &self.intent_id)?;
        validate_id("intent_id", &self.intent_id)?;
        validate_id("change_set_id", &self.change_set_id)?;
        self.parameters.validate(&self.intent_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetRecord {
    pub schema_version: u32,
    pub change_set_id: String,
    pub actor: String,
    pub reasoning: String,
    pub base_generation: u64,
    pub state: ChangeSetState,
    pub submission_idempotency_key: String,
    pub intent_ids: Vec<String>,
    pub inferred_scope: Option<InferredScope>,
    pub queue_sequence: Option<u64>,
    pub expansion_count: u32,
    pub blocking_change_set_id: Option<String>,
    pub committed_generation: Option<u64>,
    #[serde(default)]
    pub created_at_tick: u64,
    #[serde(default)]
    pub expires_at_tick: Option<u64>,
}

impl ChangeSetRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schema_version: u32,
        change_set_id: impl Into<String>,
        actor: impl Into<String>,
        reasoning: impl Into<String>,
        base_generation: u64,
        submission_idempotency_key: impl Into<String>,
        intents: &[IntentRecord],
    ) -> Result<Self, String> {
        let change_set_id = change_set_id.into();
        validate_schema(schema_version, "change set", &change_set_id)?;
        validate_id("change_set_id", &change_set_id)?;

        let mut seen = HashSet::new();
        let mut intent_ids = Vec::with_capacity(intents.len());
        for intent in intents {
            intent.validate()?;
            if intent.change_set_id != change_set_id {
                return Err(format!(
                    "intent {} belongs to change set {}, not {}",
                    intent.intent_id, intent.change_set_id, change_set_id
                ));
            }
            if !seen.insert(intent.intent_id.as_str()) {
                return Err(format!(
                    "change set {change_set_id} contains duplicate intent ID {}",
                    intent.intent_id
                ));
            }
            intent_ids.push(intent.intent_id.clone());
        }

        let actor = actor.into();
        let submission_idempotency_key = submission_idempotency_key.into();
        validate_id("actor", &actor)?;
        validate_id("submission_idempotency_key", &submission_idempotency_key)?;

        Ok(Self {
            schema_version,
            change_set_id,
            actor,
            reasoning: reasoning.into(),
            base_generation,
            state: ChangeSetState::Draft,
            submission_idempotency_key,
            intent_ids,
            inferred_scope: None,
            queue_sequence: None,
            expansion_count: 0,
            blocking_change_set_id: None,
            committed_generation: None,
            created_at_tick: 0,
            expires_at_tick: None,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_schema(self.schema_version, "change set", &self.change_set_id)?;
        validate_id("change_set_id", &self.change_set_id)?;
        validate_id("actor", &self.actor)?;
        validate_id(
            "submission_idempotency_key",
            &self.submission_idempotency_key,
        )?;
        let mut seen = HashSet::new();
        for intent_id in &self.intent_ids {
            validate_id("intent_id", intent_id)?;
            if !seen.insert(intent_id.as_str()) {
                return Err(format!(
                    "change set {} contains duplicate intent ID {intent_id}",
                    self.change_set_id
                ));
            }
        }
        if let Some(scope) = &self.inferred_scope {
            scope.validate()?;
        }
        if self
            .blocking_change_set_id
            .as_ref()
            .is_some_and(String::is_empty)
        {
            return Err(format!(
                "change set {} has an empty blocking_change_set_id",
                self.change_set_id
            ));
        }
        Ok(())
    }

    pub fn transition_to(&mut self, next: ChangeSetState) -> Result<(), String> {
        if self.state.is_terminal() && !next.is_terminal() {
            return Err(format!(
                "change set {} cannot transition from {:?} to {:?}",
                self.change_set_id, self.state, next
            ));
        }
        self.state = next;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationTicket {
    pub schema_version: u32,
    pub ticket_id: String,
    pub change_set_id: String,
    pub state: TicketState,
    pub scope_fingerprint: String,
    pub reservation_keys: Vec<String>,
    pub queue_sequence: u64,
    pub age_rounds: u64,
    pub ready_offer_id: Option<String>,
    pub active_claim_id: Option<String>,
}

impl CoordinationTicket {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schema_version: u32,
        ticket_id: impl Into<String>,
        change_set_id: impl Into<String>,
        state: TicketState,
        scope_fingerprint: impl Into<String>,
        reservation_keys: Vec<String>,
        queue_sequence: u64,
    ) -> Result<Self, String> {
        let record = Self {
            schema_version,
            ticket_id: ticket_id.into(),
            change_set_id: change_set_id.into(),
            state,
            scope_fingerprint: scope_fingerprint.into(),
            reservation_keys,
            queue_sequence,
            age_rounds: 0,
            ready_offer_id: None,
            active_claim_id: None,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_schema(self.schema_version, "ticket", &self.ticket_id)?;
        validate_id("ticket_id", &self.ticket_id)?;
        validate_id("change_set_id", &self.change_set_id)?;
        validate_id("scope_fingerprint", &self.scope_fingerprint)?;
        validate_ids("reservation key", &self.reservation_keys)?;
        validate_optional_id("ready_offer_id", &self.ready_offer_id)?;
        validate_optional_id("active_claim_id", &self.active_claim_id)
    }

    pub fn transition_to(&mut self, next: TicketState) -> Result<(), String> {
        if self.state.is_terminal() && !next.is_terminal() {
            return Err(format!(
                "ticket {} cannot transition from {:?} to {:?}",
                self.ticket_id, self.state, next
            ));
        }
        self.state = next;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyOffer {
    pub schema_version: u32,
    pub offer_id: String,
    pub change_set_id: String,
    pub service_epoch: u64,
    pub graph_generation: u64,
    pub scope_fingerprint: String,
    pub claim_token: String,
    pub expires_at_tick: u64,
    pub blocking_event_sequence: Option<u64>,
}

impl ReadyOffer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schema_version: u32,
        offer_id: impl Into<String>,
        change_set_id: impl Into<String>,
        service_epoch: u64,
        graph_generation: u64,
        scope_fingerprint: impl Into<String>,
        claim_token: impl Into<String>,
        expires_at_tick: u64,
        blocking_event_sequence: Option<u64>,
    ) -> Result<Self, String> {
        let record = Self {
            schema_version,
            offer_id: offer_id.into(),
            change_set_id: change_set_id.into(),
            service_epoch,
            graph_generation,
            scope_fingerprint: scope_fingerprint.into(),
            claim_token: claim_token.into(),
            expires_at_tick,
            blocking_event_sequence,
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_schema(self.schema_version, "offer", &self.offer_id)?;
        validate_id("offer_id", &self.offer_id)?;
        validate_id("change_set_id", &self.change_set_id)?;
        validate_id("scope_fingerprint", &self.scope_fingerprint)?;
        validate_id("claim_token", &self.claim_token)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimHandle {
    pub claim_id: String,
    pub change_set_id: String,
    pub offer_id: String,
    pub service_epoch: u64,
    pub graph_generation: u64,
    pub scope_fingerprint: String,
    pub reservation_keys: Vec<String>,
    #[serde(default)]
    pub attempt_id: String,
    #[serde(default)]
    pub expires_at_tick: u64,
    #[serde(default)]
    pub dependency_versions: Vec<super::DependencyVersion>,
}

impl ClaimHandle {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        claim_id: impl Into<String>,
        change_set_id: impl Into<String>,
        offer_id: impl Into<String>,
        service_epoch: u64,
        graph_generation: u64,
        scope_fingerprint: impl Into<String>,
        reservation_keys: Vec<String>,
    ) -> Result<Self, String> {
        let record = Self {
            claim_id: claim_id.into(),
            change_set_id: change_set_id.into(),
            offer_id: offer_id.into(),
            service_epoch,
            graph_generation,
            scope_fingerprint: scope_fingerprint.into(),
            reservation_keys,
            attempt_id: String::new(),
            expires_at_tick: 0,
            dependency_versions: Vec::new(),
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_id("claim_id", &self.claim_id)?;
        validate_id("change_set_id", &self.change_set_id)?;
        validate_id("offer_id", &self.offer_id)?;
        validate_id("scope_fingerprint", &self.scope_fingerprint)?;
        validate_ids("reservation key", &self.reservation_keys)?;
        if !self.attempt_id.is_empty() {
            validate_id("attempt_id", &self.attempt_id)?;
        }
        if self
            .dependency_versions
            .iter()
            .any(|dependency| dependency.resource_key.is_empty())
        {
            return Err("claim dependency resource key cannot be empty".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseExpiryOutcome {
    pub change_set_id: String,
    pub authority_kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationEvent {
    pub schema_version: u32,
    pub event_id: String,
    pub sequence: u64,
    pub kind: CoordinationEventKind,
    pub change_set_id: String,
    pub graph_generation: u64,
    pub payload_json: String,
}

impl CoordinationEvent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        schema_version: u32,
        event_id: impl Into<String>,
        sequence: u64,
        kind: CoordinationEventKind,
        change_set_id: impl Into<String>,
        graph_generation: u64,
        payload_json: impl Into<String>,
    ) -> Result<Self, String> {
        let record = Self {
            schema_version,
            event_id: event_id.into(),
            sequence,
            kind,
            change_set_id: change_set_id.into(),
            graph_generation,
            payload_json: payload_json.into(),
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_schema(self.schema_version, "event", &self.event_id)?;
        validate_id("event_id", &self.event_id)?;
        validate_id("change_set_id", &self.change_set_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCursor {
    pub client_id: String,
    pub acknowledged_sequence: u64,
}

impl EventCursor {
    pub fn new(client_id: impl Into<String>, acknowledged_sequence: u64) -> Result<Self, String> {
        let record = Self {
            client_id: client_id.into(),
            acknowledged_sequence,
        };
        validate_id("client_id", &record.client_id)?;
        Ok(record)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmissionOutcome {
    Ready {
        ticket: CoordinationTicket,
        offer: ReadyOffer,
    },
    Queued {
        ticket: CoordinationTicket,
    },
    Duplicate {
        change_set: ChangeSetRecord,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaimOutcome {
    Claimed(ClaimHandle),
    Requeued {
        ticket: CoordinationTicket,
        event: CoordinationEvent,
    },
    NeedsDecision {
        change_set: ChangeSetRecord,
        event: CoordinationEvent,
    },
}

fn validate_schema(schema_version: u32, kind: &str, id: &str) -> Result<(), String> {
    if schema_version != SCHEMA_VERSION {
        return Err(format!(
            "{kind} {id:?} has unsupported schema version {schema_version}; expected {SCHEMA_VERSION}"
        ));
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    Ok(())
}

fn validate_ids(kind: &str, values: &[String]) -> Result<(), String> {
    if values.iter().any(String::is_empty) {
        return Err(format!("{kind} cannot be empty"));
    }
    Ok(())
}

fn validate_optional_id(field: &str, value: &Option<String>) -> Result<(), String> {
    if value.as_ref().is_some_and(String::is_empty) {
        return Err(format!("{field} cannot be empty"));
    }
    Ok(())
}
