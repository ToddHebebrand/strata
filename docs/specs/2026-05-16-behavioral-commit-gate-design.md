# Spec — Behavioral commit gate (one shared finish line)

*Status: draft for review. Date: 2026-05-16. Governed by `strata-design.md` + `decisions.md` (this spec, once approved and built, gets a `decisions.md` entry per the project's append-only discipline).*

## Problem

The agent's only commit gate is `commit(db, tx)` in `packages/verify/src/validate.ts`. It calls `validate(db, tx)` — an **in-memory type-check** of the rendered transaction state — and finalizes the change if the type-checker is clean. It never runs the project's tests.

The benchmark *scorer* judges success differently: `substrateQualityFromRendered` in `packages/bench/src/configs/substrate.ts` renders the result to a real folder, runs `tscNoEmitSrc` (src-scoped type-check) **and** `vitestRun` (the corpus's real test suite), and only calls the task passed if the tests pass.

So the agent's finish line ("it type-checks") and the grader's finish line ("the tests pass") are two different functions in two different packages. This is the diagnosed root cause of the Phase 1.5 multi-step boundary:

- **T08:** agent changed a return type, types still lined up, `validate` was clean, `commit` accepted it — the corpus test for that behavior was failing the whole time and the agent never saw it. *Confident-and-wrong commit.*
- **T01 (post-prompt):** same shape of confident-wrong commit on the callsite fan-out path.

`decisions.md` (2026-05-15, "Phase 1.5-P … terminal") records this is **not** prompt-tunable and names this exact lever: gate commit on behavioral task-acceptance, not just `tsc`-clean. It is explicitly a loop/architecture change, not a prompt pass.

## Goal

Make the agent's commit gate enforce the **same** behavioral check the grader already uses, by **unifying both onto one shared function**. A change that compiles but fails the corpus tests must be **refused at commit**, with the failing test output handed back to the agent the same way type diagnostics are handed back today, so the agent must keep working (or exhaust budget — an honest failure) instead of finishing wrong.

## Non-goals (YAGNI)

- No new agent tool. `run_tests`-as-a-callable-tool (the rejected "Option C") is out of scope. The cheap in-memory `validate` tool stays exactly as-is as the agent's fast pre-check.
- No prompt/tool-description rework. That lever is recorded as exhausted.
- No stronger-model evaluation. Separate, independently-named lever; not this spec.
- No change to the proven T03 rename path's behavior. T03 is the regression guard.
- No change to `commit()`'s existing signature/behavior for non-corpus callers (CLI, unit tests). The 170 key-free tests must stay green **unchanged**.

## Design

### One shared runner, lowered into `@strata/verify`

The on-disk render + type-check + test runner moves **down** the package graph from `@strata/bench` into `@strata/verify`. The package order is `bench → agent → verify → render/store`; `verify` already depends on `@strata/render` and `@strata/store`, and the runners only additionally shell out to the `typescript` and `vitest` binaries resolved from the repo-root `node_modules` (the pattern `quality.ts` already uses). Lowering it is therefore acyclic and lets **both** the agent commit gate (`verify`) **and** the benchmark scorer (`bench`) call the identical function — the two finish lines become one *by construction*, not by convention.

Relocated from `packages/bench/src/quality.ts` into `@strata/verify` (e.g. `packages/verify/src/corpusRun.ts`), behavior-preserving:

- `renderStoreToDir`, `tscNoEmit`, `tscNoEmitSrc`, `assertSrcOnlyScope`, `resolveCorpusTsconfigInclude`, `resolveTscProgramRootNames`, `vitestRun`, `QualityResult`.

`@strata/bench` re-exports these from `@strata/verify` (its `index.ts` barrel and `configs/*` imports switch to the verify source) so no bench-side behavior or test changes. The `scopeEquivalence` discipline (`decisions.md` R2c) is preserved: bench still scores through the same logic, now sourced from verify.

### The behavioral materialize-and-run step

Generalize the exact tree `substrateQualityFromRendered` already builds into a reusable verify function:

```
runCorpusAcceptance(renderedSrc: Map<relPath, text>, corpusRoot): {
  tscClean: boolean
  vitestPassed: boolean
  failureOutput: string   // captured tsc/vitest stdout+stderr for the agent
}
```

Steps (lifted verbatim from `substrateQualityFromRendered`, plus capturing failure text):
1. temp dir; write each `renderedSrc` entry under `src/`.
2. copy `tsconfig.json`, `package.json`, `vitest.config.ts` from `corpusRoot`.
3. copy the seed `tests/` from `corpusRoot`.
4. symlink the repo-root `node_modules` into the temp tree.
5. `tscNoEmitSrc(temp)` then `vitestRun(temp)`; capture their subprocess output.
6. remove the temp dir (existing `finally`).

`vitestRun` already returns `vitestPassed: true` when the corpus has no test files (`hasVitestFiles`). So on a test-less corpus the gate degrades to today's type-only behavior — it only bites when a real fail-before/pass-after suite exists (`examples/medium` has one). This is intended.

### Rendering the *pending* transaction state

The gate runs **before** finalize, so it must render the transaction's pending overlay state — exactly what `validate()` already does in `validate.ts:25–42`. Extract that "render every module at the tx overlay state → `Map<absPath, text>`" block into a shared helper used by **both** `validate()` (unchanged behavior — it still feeds the in-memory tsc program) and the new gate (which writes the Map to `src/`). The Map's paths map to corpus-`src`-relative paths the same way `renderStoreToDir` already computes (`path.relative(srcRoot, module.path)`).

### The gated commit (additive — `commit()` itself is untouched)

Add a new function in `@strata/verify`:

```
commitWithBehavioralGate(db, tx, { corpusRoot, srcRoot }): CommitResult'
```

- Run existing `validate(db, tx)` (in-memory tsc). Non-empty → `{ ok:false, diagnostics }` exactly as today.
- Render pending state → Map; `runCorpusAcceptance(map, corpusRoot)`.
- `!tscClean || !vitestPassed` → `{ ok:false, testFailures: failureOutput }` and **do not finalize**.
- Otherwise `materializeStatementPayloads` + `commitWithoutValidate` (identical to `commit()`'s tail) → `{ ok:true }`.

`commit(db, tx)` keeps its current signature and tsc-only behavior. Non-corpus callers (CLI `t03`, unit tests, the 170-test regression net) are unaffected because they call `commit()` and never supply corpus context.

### Wiring the agent

- `StrataSessionContext` gains optional `acceptance?: { corpusRoot, srcRoot }`. Both are values the existing substrate path already resolves: `corpusRoot` is the `runAgentTask`/`runAgentT03` parameter, and `srcRoot` is the same corpus source root the existing T03/scorer path already passes to `renderStoreToDir` (`<corpusRoot>/src` for `examples/medium`). The session threads both in; no new resolution logic is introduced.
- The `commit_transaction` tool handler: if `ctx.acceptance` is set, call `commitWithBehavioralGate`; otherwise call `commit` (preserves replay/key-free agent tests that construct a context without a corpus).
- The tool's result shape stays `content:[{type:"text", text: JSON.stringify(...)}]`. On behavioral failure it returns `{ ok:false, testFailures }` — the agent receives failing-test text through the **same channel** it already receives `{ ok:false, diagnostics }`, so no loop/SDK change is needed.
- The `commit_transaction` tool **description** is updated to state the truth: it finalizes only if the type-checker is clean **and the project's tests pass**, and returns the failing tests otherwise. (Tool descriptions are part of the agent's worldview per `CLAUDE.md`; this is a factual correction of the gate's contract, not the exhausted "tune the prompt" lever.)

## What this fixes — and what it honestly will not

- **Fixes:** T08 and the post-prompt T01 confident-wrong commit path. A compiles-but-behaviorally-wrong change cannot be finalized.
- **Will not fix alone:** T05, where the agent explored forever and never reached commit. A commit-time gate cannot help an agent that never commits. Expected; will show plainly in the re-run and be reported, not hidden.
- **May not fully fix T01:** if the agent self-collides via `replace_body` and rolls back before ever reaching the gate, the gate never engages. Also expected and reported honestly.

The point of this change is to remove the *one* failure mode the project explicitly named as the highest-leverage lever, and to make every remaining failure an *honest* failure.

## Error handling & edge cases

- **No tests in corpus:** `vitestPassed:true` (existing `hasVitestFiles`); gate = today's tsc behavior. Intended.
- **Render produces zero modules:** `{ ok:false, testFailures:"no modules rendered" }`; never silently finalize.
- **Subprocess (tsc/vitest) crash vs. test failure:** both treated as gate-fail; `failureOutput` carries the captured stdout/stderr so the agent (and the operator log) can tell which. A crash is a fail-closed, never a fail-open.
- **Temp-dir cleanup:** always in `finally` (as `substrateQualityFromRendered` already does).
- **`vitest` resolvable from verify:** confirmed-at-implementation via the existing `require.resolve("vitest/vitest.mjs")` repo-root pattern; if it is not resolvable, that is an implementation blocker to surface, not to work around with a copied binary.

## Bail signals (declared up front, per project ethos)

Stop and log in `decisions.md` rather than paper over, if:

- **BG-1 (flaky gate):** a behaviorally-correct change intermittently fails the gate (test or subprocess non-determinism). Do **not** add retry-masking; surface it — a non-deterministic gate is a finding about the gate, not noise to suppress.
- **BG-2 (gate cost):** a single commit-gate invocation is so slow it dominates the loop. Reference point: the scorer already pays one render+tsc+vitest per trial today and that is tolerated; a *per-commit-attempt* cost of the same order on `examples/medium` (seconds) is acceptable. If it is materially worse, surface it before optimizing.
- **BG-3 (scorer divergence):** after the relocation, the bench `scopeEquivalence`/regression tests do not stay byte-identical-green. The relocation must be behavior-preserving; if it is not, stop — a changed scorer invalidates every number.
- **BG-4 (T03 regression):** the proven rename win changes at all under the keyed re-run. T03 is the regression guard; any movement is a stop-and-diagnose, not a proceed.

## Testing & acceptance

**Key-free (the regression net — what gets built and proven without an API key):**
- All 170 existing tests pass **unchanged**; the byte-frozen regression guards are not edited.
- `commit(db, tx)` with no corpus context is behaviorally identical (a focused test asserting tsc-only path unchanged).
- New `@strata/verify` unit tests for `runCorpusAcceptance`: pass-when-green, fail-when-tests-red, `failureOutput` populated, no-tests degrades to tsc-only, render-failure fails closed.
- The extracted "render pending tx → Map" helper proven to leave `validate()` byte-identical (behavior-preserving extraction).
- A bench-side equivalence test (mirroring the existing `scopeEquivalence` discipline) that the relocated runner sourced from `@strata/verify` returns identical results to the prior bench-local one.

**Keyed (operator-run, the real proof — costs money, needs `ANTHROPIC_API_KEY`, exactly like every prior round):**
- Re-run the four-task benchmark: **T01, T05, T08** under the new gate, with **T03 as the regression guard**. N=1 validation first (cheap), then N=3 only if the pattern warrants — the project's validation-before-distribution discipline is unchanged.
- The outcome is logged in `decisions.md` **whatever it is**: gate works / T05 still thrashes / T01 self-collides / gate is flaky/slow. A diagnosed honest result is the deliverable; a green number is not required for the work to be a success.

**Definition of done for the buildable portion:** the gate exists, is wired to the agent, the relocation is behavior-preserving, all key-free tests are green, and a `decisions.md` entry records the package move and the design divergence. The keyed re-run and its finding entry are the operator's follow-on, consistent with how Phases 3/4/1.5 were run.

## File-level change summary

- **`packages/verify/src/corpusRun.ts`** (new): relocated runners (`renderStoreToDir`, `tscNoEmit`, `tscNoEmitSrc`, `assertSrcOnlyScope`, `resolveCorpusTsconfigInclude`, `resolveTscProgramRootNames`, `vitestRun`, `QualityResult`) + new `runCorpusAcceptance`.
- **`packages/verify/src/validate.ts`**: extract the module-render-at-overlay block into a shared helper used by `validate()` (unchanged behavior) and the gate; add `commitWithBehavioralGate`. `commit()` and `validate()` keep their signatures/behavior.
- **`packages/verify/src/index.ts`**: export the new surface.
- **`packages/bench/src/quality.ts`**: becomes a thin re-export from `@strata/verify` (or is deleted with imports repointed); `configs/baseline.ts`, `configs/substrate.ts`, `index.ts` import the runners from `@strata/verify`. No bench behavior change.
- **`packages/agent/src/tools.ts`**: `StrataSessionContext.acceptance?`; `commit_transaction` handler branches to `commitWithBehavioralGate` when present; updated tool description.
- **`packages/agent/src/session.ts`** (+ `runAgentTask`/`runAgentT03` path): thread `corpusRoot`/`srcRoot` into the session context as `acceptance`.
- **`decisions.md`**: new newest-first entry for the runner relocation + the behavioral-gate design divergence; later, the operator-round finding entry.
