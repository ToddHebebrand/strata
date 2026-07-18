use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, bail};

#[cfg(feature = "coordination-test-api")]
use super::CandidateBuilder;
use super::analyzer::analyze_change_set;
use super::authority::plan_change_set;
use super::coordinator::{
    affected_node_ids, append_event, append_event_with_payload, bounded_wake_payload,
    bounded_wake_payload_with_scope, combine_release_and_readiness, coordination_commit_key,
    intent_kind, operation_renames, scheduler_ticket_updates, transition,
};
use super::planner::{PlannerSnapshot, plan_readiness};
use super::resource_keys;
use super::{
    CandidateEnvelope, ChangeSetState, ClaimHandle, CoordinationEventKind, DependencyVersion,
    DynamicExpansionPolicy, LifecycleTransition, PreparedCandidate, PublicationAttemptRecord,
    PublishClaimOutcome, SchedulerState, ScopeChange, TicketState, classify_scope_change,
};
use crate::bridge::CandidateExecutor;
#[cfg(feature = "redb-spike-api")]
use crate::kernel::PublishFailpoint;
use crate::model::{FenceClaim, Publication};
use crate::storage::{CoordinatedCommit, CoordinatedPublishFailpoint, PublishOutcome};
use crate::{
    EventRecord, GraphGeneration, Kernel, OperationRecord, PublicationReport, SCHEMA_VERSION,
    TicketRecord,
};

enum CandidateSource<'a> {
    Executor(&'a dyn CandidateExecutor),
    #[cfg(feature = "coordination-test-api")]
    ExternalEnvelope(CandidateEnvelope),
    Validated(ValidatedCandidate),
}

#[cfg(feature = "coordination-test-api")]
struct TestCandidateExecutor<'a>(&'a dyn CandidateBuilder);

#[cfg(feature = "coordination-test-api")]
impl CandidateExecutor for TestCandidateExecutor<'_> {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> Result<CandidateEnvelope> {
        self.0.build_candidate(prepared)
    }
}

#[derive(Clone)]
struct ValidatedCandidate {
    envelope: CandidateEnvelope,
    prepared_graph_generation: u64,
}

#[derive(Clone, Copy, Default)]
struct PublicationTestHooks<'a> {
    before_final_check: Option<&'a dyn Fn(u32)>,
    before_invalidation_final_check: Option<&'a dyn Fn(u32)>,
    before_redb_commit: Option<&'a dyn Fn()>,
    after_digest_validation: Option<&'a dyn Fn()>,
}

#[derive(Clone, Copy)]
struct PublicationExecution<'a> {
    failpoint: CoordinatedPublishFailpoint,
    #[cfg(feature = "redb-spike-api")]
    crash_failpoint: PublishFailpoint,
    after_outer_idempotency_lookup: Option<&'a dyn Fn()>,
    optimistic_attempt: u32,
    test_hooks: PublicationTestHooks<'a>,
}

impl Default for PublicationExecution<'_> {
    fn default() -> Self {
        Self {
            failpoint: CoordinatedPublishFailpoint::None,
            #[cfg(feature = "redb-spike-api")]
            crash_failpoint: PublishFailpoint::None,
            after_outer_idempotency_lookup: None,
            optimistic_attempt: 0,
            test_hooks: PublicationTestHooks::default(),
        }
    }
}

/// Complete immutable publication proposal prepared before either global mutex is acquired.
pub(crate) struct PreparedPublication {
    pub expected_graph_generation: u64,
    pub expected_scheduler_revision: u64,
    pub expected_service_epoch: u64,
    pub claim: ClaimHandle,
    pub envelope: CandidateEnvelope,
    pub dependency_versions: Vec<DependencyVersion>,
    pub next_graph: Arc<GraphGeneration>,
    pub next_scheduler: SchedulerState,
    pub lifecycle: LifecycleTransition,
    pub resource_clock_updates: BTreeMap<String, u64>,
    pub attempt_record: PublicationAttemptRecord,
    pub operation: OperationRecord,
}

impl Kernel {
    pub fn execute_claimed(
        &self,
        claim: &ClaimHandle,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        let executor = self.candidate_executor()?;
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(executor),
            now_tick,
            PublicationExecution::default(),
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn execute_claimed_with_failpoint(
        &self,
        claim: &ClaimHandle,
        now_tick: u64,
        failpoint: PublishFailpoint,
    ) -> Result<PublishClaimOutcome> {
        let executor = self.candidate_executor()?;
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(executor),
            now_tick,
            PublicationExecution {
                crash_failpoint: failpoint,
                ..PublicationExecution::default()
            },
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn execute_claimed_with_test_hooks(
        &self,
        claim: &ClaimHandle,
        now_tick: u64,
        before_final_check: &dyn Fn(u32),
    ) -> Result<PublishClaimOutcome> {
        let executor = self.candidate_executor()?;
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(executor),
            now_tick,
            PublicationExecution {
                test_hooks: PublicationTestHooks {
                    before_final_check: Some(before_final_check),
                    ..PublicationTestHooks::default()
                },
                ..PublicationExecution::default()
            },
        )
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        let executor = TestCandidateExecutor(candidate_builder);
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(&executor),
            now_tick,
            PublicationExecution::default(),
        )
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed_envelope(
        &self,
        claim: &ClaimHandle,
        envelope: CandidateEnvelope,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        self.publish_claimed_inner(
            claim,
            CandidateSource::ExternalEnvelope(envelope),
            now_tick,
            PublicationExecution::default(),
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed_with_test_hooks(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        before_final_check: &dyn Fn(u32),
        before_redb_commit: &dyn Fn(),
    ) -> Result<PublishClaimOutcome> {
        let executor = TestCandidateExecutor(candidate_builder);
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(&executor),
            now_tick,
            PublicationExecution {
                test_hooks: PublicationTestHooks {
                    before_final_check: Some(before_final_check),
                    before_invalidation_final_check: None,
                    before_redb_commit: Some(before_redb_commit),
                    after_digest_validation: None,
                },
                ..PublicationExecution::default()
            },
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed_with_invalidation_test_hooks(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        before_final_check: &dyn Fn(u32),
        before_invalidation_final_check: &dyn Fn(u32),
        before_redb_commit: &dyn Fn(),
    ) -> Result<PublishClaimOutcome> {
        let executor = TestCandidateExecutor(candidate_builder);
        self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(&executor),
            now_tick,
            PublicationExecution {
                test_hooks: PublicationTestHooks {
                    before_final_check: Some(before_final_check),
                    before_invalidation_final_check: Some(before_invalidation_final_check),
                    before_redb_commit: Some(before_redb_commit),
                    after_digest_validation: None,
                },
                ..PublicationExecution::default()
            },
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed_envelope_with_validation_hook(
        &self,
        claim: &ClaimHandle,
        envelope: CandidateEnvelope,
        now_tick: u64,
        after_digest_validation: &dyn Fn(),
    ) -> Result<PublishClaimOutcome> {
        self.publish_claimed_inner(
            claim,
            CandidateSource::ExternalEnvelope(envelope),
            now_tick,
            PublicationExecution {
                test_hooks: PublicationTestHooks {
                    before_final_check: None,
                    before_invalidation_final_check: None,
                    before_redb_commit: None,
                    after_digest_validation: Some(after_digest_validation),
                },
                ..PublicationExecution::default()
            },
        )
    }

    #[doc(hidden)]
    #[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub fn publish_claimed_with_failpoint(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        failpoint: CoordinatedPublishFailpoint,
    ) -> Result<PublicationReport> {
        let executor = TestCandidateExecutor(candidate_builder);
        let outcome = self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(&executor),
            now_tick,
            PublicationExecution {
                failpoint,
                ..PublicationExecution::default()
            },
        )?;
        let PublishClaimOutcome::Published(report) = outcome else {
            bail!("failpoint publication did not reach a graph publication outcome")
        };
        Ok(report)
    }

    /// Test synchronization point for observing an idempotency miss before lock acquisition.
    #[doc(hidden)]
    #[cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]
    pub fn publish_claimed_with_entry_hook(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        after_outer_idempotency_lookup: &dyn Fn(),
    ) -> Result<PublicationReport> {
        let executor = TestCandidateExecutor(candidate_builder);
        let outcome = self.publish_claimed_inner(
            claim,
            CandidateSource::Executor(&executor),
            now_tick,
            PublicationExecution {
                after_outer_idempotency_lookup: Some(after_outer_idempotency_lookup),
                ..PublicationExecution::default()
            },
        )?;
        let PublishClaimOutcome::Published(report) = outcome else {
            bail!("entry-hook publication did not reach a graph publication outcome")
        };
        Ok(report)
    }

    fn publish_claimed_inner(
        &self,
        claim: &ClaimHandle,
        candidate_source: CandidateSource<'_>,
        now_tick: u64,
        execution: PublicationExecution<'_>,
    ) -> Result<PublishClaimOutcome> {
        let PublicationExecution {
            failpoint,
            #[cfg(feature = "redb-spike-api")]
            crash_failpoint,
            after_outer_idempotency_lookup,
            optimistic_attempt,
            test_hooks,
        } = execution;
        let idempotency_key = coordination_commit_key(&claim.change_set_id);
        if let Some(report) = self.committed_candidate_report(claim, &candidate_source)? {
            return Ok(PublishClaimOutcome::Published(report));
        }
        if let Some(hook) = after_outer_idempotency_lookup {
            hook();
        }

        let semantic_provider = self.semantic_provider()?;
        let durable = self.store.coordination();
        let (captured_scheduler, captured_revision) = {
            let scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            (scheduler.clone(), scheduler.revision())
        };
        self.validate_executing_claim(&captured_scheduler, claim, now_tick)?;
        let prepared_graph = self.snapshot();
        let before_change_set = durable
            .change_set(&claim.change_set_id)?
            .with_context(|| format!("change set {} does not exist", claim.change_set_id))?;
        if before_change_set.state != ChangeSetState::Executing {
            bail!("change set {} is not Executing", claim.change_set_id);
        }
        let previous_scope = before_change_set
            .inferred_scope
            .as_ref()
            .context("executing change set has no inferred scope")?;
        let intents = durable.intents_for(&claim.change_set_id)?;
        let fresh_scope = analyze_change_set(&prepared_graph, &intents, semantic_provider)?;
        let scope_change = classify_scope_change(previous_scope, &fresh_scope);
        if scope_change != ScopeChange::Unchanged {
            self.persist_changed_publication_scope(claim, now_tick, test_hooks)?;
            return self.invalidated_claim_outcome(claim);
        }

        let (validated_candidate, candidate_may_rebase) = match candidate_source {
            CandidateSource::Executor(candidate_executor) => {
                let prepared = PreparedCandidate {
                    change_set: before_change_set.clone(),
                    intents: intents.clone(),
                    graph: prepared_graph.clone(),
                    attempt_id: claim.attempt_id.clone(),
                    scope_fingerprint: fresh_scope.scope_fingerprint.clone(),
                };
                let envelope = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    candidate_executor.build_candidate(&prepared)
                }))
                .map_err(|_| anyhow::anyhow!("candidate builder panicked"))??;
                envelope.validate_digest()?;
                if let Some(hook) = test_hooks.after_digest_validation {
                    hook();
                }
                (
                    ValidatedCandidate {
                        envelope,
                        prepared_graph_generation: prepared_graph.generation(),
                    },
                    false,
                )
            }
            #[cfg(feature = "coordination-test-api")]
            CandidateSource::ExternalEnvelope(envelope) => {
                envelope.validate_digest()?;
                if let Some(hook) = test_hooks.after_digest_validation {
                    hook();
                }
                (
                    ValidatedCandidate {
                        envelope,
                        prepared_graph_generation: prepared_graph.generation(),
                    },
                    false,
                )
            }
            CandidateSource::Validated(candidate) => (candidate, true),
        };
        let envelope = validated_candidate.envelope.clone();
        let candidate_digest = envelope.candidate_digest.clone();
        let mut delta = envelope.delta;
        if delta.schema_version != SCHEMA_VERSION {
            bail!(
                "candidate delta has unsupported schema version {}",
                delta.schema_version
            );
        }
        if delta.base_generation != prepared_graph.generation() && !candidate_may_rebase {
            bail!(
                "candidate delta base generation {} does not match current generation {}",
                delta.base_generation,
                prepared_graph.generation()
            );
        }
        super::validate_delta_containment(&prepared_graph, &delta, &fresh_scope)
            .context("candidate delta is outside inferred scope")?;
        let candidate_envelope = validated_candidate.envelope.clone();

        let before_scheduler = {
            let scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            scheduler.clone()
        };
        self.validate_executing_claim(&before_scheduler, claim, now_tick)?;
        let graph = self.snapshot();
        let clocks = self.resource_clock_snapshot();
        if !clocks.matches(&claim.dependency_versions) {
            self.persist_changed_publication_scope(claim, now_tick, test_hooks)?;
            return self.invalidated_claim_outcome(claim);
        }
        if before_scheduler.revision() < captured_revision {
            bail!("scheduler revision moved backward during candidate construction");
        }
        let current_authority = plan_change_set(&graph, &intents, semantic_provider)?;
        let current_scope_change = classify_scope_change(previous_scope, &current_authority.scope);
        if current_scope_change != ScopeChange::Unchanged {
            self.persist_changed_publication_scope(claim, now_tick, test_hooks)?;
            return self.invalidated_claim_outcome(claim);
        }
        let fresh_scope = current_authority.scope;
        delta.base_generation = graph.generation();
        super::validate_delta_containment(&graph, &delta, &fresh_scope)
            .context("rebased candidate delta is outside inferred scope")?;
        // Write-set keys only: validation-set namespace pins are observations
        // (spec 2026-07-17 Change 2b) and must not bump conflict clocks.
        let semantic_index_keys = fresh_scope
            .write_set
            .iter()
            .filter(|resource| {
                resource.resource_key.starts_with("namespace:")
                    || resource.resource_key.starts_with("absence:")
            })
            .map(|resource| resource.resource_key.clone())
            .collect::<BTreeSet<_>>();
        let affected_resource_keys = resource_keys(&graph, &delta, &semantic_index_keys)?;
        let resource_clock_updates =
            durable.next_resource_clock_updates(&affected_resource_keys)?;
        let next_resource_clocks = Arc::new(
            self.resource_clock_snapshot()
                .apply(&resource_clock_updates),
        );
        let next = Arc::new(graph.apply(&delta)?);
        let next_generation = next.generation();
        let operation_id = format!("operation:{}", uuid::Uuid::new_v4());
        let affected_node_ids = affected_node_ids(&delta);

        let mut next_scheduler = before_scheduler.clone();
        let before_ticket = next_scheduler
            .tickets()
            .find(|ticket| ticket.change_set_id == claim.change_set_id)
            .cloned()
            .context("executing claim has no scheduler ticket")?;
        next_scheduler.release(&claim.claim_id, TicketState::Completed)?;

        let metadata = durable.metadata_state()?;
        let mut lifecycle = transition(metadata)?;
        let mut committed_change_set = before_change_set.clone();
        committed_change_set.state = ChangeSetState::Committed;
        committed_change_set.committed_generation = Some(next_generation);
        lifecycle
            .change_sets
            .push((Some(before_change_set.clone()), Some(committed_change_set)));
        let mut completed_ticket = before_ticket.clone();
        completed_ticket.state = TicketState::Completed;
        completed_ticket.active_claim_id = None;
        completed_ticket.ready_offer_id = None;
        lifecycle
            .tickets
            .push((Some(before_ticket.clone()), Some(completed_ticket)));
        lifecycle.claims.push((Some(claim.clone()), None));
        let committed_event = append_event_with_payload(
            &mut lifecycle,
            CoordinationEventKind::IntentCommitted,
            &claim.change_set_id,
            next_generation,
            bounded_wake_payload(
                "operationId",
                &operation_id,
                graph.generation(),
                next_generation,
                &affected_node_ids,
            ),
        )?;

        let readiness_plan = plan_readiness(
            semantic_provider,
            PlannerSnapshot {
                graph: next.clone(),
                scheduler: next_scheduler,
                scheduler_revision: before_scheduler.revision(),
                service_epoch: self.service_epoch(),
                now_tick,
                cause: super::TransitionCause::Publication,
                blocking_event_sequence: Some(committed_event.sequence),
                deferred_change_set_ids: BTreeSet::new(),
            },
            &durable,
        )?;
        let mut readiness_lifecycle = readiness_plan.lifecycle_transition()?;
        for (_, after) in &mut readiness_lifecycle.change_sets {
            if let Some(after) = after {
                after.blocking_change_set_id = Some(claim.change_set_id.clone());
            }
        }
        for event in &mut readiness_lifecycle.events {
            if matches!(
                event.kind,
                CoordinationEventKind::IntentReady
                    | CoordinationEventKind::ScopeExpanded
                    | CoordinationEventKind::IntentNeedsDecision
            ) {
                let scope_fingerprint = readiness_lifecycle
                    .change_sets
                    .iter()
                    .find_map(|(_, after)| {
                        after
                            .as_ref()
                            .filter(|record| record.change_set_id == event.change_set_id)
                            .and_then(|record| record.inferred_scope.as_ref())
                            .map(|scope| scope.scope_fingerprint.as_str())
                    })
                    .context("planned readiness event has no fresh inferred scope")?;
                event.payload_json = bounded_wake_payload_with_scope(
                    "blockingOperationId",
                    &operation_id,
                    graph.generation(),
                    next_generation,
                    &affected_node_ids,
                    scope_fingerprint,
                );
            }
        }
        lifecycle = combine_release_and_readiness(lifecycle, readiness_lifecycle)?;
        next_scheduler = readiness_plan.next_scheduler;
        next_scheduler.set_revision(lifecycle.next_metadata.scheduler_revision);
        let operation_intents = intents
            .iter()
            .map(|intent| {
                Ok(crate::OperationIntentRecord {
                    kind: intent_kind(intent).to_owned(),
                    parameters_json: serde_json::to_string(&intent.parameters)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let operation = OperationRecord {
            operation_id: operation_id.clone(),
            change_set_id: claim.change_set_id.clone(),
            actor: before_change_set.actor.clone(),
            kind: if intents.len() == 1 {
                intent_kind(&intents[0]).to_owned()
            } else {
                format!("CompositeChangeSet({})", intents.len())
            },
            reasoning: before_change_set.reasoning.clone(),
            affected_node_ids: affected_node_ids.clone(),
            renames: operation_renames(&graph, &intents)?,
            intents: operation_intents,
        };
        let publication = Publication {
            schema_version: SCHEMA_VERSION,
            idempotency_key,
            delta,
            operation: operation.clone(),
            ticket: TicketRecord {
                ticket_id: before_ticket.ticket_id,
                state: "completed".into(),
                scope_fingerprint: fresh_scope.scope_fingerprint.clone(),
            },
            event: EventRecord {
                event_id: format!("graph-event:{}", uuid::Uuid::new_v4()),
                sequence: next_generation,
                kind: "PublicationCommitted".into(),
                graph_generation: next_generation,
                payload_json: serde_json::json!({
                    "changeSetId": claim.change_set_id,
                    "operationId": operation_id,
                })
                .to_string(),
            },
            fence: FenceClaim {
                service_epoch: self.service_epoch(),
                resource_tokens: BTreeMap::new(),
            },
        };
        next_scheduler.set_revision(lifecycle.next_metadata.scheduler_revision);
        let attempt_record = PublicationAttemptRecord {
            change_set_id: claim.change_set_id.clone(),
            attempt_id: claim.attempt_id.clone(),
            candidate_digest,
            prepared_graph_generation: Some(validated_candidate.prepared_graph_generation),
            generation: next_generation,
            graph_digest: next.digest().to_owned(),
        };
        let prepared_publication = PreparedPublication {
            expected_graph_generation: graph.generation(),
            expected_scheduler_revision: before_scheduler.revision(),
            expected_service_epoch: self.service_epoch(),
            claim: claim.clone(),
            envelope: candidate_envelope.clone(),
            dependency_versions: claim.dependency_versions.clone(),
            next_graph: next.clone(),
            next_scheduler: next_scheduler.clone(),
            lifecycle: lifecycle.clone(),
            resource_clock_updates: resource_clock_updates.clone(),
            attempt_record: attempt_record.clone(),
            operation,
        };
        let commit = CoordinatedCommit {
            publication,
            lifecycle: prepared_publication.lifecycle.clone(),
            service_epoch: prepared_publication.expected_service_epoch,
            reservation_keys: fresh_scope.reservation_keys,
            resource_clock_updates: prepared_publication.resource_clock_updates.clone(),
            publication_attempt: prepared_publication.attempt_record.clone(),
        };
        debug_assert_eq!(prepared_publication.operation, commit.publication.operation);
        if let Some(hook) = test_hooks.before_final_check {
            hook(optimistic_attempt);
        }
        let _publish = self
            .publish_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        if let Some(report) = self.committed_candidate_report_for_digest(
            claim,
            &prepared_publication.envelope.candidate_digest,
        )? {
            return Ok(PublishClaimOutcome::Published(report));
        }
        if let Err(error) =
            self.validate_executing_claim(&scheduler, &prepared_publication.claim, now_tick)
        {
            drop(scheduler);
            drop(_publish);
            if error.downcast_ref::<super::CoordinationError>()
                == Some(&super::CoordinationError::LeaseExpired)
                && now_tick >= prepared_publication.claim.expires_at_tick
            {
                self.expire_leases(now_tick)?;
            }
            return Err(error);
        }
        if !self
            .resource_clock_snapshot()
            .matches(&prepared_publication.dependency_versions)
        {
            drop(scheduler);
            drop(_publish);
            self.persist_changed_publication_scope(claim, now_tick, test_hooks)?;
            return self.invalidated_claim_outcome(claim);
        }
        if self.snapshot().generation() != prepared_publication.expected_graph_generation
            || scheduler.revision() != prepared_publication.expected_scheduler_revision
            || *scheduler != before_scheduler
            || self.service_epoch() != prepared_publication.expected_service_epoch
        {
            drop(scheduler);
            drop(_publish);
            let next_attempt = optimistic_attempt
                .checked_add(1)
                .context("optimistic attempt counter overflow")?;
            if next_attempt < super::MAX_OPTIMISTIC_RETRIES {
                return self.publish_claimed_inner(
                    claim,
                    CandidateSource::Validated(ValidatedCandidate {
                        envelope: candidate_envelope,
                        prepared_graph_generation: validated_candidate.prepared_graph_generation,
                    }),
                    now_tick,
                    PublicationExecution {
                        failpoint,
                        #[cfg(feature = "redb-spike-api")]
                        crash_failpoint,
                        after_outer_idempotency_lookup: None,
                        optimistic_attempt: next_attempt,
                        test_hooks,
                    },
                );
            }
            return Err(anyhow::Error::new(
                super::CoordinationError::OptimisticRetryExhausted {
                    attempts: super::MAX_OPTIMISTIC_RETRIES,
                },
            ));
        }
        if let Some(hook) = test_hooks.before_redb_commit {
            hook();
        }
        let persistence_started = Instant::now();
        let outcome = self.store.publish_coordinated(
            &commit,
            next.digest(),
            failpoint,
            #[cfg(feature = "redb-spike-api")]
            crash_failpoint,
        )?;
        let persistence_ns = persistence_started.elapsed().as_nanos();
        match outcome {
            PublishOutcome::AlreadyPublished { generation } => {
                let digest = self.store.generation_digest(generation)?;
                Ok(PublishClaimOutcome::Published(PublicationReport {
                    generation,
                    digest,
                    persistence_ns,
                    memory_publish_ns: 0,
                    already_published: true,
                }))
            }
            PublishOutcome::Published { generation } => {
                if generation != prepared_publication.next_graph.generation() {
                    bail!("durable generation does not match prepared generation");
                }
                let memory_started = Instant::now();
                *self
                    .live
                    .write()
                    .map_err(|_| anyhow::anyhow!("live generation lock is poisoned"))? =
                    prepared_publication.next_graph.clone();
                *self
                    .resource_clocks
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = next_resource_clocks;
                let memory_publish_ns = memory_started.elapsed().as_nanos();
                *scheduler = prepared_publication.next_scheduler;
                #[cfg(feature = "redb-spike-api")]
                if crash_failpoint == PublishFailpoint::AfterMemoryPublish {
                    std::process::abort();
                }
                Ok(PublishClaimOutcome::Published(PublicationReport {
                    generation,
                    digest: prepared_publication.next_graph.digest().to_owned(),
                    persistence_ns,
                    memory_publish_ns,
                    already_published: false,
                }))
            }
        }
    }

    fn committed_candidate_report(
        &self,
        claim: &ClaimHandle,
        candidate_source: &CandidateSource<'_>,
    ) -> Result<Option<PublicationReport>> {
        let Some(attempt) = self
            .store
            .coordination()
            .publication_attempt(&claim.attempt_id)?
        else {
            return Ok(None);
        };
        if attempt.change_set_id != claim.change_set_id {
            return Err(anyhow::Error::new(
                super::CoordinationError::AttemptDigestMismatch,
            ));
        }
        let candidate_digest = match candidate_source {
            #[cfg(feature = "coordination-test-api")]
            CandidateSource::ExternalEnvelope(envelope) => {
                envelope.validate_digest()?;
                envelope.candidate_digest.clone()
            }
            CandidateSource::Validated(candidate) => candidate.envelope.candidate_digest.clone(),
            CandidateSource::Executor(executor) => {
                let base_generation = match attempt.prepared_graph_generation {
                    Some(generation) => generation,
                    None => attempt.generation.checked_sub(1).with_context(|| {
                        format!(
                            "publication attempt {} has invalid generation zero",
                            attempt.attempt_id
                        )
                    })?,
                };
                let graph = Arc::new(self.store.graph_generation(base_generation)?);
                let durable = self.store.coordination();
                let mut change_set =
                    durable
                        .change_set(&attempt.change_set_id)?
                        .with_context(|| {
                            format!("change set {} does not exist", attempt.change_set_id)
                        })?;
                let scope_fingerprint = change_set
                    .inferred_scope
                    .as_ref()
                    .context("committed change set has no inferred scope")?
                    .scope_fingerprint
                    .clone();
                change_set.state = ChangeSetState::Executing;
                change_set.committed_generation = None;
                let prepared = PreparedCandidate {
                    change_set,
                    intents: durable.intents_for(&attempt.change_set_id)?,
                    graph,
                    attempt_id: attempt.attempt_id.clone(),
                    scope_fingerprint,
                };
                let envelope = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    executor.build_candidate(&prepared)
                }))
                .map_err(|_| anyhow::anyhow!("committed replay builder panicked"))??;
                envelope.validate_digest()?;
                envelope.candidate_digest
            }
        };
        if attempt.candidate_digest != candidate_digest {
            return Err(anyhow::Error::new(
                super::CoordinationError::AttemptDigestMismatch,
            ));
        }
        Ok(Some(PublicationReport {
            generation: attempt.generation,
            digest: attempt.graph_digest,
            persistence_ns: 0,
            memory_publish_ns: 0,
            already_published: true,
        }))
    }

    fn committed_candidate_report_for_digest(
        &self,
        claim: &ClaimHandle,
        validated_candidate_digest: &str,
    ) -> Result<Option<PublicationReport>> {
        let Some(attempt) = self
            .store
            .coordination()
            .publication_attempt(&claim.attempt_id)?
        else {
            return Ok(None);
        };
        if attempt.change_set_id != claim.change_set_id
            || attempt.candidate_digest != validated_candidate_digest
        {
            return Err(anyhow::Error::new(
                super::CoordinationError::AttemptDigestMismatch,
            ));
        }
        Ok(Some(PublicationReport {
            generation: attempt.generation,
            digest: attempt.graph_digest,
            persistence_ns: 0,
            memory_publish_ns: 0,
            already_published: true,
        }))
    }

    fn validate_executing_claim(
        &self,
        scheduler: &SchedulerState,
        claim: &ClaimHandle,
        now_tick: u64,
    ) -> Result<()> {
        if claim.service_epoch != self.service_epoch()
            || claim.expires_at_tick == 0
            || now_tick >= claim.expires_at_tick
        {
            return Err(anyhow::Error::new(super::CoordinationError::LeaseExpired));
        }
        let durable = self.store.coordination();
        let active = durable
            .active_claims()?
            .into_iter()
            .find(|active| active.claim_id == claim.claim_id)
            .ok_or_else(|| anyhow::Error::new(super::CoordinationError::LeaseExpired))?;
        if active != *claim {
            bail!("claim does not match durable executing claim");
        }
        let ticket = scheduler
            .tickets()
            .find(|ticket| ticket.change_set_id == claim.change_set_id)
            .context("claim has no scheduler ticket")?;
        if ticket.state != TicketState::Claimed
            || ticket.active_claim_id.as_deref() != Some(claim.claim_id.as_str())
            || ticket.scope_fingerprint != claim.scope_fingerprint
            || ticket.reservation_keys != claim.reservation_keys
        {
            bail!("claim does not match scheduler executing state");
        }
        Ok(())
    }

    fn invalidated_claim_outcome(&self, claim: &ClaimHandle) -> Result<PublishClaimOutcome> {
        let durable = self.store.coordination();
        let change_set = durable
            .change_set(&claim.change_set_id)?
            .context("invalidated publication lost its change set")?;
        let event = durable
            .events_after("publication-invalidation", 0, usize::MAX)?
            .into_iter()
            .rev()
            .find(|event| event.change_set_id == claim.change_set_id)
            .context("invalidated publication did not append an event")?;
        match change_set.state {
            ChangeSetState::Queued => Ok(PublishClaimOutcome::Requeued {
                ticket: self
                    .ticket_for_change_set(&claim.change_set_id)?
                    .context("requeued publication lost its ticket")?,
                event,
            }),
            ChangeSetState::NeedsDecision => {
                Ok(PublishClaimOutcome::NeedsDecision { change_set, event })
            }
            state => bail!("invalidated publication remained in unexpected state {state:?}"),
        }
    }

    fn persist_changed_publication_scope(
        &self,
        claim: &ClaimHandle,
        now_tick: u64,
        test_hooks: PublicationTestHooks<'_>,
    ) -> Result<()> {
        let mut invalidation_attempt = 0;
        // Once authority is known stale, unrelated optimistic losses cannot safely return while
        // the exact claim is still active. Replan until this claim is atomically removed or a
        // concurrent lifecycle transition makes validate_executing_claim return its typed error.
        loop {
            let durable = self.store.coordination();
            let graph = self.snapshot();
            let clocks = self.resource_clock_snapshot();
            let service_epoch = self.service_epoch();
            let before_scheduler = {
                let scheduler = self
                    .scheduler
                    .lock()
                    .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
                scheduler.clone()
            };
            let expected_revision = before_scheduler.revision();
            self.validate_executing_claim(&before_scheduler, claim, now_tick)?;
            let before_change_set = durable
                .change_set(&claim.change_set_id)?
                .with_context(|| format!("change set {} does not exist", claim.change_set_id))?;
            if before_change_set.state != ChangeSetState::Executing {
                bail!("change set {} is not Executing", claim.change_set_id);
            }
            let previous_scope = before_change_set
                .inferred_scope
                .as_ref()
                .context("executing change set has no inferred scope")?;
            let intents = durable.intents_for(&claim.change_set_id)?;
            let authority = plan_change_set(&graph, &intents, self.semantic_provider()?)?;
            let fresh_scope = authority.scope;
            let scope_change = classify_scope_change(previous_scope, &fresh_scope);
            let planned_dependencies = clocks.dependencies(&authority.dependency_keys);
            let metadata = durable.metadata_state()?;
            if metadata.scheduler_revision != expected_revision {
                continue;
            }
            let mut base = transition(metadata)?;
            let mut simulated = before_scheduler.clone();
            let mut after_change_set = before_change_set.clone();
            after_change_set.inferred_scope = Some(fresh_scope.clone());
            let terminal = matches!(scope_change, ScopeChange::MateriallyChanged)
                || matches!(
                    fresh_scope.dynamic_expansion_policy,
                    DynamicExpansionPolicy::NeedsDecision
                )
                || before_change_set.expansion_count
                    >= match fresh_scope.dynamic_expansion_policy {
                        DynamicExpansionPolicy::Requeue { max_expansions } => max_expansions,
                        DynamicExpansionPolicy::NeedsDecision => 0,
                    };
            let (blocking_event_sequence, deferred_change_set_ids) = if terminal {
                simulated.release(&claim.claim_id, TicketState::NeedsDecision)?;
                after_change_set.state = ChangeSetState::NeedsDecision;
                let event = append_event(
                    &mut base,
                    CoordinationEventKind::IntentNeedsDecision,
                    &claim.change_set_id,
                    graph.generation(),
                )?;
                (Some(event.sequence), BTreeSet::new())
            } else {
                simulated.requeue_claim_with_scope(
                    &claim.claim_id,
                    fresh_scope.scope_fingerprint.clone(),
                    fresh_scope.reservation_keys.clone(),
                )?;
                after_change_set.state = ChangeSetState::Queued;
                after_change_set.expansion_count = after_change_set
                    .expansion_count
                    .checked_add(1)
                    .context("scope expansion count overflow")?;
                append_event(
                    &mut base,
                    CoordinationEventKind::ScopeExpanded,
                    &claim.change_set_id,
                    graph.generation(),
                )?;
                (None, BTreeSet::from([claim.change_set_id.clone()]))
            };
            base.change_sets
                .push((Some(before_change_set.clone()), Some(after_change_set)));
            base.claims.push((Some(claim.clone()), None));
            base.tickets = scheduler_ticket_updates(&before_scheduler, &simulated);

            let plan = plan_readiness(
                self.semantic_provider()?,
                PlannerSnapshot {
                    graph: graph.clone(),
                    scheduler: simulated,
                    scheduler_revision: expected_revision,
                    service_epoch,
                    now_tick,
                    cause: super::TransitionCause::ClaimRejection,
                    blocking_event_sequence,
                    deferred_change_set_ids,
                },
                &durable,
            )?;
            let mut combined = combine_release_and_readiness(base, plan.lifecycle_transition()?)?;
            combined.expected_metadata.scheduler_revision = expected_revision;
            combined.next_metadata.scheduler_revision = expected_revision
                .checked_add(1)
                .context("scheduler revision overflow")?;
            let mut final_scheduler = plan.next_scheduler;
            final_scheduler.set_revision(combined.next_metadata.scheduler_revision);

            if let Some(hook) = test_hooks.before_invalidation_final_check {
                hook(invalidation_attempt);
            }
            invalidation_attempt = invalidation_attempt.saturating_add(1);
            let publication = self
                .publish_lock
                .lock()
                .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if let Err(error) = self.validate_executing_claim(&scheduler, claim, now_tick) {
                drop(scheduler);
                drop(publication);
                if error.downcast_ref::<super::CoordinationError>()
                    == Some(&super::CoordinationError::LeaseExpired)
                    && now_tick >= claim.expires_at_tick
                {
                    self.expire_leases(now_tick)?;
                }
                return Err(error);
            }
            if !self
                .resource_clock_snapshot()
                .matches(&planned_dependencies)
            {
                drop(scheduler);
                drop(publication);
                continue;
            }
            if self.snapshot().generation() != graph.generation()
                || self.service_epoch() != service_epoch
                || scheduler.revision() != expected_revision
                || *scheduler != before_scheduler
                || durable.change_set(&claim.change_set_id)?.as_ref() != Some(&before_change_set)
            {
                drop(scheduler);
                drop(publication);
                continue;
            }
            if let Some(hook) = test_hooks.before_redb_commit {
                hook();
            }
            durable.persist_lifecycle(&combined)?;
            *scheduler = final_scheduler;
            return Ok(());
        }
    }
}
