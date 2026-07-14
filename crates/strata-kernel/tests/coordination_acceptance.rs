#[path = "support/coordination.rs"]
mod coordination_support;

use std::collections::BTreeSet;

use coordination_support::{
    FixedDeltaBuilder, GraphDerivedAnalyzer, MediumCoordinationFixture, NodePatchBuilder,
    ScriptedCallsite, begin_with_intents, declaration_name, rename,
};
use serde::Serialize;
use strata_kernel::{
    BeginChangeSet, ChangeSetState, ClaimHandle, ClaimOutcome, CoordinationEventKind, GraphChange,
    GraphDelta, GraphGeneration, IntentParameters, IntentRecord, Kernel,
    MAX_WAKE_AFFECTED_NODE_IDS, ReferenceRecord, SCHEMA_VERSION, SubmissionOutcome, TicketState,
    analyze_change_set,
};
use tempfile::tempdir;

#[cfg(feature = "redb-spike-api")]
use strata_kernel::CoordinatedPublishFailpoint;

#[test]
fn scheduler_acceptance_uses_the_real_examples_medium_graph() {
    let fixture = MediumCoordinationFixture::load();
    assert!(fixture.snapshot().nodes.len() > 1_000);
    assert!(fixture.snapshot().references.len() > 500);
}

fn intent(id: &str, parameters: IntentParameters) -> IntentRecord {
    IntentRecord::new(SCHEMA_VERSION, id, "scope-probe", 0, parameters).unwrap()
}

fn ready(outcome: SubmissionOutcome) -> strata_kernel::ReadyOffer {
    match outcome {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected Ready, got {other:?}"),
    }
}

fn claimed(outcome: ClaimOutcome) -> ClaimHandle {
    match outcome {
        ClaimOutcome::Claimed(claim) => claim,
        other => panic!("expected Claimed, got {other:?}"),
    }
}

fn reservation_set(scope: &strata_kernel::InferredScope) -> BTreeSet<&str> {
    scope.reservation_keys.iter().map(String::as_str).collect()
}

fn resource_set(resources: &[strata_kernel::ResourceVersion]) -> BTreeSet<(&str, &str)> {
    resources
        .iter()
        .map(|resource| (resource.resource_key.as_str(), resource.version.as_str()))
        .collect()
}

#[test]
fn analyzer_is_intent_and_graph_derived_and_client_inputs_are_key_free() {
    let fixture = MediumCoordinationFixture::load();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::new();
    let user = fixture.declaration_named("User");
    let user_repo = fixture.declaration_named("UserRepo");
    let parse_args = fixture.declaration_named("parseArgs");
    let number_option = fixture.declaration_named("numberOption");

    let user_scope = analyze_change_set(
        &graph,
        &[intent("rename-user", rename(&user.id, "Account"))],
        &analyzer,
    )
    .unwrap();
    let repo_scope = analyze_change_set(
        &graph,
        &[intent("rename-repo", rename(&user_repo.id, "AccountRepo"))],
        &analyzer,
    )
    .unwrap();
    assert_ne!(user_scope.scope_fingerprint, repo_scope.scope_fingerprint);
    assert_ne!(user_scope.reservation_keys, repo_scope.reservation_keys);

    let parse_scope = analyze_change_set(
        &graph,
        &[intent(
            "parameter-parse",
            coordination_support::add_parameter(&parse_args.id),
        )],
        &analyzer,
    )
    .unwrap();
    let number_scope = analyze_change_set(
        &graph,
        &[intent(
            "parameter-number",
            coordination_support::add_parameter(&number_option.id),
        )],
        &analyzer,
    )
    .unwrap();
    assert_ne!(
        parse_scope.scope_fingerprint,
        number_scope.scope_fingerprint
    );

    for unknown in [
        rename("missing:declaration", "Nope"),
        coordination_support::add_parameter("missing:function"),
    ] {
        let error =
            analyze_change_set(&graph, &[intent("unknown", unknown)], &analyzer).unwrap_err();
        assert!(error.to_string().contains("unknown"));
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SubmitInput<'a> {
        change_set_id: &'a str,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AddIntentInput<'a> {
        change_set_id: &'a str,
        parameters: IntentParameters,
    }
    let client_inputs = [
        serde_json::to_value(BeginChangeSet {
            change_set_id: "client-input".into(),
            actor: "agent:client".into(),
            reasoning: "rename a declaration".into(),
            submission_idempotency_key: "submission:client-input".into(),
        })
        .unwrap(),
        serde_json::to_value(AddIntentInput {
            change_set_id: "client-input",
            parameters: rename(&user.id, "Account"),
        })
        .unwrap(),
        serde_json::to_value(SubmitInput {
            change_set_id: "client-input",
        })
        .unwrap(),
    ];
    let encoded = serde_json::to_string(&client_inputs).unwrap();
    for forbidden in [
        "reservationKeys",
        "scopeFingerprint",
        "fence",
        "claimToken",
        "resourceTokens",
    ] {
        assert!(!encoded.contains(forbidden), "client supplied {forbidden}");
    }
}

#[test]
fn disjoint_work_is_ready_together_and_commits_after_fresh_claims_in_either_order() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();

    for order in [["user", "parse"], ["parse", "user"]] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("kernel.redb");
        let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
        let analyzer = GraphDerivedAnalyzer::new();
        begin_with_intents(&kernel, "user", [rename(&user_id, "Account")]).unwrap();
        begin_with_intents(&kernel, "parse", [rename(&parse_id, "parseTokens")]).unwrap();
        let user_offer = ready(kernel.submit_change_set("user", &analyzer, 0).unwrap());
        let parse_offer = ready(kernel.submit_change_set("parse", &analyzer, 0).unwrap());
        let user_scope = kernel
            .change_set("user")
            .unwrap()
            .unwrap()
            .inferred_scope
            .unwrap();
        let parse_scope = kernel
            .change_set("parse")
            .unwrap()
            .unwrap()
            .inferred_scope
            .unwrap();
        assert!(reservation_set(&user_scope).is_disjoint(&reservation_set(&parse_scope)));

        for (index, id) in order.into_iter().enumerate() {
            let (offer, node_id) = if id == "user" {
                (&user_offer, &user_id)
            } else {
                (&parse_offer, &parse_id)
            };
            let claim = claimed(
                kernel
                    .claim_ready(
                        &offer.offer_id,
                        &offer.claim_token,
                        &analyzer,
                        1 + index as u64,
                    )
                    .unwrap(),
            );
            assert_eq!(claim.graph_generation, index as u64);
            let report = kernel
                .publish_claimed(
                    &claim,
                    &analyzer,
                    &NodePatchBuilder::new(vec![(node_id.clone(), format!("\n// committed-{id}"))]),
                    10 + index as u64,
                )
                .unwrap();
            assert_eq!(report.generation, index as u64 + 1);
        }
        assert_eq!(kernel.snapshot().generation(), 2);
        assert_eq!(
            kernel.change_set("user").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
        assert_eq!(
            kernel.change_set("parse").unwrap().unwrap().state,
            ChangeSetState::Committed
        );
    }
}

#[test]
fn same_symbol_is_fifo_then_wakes_with_bounded_context_and_needs_fresh_decision() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::new();

    begin_with_intents(&kernel, "first", [rename(&user_id, "Account")]).unwrap();
    let first_offer = ready(kernel.submit_change_set("first", &analyzer, 0).unwrap());
    let first_claim = claimed(
        kernel
            .claim_ready(
                &first_offer.offer_id,
                &first_offer.claim_token,
                &analyzer,
                1,
            )
            .unwrap(),
    );
    begin_with_intents(&kernel, "second", [rename(&user_id, "Customer")]).unwrap();
    let SubmissionOutcome::Queued { ticket } =
        kernel.submit_change_set("second", &analyzer, 1).unwrap()
    else {
        panic!("same-symbol successor must queue")
    };
    assert_eq!(ticket.state, TicketState::Queued);

    kernel
        .publish_claimed(
            &first_claim,
            &analyzer,
            &NodePatchBuilder::new(vec![(user_id.clone(), "\n// Account".into())]),
            2,
        )
        .unwrap();
    let second_offer = kernel
        .ready_offer_for_change_set("second")
        .unwrap()
        .expect("first commit must atomically wake the successor");
    let events = kernel.events_after("same-symbol-audit", 0, 100).unwrap();
    let ready_event = events
        .iter()
        .rev()
        .find(|event| {
            event.change_set_id == "second" && event.kind == CoordinationEventKind::IntentReady
        })
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&ready_event.payload_json).unwrap();
    assert!(payload["blockingOperationId"].as_str().is_some());
    assert_eq!(payload["beforeGeneration"], 0);
    assert_eq!(payload["afterGeneration"], 1);
    assert!(payload["affectedNodeIds"].as_array().unwrap().len() <= MAX_WAKE_AFFECTED_NODE_IDS);
    assert!(payload["totalAffectedNodeCount"].as_u64().is_some());
    assert!(payload["affectedNodeIdsTruncated"].as_bool().is_some());
    let outcome = kernel
        .claim_ready(
            &second_offer.offer_id,
            &second_offer.claim_token,
            &analyzer,
            3,
        )
        .unwrap();
    let ClaimOutcome::NeedsDecision { change_set, event } = outcome else {
        panic!("stale same-symbol rename must require a fresh decision")
    };
    assert_eq!(change_set.state, ChangeSetState::NeedsDecision);
    assert_eq!(event.kind, CoordinationEventKind::IntentNeedsDecision);
    assert_ne!(
        change_set
            .inferred_scope
            .as_ref()
            .unwrap()
            .scope_fingerprint,
        second_offer.scope_fingerprint,
        "claim-time analysis must persist a fresh fingerprint"
    );
    assert!(
        !kernel
            .snapshot()
            .node(&user_id)
            .unwrap()
            .payload
            .contains("Customer")
    );
}

#[test]
fn reference_overlap_and_claim_time_callsite_expansion_are_inferred_before_mutation() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let greet_id = fixture.declaration_named("greet").id.clone();
    let extra_callsite = fixture.reference_source_for("formatTimestamp").id.clone();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::with_scripted_callsite(ScriptedCallsite {
        function_id: greet_id.clone(),
        node_id: extra_callsite.clone(),
        appears_after_generation: 1,
    });
    let rename_scope = analyze_change_set(
        &graph,
        &[intent("rename-user", rename(&user_id, "Account"))],
        &analyzer,
    )
    .unwrap();
    let parameter_scope = analyze_change_set(
        &graph,
        &[intent(
            "parameter-greet",
            coordination_support::add_parameter(&greet_id),
        )],
        &analyzer,
    )
    .unwrap();
    let overlap: Vec<_> = reservation_set(&rename_scope)
        .intersection(&reservation_set(&parameter_scope))
        .copied()
        .collect();
    assert!(
        !overlap.is_empty(),
        "greet's graph-derived User reference must overlap the User rename"
    );

    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    begin_with_intents(&kernel, "blocker", [rename(&user_id, "Account")]).unwrap();
    let blocker_offer = ready(kernel.submit_change_set("blocker", &analyzer, 0).unwrap());
    let blocker_claim = claimed(
        kernel
            .claim_ready(
                &blocker_offer.offer_id,
                &blocker_offer.claim_token,
                &analyzer,
                0,
            )
            .unwrap(),
    );
    begin_with_intents(
        &kernel,
        "expanding",
        [coordination_support::add_parameter(&greet_id)],
    )
    .unwrap();
    let SubmissionOutcome::Queued { ticket } =
        kernel.submit_change_set("expanding", &analyzer, 0).unwrap()
    else {
        panic!("reference-overlapping add-parameter must queue")
    };
    let old_scope = kernel
        .change_set("expanding")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert!(
        !old_scope
            .reservation_keys
            .contains(&format!("node:{extra_callsite}"))
    );
    assert_eq!(ticket.state, TicketState::Queued);

    kernel
        .publish_claimed(
            &blocker_claim,
            &analyzer,
            &NodePatchBuilder::new(vec![(user_id, "\n// rename blocker".into())]),
            1,
        )
        .unwrap();
    let expanding_offer = kernel
        .ready_offer_for_change_set("expanding")
        .unwrap()
        .unwrap();
    let unused_old_candidate = NodePatchBuilder::new(vec![(
        greet_id.clone(),
        "\n// stale add-parameter candidate".into(),
    )]);
    let outcome = kernel
        .claim_ready(
            &expanding_offer.offer_id,
            &expanding_offer.claim_token,
            &analyzer,
            2,
        )
        .unwrap();
    let ClaimOutcome::Requeued { ticket, event } = outcome else {
        panic!("new callsite must expand and requeue before execution")
    };
    assert_eq!(ticket.state, TicketState::Queued);
    assert_eq!(event.kind, CoordinationEventKind::ScopeExpanded);
    assert_eq!(unused_old_candidate.calls(), 0);
    assert_eq!(kernel.snapshot().generation(), 1);
    assert!(
        !kernel
            .snapshot()
            .node(&greet_id)
            .unwrap()
            .payload
            .contains("stale")
    );
    let new_scope = kernel
        .change_set("expanding")
        .unwrap()
        .unwrap()
        .inferred_scope
        .unwrap();
    assert!(
        new_scope
            .reservation_keys
            .contains(&format!("node:{extra_callsite}"))
    );
    assert!(reservation_set(&old_scope).is_subset(&reservation_set(&new_scope)));
    assert!(resource_set(&old_scope.read_set).is_subset(&resource_set(&new_scope.read_set)));
    assert!(resource_set(&old_scope.write_set).is_subset(&resource_set(&new_scope.write_set)));
    assert!(
        resource_set(&old_scope.validation_set).is_subset(&resource_set(&new_scope.validation_set))
    );
}

#[test]
fn malicious_node_and_reference_deltas_are_contained_with_zero_side_effects() {
    let fixture = MediumCoordinationFixture::load();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let rogue_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::new();
    begin_with_intents(&kernel, "contained", [rename(&parse_id, "parseTokens")]).unwrap();
    let offer = ready(kernel.submit_change_set("contained", &analyzer, 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, &analyzer, 1)
            .unwrap(),
    );

    let before_digest = kernel.snapshot().digest().to_owned();
    let before_events = kernel.events_after("containment-audit", 0, 100).unwrap();
    let before_change_set = kernel.change_set("contained").unwrap().unwrap();
    let before_ticket = kernel.ticket_for_change_set("contained").unwrap().unwrap();

    let mut rogue_node = kernel.snapshot().node(&rogue_id).unwrap().clone();
    rogue_node.payload.push_str("\n// unauthorized");
    let node_delta = GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes: vec![GraphChange::UpsertNode { node: rogue_node }],
    };
    let error = kernel
        .publish_claimed(&claim, &analyzer, &FixedDeltaBuilder(node_delta), 2)
        .unwrap_err();
    assert!(error.to_string().contains("outside inferred scope"));

    let original_reference = fixture.snapshot().references[0].clone();
    let replacement_target = fixture
        .snapshot()
        .nodes
        .iter()
        .find(|node| node.id != original_reference.to_node_id)
        .unwrap();
    let reference_delta = GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes: vec![GraphChange::UpsertReference {
            reference: ReferenceRecord {
                to_node_id: replacement_target.id.clone(),
                ..original_reference
            },
        }],
    };
    let error = kernel
        .publish_claimed(&claim, &analyzer, &FixedDeltaBuilder(reference_delta), 3)
        .unwrap_err();
    assert!(error.to_string().contains("outside inferred scope"));

    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(kernel.snapshot().digest(), before_digest);
    assert_eq!(
        kernel.events_after("containment-audit", 0, 100).unwrap(),
        before_events
    );
    assert_eq!(
        kernel.change_set("contained").unwrap().unwrap(),
        before_change_set
    );
    assert_eq!(
        kernel.ticket_for_change_set("contained").unwrap().unwrap(),
        before_ticket
    );
    assert!(kernel.operation(1).unwrap().is_none());
}

#[test]
fn older_wide_ticket_ages_without_starvation_while_only_disjoint_work_passes() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let analyzer = GraphDerivedAnalyzer::new();
    let graph = GraphGeneration::from_snapshot(fixture.snapshot().clone()).unwrap();
    let wide_scope = analyze_change_set(
        &graph,
        &[
            intent("wide-user", rename(&user_id, "Account")),
            intent("wide-parse", rename(&parse_id, "parseTokens")),
        ],
        &analyzer,
    )
    .unwrap();
    let wide_keys = reservation_set(&wide_scope);
    let disjoint_ids: Vec<_> = fixture
        .top_level_declarations()
        .filter(|node| node.id != user_id && node.id != parse_id)
        .filter_map(|node| {
            let scope = analyze_change_set(
                &graph,
                &[intent(
                    &format!("probe-{}", node.id),
                    rename(&node.id, &format!("{}Acceptance", declaration_name(node)?)),
                )],
                &analyzer,
            )
            .ok()?;
            reservation_set(&scope)
                .is_disjoint(&wide_keys)
                .then(|| node.id.clone())
        })
        .take(5)
        .collect();
    assert_eq!(
        disjoint_ids.len(),
        5,
        "real corpus needs five disjoint targets"
    );

    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    begin_with_intents(&kernel, "active-small", [rename(&user_id, "HeldUser")]).unwrap();
    let _active_offer = ready(
        kernel
            .submit_change_set("active-small", &analyzer, 0)
            .unwrap(),
    );
    begin_with_intents(
        &kernel,
        "older-wide",
        [rename(&user_id, "WideUser"), rename(&parse_id, "wideParse")],
    )
    .unwrap();
    assert!(matches!(
        kernel
            .submit_change_set("older-wide", &analyzer, 0)
            .unwrap(),
        SubmissionOutcome::Queued { .. }
    ));

    let mut overlapping_ids = Vec::new();
    for index in 0..10 {
        if index % 2 == 0 {
            let id = format!("newer-overlap-{index}");
            begin_with_intents(&kernel, &id, [rename(&user_id, &format!("User{index}"))]).unwrap();
            assert!(matches!(
                kernel
                    .submit_change_set(&id, &analyzer, index as u64 + 1)
                    .unwrap(),
                SubmissionOutcome::Queued { .. }
            ));
            overlapping_ids.push(id);
        } else {
            let node_id = disjoint_ids[index / 2].clone();
            let id = format!("newer-disjoint-{index}");
            begin_with_intents(
                &kernel,
                &id,
                [rename(&node_id, &format!("Disjoint{index}"))],
            )
            .unwrap();
            let offer = ready(
                kernel
                    .submit_change_set(&id, &analyzer, index as u64 + 1)
                    .unwrap(),
            );
            let claim = claimed(
                kernel
                    .claim_ready(
                        &offer.offer_id,
                        &offer.claim_token,
                        &analyzer,
                        index as u64 + 2,
                    )
                    .unwrap(),
            );
            kernel
                .publish_claimed(
                    &claim,
                    &analyzer,
                    &NodePatchBuilder::new(vec![(node_id, format!("\n// disjoint-{index}"))]),
                    index as u64 + 3,
                )
                .unwrap();
        }
    }
    let wide_ticket = kernel.ticket_for_change_set("older-wide").unwrap().unwrap();
    assert!(wide_ticket.age_rounds > 0);
    assert_eq!(wide_ticket.state, TicketState::Queued);
    assert!(
        overlapping_ids
            .iter()
            .all(|id| kernel.ready_offer_for_change_set(id).unwrap().is_none())
    );

    let cancellation = kernel.cancel_change_set("active-small", 50).unwrap();
    let wide_offer = cancellation
        .ready_offers
        .into_iter()
        .find(|offer| offer.change_set_id == "older-wide")
        .expect("the oldest wide ticket must be offered immediately on release");
    let wide_claim = claimed(
        kernel
            .claim_ready(&wide_offer.offer_id, &wide_offer.claim_token, &analyzer, 51)
            .unwrap(),
    );
    assert_eq!(wide_claim.change_set_id, "older-wide");
    assert!(
        overlapping_ids
            .iter()
            .all(|id| kernel.ready_offer_for_change_set(id).unwrap().is_none())
    );
}

#[test]
fn restart_preserves_ticket_event_identity_invalidates_offers_and_keeps_cursors_independent() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let analyzer = GraphDerivedAnalyzer::new();
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    begin_with_intents(
        &kernel,
        "ready-before-restart",
        [rename(&user_id, "Account")],
    )
    .unwrap();
    let old_offer = ready(
        kernel
            .submit_change_set("ready-before-restart", &analyzer, 0)
            .unwrap(),
    );
    begin_with_intents(
        &kernel,
        "queued-before-restart",
        [rename(&user_id, "Customer")],
    )
    .unwrap();
    assert!(matches!(
        kernel
            .submit_change_set("queued-before-restart", &analyzer, 0)
            .unwrap(),
        SubmissionOutcome::Queued { .. }
    ));
    let ready_ticket_id = kernel
        .ticket_for_change_set("ready-before-restart")
        .unwrap()
        .unwrap()
        .ticket_id;
    let queued_ticket_id = kernel
        .ticket_for_change_set("queued-before-restart")
        .unwrap()
        .unwrap()
        .ticket_id;
    let before_events = kernel.events_after("client-a", 0, 100).unwrap();
    let before_event_ids: Vec<_> = before_events
        .iter()
        .map(|event| event.event_id.clone())
        .collect();
    drop(kernel);

    let (reopened, report) = Kernel::open(&path).unwrap();
    assert!(report.service_epoch > old_offer.service_epoch);
    assert_eq!(
        reopened
            .ticket_for_change_set("ready-before-restart")
            .unwrap()
            .unwrap()
            .ticket_id,
        ready_ticket_id
    );
    assert_eq!(
        reopened
            .ticket_for_change_set("queued-before-restart")
            .unwrap()
            .unwrap()
            .ticket_id,
        queued_ticket_id
    );
    assert!(
        reopened
            .ready_offer_for_change_set("ready-before-restart")
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .claim_ready(&old_offer.offer_id, &old_offer.claim_token, &analyzer, 1)
            .unwrap_err()
            .to_string()
            .contains("does not exist")
    );

    let delivery_one = reopened.events_after("client-a", 0, 100).unwrap();
    let delivery_two = reopened.events_after("client-a", 0, 100).unwrap();
    assert_eq!(
        serde_json::to_vec(&delivery_one).unwrap(),
        serde_json::to_vec(&delivery_two).unwrap()
    );
    assert!(delivery_one.len() > before_events.len());
    assert_eq!(
        &delivery_one[..before_event_ids.len()]
            .iter()
            .map(|event| event.event_id.clone())
            .collect::<Vec<_>>(),
        &before_event_ids
    );
    assert!(delivery_one.iter().any(|event| {
        event.change_set_id == "ready-before-restart"
            && event.kind == CoordinationEventKind::LeaseExpired
    }));

    let acknowledged = delivery_one[1].sequence;
    reopened.ack_events("client-a", acknowledged).unwrap();
    let remaining_a = reopened.events_after("client-a", 0, 100).unwrap();
    assert!(
        remaining_a
            .iter()
            .all(|event| event.sequence > acknowledged)
    );
    let full_b = reopened.events_after("client-b", 0, 100).unwrap();
    assert_eq!(full_b, delivery_one);
}

#[test]
fn composite_change_set_publishes_two_real_nodes_in_exactly_one_generation() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::new();
    begin_with_intents(
        &kernel,
        "composite",
        [
            rename(&user_id, "Account"),
            rename(&parse_id, "parseTokens"),
        ],
    )
    .unwrap();
    let offer = ready(kernel.submit_change_set("composite", &analyzer, 0).unwrap());
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, &analyzer, 1)
            .unwrap(),
    );
    let report = kernel
        .publish_claimed(
            &claim,
            &analyzer,
            &NodePatchBuilder::new(vec![
                (user_id.clone(), "\n// composite-user".into()),
                (parse_id.clone(), "\n// composite-parse".into()),
            ]),
            2,
        )
        .unwrap();
    assert_eq!(report.generation, 1);
    assert_eq!(kernel.snapshot().generation(), 1);
    assert!(
        kernel
            .snapshot()
            .node(&user_id)
            .unwrap()
            .payload
            .contains("composite-user")
    );
    assert!(
        kernel
            .snapshot()
            .node(&parse_id)
            .unwrap()
            .payload
            .contains("composite-parse")
    );
    let operation = kernel.operation(1).unwrap().unwrap();
    assert_eq!(operation.change_set_id, "composite");
    assert_eq!(operation.kind, "CompositeChangeSet(2)");
    assert_eq!(operation.affected_node_ids.len(), 2);
    assert_eq!(
        kernel
            .ticket_for_change_set("composite")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Completed
    );
}

#[cfg(feature = "redb-spike-api")]
#[test]
fn composite_precommit_failure_exposes_neither_real_node_change() {
    let fixture = MediumCoordinationFixture::load();
    let user_id = fixture.declaration_named("User").id.clone();
    let parse_id = fixture.declaration_named("parseArgs").id.clone();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (kernel, _) = Kernel::create(&path, fixture.snapshot().clone()).unwrap();
    let analyzer = GraphDerivedAnalyzer::new();
    begin_with_intents(
        &kernel,
        "composite-failure",
        [
            rename(&user_id, "Account"),
            rename(&parse_id, "parseTokens"),
        ],
    )
    .unwrap();
    let offer = ready(
        kernel
            .submit_change_set("composite-failure", &analyzer, 0)
            .unwrap(),
    );
    let claim = claimed(
        kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, &analyzer, 1)
            .unwrap(),
    );
    let before_digest = kernel.snapshot().digest().to_owned();
    let before_events = kernel
        .events_after("composite-failure-audit", 0, 100)
        .unwrap();
    let builder = NodePatchBuilder::new(vec![
        (user_id.clone(), "\n// must-not-appear-user".into()),
        (parse_id.clone(), "\n// must-not-appear-parse".into()),
    ]);
    assert!(
        kernel
            .publish_claimed_with_failpoint(
                &claim,
                &analyzer,
                &builder,
                2,
                CoordinatedPublishFailpoint::BeforeCommit,
            )
            .is_err()
    );
    assert_eq!(kernel.snapshot().generation(), 0);
    assert_eq!(kernel.snapshot().digest(), before_digest);
    assert!(
        !kernel
            .snapshot()
            .node(&user_id)
            .unwrap()
            .payload
            .contains("must-not")
    );
    assert!(
        !kernel
            .snapshot()
            .node(&parse_id)
            .unwrap()
            .payload
            .contains("must-not")
    );
    assert_eq!(
        kernel
            .events_after("composite-failure-audit", 0, 100)
            .unwrap(),
        before_events
    );
    assert!(kernel.operation(1).unwrap().is_none());
    assert_eq!(
        kernel
            .change_set("composite-failure")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Executing
    );
    assert_eq!(
        kernel
            .ticket_for_change_set("composite-failure")
            .unwrap()
            .unwrap()
            .state,
        TicketState::Claimed
    );
    for key in &claim.reservation_keys {
        assert_eq!(kernel.fence_state(key).unwrap(), (None, None));
    }
}
