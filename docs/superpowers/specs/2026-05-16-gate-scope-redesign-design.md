# Gate-scope redesign: a task-scoped behavioral commit gate

*Spec. Date: 2026-05-16. Follows the BG-4 finding in [`decisions.md`](../../../decisions.md) (2026-05-16, "Keyed behavioral-gate re-run: BG-4 TRIGGERED"). Supersedes the whole-suite scope of the gate built in [`docs/specs/2026-05-16-behavioral-commit-gate-design.md`](../../specs/2026-05-16-behavioral-commit-gate-design.md); the gate==scorer architecture from that spec is retained.*

## Problem

`runCorpusAcceptance` in `@strata/verify/src/corpusRun.ts` runs the **entire** corpus vitest suite (`vitest run`, no scoping). The shared seed `examples/medium` deliberately co-locates every benchmark task's fail-before fixture:

- `tests/dateRange.test.ts` — `describe("isWithinRange (T05 - half-open interval)")`, red against the buggy seed `src/lib/dateRange.ts` — **is the T05 task**.
- `tests/format.test.ts` — `describe("formatTimestamp timezone parameter (T01)")` — **is the T01 task**.
- T03 (rename) and T08 (change_return_type) ship **no** behavioral fixture.

Because the gate runs the whole suite, it is **structurally unsatisfiable for T01/T03/T08 by the correct task change alone**: every first `commit_transaction` is rejected by the unrelated T05 red. The keyed re-run proved the agent then fixes the T05 bug as collateral (T08 verbatim: *"I need to fix isWithinRange in the same transaction"*), which (a) **triggered BG-4** — the proven atomic T03 rename became a two-transaction rename-plus-unrelated-bugfix (1473→2176 tok, 11→12 tools, 30→45 s) — and (b) contaminated the scorer (T03/T08 `vitestPassed=1` reflects the agent fixing T05, not clean task signal).

The behavioral-gate *concept* is not refuted. The gate is invalid against a corpus that co-locates multiple tasks' fail-before fixtures in one shared suite. It must be **task-scoped**.

## Goal

The behavioral gate runs only the **active task's own behavioral fixture(s)**. A correct task change commits in a single transaction with no unrelated collateral. The agent commit gate and the benchmark scorer remain **one shared computation** per task. The proven T03 path is re-established exactly (regression guard). No corpus restructuring.

## Non-goals

- No new behavioral fixtures for T03/T08. Justification: T08's failure mode is fully tsc-catchable — `getRole`'s body is `ROLES[userId] ?? "viewer"` with `ROLES: Record<string,string>`, so narrowing the return type to `"admin"|"editor"|"viewer"` without fixing the body is a hard `tsc` error caught by the src-only typecheck the gate already runs; T03 (rename) has no behavioral-only failure mode. The original 2026-05-15 "T08 confident-wrong commit" was the whole-suite vitest being red from T05's contamination, not a genuine T08 hole. A fabricated T03/T08 fixture would only re-assert what tsc + text-criteria already enforce.
- No per-task corpus isolation (heavier; re-opens the Phase 1.5 scorer-asymmetry risk; achieves nothing scoped selection doesn't).
- No "no test regressed vs. baseline" semantics (degrades the gate from a task-acceptance signal to a weaker non-regression signal).
- The second open lever (a stronger model at the 11-tool surface) is untouched and stays logged as open.

## Approach: task-scoped fixture selection

### Invariant preserved: scoping is additive

`runCorpusAcceptance(rendered, corpusRoot, fixtures?)`. When `fixtures` is **`undefined`** (every existing key-free caller — `quality.test.ts`, `materializeOfflineVitest.test.ts`, `seedTscClean.test.ts`) behavior is **byte-identical to today** (whole suite). This is the BG-3 safety mechanism: the key-free suite (`pnpm -r test` = 176 passing / 2 key-gated skipped) cannot move, by construction, because no key-free caller passes `fixtures`. Only the two live consumers (the commit gate and the scorer's `vitestPassed` sub-metric) pass an explicit list.

### Components

**1. Authoritative fixture map — `@strata/verify/src/taskBehavioralFixtures.ts` (new).**

```
TASK_BEHAVIORAL_FIXTURES = {
  T01: ["tests/format.test.ts"],
  T05: ["tests/dateRange.test.ts"],
  T03: [],
  T08: [],
}
behavioralFixturesForTask(taskId: string): readonly string[]
```

Lives in `@strata/verify` (lowest layer that needs it; keyed by plain string id so there is no `bench→verify` import cycle). **Fail-loud:** an unrecognized task id *throws* — it is never silently treated as whole-suite or as empty. Registering a 5th task is thereby forced to be a deliberate edit here. This is the single source of truth that replaces today's implicit signals (describe-tag suffixes `(T01)`/`(T05)`, `T05_TEST_KEY`, the agent's hardcoded `tests/dateRange.test.ts` hint string in `session.ts`).

**2. Plumb task identity to the gate.** `AcceptanceContext` (`agent/src/tools.ts`, constructed in `agent/src/session.ts`) gains `taskId: string`. `commitWithBehavioralGate` resolves `behavioralFixturesForTask(ctx.taskId)` and passes the list to `runCorpusAcceptance`. The bench substrate config already knows the id (`runSubstrateTaskTrial("T08", …)`); thread it through `runParams` → session → `AcceptanceContext`. The T03 substrate path (`runSubstrateTrial`, currently id-less) is given `"T03"` so it resolves deterministically to `[]`.

**3. Scoped `vitestRun(treeRoot, fixtures?)`.**
- `undefined` → `vitest run` (unchanged; key-free callers).
- `[]` → **skip vitest**, return `{ vitestPassed: true, output: "" }` (tsc-only task — nothing behavioral to assert).
- non-empty → `vitest run <files…>` (only the named files).

The whole `tests/` directory is still copied into the scratch tree (no per-task copy filtering — that is what re-introduces scorer asymmetry). Unscoped files are present but never executed.

**4. Scorer uses the identical list.** The bench quality sub-metric (`substrateQualityFromRendered` and the baseline analog) resolves `behavioralFixturesForTask(taskId)` too, so the scored `vitestPassed` and the gate decision are the same computation per task. Gate == scorer is preserved by construction.

### Data flow (live T08 substrate run)

`runSubstrateTaskTrial("T08")` → `runParams.taskId="T08"` → `AcceptanceContext{ corpusRoot, srcRoot, taskId:"T08" }` → agent calls `commit_transaction` → `commitWithBehavioralGate` resolves `[]` → `runCorpusAcceptance(rendered, corpusRoot, [])` → src-only `tsc` (catches the `string`→literal-union narrowing error if the body is unfixed — T08's real failure mode) + vitest skipped → commit succeeds in **one** transaction on a correct change, with no unrelated T05 red. T03 is identical (`[]`). T01 → only `format.test.ts` runs. T05 → only `dateRange.test.ts` runs.

### Error handling (fail-loud, no silent green)

- Unknown task id → throw (forces registration).
- A named fixture file absent from the corpus → explicit error surfaced in `failureOutput`; **not** a silent pass. (A typo'd path making the gate vacuously green is the same silent-failure class the 2026-05-16 build already caught and rejected once.)
- `fixtures === undefined` → exact current behavior (key-free / BG-3).

## Testing

### Key-free regression net (must stay byte-identical green: `pnpm -r test` = 176 / 2)

New `@strata/verify` units:
- `behavioralFixturesForTask`: T01→`["tests/format.test.ts"]`, T05→`["tests/dateRange.test.ts"]`, T03→`[]`, T08→`[]`, unknown→throws.
- `runCorpusAcceptance` with `fixtures=["tests/dateRange.test.ts"]` on a tree where dateRange is fixed → `vitestPassed:true` (scoped selection proven); the same scoped to a still-buggy dateRange → `false`.
- **`runCorpusAcceptance` with `fixtures=[]` on a seed that still contains the failing `dateRange.test.ts` → `vitestPassed:true, tscClean:true`** — the precise unit-level proof that BG-4's mechanism is gone (a tsc-only task is not blocked by another task's red).
- Missing fixture path → explicit failure, not silent green.
- Assert no existing caller passes `fixtures` (preserves `undefined`⇒whole-suite, BG-3).

### Pre-committed bail signals for the next operator keyed round

Round form: `pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=1. Classified from the persisted transcripts; the outcome is logged newest-first in `decisions.md` **whatever it is**.

- **GS-1 (T03 regression guard restored):** the **hard STOP trigger is structural** — T03 substrate must return to a single clean transaction (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`) with **no `replace_body` repairing an unrelated bug** and **no second transaction**. Any residual second transaction or unrelated collateral edit ⇒ the scope fix failed, **STOP**. The proven metric band (~1200–1473 tok / 7–11 tools / 24–30 s, from the N=3 Phase 4 round) is **corroborating, not a hard N=1 gate**: a structurally-clean T03 whose N=1 metrics sit modestly outside the band is acceptable model variance; metrics materially beyond the band on a structurally-clean run are a **diagnose** (note in the log), not an automatic stop.
- **GS-2 (teeth where due):** a deliberately-wrong T01/T05 change is rejected by *its own* scoped fixture (not by another task's).
- **GS-3 (no cross-task contamination):** no task's commit is rejected by another task's fixture — the defining BG-4 symptom must be gone.
- **GS-4 (scorer == gate):** the scored `vitestPassed` sub-metric and the gate decision use the identical per-task fixture list (verified from transcript + scorer output agreeing).

## Accepted limitation (to log)

A task could behaviorally break *another* task's code with no type signal, and the scoped gate would not catch it; whole-src `tsc` still catches type-level cross-module breakage. For these four tasks on `examples/medium` this is not a real risk. Logged as a bounded, honest limitation, consistent with the project's diagnosed-and-bounded discipline.

## Design-doc impact

None to `strata-design.md`. Sharpens the prior gate decision: the shared agent/scorer finish line must be **task-scoped** to be a valid behavioral signal on a multi-task corpus.
