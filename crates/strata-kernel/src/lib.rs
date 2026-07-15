mod bridge;
mod coordination;
mod graph;
mod kernel;
mod model;
mod storage;

pub use bridge::NodeBridgeConfig;

#[cfg(feature = "coordination-test-api")]
pub use coordination::affected_resource_keys;
pub use coordination::{
    BeginChangeSet, CLAIM_TTL_TICKS, CancellationOutcome, ChangeSetRecord, ChangeSetState,
    ClaimHandle, ClaimOutcome, CoordinationDurable, CoordinationError, CoordinationEvent,
    CoordinationEventKind, CoordinationFailpoint, CoordinationMetadataState,
    CoordinationTableCounts, CoordinationTicket, CreateDraftOutcome, DRAFT_TTL_TICKS,
    DependencyVersion, DynamicExpansionPolicy, EventCursor, IdempotencyClass, InferredScope,
    IntentParameters, IntentRecord, LeaseExpiryOutcome, MAX_WAKE_AFFECTED_NODE_IDS,
    READY_OFFER_TTL_TICKS, ReadyOffer, ResourceVersion, SchedulerState, ScopeChange,
    SubmissionOutcome, TicketState, canonical_scope_fingerprint, classify_scope_change,
    validate_delta_containment,
};
#[cfg(feature = "coordination-test-api")]
pub use coordination::{
    CandidateBuilder, CandidateEnvelope, PreparedCandidate, PublicationAttemptRecord,
    PublishClaimOutcome, RecoveryMetadataState, RecoveryValidationMigration,
    canonical_candidate_digest,
};
#[cfg(feature = "coordination-test-api")]
pub use coordination::{
    DeltaAuthority, IntentAnalysis, TestSemanticProvider, analyze_change_set,
    required_delta_authority,
};
pub use graph::GraphGeneration;
#[cfg(feature = "redb-spike-api")]
pub use kernel::PublishFailpoint;
pub use kernel::{Kernel, PublicationReport, RecoveryReport};
pub use model::{
    EventRecord, GraphChange, GraphDelta, GraphSnapshot, NodeRecord, OperationRecord,
    ReferenceRecord, SCHEMA_VERSION, TicketRecord,
};
#[cfg(feature = "redb-spike-api")]
pub use model::{FenceClaim, Publication};
#[cfg(feature = "redb-spike-api")]
pub use storage::{CoordinatedPublishFailpoint, DurableStore, PublishOutcome};
