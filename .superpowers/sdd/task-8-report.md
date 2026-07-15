# Task 8 Phase A report — integrated correction audit and deterministic gate

## Status

Phase A, the integrated-review correction wave, and the legacy redb compatibility follow-up are
complete. The eight correction scenarios are mapped to explicit real-corpus tests, the two
remaining toy-fixture gaps were corrected, and the review findings were fixed and verified. The
final implementation and test head is `f02b9095aa0c9d8752f08068db5cc70b7bbf6337`.

The initial Phase A audit changed acceptance tests only. Integrated review then required production
corrections for provider-failure containment and validate-before-migrate recovery. The compatibility
follow-up corrected marker-absent databases created by the actual `8422f4e` coordination schema,
which lacks the resource-clock and publication-attempt tables. This work still deliberately did not
edit `decisions.md`, `docs/product-roadmap.md`, or the correction evidence report.

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
| 4 | Lifecycle progress while builder is active | `coordination_optimistic::builder_can_run_disjoint_lifecycle_and_event_replay_without_global_lock_blocking`; `coordination_optimistic::candidate_builder_observes_both_global_mutexes_unlocked` | An expiring real-medium claim is captured at tick 1 and is actually due at tick 61; the publisher is captured at tick 51 and remains valid through tick 111. During builder execution, disjoint work is submitted and successfully claimed, reconsideration succeeds, another change set is cancelled, the due claim expires, and events replay. Publication reaches generation 1; live and reopened publisher/disjoint/expired/cancelled states are asserted. The lock probe observes both global mutexes free. |
| 5 | Fresh analysis on every release path | `coordination_leases::every_release_cause_uses_the_latest_provider_scope_and_current_generation`; `coordination_optimistic::publication_successor_offer_uses_fresh_unlocked_analysis_on_committed_graph` | Cancellation, offer expiry, claim expiry, and claim rejection each invoke the provider, issue current-generation authority, and persist the new scope fingerprint; publication successor analysis observes generation 1 and cannot strand the waiter. Live graph generation is compared with the durable offer/scope records. |
| 6 | Expiry/restart fencing | `coordination_leases::restart_and_expiry_are_idempotent_and_old_epoch_claims_are_fenced` | Old-epoch publication returns `LeaseExpired`; the medium graph generation/digest remains unchanged across two reopens; draft expiry remains durable and idempotent with no duplicate event. |
| 7 | Same-attempt replay and mismatch rejection | `coordination_publication::same_attempt_same_digest_replays_but_changed_digest_is_rejected`; attempt corruption cases in `coordination_recovery` | Same digest replays the original generation/digest before and after reopen; a changed digest returns `AttemptDigestMismatch` with no live/durable mutation. Reopen also checks cross-record consistency between the attempt, committed change set/generation, operation identity, and graph-event payload identity; this is an integrity linkage check, not a claim of cryptographic provenance. |
| 8 | Complete-old-or-complete-new failpoint reopen | `coordination_publication::failure_after_in_transaction_fence_mutation_rolls_back_fences_graph_and_coordination`; `coordination_publication::atomic_state_distinguishes_wrong_graph_publication_content` | Reopened normalized full atomic state at `AfterFenceMutation`, all actual `AfterInsert(1..=18)` boundaries, `AfterResourceClockWrite`, `AfterAttemptWrite`, and `BeforeCommit` equals complete old or complete new. These are explicit in-transaction failpoints before redb commit, not instruction-level crash injection inside redb's commit implementation. The tuple covers graph, operations/events/tickets/idempotency, clocks, attempts, lifecycle metadata, fences, and live projections; deliberate content mutations compare unequal. |

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

No production correction was necessary during the initial audit.

## Integrated-review corrections and TDD evidence

### Provider failure containment

- RED: the three real-medium tests
  `queued_provider_failure_does_not_abort_claimed_publication_or_disjoint_readiness`,
  `queued_provider_failure_does_not_abort_claimed_cancellation_or_disjoint_readiness`, and
  `queued_provider_failure_does_not_abort_due_claim_expiry_or_disjoint_readiness` each returned
  `deterministic queued semantic failure` from an unrelated queued ticket and aborted the
  triggering transition.
- GREEN: one queued provider failure is now a pass-local nonselectable ticket, not a planner-wide
  error. It remains a FIFO blocker for younger overlapping work, receives no `Ready` authority,
  and does not prevent fresh disjoint work from progressing. Publication, cancellation, and due
  claim expiry each durably leave `Executing`; live state and reopen agree.

### Validate-before-migrate recovery

- RED: versioned reopen recreated missing `current_event_sequence` and then failed later, silently
  recreated missing `next_queue_sequence`, backfilled a missing event-ID mapping, and default
  `Kernel::open` accepted a retained recovery version with a missing lifecycle marker.
- GREEN: `DurableStore::open` performs no schema/metadata repair. Common recovery validation now
  runs for default and feature builds before the service-epoch write. A versioned database must
  retain exact queue/event/revision metadata, lifecycle/clock markers, event-ID mappings, clocks,
  and publication-attempt/delta/digest/cross-record identity consistency. Failed opens preserve
  raw coordination metadata and index records.
- Exact compatibility rule: a retained recovery-validation version makes any missing subordinate
  marker or metadata corruption an error. Complete absence of the validation version plus both
  subordinate markers is treated as legacy; it cannot be distinguished from deliberate complete
  marker deletion. Only that legacy state receives a derived migration plan, applied atomically
  with schema creation/backfill, service-epoch advancement, and authority recovery.

### `8422f4e` physical-schema compatibility

- RED: a regression populated real coordination lifecycle records, stripped the database to the
  exact ten-table coordination schema and two-key metadata shape present at `8422f4e`, and failed
  reopen at `coordination_resource_clocks does not exist`. That historical schema has neither
  `coordination_resource_clocks` nor `coordination_publication_attempts`.
- GREEN: only marker-absent/unversioned legacy validation treats an absent clock or attempt table as
  empty. A nonzero active-claim dependency still requires a durable clock, so the existing
  corruption rule is preserved. Recovery creates both absent tables in the same write transaction
  as marker backfill, service-epoch advancement, and authority recovery; a `BeforeCommit`
  failpoint proves schema creation, metadata, and epoch all roll back together.
- Retained/versioned databases still require both tables. Deleting either one makes reopen fail
  closed before any write; a second raw read proves the missing table was not recreated, metadata
  was unchanged, and service epoch did not advance.

### Builder-progress acceptance

- RED: asserting an actually due claim expiry exposed the old tick-6 call as a no-op.
- GREEN: the real-medium test now proves successful disjoint `claim_ready`, successful
  `reconsider_tickets`, cancellation, event replay, and expiry of the tick-61 claim while the
  publishing claim remains valid to tick 111. Live and reopened lifecycle/claim state are exact.

## Required ordered gate

The first formatting check found only rustfmt differences in the initial assertions. After
mechanical formatting, the complete sequence was restarted at command 1. The parent agent's exact
full ordered gate at report head `ef4d9cf471895b1e835ee2163e7d3a136a18154a` covered implementation
head `1f3b2a834bdc3656cbcd4fcb255bda037e20679e` and produced:

1. `cargo fmt --all -- --check` — PASS, exit 0.
2. `cargo clippy -p strata-kernel --all-targets -- -D warnings` — PASS, exit 0, zero warnings.
3. `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings` — PASS,
   exit 0, zero warnings.
4. `cargo test -p strata-kernel` — PASS, 33 passed, 0 failed.
5. `cargo test -p strata-kernel --features redb-spike-api` — PASS, 169 passed, 0 failed.
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

The compatibility follow-up changed only the Rust kernel and Rust recovery tests. The complete Rust
portion was therefore rerun from command 1 against exact final implementation head
`f02b9095aa0c9d8752f08068db5cc70b7bbf6337`:

1. `cargo fmt --all -- --check` — PASS, exit 0.
2. `cargo clippy -p strata-kernel --all-targets -- -D warnings` — PASS, exit 0, zero warnings.
3. `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings` — PASS,
   exit 0, zero warnings.
4. `cargo test -p strata-kernel` — PASS, 33 passed, 0 failed.
5. `cargo test -p strata-kernel --features redb-spike-api` — PASS, 171 passed, 0 failed. The two-test
   increase over the parent gate is exactly the legacy physical-schema migration regression and
   the retained/versioned missing-table fail-closed regression.
6. Focused `coordination_recovery` suite — PASS, 23 passed, 0 failed.

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
- On claimed coordination publication, provider analysis, candidate building, graph application,
  digest validation, and readiness planning remain outside the publication and scheduler mutexes;
  focused lock probes pass. The statement is scoped to this implemented publication path, not a
  blanket claim about unrelated future worker/bridge code.
- Every release cause uses centralized fresh planning and persists its newly inferred scope.
- An unrelated queued provider failure cannot abort publication/cancellation/expiry; the failed
  ticket remains queued with no offer and preserves FIFO blocking while disjoint work progresses.
- Expiry/restart/cancellation fence stale authority and the invalidation suite proves no affected
  claim remains Executing.
- The atomic failpoint tuple includes graph, clocks, attempts, lifecycle, fences, tickets,
  operations/events, idempotency, and live projections in complete-old-or-complete-new reopen.
- Default and feature builds run the same read-only recovery integrity validation before writes;
  versioned corruption fails without metadata/index self-healing, while complete marker absence is
  the documented legacy migration rule.
- Actual `8422f4e` marker-absent databases may omit resource-clock and publication-attempt tables;
  they validate those tables as empty and create them atomically during recovery. The same absence
  in retained/versioned state remains corruption and does not self-heal.
- No bridge, transport, authentication, live-model, task orchestration, or production TypeScript
  semantic claim was added.

## Files changed

- `crates/strata-kernel/tests/coordination_authority.rs`
- `crates/strata-kernel/tests/coordination_leases.rs`
- `crates/strata-kernel/tests/coordination_optimistic.rs`
- `crates/strata-kernel/tests/coordination_publication.rs`
- `crates/strata-kernel/tests/coordination_recovery.rs`
- `crates/strata-kernel/tests/coordination_recovery_default.rs`
- `crates/strata-kernel/tests/coordination_durable.rs`
- `crates/strata-kernel/src/coordination/authority.rs`
- `crates/strata-kernel/src/coordination/durable.rs`
- `crates/strata-kernel/src/coordination/mod.rs`
- `crates/strata-kernel/src/coordination/planner.rs`
- `crates/strata-kernel/src/coordination/scheduler.rs`
- `crates/strata-kernel/src/kernel.rs`
- `crates/strata-kernel/src/storage.rs`
- `.superpowers/sdd/task-8-report.md`

## Concerns and handoff

- The required correction gate has no new failure. Its sole reached pnpm failure is the explicitly
  authorized TS2454 baseline.
- The supplemental run establishes a separate, pre-existing and previously obscured pair of stale
  agent replay-fixture failures. They are outside this acceptance-test-only correction and do not
  falsify the Rust coordination invariants, but the whole-branch and architecture reviewers should
  be given this fact rather than told the entire TypeScript workspace is green.
- Phase B reviews and any decision/roadmap/evidence edits remain with the parent agent.
