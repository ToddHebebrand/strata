#![cfg(feature = "coordination-test-api")]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, bail};

use super::analyzer::analyze_change_set;
use super::authority::plan_change_set;
use super::coordinator::{
    affected_node_ids, append_event, append_event_with_payload, bounded_wake_payload,
    bounded_wake_payload_with_scope, combine_release_and_readiness, coordination_commit_key,
    intent_kind, scheduler_ticket_updates, transition,
};
use super::planner::{PlannerSnapshot, plan_readiness};
use super::resource_keys;
use super::{
    CandidateBuilder, CandidateEnvelope, ChangeSetRecord, ChangeSetState, ClaimHandle,
    CoordinationEventKind, DependencyVersion, DynamicExpansionPolicy, LifecycleTransition,
    PreparedCandidate, PublicationAttemptRecord, PublishClaimOutcome, SchedulerState, ScopeChange,
    TicketState, classify_scope_change,
};
use crate::model::{FenceClaim, Publication};
use crate::storage::{CoordinatedCommit, CoordinatedPublishFailpoint, PublishOutcome};
use crate::{
    EventRecord, GraphGeneration, Kernel, OperationRecord, PublicationReport, SCHEMA_VERSION,
    TicketRecord,
};

enum CandidateSource<'a> {
    Builder(&'a dyn CandidateBuilder),
    Envelope(CandidateEnvelope),
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
    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            CoordinatedPublishFailpoint::None,
            None,
            0,
        )
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed_envelope(
        &self,
        claim: &ClaimHandle,
        envelope: CandidateEnvelope,
        now_tick: u64,
    ) -> Result<PublishClaimOutcome> {
        envelope.validate_digest()?;
        self.publish_claimed_inner(
            claim,
            CandidateSource::Envelope(envelope),
            now_tick,
            CoordinatedPublishFailpoint::None,
            None,
            0,
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
        let outcome = self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            failpoint,
            None,
            0,
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
        let outcome = self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            CoordinatedPublishFailpoint::None,
            Some(after_outer_idempotency_lookup),
            0,
        )?;
        let PublishClaimOutcome::Published(report) = outcome else {
            bail!("entry-hook publication did not reach a graph publication outcome")
        };
        Ok(report)
    }

    #[cfg(feature = "coordination-test-api")]
    fn publish_claimed_inner(
        &self,
        claim: &ClaimHandle,
        candidate_source: CandidateSource<'_>,
        now_tick: u64,
        failpoint: CoordinatedPublishFailpoint,
        after_outer_idempotency_lookup: Option<&dyn Fn()>,
        optimistic_attempt: u32,
    ) -> Result<PublishClaimOutcome> {
        let idempotency_key = coordination_commit_key(&claim.change_set_id);
        if let Some(report) = self.committed_candidate_report(claim, &candidate_source)? {
            return Ok(PublishClaimOutcome::Published(report));
        }
        if let Some(hook) = after_outer_idempotency_lookup {
            hook();
        }

        let semantic_provider = self.semantic_provider()?;
        let durable = self.store.coordination();
        let captured_revision = {
            let scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            self.validate_executing_claim(&scheduler, claim, now_tick)?;
            scheduler.revision()
        };
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
            self.persist_changed_publication_scope(claim, fresh_scope, scope_change, now_tick)?;
            return self.invalidated_claim_outcome(claim);
        }

        let candidate_may_rebase = matches!(&candidate_source, CandidateSource::Envelope(_));
        let envelope = match candidate_source {
            CandidateSource::Builder(candidate_builder) => {
                let prepared = PreparedCandidate {
                    change_set: before_change_set.clone(),
                    intents: intents.clone(),
                    graph: prepared_graph.clone(),
                    attempt_id: claim.attempt_id.clone(),
                    scope_fingerprint: fresh_scope.scope_fingerprint.clone(),
                };
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    candidate_builder.build_candidate(&prepared)
                }))
                .map_err(|_| anyhow::anyhow!("candidate builder panicked"))??
            }
            CandidateSource::Envelope(envelope) => envelope,
        };
        envelope.validate_digest()?;
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
        let candidate_envelope = CandidateEnvelope {
            delta: delta.clone(),
            candidate_digest: candidate_digest.clone(),
        };

        let before_scheduler = {
            let scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            self.validate_executing_claim(&scheduler, claim, now_tick)?;
            scheduler.clone()
        };
        let graph = self.snapshot();
        let clocks = self.resource_clock_snapshot();
        if !clocks.matches(&claim.dependency_versions) {
            let authority = plan_change_set(&graph, &intents, semantic_provider)?;
            let changed = classify_scope_change(previous_scope, &authority.scope);
            self.persist_changed_publication_scope(claim, authority.scope, changed, now_tick)?;
            return self.invalidated_claim_outcome(claim);
        }
        if before_scheduler.revision() < captured_revision {
            bail!("scheduler revision moved backward during candidate construction");
        }
        let current_authority = plan_change_set(&graph, &intents, semantic_provider)?;
        let current_scope_change = classify_scope_change(previous_scope, &current_authority.scope);
        if current_scope_change != ScopeChange::Unchanged {
            self.persist_changed_publication_scope(
                claim,
                current_authority.scope,
                current_scope_change,
                now_tick,
            )?;
            return self.invalidated_claim_outcome(claim);
        }
        let fresh_scope = current_authority.scope;
        delta.base_generation = graph.generation();
        super::validate_delta_containment(&graph, &delta, &fresh_scope)
            .context("rebased candidate delta is outside inferred scope")?;
        let semantic_index_keys = fresh_scope
            .write_set
            .iter()
            .chain(&fresh_scope.validation_set)
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

        let mut successor_change_sets: BTreeMap<String, (ChangeSetRecord, ChangeSetRecord)> =
            BTreeMap::new();
        let mut terminal_successor_ticket_ids = BTreeSet::new();
        loop {
            let selected = next_scheduler.select_ready()?;
            if selected.is_empty() {
                break;
            }
            let mut analyses = Vec::with_capacity(selected.len());
            let mut any_scope_change = false;
            for ticket_id in selected {
                let ticket = next_scheduler
                    .ticket(&ticket_id)
                    .cloned()
                    .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
                let (durable_before, current) = if let Some((before, after)) =
                    successor_change_sets.get(&ticket.change_set_id)
                {
                    (before.clone(), after.clone())
                } else {
                    let before = durable
                        .change_set(&ticket.change_set_id)?
                        .with_context(|| {
                            format!("missing successor change set {}", ticket.change_set_id)
                        })?;
                    (before.clone(), before)
                };
                let previous_scope = current
                    .inferred_scope
                    .as_ref()
                    .context("queued successor has no inferred scope")?;
                let successor_intents = durable.intents_for(&ticket.change_set_id)?;
                let fresh = analyze_change_set(&next, &successor_intents, semantic_provider)?;
                let scope_change = classify_scope_change(previous_scope, &fresh);
                any_scope_change |= scope_change != ScopeChange::Unchanged;
                analyses.push((ticket, durable_before, current, fresh, scope_change));
            }

            if !any_scope_change {
                for (ticket, durable_before, mut current, fresh, _) in analyses {
                    let mut fresh_ticket = next_scheduler.update_queued_scope(
                        &ticket.ticket_id,
                        fresh.scope_fingerprint.clone(),
                        fresh.reservation_keys.clone(),
                    )?;
                    let mut offer = super::planner::make_offer(
                        &fresh_ticket,
                        self.service_epoch(),
                        next_generation,
                        now_tick,
                    )?;
                    offer.blocking_event_sequence = Some(committed_event.sequence);
                    super::planner::mark_ready(
                        &mut next_scheduler,
                        &ticket.ticket_id,
                        offer.clone(),
                    )?;
                    fresh_ticket = next_scheduler
                        .ticket(&ticket.ticket_id)
                        .cloned()
                        .context("freshly offered successor disappeared")?;
                    debug_assert_eq!(fresh_ticket.scope_fingerprint, fresh.scope_fingerprint);
                    current.state = ChangeSetState::Ready;
                    current.inferred_scope = Some(fresh.clone());
                    current.blocking_change_set_id = Some(claim.change_set_id.clone());
                    successor_change_sets
                        .insert(current.change_set_id.clone(), (durable_before, current));
                    lifecycle.offers.push((None, Some(offer.clone())));
                    append_event_with_payload(
                        &mut lifecycle,
                        CoordinationEventKind::IntentReady,
                        &offer.change_set_id,
                        next_generation,
                        bounded_wake_payload_with_scope(
                            "blockingOperationId",
                            &operation_id,
                            graph.generation(),
                            next_generation,
                            &affected_node_ids,
                            &fresh.scope_fingerprint,
                        ),
                    )?;
                }
                break;
            }

            for (ticket, durable_before, mut current, fresh, scope_change) in analyses {
                if scope_change == ScopeChange::Unchanged {
                    continue;
                }
                let can_requeue_expansion = scope_change == ScopeChange::Expanded
                    && matches!(
                        fresh.dynamic_expansion_policy,
                        DynamicExpansionPolicy::Requeue { max_expansions }
                            if current.expansion_count < max_expansions
                    );
                if can_requeue_expansion {
                    next_scheduler.update_queued_scope(
                        &ticket.ticket_id,
                        fresh.scope_fingerprint.clone(),
                        fresh.reservation_keys.clone(),
                    )?;
                    current.state = ChangeSetState::Queued;
                    current.inferred_scope = Some(fresh.clone());
                    current.blocking_change_set_id = Some(claim.change_set_id.clone());
                    current.expansion_count = current
                        .expansion_count
                        .checked_add(1)
                        .context("successor scope expansion count overflow")?;
                    successor_change_sets.insert(
                        current.change_set_id.clone(),
                        (durable_before, current.clone()),
                    );
                    append_event_with_payload(
                        &mut lifecycle,
                        CoordinationEventKind::ScopeExpanded,
                        &current.change_set_id,
                        next_generation,
                        bounded_wake_payload_with_scope(
                            "blockingOperationId",
                            &operation_id,
                            graph.generation(),
                            next_generation,
                            &affected_node_ids,
                            &fresh.scope_fingerprint,
                        ),
                    )?;
                } else {
                    let current_ticket = next_scheduler
                        .ticket(&ticket.ticket_id)
                        .cloned()
                        .context("terminal successor ticket disappeared")?;
                    next_scheduler.cancel_ticket(&ticket.ticket_id)?;
                    let mut terminal_ticket = current_ticket;
                    terminal_ticket.state = TicketState::NeedsDecision;
                    terminal_ticket.scope_fingerprint = fresh.scope_fingerprint.clone();
                    terminal_ticket.reservation_keys = fresh.reservation_keys.clone();
                    terminal_ticket.ready_offer_id = None;
                    terminal_ticket.active_claim_id = None;
                    let durable_before_ticket = before_scheduler
                        .ticket(&ticket.ticket_id)
                        .cloned()
                        .context("terminal successor missing before scheduler ticket")?;
                    lifecycle
                        .tickets
                        .push((Some(durable_before_ticket), Some(terminal_ticket)));
                    terminal_successor_ticket_ids.insert(ticket.ticket_id.clone());
                    current.state = ChangeSetState::NeedsDecision;
                    current.inferred_scope = Some(fresh.clone());
                    current.blocking_change_set_id = Some(claim.change_set_id.clone());
                    successor_change_sets.insert(
                        current.change_set_id.clone(),
                        (durable_before, current.clone()),
                    );
                    append_event_with_payload(
                        &mut lifecycle,
                        CoordinationEventKind::IntentNeedsDecision,
                        &current.change_set_id,
                        next_generation,
                        bounded_wake_payload_with_scope(
                            "blockingOperationId",
                            &operation_id,
                            graph.generation(),
                            next_generation,
                            &affected_node_ids,
                            &fresh.scope_fingerprint,
                        ),
                    )?;
                }
            }
        }
        lifecycle.change_sets.extend(
            successor_change_sets
                .into_values()
                .map(|(before, after)| (Some(before), Some(after))),
        );
        lifecycle.tickets.extend(
            scheduler_ticket_updates(&before_scheduler, &next_scheduler)
                .into_iter()
                .filter(|(before, after)| {
                    let ticket_id = before
                        .as_ref()
                        .or(after.as_ref())
                        .map(|ticket| ticket.ticket_id.as_str());
                    ticket_id != Some(before_ticket.ticket_id.as_str())
                        && ticket_id.is_none_or(|ticket_id| {
                            !terminal_successor_ticket_ids.contains(ticket_id)
                        })
                }),
        );

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
        let _publish = self
            .publish_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        if let Some(report) = self.committed_candidate_report(
            claim,
            &CandidateSource::Envelope(prepared_publication.envelope.clone()),
        )? {
            return Ok(PublishClaimOutcome::Published(report));
        }
        if self.snapshot().generation() != prepared_publication.expected_graph_generation
            || scheduler.revision() != prepared_publication.expected_scheduler_revision
            || *scheduler != before_scheduler
            || self.service_epoch() != prepared_publication.expected_service_epoch
            || !self
                .resource_clock_snapshot()
                .matches(&prepared_publication.dependency_versions)
        {
            drop(scheduler);
            drop(_publish);
            let next_attempt = optimistic_attempt
                .checked_add(1)
                .context("optimistic attempt counter overflow")?;
            if next_attempt < super::MAX_OPTIMISTIC_RETRIES {
                return self.publish_claimed_inner(
                    claim,
                    CandidateSource::Envelope(candidate_envelope),
                    now_tick,
                    failpoint,
                    None,
                    next_attempt,
                );
            }
            return Err(anyhow::Error::new(
                super::CoordinationError::OptimisticRetryExhausted {
                    attempts: super::MAX_OPTIMISTIC_RETRIES,
                },
            ));
        }
        self.validate_executing_claim(&scheduler, &prepared_publication.claim, now_tick)?;
        let persistence_started = Instant::now();
        let outcome = self
            .store
            .publish_coordinated(&commit, next.digest(), failpoint)?;
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

    #[cfg(feature = "coordination-test-api")]
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
            CandidateSource::Envelope(envelope) => {
                envelope.validate_digest()?;
                envelope.candidate_digest.clone()
            }
            CandidateSource::Builder(builder) => {
                let base_generation = attempt.generation.checked_sub(1).with_context(|| {
                    format!(
                        "publication attempt {} has invalid generation zero",
                        attempt.attempt_id
                    )
                })?;
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
                let envelope = builder.build_candidate(&prepared)?;
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

    #[cfg(feature = "coordination-test-api")]
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

    #[cfg(feature = "coordination-test-api")]
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

    #[cfg(feature = "coordination-test-api")]
    fn persist_changed_publication_scope(
        &self,
        claim: &ClaimHandle,
        fresh_scope: super::InferredScope,
        scope_change: ScopeChange,
        now_tick: u64,
    ) -> Result<()> {
        for _ in 0..super::MAX_OPTIMISTIC_RETRIES {
            let durable = self.store.coordination();
            let graph = self.snapshot();
            let service_epoch = self.service_epoch();
            let (before_scheduler, expected_revision) = {
                let scheduler = self
                    .scheduler
                    .lock()
                    .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
                (scheduler.clone(), scheduler.revision())
            };
            self.validate_executing_claim(&before_scheduler, claim, now_tick)?;
            let before_change_set = durable
                .change_set(&claim.change_set_id)?
                .with_context(|| format!("change set {} does not exist", claim.change_set_id))?;
            if before_change_set.state != ChangeSetState::Executing {
                bail!("change set {} is not Executing", claim.change_set_id);
            }
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

            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if self.snapshot().generation() != graph.generation()
                || self.service_epoch() != service_epoch
                || scheduler.revision() != expected_revision
                || *scheduler != before_scheduler
                || durable.change_set(&claim.change_set_id)?.as_ref() != Some(&before_change_set)
                || durable
                    .active_claims()?
                    .into_iter()
                    .find(|active| active.claim_id == claim.claim_id)
                    .as_ref()
                    != Some(claim)
            {
                continue;
            }
            durable.persist_lifecycle(&combined)?;
            *scheduler = final_scheduler;
            return Ok(());
        }
        Err(anyhow::Error::new(
            super::CoordinationError::OptimisticRetryExhausted {
                attempts: super::MAX_OPTIMISTIC_RETRIES,
            },
        ))
    }
}
