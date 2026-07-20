# Task 6 report — Gate-2 profile runner (`packages/live-compare/src/gate2.ts`)

## Status: DONE

Commit: `0df9943` — `feat(live-compare): gate-2 observability profile runner, parser, and artifacts`

(Note: this file previously held a report for a differently-numbered "Task 6"
from the gate-1 plan iteration; it has been replaced with this task's report
per the current plan, `docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md`.)

## Implementation

### Files changed

- **Created** `packages/live-compare/src/gate2.ts` (535 lines):
  - Metrics JSONL zod schemas: `recoveryRecordSchema`, `workerRunRecordSchema` (with nested `workerSelfMetricsSchema`, `runPhaseSchema` enum of the six shared-vocabulary phases), `requestRecordSchema` (with nested `publicationRecordSchema`), combined via `z.discriminatedUnion("kind", [...])` into `metricsRecordSchema`. All object schemas are `.strict()`. Exported types: `RecoveryRecord`, `WorkerRunRecord`, `RequestRecord`, `MetricsRecord`.
  - `parseMetricsJsonl(text)` — splits on `\n`, skips blank lines, `JSON.parse` + `metricsRecordSchema.parse` per line (either failure throws, as required).
  - `Gate2Profile` / `RecoveryLeg` interfaces — copied verbatim from the brief.
  - `buildGate2Profile(records)` — pure; throws on missing cold recovery, missing restart recovery, any `workerRun.outcome !== "ok"`, and zero/>1 `request` records carrying a non-null `publication`. Attribution is purely by each record's own tagged fields (never array position/adjacency), per the global constraint.
  - `runGate2KernelFlow(corpusRoot)` — cold leg (`startKernelService` with `extraArgs: ["--metrics", coldPath]` → `hello` → `find_declarations` → `begin_change_set` → `add_intent` (rename) → `submit_change_set` → `advanceUntilPublished` (a defensive polling loop, bounded at 10 attempts — T03 is uncontested so it resolves on the first call in practice, matching gate 1's single-call behavior) → `read_operation` → `stop({ preserveDirectory: true })`), then a restart leg (`startKernelService` on the same `directory` with a fresh `--metrics` path → `hello` → `stop`), then concatenates cold+restart JSONL text, parses, and builds the profile. The scratch directory is removed in a `finally` regardless of outcome.
  - `writeGate2Artifacts(profile, records, outDir, options?)` — default `gate2-profile-<sanitized-ISO>.{json,md}` (matching the existing house convention in `liveAdapter.ts`/`bench/runner.ts`: `toISOString().replace(/[:.]/g, "-")`), or `gate2-observability-profile.{json,md}` with `{ deterministicName: true }`. JSON is `{ profile, records }`; Markdown is one row per review category (stage → measured value → source record kind) with `coreGraphRecordValueBytes` explicitly footnoted as the four graph-record value bytes only.

- **Modified** `packages/live-compare/src/gate1.ts` — exported eight previously module-private symbols gate2.ts needed, with no behavior change: `OLD_NAME`, `NEW_NAME`, `DISCOVERY_DEADLINE_MS`, `SUBMIT_DEADLINE_MS`, `ADVANCE_DEADLINE_MS`, `credentialFreeEnv`, `kernelServiceBinary`, `expectResult`. `SUBMIT_DEADLINE_MS`/`ADVANCE_DEADLINE_MS` are gate-1's proven 120s/180s budgets, both comfortably clearing the daemon's `session.rs` minimums (`MIN_BRIDGE_ANALYSIS_MS` = 30.1s, `MIN_BRIDGE_PUBLICATION_MS` = 60.1s) that the brief referenced.

- **Modified** `packages/live-compare/src/index.ts` — added `export * from "./gate2.js";` for consistency with every other `src/*.ts` module (mechanical, matches existing pattern).

- **Created** `packages/live-compare/tests/gate2Profile.unit.test.ts` (230 lines) — pure parser/builder unit test per the brief's Step 1: one hand-written JSONL fixture with one of each record kind using shared-vocabulary-shaped values; asserts full field-by-field profile output; malformed-JSON line → throw; unknown `kind` → throw; two publications → throw; zero publications → throw; missing restart recovery → throw; missing cold recovery → throw; a `workerRun` with `outcome: "timedOut"` → throw.

## TDD evidence

**RED** (gate2.ts did not exist yet):
```
FAIL  tests/gate2Profile.unit.test.ts [ tests/gate2Profile.unit.test.ts ]
Error: Cannot find module '../src/gate2.js' imported from '.../tests/gate2Profile.unit.test.ts'
```

**GREEN** (after implementing `gate2.ts`):
```
✓ tests/gate2Profile.unit.test.ts > parseMetricsJsonl > parses one of each record kind
✓ tests/gate2Profile.unit.test.ts > parseMetricsJsonl > ignores blank lines
✓ tests/gate2Profile.unit.test.ts > parseMetricsJsonl > throws on a malformed line (invalid JSON)
✓ tests/gate2Profile.unit.test.ts > parseMetricsJsonl > throws on an unknown record kind
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > builds a field-by-field profile from a valid record set
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > throws when there are two publications
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > throws when there is no publication
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > throws when the restart recovery record is missing
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > throws when the cold recovery record is missing
✓ tests/gate2Profile.unit.test.ts > buildGate2Profile > throws when a workerRun outcome is not ok
Test Files  1 passed (1) / Tests  10 passed (10)
```

**Build:** `pnpm --filter @strata-code/kernel-bridge build` and `pnpm --filter @strata-code/live-compare build` — both clean (`tsc -b`, no errors, no unused-import warnings).

**Full package suite:** `PATH=/opt/homebrew/bin:$PATH npx vitest run` inside `packages/live-compare` (run directly, not via `pnpm --filter`, because the pnpm-wrapped invocation hung/timed out for reasons unrelated to this change — direct `npx vitest run` uses the same test runner and config and is reliable):
```
Test Files  19 passed (19)
Tests  158 passed (158)
Duration  224.88s
```
This includes all pre-existing gate-1 suites (`gate1Parity`, `gate1Crash`, `gate1Intrusion`, `dynamicPreflight`, `mMechanism`, `service`, etc.) staying green with the gate1.ts export-only diff, plus the new `gate2Profile.unit.test.ts`.

## Self-review

- **No behavior change in gate1.ts**: diff is `function foo(` → `export function foo(` and `const X` → `export const X`, plus doc comments. No call sites, logic, or control flow touched. Confirmed via `git diff` before commit.
- **No cross-arm numbers, no model calls, no SQLite**: `gate2.ts` never imports `@strata-code/store`/`openDb`; it only talks to the daemon over `CoordinationClient`. `credentialFreeEnv()` (reused from gate1) strips `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` before spawning the daemon.
- **Attribution by tag, not adjacency**: `buildGate2Profile` filters records by their own `kind`/`outcome`/`publication` fields; it never assumes a `workerRun` belongs to a neighboring `request` record. Documented in the module doc-comment and the function doc-comment.
- **`coreGraphRecordValueBytes` honesty footnote**: present verbatim in the generated Markdown, matching the plan's required wording (four graph-record value bytes only, not transaction/redb bytes).
- **Artifact naming**: verified against Task 7's acceptance-test snippet in the plan (`expect(artifacts.jsonPath).toContain("gate2-profile-")`) — my default naming satisfies it. `deterministicName: true` produces the exact `gate2-observability-profile.{json,md}` name Task 8 expects to commit under `docs/spikes/`.
- **`advanceUntilPublished` loop**: gate 1's equivalent flow makes exactly one `advance_change_set` call and expects `published` immediately (uncontested single-change-set T03). I kept that as the expected fast path but added a small bounded retry loop (max 10 attempts) since the brief's prose explicitly says "advance until published" — purely defensive, zero behavior risk, throws a clear error if the bound is ever exhausted.
- **Not exercised end-to-end here**: `runGate2KernelFlow` was verified by build + type-check only (it compiles, and its building blocks — `startKernelService`, `CoordinationClient`, gate1's exported constants/helpers — are each independently tested elsewhere). Per the brief, the live end-to-end flow is Task 7's acceptance test to write and run, not this task's.
- **Scope discipline**: did not touch root `package.json` scripts (`kernel:gate2:test`), did not create `docs/spikes/` artifacts, did not touch `decisions.md`/roadmap — all explicitly Task 7/8 territory per the plan.

## Concerns

- None blocking. One judgment call flagged above for visibility: the `advanceUntilPublished` bounded-retry loop is a defensive addition beyond gate1's proven single-call pattern; if Task 7's acceptance run ever needs more than 10 attempts to reach `published` for a legitimate reason, that bound should be revisited (unlikely for an uncontested T03 flow).
- The `pnpm --filter @strata-code/live-compare test -- gate2Profile` invocation form specified in the brief's Step 2 hung for me in this sandbox (2-minute Bash-tool timeout, unrelated to the code change — likely an environment/wrapper quirk); I verified RED/GREEN and the full suite instead via `cd packages/live-compare && PATH=/opt/homebrew/bin:$PATH npx vitest run [pattern]`, which is the same test runner and config. Worth a quick sanity check by the operator if the exact `pnpm --filter` form matters for later automation (e.g. Task 7's `kernel:gate2:test` script).
