#![cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]

#[path = "support/full_key_free.rs"]
mod full_key_free_support;

use full_key_free_support::{
    CanonicalFinalState, ClientActor, assert_canonical_final_state,
    assert_projected_typescript_green, create_projected_kernel, reopen_projected_kernel,
};
use strata_kernel::{
    ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEventKind, IntentParameters, Kernel,
    PublishClaimOutcome, ReadyOffer, SubmissionOutcome, TicketState,
};
use tempfile::tempdir;

const USER_DECLARATION_ID: &str = "fc98295bca9efc3e";
const FORMAT_TIMESTAMP_DECLARATION_ID: &str = "9a25d67ed4b74807";
const GREET_DECLARATION_ID: &str = "603b2ae524ee3c70";

fn submit_rename(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    declaration_id: &str,
    new_name: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            &format!("rename {declaration_id} to {new_name}"),
            now_tick,
        )
        .unwrap();
    actor
        .add_intent(
            kernel,
            change_set_id,
            IntentParameters::RenameSymbol {
                declaration_id: declaration_id.into(),
                new_name: new_name.into(),
            },
        )
        .unwrap();
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

fn submit_add_parameter(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            "add the uniform excited parameter to greet",
            now_tick,
        )
        .unwrap();
    actor
        .add_intent(
            kernel,
            change_set_id,
            IntentParameters::AddParameter {
                function_id: GREET_DECLARATION_ID.into(),
                name: "excited".into(),
                type_text: "boolean".into(),
                position: 1,
                default_value: Some("false".into()),
            },
        )
        .unwrap();
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

fn ready(outcome: SubmissionOutcome) -> ReadyOffer {
    let SubmissionOutcome::Ready { offer, .. } = outcome else {
        panic!("change set must be ready")
    };
    offer
}

fn claim(actor: &ClientActor, kernel: &Kernel, offer: &ReadyOffer, now_tick: u64) -> ClaimHandle {
    let ClaimOutcome::Claimed(claim) = actor.claim_ready(kernel, offer, now_tick).unwrap() else {
        panic!("ready offer must be claimable")
    };
    claim
}

fn published(outcome: PublishClaimOutcome) -> strata_kernel::PublicationReport {
    let PublishClaimOutcome::Published(report) = outcome else {
        panic!("real Node-backed claim must publish")
    };
    report
}

fn run_disjoint_rename_order(format_first: bool) {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let user = ClientActor::new("agent:row-1-user", "events:row-1-user");
    let format = ClientActor::new("agent:row-1-format", "events:row-1-format");
    assert_ne!(user.actor_id(), format.actor_id());

    let user_offer = ready(submit_rename(
        &user,
        &kernel,
        "row-1-user",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let user_claim = claim(&user, &kernel, &user_offer, 2);
    let format_offer = ready(submit_rename(
        &format,
        &kernel,
        "row-1-format",
        FORMAT_TIMESTAMP_DECLARATION_ID,
        "renderTimestamp",
        0,
    ));
    let format_claim = claim(&format, &kernel, &format_offer, 2);
    assert_eq!(user_claim.graph_generation, 0);
    assert_eq!(format_claim.graph_generation, 0);

    let (first, second) = if format_first {
        (
            published(format.execute_claimed(&kernel, &format_claim, 3).unwrap()),
            published(user.execute_claimed(&kernel, &user_claim, 4).unwrap()),
        )
    } else {
        (
            published(user.execute_claimed(&kernel, &user_claim, 3).unwrap()),
            published(format.execute_claimed(&kernel, &format_claim, 4).unwrap()),
        )
    };
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);

    let final_state =
        CanonicalFinalState::capture(&kernel, &["row-1-user", "row-1-format"], &[&user, &format])
            .unwrap();
    assert_eq!(final_state.graph_generation, 2);
    assert_eq!(final_state.operations.len(), 2);
    let expected_change_set_order = if format_first {
        ["row-1-format", "row-1-user"]
    } else {
        ["row-1-user", "row-1-format"]
    };
    assert_eq!(
        final_state
            .operations
            .iter()
            .map(|operation| operation.change_set_id.as_str())
            .collect::<Vec<_>>(),
        expected_change_set_order
    );
    assert_eq!(
        final_state
            .operations
            .iter()
            .map(|operation| operation.actor.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([user.actor_id(), format.actor_id()])
    );
    let snapshot = final_state.graph_snapshot();
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == USER_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("interface Account")
    );
    assert!(
        snapshot
            .nodes
            .iter()
            .find(|node| node.id == FORMAT_TIMESTAMP_DECLARATION_ID)
            .unwrap()
            .payload
            .contains("function renderTimestamp")
    );
    assert_projected_typescript_green(&snapshot);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn deterministic_acceptance_harness_uses_public_kernel_surface() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let mut alpha = ClientActor::new("agent:acceptance-alpha", "events:acceptance-alpha");
    let beta = ClientActor::new("agent:acceptance-beta", "events:acceptance-beta");
    assert_eq!(alpha.actor_id(), "agent:acceptance-alpha");
    assert_eq!(alpha.acknowledged_event_sequence(), 0);
    let initial = CanonicalFinalState::capture(&kernel, &[], &[&alpha, &beta]).unwrap();
    assert_eq!(initial.graph_generation, 0);
    assert_eq!(initial.nodes.len(), 1_203);
    assert_eq!(initial.references.len(), 592);
    assert!(initial.operations.is_empty());
    assert!(initial.tickets.is_empty());

    alpha
        .begin_change_set(
            &kernel,
            "acceptance-shell-user-rename",
            "prove the deterministic acceptance harness",
            0,
        )
        .unwrap();
    alpha
        .add_intent(
            &kernel,
            "acceptance-shell-user-rename",
            IntentParameters::RenameSymbol {
                declaration_id: "fc98295bca9efc3e".into(),
                new_name: "Account".into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } = alpha
        .submit_change_set(&kernel, "acceptance-shell-user-rename", 1)
        .unwrap()
    else {
        panic!("the projected User rename must be ready")
    };
    let ClaimOutcome::Claimed(claim) = alpha.claim_ready(&kernel, &offer, 2).unwrap() else {
        panic!("the projected User rename must be claimed")
    };
    let PublishClaimOutcome::Published(report) = alpha.execute_claimed(&kernel, &claim, 3).unwrap()
    else {
        panic!("the projected User rename must publish")
    };
    assert_eq!(report.generation, 1);

    let delivered = alpha.read_events(&kernel, 100).unwrap();
    let last_sequence = delivered.last().unwrap().sequence;
    let cursor = alpha.acknowledge_events(&kernel, last_sequence).unwrap();
    assert_eq!(cursor.acknowledged_sequence, last_sequence);
    assert_eq!(alpha.acknowledged_event_sequence(), last_sequence);

    let expected =
        CanonicalFinalState::capture(&kernel, &["acceptance-shell-user-rename"], &[&alpha, &beta])
            .unwrap();
    assert_eq!(expected.graph_generation, 1);
    assert_eq!(expected.graph_digest.len(), 64);
    assert_eq!(expected.operations.len(), 1);
    assert_eq!(expected.tickets.len(), 1);
    assert_eq!(expected.tickets[0].state, TicketState::Completed);
    assert!(!expected.events.is_empty());
    assert_eq!(
        expected.event_cursors[alpha.event_client_id()],
        last_sequence
    );
    assert_projected_typescript_green(&expected.graph_snapshot());
    drop(kernel);

    let (reopened, recovered) = reopen_projected_kernel(&database_path).unwrap();
    assert_eq!(recovered.generation, 1);
    let mut resumed_alpha = ClientActor::new("agent:acceptance-alpha", "events:acceptance-alpha");
    let mut resumed_beta = ClientActor::new("agent:acceptance-beta", "events:acceptance-beta");
    assert!(
        resumed_alpha
            .read_events(&reopened, 100)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        resumed_alpha
            .resume_event_cursor(&reopened)
            .unwrap()
            .acknowledged_sequence,
        last_sequence
    );
    resumed_beta.resume_event_cursor(&reopened).unwrap();
    let actual = CanonicalFinalState::capture(
        &reopened,
        &["acceptance-shell-user-rename"],
        &[&resumed_alpha, &resumed_beta],
    )
    .unwrap();
    assert_canonical_final_state(&expected, &actual);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_1_disjoint_real_renames_publish_in_both_orders() {
    run_disjoint_rename_order(true);
    run_disjoint_rename_order(false);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_2_same_symbol_real_renames_require_a_fresh_decision() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let first = ClientActor::new("agent:row-2-first", "events:row-2-first");
    let second = ClientActor::new("agent:row-2-second", "events:row-2-second");
    let first_offer = ready(submit_rename(
        &first,
        &kernel,
        "row-2-account",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let first_claim = claim(&first, &kernel, &first_offer, 2);
    let SubmissionOutcome::Queued { ticket } = submit_rename(
        &second,
        &kernel,
        "row-2-customer",
        USER_DECLARATION_ID,
        "Customer",
        1,
    ) else {
        panic!("same-symbol successor must queue behind the held first claim")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    let stale_fingerprint = kernel
        .change_set("row-2-customer")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap()
        .scope_fingerprint;

    let first_report = published(first.execute_claimed(&kernel, &first_claim, 3).unwrap());
    assert_eq!(first_report.generation, 1);
    assert!(
        kernel
            .ready_offer_for_change_set("row-2-customer")
            .unwrap()
            .is_none(),
        "the second client must not receive authority from its stale G0 analysis"
    );
    let second_change_set = kernel.change_set("row-2-customer").unwrap().unwrap();
    assert_eq!(second_change_set.state, ChangeSetState::NeedsDecision);
    let fresh_fingerprint = second_change_set
        .inferred_scope
        .as_ref()
        .unwrap()
        .scope_fingerprint
        .clone();
    assert_ne!(fresh_fingerprint, stale_fingerprint);

    let decision_event = second
        .read_events(&kernel, 100)
        .unwrap()
        .into_iter()
        .rev()
        .find(|event| {
            event.change_set_id == "row-2-customer"
                && event.kind == CoordinationEventKind::IntentNeedsDecision
        })
        .expect("fresh-state decision event");
    let decision: serde_json::Value = serde_json::from_str(&decision_event.payload_json).unwrap();
    assert_eq!(decision["beforeGeneration"], 0);
    assert_eq!(decision["afterGeneration"], 1);
    assert_eq!(decision["scopeFingerprint"], fresh_fingerprint);
    assert!(decision["blockingOperationId"].as_str().is_some());

    let final_state = CanonicalFinalState::capture(
        &kernel,
        &["row-2-account", "row-2-customer"],
        &[&first, &second],
    )
    .unwrap();
    assert_eq!(final_state.graph_generation, 1);
    assert_eq!(final_state.operations.len(), 1);
    assert_eq!(final_state.operations[0].change_set_id, "row-2-account");
    assert_eq!(final_state.operations[0].actor, first.actor_id());
    assert_eq!(
        final_state
            .tickets
            .iter()
            .find(|ticket| ticket.change_set_id == "row-2-customer")
            .unwrap()
            .state,
        TicketState::NeedsDecision
    );
    let user = final_state
        .nodes
        .iter()
        .find(|node| node.id == USER_DECLARATION_ID)
        .unwrap();
    assert!(user.payload.contains("interface Account"));
    assert!(!user.payload.contains("Customer"));
    assert_projected_typescript_green(&final_state.graph_snapshot());
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_3_real_reference_facts_infer_overlap_before_mutation() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);
    let before = kernel.snapshot();
    let user_name_id = before
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.kind == "Identifier"
                && node.parent_id.as_deref() == Some(USER_DECLARATION_ID)
                && serde_json::from_str::<serde_json::Value>(&node.payload)
                    .ok()
                    .and_then(|payload| payload["text"].as_str().map(str::to_owned))
                    .as_deref()
                    == Some("User")
        })
        .expect("stable User declaration-name identifier")
        .id;
    let greet_user_reference = before
        .snapshot()
        .references
        .into_iter()
        .find(|reference| {
            reference.to_node_id == user_name_id
                && before
                    .node(&reference.from_node_id)
                    .is_some_and(|source| source.parent_id.as_deref() == Some(GREET_DECLARATION_ID))
        })
        .expect("greet signature must contain a real graph reference to User");

    let rename = ClientActor::new("agent:row-3-rename", "events:row-3-rename");
    let parameter = ClientActor::new("agent:row-3-parameter", "events:row-3-parameter");
    let rename_offer = ready(submit_rename(
        &rename,
        &kernel,
        "row-3-rename-user",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let rename_claim = claim(&rename, &kernel, &rename_offer, 2);
    let SubmissionOutcome::Queued { ticket } =
        submit_add_parameter(&parameter, &kernel, "row-3-parameter-greet", 1)
    else {
        panic!("the reference-mediated add-parameter must queue before mutation")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert!(
        kernel
            .ready_offer_for_change_set("row-3-parameter-greet")
            .unwrap()
            .is_none(),
        "the overlapping client must not receive concurrent claim authority"
    );
    assert_eq!(kernel.snapshot().generation(), 0);
    assert!(kernel.operation(1).unwrap().is_none());

    let parameter_scope = kernel
        .change_set("row-3-parameter-greet")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    let overlap = rename_claim
        .reservation_keys
        .iter()
        .filter(|key| parameter_scope.reservation_keys.contains(key))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        overlap.contains(&format!("node:{GREET_DECLARATION_ID}")),
        "User reference source {} makes greet a Rust-derived shared reservation: {overlap:?}",
        greet_user_reference.from_node_id
    );
    assert_eq!(
        kernel
            .snapshot()
            .node(GREET_DECLARATION_ID)
            .unwrap()
            .payload,
        before.node(GREET_DECLARATION_ID).unwrap().payload
    );
}
