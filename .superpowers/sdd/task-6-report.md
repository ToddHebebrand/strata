# Task 6 implementation report

Status: DONE

Commit: this report is committed with `fix(kernel): publish disjoint claims optimistically`.

## Delivered

- Extracted the complete publish/prepare/revalidate/retry/invalidation implementation from `coordinator.rs` into `coordination/publication.rs`, and moved candidate construction, panic handling, digest validation, current-graph semantic reanalysis, graph application, resource-clock planning, and successor readiness planning outside both global mutexes.
- Added a private `PreparedPublication` containing every expected graph/scheduler/epoch/claim/dependency value and the complete graph, scheduler, lifecycle, clock, operation, and durable attempt proposal.
- Reduced the final critical section to publication mutex -> scheduler mutex -> redb transaction, with exact rechecks immediately before the write transaction and in-memory publication only after redb commits.
- Removed global-generation invalidation from claim authority. Disjoint candidates rebase onto the current generation when their dependency clocks remain fresh.
- Added an exactly-three-attempt optimistic retry loop. Retries reuse the validated candidate envelope and never rerun the untrusted builder.
- Converted claimed publication to `PublishClaimOutcome`, returning `Published`, `Requeued`, or `NeedsDecision` rather than stranding invalidated work in `Executing`.
- Caught builder panics without mutating canonical state; the active claim remains durable until explicit cancellation/abandonment/expiry.
- Preserved Task 5 attempt/digest binding, tampered-`ClaimHandle` replay protection, historical builder replay, and provider-free committed-envelope replay after reopen.

## TDD evidence

- RED command: `cargo test -p strata-kernel --features coordination-test-api --test coordination_optimistic`.
- RED result: exit 101 with both intended behavioral failures: `candidate_builder_observes_both_global_mutexes_unlocked` reported the held global mutexes, and `two_disjoint_claims_captured_before_publication_both_commit_in_either_order` failed because the second generation-zero claim was rejected as stale.
- GREEN focused result: 6/6 optimistic tests passed.
- The optimistic suite proves both pre-captured disjoint claims commit in either order; builder lock freedom and disjoint lifecycle/event progress; panic containment; node, edge, children, references-to, namespace, and absence dependency invalidation; unrelated rebase; and fresh unlocked successor analysis at committed generation 1.

## Verification

- Exact Task 6 acceptance command passed: optimistic 6/6, publication 14/14, acceptance 11/11.
- `cargo test -p strata-kernel --features coordination-test-api` passed with zero failures.
- `cargo test -p strata-kernel --all-features` passed with zero failures, including duplicate publication races, coordinated failpoint rollback, recovery, fencing, and crash-recovery suites.
- `cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings` passed.
- `cargo clippy -p strata-kernel --all-targets -- -D warnings` passed.
- `cargo fmt --all -- --check` passed.
- `git diff --check` passed.

## Files

- `crates/strata-kernel/src/coordination/coordinator.rs`
- `crates/strata-kernel/src/coordination/mod.rs`
- `crates/strata-kernel/src/coordination/publication.rs`
- `crates/strata-kernel/src/kernel.rs`
- `crates/strata-kernel/tests/coordination_acceptance.rs`
- `crates/strata-kernel/tests/coordination_optimistic.rs`
- `crates/strata-kernel/tests/coordination_publication.rs`
- `crates/strata-kernel/tests/coordination_resources.rs`
- `.superpowers/sdd/task-6-report.md`

## Self-review

- Lock lifetime: no builder, provider analysis, candidate digest/containment validation, graph application, resource planning, or successor planning executes with either global mutex held. The final path acquires publication, then scheduler, then enters redb.
- Retry behavior: attempts are numbered 0, 1, and 2; the third lost race returns `OptimisticRetryExhausted { attempts: 3 }`. Candidate bytes/digest remain bound across retries.
- Dependency invalidation: the current clock projection is checked before reanalysis and again under both final locks. A mismatch runs fresh analysis, atomically removes the claim, updates the ticket/change set, applies centralized readiness, and returns only after the durable state is `Queued` or `NeedsDecision`.
- Fresh readiness: publication success analyzes queued successors against the tentative committed graph before final locks; a provider probe verifies generation 1 and verifies both mutexes are available during every call.
- Failure paths: builder error/panic has no durable side effects; cancellation/expiry/restart invalidate delayed work; final-state drift retries; failpoint rollback remains complete-old; redb commit precedes all live graph/clock/scheduler swaps.
- Replay: the outer durable attempt lookup remains provider-free for envelopes and rebuilds historical builder input from durable prepared authority, so caller-tampered scope/generation fields cannot mint replay authority.
- No schema, API trust-boundary, or architectural divergence beyond the approved Task 6 plan was required; `decisions.md` and `strata-design.md` remain unchanged.

## Concerns

- None blocking.

## Review-fix wave (2026-07-15)

Status: DONE

### Corrections delivered

- Made dependency-clock drift authoritative at every final check, including the third optimistic attempt: stale work is atomically reanalyzed, its claim is removed and fenced, and it returns `Requeued` or `NeedsDecision`; only three consecutive unrelated graph/scheduler/service losses return `OptimisticRetryExhausted { attempts: 3 }`.
- Routed successful-publication and invalidation successor scheduling through the centralized `plan_readiness` path. Scope contraction is now explicit, so stale wide reservations can contract to fresh narrow authority before FIFO selection.
- Enforced publication -> scheduler -> redb ordering for the invalidation commit and added a deterministic lock-order probe.
- Persisted the builder's original prepared graph generation in `PublicationAttemptRecord`. Retry and reopen replay reuse that authority; legacy records deserialize through a `serde(default)` fallback.
- Split external envelopes from internally validated retry candidates. Initial external input must bind to the captured graph generation, while retries reuse the already validated envelope without rebuilding or rehashing it.
- Removed structural digest validation from final locked/idempotency checks; the final section compares the already validated digest string to durable state only.
- Converted committed builder-replay panics to typed errors and strengthened panic recovery coverage through a raw durable reopen followed by kernel recovery and stale-claim fencing.

### Regression-first evidence

- Initial compile RED failed on the intentionally missing durable prepared-generation field and deterministic test probes.
- Behavioral RED proved all three target defects: third-final-check dependency drift returned generic optimistic exhaustion; centralized-planner contraction produced no successor offer; and rebased reopen replay failed with `AttemptDigestMismatch`.
- Publication RED proved an external envelope with base generation 99 could commit and a replay builder panic could unwind.
- The control regression was green throughout: three unrelated final-state losses return exactly `OptimisticRetryExhausted { attempts: 3 }`, and the builder runs once.

### Final verification

- Exact acceptance command passed 39/39: optimistic 11/11, publication 17/17, acceptance 11/11.
- Full coordination-test-api suite passed 93/93.
- Full all-features suite passed 146/146, including durable panic recovery, duplicate races, failpoints, recovery, and fencing.
- Default and all-features strict Clippy passed with `-D warnings`.
- `cargo fmt --all -- --check` and `git diff --check` passed.

### Review conclusion

- Claim removal, durable state transition, scheduler ticket/offer state, and fencing are committed together on invalidation; no stale active claim or offer remains.
- Candidate construction, semantic analysis, digest work, graph application, readiness planning, and replay building remain outside both global mutexes.
- The durable prepared-generation field implements the already approved idempotency/replay contract and is backward compatible, so no `decisions.md` or design-spec change is required.
- No blocking concerns remain.
