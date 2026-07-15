use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "coordination-test-api")]
use std::sync::Arc;
#[cfg(feature = "coordination-test-api")]
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::analyzer::analyze_change_set;
use super::authority::plan_change_set;
use super::durable::{CoordinationMetadataState, LifecycleTransition};
use super::planner::{PlannerSnapshot, plan_readiness};
#[cfg(feature = "coordination-test-api")]
use super::resource_keys;
#[cfg(feature = "coordination-test-api")]
use super::{
    CandidateBuilder, CandidateEnvelope, PreparedCandidate, PublicationAttemptRecord,
    PublishClaimOutcome,
};
use super::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, CreateDraftOutcome, DynamicExpansionPolicy,
    EventCursor, IntentParameters, IntentRecord, LeaseExpiryOutcome, ReadyOffer, SchedulerState,
    ScopeChange, SubmissionOutcome, TicketState, classify_scope_change,
};
#[cfg(feature = "coordination-test-api")]
use crate::model::{FenceClaim, Publication};
#[cfg(feature = "coordination-test-api")]
use crate::storage::{CoordinatedCommit, CoordinatedPublishFailpoint, PublishOutcome};
#[cfg(feature = "coordination-test-api")]
use crate::{EventRecord, GraphChange, PublicationReport, TicketRecord};
use crate::{Kernel, OperationRecord, SCHEMA_VERSION};

pub const READY_OFFER_TTL_TICKS: u64 = 30;
pub const DRAFT_TTL_TICKS: u64 = 120;
pub const CLAIM_TTL_TICKS: u64 = 60;
pub const MAX_WAKE_AFFECTED_NODE_IDS: usize = 64;

#[cfg(feature = "coordination-test-api")]
enum CandidateSource<'a> {
    Builder(&'a dyn CandidateBuilder),
    Envelope(CandidateEnvelope),
}

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
                ScopeChange::Unchanged => {
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

    #[cfg(feature = "coordination-test-api")]
    pub fn publish_claimed(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
    ) -> Result<PublicationReport> {
        self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            CoordinatedPublishFailpoint::None,
            None,
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
        Ok(PublishClaimOutcome::Published(self.publish_claimed_inner(
            claim,
            CandidateSource::Envelope(envelope),
            now_tick,
            CoordinatedPublishFailpoint::None,
            None,
        )?))
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
        self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            failpoint,
            None,
        )
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
        self.publish_claimed_inner(
            claim,
            CandidateSource::Builder(candidate_builder),
            now_tick,
            CoordinatedPublishFailpoint::None,
            Some(after_outer_idempotency_lookup),
        )
    }

    #[cfg(feature = "coordination-test-api")]
    fn publish_claimed_inner(
        &self,
        claim: &ClaimHandle,
        candidate_source: CandidateSource<'_>,
        now_tick: u64,
        failpoint: CoordinatedPublishFailpoint,
        after_outer_idempotency_lookup: Option<&dyn Fn()>,
    ) -> Result<PublicationReport> {
        let idempotency_key = coordination_commit_key(&claim.change_set_id);
        if let Some(report) = self.committed_candidate_report(claim, &candidate_source)? {
            return Ok(report);
        }
        if let Some(hook) = after_outer_idempotency_lookup {
            hook();
        }

        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let _publish = self
            .publish_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("publication lock is poisoned"))?;
        if let Some(report) = self.committed_candidate_report(claim, &candidate_source)? {
            return Ok(report);
        }

        let semantic_provider = self.semantic_provider()?;
        let graph = self.snapshot();
        self.validate_executing_claim(&scheduler, claim, graph.generation(), now_tick)?;
        let durable = self.store.coordination();
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
        let fresh_scope = analyze_change_set(&graph, &intents, semantic_provider)?;
        let scope_change = classify_scope_change(previous_scope, &fresh_scope);
        if scope_change != ScopeChange::Unchanged {
            drop(_publish);
            drop(scheduler);
            self.persist_changed_publication_scope(claim, fresh_scope, scope_change, now_tick)?;
            bail!("publication scope changed before candidate construction");
        }

        let envelope = match candidate_source {
            CandidateSource::Builder(candidate_builder) => {
                let prepared = PreparedCandidate {
                    change_set: before_change_set.clone(),
                    intents: intents.clone(),
                    graph: graph.clone(),
                    attempt_id: claim.attempt_id.clone(),
                    scope_fingerprint: fresh_scope.scope_fingerprint.clone(),
                };
                candidate_builder.build_candidate(&prepared)?
            }
            CandidateSource::Envelope(envelope) => envelope,
        };
        envelope.validate_digest()?;
        let candidate_digest = envelope.candidate_digest.clone();
        let delta = envelope.delta;
        if delta.schema_version != SCHEMA_VERSION {
            bail!(
                "candidate delta has unsupported schema version {}",
                delta.schema_version
            );
        }
        if delta.base_generation != graph.generation() {
            bail!(
                "candidate delta base generation {} does not match current generation {}",
                delta.base_generation,
                graph.generation()
            );
        }
        super::validate_delta_containment(&graph, &delta, &fresh_scope)
            .context("candidate delta is outside inferred scope")?;
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

        let before_scheduler = scheduler.clone();
        let mut next_scheduler = scheduler.clone();
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

        let publication = Publication {
            schema_version: SCHEMA_VERSION,
            idempotency_key,
            delta,
            operation: OperationRecord {
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
            },
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
        let commit = CoordinatedCommit {
            publication,
            lifecycle,
            service_epoch: self.service_epoch(),
            reservation_keys: fresh_scope.reservation_keys,
            resource_clock_updates,
            publication_attempt: PublicationAttemptRecord {
                change_set_id: claim.change_set_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                candidate_digest,
                generation: next_generation,
                graph_digest: next.digest().to_owned(),
            },
        };
        let persistence_started = Instant::now();
        let outcome = self
            .store
            .publish_coordinated(&commit, next.digest(), failpoint)?;
        let persistence_ns = persistence_started.elapsed().as_nanos();
        match outcome {
            PublishOutcome::AlreadyPublished { generation } => {
                let digest = self.store.generation_digest(generation)?;
                Ok(PublicationReport {
                    generation,
                    digest,
                    persistence_ns,
                    memory_publish_ns: 0,
                    already_published: true,
                })
            }
            PublishOutcome::Published { generation } => {
                if generation != next_generation {
                    bail!("durable generation does not match prepared generation");
                }
                let memory_started = Instant::now();
                *self
                    .live
                    .write()
                    .map_err(|_| anyhow::anyhow!("live generation lock is poisoned"))? =
                    next.clone();
                *self
                    .resource_clocks
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = next_resource_clocks;
                let memory_publish_ns = memory_started.elapsed().as_nanos();
                *scheduler = next_scheduler;
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
                let graph = Arc::new(self.store.graph_generation(claim.graph_generation)?);
                let durable = self.store.coordination();
                let mut change_set =
                    durable.change_set(&claim.change_set_id)?.with_context(|| {
                        format!("change set {} does not exist", claim.change_set_id)
                    })?;
                change_set.state = ChangeSetState::Executing;
                change_set.committed_generation = None;
                let prepared = PreparedCandidate {
                    change_set,
                    intents: durable.intents_for(&claim.change_set_id)?,
                    graph,
                    attempt_id: claim.attempt_id.clone(),
                    scope_fingerprint: claim.scope_fingerprint.clone(),
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
        graph_generation: u64,
        now_tick: u64,
    ) -> Result<()> {
        if claim.service_epoch != self.service_epoch()
            || claim.expires_at_tick == 0
            || now_tick >= claim.expires_at_tick
        {
            return Err(anyhow::Error::new(super::CoordinationError::LeaseExpired));
        }
        if claim.graph_generation != graph_generation {
            bail!("claim belongs to a stale graph generation");
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
            self.validate_executing_claim(&before_scheduler, claim, graph.generation(), now_tick)?;
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

#[cfg(feature = "coordination-test-api")]
fn coordination_commit_key(change_set_id: &str) -> String {
    format!("coordination-commit:{change_set_id}")
}

#[cfg(feature = "coordination-test-api")]
fn affected_node_ids(delta: &crate::GraphDelta) -> Vec<String> {
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

#[cfg(feature = "coordination-test-api")]
fn intent_kind(intent: &IntentRecord) -> &'static str {
    match intent.parameters {
        IntentParameters::RenameSymbol { .. } => "RenameSymbol",
        IntentParameters::AddParameter { .. } => "AddParameter",
    }
}

#[cfg(feature = "coordination-test-api")]
fn bounded_wake_payload(
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

#[cfg(feature = "coordination-test-api")]
fn bounded_wake_payload_with_scope(
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

fn append_event_with_payload(
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

fn combine_release_and_readiness(
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
