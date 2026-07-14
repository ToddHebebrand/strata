use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use anyhow::{Context, Result, bail};

use crate::{
    DurableStore, FenceClaim, GraphGeneration, GraphSnapshot, Publication, PublishOutcome,
    SchedulerState,
};

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
    live: RwLock<Arc<GraphGeneration>>,
    publish_lock: Mutex<()>,
    service_epoch: u64,
    pub(crate) scheduler: Mutex<SchedulerState>,
}

impl Kernel {
    pub fn create(
        path: impl AsRef<Path>,
        initial: GraphSnapshot,
    ) -> Result<(Self, RecoveryReport)> {
        let graph = Arc::new(GraphGeneration::from_snapshot(initial.clone())?);
        let store = DurableStore::create(path)?;
        store.seed(&initial)?;
        let service_epoch = store.begin_service_epoch()?;
        let report = RecoveryReport {
            snapshot_generation: graph.generation(),
            replayed_operations: 0,
            generation: graph.generation(),
            digest: graph.digest().to_owned(),
            service_epoch,
        };
        let scheduler = SchedulerState::recover(Vec::new(), Vec::new(), Vec::new())?;
        Ok((
            Self::from_parts(store, graph, service_epoch, scheduler),
            report,
        ))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<(Self, RecoveryReport)> {
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

        let service_epoch = store.begin_service_epoch_and_recover_coordination()?;
        let scheduler = SchedulerState::recover(
            store.coordination().active_tickets()?,
            store.coordination().ready_offers()?,
            store.coordination().active_claims()?,
        )?;
        let graph = Arc::new(graph);
        let report = RecoveryReport {
            snapshot_generation,
            replayed_operations: deltas.len() as u64,
            generation: graph.generation(),
            digest: graph.digest().to_owned(),
            service_epoch,
        };
        Ok((
            Self::from_parts(store, graph, service_epoch, scheduler),
            report,
        ))
    }

    pub fn snapshot(&self) -> Arc<GraphGeneration> {
        self.live
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn issue_fence(&self, resources: &[String]) -> Result<FenceClaim> {
        self.store.issue_fence(self.service_epoch, resources)
    }

    pub fn publish(&self, publication: Publication) -> Result<PublicationReport> {
        self.publish_inner(publication, PublishFailpoint::None)
    }

    #[doc(hidden)]
    pub fn publish_with_failpoint(
        &self,
        publication: Publication,
        failpoint: PublishFailpoint,
    ) -> Result<PublicationReport> {
        self.publish_inner(publication, failpoint)
    }

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

    fn from_parts(
        store: DurableStore,
        graph: Arc<GraphGeneration>,
        service_epoch: u64,
        scheduler: SchedulerState,
    ) -> Self {
        Self {
            store,
            live: RwLock::new(graph),
            publish_lock: Mutex::new(()),
            service_epoch,
            scheduler: Mutex::new(scheduler),
        }
    }
}
