mod analyzer;
mod authority;
mod coordinator;
mod durable;
mod model;
mod resources;
mod scheduler;

#[cfg(not(feature = "coordination-test-api"))]
pub(crate) use analyzer::IntentAnalysis;
pub use analyzer::{
    CandidateBuilder, ScopeChange, canonical_scope_fingerprint, classify_scope_change,
    validate_delta_containment,
};
#[cfg(feature = "coordination-test-api")]
pub use analyzer::{DeltaAuthority, IntentAnalysis, required_delta_authority};
pub(crate) use authority::SemanticProvider;
#[cfg(feature = "coordination-test-api")]
pub(crate) use authority::TestSemanticAdapter;
#[cfg(feature = "coordination-test-api")]
pub use authority::{TestSemanticProvider, analyze_change_set};
pub use coordinator::{
    BeginChangeSet, CancellationOutcome, MAX_WAKE_AFFECTED_NODE_IDS, READY_OFFER_TTL_TICKS,
};
pub use durable::{
    CoordinationDurable, CoordinationFailpoint, CoordinationMetadataState, CoordinationTableCounts,
    CreateDraftOutcome,
};
pub(crate) use durable::{LifecycleTransition, ensure_coordination_schema};
pub use model::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationError,
    CoordinationEvent, CoordinationEventKind, CoordinationTicket, DynamicExpansionPolicy,
    EventCursor, IdempotencyClass, InferredScope, IntentParameters, IntentRecord, ReadyOffer,
    ResourceVersion, SubmissionOutcome, TicketState,
};
pub use resources::DependencyVersion;
#[cfg(feature = "coordination-test-api")]
pub use resources::affected_resource_keys;
pub(crate) use resources::{ResourceClockSnapshot, affected_resource_keys as resource_keys};
pub use scheduler::SchedulerState;
