use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(feature = "coordination-test-api")]
use super::PublicationAttemptRecord;
use super::analyzer::analyze_change_set;
use super::authority::plan_change_set;
use super::durable::{CoordinationMetadataState, LifecycleTransition};
use super::planner::{PlannerSnapshot, plan_readiness};
use super::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, CreateDraftOutcome, DynamicExpansionPolicy,
    EventCursor, IntentParameters, IntentRecord, LeaseExpiryOutcome, ReadyOffer, SchedulerState,
    ScopeChange, SubmissionOutcome, TicketState, classify_scope_change,
};
use crate::GraphChange;
use crate::{Kernel, OperationRecord, SCHEMA_VERSION};

pub const READY_OFFER_TTL_TICKS: u64 = 30;
pub const DRAFT_TTL_TICKS: u64 = 120;
pub const CLAIM_TTL_TICKS: u64 = 60;
pub const MAX_WAKE_AFFECTED_NODE_IDS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginChangeSet {
    pub change_set_id: String,
    pub actor: String,
    pub reasoning: String,
    pub submission_idempotency_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancellationOutcome {
    pub change_set: ChangeSetRecord,
    pub ready_offers: Vec<ReadyOffer>,
}

impl Kernel {
    pub fn change_set(&self, id: &str) -> Result<Option<ChangeSetRecord>> {
        self.store.coordination().change_set(id)
    }

    /// Reads only the bounded intent records needed by the local service to
    /// reconcile a write-ahead request after restart. These records are never
    /// part of the client protocol.
    pub fn intents_for_change_set_bounded(
        &self,
        id: &str,
        limit: usize,
    ) -> Result<Vec<IntentRecord>> {
        if limit == 0 || limit > 256 {
            bail!("intent projection limit must be in 1..=256");
        }
        let intents = self.store.coordination().intents_for(id)?;
        if intents.len() > limit {
            bail!("change set {id} exceeds {limit} intent projection bound");
        }
        Ok(intents)
    }

    pub fn ticket_for_change_set(&self, id: &str) -> Result<Option<CoordinationTicket>> {
        Ok(self
            .store
            .coordination()
            .all_tickets()?
            .into_iter()
            .find(|ticket| ticket.change_set_id == id))
    }

    pub fn operation(&self, generation: u64) -> Result<Option<OperationRecord>> {
        self.store.operation(generation)
    }

    /// Net renamed-symbol transitions committed after `base_generation`, for
    /// fresh-decision reporting: an agent whose change set needs a decision
    /// authored its intent content against `base_generation`, so any name it
    /// used may have moved. Walks the operation log; bounded, deterministic.
    pub fn renamed_symbols_since(
        &self,
        base_generation: u64,
    ) -> Result<Vec<crate::OperationRename>> {
        let current = self.snapshot().generation();
        let mut operations = Vec::new();
        let mut generation = base_generation;
        while generation < current {
            generation = generation
                .checked_add(1)
                .context("operation walk generation overflow")?;
            if let Some(operation) = self.store.operation(generation)? {
                operations.push(operation);
            }
        }
        Ok(fold_operation_renames(operations.iter()))
    }

    pub fn ready_offer_for_change_set(&self, id: &str) -> Result<Option<ReadyOffer>> {
        Ok(self
            .store
            .coordination()
            .ready_offers()?
            .into_iter()
            .find(|offer| offer.change_set_id == id))
    }

    #[cfg(feature = "coordination-test-api")]
    pub fn publication_attempt(
        &self,
        attempt_id: &str,
    ) -> Result<Option<PublicationAttemptRecord>> {
        self.store.coordination().publication_attempt(attempt_id)
    }

    pub fn events_after(
        &self,
        client_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<CoordinationEvent>> {
        self.store
            .coordination()
            .events_after(client_id, after_sequence, limit)
    }

    pub fn ack_events(&self, client_id: &str, sequence: u64) -> Result<EventCursor> {
        self.store.coordination().ack_events(client_id, sequence)
    }

    pub fn begin_change_set(
        &self,
        input: BeginChangeSet,
        now_tick: u64,
    ) -> Result<ChangeSetRecord> {
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let mut record = ChangeSetRecord::new(
            SCHEMA_VERSION,
            input.change_set_id,
            input.actor,
            input.reasoning,
            self.snapshot().generation(),
            input.submission_idempotency_key,
            &[],
        )
        .map_err(anyhow::Error::msg)?;
        record.created_at_tick = now_tick;
        record.expires_at_tick = Some(
            now_tick
                .checked_add(DRAFT_TTL_TICKS)
                .context("draft expiry overflow")?,
        );
        let durable = self.store.coordination();
        let outcome = durable.create_draft(&record)?;
        scheduler.set_revision(durable.metadata_state()?.scheduler_revision);
        match outcome {
            CreateDraftOutcome::Created { change_set }
            | CreateDraftOutcome::Duplicate { change_set } => Ok(change_set),
        }
    }

    pub fn add_intent(
        &self,
        change_set_id: &str,
        parameters: IntentParameters,
    ) -> Result<IntentRecord> {
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let change_set = self
            .store
            .coordination()
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if change_set.state != ChangeSetState::Draft {
            bail!(
                "change set {change_set_id} is {:?}, not Draft",
                change_set.state
            );
        }
        let intent = IntentRecord::new(
            SCHEMA_VERSION,
            Uuid::new_v4().to_string(),
            change_set_id,
            change_set.base_generation,
            parameters,
        )
        .map_err(anyhow::Error::msg)?;
        self.store.coordination().append_intent(&intent)?;
        scheduler.set_revision(
            self.store
                .coordination()
                .metadata_state()?
                .scheduler_revision,
        );
        Ok(intent)
    }

    pub fn submit_change_set(
        &self,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<SubmissionOutcome> {
        let durable = self.store.coordination();
        let draft = durable
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if draft.state != ChangeSetState::Draft {
            return Ok(SubmissionOutcome::Duplicate { change_set: draft });
        }
        if draft
            .expires_at_tick
            .is_some_and(|expires_at| now_tick >= expires_at)
        {
            self.expire_leases(now_tick)?;
            return Err(anyhow::Error::new(super::CoordinationError::LeaseExpired));
        }
        let semantic_provider = self.semantic_provider()?;
        let graph = self.snapshot();
        let intents = durable.intents_for(change_set_id)?;
        let scope = analyze_change_set(&graph, &intents, semantic_provider)?;

        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let current_draft = durable
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if current_draft.state != ChangeSetState::Draft {
            return Ok(SubmissionOutcome::Duplicate {
                change_set: current_draft,
            });
        }
        if current_draft != draft || self.snapshot().generation() != graph.generation() {
            return Err(anyhow::Error::new(
                super::CoordinationError::OptimisticRetryExhausted {
                    attempts: super::MAX_OPTIMISTIC_RETRIES,
                },
            ));
        }
        let metadata = durable.metadata_state()?;
        if scheduler.revision() != metadata.scheduler_revision {
            return Err(anyhow::Error::new(
                super::CoordinationError::OptimisticRetryExhausted {
                    attempts: super::MAX_OPTIMISTIC_RETRIES,
                },
            ));
        }
        let queue_sequence = metadata.next_queue_sequence;
        let next_queue_sequence = queue_sequence
            .checked_add(1)
            .context("coordination queue sequence overflow")?;

        let mut queued_change_set = draft.clone();
        queued_change_set.state = ChangeSetState::Queued;
        queued_change_set.expires_at_tick = None;
        queued_change_set.inferred_scope = Some(scope.clone());
        queued_change_set.queue_sequence = Some(queue_sequence);
        let queued_ticket = CoordinationTicket::new(
            SCHEMA_VERSION,
            Uuid::new_v4().to_string(),
            change_set_id,
            TicketState::Queued,
            scope.scope_fingerprint.clone(),
            scope.reservation_keys.clone(),
            queue_sequence,
        )
        .map_err(anyhow::Error::msg)?;

        let before_scheduler = scheduler.clone();
        let mut next_scheduler = scheduler.clone();
        next_scheduler.enqueue(queued_ticket.clone())?;

        let mut transition = transition(metadata)?;
        transition.next_metadata.next_queue_sequence = next_queue_sequence;
        let queued_event = append_event(
            &mut transition,
            CoordinationEventKind::IntentQueued,
            change_set_id,
            graph.generation(),
        )?;
        debug_assert_eq!(queued_event.kind, CoordinationEventKind::IntentQueued);

        transition
            .change_sets
            .push((Some(draft), Some(queued_change_set)));
        transition.tickets = scheduler_ticket_updates(&before_scheduler, &next_scheduler);
        next_scheduler.set_revision(transition.next_metadata.scheduler_revision);
        durable.persist_lifecycle(&transition)?;
        *scheduler = next_scheduler;
        drop(scheduler);

        self.plan_and_apply_readiness(now_tick, super::TransitionCause::Submission, None)?;
        let ticket = durable
            .all_tickets()?
            .into_iter()
            .find(|ticket| ticket.change_set_id == change_set_id)
            .context("submitted ticket missing after readiness planning")?;
        if let Some(offer) = self.ready_offer_for_change_set(change_set_id)? {
            Ok(SubmissionOutcome::Ready { ticket, offer })
        } else {
            Ok(SubmissionOutcome::Queued { ticket })
        }
    }

    pub fn claim_ready(
        &self,
        offer_id: &str,
        claim_token: &str,
        now_tick: u64,
    ) -> Result<ClaimOutcome> {
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
            let offer = before_scheduler
                .offer(offer_id)
                .cloned()
                .with_context(|| format!("ready offer {offer_id} does not exist"))?;
            if offer.claim_token != claim_token {
                bail!("ready offer {offer_id} claim token does not match");
            }
            validate_offer_context(&offer, service_epoch, now_tick)?;
            let before_ticket = before_scheduler
                .ticket_for_offer(offer_id)
                .cloned()
                .with_context(|| format!("ready offer {offer_id} has no ticket"))?;
            let before_change_set = durable
                .change_set(&offer.change_set_id)?
                .with_context(|| format!("missing change set {}", offer.change_set_id))?;
            if before_change_set.state != ChangeSetState::Ready {
                bail!(
                    "change set {} is {:?}, not Ready",
                    offer.change_set_id,
                    before_change_set.state
                );
            }
            let before_scope = before_change_set
                .inferred_scope
                .as_ref()
                .context("ready change set has no inferred scope")?;
            let intents = durable.intents_for(&offer.change_set_id)?;
            let next_authority = plan_change_set(&graph, &intents, self.semantic_provider()?)?;
            let next_scope = next_authority.scope.clone();
            let scope_change = classify_scope_change(before_scope, &next_scope);
            let metadata = durable.metadata_state()?;
            if metadata.scheduler_revision != expected_revision {
                continue;
            }
            let mut base = transition(metadata)?;
            base.offers.push((Some(offer.clone()), None));
            let mut simulated = before_scheduler.clone();

            let (outcome, mut combined, mut final_scheduler) = match scope_change {
                ScopeChange::Unchanged | ScopeChange::Contracted => {
                    let mut claim = ClaimHandle::new(
                        Uuid::new_v4().to_string(),
                        offer.change_set_id.clone(),
                        offer.offer_id.clone(),
                        service_epoch,
                        graph.generation(),
                        next_scope.scope_fingerprint.clone(),
                        next_scope.reservation_keys.clone(),
                    )
                    .map_err(anyhow::Error::msg)?;
                    claim.attempt_id = Uuid::new_v4().to_string();
                    claim.expires_at_tick = now_tick
                        .checked_add(CLAIM_TTL_TICKS)
                        .context("claim expiry overflow")?;
                    claim.dependency_versions = self
                        .resource_clock_snapshot()
                        .dependencies(&next_authority.dependency_keys);
                    simulated.claim(offer_id, claim.clone())?;
                    let after_ticket = simulated
                        .ticket(&before_ticket.ticket_id)
                        .cloned()
                        .context("claimed ticket disappeared")?;
                    let mut after_change_set = before_change_set.clone();
                    after_change_set.state = ChangeSetState::Executing;
                    after_change_set.inferred_scope = Some(next_scope);
                    base.change_sets
                        .push((Some(before_change_set.clone()), Some(after_change_set)));
                    base.tickets
                        .push((Some(before_ticket.clone()), Some(after_ticket)));
                    base.claims.push((None, Some(claim.clone())));
                    (ClaimOutcome::Claimed(claim), base, simulated)
                }
                ScopeChange::Expanded
                    if matches!(
                        next_scope.dynamic_expansion_policy,
                        DynamicExpansionPolicy::Requeue { max_expansions }
                            if before_change_set.expansion_count < max_expansions
                    ) =>
                {
                    let after_ticket = simulated.requeue_with_scope(
                        offer_id,
                        next_scope.scope_fingerprint.clone(),
                        next_scope.reservation_keys.clone(),
                    )?;
                    let mut after_change_set = before_change_set.clone();
                    after_change_set.state = ChangeSetState::Queued;
                    after_change_set.inferred_scope = Some(next_scope);
                    after_change_set.expansion_count = after_change_set
                        .expansion_count
                        .checked_add(1)
                        .context("scope expansion count overflow")?;
                    let event = append_event(
                        &mut base,
                        CoordinationEventKind::ScopeExpanded,
                        &after_change_set.change_set_id,
                        graph.generation(),
                    )?;
                    base.change_sets
                        .push((Some(before_change_set.clone()), Some(after_change_set)));
                    base.tickets
                        .push((Some(before_ticket.clone()), Some(after_ticket.clone())));
                    let plan = plan_readiness(
                        self.semantic_provider()?,
                        PlannerSnapshot {
                            graph: graph.clone(),
                            scheduler: simulated,
                            scheduler_revision: expected_revision,
                            service_epoch,
                            now_tick,
                            cause: super::TransitionCause::ClaimRejection,
                            blocking_event_sequence: None,
                            deferred_change_set_ids: BTreeSet::from([offer.change_set_id.clone()]),
                        },
                        &durable,
                    )?;
                    (
                        ClaimOutcome::Requeued {
                            ticket: after_ticket,
                            event,
                        },
                        combine_release_and_readiness(base, plan.lifecycle_transition()?)?,
                        plan.next_scheduler,
                    )
                }
                ScopeChange::Expanded | ScopeChange::MateriallyChanged => {
                    simulated.cancel_ticket(&before_ticket.ticket_id)?;
                    let mut terminal_ticket = before_ticket.clone();
                    terminal_ticket.state = TicketState::NeedsDecision;
                    terminal_ticket.ready_offer_id = None;
                    terminal_ticket.active_claim_id = None;
                    let mut after_change_set = before_change_set.clone();
                    after_change_set.state = ChangeSetState::NeedsDecision;
                    after_change_set.inferred_scope = Some(next_scope);
                    let event = append_event(
                        &mut base,
                        CoordinationEventKind::IntentNeedsDecision,
                        &after_change_set.change_set_id,
                        graph.generation(),
                    )?;
                    base.change_sets.push((
                        Some(before_change_set.clone()),
                        Some(after_change_set.clone()),
                    ));
                    base.tickets
                        .push((Some(before_ticket.clone()), Some(terminal_ticket)));
                    let plan = plan_readiness(
                        self.semantic_provider()?,
                        PlannerSnapshot {
                            graph: graph.clone(),
                            scheduler: simulated,
                            scheduler_revision: expected_revision,
                            service_epoch,
                            now_tick,
                            cause: super::TransitionCause::ClaimRejection,
                            blocking_event_sequence: None,
                            deferred_change_set_ids: BTreeSet::new(),
                        },
                        &durable,
                    )?;
                    (
                        ClaimOutcome::NeedsDecision {
                            change_set: after_change_set,
                            event,
                        },
                        combine_release_and_readiness(base, plan.lifecycle_transition()?)?,
                        plan.next_scheduler,
                    )
                }
            };

            combined.expected_metadata.scheduler_revision = expected_revision;
            combined.next_metadata.scheduler_revision = expected_revision
                .checked_add(1)
                .context("scheduler revision overflow")?;
            final_scheduler.set_revision(combined.next_metadata.scheduler_revision);
            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if self.snapshot().generation() != graph.generation()
                || self.service_epoch() != service_epoch
                || scheduler.revision() != expected_revision
                || *scheduler != before_scheduler
                || durable.change_set(&offer.change_set_id)?.as_ref() != Some(&before_change_set)
            {
                continue;
            }
            durable.persist_lifecycle(&combined)?;
            *scheduler = final_scheduler;
            return Ok(outcome);
        }
        Err(anyhow::Error::new(
            super::CoordinationError::OptimisticRetryExhausted {
                attempts: super::MAX_OPTIMISTIC_RETRIES,
            },
        ))
    }

    pub fn reconsider_tickets(&self, now_tick: u64) -> Result<Vec<ReadyOffer>> {
        self.plan_and_apply_readiness(now_tick, super::TransitionCause::Reconsideration, None)
    }

    pub fn expire_ready_offers(&self, now_tick: u64) -> Result<Vec<String>> {
        let expired_offer_ids = {
            let scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            scheduler
                .offers()
                .filter(|offer| now_tick >= offer.expires_at_tick)
                .map(|offer| offer.offer_id.clone())
                .collect::<Vec<_>>()
        };
        self.expire_leases(now_tick)?;
        Ok(expired_offer_ids)
    }

    /// Expires every due coordination lease using a caller-supplied logical tick.
    ///
    /// The release is simulated first, semantic readiness is recomputed without a lock, and the
    /// complete expiry plus fresh offers is persisted as one optimistic lifecycle transition.
    pub fn expire_leases(&self, now_tick: u64) -> Result<Vec<LeaseExpiryOutcome>> {
        for _ in 0..super::MAX_OPTIMISTIC_RETRIES {
            let durable = self.store.coordination();
            let (
                graph,
                service_epoch,
                before_scheduler,
                expected_revision,
                metadata,
                change_sets,
                active_claims,
            ) = {
                let scheduler = self
                    .scheduler
                    .lock()
                    .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
                let expected_revision = scheduler.revision();
                let metadata = durable.metadata_state()?;
                if metadata.scheduler_revision != expected_revision {
                    continue;
                }
                (
                    self.snapshot(),
                    self.service_epoch(),
                    scheduler.clone(),
                    expected_revision,
                    metadata,
                    durable.all_change_sets()?,
                    durable.active_claims()?,
                )
            };
            let change_sets = change_sets
                .into_iter()
                .map(|change_set| (change_set.change_set_id.clone(), change_set))
                .collect::<BTreeMap<_, _>>();

            let mut next_scheduler = before_scheduler.clone();
            let mut base = transition(metadata)?;
            let mut outcomes = Vec::new();
            let mut deferred_change_set_ids = BTreeSet::new();

            for before in change_sets.values() {
                if before.state != ChangeSetState::Draft
                    || before
                        .expires_at_tick
                        .is_none_or(|expires_at| now_tick < expires_at)
                {
                    continue;
                }
                let mut after = before.clone();
                after.state = ChangeSetState::Cancelled;
                after.expires_at_tick = None;
                base.change_sets.push((Some(before.clone()), Some(after)));
                append_event_with_payload(
                    &mut base,
                    CoordinationEventKind::LeaseExpired,
                    &before.change_set_id,
                    graph.generation(),
                    serde_json::json!({
                        "authorityKind": "draft",
                        "reason": "draft-expired",
                    })
                    .to_string(),
                )?;
                outcomes.push(LeaseExpiryOutcome {
                    change_set_id: before.change_set_id.clone(),
                    authority_kind: "draft".into(),
                });
            }

            let due_offers = before_scheduler
                .offers()
                .filter(|offer| now_tick >= offer.expires_at_tick)
                .cloned()
                .collect::<Vec<_>>();
            for offer in due_offers {
                next_scheduler.expire_offer(&offer.offer_id)?;
                let before = change_sets
                    .get(&offer.change_set_id)
                    .cloned()
                    .with_context(|| format!("missing change set {}", offer.change_set_id))?;
                let mut after = before.clone();
                after.state = ChangeSetState::Queued;
                base.change_sets.push((Some(before), Some(after)));
                base.offers.push((Some(offer.clone()), None));
                append_event_with_payload(
                    &mut base,
                    CoordinationEventKind::LeaseExpired,
                    &offer.change_set_id,
                    graph.generation(),
                    serde_json::json!({
                        "authorityKind": "offer",
                        "reason": "offer-expired",
                    })
                    .to_string(),
                )?;
                outcomes.push(LeaseExpiryOutcome {
                    change_set_id: offer.change_set_id,
                    authority_kind: "offer".into(),
                });
            }

            let due_claims = active_claims
                .into_iter()
                .filter(|claim| now_tick >= claim.expires_at_tick)
                .collect::<Vec<_>>();
            for claim in due_claims {
                next_scheduler.release(&claim.claim_id, TicketState::Queued)?;
                let before = change_sets
                    .get(&claim.change_set_id)
                    .cloned()
                    .with_context(|| format!("missing change set {}", claim.change_set_id))?;
                let mut after = before.clone();
                after.state = ChangeSetState::Queued;
                base.change_sets.push((Some(before), Some(after)));
                base.claims.push((Some(claim.clone()), None));
                append_event_with_payload(
                    &mut base,
                    CoordinationEventKind::LeaseExpired,
                    &claim.change_set_id,
                    graph.generation(),
                    serde_json::json!({
                        "authorityKind": "claim",
                        "reason": "claim-expired",
                        "attemptId": claim.attempt_id,
                    })
                    .to_string(),
                )?;
                deferred_change_set_ids.insert(claim.change_set_id.clone());
                outcomes.push(LeaseExpiryOutcome {
                    change_set_id: claim.change_set_id,
                    authority_kind: "claim".into(),
                });
            }

            if outcomes.is_empty() {
                return Ok(Vec::new());
            }
            base.tickets = scheduler_ticket_updates(&before_scheduler, &next_scheduler);
            let has_claim_expiry = outcomes
                .iter()
                .any(|outcome| outcome.authority_kind == "claim");
            let has_offer_expiry = outcomes
                .iter()
                .any(|outcome| outcome.authority_kind == "offer");
            let (mut combined, mut final_scheduler) = if has_claim_expiry || has_offer_expiry {
                let cause = if has_claim_expiry {
                    super::TransitionCause::ClaimExpiry
                } else {
                    super::TransitionCause::OfferExpiry
                };
                let plan = plan_readiness(
                    self.semantic_provider()?,
                    PlannerSnapshot {
                        graph: graph.clone(),
                        scheduler: next_scheduler,
                        scheduler_revision: expected_revision,
                        service_epoch,
                        now_tick,
                        cause,
                        blocking_event_sequence: None,
                        deferred_change_set_ids,
                    },
                    &durable,
                )?;
                (
                    combine_release_and_readiness(base, plan.lifecycle_transition()?)?,
                    plan.next_scheduler,
                )
            } else {
                (base, next_scheduler)
            };
            final_scheduler.set_revision(combined.next_metadata.scheduler_revision);

            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if self.snapshot().generation() != graph.generation()
                || self.service_epoch() != service_epoch
                || scheduler.revision() != expected_revision
                || *scheduler != before_scheduler
            {
                continue;
            }
            combined.expected_metadata.scheduler_revision = expected_revision;
            combined.next_metadata.scheduler_revision = expected_revision
                .checked_add(1)
                .context("scheduler revision overflow")?;
            final_scheduler.set_revision(combined.next_metadata.scheduler_revision);
            durable.persist_lifecycle(&combined)?;
            *scheduler = final_scheduler;
            return Ok(outcomes);
        }
        Err(anyhow::Error::new(
            super::CoordinationError::OptimisticRetryExhausted {
                attempts: super::MAX_OPTIMISTIC_RETRIES,
            },
        ))
    }

    pub(crate) fn plan_and_apply_readiness(
        &self,
        now_tick: u64,
        cause: super::TransitionCause,
        blocking_event_sequence: Option<u64>,
    ) -> Result<Vec<ReadyOffer>> {
        for _ in 0..super::MAX_OPTIMISTIC_RETRIES {
            let snapshot =
                self.capture_planner_snapshot(now_tick, cause, blocking_event_sequence)?;
            let plan = plan_readiness(
                self.semantic_provider()?,
                snapshot,
                &self.store.coordination(),
            )?;
            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if self.snapshot().generation() != plan.expected_graph_generation
                || scheduler.revision() != plan.expected_scheduler_revision
            {
                continue;
            }
            let offers = plan
                .offers
                .iter()
                .map(|planned| {
                    debug_assert_eq!(
                        planned.ticket_before.change_set_id,
                        planned.change_set_before.change_set_id
                    );
                    debug_assert_eq!(
                        planned.ticket_after.change_set_id,
                        planned.change_set_after.change_set_id
                    );
                    planned.offer.clone()
                })
                .collect::<Vec<_>>();
            debug_assert!(
                plan.requeued
                    .iter()
                    .all(|(_, after)| after.state == ChangeSetState::Queued)
            );
            debug_assert!(
                plan.needs_decision
                    .iter()
                    .all(|(_, after)| after.state == ChangeSetState::NeedsDecision)
            );
            if plan.has_lifecycle_changes() {
                self.store
                    .coordination()
                    .persist_lifecycle(&plan.lifecycle_transition()?)?;
                *scheduler = plan.next_scheduler;
            }
            return Ok(offers);
        }
        Err(anyhow::Error::new(
            super::CoordinationError::OptimisticRetryExhausted {
                attempts: super::MAX_OPTIMISTIC_RETRIES,
            },
        ))
    }

    fn capture_planner_snapshot(
        &self,
        now_tick: u64,
        cause: super::TransitionCause,
        blocking_event_sequence: Option<u64>,
    ) -> Result<PlannerSnapshot> {
        let scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        Ok(PlannerSnapshot {
            graph: self.snapshot(),
            scheduler: scheduler.clone(),
            scheduler_revision: scheduler.revision(),
            service_epoch: self.service_epoch(),
            now_tick,
            cause,
            blocking_event_sequence,
            deferred_change_set_ids: BTreeSet::new(),
        })
    }

    pub fn cancel_change_set(
        &self,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<CancellationOutcome> {
        for _ in 0..super::MAX_OPTIMISTIC_RETRIES {
            let durable = self.store.coordination();
            let (
                graph,
                service_epoch,
                before_scheduler,
                expected_revision,
                metadata,
                before_change_set,
                active_claims,
            ) = {
                let scheduler = self
                    .scheduler
                    .lock()
                    .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
                let expected_revision = scheduler.revision();
                let metadata = durable.metadata_state()?;
                if metadata.scheduler_revision != expected_revision {
                    continue;
                }
                (
                    self.snapshot(),
                    self.service_epoch(),
                    scheduler.clone(),
                    expected_revision,
                    metadata,
                    durable
                        .change_set(change_set_id)?
                        .with_context(|| format!("change set {change_set_id} does not exist"))?,
                    durable.active_claims()?,
                )
            };
            if matches!(
                before_change_set.state,
                ChangeSetState::Committed
                    | ChangeSetState::NeedsDecision
                    | ChangeSetState::Cancelled
                    | ChangeSetState::Failed
            ) {
                return Ok(CancellationOutcome {
                    change_set: before_change_set,
                    ready_offers: Vec::new(),
                });
            }
            let mut base = transition(metadata)?;
            let mut after_change_set = before_change_set.clone();
            after_change_set.state = ChangeSetState::Cancelled;
            after_change_set.expires_at_tick = None;
            base.change_sets.push((
                Some(before_change_set.clone()),
                Some(after_change_set.clone()),
            ));
            append_event(
                &mut base,
                CoordinationEventKind::IntentCancelled,
                change_set_id,
                graph.generation(),
            )?;

            let mut simulated = before_scheduler.clone();
            if let Some(before_ticket) = before_scheduler
                .tickets()
                .find(|ticket| ticket.change_set_id == change_set_id)
                .cloned()
            {
                if let Some(offer_id) = &before_ticket.ready_offer_id {
                    let offer = before_scheduler
                        .offer(offer_id)
                        .cloned()
                        .with_context(|| format!("missing ready offer {offer_id}"))?;
                    base.offers.push((Some(offer), None));
                }
                if let Some(claim_id) = &before_ticket.active_claim_id {
                    let claim = active_claims
                        .into_iter()
                        .find(|claim| claim.claim_id == *claim_id)
                        .with_context(|| format!("missing active claim {claim_id}"))?;
                    base.claims.push((Some(claim), None));
                }
                simulated.cancel_ticket(&before_ticket.ticket_id)?;
                let mut terminal_ticket = before_ticket.clone();
                terminal_ticket.state = TicketState::Cancelled;
                terminal_ticket.ready_offer_id = None;
                terminal_ticket.active_claim_id = None;
                base.tickets
                    .push((Some(before_ticket), Some(terminal_ticket)));
            }
            base.tickets.extend(
                scheduler_ticket_updates(&before_scheduler, &simulated)
                    .into_iter()
                    .filter(|(before, after)| {
                        before
                            .as_ref()
                            .or(after.as_ref())
                            .is_some_and(|ticket| ticket.change_set_id != change_set_id)
                    }),
            );

            let (mut combined, mut final_scheduler, ready_offers) = if simulated
                .tickets()
                .any(|ticket| ticket.state == TicketState::Queued)
            {
                let plan = plan_readiness(
                    self.semantic_provider()?,
                    PlannerSnapshot {
                        graph: graph.clone(),
                        scheduler: simulated,
                        scheduler_revision: expected_revision,
                        service_epoch,
                        now_tick,
                        cause: super::TransitionCause::Cancellation,
                        blocking_event_sequence: None,
                        deferred_change_set_ids: BTreeSet::new(),
                    },
                    &durable,
                )?;
                let offers = plan
                    .offers
                    .iter()
                    .map(|planned| planned.offer.clone())
                    .collect();
                (
                    combine_release_and_readiness(base, plan.lifecycle_transition()?)?,
                    plan.next_scheduler,
                    offers,
                )
            } else {
                (base, simulated, Vec::new())
            };

            combined.expected_metadata.scheduler_revision = expected_revision;
            combined.next_metadata.scheduler_revision = expected_revision
                .checked_add(1)
                .context("scheduler revision overflow")?;
            final_scheduler.set_revision(combined.next_metadata.scheduler_revision);
            let mut scheduler = self
                .scheduler
                .lock()
                .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
            if self.snapshot().generation() != graph.generation()
                || self.service_epoch() != service_epoch
                || scheduler.revision() != expected_revision
                || *scheduler != before_scheduler
                || durable.change_set(change_set_id)?.as_ref() != Some(&before_change_set)
            {
                continue;
            }
            durable.persist_lifecycle(&combined)?;
            *scheduler = final_scheduler;
            return Ok(CancellationOutcome {
                change_set: after_change_set,
                ready_offers,
            });
        }
        Err(anyhow::Error::new(
            super::CoordinationError::OptimisticRetryExhausted {
                attempts: super::MAX_OPTIMISTIC_RETRIES,
            },
        ))
    }
}
/// The graph-level idempotency key a committed change set's publication is
/// recorded under. `pub(crate)` (not `pub(super)`) because the atomic-state
/// projection (`Kernel::test_atomic_state_projection`, `redb-spike-api`) reads
/// it from `kernel.rs` at the crate root to recover idempotency generations
/// for every change set it discovers, alongside its normal use inside this
/// module's commit path.
pub(crate) fn coordination_commit_key(change_set_id: &str) -> String {
    format!("coordination-commit:{change_set_id}")
}

pub(super) fn affected_node_ids(delta: &crate::GraphDelta) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for change in &delta.changes {
        match change {
            GraphChange::UpsertNode { node } => {
                ids.insert(node.id.clone());
            }
            GraphChange::DeleteNode { node_id } => {
                ids.insert(node_id.clone());
            }
            GraphChange::UpsertReference { reference } => {
                ids.insert(reference.from_node_id.clone());
                ids.insert(reference.to_node_id.clone());
            }
            GraphChange::DeleteReference { from_node_id } => {
                ids.insert(from_node_id.clone());
            }
        }
    }
    ids.into_iter().collect()
}

pub(super) fn intent_kind(intent: &IntentRecord) -> &'static str {
    match intent.parameters {
        IntentParameters::RenameSymbol { .. } => "RenameSymbol",
        IntentParameters::AddParameter { .. } => "AddParameter",
    }
}

/// Record each rename intent's name transition against the pre-publication
/// graph. Analysis already proved every rename target is a supported named
/// declaration, so extraction failure here is graph corruption and fails the
/// publication closed.
pub(super) fn operation_renames(
    graph: &crate::GraphGeneration,
    intents: &[IntentRecord],
) -> Result<Vec<crate::OperationRename>> {
    let mut renames = Vec::new();
    for intent in intents {
        let IntentParameters::RenameSymbol {
            declaration_id,
            new_name,
        } = &intent.parameters
        else {
            continue;
        };
        let declaration = graph.node(declaration_id).with_context(|| {
            format!("rename target {declaration_id} disappeared before publication")
        })?;
        let from_name = crate::bridge::declaration_name(graph, declaration)?
            .with_context(|| format!("rename target {declaration_id} has no declaration name"))?;
        renames.push(crate::OperationRename {
            node_id: declaration_id.clone(),
            from_name,
            to_name: new_name.clone(),
        });
    }
    Ok(renames)
}

/// The maximum renamed-symbol entries a fresh-decision report carries; this
/// matches the local-service protocol's array bound.
pub const MAX_RENAMED_SYMBOLS: usize = 256;

/// Fold the rename transitions recorded by a sequence of operations
/// (ascending generation order) into per-declaration net transitions.
/// Renames that return to their starting name are dropped; output is
/// deterministic (ordered by node ID) and bounded.
pub fn fold_operation_renames<'a>(
    operations: impl Iterator<Item = &'a OperationRecord>,
) -> Vec<crate::OperationRename> {
    let mut chains: BTreeMap<&str, (&str, &str)> = BTreeMap::new();
    for operation in operations {
        for rename in &operation.renames {
            chains
                .entry(rename.node_id.as_str())
                .and_modify(|(_, current)| *current = rename.to_name.as_str())
                .or_insert((rename.from_name.as_str(), rename.to_name.as_str()));
        }
    }
    chains
        .into_iter()
        .filter(|(_, (from, to))| from != to)
        .take(MAX_RENAMED_SYMBOLS)
        .map(|(node_id, (from, to))| crate::OperationRename {
            node_id: node_id.to_owned(),
            from_name: from.to_owned(),
            to_name: to.to_owned(),
        })
        .collect()
}

pub(super) fn bounded_wake_payload(
    operation_field: &str,
    operation_id: &str,
    before_generation: u64,
    after_generation: u64,
    affected_node_ids: &[String],
) -> String {
    let shown = affected_node_ids
        .iter()
        .take(MAX_WAKE_AFFECTED_NODE_IDS)
        .cloned()
        .collect::<Vec<_>>();
    let mut payload = serde_json::json!({
        "beforeGeneration": before_generation,
        "afterGeneration": after_generation,
        "affectedNodeIds": shown,
        "totalAffectedNodeCount": affected_node_ids.len(),
        "affectedNodeIdsTruncated": affected_node_ids.len() > MAX_WAKE_AFFECTED_NODE_IDS,
    });
    payload
        .as_object_mut()
        .expect("wake payload is an object")
        .insert(operation_field.into(), operation_id.into());
    payload.to_string()
}

pub(super) fn bounded_wake_payload_with_scope(
    operation_field: &str,
    operation_id: &str,
    before_generation: u64,
    after_generation: u64,
    affected_node_ids: &[String],
    scope_fingerprint: &str,
) -> String {
    let mut payload: serde_json::Value = serde_json::from_str(&bounded_wake_payload(
        operation_field,
        operation_id,
        before_generation,
        after_generation,
        affected_node_ids,
    ))
    .expect("kernel-generated wake payload is valid JSON");
    payload
        .as_object_mut()
        .expect("wake payload is an object")
        .insert("scopeFingerprint".into(), scope_fingerprint.into());
    payload.to_string()
}

pub(super) fn append_event_with_payload(
    transition: &mut LifecycleTransition,
    kind: CoordinationEventKind,
    change_set_id: &str,
    graph_generation: u64,
    payload_json: String,
) -> Result<CoordinationEvent> {
    let event = append_event(transition, kind, change_set_id, graph_generation)?;
    transition
        .events
        .last_mut()
        .expect("event was appended")
        .payload_json = payload_json.clone();
    Ok(CoordinationEvent {
        payload_json,
        ..event
    })
}

fn validate_offer_context(
    offer: &ReadyOffer,
    current_service_epoch: u64,
    now_tick: u64,
) -> Result<()> {
    if offer.service_epoch != current_service_epoch {
        bail!(
            "ready offer {} belongs to a stale service epoch",
            offer.offer_id
        );
    }
    if now_tick >= offer.expires_at_tick {
        bail!(
            "ready offer {} expired at tick {}",
            offer.offer_id,
            offer.expires_at_tick
        );
    }
    Ok(())
}

pub(super) fn combine_release_and_readiness(
    mut release: LifecycleTransition,
    readiness: LifecycleTransition,
) -> Result<LifecycleTransition> {
    if release.expected_metadata != readiness.expected_metadata {
        bail!("release and readiness plans were captured from different metadata");
    }

    for update in readiness.change_sets {
        let id = update
            .0
            .as_ref()
            .or(update.1.as_ref())
            .context("readiness change-set update has no record")?
            .change_set_id
            .clone();
        if let Some(existing) = release.change_sets.iter_mut().find(|existing| {
            existing
                .0
                .as_ref()
                .or(existing.1.as_ref())
                .is_some_and(|record| record.change_set_id == id)
        }) {
            existing.1 = update.1;
        } else {
            release.change_sets.push(update);
        }
    }
    for update in readiness.tickets {
        let id = update
            .0
            .as_ref()
            .or(update.1.as_ref())
            .context("readiness ticket update has no record")?
            .ticket_id
            .clone();
        if let Some(existing) = release.tickets.iter_mut().find(|existing| {
            existing
                .0
                .as_ref()
                .or(existing.1.as_ref())
                .is_some_and(|record| record.ticket_id == id)
        }) {
            existing.1 = update.1;
        } else {
            release.tickets.push(update);
        }
    }
    release.offers.extend(readiness.offers);
    release.claims.extend(readiness.claims);

    for mut event in readiness.events {
        let sequence = release
            .next_metadata
            .current_event_sequence
            .checked_add(1)
            .context("coordination event sequence overflow")?;
        event.sequence = sequence;
        release.next_metadata.current_event_sequence = sequence;
        release.events.push(event);
    }
    release.next_metadata.next_queue_sequence = readiness.next_metadata.next_queue_sequence;
    release.next_metadata.scheduler_revision = release
        .expected_metadata
        .scheduler_revision
        .checked_add(1)
        .context("scheduler revision overflow")?;
    Ok(release)
}

pub(super) fn transition(metadata: CoordinationMetadataState) -> Result<LifecycleTransition> {
    let mut next_metadata = metadata;
    next_metadata.scheduler_revision = metadata
        .scheduler_revision
        .checked_add(1)
        .context("scheduler revision overflow")?;
    Ok(LifecycleTransition {
        change_sets: Vec::new(),
        tickets: Vec::new(),
        offers: Vec::new(),
        claims: Vec::new(),
        events: Vec::new(),
        expected_metadata: metadata,
        next_metadata,
    })
}

pub(super) fn append_event(
    transition: &mut LifecycleTransition,
    kind: CoordinationEventKind,
    change_set_id: &str,
    graph_generation: u64,
) -> Result<CoordinationEvent> {
    let sequence = transition
        .next_metadata
        .current_event_sequence
        .checked_add(1)
        .context("coordination event sequence overflow")?;
    let event = CoordinationEvent::new(
        SCHEMA_VERSION,
        Uuid::new_v4().to_string(),
        sequence,
        kind,
        change_set_id,
        graph_generation,
        "{}",
    )
    .map_err(anyhow::Error::msg)?;
    transition.next_metadata.current_event_sequence = sequence;
    transition.events.push(event.clone());
    Ok(event)
}

pub(super) fn scheduler_ticket_updates(
    before: &SchedulerState,
    after: &SchedulerState,
) -> Vec<(Option<CoordinationTicket>, Option<CoordinationTicket>)> {
    let before = before
        .tickets()
        .map(|ticket| (ticket.ticket_id.clone(), ticket.clone()))
        .collect::<BTreeMap<_, _>>();
    let after = after
        .tickets()
        .map(|ticket| (ticket.ticket_id.clone(), ticket.clone()))
        .collect::<BTreeMap<_, _>>();
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|id| {
            let old = before.get(id).cloned();
            let new = after.get(id).cloned();
            (old != new).then_some((old, new))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::planner::make_offer;

    #[test]
    fn offer_context_rejects_a_stale_service_epoch_directly() {
        let ticket = CoordinationTicket::new(
            SCHEMA_VERSION,
            "ticket",
            "change-set",
            TicketState::Queued,
            "scope",
            vec!["symbol:target".to_owned()],
            1,
        )
        .unwrap();
        let offer = make_offer(&ticket, 7, 3, 0).unwrap();

        let error = validate_offer_context(&offer, 8, 10).unwrap_err();
        assert!(error.to_string().contains("stale service epoch"));
    }
}
