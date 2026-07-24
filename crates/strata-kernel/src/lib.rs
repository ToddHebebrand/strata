mod bridge;
mod coordination;
mod graph;
mod kernel;
mod model;
mod storage;
mod sync_digest;

pub use bridge::{NodeBridgeConfig, WorkerRunMetrics, WorkerSelfMetrics};

#[cfg(feature = "coordination-test-api")]
pub use coordination::affected_resource_keys;
pub use coordination::{
    BeginChangeSet, CLAIM_TTL_TICKS, CancellationOutcome, ChangeSetRecord, ChangeSetState,
    ClaimHandle, ClaimOutcome, CoordinationError, CoordinationEvent, CoordinationEventKind,
    CoordinationMetadataState, CoordinationTableCounts, CoordinationTicket, CreateDraftOutcome,
    DRAFT_TTL_TICKS, DependencyVersion, DynamicExpansionPolicy, EventCursor, IdempotencyClass,
    InferredScope, IntentParameters, IntentRecord, LeaseExpiryOutcome, MAX_RENAMED_SYMBOLS,
    MAX_WAKE_AFFECTED_NODE_IDS, PublishClaimOutcome, READY_OFFER_TTL_TICKS, ReadyOffer,
    ResourceVersion, SchedulerState, ScopeChange, SubmissionOutcome, TicketState,
    canonical_scope_fingerprint, classify_scope_change, fold_operation_renames,
    validate_delta_containment,
};
#[cfg(feature = "coordination-test-api")]
pub use coordination::{
    CandidateBuilder, CandidateEnvelope, PreparedCandidate, PublicationAttemptRecord,
    RecoveryMetadataState, RecoveryValidationMigration,
};
#[cfg(feature = "coordination-test-api")]
pub use coordination::{CoordinationDurable, CoordinationFailpoint};
#[cfg(feature = "coordination-test-api")]
pub use coordination::{
    DeltaAuthority, IntentAnalysis, TestSemanticProvider, analyze_change_set,
    required_delta_authority,
};
pub use graph::GraphGeneration;
#[cfg(feature = "redb-spike-api")]
pub use kernel::PublishFailpoint;
pub use kernel::{
    DeclarationMatch, Kernel, MAX_DECLARATION_MATCHES, PublicationReport, RecoveryReport,
};
pub use model::{
    EventRecord, GraphChange, GraphDelta, GraphSnapshot, NodeRecord, OperationIntentRecord,
    OperationRecord, OperationRename, ReferenceRecord, SCHEMA_VERSION, TicketRecord,
};
#[cfg(feature = "redb-spike-api")]
pub use model::{FenceClaim, Publication};
#[cfg(feature = "redb-spike-api")]
pub use storage::{CoordinatedPublishFailpoint, DurableStore, PublishOutcome};
pub use sync_digest::canonical_sync_digest;
