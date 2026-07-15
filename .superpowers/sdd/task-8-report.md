# Task 8 Phase A report — integrated correction audit and deterministic gate

## Status

Phase A is complete. The eight correction scenarios are mapped to explicit real-corpus tests, the
two remaining toy-fixture gaps were corrected, and the required ordered gate was executed against
correction head `c7414d52c9260364d6e9d61e55d8212ed005b09b`.

No production code changed. This phase changed acceptance tests only and deliberately did not edit
`decisions.md`, `docs/product-roadmap.md`, or the correction evidence report.

The bounded Rust/ingest/build gate passes. The exact `pnpm -r test` command reproduces only the
documented `@strata/verify` TS2454 baseline before pnpm stops. A supplemental non-bailing run also
exposed two pre-existing stale T03 replay-fixture failures in `@strata/agent`; those tests are
unchanged from integrated review base `8422f4e` and were not reached by the exact first-failure
command. See “Workspace baseline concern.”

## Toolchain

- `rustc 1.89.0 (29483883e 2025-08-04)`
- `cargo 1.89.0 (c24e10642 2025-06-23)`
- `redb 4.1.0`
- `node v26.3.0`
- `pnpm 10.26.2`
- `typescript 5.9.3`
- `vitest 3.2.4` (`darwin-arm64`)

## Acceptance audit matrix

Every row uses the committed ingest-derived
`crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json` fixture (1,282 nodes, 614
references). “Durable” below means either an explicit drop/reopen comparison or reads of the
canonical redb coordination records; “live” means the in-memory graph/scheduler projection.

| # | Scenario | Exact test evidence | End-state evidence |
|---:|---|---|---|
| 1 | Default authority sealing | `coordination_authority::default_kernel_rejects_semantic_execution_without_side_effects`; `api_sealing::semantic_authority_is_not_exported_by_default` | Uses a real `User` declaration, gets `SemanticProviderUnavailable`, preserves live generation/digest, persists Draft with no events, and reopens to the same durable graph and lifecycle state. Compile-fail coverage seals the default authority API. |
| 2 | Two claims captured before either publishes | `coordination_optimistic::two_disjoint_claims_captured_before_publication_both_commit_in_either_order` | Both claims are captured at generation 0, both publication orders reach generations 1 then 2, both real nodes change in live memory, both change sets are durably Committed, and reopen reproduces generation 2 and the live digest. |
| 3 | Affected dependency invalidation | `coordination_optimistic::every_dependency_clock_class_invalidates_affected_work_but_unrelated_work_rebases` | Exercises node, children, edge, references-to, namespace, and absence dependency classes. Affected claims durably leave Executing, never leak their candidate into the live graph, and unrelated drift rebases and commits at generation 2. |
| 4 | Lifecycle progress while builder is active | `coordination_optimistic::builder_can_run_disjoint_lifecycle_and_event_replay_without_global_lock_blocking`; `coordination_optimistic::candidate_builder_observes_both_global_mutexes_unlocked` | The builder submits disjoint work, cancels another change set, expires leases, and replays events while publication is active. Publication reaches live generation 1; publisher/disjoint/cancelled lifecycle states are asserted; reopen reproduces the graph digest and durable terminal states. The lock probe observes both global mutexes free. |
| 5 | Fresh analysis on every release path | `coordination_leases::every_release_cause_uses_the_latest_provider_scope_and_current_generation`; `coordination_optimistic::publication_successor_offer_uses_fresh_unlocked_analysis_on_committed_graph` | Cancellation, offer expiry, claim expiry, and claim rejection each invoke the provider, issue current-generation authority, and persist the new scope fingerprint; publication successor analysis observes generation 1 and cannot strand the waiter. Live graph generation is compared with the durable offer/scope records. |
| 6 | Expiry/restart fencing | `coordination_leases::restart_and_expiry_are_idempotent_and_old_epoch_claims_are_fenced` | Old-epoch publication returns `LeaseExpired`; the medium graph generation/digest remains unchanged across two reopens; draft expiry remains durable and idempotent with no duplicate event. |
| 7 | Same-attempt replay and mismatch rejection | `coordination_publication::same_attempt_same_digest_replays_but_changed_digest_is_rejected` | Same digest replays the original generation/digest before and after reopen; the durable attempt identity/digests are asserted; a changed digest returns `AttemptDigestMismatch` while both live graph digest and durable attempt remain unchanged. |
| 8 | Complete-old-or-complete-new failpoint reopen | `coordination_publication::failure_after_in_transaction_fence_mutation_rolls_back_fences_graph_and_coordination`; `coordination_publication::atomic_state_distinguishes_wrong_graph_publication_content` | Reopened normalized full atomic state at `AfterFenceMutation`, all actual `AfterInsert(1..=18)` boundaries, `AfterResourceClockWrite`, `AfterAttemptWrite`, and `BeforeCommit` equals complete old or complete new. The tuple covers graph, operations/events/tickets/idempotency, clocks, attempts, lifecycle metadata, fences, and live projections; deliberate content mutations compare unequal. |

The broader `coordination_acceptance` harness also passed 12/12 and every test in that file loads
`MediumCoordinationFixture`.

## Acceptance-test corrections and TDD evidence

### RED

1. Added a non-empty-real-fixture assertion to
   `default_kernel_rejects_semantic_execution_without_side_effects` while it still constructed
   `empty_snapshot()`. Focused command exited 101 with the expected fixture assertion.
2. Added the same requirement to
   `every_release_cause_uses_the_latest_provider_scope_and_current_generation` while the shared
   lease helper still constructed an empty graph. Focused command exited 101 with the expected
   fixture assertion.

### GREEN

- Migrated authority sealing to the committed medium fixture and a real `User` declaration.
- Migrated the release-path lease helper to the same committed fixture.
- Added durable-reopen plus live-graph assertions to simultaneous claims and builder-progress;
  added no-leak/live-state assertions to dependency invalidation; added reopen graph invariants to
  restart fencing; added no-side-effect attempt/digest assertions to mismatch rejection.
- `coordination_authority`: 1/1 passed.
- `coordination_leases`: 8/8 passed.
- `coordination_optimistic`: 12/12 passed.
- `coordination_publication`: 21/21 passed.
- `coordination_acceptance`: 12/12 passed.

No production correction was necessary.

## Required ordered gate

The first formatting check found only rustfmt differences in the new assertions. After mechanical
formatting, the complete sequence was restarted at command 1 and run in the prescribed order:

1. `cargo fmt --all -- --check` — PASS, exit 0.
2. `cargo clippy -p strata-kernel --all-targets -- -D warnings` — PASS, exit 0, zero warnings.
3. `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings` — PASS,
   exit 0, zero warnings.
4. `cargo test -p strata-kernel` — PASS, 32 passed, 0 failed.
5. `cargo test -p strata-kernel --features redb-spike-api` — PASS, 162 passed, 0 failed.
6. `pnpm --filter @strata/ingest build` — PASS, exit 0.
7. `pnpm --filter @strata/ingest test` — PASS, 4 files and 8 tests passed.
8. `pnpm -r build` — PASS, all 8 buildable workspace projects completed.
9. `pnpm -r test` — exit 1 with exactly the authorized first-failure baseline:
   - `@strata/store`: 36 files, 177/177 passed.
   - `@strata/render`: 3 files, 13/13 passed.
   - `@strata/ingest`: 4 files, 8/8 passed.
   - `@strata/verify`: 15 files passed, 1 failed; 69/70 tests passed.
   - sole reached failure:
     `tests/extractFunctionCommit.test.ts > extract_function on the real corpus > extracts a contiguous span from a medium-corpus function and commits green`, assertion at line 228.
   - This exactly matches `decisions.md` and the prior scheduler/redb evidence: the analyzer accepts
     the unsafe `let args` span, then the commit gate rejects TS2454 (`args` used before assignment).
     No correction file touches that TypeScript surface.
   - pnpm stopped at the first failing package, so agent/cli/bench/lab were not run by this exact
     command.

## Supplemental non-bailing workspace check

`pnpm -r --no-bail test` was run after the required gate to account for packages skipped by pnpm's
first-failure behavior:

- store 177/177, ingest 8/8, render 13/13, CLI 22/22, bench 62/62; lab's documented
  non-authoritative test script exited 0.
- verify reproduced only the authorized 69/70 TS2454 baseline.
- agent passed 53 tests, failed 2, and skipped 2. Both failures are the same stale replay fixture
  declaration ID `5073ecfb56151b41`:
  - `labSeam::seam: acceptance lifted to callers preserves T03 replay > T03 replay still scores all criteria true`
  - `replay::runAgentT03 replays the committed transcript fixture deterministically > reproduces all 11 T03 criteria from the fixture without a model`
- `git diff 8422f4e -- packages/agent examples/medium packages/store packages/ingest packages/verify`
  is empty, so these two failures predate the complete integrated correction diff and were not
  introduced or altered by Tasks 1–8. They were not visible in the historical exact gate because
  recursive pnpm stopped at verify first.

## Fixed-invariant audit

- Default builds cannot install semantic authority: behavioral and compile-fail tests pass.
- Both generation-0 disjoint claims publish in either order and survive reopen.
- Provider, builder, graph application, digest validation, and readiness planning remain outside
  global locks; focused lock probes pass and this phase changed no production code.
- Every release cause uses centralized fresh planning and persists its newly inferred scope.
- Expiry/restart/cancellation fence stale authority and the invalidation suite proves no affected
  claim remains Executing.
- The atomic failpoint tuple includes graph, clocks, attempts, lifecycle, fences, tickets,
  operations/events, idempotency, and live projections in complete-old-or-complete-new reopen.
- No bridge, transport, authentication, live-model, task orchestration, or production TypeScript
  semantic claim was added.

## Files changed

- `crates/strata-kernel/tests/coordination_authority.rs`
- `crates/strata-kernel/tests/coordination_leases.rs`
- `crates/strata-kernel/tests/coordination_optimistic.rs`
- `crates/strata-kernel/tests/coordination_publication.rs`
- `.superpowers/sdd/task-8-report.md`

## Concerns and handoff

- The required correction gate has no new failure. Its sole reached pnpm failure is the explicitly
  authorized TS2454 baseline.
- The supplemental run establishes a separate, pre-existing and previously obscured pair of stale
  agent replay-fixture failures. They are outside this acceptance-test-only correction and do not
  falsify the Rust coordination invariants, but the whole-branch and architecture reviewers should
  be given this fact rather than told the entire TypeScript workspace is green.
- Phase B reviews and any decision/roadmap/evidence edits remain with the parent agent.
