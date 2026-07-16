#![cfg(all(feature = "coordination-test-api", feature = "redb-spike-api"))]

#[path = "support/full_key_free.rs"]
mod full_key_free_support;

use full_key_free_support::{
    CanonicalFinalState, ClientActor, assert_canonical_final_state,
    assert_projected_typescript_green, create_projected_kernel, reopen_projected_kernel,
};
use strata_kernel::{
    ClaimOutcome, IntentParameters, PublishClaimOutcome, SubmissionOutcome, TicketState,
};
use tempfile::tempdir;

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
