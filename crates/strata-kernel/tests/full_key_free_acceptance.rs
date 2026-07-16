#![cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]

#[path = "support/full_key_free.rs"]
mod full_key_free_support;

use full_key_free_support::{
    CanonicalFinalState, ClientActor, assert_canonical_final_state,
    assert_projected_typescript_green, assert_typescript_green, classified_request_count,
    create_projected_kernel, inject_validated_add_parameter_g1, localized_add_parameter_fixture,
    reopen_projected_kernel,
};
use strata_kernel::{
    ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEventKind, IntentParameters, Kernel,
    PublishClaimOutcome, ReadyOffer, SubmissionOutcome, TicketState,
};
use tempfile::tempdir;

const USER_DECLARATION_ID: &str = "fc98295bca9efc3e";
const FORMAT_TIMESTAMP_DECLARATION_ID: &str = "9a25d67ed4b74807";
const GREET_DECLARATION_ID: &str = "603b2ae524ee3c70";

fn submit_wide_rename(
    actor: &ClientActor,
    kernel: &Kernel,
    change_set_id: &str,
    parse_declaration_id: &str,
    now_tick: u64,
) -> SubmissionOutcome {
    actor
        .begin_change_set(
            kernel,
            change_set_id,
            "rename User and parseArgs as one old wide change",
            now_tick,
        )
        .unwrap();
    for parameters in [
        IntentParameters::RenameSymbol {
            declaration_id: USER_DECLARATION_ID.into(),
            new_name: "WideUser".into(),
        },
        IntentParameters::RenameSymbol {
            declaration_id: parse_declaration_id.into(),
            new_name: "parseWideArgs".into(),
        },
    ] {
        actor.add_intent(kernel, change_set_id, parameters).unwrap();
    }
    actor
        .submit_change_set(kernel, change_set_id, now_tick + 1)
        .unwrap()
}

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
    function_id: &str,
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
                function_id: function_id.into(),
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
    let SubmissionOutcome::Queued { ticket } = submit_add_parameter(
        &parameter,
        &kernel,
        "row-3-parameter-greet",
        GREET_DECLARATION_ID,
        1,
    ) else {
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

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_4_add_parameter_requeues_before_build_and_updates_the_new_callsite() {
    let directory = tempdir().unwrap();
    let fixture = localized_add_parameter_fixture(directory.path());
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) =
        Kernel::create_with_node_bridge(&database_path, fixture.g0.clone(), fixture.worker_config)
            .unwrap();
    assert_eq!(created.generation, 0);

    let publisher = ClientActor::new("agent:row-4-publisher", "events:row-4-publisher");
    let parameter = ClientActor::new("agent:row-4-parameter", "events:row-4-parameter");
    let offer = ready(submit_add_parameter(
        &parameter,
        &kernel,
        "row-4-add-parameter",
        &fixture.greet_id,
        0,
    ));
    let submitted_scope = kernel
        .change_set("row-4-add-parameter")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert!(
        !submitted_scope.write_set.iter().any(|resource| {
            resource.resource_key == format!("node:{}", fixture.new_callsite_id)
        })
    );
    let analyses_before_claim = classified_request_count(&fixture.request_counts, "analyzeIntent");
    assert!(analyses_before_claim >= 1);
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        0
    );

    // This is a combined-feature fixture publisher, never a client or production storage path.
    inject_validated_add_parameter_g1(&kernel, &fixture.g0, &fixture.g1);
    let ClaimOutcome::Requeued { ticket, event } =
        parameter.claim_ready(&kernel, &offer, 2).unwrap()
    else {
        panic!("the G+1 callsite must expand scope and requeue")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert_eq!(event.kind, CoordinationEventKind::ScopeExpanded);
    assert_eq!(event.change_set_id, "row-4-add-parameter");
    assert!(
        classified_request_count(&fixture.request_counts, "analyzeIntent") > analyses_before_claim
    );
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        0,
        "fresh expansion must requeue before any candidate construction"
    );
    let expanded_scope = kernel
        .change_set("row-4-add-parameter")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert_ne!(
        expanded_scope.scope_fingerprint,
        submitted_scope.scope_fingerprint
    );
    assert!(
        expanded_scope.write_set.iter().any(|resource| {
            resource.resource_key == format!("node:{}", fixture.new_callsite_id)
        })
    );

    kernel.reconsider_tickets(3).unwrap();
    let fresh_offer = kernel
        .ready_offer_for_change_set("row-4-add-parameter")
        .unwrap()
        .expect("expanded replay-safe intent must receive fresh authority");
    let fresh_claim = claim(&parameter, &kernel, &fresh_offer, 4);
    let report = published(parameter.execute_claimed(&kernel, &fresh_claim, 5).unwrap());
    assert_eq!(report.generation, 2);
    assert!(!report.already_published);
    assert_eq!(
        classified_request_count(&fixture.request_counts, "buildValidateCandidate"),
        1
    );

    let final_state =
        CanonicalFinalState::capture(&kernel, &["row-4-add-parameter"], &[&publisher, &parameter])
            .unwrap();
    assert_eq!(final_state.graph_generation, 2);
    assert_eq!(final_state.operations.len(), 2);
    assert_eq!(final_state.operations[0].actor, "fixture:ingest-exporter");
    assert_eq!(final_state.operations[1].actor, parameter.actor_id());
    assert_eq!(
        final_state.operations[1].change_set_id,
        "row-4-add-parameter"
    );
    assert!(
        final_state.operations[1]
            .affected_node_ids
            .contains(&fixture.greet_id)
    );
    assert!(
        final_state.operations[1]
            .affected_node_ids
            .contains(&fixture.new_callsite_id)
    );
    assert!(kernel.operation(3).unwrap().is_none());
    let callsite = final_state
        .nodes
        .iter()
        .find(|node| node.id == fixture.new_callsite_id)
        .unwrap();
    assert_eq!(callsite.payload.matches("false").count(), 1);
    assert!(
        parameter
            .read_events(&kernel, 100)
            .unwrap()
            .iter()
            .any(|event| {
                event.change_set_id == "row-4-add-parameter"
                    && event.kind == CoordinationEventKind::IntentCommitted
            })
    );
    assert_typescript_green(&final_state.graph_snapshot(), &fixture.corpus_root);
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn row_5_real_scopes_age_the_old_wide_ticket_while_only_disjoint_work_bypasses() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);
    let parse_declaration_id = kernel
        .snapshot()
        .snapshot()
        .nodes
        .into_iter()
        .find(|node| {
            node.kind == "FunctionDeclaration" && node.payload.contains("function parseArgs(")
        })
        .expect("real parseArgs declaration")
        .id;

    let active = ClientActor::new("agent:row-5-active", "events:row-5-active");
    let wide = ClientActor::new("agent:row-5-wide", "events:row-5-wide");
    let disjoint = ClientActor::new("agent:row-5-disjoint", "events:row-5-disjoint");
    let active_offer = ready(submit_rename(
        &active,
        &kernel,
        "row-5-active-user",
        USER_DECLARATION_ID,
        "HeldUser",
        0,
    ));
    let _active_claim = claim(&active, &kernel, &active_offer, 2);
    let SubmissionOutcome::Queued { ticket } =
        submit_wide_rename(&wide, &kernel, "row-5-old-wide", &parse_declaration_id, 1)
    else {
        panic!("the old wide change must queue behind the held User claim")
    };
    assert_eq!(ticket.state, TicketState::Queued);

    let overlap_clients = (0..1)
        .map(|index| {
            ClientActor::new(
                format!("agent:row-5-overlap-{index}"),
                format!("events:row-5-overlap-{index}"),
            )
        })
        .collect::<Vec<_>>();
    for (index, actor) in overlap_clients.iter().enumerate() {
        let change_set_id = format!("row-5-newer-overlap-{index}");
        let SubmissionOutcome::Queued { .. } = submit_rename(
            actor,
            &kernel,
            &change_set_id,
            USER_DECLARATION_ID,
            &format!("NewerUser{index}"),
            3 + index as u64,
        ) else {
            panic!("newer overlapping work must remain bounded behind the old wide ticket")
        };
    }

    for index in 0..2 {
        let change_set_id = format!("row-5-disjoint-{index}");
        let offer = ready(submit_rename(
            &disjoint,
            &kernel,
            &change_set_id,
            FORMAT_TIMESTAMP_DECLARATION_ID,
            &format!("renderTimestamp{index}"),
            10 + index * 4,
        ));
        let disjoint_claim = claim(&disjoint, &kernel, &offer, 12 + index * 4);
        let report = published(
            disjoint
                .execute_claimed(&kernel, &disjoint_claim, 13 + index * 4)
                .unwrap(),
        );
        assert_eq!(report.generation, index + 1);
        for overlap_index in 0..overlap_clients.len() {
            assert!(
                kernel
                    .ready_offer_for_change_set(&format!("row-5-newer-overlap-{overlap_index}"))
                    .unwrap()
                    .is_none(),
                "newer overlap bypassed FIFO after disjoint round {index}"
            );
        }
    }
    let aged = kernel
        .ticket_for_change_set("row-5-old-wide")
        .unwrap()
        .unwrap();
    assert_eq!(aged.state, TicketState::Queued);
    assert!(
        aged.age_rounds >= 2,
        "each deterministic bypass round must age the old ticket"
    );

    let cancellation = active
        .cancel_change_set(&kernel, "row-5-active-user", 50)
        .unwrap();
    let wide_offer = cancellation
        .ready_offers
        .into_iter()
        .find(|offer| offer.change_set_id == "row-5-old-wide")
        .expect("releasing the blocker must offer the oldest wide ticket immediately");
    let wide_claim = claim(&wide, &kernel, &wide_offer, 51);
    assert_eq!(wide_claim.change_set_id, "row-5-old-wide");
    for overlap_index in 0..overlap_clients.len() {
        assert!(
            kernel
                .ready_offer_for_change_set(&format!("row-5-newer-overlap-{overlap_index}"))
                .unwrap()
                .is_none()
        );
    }
}

#[test]
#[ignore = "run through pnpm kernel:full-key-free:test after building the Node worker"]
fn rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("kernel.redb");
    let (kernel, created) = create_projected_kernel(&database_path).unwrap();
    assert_eq!(created.generation, 0);

    let first = ClientActor::new("agent:rows-6-7-11-first", "events:rows-6-7-11-first");
    let queued = ClientActor::new("agent:rows-6-7-11-queued", "events:rows-6-7-11-queued");
    let mut observer =
        ClientActor::new("agent:rows-6-7-11-observer", "events:rows-6-7-11-observer");
    let first_offer = ready(submit_rename(
        &first,
        &kernel,
        "rows-6-7-11-first",
        USER_DECLARATION_ID,
        "Account",
        0,
    ));
    let old_claim = claim(&first, &kernel, &first_offer, 2);
    let SubmissionOutcome::Queued { .. } = submit_rename(
        &queued,
        &kernel,
        "rows-6-7-11-queued",
        USER_DECLARATION_ID,
        "Customer",
        1,
    ) else {
        panic!("the second real client must be durably queued")
    };
    let first_ticket_id = kernel
        .ticket_for_change_set("rows-6-7-11-first")
        .unwrap()
        .unwrap()
        .ticket_id;
    let queued_ticket_id = kernel
        .ticket_for_change_set("rows-6-7-11-queued")
        .unwrap()
        .unwrap()
        .ticket_id;
    let events_before_restart = observer.read_events(&kernel, 100).unwrap();
    assert!(!events_before_restart.is_empty());
    assert_eq!(observer.acknowledged_event_sequence(), 0);
    let old_epoch = old_claim.service_epoch;
    drop(kernel);

    let (reopened, recovered) = reopen_projected_kernel(&database_path).unwrap();
    assert!(recovered.service_epoch > old_epoch);
    assert_eq!(
        reopened
            .ticket_for_change_set("rows-6-7-11-first")
            .unwrap()
            .unwrap()
            .ticket_id,
        first_ticket_id
    );
    let recovered_queued = reopened
        .ticket_for_change_set("rows-6-7-11-queued")
        .unwrap()
        .unwrap();
    assert_eq!(recovered_queued.ticket_id, queued_ticket_id);
    assert_eq!(recovered_queued.state, TicketState::Queued);

    let before_stale_attempt = reopened.snapshot().digest().to_owned();
    let stale_error = first
        .execute_claimed(&reopened, &old_claim, 3)
        .unwrap_err()
        .to_string();
    assert!(
        stale_error.contains("claim")
            || stale_error.contains("epoch")
            || stale_error.contains("lease has expired"),
        "old real claim must be rejected by recovered authority: {stale_error}"
    );
    assert_eq!(reopened.snapshot().generation(), 0);
    assert_eq!(reopened.snapshot().digest(), before_stale_attempt);
    assert!(reopened.operation(1).unwrap().is_none());

    let delivery_one = observer.read_events(&reopened, 100).unwrap();
    let delivery_two = observer.read_events(&reopened, 100).unwrap();
    assert_eq!(
        delivery_one, delivery_two,
        "redelivery before acknowledgement is stable"
    );
    assert_eq!(
        &delivery_one[..events_before_restart.len()],
        events_before_restart.as_slice(),
        "unacknowledged event IDs and payloads must survive restart"
    );
    let delivered_ids = delivery_one
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(delivered_ids.len(), delivery_one.len());
    let acknowledged = delivery_one.last().unwrap().sequence;
    let first_ack = observer
        .acknowledge_events(&reopened, acknowledged)
        .unwrap();
    let duplicate_ack = observer
        .acknowledge_events(&reopened, acknowledged)
        .unwrap();
    let older_ack = observer
        .acknowledge_events(&reopened, acknowledged.saturating_sub(1))
        .unwrap();
    assert_eq!(first_ack, duplicate_ack);
    assert_eq!(older_ack.acknowledged_sequence, acknowledged);
    assert!(observer.read_events(&reopened, 100).unwrap().is_empty());

    let fresh_offer = reopened
        .ready_offer_for_change_set("rows-6-7-11-first")
        .unwrap()
        .expect("restart must issue fresh authority for the oldest recovered ticket");
    assert_ne!(fresh_offer.service_epoch, old_claim.service_epoch);
    let fresh_claim = claim(&first, &reopened, &fresh_offer, 4);
    let first_publish = published(first.execute_claimed(&reopened, &fresh_claim, 5).unwrap());
    assert_eq!(first_publish.generation, 1);
    assert!(!first_publish.already_published);
    let duplicate_publish = published(first.execute_claimed(&reopened, &fresh_claim, 6).unwrap());
    assert_eq!(duplicate_publish.generation, 1);
    assert!(duplicate_publish.already_published);
    assert_eq!(reopened.snapshot().generation(), 1);
    assert!(reopened.operation(2).unwrap().is_none());
    assert_eq!(
        (1..=reopened.snapshot().generation())
            .filter_map(|generation| reopened.operation(generation).unwrap())
            .filter(|operation| operation.change_set_id == "rows-6-7-11-first")
            .count(),
        1
    );
    let committed_events = reopened
        .events_after("events:rows-6-7-11-audit", 0, 100)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.change_set_id == "rows-6-7-11-first"
                && event.kind == CoordinationEventKind::IntentCommitted
        })
        .count();
    assert_eq!(committed_events, 1);
    assert_projected_typescript_green(&reopened.snapshot().snapshot());
}
