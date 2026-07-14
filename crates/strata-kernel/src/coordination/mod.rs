mod analyzer;
mod coordinator;
mod durable;
mod model;
mod scheduler;

pub use analyzer::{
    CandidateBuilder, DeltaAuthority, IntentAnalysis, IntentAnalyzer, ScopeChange,
    analyze_change_set, canonical_scope_fingerprint, classify_scope_change,
    required_delta_authority, validate_delta_containment,
};
pub use coordinator::{BeginChangeSet, CancellationOutcome, READY_OFFER_TTL_TICKS};
pub use durable::{
    CoordinationDurable, CoordinationFailpoint, CoordinationMetadataState, CoordinationTableCounts,
    CreateDraftOutcome,
};
pub(crate) use durable::{LifecycleTransition, ensure_coordination_schema};
pub use model::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, DynamicExpansionPolicy, EventCursor,
    IdempotencyClass, InferredScope, IntentParameters, IntentRecord, ReadyOffer, ResourceVersion,
    SubmissionOutcome, TicketState,
};
pub use scheduler::SchedulerState;
