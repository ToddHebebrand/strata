use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::analyzer::analyze_change_set;
use super::durable::{CoordinationMetadataState, LifecycleTransition};
use super::{
    CandidateBuilder, ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome,
    CoordinationEvent, CoordinationEventKind, CoordinationTicket, CreateDraftOutcome,
    DynamicExpansionPolicy, EventCursor, IntentParameters, IntentRecord, ReadyOffer,
    SchedulerState, ScopeChange, SubmissionOutcome, TicketState, classify_scope_change,
};
use crate::model::{FenceClaim, Publication};
use crate::storage::{CoordinatedCommit, CoordinatedPublishFailpoint, PublishOutcome};
use crate::{
    EventRecord, GraphChange, Kernel, OperationRecord, PublicationReport, SCHEMA_VERSION,
    TicketRecord,
};

pub const READY_OFFER_TTL_TICKS: u64 = 30;
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

    pub fn begin_change_set(&self, input: BeginChangeSet) -> Result<ChangeSetRecord> {
        let _scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let record = ChangeSetRecord::new(
            SCHEMA_VERSION,
            input.change_set_id,
            input.actor,
            input.reasoning,
            self.snapshot().generation(),
            input.submission_idempotency_key,
            &[],
        )
        .map_err(anyhow::Error::msg)?;
        match self.store.coordination().create_draft(&record)? {
            CreateDraftOutcome::Created { change_set }
            | CreateDraftOutcome::Duplicate { change_set } => Ok(change_set),
        }
    }

    pub fn add_intent(
        &self,
        change_set_id: &str,
        parameters: IntentParameters,
    ) -> Result<IntentRecord> {
        let _scheduler = self
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
        Ok(intent)
    }

    pub fn submit_change_set(
        &self,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<SubmissionOutcome> {
        let semantic_provider = self.semantic_provider()?;
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let durable = self.store.coordination();
        let draft = durable
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if draft.state != ChangeSetState::Draft {
            return Ok(SubmissionOutcome::Duplicate { change_set: draft });
        }
        let graph = self.snapshot();
        let intents = durable.intents_for(change_set_id)?;
        let scope = analyze_change_set(&graph, &intents, semantic_provider)?;
        let metadata = durable.metadata_state()?;
        let queue_sequence = metadata.next_queue_sequence;
        let next_queue_sequence = queue_sequence
            .checked_add(1)
            .context("coordination queue sequence overflow")?;

        let mut queued_change_set = draft.clone();
        queued_change_set.state = ChangeSetState::Queued;
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
        let selected = next_scheduler.select_ready()?;
        let mut offers = Vec::new();
        for ticket_id in &selected {
            let ticket = next_scheduler
                .ticket(ticket_id)
                .cloned()
                .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
            let offer = make_offer(&ticket, self.service_epoch(), graph.generation(), now_tick)?;
            next_scheduler.mark_ready(ticket_id, offer.clone())?;
            offers.push(offer);
        }

        let mut transition = transition(metadata);
        transition.next_metadata.next_queue_sequence = next_queue_sequence;
        let queued_event = append_event(
            &mut transition,
            CoordinationEventKind::IntentQueued,
            change_set_id,
            graph.generation(),
        )?;
        debug_assert_eq!(queued_event.kind, CoordinationEventKind::IntentQueued);

        let mut change_set_updates = BTreeMap::new();
        change_set_updates.insert(
            change_set_id.to_owned(),
            (draft.clone(), queued_change_set.clone()),
        );
        for offer in &offers {
            let (before, mut after) = if offer.change_set_id == change_set_id {
                (draft.clone(), queued_change_set.clone())
            } else {
                let before = durable
                    .change_set(&offer.change_set_id)?
                    .with_context(|| format!("missing change set {}", offer.change_set_id))?;
                (before.clone(), before)
            };
            after.state = ChangeSetState::Ready;
            change_set_updates.insert(offer.change_set_id.clone(), (before, after));
            append_event(
                &mut transition,
                CoordinationEventKind::IntentReady,
                &offer.change_set_id,
                graph.generation(),
            )?;
            transition.offers.push((None, Some(offer.clone())));
        }
        transition.change_sets = change_set_updates
            .into_values()
            .map(|(before, after)| (Some(before), Some(after)))
            .collect();
        transition.tickets = scheduler_ticket_updates(&before_scheduler, &next_scheduler);

        durable.persist_lifecycle(&transition)?;
        *scheduler = next_scheduler;

        let ticket = scheduler
            .tickets()
            .find(|ticket| ticket.change_set_id == change_set_id)
            .cloned()
            .context("submitted ticket missing after durable transition")?;
        if let Some(offer) = offers
            .into_iter()
            .find(|offer| offer.change_set_id == change_set_id)
        {
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
        let semantic_provider = self.semantic_provider()?;
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let offer = scheduler
            .offer(offer_id)
            .cloned()
            .with_context(|| format!("ready offer {offer_id} does not exist"))?;
        if offer.claim_token != claim_token {
            bail!("ready offer {offer_id} claim token does not match");
        }
        validate_offer_context(&offer, self.service_epoch(), now_tick)?;

        let graph = self.snapshot();
        let durable = self.store.coordination();
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
        let next_scope = analyze_change_set(&graph, &intents, semantic_provider)?;
        let scope_change = classify_scope_change(before_scope, &next_scope);
        let before_ticket = scheduler
            .ticket_for_offer(offer_id)
            .cloned()
            .with_context(|| format!("ready offer {offer_id} has no ticket"))?;
        let metadata = durable.metadata_state()?;
        let mut transition = transition(metadata);
        transition.offers.push((Some(offer.clone()), None));
        let mut next_scheduler = scheduler.clone();

        let outcome = match scope_change {
            ScopeChange::Unchanged => {
                let claim = ClaimHandle::new(
                    Uuid::new_v4().to_string(),
                    offer.change_set_id.clone(),
                    offer.offer_id.clone(),
                    self.service_epoch(),
                    graph.generation(),
                    next_scope.scope_fingerprint.clone(),
                    next_scope.reservation_keys.clone(),
                )
                .map_err(anyhow::Error::msg)?;
                next_scheduler.claim(offer_id, claim.clone())?;
                let after_ticket = next_scheduler
                    .ticket(&before_ticket.ticket_id)
                    .cloned()
                    .context("claimed ticket disappeared")?;
                let mut after_change_set = before_change_set.clone();
                after_change_set.state = ChangeSetState::Executing;
                after_change_set.inferred_scope = Some(next_scope);
                transition
                    .change_sets
                    .push((Some(before_change_set), Some(after_change_set)));
                transition
                    .tickets
                    .push((Some(before_ticket), Some(after_ticket)));
                transition.claims.push((None, Some(claim.clone())));
                ClaimOutcome::Claimed(claim)
            }
            ScopeChange::Expanded
                if matches!(
                    next_scope.dynamic_expansion_policy,
                    DynamicExpansionPolicy::Requeue { max_expansions }
                        if before_change_set.expansion_count < max_expansions
                ) =>
            {
                let after_ticket = next_scheduler.requeue_with_scope(
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
                    &mut transition,
                    CoordinationEventKind::ScopeExpanded,
                    &after_change_set.change_set_id,
                    graph.generation(),
                )?;
                transition
                    .change_sets
                    .push((Some(before_change_set), Some(after_change_set)));
                transition
                    .tickets
                    .push((Some(before_ticket), Some(after_ticket.clone())));
                ClaimOutcome::Requeued {
                    ticket: after_ticket,
                    event,
                }
            }
            ScopeChange::Expanded | ScopeChange::MateriallyChanged => {
                next_scheduler.cancel_ticket(&before_ticket.ticket_id)?;
                let mut terminal_ticket = before_ticket.clone();
                terminal_ticket.state = TicketState::NeedsDecision;
                terminal_ticket.ready_offer_id = None;
                terminal_ticket.active_claim_id = None;
                let mut after_change_set = before_change_set.clone();
                after_change_set.state = ChangeSetState::NeedsDecision;
                after_change_set.inferred_scope = Some(next_scope);
                let event = append_event(
                    &mut transition,
                    CoordinationEventKind::IntentNeedsDecision,
                    &after_change_set.change_set_id,
                    graph.generation(),
                )?;
                transition
                    .change_sets
                    .push((Some(before_change_set), Some(after_change_set.clone())));
                transition
                    .tickets
                    .push((Some(before_ticket), Some(terminal_ticket)));
                ClaimOutcome::NeedsDecision {
                    change_set: after_change_set,
                    event,
                }
            }
        };

        durable.persist_lifecycle(&transition)?;
        *scheduler = next_scheduler;
        Ok(outcome)
    }

    pub fn reconsider_tickets(&self, now_tick: u64) -> Result<Vec<ReadyOffer>> {
        self.reconsider_with_expired(now_tick, false)
            .map(|(offers, _)| offers)
    }

    pub fn expire_ready_offers(&self, now_tick: u64) -> Result<Vec<String>> {
        self.reconsider_with_expired(now_tick, true)
            .map(|(_, expired)| expired)
    }

    fn reconsider_with_expired(
        &self,
        now_tick: u64,
        expire_due_offers: bool,
    ) -> Result<(Vec<ReadyOffer>, Vec<String>)> {
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let durable = self.store.coordination();
        let graph = self.snapshot();
        let metadata = durable.metadata_state()?;
        let before_scheduler = scheduler.clone();
        let mut next_scheduler = scheduler.clone();
        let expired_ids = if expire_due_offers {
            next_scheduler
                .offers()
                .filter(|offer| now_tick >= offer.expires_at_tick)
                .map(|offer| offer.offer_id.clone())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let mut expired_offers = Vec::new();
        let mut affected_change_sets = BTreeSet::new();
        for offer_id in &expired_ids {
            let offer = next_scheduler
                .offer(offer_id)
                .cloned()
                .with_context(|| format!("ready offer {offer_id} does not exist"))?;
            if now_tick < offer.expires_at_tick {
                bail!("ready offer {offer_id} has not expired");
            }
            next_scheduler.expire_offer(offer_id)?;
            affected_change_sets.insert(offer.change_set_id.clone());
            expired_offers.push(offer);
        }

        let selected = next_scheduler.select_ready()?;
        let mut new_offers = Vec::new();
        for ticket_id in &selected {
            let ticket = next_scheduler
                .ticket(ticket_id)
                .cloned()
                .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
            let offer = make_offer(&ticket, self.service_epoch(), graph.generation(), now_tick)?;
            next_scheduler.mark_ready(ticket_id, offer.clone())?;
            affected_change_sets.insert(offer.change_set_id.clone());
            new_offers.push(offer);
        }

        if expired_offers.is_empty()
            && new_offers.is_empty()
            && scheduler_ticket_updates(&before_scheduler, &next_scheduler).is_empty()
        {
            return Ok((Vec::new(), Vec::new()));
        }

        let mut transition = transition(metadata);
        for offer in &expired_offers {
            transition.offers.push((Some(offer.clone()), None));
            append_event(
                &mut transition,
                CoordinationEventKind::LeaseExpired,
                &offer.change_set_id,
                graph.generation(),
            )?;
        }
        for offer in &new_offers {
            transition.offers.push((None, Some(offer.clone())));
            append_event(
                &mut transition,
                CoordinationEventKind::IntentReady,
                &offer.change_set_id,
                graph.generation(),
            )?;
        }
        transition.tickets = scheduler_ticket_updates(&before_scheduler, &next_scheduler);
        for change_set_id in affected_change_sets {
            let before = durable
                .change_set(&change_set_id)?
                .with_context(|| format!("missing change set {change_set_id}"))?;
            let mut after = before.clone();
            let ticket = next_scheduler
                .tickets()
                .find(|ticket| ticket.change_set_id == change_set_id)
                .with_context(|| format!("missing active ticket for {change_set_id}"))?;
            after.state = match ticket.state {
                TicketState::Queued => ChangeSetState::Queued,
                TicketState::Ready => ChangeSetState::Ready,
                TicketState::Claimed => ChangeSetState::Executing,
                TicketState::Completed
                | TicketState::NeedsDecision
                | TicketState::Cancelled
                | TicketState::Failed => {
                    bail!("terminal ticket cannot be reconsidered")
                }
            };
            if before != after {
                transition.change_sets.push((Some(before), Some(after)));
            }
        }
        durable.persist_lifecycle(&transition)?;
        *scheduler = next_scheduler;
        Ok((new_offers, expired_ids))
    }

    pub fn cancel_change_set(
        &self,
        change_set_id: &str,
        now_tick: u64,
    ) -> Result<CancellationOutcome> {
        let mut scheduler = self
            .scheduler
            .lock()
            .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
        let durable = self.store.coordination();
        let before_change_set = durable
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
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
        let graph = self.snapshot();
        let metadata = durable.metadata_state()?;
        let mut transition = transition(metadata);
        let mut after_change_set = before_change_set.clone();
        after_change_set.state = ChangeSetState::Cancelled;
        transition
            .change_sets
            .push((Some(before_change_set), Some(after_change_set.clone())));
        append_event(
            &mut transition,
            CoordinationEventKind::IntentCancelled,
            change_set_id,
            graph.generation(),
        )?;

        let before_scheduler = scheduler.clone();
        let mut next_scheduler = scheduler.clone();
        let mut cancelled_ticket_id = None;
        if let Some(before_ticket) = scheduler
            .tickets()
            .find(|ticket| ticket.change_set_id == change_set_id)
            .cloned()
        {
            cancelled_ticket_id = Some(before_ticket.ticket_id.clone());
            if let Some(offer_id) = &before_ticket.ready_offer_id {
                let offer = scheduler
                    .offer(offer_id)
                    .cloned()
                    .with_context(|| format!("missing ready offer {offer_id}"))?;
                transition.offers.push((Some(offer), None));
            }
            if let Some(claim_id) = &before_ticket.active_claim_id {
                let claim = durable
                    .active_claims()?
                    .into_iter()
                    .find(|claim| claim.claim_id == *claim_id)
                    .with_context(|| format!("missing active claim {claim_id}"))?;
                transition.claims.push((Some(claim), None));
            }
            next_scheduler.cancel_ticket(&before_ticket.ticket_id)?;
            let mut terminal_ticket = before_ticket.clone();
            terminal_ticket.state = TicketState::Cancelled;
            terminal_ticket.ready_offer_id = None;
            terminal_ticket.active_claim_id = None;
            transition
                .tickets
                .push((Some(before_ticket), Some(terminal_ticket)));
        }

        let selected = next_scheduler.select_ready()?;
        let mut ready_offers = Vec::new();
        for ticket_id in &selected {
            let ticket = next_scheduler
                .ticket(ticket_id)
                .cloned()
                .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
            let offer = make_offer(&ticket, self.service_epoch(), graph.generation(), now_tick)?;
            next_scheduler.mark_ready(ticket_id, offer.clone())?;
            let before = durable
                .change_set(&offer.change_set_id)?
                .with_context(|| format!("missing change set {}", offer.change_set_id))?;
            let mut after = before.clone();
            after.state = ChangeSetState::Ready;
            transition.change_sets.push((Some(before), Some(after)));
            transition.offers.push((None, Some(offer.clone())));
            append_event(
                &mut transition,
                CoordinationEventKind::IntentReady,
                &offer.change_set_id,
                graph.generation(),
            )?;
            ready_offers.push(offer);
        }
        transition.tickets.extend(
            scheduler_ticket_updates(&before_scheduler, &next_scheduler)
                .into_iter()
                .filter(|(before, after)| {
                    let id = before
                        .as_ref()
                        .or(after.as_ref())
                        .map(|ticket| ticket.ticket_id.as_str());
                    id != cancelled_ticket_id.as_deref()
                }),
        );

        durable.persist_lifecycle(&transition)?;
        *scheduler = next_scheduler;
        Ok(CancellationOutcome {
            change_set: after_change_set,
            ready_offers,
        })
    }

    /// Publishes an executing claim through the only default commit-authority path.
    ///
    /// Lock order is scheduler -> publish lock -> redb write transaction -> live write.
    /// Methods that need a subset of these locks preserve that order; no method may acquire
    /// scheduler or publish locks while holding the live write lock.
    pub fn publish_claimed(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
    ) -> Result<PublicationReport> {
        self.publish_claimed_inner(
            claim,
            candidate_builder,
            now_tick,
            CoordinatedPublishFailpoint::None,
            None,
        )
    }

    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn publish_claimed_with_failpoint(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        failpoint: CoordinatedPublishFailpoint,
    ) -> Result<PublicationReport> {
        self.publish_claimed_inner(claim, candidate_builder, now_tick, failpoint, None)
    }

    /// Test synchronization point for observing an idempotency miss before lock acquisition.
    #[doc(hidden)]
    #[cfg(feature = "redb-spike-api")]
    pub fn publish_claimed_with_entry_hook(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        after_outer_idempotency_lookup: &dyn Fn(),
    ) -> Result<PublicationReport> {
        self.publish_claimed_inner(
            claim,
            candidate_builder,
            now_tick,
            CoordinatedPublishFailpoint::None,
            Some(after_outer_idempotency_lookup),
        )
    }

    fn publish_claimed_inner(
        &self,
        claim: &ClaimHandle,
        candidate_builder: &dyn CandidateBuilder,
        now_tick: u64,
        failpoint: CoordinatedPublishFailpoint,
        after_outer_idempotency_lookup: Option<&dyn Fn()>,
    ) -> Result<PublicationReport> {
        let semantic_provider = self.semantic_provider()?;
        let idempotency_key = coordination_commit_key(&claim.change_set_id);
        if let Some(report) = self.committed_publication_report(&idempotency_key)? {
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
        if let Some(report) = self.committed_publication_report(&idempotency_key)? {
            return Ok(report);
        }

        let graph = self.snapshot();
        self.validate_executing_claim(&scheduler, claim, graph.generation())?;
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
        match classify_scope_change(previous_scope, &fresh_scope) {
            ScopeChange::Unchanged => {}
            scope_change => {
                self.persist_changed_publication_scope(
                    &mut scheduler,
                    claim,
                    before_change_set,
                    fresh_scope,
                    scope_change,
                    now_tick,
                )?;
                bail!("publication scope changed before candidate construction");
            }
        }

        let delta = candidate_builder.build_candidate(&graph, &before_change_set, &intents)?;
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
        let mut lifecycle = transition(metadata);
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
                    let mut offer = make_offer(
                        &fresh_ticket,
                        self.service_epoch(),
                        next_generation,
                        now_tick,
                    )?;
                    offer.blocking_event_sequence = Some(committed_event.sequence);
                    next_scheduler.mark_ready(&ticket.ticket_id, offer.clone())?;
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
        let commit = CoordinatedCommit {
            publication,
            lifecycle,
            service_epoch: self.service_epoch(),
            reservation_keys: fresh_scope.reservation_keys,
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

    fn committed_publication_report(&self, key: &str) -> Result<Option<PublicationReport>> {
        let Some(generation) = self.store.idempotency_generation(key)? else {
            return Ok(None);
        };
        Ok(Some(PublicationReport {
            generation,
            digest: self.store.generation_digest(generation)?,
            persistence_ns: 0,
            memory_publish_ns: 0,
            already_published: true,
        }))
    }

    fn validate_executing_claim(
        &self,
        scheduler: &SchedulerState,
        claim: &ClaimHandle,
        graph_generation: u64,
    ) -> Result<()> {
        if claim.service_epoch != self.service_epoch() {
            bail!("claim belongs to a stale service epoch");
        }
        if claim.graph_generation != graph_generation {
            bail!("claim belongs to a stale graph generation");
        }
        let durable = self.store.coordination();
        let active = durable
            .active_claims()?
            .into_iter()
            .find(|active| active.claim_id == claim.claim_id)
            .context("claim is not durably active")?;
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

    fn persist_changed_publication_scope(
        &self,
        scheduler: &mut SchedulerState,
        claim: &ClaimHandle,
        before_change_set: ChangeSetRecord,
        fresh_scope: super::InferredScope,
        scope_change: ScopeChange,
        now_tick: u64,
    ) -> Result<()> {
        let graph_generation = claim.graph_generation;
        let before_scheduler = scheduler.clone();
        let mut next_scheduler = scheduler.clone();
        let before_ticket = next_scheduler
            .tickets()
            .find(|ticket| ticket.change_set_id == claim.change_set_id)
            .cloned()
            .context("claim has no scheduler ticket")?;
        let durable = self.store.coordination();
        let metadata = durable.metadata_state()?;
        let mut lifecycle = transition(metadata);
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
        if terminal {
            next_scheduler.release(&claim.claim_id, TicketState::NeedsDecision)?;
            after_change_set.state = ChangeSetState::NeedsDecision;
            let mut after_ticket = before_ticket.clone();
            after_ticket.state = TicketState::NeedsDecision;
            after_ticket.active_claim_id = None;
            lifecycle
                .tickets
                .push((Some(before_ticket), Some(after_ticket)));
            let terminal_event = append_event(
                &mut lifecycle,
                CoordinationEventKind::IntentNeedsDecision,
                &claim.change_set_id,
                graph_generation,
            )?;
            let selected = next_scheduler.select_ready()?;
            for ticket_id in selected {
                let ticket = next_scheduler
                    .ticket(&ticket_id)
                    .cloned()
                    .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
                let mut offer =
                    make_offer(&ticket, self.service_epoch(), graph_generation, now_tick)?;
                offer.blocking_event_sequence = Some(terminal_event.sequence);
                next_scheduler.mark_ready(&ticket_id, offer.clone())?;
                let before = durable.change_set(&offer.change_set_id)?.with_context(|| {
                    format!("missing successor change set {}", offer.change_set_id)
                })?;
                let mut after = before.clone();
                after.state = ChangeSetState::Ready;
                after.blocking_change_set_id = Some(claim.change_set_id.clone());
                lifecycle.change_sets.push((Some(before), Some(after)));
                lifecycle.offers.push((None, Some(offer.clone())));
                append_event(
                    &mut lifecycle,
                    CoordinationEventKind::IntentReady,
                    &offer.change_set_id,
                    graph_generation,
                )?;
            }
        } else {
            let after_ticket = next_scheduler.requeue_claim_with_scope(
                &claim.claim_id,
                fresh_scope.scope_fingerprint.clone(),
                fresh_scope.reservation_keys.clone(),
            )?;
            after_change_set.state = ChangeSetState::Queued;
            after_change_set.expansion_count = after_change_set
                .expansion_count
                .checked_add(1)
                .context("scope expansion count overflow")?;
            lifecycle
                .tickets
                .push((Some(before_ticket), Some(after_ticket)));
            append_event(
                &mut lifecycle,
                CoordinationEventKind::ScopeExpanded,
                &claim.change_set_id,
                graph_generation,
            )?;
        }
        lifecycle
            .change_sets
            .push((Some(before_change_set), Some(after_change_set)));
        lifecycle.claims.push((Some(claim.clone()), None));
        lifecycle.tickets.extend(
            scheduler_ticket_updates(&before_scheduler, &next_scheduler)
                .into_iter()
                .filter(|(before, after)| {
                    before
                        .as_ref()
                        .or(after.as_ref())
                        .is_some_and(|ticket| ticket.change_set_id != claim.change_set_id)
                }),
        );
        durable.persist_lifecycle(&lifecycle)?;
        *scheduler = next_scheduler;
        Ok(())
    }
}

fn coordination_commit_key(change_set_id: &str) -> String {
    format!("coordination-commit:{change_set_id}")
}

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

fn intent_kind(intent: &IntentRecord) -> &'static str {
    match intent.parameters {
        IntentParameters::RenameSymbol { .. } => "RenameSymbol",
        IntentParameters::AddParameter { .. } => "AddParameter",
    }
}

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

fn make_offer(
    ticket: &CoordinationTicket,
    service_epoch: u64,
    graph_generation: u64,
    now_tick: u64,
) -> Result<ReadyOffer> {
    let expires_at_tick = now_tick
        .checked_add(READY_OFFER_TTL_TICKS)
        .context("ready offer expiry overflow")?;
    ReadyOffer::new(
        SCHEMA_VERSION,
        Uuid::new_v4().to_string(),
        ticket.change_set_id.clone(),
        service_epoch,
        graph_generation,
        ticket.scope_fingerprint.clone(),
        Uuid::new_v4().to_string(),
        expires_at_tick,
        None,
    )
    .map_err(anyhow::Error::msg)
}

fn transition(metadata: CoordinationMetadataState) -> LifecycleTransition {
    LifecycleTransition {
        change_sets: Vec::new(),
        tickets: Vec::new(),
        offers: Vec::new(),
        claims: Vec::new(),
        events: Vec::new(),
        expected_metadata: metadata,
        next_metadata: metadata,
    }
}

fn append_event(
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

fn scheduler_ticket_updates(
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

    #[test]
    fn offer_context_rejects_a_stale_service_epoch_directly() {
        let offer = ReadyOffer::new(
            SCHEMA_VERSION,
            "offer",
            "change-set",
            7,
            3,
            "scope",
            "token",
            30,
            None,
        )
        .unwrap();

        let error = validate_offer_context(&offer, 8, 10).unwrap_err();
        assert!(error.to_string().contains("stale service epoch"));
    }
}
