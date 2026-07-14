use std::collections::{BTreeMap, BTreeSet};

use strata_kernel::{
    ClaimHandle, CoordinationTicket, ReadyOffer, SCHEMA_VERSION, SchedulerState, TicketState,
};

fn ticket(id: &str, sequence: u64, keys: &[&str]) -> CoordinationTicket {
    CoordinationTicket::new(
        SCHEMA_VERSION,
        id,
        format!("change-set:{id}"),
        TicketState::Queued,
        format!("scope:{id}"),
        keys.iter().map(|key| (*key).to_owned()).collect(),
        sequence,
    )
    .unwrap()
}

fn offer(ticket: &CoordinationTicket) -> ReadyOffer {
    ReadyOffer::new(
        SCHEMA_VERSION,
        format!("offer:{}", ticket.ticket_id),
        ticket.change_set_id.clone(),
        1,
        0,
        ticket.scope_fingerprint.clone(),
        format!("token:{}", ticket.ticket_id),
        30,
        None,
    )
    .unwrap()
}

fn claim(ticket: &CoordinationTicket, offer: &ReadyOffer) -> ClaimHandle {
    ClaimHandle::new(
        format!("claim:{}", ticket.ticket_id),
        ticket.change_set_id.clone(),
        offer.offer_id.clone(),
        offer.service_epoch,
        offer.graph_generation,
        ticket.scope_fingerprint.clone(),
        ticket.reservation_keys.clone(),
    )
    .unwrap()
}

fn ready_records(mut ticket: CoordinationTicket) -> (CoordinationTicket, ReadyOffer) {
    let offer = offer(&ticket);
    ticket.state = TicketState::Ready;
    ticket.ready_offer_id = Some(offer.offer_id.clone());
    (ticket, offer)
}

fn claimed_records(mut ticket: CoordinationTicket) -> (CoordinationTicket, ClaimHandle) {
    let offer = offer(&ticket);
    let claim = claim(&ticket, &offer);
    ticket.state = TicketState::Claimed;
    ticket.active_claim_id = Some(claim.claim_id.clone());
    (ticket, claim)
}

#[test]
fn disjoint_tickets_are_selected_together() {
    let mut scheduler = SchedulerState::recover(
        vec![ticket("a", 1, &["symbol:A"]), ticket("b", 2, &["symbol:B"])],
        vec![],
        vec![],
    )
    .unwrap();

    assert_eq!(scheduler.select_ready().unwrap(), vec!["a", "b"]);
}

#[test]
fn overlapping_tickets_run_in_queue_sequence_order() {
    let first = ticket("first", 1, &["symbol:A"]);
    let second = ticket("second", 2, &["symbol:A"]);
    let mut scheduler =
        SchedulerState::recover(vec![second, first.clone()], vec![], vec![]).unwrap();

    assert_eq!(scheduler.select_ready().unwrap(), vec!["first"]);
    let first_offer = offer(&first);
    scheduler.mark_ready("first", first_offer.clone()).unwrap();
    scheduler
        .claim(&first_offer.offer_id, claim(&first, &first_offer))
        .unwrap();
    assert!(scheduler.select_ready().unwrap().is_empty());
    scheduler
        .release("claim:first", TicketState::Completed)
        .unwrap();
    assert_eq!(scheduler.select_ready().unwrap(), vec!["second"]);
}

#[test]
fn a_wide_ticket_is_never_partially_selected() {
    let (active_ticket, active_claim) = claimed_records(ticket("active-x", 1, &["node:X"]));
    let wide = ticket("wide", 2, &["symbol:A", "node:X"]);
    let mut scheduler =
        SchedulerState::recover(vec![active_ticket, wide], vec![], vec![active_claim]).unwrap();

    assert!(scheduler.select_ready().unwrap().is_empty());
    assert_eq!(scheduler.ticket("wide").unwrap().age_rounds, 1);
    assert_eq!(
        scheduler.ticket("wide").unwrap().reservation_keys,
        vec!["symbol:A", "node:X"]
    );
}

#[test]
fn an_older_blocked_wide_ticket_blocks_younger_overlap_but_not_disjoint_work() {
    let (active_ticket, active_claim) = claimed_records(ticket("active-a", 1, &["symbol:A"]));
    let wide = ticket("wide", 2, &["symbol:A", "node:X"]);
    let younger_overlap = ticket("younger-x", 3, &["node:X"]);
    let disjoint = ticket("disjoint", 4, &["symbol:C"]);
    let mut scheduler = SchedulerState::recover(
        vec![active_ticket, wide, younger_overlap, disjoint],
        vec![],
        vec![active_claim],
    )
    .unwrap();

    assert_eq!(scheduler.select_ready().unwrap(), vec!["disjoint"]);
    assert_eq!(scheduler.ticket("wide").unwrap().age_rounds, 1);
    assert_eq!(scheduler.ticket("younger-x").unwrap().age_rounds, 1);
    assert_eq!(scheduler.ticket("disjoint").unwrap().age_rounds, 0);
}

#[test]
fn skipped_rounds_age_with_checked_arithmetic_and_no_partial_update() {
    let (active_ticket, active_claim) =
        claimed_records(ticket("active", 1, &["symbol:A", "symbol:B"]));
    let mut first = ticket("first", 2, &["symbol:A"]);
    first.age_rounds = 7;
    let mut overflow = ticket("overflow", 3, &["symbol:B"]);
    overflow.age_rounds = u64::MAX;
    let mut scheduler = SchedulerState::recover(
        vec![active_ticket, first, overflow],
        vec![],
        vec![active_claim],
    )
    .unwrap();

    let error = scheduler.select_ready().unwrap_err();
    assert!(error.to_string().contains("age_rounds overflow"));
    assert_eq!(scheduler.ticket("first").unwrap().age_rounds, 7);
    assert_eq!(scheduler.ticket("overflow").unwrap().age_rounds, u64::MAX);
}

#[test]
fn age_orders_only_tickets_that_are_already_fifo_eligible() {
    let older_overlap = ticket("older-overlap", 1, &["symbol:A"]);
    let mut younger_overlap = ticket("younger-overlap", 2, &["symbol:A"]);
    younger_overlap.age_rounds = 99;
    let mut aged_disjoint = ticket("aged-disjoint", 3, &["symbol:B"]);
    aged_disjoint.age_rounds = 4;
    let fresh_disjoint = ticket("fresh-disjoint", 4, &["symbol:C"]);
    let mut scheduler = SchedulerState::recover(
        vec![
            older_overlap,
            younger_overlap,
            aged_disjoint,
            fresh_disjoint,
        ],
        vec![],
        vec![],
    )
    .unwrap();

    assert_eq!(
        scheduler.select_ready().unwrap(),
        vec!["aged-disjoint", "older-overlap", "fresh-disjoint"]
    );
    assert_eq!(scheduler.ticket("younger-overlap").unwrap().age_rounds, 100);
}

#[test]
fn ready_offer_holds_complete_priority_scope_until_claim_or_expiry() {
    let ready = ticket("older-wide", 1, &["symbol:A", "node:X"]);
    let ready_offer = offer(&ready);
    let (ready, durable_offer) = ready_records(ready.clone());
    assert_eq!(ready_offer, durable_offer);
    let younger = ticket("younger", 2, &["node:X"]);
    let mut scheduler =
        SchedulerState::recover(vec![ready, younger], vec![ready_offer.clone()], vec![]).unwrap();

    assert!(scheduler.select_ready().unwrap().is_empty());
    scheduler
        .claim(
            &ready_offer.offer_id,
            claim(
                &scheduler.ticket("older-wide").unwrap().clone(),
                &ready_offer,
            ),
        )
        .unwrap();
    assert!(scheduler.select_ready().unwrap().is_empty());
}

#[test]
fn expiring_an_offer_preserves_fifo_position() {
    let older = ticket("older", 8, &["symbol:A"]);
    let older_offer = offer(&older);
    let (ready_older, durable_offer) = ready_records(older);
    let younger = ticket("younger", 9, &["symbol:A"]);
    let mut scheduler =
        SchedulerState::recover(vec![ready_older, younger], vec![durable_offer], vec![]).unwrap();

    assert_eq!(
        scheduler.expire_offer(&older_offer.offer_id).unwrap(),
        "older"
    );
    assert_eq!(scheduler.ticket("older").unwrap().queue_sequence, 8);
    assert_eq!(
        scheduler.ticket("older").unwrap().state,
        TicketState::Queued
    );
    assert_eq!(scheduler.select_ready().unwrap(), vec!["older"]);
}

#[test]
fn recovery_fails_closed_on_corrupt_cardinality_and_overlap() {
    let duplicate_sequence = SchedulerState::recover(
        vec![
            ticket("one", 1, &["symbol:A"]),
            ticket("two", 1, &["symbol:B"]),
        ],
        vec![],
        vec![],
    )
    .unwrap_err();
    assert!(
        duplicate_sequence
            .to_string()
            .contains("duplicate queue sequence")
    );

    let mut corrupt_ready = ticket("ready", 1, &["symbol:A"]);
    corrupt_ready.state = TicketState::Ready;
    corrupt_ready.ready_offer_id = Some("offer:missing".into());
    let mismatch = SchedulerState::recover(vec![corrupt_ready], vec![], vec![]).unwrap_err();
    assert!(mismatch.to_string().contains("missing ready offer"));

    let queued = ticket("queued", 1, &["symbol:A"]);
    let unmatched_offer = offer(&queued);
    let mismatch =
        SchedulerState::recover(vec![queued], vec![unmatched_offer], vec![]).unwrap_err();
    assert!(
        mismatch
            .to_string()
            .contains("does not match a Ready ticket")
    );

    let mut corrupt_claimed = ticket("claimed", 1, &["symbol:A"]);
    corrupt_claimed.state = TicketState::Claimed;
    corrupt_claimed.active_claim_id = Some("claim:missing".into());
    let mismatch = SchedulerState::recover(vec![corrupt_claimed], vec![], vec![]).unwrap_err();
    assert!(mismatch.to_string().contains("missing active claim"));

    let (first, first_claim) = claimed_records(ticket("first", 1, &["symbol:A"]));
    let (second, second_claim) = claimed_records(ticket("second", 2, &["symbol:A"]));
    let overlap =
        SchedulerState::recover(vec![first, second], vec![], vec![first_claim, second_claim])
            .unwrap_err();
    assert!(overlap.to_string().contains("overlapping active claims"));

    let (first, first_offer) = ready_records(ticket("first", 1, &["symbol:A"]));
    let (second, second_offer) = ready_records(ticket("second", 2, &["symbol:A"]));
    let overlap =
        SchedulerState::recover(vec![first, second], vec![first_offer, second_offer], vec![])
            .unwrap_err();
    assert!(overlap.to_string().contains("overlapping ready offers"));

    let (active, active_claim) = claimed_records(ticket("active", 1, &["symbol:A"]));
    let (ready, ready_offer) = ready_records(ticket("ready", 2, &["symbol:A"]));
    let overlap =
        SchedulerState::recover(vec![active, ready], vec![ready_offer], vec![active_claim])
            .unwrap_err();
    assert!(
        overlap
            .to_string()
            .contains("ready offer overlaps active claim")
    );
}

#[test]
fn recovery_rejects_ready_ticket_overlapping_older_queued_ticket() {
    let older = ticket("older", 1, &["symbol:A"]);
    let (younger, younger_offer) = ready_records(ticket("younger", 2, &["symbol:A"]));

    let error =
        SchedulerState::recover(vec![older, younger], vec![younger_offer], vec![]).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("older overlapping queued ticket")
    );
}

#[test]
fn recovery_rejects_claimed_ticket_overlapping_older_queued_ticket() {
    let older = ticket("older", 1, &["symbol:A"]);
    let (younger, younger_claim) = claimed_records(ticket("younger", 2, &["symbol:A"]));

    let error =
        SchedulerState::recover(vec![older, younger], vec![], vec![younger_claim]).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("older overlapping queued ticket")
    );
}

#[test]
fn enqueue_rejects_older_queued_ticket_beneath_younger_ready_ticket() {
    let (younger, younger_offer) = ready_records(ticket("younger", 2, &["symbol:A"]));
    let mut scheduler =
        SchedulerState::recover(vec![younger], vec![younger_offer], vec![]).unwrap();

    let error = scheduler
        .enqueue(ticket("older", 1, &["symbol:A"]))
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("younger overlapping Ready ticket")
    );
}

#[test]
fn enqueue_rejects_older_queued_ticket_beneath_younger_claimed_ticket() {
    let (younger, younger_claim) = claimed_records(ticket("younger", 2, &["symbol:A"]));
    let mut scheduler =
        SchedulerState::recover(vec![younger], vec![], vec![younger_claim]).unwrap();

    let error = scheduler
        .enqueue(ticket("older", 1, &["symbol:A"]))
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("younger overlapping Claimed ticket")
    );
}

#[test]
fn recovery_accepts_older_queued_ticket_disjoint_from_younger_ready_and_claimed_tickets() {
    let older = ticket("older", 1, &["symbol:A"]);
    let (ready, ready_offer) = ready_records(ticket("ready", 2, &["symbol:B"]));
    let (claimed, claimed_handle) = claimed_records(ticket("claimed", 3, &["symbol:C"]));

    let scheduler = SchedulerState::recover(
        vec![older, ready, claimed],
        vec![ready_offer],
        vec![claimed_handle],
    )
    .unwrap();

    assert_eq!(
        scheduler.ticket("older").unwrap().state,
        TicketState::Queued
    );
}

#[test]
fn enqueue_accepts_older_queued_ticket_disjoint_from_younger_ready_and_claimed_tickets() {
    let (ready, ready_offer) = ready_records(ticket("ready", 2, &["symbol:B"]));
    let (claimed, claimed_handle) = claimed_records(ticket("claimed", 3, &["symbol:C"]));
    let mut scheduler = SchedulerState::recover(
        vec![ready, claimed],
        vec![ready_offer],
        vec![claimed_handle],
    )
    .unwrap();

    scheduler
        .enqueue(ticket("older", 1, &["symbol:A"]))
        .unwrap();

    assert_eq!(
        scheduler.ticket("older").unwrap().state,
        TicketState::Queued
    );
}

#[test]
fn claim_and_release_validate_complete_scope_and_transition_atomically() {
    let queued = ticket("work", 1, &["symbol:A", "node:X"]);
    let mut scheduler = SchedulerState::recover(vec![queued.clone()], vec![], vec![]).unwrap();
    let ready_offer = offer(&queued);
    scheduler.mark_ready("work", ready_offer.clone()).unwrap();

    let mut partial_claim = claim(&queued, &ready_offer);
    partial_claim.reservation_keys = vec!["symbol:A".into()];
    assert!(
        scheduler
            .claim(&ready_offer.offer_id, partial_claim)
            .is_err()
    );
    assert!(scheduler.offer(&ready_offer.offer_id).is_some());
    assert_eq!(scheduler.ticket("work").unwrap().state, TicketState::Ready);

    scheduler
        .claim(&ready_offer.offer_id, claim(&queued, &ready_offer))
        .unwrap();
    assert!(scheduler.offer(&ready_offer.offer_id).is_none());
    assert_eq!(
        scheduler.ticket("work").unwrap().state,
        TicketState::Claimed
    );
    assert!(scheduler.release("claim:work", TicketState::Ready).is_err());
    assert!(scheduler.active_scope("claim:work").is_some());
    scheduler
        .release("claim:work", TicketState::Queued)
        .unwrap();
    assert!(scheduler.active_scope("claim:work").is_none());
    assert_eq!(scheduler.ticket("work").unwrap().state, TicketState::Queued);
}

#[test]
fn every_four_ticket_interleaving_preserves_disjoint_progress_and_fifo() {
    let ids = ["a-old", "a-young", "b", "c"];
    let tickets = BTreeMap::from([
        ("a-old", ticket("a-old", 1, &["symbol:A"])),
        ("a-young", ticket("a-young", 2, &["symbol:A"])),
        ("b", ticket("b", 3, &["symbol:B"])),
        ("c", ticket("c", 4, &["symbol:C"])),
    ]);

    for permutation in permutations(ids) {
        let mut scheduler = SchedulerState::recover(vec![], vec![], vec![]).unwrap();
        for id in permutation {
            scheduler.enqueue(tickets[id].clone()).unwrap();
        }

        let first_batch = scheduler.select_ready().unwrap();
        assert_eq!(first_batch, vec!["a-old", "b", "c"]);
        assert_disjoint_ticket_scopes(&scheduler, &first_batch);

        for ticket_id in &first_batch {
            let ready_offer = offer(scheduler.ticket(ticket_id).unwrap());
            scheduler.mark_ready(ticket_id, ready_offer).unwrap();
            assert_disjoint_holds(&scheduler);
        }
        assert!(scheduler.select_ready().unwrap().is_empty());

        let mut claim_sequences: BTreeMap<String, Vec<u64>> = BTreeMap::new();
        for ticket_id in first_batch.iter().rev() {
            let queued = scheduler.ticket(ticket_id).unwrap().clone();
            let ready_offer = scheduler
                .offers()
                .find(|offer| offer.change_set_id == queued.change_set_id)
                .unwrap()
                .clone();
            scheduler
                .claim(&ready_offer.offer_id, claim(&queued, &ready_offer))
                .unwrap();
            for key in &queued.reservation_keys {
                claim_sequences
                    .entry(key.clone())
                    .or_default()
                    .push(queued.queue_sequence);
            }
            scheduler
                .release(&format!("claim:{ticket_id}"), TicketState::Completed)
                .unwrap();
        }

        assert_eq!(scheduler.select_ready().unwrap(), vec!["a-young"]);
        let younger = scheduler.ticket("a-young").unwrap().clone();
        let younger_offer = offer(&younger);
        scheduler
            .mark_ready("a-young", younger_offer.clone())
            .unwrap();
        scheduler
            .claim(&younger_offer.offer_id, claim(&younger, &younger_offer))
            .unwrap();
        claim_sequences
            .entry("symbol:A".into())
            .or_default()
            .push(younger.queue_sequence);

        assert_eq!(claim_sequences["symbol:A"], vec![1, 2]);
        assert!(
            claim_sequences
                .values()
                .all(|sequences| sequences.is_sorted())
        );
        assert_eq!(
            claim_sequences.keys().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from(["symbol:A".into(), "symbol:B".into(), "symbol:C".into()])
        );
    }
}

fn assert_disjoint_ticket_scopes(scheduler: &SchedulerState, ticket_ids: &[String]) {
    let scopes = ticket_ids
        .iter()
        .map(|id| {
            scheduler
                .ticket(id)
                .unwrap()
                .reservation_keys
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    for left in 0..scopes.len() {
        for right in left + 1..scopes.len() {
            assert!(scopes[left].is_disjoint(&scopes[right]));
        }
    }
}

fn assert_disjoint_holds(scheduler: &SchedulerState) {
    let scopes = scheduler
        .offers()
        .map(|offer| {
            scheduler
                .ticket_for_offer(&offer.offer_id)
                .unwrap()
                .reservation_keys
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    for left in 0..scopes.len() {
        for right in left + 1..scopes.len() {
            assert!(scopes[left].is_disjoint(&scopes[right]));
        }
    }
}

fn permutations<const N: usize>(mut values: [&'static str; N]) -> Vec<[&'static str; N]> {
    fn visit<const N: usize>(
        values: &mut [&'static str; N],
        start: usize,
        output: &mut Vec<[&'static str; N]>,
    ) {
        if start == N {
            output.push(*values);
            return;
        }
        for index in start..N {
            values.swap(start, index);
            visit(values, start + 1, output);
            values.swap(start, index);
        }
    }

    let mut output = Vec::new();
    visit(&mut values, 0, &mut output);
    output
}
