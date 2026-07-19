# Review brief: concurrent-advance FIFO violation — kernel defect or contract correction?

**For:** independent expert review (read-only, repo-grounded). **Date:** 2026-07-19.

## The finding

Gate-1 Task 8 (second-client intrusion suite, `packages/live-compare/tests/gate1Intrusion.test.ts`,
currently uncommitted in the working tree) built a concurrent-advance case: client A submits an
overlapping rename (`User`→`Account`) FIRST (older durable queue sequence), client B submits
(`User`→`Client`) SECOND, then both fire `advance_change_set` concurrently (`Promise.allSettled`,
each client polling advance until terminal).

**Observed (deterministic, 3/3 in both array orders, against the real daemon on `examples/medium`):**

| | A (older submit) | B (younger submit) |
|---|---|---|
| Concurrent dead-heat | **`validation_failed`** @gen 0 | **`published`** @gen 1 |
| A given a 1-advance head start | `published` @gen 1 | `needs_decision` |
| Fully sequential (A then B) | `published` @gen 1 | `needs_decision` |

So the winner is decided by claim-race order, not durable submit order; under a true dead-heat the
younger ticket wins and the older loser exits via `candidate_validation_failed` rather than the clean
`needs_decision` the younger loser gets in the sequential path. Safety holds in all runs: exactly one
rename commits, no silent overwrite, tree green.

## The governing contract (spec text)

`docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`:

- §"Scheduling and fairness" (lines 170–176): "Each semantic resource has FIFO ordering." …
  "Newer work may pass an older ticket only when the complete scopes are disjoint."
- §6 "Validate candidate" (line 153): "During validation, the change set owns queue priority for its
  semantic scope so newer conflicting work cannot starve it."

On its face the observed behavior violates both. The question is whether the implementation has a
genuine scheduling race (defect) or whether the spec's FIFO promise was never meant to cover the
claim/advance race window (in which case the spec and the test oracle need correcting instead).

## Source pointers (verified in-session)

- Thread-per-connection daemon: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49-56`
  — A's and B's advance requests run on separate threads.
- The older-overlap FIFO guard: `crates/strata-kernel/src/coordination/scheduler.rs` `select_ready_with_constraints`
  (~lines 255–305). It skips a ticket when `active_overlap || offered_overlap || selected_overlap || older_overlap`;
  `older_overlap` only counts older tickets whose state is `Queued | Ready`. A claimed/mid-validation
  older ticket is invisible to `older_overlap` (though its scope may appear via `active`/`offers`).
- Claim path: `crates/strata-kernel/src/coordination/coordinator.rs` `claim_ready` (~319–500) —
  optimistic retries against a scheduler-revision CAS; re-analyzes scope at claim
  (`classify_scope_change`); only `Expanded | MateriallyChanged` yields `NeedsDecision`.
- Publication is fenced (`coordination/publication.rs`); the losing older candidate is fenced out and
  surfaces as `candidate_validation_failed`.
- The advance loop as the client drives it: `packages/kernel-bridge` client + the daemon session's
  `advance_change_set` handler (`crates/strata-kernel/src/bin/strata_kernel_service/session.rs`).

The implementer's fuller trace and reproduction scripts are described in
`.superpowers/sdd/task-8-report.md` (§"The concurrent-advance falsifier").

## Already-falsified levers (do NOT re-propose)

1. **Pre-submit `needs_decision`**: the kernel pins scope at submit (`coordinator.rs:225-264`); a
   change set submitted after a conflicting commit re-analyzes fresh and publishes directly. This was
   probe-confirmed and ratified as the contract on 2026-07-18 (decisions.md top entry). The pre-submit
   oracle now asserts direct sequential publish — do not revisit.
2. **"Either serial order" oracles**: rejected by the prior review and by the operator — the suite
   must assert a required winner or a spec-grounded deterministic outcome, never a coin-flip
   acceptance.

## Hard constraints on any proposed fix

- No solo bypass: scope inference, fresh analysis, validation binding, reservations, and fenced
  publication must all remain engaged (falsifier 1 of the convergence review).
- Redb remains the sole durable authority; single-writer publication transaction stays.
- Deterministic key-free tests must be able to assert the resulting contract.
- Minimal-diff bias: gate 1 is a measurement gate; a large scheduler rewrite would itself need
  re-review.

## Questions for the reviewer

1. **Mechanism:** derive the exact interleaving that lets the younger ticket win a dead-heat despite
   `older_overlap`, `active_overlap`, and `offered_overlap`. Which window (offer creation, claim CAS
   retry, validation, publication fencing) actually loses the older ticket's priority? Verify against
   the code, not the report's summary.
2. **Verdict:** given the spec's FIFO-per-resource and validation-priority language, is this a kernel
   defect (fix the scheduler) or an acceptable contract narrowing (fix the spec + oracle)? If the
   latter, state precisely what FIFO guarantee the kernel DOES provide and how the spec text should
   be amended without gutting the fairness section.
3. **If defect — minimal fix:** what is the smallest change that restores "newer overlapping work
   cannot pass an older ticket" across concurrent advances (e.g., extending `older_overlap` to cover
   claimed/validating states, serializing overlapping claim scheduling, or reservation-holding through
   validation)? Call out deadlock/starvation risks and how ticket aging interacts.
4. **Loser exit state:** regardless of 2/3 — should an older ticket that loses fenced publication be
   routed to `needs_decision` (fresh decision with named transitions) instead of
   `candidate_validation_failed`? The asymmetry (younger loser gets the clean path, older loser the
   rough one) looks unintended.
5. **Test oracle:** state the exact assertion set the concurrent-advance case should carry under your
   recommended resolution, keeping the no-either-order rule.

Answer with file:line evidence for every load-bearing claim.
