# Task 6 report: lifecycle-call parity from the runtime trace (gate 3)

## Implementation

Added to `packages/live-compare/src/gate3/stats.ts` (no new src file, per brief):

- `SQLITE_CANONICAL_LIFECYCLE = ["begin", "rename_symbol", "validate", "commit"] as const`
- `KERNEL_CANONICAL_LIFECYCLE = ["begin_change_set", "add_intent", "submit_change_set", "advance_change_set"] as const`
- `interface LifecycleParity { kernel: number; sqlite: number; equal: boolean }`
- `lifecycleParity(kernelTrace: readonly string[], sqliteTrace: readonly string[]): LifecycleParity` — `kernel`/`sqlite` are the traced call counts (`trace.length`, derived directly from whatever the Task-2 child actually emitted, not a hand-list). `equal` is true only when BOTH traces exactly match their canonical sequence (order and length via a private `sequenceEquals` helper) — so a same-length-but-reordered trace still reports `equal: false`. Because the counts come from the traces, a future call-structure change in `sqlite-child.ts`/`kernel-child.ts` (add/remove/reorder a wrapped call) changes what this function reports automatically.

Test file: `packages/live-compare/tests/gate3Lifecycle.test.ts` (new), three cases:
1. Canonical sequences asserted exactly (documentation/regression pin).
2. Real medium cold-run traces spawned via `gate3ChildHarness.runChild` against the compiled `sqlite-child.js`/`kernel-child.js` (`RENAME_TARGET`, mode `"cold"`, `iterations: 1`, matching `gate3Child.test.ts`'s established pattern) — asserts the raw traces first (sanity: these are real, not fabricated), then `lifecycleParity(kernelTrace, sqliteTrace)` equals `{ kernel: 4, sqlite: 4, equal: true }`.
3. Synthetic 5-call kernel trace (an extra `add_intent`) vs the sqlite canonical sequence → `{ kernel: 5, sqlite: 4, equal: false }`.

## TDD

- RED: ran `pnpm --filter @strata-code/live-compare test gate3Lifecycle` before implementing `lifecycleParity`/the canonical exports — 3/3 failed (`undefined` canonical exports, `lifecycleParity is not a function`).
- GREEN: after adding the stats.ts block and rebuilding, all 3 tests passed (the real-trace test took ~3.6-4.0s, one fresh sqlite + one fresh kernel child spawn).

## Commands run

```
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge build
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test gate3Lifecycle   # RED, then GREEN
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test gate3            # full gate3 group, regression check
```

Gate3 group result: 10 test files, 54 tests, all passed (65.27s), including the new `gate3Lifecycle.test.ts` (3 tests). No regressions.

## Files changed

- `packages/live-compare/src/gate3/stats.ts` (modified — added `SQLITE_CANONICAL_LIFECYCLE`, `KERNEL_CANONICAL_LIFECYCLE`, `LifecycleParity`, `lifecycleParity`)
- `packages/live-compare/tests/gate3Lifecycle.test.ts` (new)

## Commit

`6a7a1d5` — `feat(live-compare): lifecycle-call parity derived from runtime traces (4 vs 4)`

## Self-review

- Interfaces match the brief verbatim: `lifecycleParity(kernelTrace: string[], sqliteTrace: string[]): { kernel: number, sqlite: number, equal: boolean }` (used `readonly string[]` params, which accepts plain `string[]` call sites — no behavioral difference, slightly more permissive).
- `equal` genuinely gates on both count AND exact-sequence match, not just count equality (a `kernel.length === sqlite.length` check with no content comparison would have technically satisfied "4 == 4" but not "traces equal the expected canonical sequences" from the brief — implemented the stronger reading).
- Test consumes the real `ChildResult.lifecycle` from actual cold-spawned children (`runChild` against compiled `dist/gate3/*-child.js`), not a hand-list — matches the plan's "a future call-structure change cannot silently disagree with a hand-list" intent, and the parity counts are structurally derived (`trace.length`), so this holds even if a *future* canonical sequence changes length.
- Reused existing `gate3ChildHarness.runChild` + `RENAME_TARGET`/`mediumRoot` fixtures rather than introducing a second spawn mechanism — matches Task-2's `gate3Child.test.ts` pattern exactly, cheapest path to a real trace.
- Ran the gate3 test group (not full suite) per task instructions; no full monorepo `pnpm -r test` run performed — out of scope for this small task.

## Concerns

None. Scope was narrow and self-contained; no ambiguity encountered in the brief. Note: this file replaced a stale, unrelated "Task 6" report from an earlier gate-2 plan iteration that occupied the same path.
