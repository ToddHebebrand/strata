//! Published-only delta-log gates (bridge-persistence slice, Task 6; review
//! B2). The persistent mirror can only ever advance by applying entries from
//! the kernel's delta log, so these gates pin the log's append discipline at
//! the kernel level, without any worker process:
//!
//! - a publication that reaches `PublishOutcome::Published` + the in-memory
//!   swap appends EXACTLY one entry, and the published identity advances to
//!   the new generation's canonical sync digest (positive control);
//! - the mandated speculative-publication failpoint: a publication that has
//!   already run readiness planning against the speculative `next` graph but
//!   is invalidated by the final authority checks BEFORE Published leaves
//!   the delta log without any entry for the aborted generation and the
//!   published identity untouched — so the mirror can never have advanced.

#![cfg(feature = "coordination-test-api")]

#[path = "support/coordination.rs"]
#[allow(dead_code)]
mod coordination_support;

use std::sync::Arc;

use coordination_support::{
    GraphDerivedAnalyzer, MediumCoordinationFixture, NodePatchBuilder, begin_with_intents, rename,
};
use strata_kernel::{
    ClaimHandle, ClaimOutcome, ChangeSetState, GraphGeneration, Kernel, PublishClaimOutcome,
    SubmissionOutcome, canonical_sync_digest,
};
use tempfile::tempdir;

fn claim_for(kernel: &Kernel, change_set_id: &str, declaration_id: &str, new_name: &str, tick: u64) -> ClaimHandle {
    begin_with_intents(kernel, change_set_id, [rename(declaration_id, new_name)]).unwrap();
    let SubmissionOutcome::Ready { offer, .. } =
        kernel.submit_change_set(change_set_id, tick).unwrap()
    else {
        panic!("expected {change_set_id} to be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, tick + 1)
        .unwrap()
    else {
        panic!("expected {change_set_id} to be claimed")
    };
    claim
}

fn live_sync_digest(kernel: &Kernel) -> String {
    let graph: Arc<GraphGeneration> = kernel.snapshot();
    let snapshot = graph.snapshot();
    canonical_sync_digest(graph.generation(), &snapshot.nodes, &snapshot.references)
}

#[test]
fn published_publications_append_exactly_one_log_entry_each() {
    let fixture = MediumCoordinationFixture::load();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (mut kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    kernel.test_enable_published_sync_tracking();

    // Seed identity: generation 0 digest recorded before any publication.
    let (generation, digest, log) = kernel.test_published_sync_state().unwrap();
    assert_eq!(generation, 0);
    assert_eq!(digest, live_sync_digest(&kernel));
    assert!(log.is_empty());

    let user = fixture.declaration_named("User").id.clone();
    let claim = claim_for(&kernel, "sync-log-user", &user, "Account", 0);
    let builder = NodePatchBuilder::new(vec![(user.clone(), "-published-1".into())]);
    let PublishClaimOutcome::Published(report) =
        kernel.publish_claimed(&claim, &builder, 5).unwrap()
    else {
        panic!("expected the first rename to publish")
    };
    assert_eq!(report.generation, 1);

    let (generation, digest, log) = kernel.test_published_sync_state().unwrap();
    assert_eq!(generation, 1);
    assert_eq!(
        digest,
        live_sync_digest(&kernel),
        "published sync digest must be the canonical sync digest of the live graph"
    );
    assert_eq!(log, vec![1]);

    let format = fixture.declaration_named("formatTimestamp").id.clone();
    let claim = claim_for(&kernel, "sync-log-format", &format, "renderTimestamp", 6);
    let builder = NodePatchBuilder::new(vec![(format, "-published-2".into())]);
    let PublishClaimOutcome::Published(report) =
        kernel.publish_claimed(&claim, &builder, 10).unwrap()
    else {
        panic!("expected the second rename to publish")
    };
    assert_eq!(report.generation, 2);

    let (generation, digest, log) = kernel.test_published_sync_state().unwrap();
    assert_eq!(generation, 2);
    assert_eq!(digest, live_sync_digest(&kernel));
    assert_eq!(log, vec![1, 2], "one entry per published generation, in order");
}

#[test]
fn invalidated_publication_after_readiness_planning_never_enters_the_log() {
    // Gate (k), review B2's mandated failpoint: the publication below runs
    // its readiness planning against the speculative `next = graph.apply(
    // delta)` (that happens before the final-check hook fires), and is THEN
    // invalidated by the dependency-clock final check before
    // `PublishOutcome::Published`. The delta log must contain no entry for
    // the aborted generation and the published identity must be untouched —
    // the persistent mirror, which only advances via this log, can therefore
    // never have advanced.
    let fixture = MediumCoordinationFixture::load();
    let directory = tempdir().unwrap();
    let path = directory.path().join("kernel.redb");
    let (mut kernel, _) = Kernel::create_with_test_semantics(
        &path,
        fixture.snapshot().clone(),
        Arc::new(GraphDerivedAnalyzer::new()),
    )
    .unwrap();
    kernel.test_enable_published_sync_tracking();
    let seed_state = kernel.test_published_sync_state().unwrap();
    assert_eq!(seed_state.0, 0);
    assert!(seed_state.2.is_empty());

    let user = fixture.declaration_named("User").id.clone();
    let claim = claim_for(&kernel, "sync-log-invalidated", &user, "Account", 0);
    let dependency_key = claim
        .dependency_versions
        .first()
        .expect("rename claim pins at least one dependency")
        .resource_key
        .clone();
    let builder = NodePatchBuilder::new(vec![(user, "-never-published".into())]);

    let before_final_check = |attempt: u32| {
        assert_eq!(attempt, 0, "invalidation must fire on the first attempt");
        kernel
            .test_inject_claim_dependency_clock_advance(&claim, &dependency_key)
            .unwrap();
    };
    let outcome = kernel
        .publish_claimed_with_test_hooks(&claim, &builder, 5, &before_final_check, &|| {})
        .unwrap();
    assert!(
        matches!(outcome, PublishClaimOutcome::Requeued { .. }),
        "stale dependency must invalidate before Published"
    );
    assert_eq!(builder.calls(), 1, "the candidate (and its readiness planning) ran");
    assert_eq!(kernel.snapshot().generation(), 0, "nothing was published");
    assert_eq!(
        kernel
            .change_set("sync-log-invalidated")
            .unwrap()
            .unwrap()
            .state,
        ChangeSetState::Queued
    );

    let state = kernel.test_published_sync_state().unwrap();
    assert_eq!(
        state, seed_state,
        "aborted generation must not enter the delta log nor move the published identity"
    );
}
