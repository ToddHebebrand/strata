# Task 7 report — atomic clocks, attempts, lifecycle, and crash recovery

## Status

DONE. Coordinated publication now has explicit clock and attempt failpoint boundaries, complete-old-or-complete-new reopen evidence, and reopen validation for durable clocks, attempts, graph digests, and lifecycle revision metadata.

## Strict TDD evidence

- Failpoint RED command: `cargo test -p strata-kernel --features redb-spike-api --test coordination_publication failure_after`.
- Failpoint RED result: exit 101. The new test failed to compile for exactly the missing graph-count, coordination-count, durable-clock accessors and the missing `AfterResourceClockWrite` / `AfterAttemptWrite` variants. The existing implementation already wrote clocks and attempts in one redb transaction, so no false partial-atomicity failure was manufactured.
- Corruption RED command: `cargo test -p strata-kernel --features redb-spike-api --test coordination_recovery reopen_`.
- Corruption RED result: exit 101 with all three new tests failing because reopen incorrectly succeeded for a missing nonzero dependency clock, a changed candidate digest, and a scheduler revision behind lifecycle state.
- Focused GREEN: the complete failpoint sweep passed 1/1; the recovery suite passed 11/11.

## Atomic recovery proof

- `AtomicState` reads durable graph generation/digest, operation and graph-event counts, coordination-event count, change-set/ticket/offer/claim state, durable/live scheduler revision, durable/live resource clocks, the full publication attempt (including prepared generation), fence state, and live graph generation/digest.
- Complete-old is captured from a recovered executing claim; complete-new is captured from a no-failpoint control publication over the same committed `examples/medium` fixture.
- Every tested boundary is reopened and compared to those two complete states: `AfterFenceMutation`, every actual `AfterInsert(1..=18)` boundary, `AfterResourceClockWrite`, `AfterAttemptWrite`, and `BeforeCommit`.
- The coordinated write order is attempt replay/mismatch check, graph validation, fence consumption, resource-clock validation/increment, graph publication, lifecycle/scheduler publication, attempt record, then one redb commit.
- Live graph, live resource clocks, and live scheduler are still installed only after redb commit.

## Reopen corruption validation

- A nonzero active-claim dependency must have a durable resource-clock row.
- `clocked_publication_generation` distinguishes a compatible legacy/pre-clock empty table from corruption after the first coordinated clocked publication.
- Every publication attempt must match its durable key, generation, generation digest, durable delta, and canonical candidate digest.
- Candidate-digest reconstruction reverses the only publication transformation: it restores the stored delta's base generation to `prepared_graph_generation`, with the legacy `generation - 1` fallback, then recomputes `canonical_candidate_digest`.
- `latest_lifecycle_revision` is advanced with every scheduler lifecycle revision; reopen rejects a scheduler revision behind that durable high-water mark. Missing markers are initialized from existing scheduler metadata for legacy databases.

## Files changed

- `crates/strata-kernel/src/storage.rs`
- `crates/strata-kernel/src/kernel.rs`
- `crates/strata-kernel/src/coordination/durable.rs`
- `crates/strata-kernel/tests/coordination_publication.rs`
- `crates/strata-kernel/tests/coordination_recovery.rs`
- `.superpowers/sdd/task-7-report.md`

## Final verification

- `cargo fmt --all -- --check` — PASS.
- `cargo clippy -p strata-kernel --all-targets -- -D warnings` — PASS.
- `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings` — PASS.
- `cargo test -p strata-kernel` — PASS, 32 tests.
- `cargo test -p strata-kernel --features redb-spike-api` — PASS, 153 tests.
- `git diff --check` — PASS.

## Self-review

- Confirmed no semantic provider, candidate builder, graph application, digest computation, or readiness planning moved under publication/scheduler locks.
- Confirmed normal and invalidation lock order remains publication -> scheduler -> redb.
- Confirmed clocks, their compatibility marker, graph/operation/events, lifecycle/scheduler marker, attempt, fences, and idempotency all share the one redb transaction.
- Confirmed all in-memory projection updates remain after durable commit and failed failpoints update none of them.
- Confirmed Task 6 rebased replay remains valid: original prepared generation is persisted and used to reconstruct the canonical candidate digest after reopen.

## Concerns

- No blocking concerns. Attempt/candidate recovery validation is feature-gated with the research semantic surface; default builds cannot execute semantic coordinated publications.

## Commit

- Planned subject: `test(kernel): prove atomic optimistic recovery`.
