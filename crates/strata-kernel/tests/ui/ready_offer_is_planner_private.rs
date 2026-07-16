use strata_kernel::{
    CoordinationTicket, ReadyOffer, SCHEMA_VERSION, SchedulerState, TicketState,
};

fn main() {
    let mut scheduler = SchedulerState::recover(Vec::new(), Vec::new(), Vec::new()).unwrap();
    let ticket = CoordinationTicket::new(
        SCHEMA_VERSION,
        "ticket",
        "change-set",
        TicketState::Queued,
        "fingerprint",
        vec!["symbol:target".to_owned()],
        1,
    )
    .unwrap();
    scheduler.enqueue(ticket).unwrap();
    let offer = ReadyOffer::new(
        SCHEMA_VERSION,
        "offer",
        "change-set",
        1,
        0,
        "fingerprint",
        "claim-token",
        30,
        None,
    )
    .unwrap();
    scheduler.mark_ready("ticket", offer).unwrap();
}
