mod analyzer;
mod durable;
mod model;

pub use analyzer::{
    DeltaAuthority, IntentAnalysis, IntentAnalyzer, ScopeChange, analyze_change_set,
    canonical_scope_fingerprint, classify_scope_change, required_delta_authority,
    validate_delta_containment,
};
pub(crate) use durable::ensure_coordination_schema;
pub use durable::{
    CoordinationDurable, CoordinationFailpoint, CoordinationMetadataState, CoordinationTableCounts,
    CreateDraftOutcome,
};
pub use model::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, DynamicExpansionPolicy, EventCursor,
    IdempotencyClass, InferredScope, IntentParameters, IntentRecord, ReadyOffer, ResourceVersion,
    SubmissionOutcome, TicketState,
};
