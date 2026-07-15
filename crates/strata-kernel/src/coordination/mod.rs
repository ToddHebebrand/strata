mod analyzer;
mod authority;
mod coordinator;
mod durable;
mod model;
mod planner;
mod publication;
mod resources;
mod scheduler;

#[cfg(not(feature = "coordination-test-api"))]
pub(crate) use analyzer::IntentAnalysis;
#[cfg(feature = "coordination-test-api")]
pub use analyzer::{DeltaAuthority, IntentAnalysis, required_delta_authority};
pub use analyzer::{
    ScopeChange, canonical_scope_fingerprint, classify_scope_change, validate_delta_containment,
};
pub(crate) use analyzer::{expansion_policy_for_intent, idempotency_for_intent};
pub(crate) use authority::SemanticProvider;
#[cfg(feature = "coordination-test-api")]
pub(crate) use authority::TestSemanticAdapter;
#[cfg(not(feature = "coordination-test-api"))]
pub(crate) use authority::canonical_candidate_digest;
#[cfg(feature = "coordination-test-api")]
pub use authority::canonical_candidate_digest;
#[cfg(feature = "coordination-test-api")]
pub use authority::{
    CandidateBuilder, CandidateEnvelope, PreparedCandidate, PublishClaimOutcome,
    TestSemanticProvider, analyze_change_set,
};
pub use coordinator::{
    BeginChangeSet, CLAIM_TTL_TICKS, CancellationOutcome, DRAFT_TTL_TICKS,
    MAX_WAKE_AFFECTED_NODE_IDS, READY_OFFER_TTL_TICKS,
};
#[cfg(feature = "coordination-test-api")]
pub(crate) use durable::PUBLICATION_ATTEMPTS;
pub use durable::{
    CoordinationDurable, CoordinationFailpoint, CoordinationMetadataState, CoordinationTableCounts,
    CreateDraftOutcome,
};
pub(crate) use durable::{
    LifecycleTransition, RecoveryMigrationPlan, ensure_coordination_schema,
    initialize_coordination_validation_metadata,
};
#[cfg(feature = "coordination-test-api")]
pub use durable::{RecoveryMetadataState, RecoveryValidationMigration};
#[cfg(not(feature = "coordination-test-api"))]
pub(crate) use model::PublicationAttemptRecord;
#[cfg(feature = "coordination-test-api")]
pub use model::PublicationAttemptRecord;
pub use model::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationError,
    CoordinationEvent, CoordinationEventKind, CoordinationTicket, DynamicExpansionPolicy,
    EventCursor, IdempotencyClass, InferredScope, IntentParameters, IntentRecord,
    LeaseExpiryOutcome, ReadyOffer, ResourceVersion, SubmissionOutcome, TicketState,
};
pub(crate) use planner::{MAX_OPTIMISTIC_RETRIES, TransitionCause};
pub use resources::DependencyVersion;
pub(crate) use resources::ResourceClockSnapshot;
#[cfg(feature = "coordination-test-api")]
pub use resources::affected_resource_keys;
#[cfg(feature = "coordination-test-api")]
pub(crate) use resources::affected_resource_keys as resource_keys;
pub(crate) use resources::{
    children_resource, edge_resource, membership_resource, node_resource, references_to_resource,
};
pub use scheduler::SchedulerState;
