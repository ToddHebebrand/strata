# Decisions

A running log of build-time decisions for Strata. Append-only. Newest at the top.

Log an entry whenever:
- A choice diverges from `strata-design.md` (swapped library, changed schema, dropped/added scope, different tool shape).
- A spec-level question from § "Open design questions" gets resolved.
- A non-obvious trade-off is made that a future reader would otherwise have to re-derive.
- An attempt fails and shapes the next attempt (record the failure too — silent retries lose information).

If the decision is durable, also update `strata-design.md` and reference the diff or commit from the entry.

## Entry format

```
## YYYY-MM-DD — <short title>

**Context:** what triggered this decision (phase, package, problem encountered).

**Considered:** the alternatives weighed (briefly).

**Decided:** what we're doing now.

**Why:** the reasoning, especially anything not obvious from the alternatives.

**Design-doc impact:** "none" / "updated § X" / "supersedes § X paragraph N".

**Revisit when:** the condition that should make us reopen this (e.g., "if Phase 4 benchmarks show ingest is the bottleneck").
```

---

<!-- New entries go below this line, newest first. -->

## 2026-05-15 — Phase 1.5 re-validation: harness now valid; T03 win replicates; new tools are NOT agent-effective (honest negative)

**Context:** Post-remediation operator re-validation, `claude-sonnet-4-6`, N=1 (8 runs $0.76) + a targeted T01/T05/T08 round ($0.43). The remediation (R1/R2/R3) is confirmed working: scoring is symmetric and valid (both configs `tsc clean 1/1` everywhere; T03 baseline passes again exactly as in the valid Phase 4 round — proving the harness is fair, not rigged).

**Result (N=1, indicative not a significance claim — and N=3 deliberately NOT run because the pattern does not hold):**
- **T03 (rename): the Phase-1 win replicates under the now-valid harness.** Both succeed; substrate ~2.9x fewer tokens (1359 vs 3910), ~1.8x faster (30.6s vs 56.4s), 0 vs 2 retries. Robust.
- **T01 (add_parameter):** substrate `error_wall_time`; at the raised 420s/40t budget it did MORE tool calls (33) than the prior 240s round (22) and still failed. More budget produced more work, not success → by the R3 anti-inflate clause this is NOT budget-bound; do not raise further.
- **T05 (the reasoning control):** baseline succeeds trivially (5 tools, 16s); substrate `error_wall_time` at 12 tool calls / 300s. The control is INVERTED — the substrate loses where the file baseline trivially wins. The strongest possible evidence the gap is the substrate, not a rigged comparison.
- **T08 (change_return_type):** substrate terminated "success" but the corpus vitest fails (0/1); it passed pre-remediation — that earlier "win" was a scoring artifact the symmetric scorer correctly destroyed.

**Decided / concluded:** Phase 1's `rename_symbol` substrate advantage is real and replicable. Phase 1.5's tool expansion (`add_parameter`, `change_return_type`, `replace_body`) does NOT generalize that advantage: the tools pass 170 unit tests but the agent cannot effectively wield them on real tasks. Do NOT run N=3 (would spend ~$3 confirming a non-pattern). Do NOT inflate budgets (forbidden by BS-R3; more budget already produced more thrash, not success).

**Instrumentation gap (a real harness defect, recorded per "log the failure too"):** the R3 spec required operator timeout classification from the session log, but `--keep-artifacts` does not actually persist a readable per-tool transcript — `substrate.ts` takes a `logPath?` and the runner threads a `keepArtifacts` boolean, but nothing converts the boolean into a concrete written log and trial records carry no `sessionLog`. So the precise budget-bound-vs-BS15E-thrash-vs-tool-ergonomics label cannot be log-classified as the protocol demands; the conclusion above is drawn from aggregates (terminal reasons, tool counts vs. budget, the inverted control), which is strong but not the spec-mandated method.

**Design-doc impact:** none to the architecture; this is an empirical finding about agent-effectiveness of the new tools + a harness instrumentation defect. The strata-design.md thesis stands on T03; it is NOT demonstrated for the broader tool set.

**Revisit when:** the keepArtifacts->logPath wiring is fixed and a cheap targeted round captures real transcripts → then classify (thrash vs ergonomics) to guide tool/prompt rework; that rework, not a benchmark re-run, is the next lever for the Phase 1.5 tools.

**Context:** Phase 1.5R's three fixes (R1 seed-clean, R2 scorer/quality scope equivalence, R3 per-task budget + classification protocol) are implemented and green key-free.

**Decided / Observed:** Acceptance holds before any operator live round: (1) unmodified seed src is `tsc --noEmit` clean under the post-R1 src-only corpus tsconfig; `tests/` remains present, in `vitest.config.ts` include, and a real fail-before signal. (2) `scopeEquivalence.test.ts` passes for all four tasks × correct/half-done/seed: substrate-side pure core and baseline-side `scoreTaskSharedCriteria` return byte-identical text booleans, and tsc scope is `["src/**/*.ts"]` with no `tests/`. (3) Per-task `maxTurns`/`wallTimeMs` are first-class in `runner.ts` and threaded unchanged into the session; T03/T08 remain 25t/240000ms by default, while T01/T05 carry the artifact-derived higher defaults; the projected-spend line prints the per-task ceiling. (4) `pnpm -r build` and `pnpm -r test` are green key-free: existing 152 passing + 2 skipped baseline held, plus 18 passing cases in the two allowed new bench test files. The genuine T03 regression guards are byte-unchanged. No BS-R1/R2/R3 fired during implementation.

**Why:** Only a valid harness may produce a number anyone should believe; the N=1→N=3 validation-before-distribution discipline is unchanged.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed re-validation N=1; record its DR-round entry regardless of outcome.

## 2026-05-15 — R3: per-task maxTurns/wallTimeMs first-class + --task-budget + timeout-classification protocol (Phase 1.5R DR3)

**Context:** Phase 1.5R remediation. Substrate T01 timed out at 22 tool calls and T05 at 17 under the 240,000 ms global wall. Budgets were single global values; the structurally bigger tasks need justified per-task budgets plus a protocol that classifies timeouts rather than inferring them.

**Considered:** (a) raise the single global budget; (b) make maxTurns/wallTimeMs per-task overridable with artifact-derived defaults for T01/T05, T03/T08 untouched, plus operator-recorded classification.

**Decided:** (b). `runner.ts` now has `PerTaskBudget`, `DEFAULT_PER_TASK_BUDGET` (T01 40t/420000ms, T05 40t/300000ms; T03/T08 no override and therefore global 25t/240000ms), `resolveTaskBudget`, `parseTaskBudget`, and `--task-budget=T01:maxTurns=40,wallMs=420000;T05:maxTurns=40,wallMs=300000`. The projected-spend line prints resolved per-task budgets. `SessionLog` `session_start` now records `wallTimeMs` alongside `maxTurns` so operator timeout classification has the configured budget in the log.

**Timeout-classification protocol (operator-recorded, never auto-inferred):** every substrate `error_wall_time`/`error_max_turns` is classified from the session log into exactly one bucket and recorded as `T0N: <bucket> — <one-sentence evidence>`: (1) budget-bound, monotonic progress; one bounded logged raise and one re-run only; (2) BS15-E thrashing, wrong-tool loops or oscillation; surface the tool-selection finding, do not inflate; (3) genuine tool-ergonomics failure, right tool cannot express the task; surface the substrate limitation. A second bucket-1 timeout at the raised budget escalates to bucket 3.

**Why:** Quantified, bounded, honest. T03/T08 budgets are unperturbed, while T01/T05 get room justified by the failing artifact without opening an inflate-until-green loop.

**Design-doc impact:** none — additive runner plumbing; the session budget contract is unchanged.

**Revisit when:** the re-validation round's classified evidence shows T01/T05 need a different shape of help than one bounded raise; that is the honest BS15-E finding, not a third raise.

## 2026-05-15 — R2c: scopeEquivalence.test.ts proves substrate==baseline byte-identical over the identical src-only scope (Phase 1.5R DR2c, BS-R2 gate)

**Context:** Phase 1.5R remediation. The methodology requires the BS-Bench-B/BS15-C identical-core property: "did the task succeed" must be the same question for substrate and baseline, over the identical scope, through one pure core.

**Considered:** n/a — this is the key-free gate and bail-signal observation.

**Decided / Observed:** Added `packages/bench/tests/scopeEquivalence.test.ts`: per task (T01/T03/T05/T08) × state (correct/half-done/seed), the substrate-side pure `evaluateT0NTextCriteria` core and the baseline-side `readModuleMap`→`scoreTaskSharedCriteria` path return byte-identical text-criteria booleans on the same logical post-edit Map. The test also asserts the materialized corpus tsconfig scope is exactly `["src/**/*.ts"]` while `tests/` remains present, and that `tscNoEmitSrc` fails loudly if `tests/` is reintroduced. BS-R2 did not fire; no byte-frozen existing test was edited.

**Why:** A non-equivalent scorer invalidates every number. This proves equivalence key-free before any operator live round, exactly as D1/D2/D12 require.

**Design-doc impact:** none — restores and gates the identical-core integrity property.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical result on any task (BS-R2 fires — do not ship that task's number, do not fork the core).

## 2026-05-15 — R2b: evaluateT0NCriteria returns the rendered Map additively; substrate resultQuality unified to the baseline's two probes (Phase 1.5R DR2b)

**Context:** Phase 1.5R remediation. The substrate `resultQuality` was not scope-equivalent: T03 re-derived a deterministic rename and T01/T05/T08 mirrored `validateAfterCommitClean`, while the baseline ran `tscNoEmit` and `vitestRun` over its edited temp tree. `runAgentForPrompt` closes its in-memory DB before returning, so resultQuality needs the final rendered text before closure.

**Considered:** (a) re-derive each task deterministically; (b) have the per-task `evaluateT0NCriteria` wrapper additively expose the rendered `Map<modulePath,text>` it already builds, then materialize that exact Map to a scratch corpus-shaped tree and run the same probes as baseline.

**Decided:** (b). `evaluateT0{1,3,5,8}Criteria` now returns `T0NCriteria & { rendered: Map<string,string> }`; the property is non-enumerable so existing boolean `Object.entries(criteria)` regression guards stay unchanged. `AgentT03Result`/`AgentTaskResult` carry optional `rendered`. `substrate.ts` now uses one quality path for every task: materialize `result.rendered` as `src/`, copy post-R1 `tsconfig.json`, `package.json`, `vitest.config.ts`, and seed `tests/`, symlink repo `node_modules`, then run `tscNoEmitSrc` and `vitestRun`.

**Why:** Substrate quality is now measured on the exact text the shared per-task core scored, using the same src-only typecheck and real vitest signal as the baseline. BS-R2 did not fire at this step; no byte-frozen tests were edited.

**Design-doc impact:** none — restores the scorer-equivalence requirement D1/D2/D12 already mandate.

**Revisit when:** a future task's committed output cannot be expressed as a rendered src Map; that would be a BS-R2 finding for that task's quality sub-metric.

## 2026-05-15 — R2a: src-scoped tscNoEmitSrc with an explicit scope guard; baseline points at it (Phase 1.5R DR2a)

**Context:** Phase 1.5R remediation. Pre-fix the baseline typechecked its whole temp tree through the corpus tsconfig while the substrate typechecked rendered src only. Post-R1 the tsconfig is src-only, but a future re-add of `tests/**` would silently re-break equivalence unless the quality path asserts the scope.

**Considered:** (a) rely on R1 alone; (b) add an explicit `tscNoEmitSrc` wrapper that asserts the resolved corpus `include` is src-only before delegating to the unchanged `tscNoEmit`.

**Decided:** (b). `quality.ts` now exports `resolveCorpusTsconfigInclude`, `assertSrcOnlyScope`, and `tscNoEmitSrc`. The baseline `defaultValidateWorkingTree` uses `tscNoEmitSrc`; the original `tscNoEmit` remains unchanged for compatibility and existing regression guards.

**Why:** The src-only typecheck invariant is now enforced where the quality probe runs, so a future `tests/` glob fails loudly instead of producing a non-equivalent benchmark number.

**Design-doc impact:** none — additive helper enforcing the existing scorer-equivalence requirement.

**Revisit when:** the corpus legitimately needs a non-`src/`-prefixed production glob; broaden the assertion while retaining the explicit `tests/` exclusion.

## 2026-05-15 — R1: corpus typecheck scope is src-only; vitest is the test-based signal (Phase 1.5R DR1)

**Context:** Phase 1.5R remediation. The N=1 round surfaced that `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature, so `tsc --noEmit` over a scope including `tests/` fails on the unmodified seed and breaks the seed-clean invariant.

**Considered:** (a) edit/delete the post-signature assertions to make the seed clean (BS-R1: weakens T01's bar); (b) exclude `tests/` from the corpus typecheck scope while keeping it in the vitest scope so the test-based signal remains fail-before/pass-after.

**Decided:** (b). `examples/medium/tsconfig.json` `include` is now `["src/**/*.ts"]`. `compilerOptions`, `vitest.config.ts`, `tests/`, and all `src/` fixtures are unchanged. "The corpus compiles" (`tscClean`) now means "src compiles"; the task test signal runs under vitest. Key-free acceptance: unmodified seed src is `tsc --noEmit` clean, while `tests/` stays on disk, in the vitest include, and remains a real fail-before signal.

**Why:** Restores the seed-clean invariant without weakening a task criterion. T01's post-task signature is still required by `evaluateT01TextCriteria` and by `tests/format.test.ts` running under vitest. BS-R1 did not fire.

**Design-doc impact:** none — corrects an implementation regression and confirms validation-before-distribution discipline.

**Revisit when:** the corpus gains a non-test src module that legitimately must be excluded, or a future task genuinely requires `tests/` in the typecheck scope (would reopen BS-R1).

## 2026-05-15 — Phase 1.5 N=1 validation round caught an invalid 4-task harness; remediation before any N=3

**Context:** First keyed 4-task live round, N=1 validation (8 runs, $0.73), `claude-sonnet-4-6`. Run as a cheap gate before the N=3 distribution. It did its job: results were NOT a clean pattern and diagnosis found the harness invalid, not the substrate beaten.

**What the round showed:** substrate T03 ✓ and T08 ✓ (rename + change_return_type work end-to-end via the agent); substrate T01 and T05 hit `error_wall_time`; baseline 0/1 on ALL four tasks including T03 (which the baseline passed cleanly 3/3 in the Phase 4 round).

**Root causes (three, distinct):**
1. **Seed-clean invariant broken (Pass 3 fixture defect).** `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature (asserts a 2nd param; calls with 2 args). On the unmodified seed `formatTimestamp` takes 1 arg, so `tsc --noEmit` over the whole seed corpus is NOT clean (2 diagnostics). Runtime fail-before/pass-after is correct for a test-based criterion, but it must not make the seed fail typecheck.
2. **Substrate/baseline tsc-scope asymmetry (scorer non-equivalence).** `quality.ts` tsc's the baseline's whole temp tree (incl `tests/format.test.ts` → fails → baseline `tscClean:false` on every task → baseline 0/1 across the board, incl T03). The substrate re-derives quality from only its rendered changed modules — a different file set. The two configs are typecheck-judged over different scopes, violating the BS15-C/BS-Bench-B identical-core integrity property the methodology depends on.
3. **Substrate timeouts on T01/T05** (`error_wall_time`, 17–22 tool calls before the wall) — independent of scoring. Wall-time too tight for the harder tools, and/or BS15-E (tool-selection thrashing at the 11-tool surface), and/or tool ergonomics. Needs its own diagnosis; may be an honest "substrate struggles here" result.

**Decided:** Do NOT run N=3 on an invalid harness; do NOT hack the fixture green. Remediate all three (operator-approved "fix all 3 properly"): (1) exclude `tests/` from the corpus tsconfig so "tscClean" means "src compiles" with vitest as the separate test-based success signal, restoring the seed-clean invariant; (2) make substrate AND baseline score/tsc the identical file scope (restore scorer equivalence); (3) raise/parameterize wall-time for the harder tools and re-diagnose the T01/T05 timeouts (BS15-E). Then re-run N=1 validation, then N=3. Remediation goes through the spec→plan→Codex machine.

**Design-doc impact:** none — confirms the validation-before-distribution discipline and the scorer-equivalence requirement; corrects an implementation regression, not the design.

**Revisit when:** the remediated N=1 re-validation either clears (proceed to N=3) or surfaces a genuine substrate limitation on T01/T05 (report honestly, do not massage).

## 2026-05-15 — Bench task abstraction; T03 path preserved unchanged (Phase 1.5 Task 12 / D14)

**Context:** The Phase 4 harness was T03-specific (`task:"T03"`, hard-wired scorer/report). The four-task pattern needs T01/T05/T08 beside T03 without rewriting the proven path.

**Decided:** Added `BenchTask` (`packages/bench/src/tasks/`, one module per task), generalized `runner.ts` to loop a `--tasks` list (default all four), kept `bench:t03` as `--tasks=T03`, and added `bench` for the four-task default. Per-task baseline/substrate runners delegate to the matching `@strata/verify` per-task core through `scoreBaselineTask` / `runAgentTask`; T05 threads seed and post-edit test text symmetrically for the byte-identical anti-cheat. The report gained `buildSuiteReport`/`renderSuiteMarkdown`: per-task distributions plus a cross-task pattern section stating the claim and falsifier (structural tasks separate and T05 does not, else report honestly). Existing `buildReport`, `runSubstrateTrial`, `runBaselineTrial`, and `runAgentT03` signatures are preserved for the Phase 4 T03 path.

**Why:** Generalize the harness without forking the T03 regression path. Scorer cores stay in `@strata/verify` to preserve the acyclic package graph and config-equivalent scoring discipline.

**Design-doc impact:** none — additive generalization on the reserved bench slot.

**Revisit when:** a fifth task is added (add a task module and verify core; the runner does not change) or the live round shows a per-task scorer is not config-portable (BS15-C — do not ship that task's number).

## 2026-05-15 — Agent surface 8 -> 11; minimal prompt additions; BS15-E framing (Phase 1.5 Task 11 / D13)

**Context:** The three new mutation tools must be agent-visible. Going 8->11 may degrade tool selection (BS15-E).

**Decided:** Registered `add_parameter`, `change_return_type`, and `replace_body` in `tools.ts` over the shared `{ db, actor }` context, with zod shapes reusing `nodeIdSchema`/`txHandleSchema`, and added all three to `STRATA_TOOL_NAMES`/qualified tool names for the runtime guard. Prompt changes are minimal: one plain-English sentence per new tool plus a "Choosing the right mutation" paragraph. The single worked pattern stays rename and key-free tests assert no benchmark-specific prompt recipes. The obsolete pre-existing tool-surface count assertion was updated 8->11; T03 behavior tests were not changed.

**Why:** Mechanical registration; the hermetic isolation contract is unchanged. BS15-E is an empirical live-round question, not something inferred from no-key tests. Wrong-tool paths must not be scored as substrate wins and task-specific recipes must not be added to hide tool-selection confusion.

**Design-doc impact:** takes the mutation-tool count to four (rename + the three), inside `strata-design.md` Phase 1 "5-7" target.

**Revisit when:** the live round shows the agent cannot reliably select the right mutation tool after honest prompt iteration (BS15-E — surface as the tool-granularity finding; do not paper over).

## 2026-05-15 — Agent session generalized to per-task entry points; T03 path preserved (Phase 1.5 Task 10)

**Context:** Phase 4's substrate path is `runAgentT03`/`T03_PROMPT`, T03-specific. The four-task benchmark needs T01/T05/T08 substrate runs without forking the proven T03 loop.

**Decided:** Extracted the `runAgentT03` body into an internal `runAgentForPrompt(params, prompt, scoreFn)`; `runAgentT03` now delegates to it with public signature/return unchanged. Added `TASK_PROMPTS` and `runAgentTask(taskId, ...)` selecting prompt plus the matching `@strata/verify` per-task scorer. `runLiveSession`'s prompt is parameterized and defaults to `T03_PROMPT`. Hermetic Options are reused unchanged.

**Why:** One session loop, zero intended behavior change for T03, and no live call added. Replay/synthetic tests remain the key-free guard; the existing T03 replay and live-test path stay the regression net.

**Design-doc impact:** none — additive generalization.

**Revisit when:** a fifth task is added (extend `TASK_PROMPTS` and a scorer; the loop does not change).

## 2026-05-15 — T05 control scorer core in @strata/verify; symmetric anti-cheat (Phase 1.5 D12 — T05, BS15-C/BS15-D)

**Context:** T05 is the reasoning control: parity is the credibility anchor. Its criteria include the anti-cheat "test file byte-identical to seed", which MUST be applied identically for both configs or the control is invalid.

**Decided:** `packages/verify/src/t05Criteria.ts` mirrors `t03Criteria.ts`: pure core (half-open comparison present, closed interval gone, test file byte-identical), with `seedTestText` passed in explicitly and never file-read inside the core. The substrate wrapper renders committed source modules and feeds the seed test under `T05_TEST_KEY`; the baseline adapter will feed its post-edit test text under the same key. Substrate-only `operationRowAppended` = ReplaceBody. Core stays in verify (no cycle).

**Why:** T05 must be expressible by BOTH configs as a localized body edit with no reference-graph advantage to the substrate (`replace_body` confers none of the fan-out leverage that wins T01/T03/T08). The passed-in seed text makes the anti-cheat provably symmetric (BS15-D), and the BS15-C key-free equivalence test feeds file text and rendered store text through one core.

**Design-doc impact:** none.

**Revisit when:** the live round shows T05 gave the substrate a structural advantage or handicapped the baseline (BS15-D — stop and surface; do not tune T05 to manufacture parity or a win).

## 2026-05-15 — T08 per-task scorer core in @strata/verify; BS15-C did NOT fire for T08 (Phase 1.5 D12 — T08)

**Context:** T08 (return-type narrowing) needs one provably-identical pure core for both configs.

**Considered / Decided:** Same as D12-T01: `packages/verify/src/t08Criteria.ts` mirrors `t03Criteria.ts`; pure text core (literal-union return type, no `as string` on `getRole` results, caller guards intact), substrate wrapper renders committed store modules and adds substrate-only `operationRowAppended` (ChangeReturnType). Core stays in verify (no cycle).

**Why:** BS15-C key-free equivalence feeds file text and rendered store text through one core and asserts identical text booleans. T08's number is portable across substrate and baseline only because the scorer has no config-specific branch.

**Design-doc impact:** none.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T08 result (BS15-C fires — do not ship T08's number, do not fork the scorer).

## 2026-05-15 — T01 per-task scorer core in @strata/verify; BS15-C did NOT fire for T01 (Phase 1.5 D12 — T01)

**Context:** T01 needs substrate and baseline scored by one provably-identical pure core (BS-Bench-B / BS15-C discipline), the T03 pattern.

**Considered:** (a) duplicate regexes in the bench adapter; (b) one pure `evaluateT01TextCriteria(Map)` core in @strata/verify fed by substrate-render and baseline-file adapters; (c) move it to bench.

**Decided:** (b). `packages/verify/src/t01Criteria.ts` mirrors `t03Criteria.ts`: pure text core (timezone signature/default, server `"UTC"` callsites, UI `"local"` direct callsite, HOF reference not mis-edited), and `evaluateT01Criteria` renders committed store modules then delegates to the same core while adding substrate-only `operationRowAppended` (AddParameter). Core stays in verify (no cycle).

**Why:** "T01 succeeded" means byte-identically the same for both configs. The BS15-C key-free equivalence test feeds file text and rendered store text through the same core and asserts identical text booleans, gating T01's number.

**Design-doc impact:** none — additive scorer core mirroring D1.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T01 result (BS15-C fires — do not ship T01's number, do not fork the scorer).

## 2026-05-15 — examples/medium gains a runnable offline vitest suite; baseline temp-tree resolves vitest via node_modules symlink (Phase 1.5 D11, Open Question 2 / BS15-D gate)

**Context:** T01/T05 success criteria are `pnpm vitest run`. examples/medium had no src/lib, no tests, no vitest dep; `materializeCorpus` copied without installing; the implementer cannot reach the registry. This is exactly the "Revisit when: the corpus gains its own vitest suite" condition the 2026-05-15 "Baseline temp-checkout" entry named.

**Considered:** (a) `pnpm install` into the temp tree (needs registry and is operator-only); (b) symlink the repo-root node_modules into the temp tree (vitest + typescript already on disk via pnpm); (c) symlink only vitest/.pnpm/typescript/@types.

**Decided:** (b). Added `src/lib/{format,dateRange,permissions}.ts`, `src/server/events.ts`, `src/ui/timeline.ts`, `tests/{format,dateRange}.test.ts`, `vitest.config.ts`, a `package.json` test script + documentary vitest devDep, and `tests/**` in the corpus tsconfig include. `materializeCorpus` removes any copied corpus `node_modules` cache and symlinks the repo-root `node_modules` into the temp tree after the recursive copy, so the baseline's `pnpm vitest run` resolves offline with ZERO registry at run time. The seed deliberately fails the new signal (`dateRange` closed-interval bug, and T01's missing parameter is caught by the corpus typecheck/type-level test), so the suite is not vacuous. Existing T03 modules are left byte-identical.

**Why:** The deps already exist on disk; resolution is the only gap. No `pnpm install`, no registry, no per-trial dependency cost. The whole-node_modules symlink did not need the narrower fallback in this environment.

**Design-doc impact:** none — implements spec § Fixtures + Open Question 2; supersedes the "Baseline temp-checkout" entry's "no install/symlink required" clause (the corpus now has a vitest suite, exactly its named Revisit condition).

**Revisit when:** the corpus gains real runtime (non-dev) deps, an SDK/vitest upgrade changes resolution, or the live baseline shows the symlink form needs to be the narrow (c) variant.

## 2026-05-15 — add_parameter shipped (Phase 1.5 D10 — tool)

**Context:** With BS15-B cleared by the callsite-resolution probe, the tool now fans an argument out to resolved direct callsites.

**Considered:** n/a — settled by spec; build record.

**Decided:** `packages/store/src/addParameter.ts` follows the spine: validate name/type/default via public-API parse; declaration edit inserts `name: type[ = default]` at the clamped position as a zero-width text-span edit; each direct callsite from `resolveCallsites` gets a zero-width arg-slot edit at the matching argument position (slot value = the parameter default if any else `undefined`); one `AddParameter` op row records affected = [declaration, ...callsiteStatements]. HOF/aliased reference identifiers are NOT edited, so the compiler flags arity/type breaks honestly rather than the tool silently mis-editing them.

**Why:** Clean spine extension for the declaration edit; the callsite fan-out reuses the BS15-B-cleared resolver and stays reference-graph based, not text search. The tool's deterministic guarantee is "every resolvable direct callsite gets an argument slot"; the semantic value remains the caller's per-site decision.

**Design-doc impact:** none — implements spec § tool specs / `add_parameter`.

**Revisit when:** a live T01 round shows a callsite shape the resolver misses (re-probe before assuming a wall — BS15-B discipline).

## 2026-05-15 — add_parameter callsite resolution probed; BS15-B did NOT fire (Phase 1.5 D10 — probe)

**Context:** BS15-B: the genuine-new-work risk of Phase 1.5. `node_references` resolves reference identifiers, not enclosing CallExpression argument lists.

**Considered:** (a) accept BS15-B as a substrate wall; (b) investigate whether re-parsing the referring statement + walking up from the reference identifier to its enclosing call (callee === that identifier) reliably resolves callsites, with HOF/aliased uses correctly classified as non-argument arity-risk sites.

**Decided / Observed:** (b). `packages/store/src/callsites.ts` `resolveCallsites(db, functionId)` resolves direct and template-literal callsites and correctly classifies `.map(formatTimestamp)` and `const f = formatTimestamp` as `nonCallReferences` (compiler-flagged arity breaks, never silently mis-edited). The probe fixture produced counts `{ resolvedDirectCallsites: 2, arityRiskReferences: 2, unresolvedReferences: 0 }`; import-specifier references are ignored as import edges, not callsites or arity-risk sites. Public TS APIs only (BS1 discipline). The substrate's reference-integrity pitch holds for callsite fan-out on the T01 stress shapes tested here.

**Why:** A missed callsite must not be papered over with text search — that abandons the substrate's whole argument. The probe is isolated and early so a fired signal stops the phase before the tool is built.

**Design-doc impact:** none — confirms the spec crux's add_parameter feasibility argument held in implementation.

**Revisit when:** the T01 corpus or live round surfaces a callsite shape (e.g. re-exported-then-called, decorator) the walk-up misses — re-probe before assuming a wall, same as BS1.

## 2026-05-15 — replace_body shipped; input is validated body text, not structured AST (Phase 1.5 D9, Open Question 3)

**Context:** Phase 1 stores bodies as raw text and renders canonically; `replace_body` needs an input shape.

**Considered:** (a) structured AST body input + a body-construction API + structured render path; (b) validated `{ ... }` body text the tool syntactically pre-checks.

**Decided:** (b). `packages/store/src/replaceBody.ts` takes a body string including braces, wraps it as `function __probe__() <body>` + `ts.createSourceFile`, requires one `ts.Block` consuming the whole text and zero compiler syntactic diagnostics through the public `ts.createProgram` API, then queues one whole-body `textSpanMutation` + one `ReplaceBody` op row (params: function_id + new_body_len; the literal body is recoverable from the post-commit payload). Interior identifiers of the new body are NOT lowered/re-resolved into `node_references` — the same limitation Phase 1 documented; validate-before-commit is the safety net (a body referencing something undefined fails tsc and commit blocks). Identical-body / non-FunctionDeclaration / no-body are no-op/throw.

**Why:** Matches the storage model; (a) is the deferred Phase 2 lowering and out of scope. T05's fix is a single-statement comparison flip with no new cross-module references, so the interior-reference caveat does not bite the control.

**Design-doc impact:** none — implements spec § tool specs / `replace_body` + Open Question 3.

**Revisit when:** a task needs interior-reference integrity after `replace_body` (logged Phase 2 decision; would be BS15-A if T05 needed it — it does not).

## 2026-05-15 — change_return_type shipped on the rename spine (Phase 1.5 D8)

**Context:** Phase 1.5's lowest-risk tool: change a function declaration's return-type annotation.

**Considered:** n/a — settled by spec; this records the build shape.

**Decided:** `packages/store/src/changeReturnType.ts` follows the `rename.ts` spine: declaration lookup → `locateSpan(payload,"returnType")` → one `textSpanMutation` (replace existing annotation, or insert `: T` after the param list `)` when absent) → one `ChangeReturnType` op row. Identical-type and non-FunctionDeclaration are no-op/throw, mirroring `rename_symbol`. The tool edits ONLY the annotation; caller repair is agent reasoning (T08 framing), not a tool fan-out. Type validity is a public-API syntactic pre-check (wrap + `ts.createSourceFile` + compiler syntactic diagnostics through `ts.createProgram`), not a hand-rolled grammar or internal parser diagnostics.

**Why:** Clean spine extension on the Task 1 overlay + Task 2 locator; no lowering (BS15-A did not fire for this tool).

**Design-doc impact:** none — implements spec § tool specs / `change_return_type`.

**Revisit when:** a task needs the tool to also repair callers (it does not — that is agent reasoning per spec/T08).

## 2026-05-15 — On-demand re-parse span location, no ingest lowering (Phase 1.5 D7, Open Question 1)

**Context:** The three tools must locate parameter-list / return-type / body spans inside a function declaration on the current statement-raw-text + identifier-child model.

**Considered:** (a) extend ingest to lower parameters/bodies/return-types into structured nodes; (b) locate spans on demand by re-parsing the statement's own stored raw payload with `ts.createSourceFile` + public `getChildren`.

**Decided:** (b). `packages/store/src/spanReparse.ts` exports `locateSpan(payload, "params"|"returnType"|"body")`. The payload IS `statement.getFullText`, so re-parsed offsets are payload offsets directly; absent return type / empty param list return a zero-width insertion span. Public TS APIs only (`createSourceFile`, `getChildren`, `getStart`/`getEnd`); no internal properties, no `forEachChild`+`.jsDoc` (BS1 discipline).

**Why:** Exact and schema-free; structured lowering is deferred Phase 2 work and not needed for the three tasks. One source of truth so the tools don't each hand-roll re-parse.

**Design-doc impact:** none — additive store helper.

**Revisit when:** a tool needs structured nodes rather than a text span (BS15-A — stop and surface).

## 2026-05-15 — textSpanMutations overlay + generalized spliceStatement (Phase 1.5 D6, Open Question 1)

**Context:** Phase 1.5's three tools edit non-identifier regions (parameter list, return type, body) of a statement's raw payload. Phase 1's overlay was identifier-text only.

**Considered:** (a) structured AST-node lowering of params/bodies/return-types; (b) generalize the existing text-splice mechanism to arbitrary text spans, with identifier mutation as the degenerate case.

**Decided:** (b). `TxOverlay` gains `textSpanMutations: Map<statementId, TextSpanEdit[]>` where `TextSpanEdit = { start, end, oldText, newText }`; `IdentifierMutation` is the degenerate span. `spliceStatement`, render, and `commitWithoutValidate`/`materializeStatementPayloads` apply text-span edits with the same descending-offset, oldText-checked algorithm Phase 1 used; identifier offsets reshift by the net text-span delta. `TextSpanEdit` is owned by `@strata/store`; `render` consumes it (keeps `render → store` one-directional, no cycle).

**Why:** The statement payload is verbatim source, so a span edit on it is exact and needs no schema change; the splice already did descending-offset oldText-checked edits. Structured lowering is real Phase 2 work and unnecessary (per-tool argued in the spec crux). Behavior-preserving for `rename_symbol`: every pre-existing rename/agent/replay/T03 test stays green unchanged (the regression net).

**Design-doc impact:** none — additive overlay generalization; supersedes the Phase 1 "Transaction overlay stores identifier text mutations in memory" entry's narrowness (text-span is the superset).

**Revisit when:** a tool needs structured parameter/body/return-type node lowering rather than text-span edits (that is BS15-A — stop and surface, do not half-lower).

## 2026-05-15 — First T03 benchmark round: substrate beats file-based baseline on every metric (BS-Bench-A/C/D resolved)

**Context:** First keyed live benchmark round (operator-run, `bench:t03`), `claude-sonnet-4-6`, validation N=1 then distribution N=3 per config. Same verbatim T03 prompt, same model, same 10-criterion shared bar, same success scoring core for both configs. Resolves the operator-pending bail signals from the D5 entry below.

**Result (N=3, both configs 3/3 success, 0 retries, tsc+vitest clean 3/3):**
- Total tokens — substrate raw [1201, 1270, 1473] (mean 1315) vs baseline [4450, 4514, 4682] (mean 4549). Distributions **disjoint** (substrate max 1473 < baseline min 4450), ~3.5x fewer.
- Wall time — substrate 24.6–30.3s vs baseline 57.4–59.4s. Disjoint, ~2.2x faster.
- Tool/edit invocations — substrate 7–11 vs baseline 25–27. Disjoint, ~3x fewer.
- Cost/run — substrate ~$0.038 vs baseline ~$0.184, ~4.9x cheaper. Round spend: $0.26 (N=1) + $0.67 (N=3) = $0.93 total.

**Bail signals:**
- **BS-Bench-A — cleared.** The file-based baseline completed T03 successfully 3/3; the comparison is meaningful (a baseline that couldn't do the task would have made the numbers vacuous).
- **BS-Bench-C — cleared.** $0.93 for the full validation+distribution round; no cost explosion. N capped at 5, dry-run available.
- **BS-Bench-D — did NOT fire.** Distributions are cleanly separated, not swamped by variance. Had they overlapped at N=3 the report and this entry would record "no separable signal" — they do not. The report and this entry explicitly frame N=3 as an observed separation, **not** a statistical-significance claim; larger N is future work.

**Why this matters:** This is the core thesis of strata-design.md ("AI coding agents are bottlenecked by the file abstraction… a structural substrate makes agents fundamentally more efficient") demonstrated empirically on a real task: same model, same task, same success criteria, materially less work to the right answer, with no quality regression.

**Design-doc impact:** none — this is the evidence the design predicted. Feeds the eventual Phase 5 write-up. Raw per-round artifacts under `packages/bench/results/` are gitignored by intent (reproducible, cost-bearing, operator-run); this entry is the durable record of the finding.

**Revisit when:** the benchmark broadens past T03 (needs Phase 1.5 tools) or runs at larger N / multiple models — re-measure; a single-task N=3 separation is a strong directional result, not the final word.

## 2026-05-15 — Phase 4 verticalizes on the T03 substrate-vs-baseline benchmark (D5); BS-Bench-A/C/D operator-pending

**Context:** `@strata/bench` now runs the substrate (`runAgentT03`, reused as-is) and a file-tools baseline (temp copy of `examples/medium`) N trials each on T03, scores both through the shared `evaluateT03TextCriteria` core (BS-Bench-B gate green key-free), aggregates distributions, and writes artifacts via the operator-only key-gated `bench:t03` script. `strata-design.md` Phase 4 remains broader (10 tasks); this is the verticalized T03-only slice the spec settled.

**Considered:** n/a — verticalization is settled by the approved spec; this is the build record plus the bail-signal observation status.

**Decided / Observed:** Deferred: no API key in this environment; the live round is an operator action via `ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench:t03 -- --trials=3`. All harness logic (scorer-equivalence BS-Bench-B gate, metrics/distribution math, retry counter, report, temp-tree materialization, and resultQuality probes) is green key-free. BS-Bench-A (whether the baseline can complete T03 with file tools), BS-Bench-C (actual per-round/per-run cost), and BS-Bench-D (whether distributions overlap or separate at N=3-5) are explicitly operator-pending and must be recorded from round one regardless of outcome. Runner module-system guard form used: CommonJS `require.main === module` with `__dirname` because `tsconfig.base.json` is `module: "CommonJS"`. Baseline SDK form used: `tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]`, `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`.

**Why:** BS-Bench-A/C/D are measurement findings recorded from the real live round, never inferred from skipped logic. The substrate path was not modified; `runAgentT03` remains the substrate. The CommonJS guard preserves script-only execution without using `import.meta`, and the baseline SDK options make the contrast file-tools-yes / Strata-tools-no / ambient-MCP-no.

**Design-doc impact:** none — `strata-design.md` Phase 4 remains the broader target; this records the implemented verticalized slice and the operator-pending live round.

**Revisit when:** the operator completes the keyed live round (record actual BS-Bench-A/C/D observations as a new newest-first entry if this deferred form was already committed), N is raised as a budgeted operator decision, or Phase 4.5 widens to a second task.

## 2026-05-15 — Baseline temp-checkout = recursive copy plus git init; file tools pinned (D4, Open Question 3)

**Context:** Phase 4's baseline needs an isolated, writable, real `.ts` tree with the corpus tsconfig/package.json and working `tsc --noEmit`. Open Question 3 left clone-vs-copy and corpus-deps handling to implementation.

**Considered:** `git clone --depth=1 file://`; recursive copy + `git init`; recursive copy only.

**Decided:** Recursive `cpSync(corpusRoot, tmp, { recursive: true })` into an OS temp dir, then `git init` in that temp tree for live operator runs. The baseline needs no repo history; `examples/medium` is a no-emit corpus with no own vitest suite and no runtime deps, so no `pnpm install`/symlink is required. Unit tests pass `initGit: false` so key-free tests do not run git. The SDK tool surface is the explicit allow-list `["Read", "Write", "Edit", "Glob", "Grep", "Bash"]` with `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, and no Strata MCP server.

**Why:** Copy is the minimal mechanism that gives an isolated writable real tree; `git init` gives Claude Code a repository-shaped workspace without depending on repository history. Pinning the tool list keeps the fairness invariant auditable: same model, same task prompt, same success bar; vary substrate vs. files, not ambient MCP servers.

**Design-doc impact:** none — implements spec § "Baseline config" / Open Question 3.

**Revisit when:** the corpus gains its own runtime deps or vitest suite, an SDK upgrade changes `Options.tools`/`systemPrompt` semantics, or the operator live run shows Claude Code requires different plain-file-tool scoping.

## 2026-05-15 — Symmetric T03 retry/failure counting rule shipped as specified (D3, Open Question 1)

**Context:** `docs/benchmarks.md` Open Questions flags that "retry" is undefined for the file baseline, so the metric is meaningless without a concrete rule. The Phase 4 spec proposed a symmetric definition.

**Considered:** count every failed tool call (over-counts a single self-correction as 3); count only explicit substrate commit blocks (no file analog); the spec's "failed verification + subsequent mutation = one self-correction" rule.

**Decided:** Shipped the spec's rule. Substrate retry = a `validate` returning diagnostics OR `commit_transaction` `{ ok:false }`, followed by a further mutating tool call (`rename_symbol`/`begin_transaction`/`rollback_transaction`). Baseline retry = a `tsc`/`vitest`/test Bash run exiting non-zero OR a re-edit of an already-edited file, followed by a further `Edit`/`Write`. A failed check with no subsequent mutation is NOT a retry.

**Why:** Symmetric on each side's native verify/edit primitives, derivable from each config's session log with no extra instrumentation, resilient to differing tool vocabularies. The worked example (one failed validate -> rollback -> corrected rename) counts as ONE, matching the spec's stated intent.

**Design-doc impact:** none — resolves `benchmarks.md` Open Question; the rule is reported alongside the metric so a reader can audit it.

**Revisit when:** the first live round's logs (operator, Task 9) show mis-classification — a corrected rule is then logged as a NEW newest-first entry, never silently retuned.

## 2026-05-15 — @strata/bench created; T03 scorer core stays in @strata/verify (D2)

**Context:** Phase 4's harness needs a package. `strata-design.md` § "Project layout" reserves `packages/bench`. The shared scorer core (D1) could nominally live in `bench`.

**Considered:** (a) put `evaluateT03TextCriteria` in `bench`; (b) keep it in `@strata/verify` and have `bench` import it from the verify barrel.

**Decided:** (b). `packages/bench` (`@strata/bench`) depends on `@strata/agent`/`@strata/verify`/`@strata/ingest`/`@strata/render`/`@strata/store` + the SDK + zod, NOT `@strata/cli`. The scorer core stays in `@strata/verify`.

**Why:** (a) cycles: `verify`'s own `evaluateT03Criteria` needs the core, and `agent`->`verify`, `bench`->`agent`/`verify`. Keeping it in `verify` keeps the graph acyclic (`bench` -> `agent` -> ... -> `verify`; `bench` -> `verify`) and lets `bench` reach the core via the barrel with no `cli` edge and no deep `dist/` import. The scorer core must NOT be relocated to `bench` later.

**Design-doc impact:** none — additive package on the reserved `packages/bench` slot.

**Revisit when:** a non-T03 benchmark task is added (the harness generalizes; the T03 scorer does not move).

## 2026-05-15 — T03 text-criteria core extracted (evaluateT03TextCriteria) in @strata/verify (D1)

**Context:** Phase 4 needs the substrate and the file-based baseline to score the nine text-derived T03 criteria through identical logic, or the comparison is invalid (BS-Bench-B). The nine criteria were inlined inside `evaluateT03Criteria`, coupled to `db`/`batch`.

**Considered:** (a) duplicate the regexes in the bench baseline adapter; (b) extract a pure `Map<modulePath,text>`-taking core in `@strata/verify` that `evaluateT03Criteria` delegates to and the baseline adapter also calls; (c) move the scorer into the new `@strata/bench`.

**Decided:** (b). `packages/verify/src/t03Criteria.ts` now exports `evaluateT03TextCriteria(modules)` (the nine text criteria, regexes verbatim) and `T03TextCriteria`. `evaluateT03Criteria` keeps its signature, builds the rendered-text Map from `db`/`batch` exactly as before, delegates the nine, and adds `commitReturnedOk`/`validateAfterCommitClean`/`operationRowAppended` unchanged.

**Why:** A single pure core called by both adapters makes "T03 succeeded" mean exactly the same thing for substrate and baseline. (c) was rejected: it would cycle (`verify` needs the core; `agent`->`verify`; `bench`->`agent`/`verify`). The core MUST stay in `@strata/verify` — moving it to `bench` later would reintroduce the cycle; do not "tidy" it there.

**Design-doc impact:** none — refactor only; `evaluateT03Criteria` signature/behavior unchanged, `cli` `t03.test.ts` and `agent` `replay.test.ts` green unchanged.

**Revisit when:** T03 grows criteria, or a fourth caller needs the core.

## 2026-05-15 — Agent hermetic isolation: `LSP` disallowed + `strictMcpConfig`/`settingSources` required

**Context:** Phase 3 live BS-A run. With `tools: []` (documented as "disable all built-in tools"), the runtime invariant guard still tripped — first on an injected `LSP` tool, then (after fixing that) on `mcp__claude_ai_Breeze__*` tools leaking in from the operator's `~/.claude.json`. Both violate the CLAUDE.md invariant that the agent's only tools are the in-process Strata ones and its world is the node graph, not files. The bail-signal guard caught this; it was NOT relaxed.

**Considered:**
- Relax the runtime guard to allow `LSP` / ambient MCP tools — rejected: papers over a real invariant violation and would invalidate the benchmark (an `LSP` tool inspects real files; Breeze tools perform arbitrary RMM actions).
- Whack-a-mole add every ambient tool to a banned list — rejected: not hermetic, brittle.
- Use the SDK's own hard-removal/isolation mechanisms — chosen.

**Decided:** In `runLiveSession` options: (1) add `"LSP"` to `BANNED_BUILTINS` (fed to `disallowedTools`, the SDK's documented "removed from the model's context and cannot be used" path) — `tools: []` does not strip `LSP` in `@anthropic-ai/claude-agent-sdk@0.2.118`; (2) set `strictMcpConfig: true` — in the underlying Claude CLI this means "use only the explicitly-passed MCP servers, ignore all other sources"; without it the SDK inherits `~/.claude.json` servers (Breeze); (3) set `settingSources: []` explicitly (documented default when omitted, set to make hermetic intent unambiguous). After these, the strict guard passes live and the agent completes T03 through only the 8 Strata tools.

**Why:** Enforces the invariant via the SDK's own mechanisms rather than weakening the check. Documents two installed-SDK-vs-docs gaps (the Phase 3 spec already flagged this class of risk): `tools: []` does not cover `LSP`; `strictMcpConfig`'s type doc says "strict validation" but its operative effect is MCP source isolation.

**Design-doc impact:** none — confirms strata-design.md § "The Agent" ("no file tools ... entire world is the node graph") is enforceable on this SDK with explicit isolation options.

**Revisit when:** upgrading `@anthropic-ai/claude-agent-sdk` (re-verify `tools: []`/LSP/`strictMcpConfig` behavior — these are version-observed, not type-guaranteed), or if a future SDK injects another ambient tool the guard catches.

## 2026-05-15 — Phase 3 verticalizes on agent-drives-T03 (D5)

**Context:** Phase 3 now has `@strata/agent` wrapping the existing store/verify spine as eight in-process SDK tools, a static worldview prompt, session logging, a headless `query()` live path configured with `tools: []`, and a deterministic replay path that passes all 11 shared `evaluateT03Criteria` checks. The design doc's Phase 3 remains broader than this slice.

**Considered:** broaden to the full benchmark harness, more tools, and the Claude Code baseline now; or ship the single agent-drives-T03 vertical slice and broaden in Phase 3.5/4.

**Decided:** single vertical slice. Phase 3 verticalizes on the proven `rename_symbol` T03 spine with no filesystem tools. Broadening to more tasks, more tools, and baseline comparison is Phase 3.5/4.

**Why:** Verticalizing isolates agent/SDK-integration risk from substrate risk. The substrate was already green for T03, so this run focuses on whether a Strata-only tool loop can drive the same outcome. The no-key replay path proves the substrate outcome deterministically. BS-A and the live half of BS-B are not claimed from skipped tests; they remain operator-pending keyed runs. BS-C cost capture wiring exists in the session log and will be populated by the operator's keyed run.

**Design-doc impact:** none — `strata-design.md` Phase 3 remains the target; this records the implemented first slice.

**Revisit when:** the operator completes the keyed live acceptance, Phase 3.5 adds a second tool/task, or Phase 4 builds the baseline comparison.

## 2026-05-15 — Phase 3 acceptance determinism: recorded-transcript replay (D4)

**Context:** The agent T03 acceptance test calls a live model, but CI must be deterministic and key-free.

**Considered:** key-gated live-only with a retry budget; or record a live transcript and replay the tool-call sequence through the real handlers so the store outcome is a pure function of the sequence.

**Decided:** Use replay. `runAgentT03` supports a replay path that re-executes `{ tool, args }` steps through the real Strata handlers and substitutes `"$TX"` with a fresh transaction handle. The committed fixture at `packages/agent/tests/fixtures/agent-t03-transcript.jsonl` is clearly labeled as a synthetic placeholder because this environment has no key; it keeps key-free CI exercising the full replay path and all 11 criteria. The operator replaces it with a real keyed live recording using `pnpm --filter @strata/agent build && ANTHROPIC_API_KEY=... pnpm --filter @strata/agent record:t03-fixture`.

**Why:** Replay keeps CI deterministic without secrets while a real live run remains the source of truth once recorded. The store outcome is a pure function of the recorded tool-call sequence, so replay is a faithful substrate-outcome reproduction, not a mock. The current placeholder is not represented as a real agent run; live confirmation remains operator-pending.

**Design-doc impact:** none — implements spec § "Acceptance test" / Open Question 2.

**Revisit when:** the SDK changes how tool calls are surfaced, the T03 corpus changes, or the operator regenerates the placeholder from a successful live run.

## 2026-05-15 — Phase 3 agent drives T03 live: BS-A / BS-C observation

**Context:** Phase 3 Task 10 wires the headless agent against the verbatim T03 prompt with only the eight Strata tools and `tools: []`.

**Considered:** n/a — this is a bail-signal observation entry, not a design choice.

**Decided / Observed:** Deferred in this environment: no Anthropic API key or Claude Code OAuth token is available, so the live BS-A run is an operator action. The live half of BS-B is likewise pending keyed confirmation from the SDK session. The CI proof for substrate outcome is the replay path added in Task 11. BS-C: token, cost, and wall-time numbers are pending the operator live run, but the session log now captures `SDKResultMessage` usage, per-model usage, total cost, and duration fields.

**Why:** BS-A is the substrate-agent-fit signal; BS-C is a primary Phase 4 cost signal. Both must be recorded from a real live run, not inferred from skipped tests.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed live acceptance, the prompt is iterated again, the tool set is widened, or Phase 4 benchmarking begins.

## 2026-05-15 — Phase 3 SDK session integration shape pending live confirmation (D3)

**Context:** Phase 3 BS-B asks whether the SDK runs headless with only custom in-process tools and `tools: []`, and whether tool results compose with our transaction model. Task 4 cleared the tool loop at the handler layer with no model; Task 5 adds the live one-tool session probe.

**Considered:** trust BS4 (schema-only) and build the full orchestrator directly; or probe a minimal one-tool session first.

**Decided:** probe-first. `packages/agent/src/session.ts` implements a single-yield async-generator prompt and `collectSession(...)` over the public `query(...)` API. `packages/agent/tests/sessionSmoke.test.ts` registers an in-process `createSdkMcpServer` with one `ping` tool, runs with `tools: []`, `allowedTools: ["mcp__probe__ping"]`, `bypassPermissions` + `allowDangerouslySkipPermissions`, `maxTurns`, and an `abortController`. Result: pending-live-confirmation — this environment has no API key, so the live SDK probe is skipped until the operator runs it with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

**Why:** The session/loop is the part BS4 did not exercise. Probing one tool isolates "the SDK headless loop composes" from "our eight tools / system prompt are right" before the full orchestrator. The no-key surface remains covered by Task 4's direct handler test; BS-B live confirmation is not claimed from a skipped test.

**Design-doc impact:** none — confirms the intended integration shape in code, with live confirmation pending.

**Revisit when:** the keyed Task 5 probe runs, an SDK upgrade changes `query`/`Options.tools`/MCP server handling, or the full Task 10 session reveals loop behavior the one-tool probe did not.

## 2026-05-15 — `read_node` added to @strata/store for the Phase 3 agent

**Context:** Phase 3's `read_node` tool needs "a node plus optional shallow children". `@strata/store` exposed `findNodeById` and `listChildren` separately; the agent must not reach into store internals.

**Considered:** (a) compose `findNodeById`+`listChildren` inside `packages/agent`; (b) add a public `readNode`/`read_node` to `@strata/store`.

**Decided:** (b). `packages/store/src/read_node.ts` exports `readNode(db, id, { includeChildren? })` (alias `read_node`) returning `{ node, children? }`.

**Why:** Keeps the dependency edge clean (`agent -> store` public surface only) and matches the spec's note that this helper belongs in `store`, not in `agent`. Minimal: one level of children, no recursion (Open Question 1 — widen only if agent behavior shows it's needed).

**Design-doc impact:** none — additive public API on an existing package.

**Revisit when:** the agent's transcript shows it repeatedly needs deeper traversal than one child level (then it becomes a logged tool-widening decision per Open Question 1).

## 2026-05-15 — T03 scoring extracted to `@strata/verify`

**Context:** Phase 3 needs the agent path and the programmatic `cli t03` path to score against identical logic so the agent cannot be given a weaker or vacuous check. The scoring block was inlined inside `runT03`, and Plan Amendment 1 moved the shared scorer boundary from `@strata/cli` to `@strata/verify`.

**Considered:** (a) duplicate the regex/operation checks in the agent test; (b) extract the post-commit scoring into `@strata/cli`; (c) extract it into `@strata/verify` and export it through the verify barrel.

**Decided:** (c). `packages/verify/src/t03Criteria.ts` exports `evaluateT03Criteria(db, batch, srcRoot, input)` and `emptyT03Criteria()`, re-exported from `@strata/verify`. `runT03` keeps driving the rename + post-commit re-validate itself and passes `commitReturnedOk`/`validateAfterCommitClean`/`renameTxId` in; the regex/operation-row scoring moved behavior-preservingly.

**Why:** `@strata/verify` already owns validation and depends on the store/render surface the scorer needs, while both `@strata/cli` and the Phase 3 agent can consume it without creating an `agent -> cli` dependency or a fragile deep `dist/` import. The 4th `input` arg keeps the function pure while letting each caller feed in its own commit outcome.

**Design-doc impact:** none — refactor only; `RunT03Result` shape unchanged, existing `t03.test.ts` unchanged and green.

**Revisit when:** T03 grows additional criteria, or Phase 4 creates a dedicated `@strata/bench` package that should own benchmark-acceptance logic.

## 2026-05-15 — Phase 1 verticalizes around `rename_symbol`

**Context:** Phase 1 completed Tasks 10-14 after the substrate pieces from Tasks 0-9 were already green. The design doc's Phase 1 remains broader than this run's implemented mutation surface.

**Considered:**
- Implement the whole Phase 1 mutation set now.
- Ship the single `rename_symbol` vertical slice with the infrastructure it forced, then broaden later.

**Decided:** Phase 1 ships as the `rename_symbol` vertical slice: identifier-level ingest, TypeChecker references, transactions, operation log, render splicing, `@strata/verify` validate-before-commit, CLI smoke commands, and the T03 acceptance path.

**Why:** The T03 path exercises the load-bearing substrate without prematurely designing every mutation. The stable-ID, overlay, JSDoc traversal, source-map, validation, and SDK-schema decisions have all been tested against the same hero operation.

**Design-doc impact:** none for now. `strata-design.md` still describes the broader target; this records the implemented Phase 1 slice.

**Revisit when:** Phase 1.5 adds the second structural mutation and tests whether the same transaction/reference/render spine generalizes.

## 2026-05-15 — BS4 cleared with SDK Zod tool schemas

**Context:** Phase 1 Task 12 probed whether `@anthropic-ai/claude-agent-sdk` can express the future Strata tool shapes before Phase 3 agent work starts.

**Considered:**
- A hand-written JSON-schema-shaped smoke object only.
- A smoke harness that also type-checks against the SDK's real `tool(...)` / `SdkMcpToolDefinition` API.

**Decided:** Use the SDK's typed `tool(...)` surface with explicit Zod schemas for `TxHandle`, `NodeId`, and `Diagnostic[]`, plus a serializable `sdk-smoke` command output for inspection.

**Why:** The installed SDK exposes `tool` and accepts Zod raw-shape schemas. The smoke harness type-checks and runs, so BS4 is cleared without inventing a custom schema representation.

**Design-doc impact:** none — this confirms the planned Phase 3 SDK direction remains viable.

**Revisit when:** Phase 3 adds the real agent tool registry, or an SDK upgrade changes `SdkMcpToolDefinition` / `tool(...)`.

## 2026-05-15 — Validate uses the nearest corpus tsconfig before root defaults

**Context:** Phase 1 Task 11 T03 initially failed validation before any rename-specific check: `examples/medium` imports `.ts` extensions and uses `import.meta` / top-level await, but `@strata/verify` was compiling rendered files with the monorepo `tsconfig.base.json` CommonJS defaults.

**Considered:**
- Keep using only `tsconfig.base.json` and special-case T03.
- Load the nearest `tsconfig.json` from the rendered module paths, falling back to `tsconfig.base.json` when no corpus config exists.

**Decided:** `@strata/verify` now loads the nearest corpus `tsconfig.json` for rendered module roots and falls back to `tsconfig.base.json`.

**Why:** The corpus already compiles cleanly under its own `examples/medium/tsconfig.json`; validation should check rendered output under the same compiler options as the corpus, not unrelated package defaults. This was an implementation bug, not a TypeChecker resolution wall.

**Design-doc impact:** supersedes the earlier Phase 0 assumption that one root base config is enough for verification.

**Revisit when:** validation spans multiple package roots with incompatible configs.

## 2026-05-15 — BS2 T03 timing recorded below total-run threshold

**Context:** Phase 1 Task 11 timed the built T03 path: ingest `examples/medium`, rename `User` to `Account`, validate through `@strata/verify`, commit, and assert acceptance criteria.

**Considered:** Stop if the run exceeded the plan's total-run timing note or if a single-module ingest / affected-node transaction clearly crossed the BS2 thresholds.

**Decided:** Continue. The final built command reported `wallTimeMs = 511.3`; `/usr/bin/time -p` reported `real 0.69`, `user 1.21`, `sys 0.06`.

**Why:** The full command is well below the plan's 5s T03 total-run note, and no single 2k-LOC ingest or ~50-node transaction threshold was clearly exceeded by this fixture.

**Design-doc impact:** none.

**Revisit when:** T03 grows to the intended ~15 modules / ~40 type positions, or validate timing becomes agent-loop visible.

## 2026-05-15 — Render source maps are per-module statement spans

**Context:** Phase 1 Task 9 moved validation into the new `@strata/verify` package and maps TypeScript diagnostics from rendered files back to graph nodes.

**Considered:**
- A per-module source map of rendered byte spans to renderable node IDs.
- A deeper identifier-level source map that maps diagnostics directly to Identifier nodes.

**Decided:** `renderWithSourceMap` returns `Array<{ renderedStart; renderedEnd; nodeId }>` sorted by `renderedStart` for each module. `@strata/verify` keys those maps by rendered module path and binary-searches the span containing `diagnostic.start`. In Phase 1 those entries point to renderable statement/EOF nodes; Identifier rows remain splice inputs rather than source-map targets.

**Why:** TypeScript diagnostics are file-position based, and statement-level mapping is enough to make validate failures actionable for the rename slice. Identifier-level mapping can be layered on later without changing the per-module map contract. The BS3 probe on the two-module validate corpus took 322.9ms cold and returned one mapped diagnostic for the intentional half-rename, below the 500ms bail threshold, so a fresh `ts.Program` per validate call remains acceptable.

**Design-doc impact:** none — this locks in the Phase 1 source-map shape without changing `strata-design.md`.

**Revisit when:** diagnostics need to drive automatic repair at identifier precision, or validate on the medium corpus crosses the BS3 threshold.

## 2026-05-15 — Transaction overlay stores identifier text mutations in memory

**Context:** Phase 1 Task 6 implemented transactions for the `rename_symbol` slice.

**Considered:**
- Store full replacement `NodeRow` values in the overlay keyed by node ID.
- Store only identifier-text mutations keyed by identifier node ID, plus pending operation rows.

**Decided:** The Phase 1 overlay is an in-memory `identifierMutations: Map<identifierId, { text }>` plus `pendingOps: PendingOp[]`, keyed by `tx_id`. `commitWithoutValidate` materializes those text mutations into canonical Identifier payload rows. Open transactions do not survive process restart; startup recovery marks persisted `status='open'` rows as `rolled_back`.

**Why:** The public Task 6/9 mutation surface queues identifier updates without a database handle, so it cannot safely construct full replacement rows at queue time. The canonical offset and statement splice context stay in the store rows until validate/commit materializes the transaction view. This preserves the Phase 1 rename invariant while keeping the overlay small and tied to operation intent.

**Design-doc impact:** none to `strata-design.md`; this records a narrower implementation shape than the plan's full-`NodeRow` overlay option.

**Revisit when:** mutations need non-identifier replacements, or read APIs must expose a fully overlay-merged graph view before commit.

## 2026-05-15 — BS1 probed and cleared: AST traversal must use `getChildren`, not `forEachChild` + internal `.jsDoc`

**Context:** Phase 1 Task 4. The BS1 probe ("resolves the JSDoc `@param {User}` identifier") fired: the resolver resolved 5 of 6 `User` references, missing the JSDoc one. Per the spec this is a bail signal — stop, do not work around. Investigation followed before accepting the bail.

**Considered:**
- Accept BS1 as a true substrate wall (TypeScript can't do reference-aware rename through JSDoc) and re-spec.
- Investigate whether the miss is a substrate limitation or an implementation defect.

**Decided:** Not a true bail. Root cause is an implementation defect: the ingest/resolver traversal used `ts.forEachChild` (which deliberately skips JSDoc nodes) plus the **internal** `node.jsDoc` property as a workaround. The internal property is absent from TypeScript's public typings, so `tsc -b` failed outright; and even cast, `forEachChild` is the wrong traversal for JSDoc. A standalone probe (`/tmp/bs1-probe.mjs`) proved `checker.getSymbolAtLocation` **does** resolve JSDoc `@param {User}` and `@returns {User}` type-reference identifiers to their `InterfaceDeclaration` when the AST is walked with the public `node.getChildren(sourceFile)` API (which includes JSDoc). Resolution: all identifier traversal in `packages/ingest` uses a pre-order DFS over `node.getChildren(sourceFile)`; `ts.forEachChild` + `.jsDoc` is banned for identifier discovery.

**Why:** The spec's BS1 threshold is explicit — "if the workaround is no more than a different TypeChecker/AST method, continue." Switching `forEachChild`→`getChildren` is exactly a different AST method. The substrate (TS Compiler API) is sufficient for reference-aware rename including JSDoc; the bail signal correctly prevented a papered-over probe but the wall was illusory.

**Design-doc impact:** none — confirms the design's premise rather than changing it. Strengthens spec § "Open questions" Q1: TypeChecker accuracy is adequate for JSDoc type references.

**Revisit when:** a later identifier-bearing construct (e.g. template literal types, satisfies expressions) is missed by `getChildren` traversal — re-probe before assuming a wall, same as here.

## 2026-05-15 — Identifier lowering stops at TypeScript identifiers

**Context:** Phase 1 Task 3 added identifier-level ingest for `rename_symbol`, which needs addressable nodes for declaration and reference occurrences without turning the whole AST into graph rows.

**Considered:**
- Emit every `ts.Identifier` under each statement, including declaration names, type references, expression references, property names, and JSDoc identifiers surfaced by the TypeScript AST.
- Emit only rename-candidate identifiers after TypeChecker resolution.
- Add deeper expression/property-access lowering immediately.

**Decided:** Emit every `ts.Identifier` occurrence under a statement as an `Identifier` node with `{ text, offset }`, while leaving string literals, template literal text, and ordinary comment text out of the identifier layer. Identifier rows are non-renderable until the render splice work lands.

**Why:** The raw statement payload remains the canonical render path for now, and a shallow identifier layer is enough for Phase 1 rename resolution. Deferring filtering until Task 4 keeps ingest simple and lets the TypeChecker decide which identifiers are real references.

**Design-doc impact:** none — this locks in the Phase 1 plan's identifier emission boundary without changing the broader node graph direction.

**Revisit when:** later mutations need property-access member renames, expression-level edits, or comment-aware transformations outside JSDoc.

## 2026-05-15 — Stable node IDs use path plus structural child path

**Context:** Phase 1 Task 1 needs deterministic node IDs before identifier-level ingest and rename operations can preserve identity across non-structural mutations.

**Considered:**
- Path + structural-position hash: `modulePath`, dot-joined child index path, and node kind.
- Content-anchored IDs based on source text or syntax-node content.

**Decided:** Use `sha1(modulePath + ":" + childIndexPath + ":" + kind)`, truncated to 16 hex characters, implemented as the single `nodeId()` helper in `@strata/store`.

**Why:** This is deterministic across re-ingest of unchanged files and stable across Phase 1 rename mutations, which only change identifier text and do not alter parent/child shape. Content anchoring would better survive statement insertion, but it is more work than Phase 1's rename slice needs.

**Design-doc impact:** none yet — this resolves a Phase 1 plan-level open choice without changing the design direction.

**Revisit when:** operations need identity stability across structural edits such as inserted statements or moved declarations.

## 2026-05-14 — EOF trivia stored as a sibling `EndOfFileTrivia` node, not on the module

**Context:** Phase 0 ingest review found trailing trivia (comments/whitespace between the last statement's end and EOF) was silently dropped because `sourceFile.statements` doesn't include the `endOfFileToken`. A real codebase with a trailing footer comment would round-trip lossy without ingest noticing.

**Considered:**
- (a) Add a synthetic child node of kind `EndOfFileTrivia` at the highest `childIndex`, with the trivia text as its payload.
- (b) Attach the trivia to the module node (e.g., JSON-encode `{ path, trailingTrivia }` into the module payload).

**Decided:** (a). The module payload stays a plain string label, and rendering — which already orders children by `childIndex` — concatenates the trivia naturally as the last child.

**Why:** Keeps the module payload schema simple (still just a path string), avoids special-casing module payload parsing in render, and produces byte-identical round-trip on the new comment fixture and on all examples/small/*.ts. The trade-off is one extra node per module and a non-statement kind in the child list — fine because `EndOfFileTrivia` is structurally just another payload-bearing child for Phase 0.

**Design-doc impact:** none yet — Phase 0 is intentionally pre-schema. Lock in when the formal node-graph schema is written for Phase 1.

**Revisit when:** statement-level lowering lands and ingest no longer stores raw source text per child. The lowering for EOF trivia will probably remain "verbatim text" since it has no semantic structure, but the node kind may want renaming once other trivia kinds (between-statement comments, JSDoc) get their own representation.

## 2026-05-14 — Verify uses in-process TypeScript Compiler API, not subprocess `tsc`

**Context:** Phase 0 CLI initially shelled out to `npx tsc --noEmit` with hard-coded compiler options that didn't match `tsconfig.base.json`. Three problems: (1) PATH-dependent `npx` resolution, (2) the rendered output was being type-checked under different settings than the project's own build, (3) it contradicted the 2026-05-14 "TS Compiler API everywhere" decision logged below.

**Decided:** Verify is now in-process: `ts.createProgram([outputPath], options)` + `ts.getPreEmitDiagnostics(program)`. Compiler options are loaded from `tsconfig.base.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. No subprocesses anywhere in `packages/cli`.

**Why:** Consistency with the parser/printer decision; one toolchain for parse, print, and verify. Also faster (no `npx` cold start), and the rendered output is checked under the same compiler options that the project's own packages build under.

**Design-doc impact:** Consistent with strata-design.md § Verify ("TypeScript Compiler API for in-process type checks"). The design doc was already correct — Phase 0's first cut diverged and has now been brought back in line.

**Revisit when:** multi-file verification is needed (Phase 2). The current implementation only type-checks the single rendered file; Phase 2 will need program-level verification across all rendered modules.

## 2026-05-14 — Use TypeScript Compiler API for parse + print in Phase 0 (drop tree-sitter and Prettier)

**Context:** Phase 0 bootstrap. The design doc specifies `tree-sitter-typescript` for parsing and `prettier` for canonical rendering, with the TS compiler API reserved for type-checking in `verify`.

**Considered:**
- tree-sitter + Prettier as specified.
- @swc/core (fast Rust parser with a built-in printer).
- TypeScript Compiler API (`typescript` package) for both parse and print, with Prettier added later only if style needs tightening.

**Decided:** Use the TypeScript Compiler API for both parse and print in Phase 0. No tree-sitter, no swc, no Prettier yet.

**Why:** The design's stated reason for tree-sitter is "round-trip preservation," but Strata renders canonically and discards original formatting — that benefit is moot for our pipeline. Meanwhile `verify` already needs the TS compiler API, so using it as the parser too collapses three toolchains into one. `ts.createPrinter()` produces serviceable canonical output; Prettier can be a post-pass when we have a reason to add it. Cuts dependencies, install time, and conceptual surface for a phase whose only goal is proving the pipeline.

**Design-doc impact:** Supersedes the Tech stack § "Parser" recommendation and the Render § "prettier" line *for Phase 0*. Will revisit at Phase 1 boundary; if expression-level lowering reveals TS-printer output to be inadequate, reopen.

**Revisit when:** (a) we need richer formatting control than `ts.createPrinter()` provides; (b) ingest perf becomes a bottleneck (swc); (c) we need incremental reparse for live editing (tree-sitter).
