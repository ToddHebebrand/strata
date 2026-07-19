# Codex review: concurrent-advance FIFO violation (gpt-5.6-sol, xhigh, read-only, 2026-07-19)

Brief: [2026-07-19-concurrent-advance-fifo-review-brief.md](2026-07-19-concurrent-advance-fifo-review-brief.md). Tokens used: 375,805.

Verdict: this is a kernel defect, but the implementer report identifies the wrong race. The younger ticket never bypasses the older offer or active claim. Repeated polling of the queued younger ticket mutates `age_rounds`, advances the global scheduler revision, and repeatedly invalidates the older ticket’s prepared publication. After three retries, the daemon mislabels that coordination failure as candidate validation failure, cancels the older claim, and only then allows the younger ticket to publish.

## 1. Exact mechanism and interleaving

1. A and B are genuinely concurrent: the daemon uses one thread per connection, while mutation serialization is keyed by change-set ID; A and B have different IDs. [server.rs:49-56](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49), [session.rs:270-275](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:270), [gate1Intrusion.test.ts:407-420](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Intrusion.test.ts:407)

2. A receives the older durable queue sequence and becomes `Ready`; B receives the next sequence and remains `Queued`. Both renames reserve the same `symbol:<declarationId>` key. [coordinator.rs:256-274](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:256), [coordinator.rs:300-309](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:300), [provider.rs:164-178](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:164)

3. The report’s claim-race explanation is incorrect. While A is `Ready`, `offered_overlap` blocks B. After A claims, the claim’s full scope is inserted into `active`, and `active_overlap` blocks B. `older_overlap` does omit `Claimed`, but it does not need to represent claims because `active_overlap` does so separately. The independent runnable check enforces the same active/offer exclusions. [scheduler.rs:283-302](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:283), [scheduler.rs:375-410](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:375), [scheduler.rs:586-623](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:586)

4. If B’s first reconsideration races A’s claim CAS, A simply retries when the scheduler revision changes; B still cannot obtain an overlapping offer. The claim remains active through candidate construction and is released only as part of publication completion or another explicit lifecycle transition. [coordinator.rs:319-363](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:319), [coordinator.rs:500-519](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:500), [publication.rs:486-509](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:486)

5. The actual problem is B’s polling loop. Every nonterminal queued advance calls `reconsider_tickets`; the test does this every 250 ms. B is correctly skipped because of A’s offer/active claim, but every skipped scheduling pass increments B’s durable `age_rounds`. [gate1Intrusion.test.ts:92-110](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Intrusion.test.ts:92), [session.rs:579-595](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:579), [scheduler.rs:297-325](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:297)

6. Because ticket equality includes `age_rounds`, that increment becomes a lifecycle ticket update; any lifecycle change advances the scheduler revision and is persisted. Thus a read-like queued poll is not idempotent despite the daemon comment claiming it is. [model.rs:380-416](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/model.rs:380), [coordinator.rs:1308-1330](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:1308), [planner.rs:244-285](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/planner.rs:244), [coordinator.rs:801-805](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:801)

7. A builds and validates outside the locks, then prepares publication against an exact scheduler revision and complete scheduler snapshot. Any intervening B age increment fails the final equality check. After three such losses, A gets `OptimisticRetryExhausted`. This happens before the redb transaction, so A is not fenced out by B’s committed rename; it is starved by scheduler-metadata churn. [publication.rs:375-415](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:375), [publication.rs:633-655](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:633), [publication.rs:695-727](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:695), [publication.rs:729-739](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:729)

8. The daemon discards the error type, synthesizes `validation_failed`/`candidate_validation_failed`, and schedules cancellation. The follow-up runs before the response is returned. Cancellation removes A’s active claim and immediately replans queued work; only then can B become ready, claim, and publish. [session.rs:652-682](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:652), [session.rs:367-387](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:367), [coordinator.rs:902-968](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:902)

Therefore, the priority is not lost at offer creation, claim CAS, or reservation holding. It is lost as a liveness failure at the final optimistic publication check, caused by younger polling that changes scheduler age/revision while remaining properly blocked.

## 2. Verdict: kernel defect

This violates the governing contract:

- During validation, newer conflicting work must not starve the validating change set. [kernel design:151-154](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:151)
- FIFO applies per semantic resource, and newer work may pass only when complete scopes are disjoint. [kernel design:170-176](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:170)
- The deterministic acceptance oracle explicitly requires same-symbol renames to be ordered, with the second receiving fresh state and `IntentNeedsDecision`. [kernel design:281-298](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:281)

The current kernel does provide a valid local scheduling guarantee: within each scheduler snapshot, a ticket cannot become ready when it overlaps an active claim, an offered scope, a ticket selected in that pass, or an older queued/ready ticket. It also rejects directly marking such a ticket runnable. [scheduler.rs:283-302](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:283), [scheduler.rs:586-623](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:586)

But narrowing the contract to that snapshot-local guarantee would gut the validation-priority and starvation clauses: a younger client could abort older validation merely by polling frequently. The correct resolution is a kernel fix, not a spec correction.

## 3. Minimal fix

The smallest targeted fix is:

> A `Reconsideration` pass that produces no offer, scope, state, claim, or event change must not persist `age_rounds`-only differences or advance the scheduler revision.

`plan_readiness` already receives a transition cause, but currently discards it. Its lifecycle-change decision treats any ticket difference—including age alone—as revision-worthy. [planner.rs:76-93](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/planner.rs:76), [planner.rs:244-288](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/planner.rs:244)

Concretely, preserve aging on real scheduling transitions—submission, publication, cancellation, expiry, scope requeue—but suppress a pure polling pass whose only result is incrementing blocked tickets’ ages. This keeps queued `advance_change_set` available for the dynamic-requeue case documented by the daemon while making “still blocked by the same offer/claim” observationally idempotent. [session.rs:584-590](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:584)

I would not:

- Extend `older_overlap` to `Claimed`: claimed work is already represented by `active_overlap`.
- Add another reservation layer: the active claim already holds the complete inferred scope.
- Hold the global scheduler/publication lock through Node validation: that would regress the deliberately restored unlocked/disjoint-progress architecture. [decisions.md:1136-1148](/Users/toddhebebrand/Strata/decisions.md:1136)

Risk assessment:

- **Deadlock:** none added; this fix introduces no new lock and preserves all-or-nothing acquisition. [kernel design:170-173](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:170)
- **Starvation:** improves, because polling rate can no longer exhaust the older publication’s retries.
- **Aging:** remains transition-driven instead of client-poll-driven. Existing strict FIFO still prevents a highly aged younger overlapping ticket from passing an older one; age only orders tickets that are already FIFO-eligible. [scheduler.rs:260-295](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:260), [coordination_scheduler.rs:172-195](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/coordination_scheduler.rs:172)

Residual concern: exact full-scheduler equality means legitimate repeated disjoint scheduler changes can still exhaust publication retries. [publication.rs:695-727](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:695) A broader fix would rebase the release/readiness lifecycle onto the latest scheduler or fence against claim-relevant state rather than the entire scheduler. That is higher-blast-radius and is not necessary to repair this two-ticket overlap gate, but it deserves a separate deterministic liveness regression.

## 4. Loser exit state

`validation_failed` is definitely wrong here, but `needs_decision` is not the correct universal replacement.

`OptimisticRetryExhausted` is a distinct coordination error, not a candidate-validation error. [model.rs:5-12](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/model.rs:5) For scheduler-only churn, no semantic decision is required; the correct outcome is internal retry or an atomic same-scope requeue/retry, without fabricating a validation diagnostic.

When a real concurrent publication changes dependency clocks or semantic scope, the publication path already has the correct mechanism: it persists fresh analysis and returns `Requeued` or `NeedsDecision`; a material scope change releases the claim directly to `NeedsDecision`. [publication.rs:686-693](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:686), [publication.rs:925-947](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:925), [publication.rs:997-1034](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:997)

The daemon should therefore distinguish:

- Semantic invalidation → existing `Requeued`/`NeedsDecision`.
- Genuine candidate/tsc validation failure → `validation_failed`.
- Optimistic scheduler contention → retry/requeue, not cancellation and not `NeedsDecision`.

The current catch-all `_error` branch erases precisely that distinction. [session.rs:638-682](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:638)

## 5. Exact concurrent test oracle

The live test should retain a single required winner:

1. Capture submit results and assert:

   - A submit: `ready`.
   - B submit: `queued`.
   - Both target the same stable declaration ID.

2. Run both polling advances concurrently and assert both promises fulfill.

3. Assert A:

   - `state === "published"`.
   - Non-null `operationId` and publication digest.
   - Generation is initial generation + 1.
   - Operation targets the declaration and records exactly `User → Account`.

4. Assert B:

   - `state === "needs_decision"`.
   - `operationId === null`.
   - Same post-A graph generation.
   - Exact transition:
     `{ nodeId: declarationId, previousName: "User", currentName: "Account" }`.
   - No `candidate_validation_failed` diagnostic.

5. Assert final durable/rendered state:

   - One committed rename operation for this conflict.
   - No B publication or `Client` rename.
   - Export is green.
   - All T03 criteria pass.
   - A’s publication digest equals the exported graph digest.

These are already the intended core assertions at [gate1Intrusion.test.ts:424-441](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Intrusion.test.ts:424); the submit-state, generation, diagnostic, and sole-operation checks should be made explicit.

I would also add a deterministic Rust regression beneath the timing-based daemon test: claim A, queue B, invoke `reconsider_tickets` repeatedly during A’s `before_final_check` hook, assert those blocked age-only passes do not change scheduler revision, then assert A publishes and B becomes `NeedsDecision`. Existing test hooks already force final-check revision losses deterministically. [coordination_optimistic.rs:1392-1439](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/coordination_optimistic.rs:1392)

No files were modified and no write-producing verification commands were run.
