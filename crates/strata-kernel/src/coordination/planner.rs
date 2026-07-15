use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use uuid::Uuid;

use super::authority::plan_change_set;
use super::coordinator::{append_event, scheduler_ticket_updates};
use super::{
    ChangeSetRecord, ChangeSetState, CoordinationDurable, CoordinationEventKind,
    CoordinationTicket, DynamicExpansionPolicy, LifecycleTransition, ReadyOffer, SchedulerState,
    ScopeChange, SemanticProvider, TicketState, classify_scope_change,
};
use crate::{GraphGeneration, SCHEMA_VERSION};

pub(crate) const MAX_OPTIMISTIC_RETRIES: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub(crate) enum TransitionCause {
    Submission,
    Publication,
    Cancellation,
    OfferExpiry,
    ClaimExpiry,
    ClaimRejection,
    Reconsideration,
    Restart,
}

pub(crate) struct PlannerSnapshot {
    pub graph: Arc<GraphGeneration>,
    pub scheduler: SchedulerState,
    pub scheduler_revision: u64,
    pub service_epoch: u64,
    pub now_tick: u64,
    pub cause: TransitionCause,
    pub blocking_event_sequence: Option<u64>,
    /// Work released by the triggering transition can be deliberately deferred for this pass.
    /// This lets an expired/rejected claim wake its successor without immediately reacquiring
    /// the reservation it just lost.
    pub deferred_change_set_ids: BTreeSet<String>,
}

pub(crate) struct PlannedOffer {
    pub ticket_before: CoordinationTicket,
    pub ticket_after: CoordinationTicket,
    pub change_set_before: ChangeSetRecord,
    pub change_set_after: ChangeSetRecord,
    pub offer: ReadyOffer,
}

pub(crate) struct ReadinessPlan {
    pub expected_graph_generation: u64,
    pub expected_scheduler_revision: u64,
    pub next_scheduler: SchedulerState,
    pub offers: Vec<PlannedOffer>,
    pub requeued: Vec<(ChangeSetRecord, ChangeSetRecord)>,
    pub needs_decision: Vec<(ChangeSetRecord, ChangeSetRecord)>,
    lifecycle: LifecycleTransition,
}

impl ReadinessPlan {
    pub(crate) fn lifecycle_transition(&self) -> Result<LifecycleTransition> {
        Ok(self.lifecycle.clone())
    }

    pub(crate) fn has_lifecycle_changes(&self) -> bool {
        !self.lifecycle.change_sets.is_empty()
            || !self.lifecycle.tickets.is_empty()
            || !self.lifecycle.offers.is_empty()
            || !self.lifecycle.claims.is_empty()
    }
}

pub(crate) fn plan_readiness(
    provider: &dyn SemanticProvider,
    snapshot: PlannerSnapshot,
    durable: &CoordinationDurable<'_>,
) -> Result<ReadinessPlan> {
    let metadata = durable.metadata_state()?;
    let before_scheduler = snapshot.scheduler.clone();
    let mut next_scheduler = snapshot.scheduler;
    let queued_ticket_ids = next_scheduler
        .tickets()
        .filter(|ticket| {
            ticket.state == TicketState::Queued
                && !snapshot
                    .deferred_change_set_ids
                    .contains(&ticket.change_set_id)
        })
        .map(|ticket| ticket.ticket_id.clone())
        .collect::<Vec<_>>();
    let mut change_set_updates = BTreeMap::<String, (ChangeSetRecord, ChangeSetRecord)>::new();
    let mut terminal_ticket_updates =
        BTreeMap::<String, (CoordinationTicket, CoordinationTicket)>::new();
    let mut requeued = Vec::new();
    let mut needs_decision = Vec::new();
    let mut pending_events = Vec::new();

    for ticket_id in queued_ticket_ids {
        let ticket_before = next_scheduler
            .ticket(&ticket_id)
            .cloned()
            .with_context(|| format!("queued ticket {ticket_id} disappeared"))?;
        let change_set_before = durable
            .change_set(&ticket_before.change_set_id)?
            .with_context(|| format!("missing change set {}", ticket_before.change_set_id))?;
        let previous_scope = change_set_before
            .inferred_scope
            .as_ref()
            .context("queued change set has no inferred scope")?;
        let intents = durable.intents_for(&ticket_before.change_set_id)?;
        let authority = plan_change_set(&snapshot.graph, &intents, provider)?;
        if authority.dependency_keys.iter().any(String::is_empty) {
            bail!("authority plan contains an empty dependency key");
        }
        let scope_change = classify_scope_change(previous_scope, &authority.scope);
        let mut change_set_after = change_set_before.clone();
        change_set_after.inferred_scope = Some(authority.scope.clone());

        let can_requeue_expansion = scope_change == ScopeChange::Expanded
            && matches!(
                authority.scope.dynamic_expansion_policy,
                DynamicExpansionPolicy::Requeue { max_expansions }
                    if change_set_before.expansion_count < max_expansions
            );
        if matches!(
            scope_change,
            ScopeChange::Unchanged | ScopeChange::Contracted
        ) || can_requeue_expansion
        {
            next_scheduler.update_queued_scope(
                &ticket_id,
                authority.scope.scope_fingerprint.clone(),
                authority.scope.reservation_keys.clone(),
            )?;
            if can_requeue_expansion {
                change_set_after.expansion_count = change_set_after
                    .expansion_count
                    .checked_add(1)
                    .context("scope expansion count overflow")?;
                pending_events.push((
                    CoordinationEventKind::ScopeExpanded,
                    change_set_after.change_set_id.clone(),
                ));
                requeued.push((change_set_before.clone(), change_set_after.clone()));
            }
            if change_set_before != change_set_after {
                change_set_updates.insert(
                    change_set_after.change_set_id.clone(),
                    (change_set_before, change_set_after),
                );
            }
        } else {
            next_scheduler.cancel_ticket(&ticket_id)?;
            let mut terminal_ticket = ticket_before.clone();
            terminal_ticket.state = TicketState::NeedsDecision;
            terminal_ticket.scope_fingerprint = authority.scope.scope_fingerprint.clone();
            terminal_ticket.reservation_keys = authority.scope.reservation_keys.clone();
            terminal_ticket.ready_offer_id = None;
            terminal_ticket.active_claim_id = None;
            change_set_after.state = ChangeSetState::NeedsDecision;
            terminal_ticket_updates.insert(ticket_id, (ticket_before, terminal_ticket));
            pending_events.push((
                CoordinationEventKind::IntentNeedsDecision,
                change_set_after.change_set_id.clone(),
            ));
            needs_decision.push((change_set_before.clone(), change_set_after.clone()));
            change_set_updates.insert(
                change_set_after.change_set_id.clone(),
                (change_set_before, change_set_after),
            );
        }
    }

    let selected = next_scheduler.select_ready_excluding(&snapshot.deferred_change_set_ids)?;
    let mut offers = Vec::new();
    for ticket_id in selected {
        let ticket_before = next_scheduler
            .ticket(&ticket_id)
            .cloned()
            .with_context(|| format!("selected ticket {ticket_id} disappeared"))?;
        let (change_set_before, mut change_set_after) =
            if let Some(update) = change_set_updates.remove(&ticket_before.change_set_id) {
                update
            } else {
                let change_set = durable
                    .change_set(&ticket_before.change_set_id)?
                    .with_context(|| {
                        format!(
                            "selected ticket {} has no durable change set",
                            ticket_before.ticket_id
                        )
                    })?;
                (change_set.clone(), change_set)
            };
        let mut offer = make_offer(
            &ticket_before,
            snapshot.service_epoch,
            snapshot.graph.generation(),
            snapshot.now_tick,
        )?;
        offer.blocking_event_sequence = snapshot.blocking_event_sequence;
        next_scheduler.mark_ready_excluding(
            &ticket_id,
            offer.clone(),
            &snapshot.deferred_change_set_ids,
        )?;
        let ticket_after = next_scheduler
            .ticket(&ticket_id)
            .cloned()
            .context("offered ticket disappeared")?;
        change_set_after.state = ChangeSetState::Ready;
        pending_events.push((
            CoordinationEventKind::IntentReady,
            change_set_after.change_set_id.clone(),
        ));
        change_set_updates.insert(
            change_set_after.change_set_id.clone(),
            (change_set_before.clone(), change_set_after.clone()),
        );
        offers.push(PlannedOffer {
            ticket_before,
            ticket_after,
            change_set_before,
            change_set_after,
            offer,
        });
    }

    let mut lifecycle = LifecycleTransition {
        change_sets: change_set_updates
            .into_values()
            .map(|(before, after)| (Some(before), Some(after)))
            .collect(),
        tickets: scheduler_ticket_updates(&before_scheduler, &next_scheduler),
        offers: offers
            .iter()
            .map(|planned| (None, Some(planned.offer.clone())))
            .collect(),
        claims: Vec::new(),
        events: Vec::new(),
        expected_metadata: metadata,
        next_metadata: metadata,
    };
    for (ticket_id, (before, after)) in terminal_ticket_updates {
        lifecycle.tickets.retain(|(old, new)| {
            old.as_ref()
                .or(new.as_ref())
                .is_none_or(|ticket| ticket.ticket_id != ticket_id)
        });
        lifecycle.tickets.push((Some(before), Some(after)));
    }
    for (kind, change_set_id) in pending_events {
        append_event(
            &mut lifecycle,
            kind,
            &change_set_id,
            snapshot.graph.generation(),
        )?;
    }
    let lifecycle_changed = !lifecycle.change_sets.is_empty()
        || !lifecycle.tickets.is_empty()
        || !lifecycle.offers.is_empty()
        || !lifecycle.claims.is_empty();
    if lifecycle_changed {
        lifecycle.next_metadata.scheduler_revision = lifecycle
            .expected_metadata
            .scheduler_revision
            .checked_add(1)
            .context("scheduler revision overflow")?;
        next_scheduler.set_revision(lifecycle.next_metadata.scheduler_revision);
    }

    let _ = snapshot.cause;
    Ok(ReadinessPlan {
        expected_graph_generation: snapshot.graph.generation(),
        expected_scheduler_revision: snapshot.scheduler_revision,
        next_scheduler,
        offers,
        requeued,
        needs_decision,
        lifecycle,
    })
}

pub(super) fn make_offer(
    ticket: &CoordinationTicket,
    service_epoch: u64,
    graph_generation: u64,
    now_tick: u64,
) -> Result<ReadyOffer> {
    let expires_at_tick = now_tick
        .checked_add(super::READY_OFFER_TTL_TICKS)
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
