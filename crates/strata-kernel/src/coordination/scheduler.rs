use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};

use super::{ClaimHandle, CoordinationTicket, ReadyOffer, TicketState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulerState {
    revision: u64,
    tickets: BTreeMap<u64, CoordinationTicket>,
    active: BTreeMap<String, BTreeSet<String>>,
    offers: BTreeMap<String, ReadyOffer>,
}

impl SchedulerState {
    pub fn recover(
        tickets: Vec<CoordinationTicket>,
        offers: Vec<ReadyOffer>,
        claims: Vec<ClaimHandle>,
    ) -> Result<Self> {
        Self::recover_with_revision(0, tickets, offers, claims)
    }

    pub(crate) fn recover_with_revision(
        revision: u64,
        tickets: Vec<CoordinationTicket>,
        offers: Vec<ReadyOffer>,
        claims: Vec<ClaimHandle>,
    ) -> Result<Self> {
        let mut state = Self {
            revision,
            tickets: BTreeMap::new(),
            active: BTreeMap::new(),
            offers: BTreeMap::new(),
        };
        let mut ticket_ids = BTreeSet::new();
        let mut change_set_ids = BTreeSet::new();

        for ticket in tickets {
            validate_ticket_scope(&ticket)?;
            if matches!(
                ticket.state,
                TicketState::Completed
                    | TicketState::NeedsDecision
                    | TicketState::Cancelled
                    | TicketState::Failed
            ) {
                bail!(
                    "terminal ticket {} cannot be recovered into the active scheduler",
                    ticket.ticket_id
                );
            }
            if !ticket_ids.insert(ticket.ticket_id.clone()) {
                bail!("duplicate ticket ID {}", ticket.ticket_id);
            }
            if !change_set_ids.insert(ticket.change_set_id.clone()) {
                bail!("duplicate ticket change set {}", ticket.change_set_id);
            }
            if state.tickets.contains_key(&ticket.queue_sequence) {
                bail!("duplicate queue sequence {}", ticket.queue_sequence);
            }
            state.tickets.insert(ticket.queue_sequence, ticket);
        }

        for offer in offers {
            offer.validate().map_err(anyhow::Error::msg)?;
            if state.offers.insert(offer.offer_id.clone(), offer).is_some() {
                bail!("duplicate ready offer ID");
            }
        }

        let mut claims_by_id = BTreeMap::new();
        for claim in claims {
            claim.validate().map_err(anyhow::Error::msg)?;
            let claim_id = claim.claim_id.clone();
            if claims_by_id.insert(claim_id.clone(), claim).is_some() {
                bail!("duplicate active claim ID {claim_id}");
            }
        }

        let mut matched_offers = BTreeSet::new();
        let mut matched_claims = BTreeSet::new();
        let mut ready_scopes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

        for ticket in state.tickets.values() {
            match ticket.state {
                TicketState::Queued => {
                    if ticket.ready_offer_id.is_some() || ticket.active_claim_id.is_some() {
                        bail!(
                            "Queued ticket {} has an offer or active claim reference",
                            ticket.ticket_id
                        );
                    }
                }
                TicketState::Ready => {
                    if ticket.active_claim_id.is_some() {
                        bail!("Ready ticket {} has an active claim", ticket.ticket_id);
                    }
                    let offer_id = ticket.ready_offer_id.as_deref().ok_or_else(|| {
                        anyhow::anyhow!("Ready ticket {} is missing ready offer", ticket.ticket_id)
                    })?;
                    let offer = state.offers.get(offer_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "Ready ticket {} is missing ready offer {offer_id}",
                            ticket.ticket_id
                        )
                    })?;
                    validate_offer_matches_ticket(offer, ticket)?;
                    if !matched_offers.insert(offer_id.to_owned()) {
                        bail!("ready offer {offer_id} is referenced by multiple tickets");
                    }
                    ready_scopes.insert(offer_id.to_owned(), scope(ticket));
                }
                TicketState::Claimed => {
                    if ticket.ready_offer_id.is_some() {
                        bail!(
                            "Claimed ticket {} still has a ready offer",
                            ticket.ticket_id
                        );
                    }
                    let claim_id = ticket.active_claim_id.as_deref().ok_or_else(|| {
                        anyhow::anyhow!(
                            "Claimed ticket {} is missing active claim",
                            ticket.ticket_id
                        )
                    })?;
                    let claim = claims_by_id.get(claim_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "Claimed ticket {} is missing active claim {claim_id}",
                            ticket.ticket_id
                        )
                    })?;
                    validate_claim_matches_ticket(claim, ticket, None)?;
                    if !matched_claims.insert(claim_id.to_owned()) {
                        bail!("active claim {claim_id} is referenced by multiple tickets");
                    }
                    state.active.insert(claim_id.to_owned(), scope(ticket));
                }
                TicketState::Completed
                | TicketState::NeedsDecision
                | TicketState::Cancelled
                | TicketState::Failed => {
                    unreachable!("terminal tickets were rejected before recovery validation")
                }
            }
        }

        if let Some(unmatched) = state
            .offers
            .keys()
            .find(|offer_id| !matched_offers.contains(*offer_id))
        {
            bail!("ready offer {unmatched} does not match a Ready ticket");
        }
        if let Some(unmatched) = claims_by_id
            .keys()
            .find(|claim_id| !matched_claims.contains(*claim_id))
        {
            bail!("active claim {unmatched} does not match a Claimed ticket");
        }

        ensure_pairwise_disjoint(&ready_scopes, "overlapping ready offers")?;
        ensure_pairwise_disjoint(&state.active, "overlapping active claims")?;
        for (offer_id, offered) in &ready_scopes {
            for (claim_id, active) in &state.active {
                if !offered.is_disjoint(active) {
                    bail!(
                        "ready offer overlaps active claim during recovery: {offer_id} and {claim_id}"
                    );
                }
            }
        }
        ensure_nonqueued_tickets_do_not_overlap_older_queued_tickets(&state.tickets)?;

        Ok(state)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }

    pub fn enqueue(&mut self, ticket: CoordinationTicket) -> Result<()> {
        validate_ticket_scope(&ticket)?;
        if ticket.state != TicketState::Queued
            || ticket.ready_offer_id.is_some()
            || ticket.active_claim_id.is_some()
        {
            bail!(
                "enqueued ticket {} must be pristine Queued",
                ticket.ticket_id
            );
        }
        if self.tickets.contains_key(&ticket.queue_sequence) {
            bail!("duplicate queue sequence {}", ticket.queue_sequence);
        }
        if self.tickets.values().any(|existing| {
            existing.ticket_id == ticket.ticket_id || existing.change_set_id == ticket.change_set_id
        }) {
            bail!("ticket {} is already enqueued", ticket.ticket_id);
        }
        let keys = scope(&ticket);
        if let Some((_, younger)) =
            self.tickets
                .range(ticket.queue_sequence..)
                .find(|(_, younger)| {
                    matches!(younger.state, TicketState::Ready | TicketState::Claimed)
                        && younger
                            .reservation_keys
                            .iter()
                            .any(|key| keys.contains(key))
                })
        {
            bail!(
                "older overlapping queued ticket {} precedes younger overlapping {:?} ticket {}",
                ticket.ticket_id,
                younger.state,
                younger.ticket_id
            );
        }
        self.tickets.insert(ticket.queue_sequence, ticket);
        Ok(())
    }

    pub fn select_ready(&mut self) -> Result<Vec<String>> {
        let mut ordered = self
            .tickets
            .values()
            .filter(|ticket| ticket.state == TicketState::Queued)
            .map(|ticket| (ticket.queue_sequence, ticket.age_rounds))
            .collect::<Vec<_>>();
        ordered.sort_by_key(|(sequence, age)| (Reverse(*age), *sequence));

        let offered_scopes = self
            .offers
            .keys()
            .map(|offer_id| {
                self.ticket_for_offer(offer_id)
                    .map(scope)
                    .ok_or_else(|| anyhow::anyhow!("ready offer {offer_id} has no ticket"))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut selected_keys = BTreeSet::new();
        let mut selected = Vec::new();
        let mut skipped = Vec::new();

        for (sequence, _) in ordered {
            let ticket = self
                .tickets
                .get(&sequence)
                .expect("ordered sequence came from scheduler tickets");
            let keys = scope(ticket);
            let active_overlap = self
                .active
                .values()
                .any(|active| !active.is_disjoint(&keys));
            let offered_overlap = offered_scopes
                .iter()
                .any(|offered| !offered.is_disjoint(&keys));
            let selected_overlap = !selected_keys.is_disjoint(&keys);
            let older_overlap = self.tickets.range(..sequence).any(|(_, older)| {
                matches!(older.state, TicketState::Queued | TicketState::Ready)
                    && older.reservation_keys.iter().any(|key| keys.contains(key))
            });

            if active_overlap || offered_overlap || selected_overlap || older_overlap {
                skipped.push(sequence);
            } else {
                selected_keys.extend(keys);
                selected.push(ticket.ticket_id.clone());
            }
        }

        let aged = skipped
            .iter()
            .map(|sequence| {
                let ticket = self
                    .tickets
                    .get(sequence)
                    .expect("skipped sequence came from scheduler tickets");
                ticket
                    .age_rounds
                    .checked_add(1)
                    .map(|age| (*sequence, age))
                    .ok_or_else(|| {
                        anyhow::anyhow!("ticket {} age_rounds overflow", ticket.ticket_id)
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        for (sequence, age) in aged {
            self.tickets
                .get_mut(&sequence)
                .expect("aged sequence came from scheduler tickets")
                .age_rounds = age;
        }

        Ok(selected)
    }

    // `coordination/planner.rs` is the sole caller so Ready authority is centralized.
    pub(super) fn mark_ready(&mut self, ticket_id: &str, offer: ReadyOffer) -> Result<()> {
        offer.validate().map_err(anyhow::Error::msg)?;
        if self.offers.contains_key(&offer.offer_id) {
            bail!("ready offer {} already exists", offer.offer_id);
        }
        let sequence = self.sequence_for_ticket(ticket_id)?;
        let ticket = self
            .tickets
            .get(&sequence)
            .expect("ticket sequence was just resolved");
        if ticket.state != TicketState::Queued
            || ticket.ready_offer_id.is_some()
            || ticket.active_claim_id.is_some()
        {
            bail!("ticket {ticket_id} is not pristine Queued");
        }
        validate_offer_matches_ticket(&offer, ticket)?;
        self.ensure_ticket_is_runnable(sequence)?;

        let offer_id = offer.offer_id.clone();
        self.offers.insert(offer_id.clone(), offer);
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("ticket sequence was just resolved");
        ticket
            .transition_to(TicketState::Ready)
            .map_err(anyhow::Error::msg)?;
        ticket.ready_offer_id = Some(offer_id);
        Ok(())
    }

    pub fn claim(&mut self, offer_id: &str, claim: ClaimHandle) -> Result<()> {
        claim.validate().map_err(anyhow::Error::msg)?;
        if self.active.contains_key(&claim.claim_id) {
            bail!("active claim {} already exists", claim.claim_id);
        }
        let offer = self
            .offers
            .get(offer_id)
            .ok_or_else(|| anyhow::anyhow!("ready offer {offer_id} does not exist"))?;
        let sequence = self.sequence_for_offer(offer_id)?;
        let ticket = self
            .tickets
            .get(&sequence)
            .expect("offer ticket sequence was just resolved");
        validate_claim_matches_ticket(&claim, ticket, Some(offer))?;
        let claimed_scope = scope(ticket);
        if self
            .active
            .values()
            .any(|active| !active.is_disjoint(&claimed_scope))
        {
            bail!("claim {} overlaps an active claim", claim.claim_id);
        }

        self.offers.remove(offer_id);
        self.active.insert(claim.claim_id.clone(), claimed_scope);
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("offer ticket sequence was just resolved");
        ticket
            .transition_to(TicketState::Claimed)
            .map_err(anyhow::Error::msg)?;
        ticket.ready_offer_id = None;
        ticket.active_claim_id = Some(claim.claim_id);
        Ok(())
    }

    pub fn release(&mut self, claim_id: &str, next_state: TicketState) -> Result<()> {
        if !matches!(
            next_state,
            TicketState::Queued
                | TicketState::Completed
                | TicketState::NeedsDecision
                | TicketState::Cancelled
                | TicketState::Failed
        ) {
            bail!("release transition must be Queued or terminal, not {next_state:?}");
        }
        if !self.active.contains_key(claim_id) {
            bail!("active claim {claim_id} does not exist");
        }
        let sequence = self.sequence_for_claim(claim_id)?;
        let ticket = self
            .tickets
            .get(&sequence)
            .expect("claim ticket sequence was just resolved");
        if ticket.state != TicketState::Claimed
            || ticket.active_claim_id.as_deref() != Some(claim_id)
        {
            bail!("active claim {claim_id} does not match a Claimed ticket");
        }

        if next_state == TicketState::Queued {
            let ticket = self
                .tickets
                .get_mut(&sequence)
                .expect("claim ticket sequence was just resolved");
            ticket
                .transition_to(TicketState::Queued)
                .map_err(anyhow::Error::msg)?;
            ticket.active_claim_id = None;
        } else {
            self.tickets.remove(&sequence);
        }
        self.active.remove(claim_id);
        Ok(())
    }

    pub(crate) fn requeue_claim_with_scope(
        &mut self,
        claim_id: &str,
        scope_fingerprint: String,
        reservation_keys: Vec<String>,
    ) -> Result<CoordinationTicket> {
        let sequence = self.sequence_for_claim(claim_id)?;
        self.release(claim_id, TicketState::Queued)?;
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("resolved ticket exists");
        ticket.scope_fingerprint = scope_fingerprint;
        ticket.reservation_keys = reservation_keys;
        validate_ticket_scope(ticket)?;
        Ok(ticket.clone())
    }

    pub(crate) fn update_queued_scope(
        &mut self,
        ticket_id: &str,
        scope_fingerprint: String,
        reservation_keys: Vec<String>,
    ) -> Result<CoordinationTicket> {
        if scope_fingerprint.is_empty() || reservation_keys.iter().any(String::is_empty) {
            bail!("updated queued scope must be non-empty and valid");
        }
        let sequence = self.sequence_for_ticket(ticket_id)?;
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("ticket sequence was just resolved");
        if ticket.state != TicketState::Queued
            || ticket.ready_offer_id.is_some()
            || ticket.active_claim_id.is_some()
        {
            bail!("ticket {ticket_id} is not pristine Queued");
        }
        ticket.scope_fingerprint = scope_fingerprint;
        ticket.reservation_keys = reservation_keys;
        validate_ticket_scope(ticket)?;
        Ok(ticket.clone())
    }

    pub fn expire_offer(&mut self, offer_id: &str) -> Result<String> {
        if !self.offers.contains_key(offer_id) {
            bail!("ready offer {offer_id} does not exist");
        }
        let sequence = self.sequence_for_offer(offer_id)?;
        let ticket_id = self
            .tickets
            .get(&sequence)
            .expect("offer ticket sequence was just resolved")
            .ticket_id
            .clone();

        self.offers.remove(offer_id);
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("offer ticket sequence was just resolved");
        ticket
            .transition_to(TicketState::Queued)
            .map_err(anyhow::Error::msg)?;
        ticket.ready_offer_id = None;
        Ok(ticket_id)
    }

    pub fn ticket(&self, ticket_id: &str) -> Option<&CoordinationTicket> {
        self.tickets
            .values()
            .find(|ticket| ticket.ticket_id == ticket_id)
    }

    pub fn offer(&self, offer_id: &str) -> Option<&ReadyOffer> {
        self.offers.get(offer_id)
    }

    pub fn offers(&self) -> impl Iterator<Item = &ReadyOffer> {
        self.offers.values()
    }

    pub fn tickets(&self) -> impl Iterator<Item = &CoordinationTicket> {
        self.tickets.values()
    }

    pub fn ticket_for_offer(&self, offer_id: &str) -> Option<&CoordinationTicket> {
        self.tickets
            .values()
            .find(|ticket| ticket.ready_offer_id.as_deref() == Some(offer_id))
    }

    pub fn active_scope(&self, claim_id: &str) -> Option<&BTreeSet<String>> {
        self.active.get(claim_id)
    }

    pub fn requeue_with_scope(
        &mut self,
        offer_id: &str,
        scope_fingerprint: String,
        reservation_keys: Vec<String>,
    ) -> Result<CoordinationTicket> {
        if scope_fingerprint.is_empty() || reservation_keys.iter().any(String::is_empty) {
            bail!("requeued scope must be non-empty and valid");
        }
        let ticket_id = self.expire_offer(offer_id)?;
        let sequence = self.sequence_for_ticket(&ticket_id)?;
        let ticket = self
            .tickets
            .get_mut(&sequence)
            .expect("ticket sequence was just resolved");
        ticket.scope_fingerprint = scope_fingerprint;
        ticket.reservation_keys = reservation_keys;
        validate_ticket_scope(ticket)?;
        Ok(ticket.clone())
    }

    pub fn cancel_ticket(&mut self, ticket_id: &str) -> Result<()> {
        let sequence = self.sequence_for_ticket(ticket_id)?;
        let ticket = self
            .tickets
            .remove(&sequence)
            .expect("ticket sequence was just resolved");
        if let Some(offer_id) = ticket.ready_offer_id {
            self.offers.remove(&offer_id);
        }
        if let Some(claim_id) = ticket.active_claim_id {
            self.active.remove(&claim_id);
        }
        Ok(())
    }

    fn ensure_ticket_is_runnable(&self, sequence: u64) -> Result<()> {
        let ticket = self
            .tickets
            .get(&sequence)
            .expect("runnable sequence came from scheduler tickets");
        let keys = scope(ticket);
        if self
            .active
            .values()
            .any(|active| !active.is_disjoint(&keys))
        {
            bail!("ticket {} overlaps an active claim", ticket.ticket_id);
        }
        for offer_id in self.offers.keys() {
            let offered = self
                .ticket_for_offer(offer_id)
                .ok_or_else(|| anyhow::anyhow!("ready offer {offer_id} has no ticket"))?;
            if !scope(offered).is_disjoint(&keys) {
                bail!(
                    "ticket {} overlaps ready offer {offer_id}",
                    ticket.ticket_id
                );
            }
        }
        if self.tickets.range(..sequence).any(|(_, older)| {
            matches!(older.state, TicketState::Queued | TicketState::Ready)
                && older.reservation_keys.iter().any(|key| keys.contains(key))
        }) {
            bail!(
                "ticket {} is blocked by an older overlapping ticket",
                ticket.ticket_id
            );
        }
        Ok(())
    }

    fn sequence_for_ticket(&self, ticket_id: &str) -> Result<u64> {
        self.tickets
            .iter()
            .find_map(|(sequence, ticket)| (ticket.ticket_id == ticket_id).then_some(*sequence))
            .ok_or_else(|| anyhow::anyhow!("ticket {ticket_id} does not exist"))
    }

    fn sequence_for_offer(&self, offer_id: &str) -> Result<u64> {
        self.tickets
            .iter()
            .find_map(|(sequence, ticket)| {
                (ticket.ready_offer_id.as_deref() == Some(offer_id)).then_some(*sequence)
            })
            .ok_or_else(|| anyhow::anyhow!("ready offer {offer_id} has no Ready ticket"))
    }

    fn sequence_for_claim(&self, claim_id: &str) -> Result<u64> {
        self.tickets
            .iter()
            .find_map(|(sequence, ticket)| {
                (ticket.active_claim_id.as_deref() == Some(claim_id)).then_some(*sequence)
            })
            .ok_or_else(|| anyhow::anyhow!("active claim {claim_id} has no Claimed ticket"))
    }
}

fn validate_ticket_scope(ticket: &CoordinationTicket) -> Result<()> {
    ticket.validate().map_err(anyhow::Error::msg)?;
    let keys = scope(ticket);
    if keys.len() != ticket.reservation_keys.len() {
        bail!("ticket {} has duplicate reservation keys", ticket.ticket_id);
    }
    Ok(())
}

fn validate_offer_matches_ticket(offer: &ReadyOffer, ticket: &CoordinationTicket) -> Result<()> {
    if offer.change_set_id != ticket.change_set_id
        || offer.scope_fingerprint != ticket.scope_fingerprint
    {
        bail!(
            "ready offer {} does not match ticket {}",
            offer.offer_id,
            ticket.ticket_id
        );
    }
    Ok(())
}

fn validate_claim_matches_ticket(
    claim: &ClaimHandle,
    ticket: &CoordinationTicket,
    offer: Option<&ReadyOffer>,
) -> Result<()> {
    if claim.change_set_id != ticket.change_set_id
        || claim.scope_fingerprint != ticket.scope_fingerprint
        || scope_from_keys(&claim.reservation_keys) != scope(ticket)
        || claim.reservation_keys.len() != ticket.reservation_keys.len()
    {
        bail!(
            "active claim {} does not match ticket {}",
            claim.claim_id,
            ticket.ticket_id
        );
    }
    if let Some(offer) = offer
        && (claim.offer_id != offer.offer_id
            || claim.service_epoch != offer.service_epoch
            || claim.graph_generation < offer.graph_generation)
    {
        bail!(
            "active claim {} does not match ready offer {}",
            claim.claim_id,
            offer.offer_id
        );
    }
    Ok(())
}

fn ensure_pairwise_disjoint(
    scopes: &BTreeMap<String, BTreeSet<String>>,
    label: &str,
) -> Result<()> {
    let entries = scopes.iter().collect::<Vec<_>>();
    for left in 0..entries.len() {
        for right in left + 1..entries.len() {
            if !entries[left].1.is_disjoint(entries[right].1) {
                bail!("{label}: {} and {}", entries[left].0, entries[right].0);
            }
        }
    }
    Ok(())
}

fn ensure_nonqueued_tickets_do_not_overlap_older_queued_tickets(
    tickets: &BTreeMap<u64, CoordinationTicket>,
) -> Result<()> {
    for (sequence, ticket) in tickets {
        if !matches!(ticket.state, TicketState::Ready | TicketState::Claimed) {
            continue;
        }
        let keys = scope(ticket);
        if let Some((_, older)) = tickets.range(..*sequence).find(|(_, older)| {
            older.state == TicketState::Queued
                && older.reservation_keys.iter().any(|key| keys.contains(key))
        }) {
            bail!(
                "older overlapping queued ticket {} precedes younger overlapping {:?} ticket {}",
                older.ticket_id,
                ticket.state,
                ticket.ticket_id
            );
        }
    }
    Ok(())
}

fn scope(ticket: &CoordinationTicket) -> BTreeSet<String> {
    scope_from_keys(&ticket.reservation_keys)
}

fn scope_from_keys(keys: &[String]) -> BTreeSet<String> {
    keys.iter().cloned().collect()
}
