#![cfg(feature = "coordination-test-api")]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use strata_kernel::{
    BeginChangeSet, CandidateBuilder, CandidateEnvelope, ChangeSetState, ClaimOutcome,
    CoordinationError, CoordinationEventKind, DRAFT_TTL_TICKS, DynamicExpansionPolicy, GraphDelta,
    GraphGeneration, GraphSnapshot, IdempotencyClass, IntentAnalysis, IntentParameters,
    IntentRecord, Kernel, PreparedCandidate, ResourceVersion, SCHEMA_VERSION, SubmissionOutcome,
    TestSemanticProvider,
};
use tempfile::tempdir;

#[derive(Default)]
struct CountingProvider {
    calls: AtomicUsize,
    expanded: std::sync::atomic::AtomicBool,
}

impl CountingProvider {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn set_expanded(&self, expanded: bool) {
        self.expanded.store(expanded, Ordering::SeqCst);
    }
}

impl TestSemanticProvider for CountingProvider {
    fn analyze(
        &self,
        _graph: &GraphGeneration,
        intent: &IntentRecord,
    ) -> anyhow::Result<IntentAnalysis> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let IntentParameters::RenameSymbol { declaration_id, .. } = &intent.parameters else {
            anyhow::bail!("lease provider only supports rename")
        };
        let key = format!("symbol:{declaration_id}");
        let mut keys = vec![key];
        if self.expanded.load(Ordering::SeqCst) {
            keys.push(format!("node:{declaration_id}:expanded"));
        }
        let resources = keys
            .iter()
            .map(|key| ResourceVersion::new(key, "stable").unwrap())
            .collect::<Vec<_>>();
        Ok(IntentAnalysis {
            read_set: resources.clone(),
            write_set: resources.clone(),
            validation_set: resources,
            reservation_keys: keys,
            dynamic_expansion_policy: DynamicExpansionPolicy::Requeue { max_expansions: 3 },
            idempotency_class: IdempotencyClass::ReplaySafe,
        })
    }
}

struct EmptyBuilder;

impl CandidateBuilder for EmptyBuilder {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope> {
        CandidateEnvelope::from_delta(GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: prepared.graph().generation(),
            changes: vec![],
        })
    }
}

fn kernel(provider: Arc<CountingProvider>) -> (tempfile::TempDir, Kernel) {
    let directory = tempdir().unwrap();
    let (kernel, _) = Kernel::create_with_test_semantics(
        directory.path().join("kernel.redb"),
        serde_json::from_str::<GraphSnapshot>(include_str!(
            "fixtures/examples-medium.snapshot.json"
        ))
        .unwrap(),
        provider,
    )
    .unwrap();
    (directory, kernel)
}

fn begin_and_submit(kernel: &Kernel, id: &str, target: &str, now_tick: u64) -> SubmissionOutcome {
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: id.into(),
                actor: "agent:lease".into(),
                reasoning: "exercise deterministic leases".into(),
                submission_idempotency_key: format!("submission:{id}"),
            },
            now_tick,
        )
        .unwrap();
    kernel
        .add_intent(
            id,
            IntentParameters::RenameSymbol {
                declaration_id: target.into(),
                new_name: format!("{target}:renamed"),
            },
        )
        .unwrap();
    kernel.submit_change_set(id, now_tick).unwrap()
}

#[test]
fn drafts_have_deterministic_expiry_and_are_retained_as_cancelled_audit_records() {
    let directory = tempdir().unwrap();
    let (kernel, _) = Kernel::create(
        directory.path().join("kernel.redb"),
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        },
    )
    .unwrap();
    let created = kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:draft".into(),
                actor: "agent:lease".into(),
                reasoning: "expire a draft".into(),
                submission_idempotency_key: "submission:draft".into(),
            },
            7,
        )
        .unwrap();
    assert_eq!(created.created_at_tick, 7);
    assert_eq!(created.expires_at_tick, Some(7 + DRAFT_TTL_TICKS));

    assert!(
        kernel
            .expire_leases(7 + DRAFT_TTL_TICKS - 1)
            .unwrap()
            .is_empty()
    );
    let expired = kernel.expire_leases(7 + DRAFT_TTL_TICKS).unwrap();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].change_set_id, "change:draft");
    let retained = kernel.change_set("change:draft").unwrap().unwrap();
    assert_eq!(retained.state, ChangeSetState::Cancelled);
    assert!(retained.expires_at_tick.is_none());
    let event = kernel.events_after("audit", 0, 10).unwrap().pop().unwrap();
    assert_eq!(event.kind, CoordinationEventKind::LeaseExpired);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&event.payload_json).unwrap(),
        serde_json::json!({"authorityKind":"draft","reason":"draft-expired"}),
    );
    assert!(kernel.expire_leases(u64::MAX).unwrap().is_empty());
}

#[test]
fn an_expired_draft_cannot_be_revived_by_submission() {
    let directory = tempdir().unwrap();
    let (kernel, _) = Kernel::create(
        directory.path().join("kernel.redb"),
        GraphSnapshot {
            schema_version: SCHEMA_VERSION,
            generation: 0,
            nodes: vec![],
            references: vec![],
        },
    )
    .unwrap();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:expired-submit".into(),
                actor: "agent:lease".into(),
                reasoning: "submission must not revive an expired draft".into(),
                submission_idempotency_key: "submission:expired-submit".into(),
            },
            5,
        )
        .unwrap();
    kernel
        .add_intent(
            "change:expired-submit",
            IntentParameters::RenameSymbol {
                declaration_id: "expired".into(),
                new_name: "Expired".into(),
            },
        )
        .unwrap();

    let error = kernel
        .submit_change_set("change:expired-submit", 5 + DRAFT_TTL_TICKS)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::LeaseExpired)
    );
    assert_eq!(
        kernel
            .change_set("change:expired-submit")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Cancelled
    );
}

#[test]
fn claim_expiry_fences_late_results_and_freshly_wakes_waiters() {
    let provider = Arc::new(CountingProvider::default());
    let (_directory, kernel) = kernel(provider.clone());
    let first_offer = match begin_and_submit(&kernel, "change:first", "shared", 1) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected first Ready offer, got {other:?}"),
    };
    let first_claim = match kernel
        .claim_ready(&first_offer.offer_id, &first_offer.claim_token, 2)
        .unwrap()
    {
        ClaimOutcome::Claimed(claim) => claim,
        other => panic!("expected first claim, got {other:?}"),
    };
    assert!(!first_claim.attempt_id.is_empty());
    assert!(first_claim.expires_at_tick > 2);
    assert!(!first_claim.dependency_versions.is_empty());

    assert!(matches!(
        begin_and_submit(&kernel, "change:waiter", "shared", 3),
        SubmissionOutcome::Queued { .. }
    ));
    provider.set_expanded(true);
    let calls_before = provider.calls();
    let outcomes = kernel.expire_leases(first_claim.expires_at_tick).unwrap();
    assert!(
        outcomes
            .iter()
            .any(|outcome| outcome.change_set_id == first_claim.change_set_id)
    );
    assert!(provider.calls() > calls_before);
    assert_eq!(
        kernel
            .change_set(&first_claim.change_set_id)
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Queued,
    );
    let waiter_offer = kernel
        .ready_offer_for_change_set("change:waiter")
        .unwrap()
        .expect("waiter should wake after the expired claim releases its reservation");
    assert_eq!(
        waiter_offer.graph_generation,
        kernel.snapshot().generation()
    );
    assert_eq!(
        waiter_offer.scope_fingerprint,
        kernel
            .change_set("change:waiter")
            .unwrap()
            .unwrap()
            .inferred_scope
            .unwrap()
            .scope_fingerprint,
    );

    let error = kernel
        .publish_claimed(&first_claim, &EmptyBuilder, first_claim.expires_at_tick)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::LeaseExpired),
    );
    assert!(
        kernel
            .expire_leases(first_claim.expires_at_tick)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cancellation_fences_a_delayed_claim_and_freshly_wakes_the_waiter() {
    let provider = Arc::new(CountingProvider::default());
    let (_directory, kernel) = kernel(provider.clone());
    let offer = match begin_and_submit(&kernel, "change:blocker", "shared", 1) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected blocker Ready, got {other:?}"),
    };
    let claim = match kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap()
    {
        ClaimOutcome::Claimed(claim) => claim,
        other => panic!("expected blocker claim, got {other:?}"),
    };
    assert!(matches!(
        begin_and_submit(&kernel, "change:waiter", "shared", 3),
        SubmissionOutcome::Queued { .. }
    ));
    provider.set_expanded(true);
    let calls_before = provider.calls();
    let cancelled = kernel.cancel_change_set("change:blocker", 4).unwrap();
    assert!(provider.calls() > calls_before);
    let offer = cancelled
        .ready_offers
        .into_iter()
        .find(|offer| offer.change_set_id == "change:waiter")
        .expect("cancellation should freshly offer the waiter");
    assert_eq!(offer.graph_generation, kernel.snapshot().generation());
    assert_eq!(
        offer.scope_fingerprint,
        kernel
            .change_set("change:waiter")
            .unwrap()
            .unwrap()
            .inferred_scope
            .unwrap()
            .scope_fingerprint,
    );

    let error = kernel
        .publish_claimed(&claim, &EmptyBuilder, 5)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::LeaseExpired),
    );
}

#[test]
fn offer_expiry_uses_fresh_analysis_and_replaces_stale_authority_atomically() {
    let provider = Arc::new(CountingProvider::default());
    let (_directory, kernel) = kernel(provider.clone());
    let old_offer = match begin_and_submit(&kernel, "change:offer", "offer", 1) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected offer, got {other:?}"),
    };
    provider.set_expanded(true);
    let calls_before = provider.calls();
    let expired = kernel.expire_leases(old_offer.expires_at_tick).unwrap();
    assert!(expired.iter().any(|outcome| {
        outcome.change_set_id == old_offer.change_set_id && outcome.authority_kind == "offer"
    }));
    assert!(provider.calls() > calls_before);
    let replacement = kernel
        .ready_offer_for_change_set(&old_offer.change_set_id)
        .unwrap()
        .unwrap();
    assert_ne!(replacement.offer_id, old_offer.offer_id);
    assert_ne!(replacement.scope_fingerprint, old_offer.scope_fingerprint);
    assert_eq!(replacement.graph_generation, kernel.snapshot().generation());
    assert_eq!(
        replacement.scope_fingerprint,
        kernel
            .ticket_for_change_set(&old_offer.change_set_id)
            .unwrap()
            .unwrap()
            .scope_fingerprint,
    );
}

#[test]
fn claim_rejection_runs_fresh_planning_after_the_unlocked_release_simulation() {
    let provider = Arc::new(CountingProvider::default());
    let (_directory, kernel) = kernel(provider.clone());
    let offer = match begin_and_submit(&kernel, "change:rejected", "rejected", 1) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected offer, got {other:?}"),
    };
    assert!(matches!(
        begin_and_submit(&kernel, "change:rejection-waiter", "rejected", 1),
        SubmissionOutcome::Queued { .. }
    ));
    provider.set_expanded(true);
    let calls_before = provider.calls();
    let outcome = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 2)
        .unwrap();
    assert!(matches!(outcome, ClaimOutcome::Requeued { .. }));
    assert!(
        provider.calls() >= calls_before + 2,
        "claim-time rejection must analyze once to reject and again through plan_readiness"
    );
    let current = kernel.change_set("change:rejected").unwrap().unwrap();
    assert!(matches!(
        current.state,
        ChangeSetState::Queued | ChangeSetState::Ready
    ));
    if let Some(replacement) = kernel
        .ready_offer_for_change_set("change:rejected")
        .unwrap()
    {
        assert_eq!(replacement.graph_generation, kernel.snapshot().generation());
        assert_eq!(
            replacement.scope_fingerprint,
            current.inferred_scope.unwrap().scope_fingerprint
        );
    }
    let waiter = kernel
        .ready_offer_for_change_set("change:rejection-waiter")
        .unwrap()
        .expect("claim rejection should freshly wake the overlapping waiter");
    assert_eq!(waiter.graph_generation, kernel.snapshot().generation());
    assert_eq!(
        waiter.scope_fingerprint,
        kernel
            .change_set("change:rejection-waiter")
            .unwrap()
            .unwrap()
            .inferred_scope
            .unwrap()
            .scope_fingerprint,
    );
}

#[derive(Clone, Copy, Debug)]
enum ReleaseCause {
    Cancellation,
    OfferExpiry,
    ClaimExpiry,
    ClaimRejection,
}

#[test]
fn every_release_cause_uses_the_latest_provider_scope_and_current_generation() {
    for cause in [
        ReleaseCause::Cancellation,
        ReleaseCause::OfferExpiry,
        ReleaseCause::ClaimExpiry,
        ReleaseCause::ClaimRejection,
    ] {
        let provider = Arc::new(CountingProvider::default());
        let (_directory, kernel) = kernel(provider.clone());
        assert!(
            !kernel.snapshot().snapshot().nodes.is_empty(),
            "release-path acceptance must run on the committed examples/medium fixture"
        );
        let blocker_offer = match begin_and_submit(&kernel, "change:blocker", "shared", 1) {
            SubmissionOutcome::Ready { offer, .. } => offer,
            other => panic!("expected blocker Ready for {cause:?}, got {other:?}"),
        };
        let initial_scope_fingerprint = blocker_offer.scope_fingerprint.clone();
        let blocker_claim = if matches!(
            cause,
            ReleaseCause::Cancellation | ReleaseCause::ClaimExpiry
        ) {
            match kernel
                .claim_ready(&blocker_offer.offer_id, &blocker_offer.claim_token, 2)
                .unwrap()
            {
                ClaimOutcome::Claimed(claim) => Some(claim),
                other => panic!("expected blocker claim for {cause:?}, got {other:?}"),
            }
        } else {
            None
        };
        if !matches!(cause, ReleaseCause::OfferExpiry) {
            assert!(matches!(
                begin_and_submit(&kernel, "change:waiter", "shared", 3),
                SubmissionOutcome::Queued { .. }
            ));
        }
        provider.set_expanded(true);
        let calls_before = provider.calls();
        let resulting_offer = match cause {
            ReleaseCause::Cancellation => kernel
                .cancel_change_set("change:blocker", 4)
                .unwrap()
                .ready_offers
                .into_iter()
                .find(|offer| offer.change_set_id == "change:waiter")
                .unwrap(),
            ReleaseCause::OfferExpiry => {
                kernel.expire_leases(blocker_offer.expires_at_tick).unwrap();
                kernel
                    .ready_offer_for_change_set("change:blocker")
                    .unwrap()
                    .unwrap()
            }
            ReleaseCause::ClaimExpiry => {
                kernel
                    .expire_leases(blocker_claim.as_ref().unwrap().expires_at_tick)
                    .unwrap();
                kernel
                    .ready_offer_for_change_set("change:waiter")
                    .unwrap()
                    .unwrap()
            }
            ReleaseCause::ClaimRejection => {
                assert!(matches!(
                    kernel
                        .claim_ready(&blocker_offer.offer_id, &blocker_offer.claim_token, 4)
                        .unwrap(),
                    ClaimOutcome::Requeued { .. }
                ));
                kernel
                    .ready_offer_for_change_set("change:waiter")
                    .unwrap()
                    .unwrap()
            }
        };
        assert!(
            provider.calls() > calls_before,
            "{cause:?} must invoke the centralized provider"
        );
        assert_eq!(
            resulting_offer.graph_generation,
            kernel.snapshot().generation(),
            "{cause:?} emitted authority for a stale graph generation"
        );
        assert_ne!(
            resulting_offer.scope_fingerprint, initial_scope_fingerprint,
            "{cause:?} reused the provider's old scope"
        );
        assert_eq!(
            resulting_offer.scope_fingerprint,
            kernel
                .change_set(&resulting_offer.change_set_id)
                .unwrap()
                .unwrap()
                .inferred_scope
                .unwrap()
                .scope_fingerprint,
            "{cause:?} offer did not carry the latest durable provider scope"
        );
    }
}

#[test]
fn restart_and_expiry_are_idempotent_and_old_epoch_claims_are_fenced() {
    let provider = Arc::new(CountingProvider::default());
    let (directory, kernel) = kernel(provider.clone());
    let path = directory.path().join("kernel.redb");
    let initial_digest = kernel.snapshot().digest().to_owned();
    let draft = kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:restart-draft".into(),
                actor: "agent:lease".into(),
                reasoning: "survive restart before expiry".into(),
                submission_idempotency_key: "submission:restart-draft".into(),
            },
            10,
        )
        .unwrap();
    let offer = match begin_and_submit(&kernel, "change:restart-claim", "epoch", 11) {
        SubmissionOutcome::Ready { offer, .. } => offer,
        other => panic!("expected offer, got {other:?}"),
    };
    let old_claim = match kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 12)
        .unwrap()
    {
        ClaimOutcome::Claimed(claim) => claim,
        other => panic!("expected claim, got {other:?}"),
    };
    drop(kernel);

    let (reopened, _) = Kernel::open_with_test_semantics(&path, provider.clone()).unwrap();
    assert_eq!(reopened.snapshot().generation(), 0);
    assert_eq!(reopened.snapshot().digest(), initial_digest);
    assert_eq!(
        reopened
            .change_set("change:restart-draft")
            .unwrap()
            .unwrap()
            .expires_at_tick,
        draft.expires_at_tick
    );
    let error = reopened
        .publish_claimed(&old_claim, &EmptyBuilder, 13)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::LeaseExpired)
    );
    reopened
        .expire_leases(draft.expires_at_tick.unwrap())
        .unwrap();
    let draft_expiry_count = reopened
        .events_after("restart-audit", 0, 100)
        .unwrap()
        .into_iter()
        .filter(|event| event.payload_json.contains("draft-expired"))
        .count();
    drop(reopened);

    let (reopened_again, _) = Kernel::open_with_test_semantics(&path, provider).unwrap();
    assert_eq!(reopened_again.snapshot().generation(), 0);
    assert_eq!(reopened_again.snapshot().digest(), initial_digest);
    assert_eq!(
        reopened_again
            .events_after("restart-audit", 0, 100)
            .unwrap()
            .into_iter()
            .filter(|event| event.payload_json.contains("draft-expired"))
            .count(),
        draft_expiry_count,
        "a second reopen must not duplicate an already recorded draft expiry"
    );
}
