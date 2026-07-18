use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
#[cfg(feature = "redb-spike-api")]
use std::time::Instant;

use anyhow::{Context, Result, bail, ensure};

use crate::bridge::{
    CandidateExecutor, NodeBridgeClient, NodeBridgeConfig, NodeCandidateExecutor,
    NodeSemanticProvider, confirmed_declaration_name,
};
use crate::coordination::{
    CoordinationError, DependencyVersion, ResourceClockSnapshot, SemanticProvider,
};
#[cfg(feature = "coordination-test-api")]
use crate::coordination::{TestSemanticAdapter, TestSemanticProvider};
use crate::model::NodeRecord;
use crate::model::OperationRecord;
#[cfg(feature = "redb-spike-api")]
use crate::model::{FenceClaim, Publication};
use crate::storage::DurableStore;
#[cfg(feature = "redb-spike-api")]
use crate::storage::PublishOutcome;
use crate::{GraphGeneration, GraphSnapshot, SchedulerState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryReport {
    pub snapshot_generation: u64,
    pub replayed_operations: u64,
    pub generation: u64,
    pub digest: String,
    pub service_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicationReport {
    pub generation: u64,
    pub digest: String,
    pub persistence_ns: u128,
    pub memory_publish_ns: u128,
    pub already_published: bool,
}

#[doc(hidden)]
#[cfg(feature = "redb-spike-api")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishFailpoint {
    None,
    BeforeRedbTransaction,
    InsideRedbTransaction,
    AfterRedbCommitBeforeMemoryPublish,
    AfterMemoryPublish,
}

#[cfg(feature = "redb-spike-api")]
impl PublishFailpoint {
    const CRASH_BOUNDARIES: [Self; 4] = [
        Self::BeforeRedbTransaction,
        Self::InsideRedbTransaction,
        Self::AfterRedbCommitBeforeMemoryPublish,
        Self::AfterMemoryPublish,
    ];

    pub fn crash_boundaries() -> std::array::IntoIter<Self, 4> {
        Self::CRASH_BOUNDARIES.into_iter()
    }

    pub const fn boundary_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::BeforeRedbTransaction => "beforeRedbTransaction",
            Self::InsideRedbTransaction => "insideRedbTransaction",
            Self::AfterRedbCommitBeforeMemoryPublish => "afterRedbCommitBeforeMemoryPublish",
            Self::AfterMemoryPublish => "afterMemoryPublish",
        }
    }

    pub fn from_boundary_name(value: &str) -> Option<Self> {
        Self::crash_boundaries().find(|failpoint| failpoint.boundary_name() == value)
    }

    pub const fn expects_committed_state(self) -> bool {
        matches!(
            self,
            Self::AfterRedbCommitBeforeMemoryPublish | Self::AfterMemoryPublish
        )
    }
}

/// Product-facing declaration kind vocabulary mapped to the persisted node kind
/// it corresponds to. This is the discovery-surface kind mapping mirrored from
/// `packages/store/src/queries.ts`.
const PRODUCT_KINDS: [(&str, &str); 5] = [
    ("interface", "InterfaceDeclaration"),
    ("type-alias", "TypeAliasDeclaration"),
    ("class", "ClassDeclaration"),
    ("function", "FunctionDeclaration"),
    ("variable", "FirstStatement"),
];

/// Fail-closed cap on `find_declarations` results.
pub const MAX_DECLARATION_MATCHES: usize = 64;

fn product_kind_to_statement_kind(kind: &str) -> Result<&'static str> {
    PRODUCT_KINDS
        .iter()
        .find(|(product, _)| *product == kind)
        .map(|(_, statement)| *statement)
        .with_context(|| format!("unsupported declaration kind {kind}"))
}

/// One named-declaration discovery match returned by `Kernel::find_declarations`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationMatch {
    pub node_id: String,
    pub kind: String,
    pub name: String,
    pub module_id: String,
}

pub struct Kernel {
    pub(crate) store: DurableStore,
    pub(crate) live: RwLock<Arc<GraphGeneration>>,
    pub(crate) publish_lock: Mutex<()>,
    pub(crate) resource_clocks: RwLock<Arc<ResourceClockSnapshot>>,
    service_epoch: u64,
    pub(crate) scheduler: Mutex<SchedulerState>,
    semantic_provider: Option<Arc<dyn SemanticProvider>>,
    candidate_executor: Option<Arc<dyn CandidateExecutor>>,
}

impl Kernel {
    pub fn create(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
    ) -> Result<(Self, RecoveryReport)> {
        Self::create_inner(path, initial, None, None)
    }

    pub fn create_with_node_bridge(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
        config: NodeBridgeConfig,
    ) -> Result<(Self, RecoveryReport)> {
        let (mut kernel, report) = Self::create_inner(path, initial, None, None)?;
        let client = Arc::new(NodeBridgeClient::new(config));
        kernel.semantic_provider = Some(Arc::new(NodeSemanticProvider::new(
            client.clone(),
            report.service_epoch,
        )));
        kernel.candidate_executor = Some(Arc::new(NodeCandidateExecutor::new(
            client,
            report.service_epoch,
        )));
        Ok((kernel, report))
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn create_with_test_semantics(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
        provider: Arc<dyn TestSemanticProvider>,
    ) -> Result<(Self, RecoveryReport)> {
        Self::create_inner(
            path,
            initial,
            Some(Arc::new(TestSemanticAdapter(provider))),
            None,
        )
    }

    fn create_inner(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
        candidate_executor: Option<Arc<dyn CandidateExecutor>>,
    ) -> Result<(Self, RecoveryReport)> {
        let graph = Arc::new(GraphGeneration::from_snapshot(initial.clone())?);
        let store = DurableStore::create(path)?;
        store.seed(&initial)?;
        let resource_clocks = Arc::new(ResourceClockSnapshot::from_clocks(
            store.coordination().resource_clocks()?,
        ));
        let service_epoch = store.begin_service_epoch()?;
        let report = RecoveryReport {
            snapshot_generation: graph.generation(),
            replayed_operations: 0,
            generation: graph.generation(),
            digest: graph.digest().to_owned(),
            service_epoch,
        };
        let scheduler_revision = store.coordination().metadata_state()?.scheduler_revision;
        let scheduler = SchedulerState::recover_with_revision(
            scheduler_revision,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?;
        Ok((
            Self::from_parts(
                store,
                graph,
                resource_clocks,
                service_epoch,
                scheduler,
                semantic_provider,
                candidate_executor,
            ),
            report,
        ))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<(Self, RecoveryReport)> {
        Self::open_inner(path, None, None)
    }

    pub fn open_with_node_bridge(
        path: impl AsRef<Path>,
        config: NodeBridgeConfig,
    ) -> Result<(Self, RecoveryReport)> {
        let (mut kernel, report) = Self::open_inner(path, None, None)?;
        let client = Arc::new(NodeBridgeClient::new(config));
        kernel.semantic_provider = Some(Arc::new(NodeSemanticProvider::new(
            client.clone(),
            report.service_epoch,
        )));
        kernel.candidate_executor = Some(Arc::new(NodeCandidateExecutor::new(
            client,
            report.service_epoch,
        )));
        kernel.plan_and_apply_readiness(0, crate::coordination::TransitionCause::Restart, None)?;
        Ok((kernel, report))
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn open_with_test_semantics(
        path: impl AsRef<Path>,
        provider: Arc<dyn TestSemanticProvider>,
    ) -> Result<(Self, RecoveryReport)> {
        Self::open_inner(path, Some(Arc::new(TestSemanticAdapter(provider))), None)
    }

    fn open_inner(
        path: impl AsRef<Path>,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
        candidate_executor: Option<Arc<dyn CandidateExecutor>>,
    ) -> Result<(Self, RecoveryReport)> {
        let store = DurableStore::open(path)?;
        let snapshot = store.latest_snapshot()?;
        let snapshot_generation = snapshot.generation;
        let mut graph = GraphGeneration::from_snapshot(snapshot)?;
        let expected_snapshot_digest = store.generation_digest(snapshot_generation)?;
        if graph.digest() != expected_snapshot_digest {
            bail!(
                "snapshot digest {} does not match durable digest {expected_snapshot_digest} for generation {snapshot_generation}",
                graph.digest()
            );
        }
        let deltas = store.deltas_after(snapshot_generation)?;
        for (delta_generation, delta) in &deltas {
            let expected_generation = graph.generation();
            if delta.base_generation != expected_generation {
                bail!(
                    "delta at generation {delta_generation} has base generation {}, expected generation {expected_generation}",
                    delta.base_generation
                );
            }
            graph = graph.apply(delta).with_context(|| {
                format!("replay delta for durable generation {delta_generation}")
            })?;
            if graph.generation() != *delta_generation {
                bail!(
                    "replayed generation {} does not match durable delta generation {delta_generation}",
                    graph.generation()
                );
            }
            let expected_replayed_digest = store.generation_digest(*delta_generation)?;
            if graph.digest() != expected_replayed_digest {
                bail!(
                    "replayed digest {} does not match durable digest {expected_replayed_digest} for generation {delta_generation}",
                    graph.digest()
                );
            }
        }

        let durable_generation = store.current_generation()?;
        if graph.generation() != durable_generation {
            bail!(
                "recovered generation {} does not match durable generation {durable_generation}",
                graph.generation()
            );
        }
        let expected_recovered_digest = store.generation_digest(durable_generation)?;
        if graph.digest() != expected_recovered_digest {
            bail!(
                "recovered digest {} does not match durable digest {expected_recovered_digest} for generation {durable_generation}",
                graph.digest()
            );
        }

        let validation_migration = store.coordination().validate_recovery_state(
            durable_generation,
            |generation| store.delta(generation),
            |generation| store.generation_digest(generation),
            |generation| store.operation(generation),
            |generation| store.event(generation),
        )?;

        let service_epoch = store
            .begin_service_epoch_and_recover_coordination_with_validation(validation_migration)?;
        let scheduler_revision = store.coordination().metadata_state()?.scheduler_revision;
        let scheduler = SchedulerState::recover_with_revision(
            scheduler_revision,
            store.coordination().active_tickets()?,
            store.coordination().ready_offers()?,
            store.coordination().active_claims()?,
        )?;
        let resource_clocks = Arc::new(ResourceClockSnapshot::from_clocks(
            store.coordination().resource_clocks()?,
        ));
        let graph = Arc::new(graph);
        let report = RecoveryReport {
            snapshot_generation,
            replayed_operations: deltas.len() as u64,
            generation: graph.generation(),
            digest: graph.digest().to_owned(),
            service_epoch,
        };
        let plan_after_recovery = semantic_provider.is_some();
        let kernel = Self::from_parts(
            store,
            graph,
            resource_clocks,
            service_epoch,
            scheduler,
            semantic_provider,
            candidate_executor,
        );
        if plan_after_recovery {
            kernel.plan_and_apply_readiness(
                0,
                crate::coordination::TransitionCause::Restart,
                None,
            )?;
        }
        Ok((kernel, report))
    }

    pub fn snapshot(&self) -> Arc<GraphGeneration> {
        self.live
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Finds named declarations by exact name, optionally narrowed to one product
    /// kind. This is the minimal discovery surface: clients otherwise only have
    /// node IDs they already know. One full-graph pass: a single snapshot clone
    /// plus a single prebuilt parent -> Identifier-children map, so cost is
    /// O(nodes), not O(declarations * nodes). Candidates whose name cannot be
    /// confirmed (malformed payload, missing/ambiguous name identifier) are
    /// skipped rather than failing the whole query, mirroring the SQLite
    /// `find_declarations` filter behavior in `packages/store/src/queries.ts`.
    pub fn find_declarations(
        &self,
        name: &str,
        kind: Option<&str>,
    ) -> Result<Vec<DeclarationMatch>> {
        let graph = self.snapshot();
        let snapshot = graph.snapshot(); // ONE clone for the whole query
        let statement_kinds: Vec<(&str, &str)> = match kind {
            Some(k) => vec![(k, product_kind_to_statement_kind(k)?)],
            None => PRODUCT_KINDS.to_vec(),
        };
        // one pass: identifier children grouped by parent
        let mut identifiers: BTreeMap<&str, Vec<&NodeRecord>> = BTreeMap::new();
        for node in &snapshot.nodes {
            if node.kind == "Identifier"
                && let Some(parent) = node.parent_id.as_deref()
            {
                identifiers.entry(parent).or_default().push(node);
            }
        }
        let mut matches = Vec::new();
        for node in &snapshot.nodes {
            let Some((product_kind, _)) = statement_kinds
                .iter()
                .find(|(_, statement)| *statement == node.kind)
            else {
                continue;
            };
            // payload-only token; SKIP candidates that cannot be named
            let Ok(Some(candidate_name)) = confirmed_declaration_name(node, &identifiers) else {
                continue;
            };
            if candidate_name != name {
                continue;
            }
            let Some(module_id) = node.parent_id.clone() else {
                continue;
            };
            matches.push(DeclarationMatch {
                node_id: node.id.clone(),
                kind: (*product_kind).to_string(),
                name: candidate_name,
                module_id,
            });
            ensure!(
                matches.len() <= MAX_DECLARATION_MATCHES,
                "declaration matches exceed {MAX_DECLARATION_MATCHES} bound"
            );
        }
        Ok(matches)
    }

    /// Reads the retained canonical digest for one exact graph generation.
    pub fn generation_digest(&self, generation: u64) -> Result<String> {
        self.store.generation_digest(generation)
    }

    /// Finds one committed operation's canonical audit record by its opaque
    /// operation ID, alongside the graph generation it was published at.
    pub fn operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>> {
        self.store.operation_by_id(operation_id)
    }

    pub(crate) fn resource_clock_snapshot(&self) -> Arc<ResourceClockSnapshot> {
        self.resource_clocks
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    #[allow(dead_code)]
    pub(crate) fn dependency_snapshot(&self, keys: &BTreeSet<String>) -> Vec<DependencyVersion> {
        self.resource_clock_snapshot().dependencies(keys)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_resource_clocks(&self, keys: &BTreeSet<String>) -> Result<BTreeMap<String, u64>> {
        Ok(self
            .dependency_snapshot(keys)
            .into_iter()
            .map(|dependency| (dependency.resource_key, dependency.clock))
            .collect())
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_durable_resource_clocks(
        &self,
        keys: &BTreeSet<String>,
    ) -> Result<BTreeMap<String, u64>> {
        let clocks = self.store.coordination().resource_clocks()?;
        Ok(keys
            .iter()
            .filter_map(|key| clocks.get(key).copied().map(|clock| (key.clone(), clock)))
            .collect())
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_all_resource_clocks(
        &self,
    ) -> Result<(BTreeMap<String, u64>, BTreeMap<String, u64>)> {
        Ok((
            self.resource_clock_snapshot().all(),
            self.store.coordination().resource_clocks()?,
        ))
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_canonical_digests(&self) -> Result<(String, String, String)> {
        let scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        Ok((
            self.store.test_canonical_graph_digest()?,
            self.store.coordination().test_canonical_digest()?,
            scheduler.test_canonical_digest(),
        ))
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_replace_node_candidate_executor(&mut self, config: NodeBridgeConfig) {
        let client = Arc::new(NodeBridgeClient::new(config));
        self.candidate_executor = Some(Arc::new(NodeCandidateExecutor::new(
            client,
            self.service_epoch,
        )));
    }

    /// Injects one monotonic in-memory dependency-clock advance without durable or graph writes.
    /// This is a research-only fault seam for proving stale candidate invalidation.
    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_inject_claim_dependency_clock_advance(
        &self,
        claim: &crate::coordination::ClaimHandle,
        resource_key: &str,
    ) -> Result<u64> {
        let dependency = claim
            .dependency_versions
            .iter()
            .find(|dependency| dependency.resource_key == resource_key)
            .with_context(|| format!("claim has no dependency {resource_key}"))?;
        let publication = self
            .publish_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
        let before = self.resource_clock_snapshot();
        if before.clock(resource_key) != dependency.clock {
            bail!("claim dependency clock is not current for {resource_key}");
        }
        let next = dependency
            .clock
            .checked_add(1)
            .with_context(|| format!("resource clock overflow for {resource_key}"))?;
        let updates = BTreeMap::from([(resource_key.to_owned(), next)]);
        *self
            .resource_clocks
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(before.apply(&updates));
        drop(publication);
        Ok(next)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_graph_table_counts(&self) -> Result<(u64, String, u64, u64)> {
        self.store.atomic_graph_table_counts()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_graph_event(&self, sequence: u64) -> Result<Option<crate::EventRecord>> {
        self.store.event(sequence)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_graph_delta(&self, generation: u64) -> Result<Option<crate::GraphDelta>> {
        self.store.delta(generation)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_graph_ticket(&self, ticket_id: &str) -> Result<Option<crate::TicketRecord>> {
        self.store.ticket(ticket_id)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_graph_idempotency_generation(&self, key: &str) -> Result<Option<u64>> {
        self.store.idempotency_generation(key)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_recovery_metadata(&self) -> Result<crate::RecoveryMetadataState> {
        self.store.coordination().recovery_metadata_state()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_coordination_table_counts(
        &self,
    ) -> Result<crate::coordination::CoordinationTableCounts> {
        self.store.coordination().table_counts()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_scheduler_revisions(&self) -> Result<(u64, u64)> {
        let scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        Ok((
            scheduler.revision(),
            self.store
                .coordination()
                .metadata_state()?
                .scheduler_revision,
        ))
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_publication_mutexes_available(&self) -> bool {
        self.publish_lock.try_lock().is_ok() && self.scheduler.try_lock().is_ok()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_publication_mutexes_held(&self) -> bool {
        self.publish_lock.try_lock().is_err() && self.scheduler.try_lock().is_err()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_active_claims(&self) -> Result<Vec<crate::coordination::ClaimHandle>> {
        self.store.coordination().active_claims()
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_fence_state(&self, resource: &str) -> Result<(Option<u64>, Option<u64>)> {
        self.store.fence_state(resource)
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_scheduler_ticket_for_change_set(
        &self,
        change_set_id: &str,
    ) -> Result<crate::coordination::CoordinationTicket> {
        self.scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?
            .tickets()
            .find(|ticket| ticket.change_set_id == change_set_id)
            .cloned()
            .with_context(|| format!("scheduler ticket for {change_set_id} does not exist"))
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn issue_fence(&self, resources: &[String]) -> Result<FenceClaim> {
        self.store.issue_fence(self.service_epoch, resources)
    }

    #[cfg(feature = "redb-spike-api")]
    pub fn publish(&self, publication: Publication) -> Result<PublicationReport> {
        self.publish_inner(publication, PublishFailpoint::None)
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn publish_with_failpoint(
        &self,
        publication: Publication,
        failpoint: PublishFailpoint,
    ) -> Result<PublicationReport> {
        self.publish_inner(publication, failpoint)
    }

    #[cfg(feature = "redb-spike-api")]
    fn publish_inner(
        &self,
        publication: Publication,
        failpoint: PublishFailpoint,
    ) -> Result<PublicationReport> {
        let _publish_guard = self
            .publish_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
        let current = self.snapshot();

        if self.store.was_published(&publication.idempotency_key)? {
            return Ok(PublicationReport {
                generation: current.generation(),
                digest: current.digest().to_owned(),
                persistence_ns: 0,
                memory_publish_ns: 0,
                already_published: true,
            });
        }

        let next = Arc::new(current.apply(&publication.delta)?);
        let persistence_started = Instant::now();
        let outcome = self
            .store
            .publish_with_failpoint(&publication, next.digest(), failpoint)?;
        let persistence_ns = persistence_started.elapsed().as_nanos();
        match outcome {
            PublishOutcome::AlreadyPublished { .. } => Ok(PublicationReport {
                generation: current.generation(),
                digest: current.digest().to_owned(),
                persistence_ns,
                memory_publish_ns: 0,
                already_published: true,
            }),
            PublishOutcome::Published { generation } => {
                if generation != next.generation() {
                    bail!(
                        "durable generation {generation} does not match prepared generation {}",
                        next.generation()
                    );
                }
                let memory_publish_started = Instant::now();
                *self
                    .live
                    .write()
                    .map_err(|_| anyhow::anyhow!("live generation lock is poisoned"))? =
                    next.clone();
                if failpoint == PublishFailpoint::AfterMemoryPublish {
                    std::process::abort();
                }
                let memory_publish_ns = memory_publish_started.elapsed().as_nanos();
                Ok(PublicationReport {
                    generation,
                    digest: next.digest().to_owned(),
                    persistence_ns,
                    memory_publish_ns,
                    already_published: false,
                })
            }
        }
    }

    pub fn write_snapshot(&self, snapshot: &GraphSnapshot) -> Result<()> {
        let validated = GraphGeneration::from_snapshot(snapshot.clone())?;
        let current = self.snapshot();
        if validated.generation() > current.generation() {
            bail!(
                "snapshot generation {} exceeds live generation {}",
                validated.generation(),
                current.generation()
            );
        }
        self.store.write_snapshot(snapshot)
    }

    pub fn service_epoch(&self) -> u64 {
        self.service_epoch
    }

    pub(crate) fn semantic_provider(&self) -> Result<&dyn SemanticProvider> {
        self.semantic_provider
            .as_deref()
            .ok_or_else(|| anyhow::Error::new(CoordinationError::SemanticProviderUnavailable))
    }

    pub(crate) fn candidate_executor(&self) -> Result<&dyn CandidateExecutor> {
        self.candidate_executor
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("candidate executor is unavailable"))
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn fence_state(&self, resource: &str) -> Result<(Option<u64>, Option<u64>)> {
        self.store.fence_state(resource)
    }

    /// A canonical, offline-safe projection of every durable atomic-state
    /// primitive this kernel tracks: the committed graph, its per-generation
    /// history (operations, deltas, digests, graph events), every discoverable
    /// change set with its intents, in-flight coordination artifacts (tickets,
    /// ready offers, active claims), the graph-level idempotency record for
    /// each discovered change set, fence and resource-clock state for every
    /// reservation key those artifacts reference, scheduler revisions, and
    /// table counts.
    ///
    /// This is the shared library core behind two callers: the row-8 crash
    /// acceptance test (`CrashAtomicState` in
    /// `tests/full_key_free_acceptance.rs`), which layers claim-scoped,
    /// test-only bits on top (the specific claim under test, its publication
    /// attempt, and the ID-normalization used to compare crash boundaries),
    /// and the `export-snapshot --state-out` CLI subcommand, which writes this
    /// projection verbatim as the crash-harness oracle. Change sets, tickets,
    /// ready offers, and claims are discovered generically (from committed
    /// operations plus every live ticket/offer/claim) rather than assumed from
    /// a single known change-set ID, since an offline export has no such
    /// context.
    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn test_atomic_state_projection(&self) -> Result<serde_json::Value> {
        let graph = self.snapshot();
        let snapshot = graph.snapshot();
        let generation = graph.generation();

        let operations = (1..=generation)
            .filter_map(|g| self.operation(g).transpose())
            .collect::<Result<Vec<_>>>()?;
        let deltas = (1..=generation)
            .filter_map(|g| self.test_graph_delta(g).transpose())
            .collect::<Result<Vec<_>>>()?;
        let generation_digests = (1..=generation)
            .map(|g| Ok((g.to_string(), self.store.generation_digest(g)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let graph_events = (1..=generation)
            .filter_map(|g| self.test_graph_event(g).transpose())
            .collect::<Result<Vec<_>>>()?;

        // `all_tickets` (not `active_tickets`) so terminal tickets for
        // committed change sets stay in the projection; ready offers and
        // active claims have no durable "all" history by design (they are
        // consumed once claimed/published), so their live enumeration is
        // already the maximal library-expressible surface.
        let all_tickets = self.store.coordination().all_tickets()?;
        let ready_offers = self.store.coordination().ready_offers()?;
        let active_claims = self.store.coordination().active_claims()?;

        let mut change_set_ids: BTreeSet<String> = BTreeSet::new();
        for operation in &operations {
            change_set_ids.insert(operation.change_set_id.clone());
        }
        for ticket in &all_tickets {
            change_set_ids.insert(ticket.change_set_id.clone());
        }
        for offer in &ready_offers {
            change_set_ids.insert(offer.change_set_id.clone());
        }
        for claim in &active_claims {
            change_set_ids.insert(claim.change_set_id.clone());
        }

        let mut change_sets = Vec::new();
        let mut intents_by_change_set = BTreeMap::new();
        let mut idempotency_generations = BTreeMap::new();
        for change_set_id in &change_set_ids {
            if let Some(change_set) = self.change_set(change_set_id)? {
                let intents = self.intents_for_change_set_bounded(change_set_id, 256)?;
                intents_by_change_set.insert(change_set_id.clone(), intents);
                change_sets.push(change_set);
            }
            let commit_key = crate::coordination::coordination_commit_key(change_set_id);
            if let Some(commit_generation) = self.test_graph_idempotency_generation(&commit_key)? {
                idempotency_generations.insert(commit_key, commit_generation);
            }
        }

        // Durable per-ticket `TicketRecord` (the `{ticket_id, state,
        // scope_fingerprint}` written into the committed Publication),
        // discovered generically from every ticket found above rather than
        // one known ticket ID, matching how `idempotencyGenerations` is
        // captured generically over `change_set_ids`. `None` when a
        // discovered ticket has no durable record (e.g. mid-flight before
        // its publication commits).
        let mut graph_tickets = BTreeMap::new();
        for ticket in &all_tickets {
            let graph_ticket = self.test_graph_ticket(&ticket.ticket_id)?;
            graph_tickets.insert(ticket.ticket_id.clone(), graph_ticket);
        }

        let mut reservation_keys: BTreeSet<String> = BTreeSet::new();
        for ticket in &all_tickets {
            reservation_keys.extend(ticket.reservation_keys.iter().cloned());
        }
        for claim in &active_claims {
            reservation_keys.extend(claim.reservation_keys.iter().cloned());
        }
        let mut fence_states = BTreeMap::new();
        for key in reservation_keys {
            let state = self.test_fence_state(&key)?;
            fence_states.insert(key, state);
        }

        let mut publication_attempts = BTreeMap::new();
        for claim in &active_claims {
            if claim.attempt_id.is_empty() {
                continue;
            }
            if let Some(attempt) = self.publication_attempt(&claim.attempt_id)? {
                publication_attempts.insert(claim.attempt_id.clone(), attempt);
            }
        }

        let (live_resource_clocks, durable_resource_clocks) = self.test_all_resource_clocks()?;
        let graph_table_counts = self.test_graph_table_counts()?;
        let coordination_table_counts = self.test_coordination_table_counts()?;
        let recovery_metadata = self.test_recovery_metadata()?;
        let scheduler_revisions = self.test_scheduler_revisions()?;

        Ok(serde_json::json!({
            "graph": snapshot,
            "graphDigest": graph.digest(),
            "graphCounts": {
                "generation": graph_table_counts.0,
                "digest": graph_table_counts.1,
                "operations": graph_table_counts.2,
                "events": graph_table_counts.3,
            },
            "operations": operations,
            "deltas": deltas,
            "generationDigests": generation_digests,
            "graphEvents": graph_events,
            "changeSets": change_sets,
            "intentsByChangeSet": intents_by_change_set,
            "idempotencyGenerations": idempotency_generations,
            "tickets": all_tickets,
            "graphTickets": graph_tickets,
            "readyOffers": ready_offers,
            "activeClaims": active_claims,
            "publicationAttempts": publication_attempts,
            "fenceStates": fence_states,
            "liveResourceClocks": live_resource_clocks,
            "durableResourceClocks": durable_resource_clocks,
            "schedulerRevisions": {
                "inMemory": scheduler_revisions.0,
                "durable": scheduler_revisions.1,
            },
            "coordinationCounts": {
                "changeSets": coordination_table_counts.change_sets,
                "intents": coordination_table_counts.intents,
                "tickets": coordination_table_counts.tickets,
                "readyOffers": coordination_table_counts.ready_offers,
                "activeClaims": coordination_table_counts.active_claims,
                "events": coordination_table_counts.events,
                "eventIds": coordination_table_counts.event_ids,
                "eventCursors": coordination_table_counts.event_cursors,
                "submissionIdempotency": coordination_table_counts.submission_idempotency,
                "publicationAttempts": coordination_table_counts.publication_attempts,
                "metadata": coordination_table_counts.metadata,
            },
            "recoveryMetadata": {
                "nextQueueSequence": recovery_metadata.next_queue_sequence,
                "currentEventSequence": recovery_metadata.current_event_sequence,
                "schedulerRevision": recovery_metadata.scheduler_revision,
                "latestLifecycleRevision": recovery_metadata.latest_lifecycle_revision,
                "clockedPublicationGeneration": recovery_metadata.clocked_publication_generation,
                "recoveryValidationVersion": recovery_metadata.recovery_validation_version,
            },
            "serviceEpoch": self.service_epoch(),
        }))
    }

    fn from_parts(
        store: DurableStore,
        graph: Arc<GraphGeneration>,
        resource_clocks: Arc<ResourceClockSnapshot>,
        service_epoch: u64,
        scheduler: SchedulerState,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
        candidate_executor: Option<Arc<dyn CandidateExecutor>>,
    ) -> Self {
        Self {
            store,
            live: RwLock::new(graph),
            publish_lock: Mutex::new(()),
            resource_clocks: RwLock::new(resource_clocks),
            service_epoch,
            scheduler: Mutex::new(scheduler),
            semantic_provider,
            candidate_executor,
        }
    }
}
