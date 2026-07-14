# Task 7 report — atomic claimed publication

## Status

Implemented kernel-owned claimed publication with a delta-only `CandidateBuilder`, fresh pre-build analysis, scope containment, one redb transaction for graph + coordination + fresh fences, atomic successor wakeups, committed retry semantics, and default raw-API sealing.

## TDD evidence

- RED: `cargo test -p strata-kernel --test coordination_publication` failed with `unresolved import strata_kernel::CandidateBuilder` before production changes.
- Additional REDs: successor-wakeup test failed because `Kernel::ready_offer_for_change_set` did not exist; fence-rollback test failed because `Kernel::fence_state` did not exist. Both were added only after their expected failures.
- GREEN focused default: `cargo test -p strata-kernel --test coordination_publication` — 5 passed, 0 failed.
- GREEN focused legacy feature: `cargo test -p strata-kernel --features redb-spike-api --test coordination_publication` — 6 passed, 0 failed, including post-fence, every one of 15 graph/coordination insert boundaries, and final pre-commit rollback.
- GREEN default full: `cargo test -p strata-kernel` — 44 tests passed (raw proof tests intentionally compile as zero tests without the feature); default trybuild sealing passed.
- GREEN feature full: `cargo test -p strata-kernel --features redb-spike-api` — 92 tests passed, 0 failed, preserving the legacy redb proof and binary test.
- Formatting/lints: `cargo fmt --all`; default and `--features redb-spike-api` `cargo clippy -p strata-kernel --all-targets -- -D warnings` both passed.

## Files and behavior

- `coordination/analyzer.rs`: production `CandidateBuilder` trait returning only `GraphDelta`.
- `coordination/coordinator.rs`, `scheduler.rs`: `publish_claimed(..., now_tick)`, exact durable claim validation, fresh analysis, safe requeue/decision, projected release/wakeups, derived records/context, memory install after redb commit, documented lock order.
- `storage.rs`, `coordination/durable.rs`: shared transaction-local graph writer, lifecycle writer hook, in-transaction fence issuance+consumption, one coordinated commit, insert-boundary failpoints, original-generation idempotency lookup.
- `Cargo.toml`, `lib.rs`, `kernel.rs`, integration tests: `redb-spike-api` gates raw store/publication/fencing/failpoints and the spike binary; coordinated graph types/lifecycle remain default.
- `tests/coordination_publication.rs`: real `examples/medium` snapshot coverage for stale epoch/generation/offer/fingerprint, builder ordering, rogue node/parent/reference, composite operation, reopen durability, wakeups, rollback, and retry semantics.
- `tests/api_sealing.rs` + UI fixture: compile-fail proof for raw imports and `Kernel::issue_fence`/`publish` without default features.

## Decision

Prepended the required `decisions.md` entry: `publish_claimed` accepts host `now_tick`; reusing the old offer expiry creates stale successor offers, while post-commit reconsideration breaks atomic wakeup. No design-doc signature required updating.

## Self-review

- Audited lock acquisition: coordinated commit is scheduler → publish lock → redb write → live write; no path takes scheduler/publish while holding live write.
- Corrected a review-found rollback issue so scope-change requeue mutates a cloned scheduler and installs it only after durable lifecycle commit.
- Confirmed duplicate `coordination-commit:<changeSetId>` returns the stored generation/digest before claim validation and again under both locks, without rebuilding or duplicating events, including after reopen.
- Confirmed the coordinated transaction never calls legacy `issue_fence`; all fresh tokens are incremented and consumed inside its own write transaction.

## Concerns / deferred scope

- `CandidateBuilder` intentionally has no production implementation; the TypeScript worker bridge remains a later task.
- The feature-gated failpoint surface is a research harness only. No Node validation, transport, real TypeScript analyzer, or live experiment was added.
