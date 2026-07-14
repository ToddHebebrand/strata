use serde::{Serialize, de::DeserializeOwned};
use strata_kernel::{
    ChangeSetRecord, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEvent,
    CoordinationEventKind, CoordinationTicket, DynamicExpansionPolicy, EventCursor,
    IdempotencyClass, InferredScope, IntentParameters, IntentRecord, ReadyOffer, ResourceVersion,
    SCHEMA_VERSION, SubmissionOutcome, TicketState,
};

fn assert_round_trip<T>(value: &T)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_string(value).unwrap();
    assert_eq!(serde_json::from_str::<T>(&json).unwrap(), *value);
}

fn rename_intent() -> IntentRecord {
    IntentRecord::new(
        SCHEMA_VERSION,
        "intent:rename",
        "change-set:1",
        7,
        IntentParameters::RenameSymbol {
            declaration_id: "decl:User".into(),
            new_name: "Account".into(),
        },
    )
    .unwrap()
}

fn add_parameter_intent() -> IntentRecord {
    IntentRecord::new(
        SCHEMA_VERSION,
        "intent:add-parameter",
        "change-set:1",
        7,
        IntentParameters::AddParameter {
            function_id: "decl:formatTimestamp".into(),
            name: "timezone".into(),
            type_text: "string".into(),
            position: 1,
            default_value: Some("\"UTC\"".into()),
        },
    )
    .unwrap()
}

fn scope() -> InferredScope {
    InferredScope {
        read_set: vec![ResourceVersion {
            resource_key: "symbol:decl:User".into(),
            version: "7".into(),
        }],
        write_set: vec![ResourceVersion {
            resource_key: "node:decl:User".into(),
            version: "7".into(),
        }],
        validation_set: vec![ResourceVersion {
            resource_key: "module-structure:users".into(),
            version: "7".into(),
        }],
        reservation_keys: vec!["node:decl:User".into(), "symbol:decl:User".into()],
        scope_fingerprint: "scope:abc123".into(),
        dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
        idempotency_class: IdempotencyClass::RequiresDecision,
    }
}

fn change_set() -> ChangeSetRecord {
    let intents = vec![rename_intent(), add_parameter_intent()];
    let mut change_set = ChangeSetRecord::new(
        SCHEMA_VERSION,
        "change-set:1",
        "agent:1",
        "rename User and extend timestamp formatting",
        7,
        "submission:1",
        &intents,
    )
    .unwrap();
    change_set.state = ChangeSetState::Queued;
    change_set.inferred_scope = Some(scope());
    change_set.queue_sequence = Some(11);
    change_set
}

fn ticket() -> CoordinationTicket {
    CoordinationTicket::new(
        SCHEMA_VERSION,
        "ticket:1",
        "change-set:1",
        TicketState::Queued,
        "scope:abc123",
        vec!["node:decl:User".into(), "symbol:decl:User".into()],
        11,
    )
    .unwrap()
}

fn offer() -> ReadyOffer {
    ReadyOffer::new(
        SCHEMA_VERSION,
        "offer:1",
        "change-set:1",
        4,
        8,
        "scope:abc123",
        "claim-token:1",
        42,
        Some(10),
    )
    .unwrap()
}

fn claim() -> ClaimHandle {
    ClaimHandle::new(
        "claim:1",
        "change-set:1",
        "offer:1",
        4,
        8,
        "scope:abc123",
        vec!["node:decl:User".into(), "symbol:decl:User".into()],
    )
    .unwrap()
}

fn event() -> CoordinationEvent {
    CoordinationEvent::new(
        SCHEMA_VERSION,
        "event:1",
        12,
        CoordinationEventKind::IntentReady,
        "change-set:1",
        8,
        r#"{"offerId":"offer:1"}"#,
    )
    .unwrap()
}

#[test]
fn coordination_records_are_schema_v1_camel_case_and_round_trip() {
    let rename = rename_intent();
    let rename_json = serde_json::to_string(&rename).unwrap();
    assert!(rename_json.contains("\"schemaVersion\":1"));
    assert!(rename_json.contains("\"changeSetId\":\"change-set:1\""));
    assert!(rename_json.contains("\"baseGeneration\":7"));
    assert!(rename_json.contains("\"type\":\"renameSymbol\""));

    let add_parameter = add_parameter_intent();
    let add_parameter_json = serde_json::to_string(&add_parameter).unwrap();
    assert!(add_parameter_json.contains("\"type\":\"addParameter\""));
    assert!(add_parameter_json.contains("\"defaultValue\":\"\\\"UTC\\\"\""));

    let change_set = change_set();
    let change_set_json = serde_json::to_string(&change_set).unwrap();
    assert!(change_set_json.contains("\"submissionIdempotencyKey\":\"submission:1\""));
    assert!(change_set_json.contains("\"reservationKeys\""));
    assert!(change_set_json.contains("\"scopeFingerprint\":\"scope:abc123\""));

    let ticket = ticket();
    let offer = offer();
    let claim = claim();
    let event = event();
    let cursor = EventCursor::new("client:1", 12).unwrap();
    let submission_ready = SubmissionOutcome::Ready {
        ticket: ticket.clone(),
        offer: offer.clone(),
    };
    let submission_queued = SubmissionOutcome::Queued {
        ticket: ticket.clone(),
    };
    let submission_duplicate = SubmissionOutcome::Duplicate {
        change_set: change_set.clone(),
    };
    let claimed = ClaimOutcome::Claimed(claim.clone());
    let requeued = ClaimOutcome::Requeued {
        ticket: ticket.clone(),
        event: event.clone(),
    };
    let needs_decision = ClaimOutcome::NeedsDecision {
        change_set: change_set.clone(),
        event: event.clone(),
    };

    assert_round_trip(&rename);
    assert_round_trip(&add_parameter);
    assert_round_trip(&scope());
    assert_round_trip(&change_set);
    assert_round_trip(&ticket);
    assert_round_trip(&offer);
    assert_round_trip(&claim);
    assert_round_trip(&event);
    assert_round_trip(&cursor);
    assert_round_trip(&submission_ready);
    assert_round_trip(&submission_queued);
    assert_round_trip(&submission_duplicate);
    assert_round_trip(&claimed);
    assert_round_trip(&requeued);
    assert_round_trip(&needs_decision);

    assert_eq!(
        serde_json::to_string(&ChangeSetState::Queued).unwrap(),
        "\"queued\""
    );
    assert_eq!(
        serde_json::to_string(&TicketState::Claimed).unwrap(),
        "\"claimed\""
    );
    assert_eq!(
        serde_json::to_string(&CoordinationEventKind::ScopeExpanded).unwrap(),
        "\"scopeExpanded\""
    );
    assert_eq!(
        DynamicExpansionPolicy::Requeue { max_expansions: 3 },
        serde_json::from_str(r#"{"type":"requeue","maxExpansions":3}"#).unwrap()
    );
    assert_eq!(
        IdempotencyClass::RequiresDecision,
        IdempotencyClass::RequiresDecision
    );
    assert!(
        serde_json::to_string(&submission_ready)
            .unwrap()
            .contains("\"type\":\"ready\"")
    );
    assert!(
        serde_json::to_string(&claimed)
            .unwrap()
            .contains("\"type\":\"claimed\"")
    );
}

#[test]
fn constructors_reject_invalid_schema_ids_and_change_set_membership() {
    let error = IntentRecord::new(
        SCHEMA_VERSION + 1,
        "intent:future",
        "change-set:1",
        7,
        IntentParameters::RenameSymbol {
            declaration_id: "decl:User".into(),
            new_name: "Account".into(),
        },
    )
    .unwrap_err();
    assert!(error.contains("intent:future"));
    assert!(error.contains("schema version 2"));

    let error = IntentRecord::new(
        SCHEMA_VERSION,
        "",
        "change-set:1",
        7,
        IntentParameters::RenameSymbol {
            declaration_id: "decl:User".into(),
            new_name: "Account".into(),
        },
    )
    .unwrap_err();
    assert!(error.contains("intent_id"));

    let mut mismatched = rename_intent();
    mismatched.change_set_id = "change-set:other".into();
    let error = ChangeSetRecord::new(
        SCHEMA_VERSION,
        "change-set:1",
        "agent:1",
        "reason",
        7,
        "submission:1",
        &[mismatched],
    )
    .unwrap_err();
    assert!(error.contains("intent:rename"));
    assert!(error.contains("change-set:other"));
    assert!(error.contains("change-set:1"));

    let duplicate = rename_intent();
    let error = ChangeSetRecord::new(
        SCHEMA_VERSION,
        "change-set:1",
        "agent:1",
        "reason",
        7,
        "submission:1",
        &[duplicate.clone(), duplicate],
    )
    .unwrap_err();
    assert!(error.contains("intent:rename"));
    assert!(error.contains("duplicate"));

    let error = ReadyOffer::new(
        SCHEMA_VERSION + 1,
        "offer:future",
        "change-set:1",
        4,
        8,
        "scope:abc123",
        "claim-token:1",
        42,
        None,
    )
    .unwrap_err();
    assert!(error.contains("offer:future"));
    assert!(error.contains("schema version 2"));
}

#[test]
fn terminal_states_cannot_transition_back_to_nonterminal_states() {
    let mut change_set = change_set();
    change_set.state = ChangeSetState::Committed;
    let error = change_set
        .transition_to(ChangeSetState::Queued)
        .unwrap_err();
    assert!(error.contains("change-set:1"));
    assert!(error.contains("Committed"));
    assert!(error.contains("Queued"));

    change_set
        .transition_to(ChangeSetState::NeedsDecision)
        .unwrap();
    assert_eq!(change_set.state, ChangeSetState::NeedsDecision);

    let mut terminal_ticket = ticket();
    terminal_ticket.state = TicketState::Completed;
    let error = terminal_ticket
        .transition_to(TicketState::Ready)
        .unwrap_err();
    assert!(error.contains("ticket:1"));
    assert!(error.contains("Completed"));
    assert!(error.contains("Ready"));

    terminal_ticket
        .transition_to(TicketState::Cancelled)
        .unwrap();
    assert_eq!(terminal_ticket.state, TicketState::Cancelled);

    assert_eq!(
        serde_json::to_string(&TicketState::NeedsDecision).unwrap(),
        r#""needsDecision""#
    );

    let mut needs_decision = ticket();
    needs_decision
        .transition_to(TicketState::NeedsDecision)
        .unwrap();
    let error = needs_decision
        .transition_to(TicketState::Queued)
        .unwrap_err();
    assert!(error.contains("NeedsDecision"));
    assert!(error.contains("Queued"));
}
