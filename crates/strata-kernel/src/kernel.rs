#[cfg(feature = "coordination-test-api")]
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
#[cfg(feature = "redb-spike-api")]
use std::time::Instant;

use anyhow::{Context, Result, bail};

use crate::coordination::{
    CoordinationError, DependencyVersion, ResourceClockSnapshot, SemanticProvider,
};
#[cfg(feature = "coordination-test-api")]
use crate::coordination::{TestSemanticAdapter, TestSemanticProvider};
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

pub struct Kernel {
    pub(crate) store: DurableStore,
    pub(crate) live: RwLock<Arc<GraphGeneration>>,
    #[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub(crate) publish_lock: Mutex<()>,
    pub(crate) resource_clocks: RwLock<Arc<ResourceClockSnapshot>>,
    service_epoch: u64,
    pub(crate) scheduler: Mutex<SchedulerState>,
    semantic_provider: Option<Arc<dyn SemanticProvider>>,
}

impl Kernel {
    pub fn create(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
    ) -> Result<(Self, RecoveryReport)> {
        Self::create_inner(path, initial, None)
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn create_with_test_semantics(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
        provider: Arc<dyn TestSemanticProvider>,
    ) -> Result<(Self, RecoveryReport)> {
        Self::create_inner(path, initial, Some(Arc::new(TestSemanticAdapter(provider))))
    }

    fn create_inner(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
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
            ),
            report,
        ))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<(Self, RecoveryReport)> {
        Self::open_inner(path, None)
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn open_with_test_semantics(
        path: impl AsRef<Path>,
        provider: Arc<dyn TestSemanticProvider>,
    ) -> Result<(Self, RecoveryReport)> {
        Self::open_inner(path, Some(Arc::new(TestSemanticAdapter(provider))))
    }

    fn open_inner(
        path: impl AsRef<Path>,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
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

        #[cfg(feature = "coordination-test-api")]
        store.coordination().validate_recovery_state(
            durable_generation,
            |generation| store.delta(generation),
            |generation| store.generation_digest(generation),
        )?;

        let service_epoch = store.begin_service_epoch_and_recover_coordination()?;
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
    pub fn test_graph_table_counts(&self) -> Result<(u64, String, u64, u64)> {
        self.store.atomic_graph_table_counts()
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

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn fence_state(&self, resource: &str) -> Result<(Option<u64>, Option<u64>)> {
        self.store.fence_state(resource)
    }

    fn from_parts(
        store: DurableStore,
        graph: Arc<GraphGeneration>,
        resource_clocks: Arc<ResourceClockSnapshot>,
        service_epoch: u64,
        scheduler: SchedulerState,
        semantic_provider: Option<Arc<dyn SemanticProvider>>,
    ) -> Self {
        Self {
            store,
            live: RwLock::new(graph),
            #[cfg(any(feature = "coordination-test-api", feature = "redb-spike-api"))]
            publish_lock: Mutex::new(()),
            resource_clocks: RwLock::new(resource_clocks),
            service_epoch,
            scheduler: Mutex::new(scheduler),
            semantic_provider,
        }
    }
}
