use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::durable::{CoordinationMetadataState, LifecycleTransition};
use super::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, CreateDraftOutcome, DynamicExpansionPolicy,
    EventCursor, IntentAnalyzer, IntentParameters, IntentRecord, ReadyOffer, SchedulerState,
    ScopeChange, SubmissionOutcome, TicketState, analyze_change_set, classify_scope_change,
};
use crate::{Kernel, SCHEMA_VERSION};

pub const READY_OFFER_TTL_TICKS: u64 = 30;

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
        analyzer: &dyn IntentAnalyzer,
        now_tick: u64,
    ) -> Result<SubmissionOutcome> {
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
        let scope = analyze_change_set(&graph, &intents, analyzer)?;
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
        analyzer: &dyn IntentAnalyzer,
        now_tick: u64,
    ) -> Result<ClaimOutcome> {
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
        let next_scope = analyze_change_set(&graph, &intents, analyzer)?;
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
