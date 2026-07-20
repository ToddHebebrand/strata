# Task 7 (gate 2) — Gate-2 observability acceptance suite + scripts: report

> Note: `.superpowers/sdd/task-N-report.md` paths are reused per gate slice. The
> prior contents of this path were the gate-1 Task-7 crash-injection report
> (committed at 8e563e1 — safe in history); the brief directs the gate-2 Task-7
> report here, so it is overwritten.

**Status: PASS.** The live gate-2 per-stage observability acceptance suite is
implemented and green against the real instrumented kernel-arm T03 flow; the
`kernel:gate2:test` script is wired and `kernel:full-key-free:test` extended.
Both full-verification commands are fully green. One real Task-6 parser defect
was surfaced by this FIRST live run and fixed consumer-side — the acceptance
oracle itself is unmodified.

## Implementation

- **Created** `packages/live-compare/tests/gate2Observability.test.ts` — the
  gate oracle, transcribed from the brief. All eight numbered categories, the
  phase-coverage assertion (submitAnalysis / claimAnalysis /
  preCandidateAnalysis / postCandidateAnalysis / candidate), the all-`ok`
  outcome assertion, and the three cross-invariants are present exactly as
  specified. 300 s vitest timeout.
  - **Only mechanical adjustment (category a):** `__dirname` →
    `import.meta.dirname` to compute `repoRoot`. Every sibling suite in
    `packages/live-compare/tests/` uses `import.meta.dirname`; the sources are
    ESM-style (`.js` specifiers, `import.meta`), run through vite/esbuild. Both
    forms yield the identical `repoRoot`. No call-signature changes were needed:
    Task 6's `runGate2KernelFlow(corpusRoot)` → `{records, profile}` and
    `writeGate2Artifacts(profile, records, outDir)` match the brief's
    consumption exactly, and the `Gate2Profile` shape the oracle reads is as
    landed.

- **Modified** root `package.json`:
  - Added `kernel:gate2:test`, mirroring `kernel:gate1:test`'s build prelude
    verbatim (`kernel-bridge build && live-compare build && cargo build -p
    strata-kernel && cargo build -p strata-kernel --features redb-spike-api`),
    ending in `pnpm --filter @strata-code/live-compare test gate2`.
  - Appended `&& pnpm kernel:gate2:test` to `kernel:full-key-free:test`.
  - **Filter note:** the vitest filter `gate2` matches BOTH the acceptance test
    (`tests/gate2Observability.test.ts`) AND `tests/gate2Profile.unit.test.ts`.
    Expected and fine — both pass (2 files / 11 tests).

## Live-flow surprise + how diagnosed (the one real finding)

The very first live run went RED — but NOT in the oracle's assertions. It failed
inside Task 6's `parseMetricsJsonl` (gate2.ts:137) with a zod error:

```
Invalid input: expected number, received null   (path: worker.validateNs)
Invalid input: expected number, received null   (path: worker.exportNs)
```

Root cause, traced across the stack (no threshold touched):
- The daemon's Rust `WorkerSelfMetrics`
  (`crates/strata-kernel/src/bridge/protocol.rs:955-962`) declares each
  per-stage field as `Option<u64>` with **no** `#[serde(skip_serializing_if)]`.
  A stage a run never entered (`validateNs`/`exportNs` on an analyze-only run)
  is therefore serialized into the `--metrics` JSONL as an explicit
  `"validateNs": null` — NOT omitted. This is the authoritative producer format
  (the daemon is landed; the Rust suite `local_service_metrics.rs` reads this
  same JSONL).
- Task 6's zod schema (`gate2.ts` `workerSelfMetricsSchema`) declared those
  fields `nonNegInt.optional()`. Zod `.optional()` accepts omitted/`undefined`
  but REJECTS `null`. Task 6's unit fixture (`gate2Profile.unit.test.ts`) used
  *omitted* fields, so this mismatch was never exercised until this first live
  gate.

Fix — consumer-side, minimal, matching the producer's real wire format:
- `workerSelfMetricsSchema` per-stage fields `.optional()` → `.nullish()`
  (nullable + optional): a tolerant superset that accepts the daemon's `null`
  AND a hand-omitted field, so the pure-unit test stays green too.
- Widened the hand-written `Gate2Profile.workerRuns[].worker` interface stage
  fields to `number | null` (optional) to mirror the emission, and narrowed the
  one markdown-render use of `validateNs` from `!== undefined` to `!= null` so
  `tsc -b` passes.

This is a genuine Task-6 defect, fixed in the direction of the authoritative
producer. It does NOT weaken the acceptance oracle — the eight categories,
phase coverage, all-`ok`, and cross-invariants are untouched and all passed on
the real flow once the parser accepted valid daemon output. (Rejected
alternative: changing the daemon to omit `null` fields — a higher-blast-radius
edit to tested Rust serialization that other consumers already handle as
`null`.)

## RED → GREEN evidence

- **RED (pre-fix):** `Test Files 1 failed | 19 passed (20)` /
  `Tests 1 failed | 158 passed (159)` — `parseMetricsJsonl` zod
  `invalid_type … received null` at `worker.validateNs`/`worker.exportNs`.
- **GREEN (post-fix, cold live run):** `Test Files 20 passed (20)` /
  `Tests 159 passed (159)`; `gate2Observability` ~223 s (cold: real daemon +
  Node bridge workers + repeated tsc). The oracle's 8 categories + invariants
  all held on the live instrumented flow.
- **GREEN (via the new `kernel:gate2:test`, warm):**
  `✓ tests/gate2Observability.test.ts (1 test) 3348ms`,
  `✓ tests/gate2Profile.unit.test.ts (10 tests)`, `Test Files 2 passed (2)` /
  `Tests 11 passed (11)`.

## Full verification tails

`PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` → **EXIT_CODE=0**,
zero `FAILED`/`error[`/`ERR_PNPM` lines. Terminal segment (appended gate2 leg):

```
> vitest run gate2
 ✓ tests/gate2Observability.test.ts (1 test) 3348ms
 ✓ tests/gate2Profile.unit.test.ts (10 tests) 6ms
 Test Files  2 passed (2)
      Tests  11 passed (11)
EXIT_CODE=0
```

`PATH=/opt/homebrew/bin:$PATH pnpm -r test` → **EXIT_CODE=0**, zero failure
lines. Per-package summaries:

```
packages/ingest        Test Files  4 passed (4)
packages/store         Test Files 36 passed (36)
packages/render        Test Files  3 passed (3)
packages/verify        Test Files 16 passed (16)
packages/agent         Test Files 20 passed | 1 skipped (21)
packages/kernel-bridge Test Files  6 passed (6)
packages/bench         Test Files 16 passed (16)
packages/cli           Test Files  7 passed (7)
packages/live-compare  Test Files 20 passed (20)  /  Tests 159 passed (159)
EXIT_CODE=0
```

## Files changed (committed)

- `packages/live-compare/tests/gate2Observability.test.ts` (new — the oracle)
- `packages/live-compare/src/gate2.ts` (parser nullability fix — Task-6 defect)
- `package.json` (`kernel:gate2:test`; extend `kernel:full-key-free:test`)
- `.superpowers/sdd/task-7-report.md` (this report)

## Self-review

- Oracle content is verbatim from the brief; the only edit is `__dirname` →
  `import.meta.dirname` (mechanical, category a). No assertion substance changed.
- The parser fix targets the authoritative producer (daemon emits `null`); it
  broadens acceptance rather than narrowing a check and keeps the pure-unit test
  green.
- `kernel:gate2:test` mirrors `kernel:gate1:test`'s prelude exactly and ends in
  `test gate2`. `kernel:full-key-free:test` now ends `… && pnpm
  kernel:gate1:test && pnpm kernel:gate2:test`.
- Both long verifications were run to completion (backgrounded run + completion
  sentinel to beat the 10-min tool cap; the supervisor did not kill either) and
  both are EXIT_CODE=0.

## Concerns

1. **Task-6 defect fix touches landed code.** I edited `gate2.ts` (Task 6's
   module) rather than only my two nominal files. This is the honest, minimal
   fix for a genuine wire-format/parser mismatch the first live run exposed; it
   is consumer-side and preserves the oracle. Flagged for operator awareness.
2. **A foreign uncommitted change was left out of my commit.**
   `.superpowers/sdd/task-6-report.md` showed as modified during my session
   though the tree started clean and I never authored it — it is the gate-2
   slice's own Task-6 report (the committed version is still the gate-1 one),
   evidently written to disk but not committed by the Task-6 execution. I did
   NOT `git add -A` blindly (which would have swept it in); I staged only my
   Task-7 files explicitly. The `task-6-report.md` change is left unstaged for
   its owner to commit.

## Final-review fix round

**Finding (whole-branch review):** the acceptance oracle's worker-starts
cross-check was vacuous. `buildGate2Profile` set
`totals.workerStarts = workerRunRecords.length`, so
`expect(profile.totals.workerStarts).toBe(profile.workerRuns.length)` in
`gate2Observability.test.ts` was a tautology. The real spawn-anchored counter
(`Kernel::worker_starts_total()`, already public) never reached the JSONL, so a
spawned child that failed to produce a terminal `workerRun` record would have
been invisible to the gate oracle.

**Fix (exactly as scoped — no wire/audit/recovery/workerRun changes):**

1. **Rust producer.** `MetricsRecord::Request` gained a
   `worker_starts_total: u64` field (auto camelCased to `workerStartsTotal` by
   the enum's `rename_all_fields`), documented one line as a monotonic
   daemon-lifetime counter. `MetricsRecord::request(...)` takes it as a new arg;
   `session.rs::emit_request_metrics` populates it from
   `self.kernel.worker_starts_total()` at emission. Recovery/workerRun records,
   the audit journal, and the wire protocol are untouched; metrics stay opt-in.
2. **Rust integration test.** `local_service_metrics.rs` now asserts every
   request record carries `workerStartsTotal` and that the FINAL request
   record's value equals that daemon's total `workerRun` record count (all
   outcomes) — closing the "spawn without a terminal record" hole at the
   integration level. Existing assertions kept.
3. **TS consumer.** `requestRecordSchema` gained required
   `workerStartsTotal: nonNegInt`. `buildGate2Profile` now splits the
   concatenated cold+restart stream into its two daemon legs at the
   `recovered:true` recovery boundary (seq resets per daemon, so it is not a
   cross-leg key — the recovery record is), and a `legWorkerStarts` helper takes
   each leg's final request record's `workerStartsTotal`, **throwing** if it
   differs from that leg's `workerRun` count.
   `totals.workerStarts = coldFinal + restartFinal` — the real spawn-counter
   total, not the drain-derived record count.
4. **Oracle unchanged.** `gate2Observability.test.ts`'s
   `expect(profile.totals.workerStarts).toBe(profile.workerRuns.length)` is
   retained as the readable surface assertion; it now tests real data (the
   builder would have thrown on any per-leg spawn/terminal mismatch first). No
   other assertion weakened.
5. **Unit test.** `gate2Profile.unit.test.ts` fixtures gained the required field
   (submit=1, advance=2), and one new case (`advance.workerStartsTotal=3` vs 2
   worker runs → builder throws `/spawn\/terminal mismatch/`). 10 → 11 tests.

**Commands + output tails (all foreground, `PATH=/opt/homebrew/bin:$PATH`):**

- `cargo test -p strata-kernel --test local_service_metrics` →
  `test result: ok. 2 passed; 0 failed`.
- Three-config feature matrix (compile+test), each verified via captured exit
  code: default `EXIT=0` (36 `test result: ok` lines, 0 failures),
  `--features coordination-test-api` `EXIT=0`, `--features redb-spike-api`
  `EXIT=0`; zero `FAILED`/`panicked`/`error[` lines in any.
- `pnpm kernel:gate2:test` (builds daemon default + redb-spike-api, live flow) →
  `Test Files 2 passed (2)` / `Tests 12 passed (12)`
  (`gate2Observability` live 3671ms — the new per-leg cross-check did NOT throw
  on real daemon output; `gate2Profile.unit` 11 tests).
- `pnpm --filter @strata-code/kernel-bridge build && … live-compare build && …
  live-compare test` → `BUILD_EXIT=0`, `TEST_EXIT=0`,
  `Test Files 20 passed (20)` / `Tests 160 passed (160)` (was 159; +1 new unit
  case), duration 269s.

**Files changed:** `crates/strata-kernel/src/bin/strata_kernel_service/metrics.rs`,
`crates/strata-kernel/src/bin/strata_kernel_service/session.rs`,
`crates/strata-kernel/tests/local_service_metrics.rs`,
`packages/live-compare/src/gate2.ts`,
`packages/live-compare/tests/gate2Profile.unit.test.ts`, and this report.
`gate2Observability.test.ts` deliberately unchanged.
