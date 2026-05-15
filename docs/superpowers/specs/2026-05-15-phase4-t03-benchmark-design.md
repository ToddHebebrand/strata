---
title: "Phase 4 design — the T03 benchmark: substrate vs. file-based baseline"
date: 2026-05-15
status: draft
authors:
  - todd@olivetech.co
related:
  - ../../../strata-design.md
  - ../../../CLAUDE.md
  - ../../../decisions.md
  - ../../benchmarks.md
  - ./2026-05-15-phase3-agent-design.md
  - ../plans/2026-05-15-phase3-agent-plan.md
  - ./2026-05-14-phase1-rename-symbol-design.md
---

## Summary

Phase 4 of Strata is implemented as a single vertical slice, the same way
Phases 1 and 3 were. Phase 3 proved a Claude agent can drive the
`rename_symbol` substrate spine for benchmark task T03 through only the eight
hermetic Strata tools. Phase 4 changes one thing: it adds a *second
configuration* — a file-based "Claude Code"-style baseline that performs the
same T03 rename on a working tree of real `.ts` files — and a benchmark
harness that runs both configurations N trials each, captures the
`strata-design.md` § "Metrics" measurements per trial, and emits a structured
plus human-readable comparison report with **distributions**, not just means.

This is the central proof obligation of the whole project
(`strata-design.md` § "Benchmark design": "The benchmark is the central
proof"). Phase 4 is deliberately verticalized on **T03 only**. The Strata
agent has exactly one structural mutation (`rename_symbol`); the other nine
benchmark tasks in `docs/benchmarks.md` (T01, T02, T04–T10) require mutation
tools that do not exist in `@strata/store` yet (Phase 1.5+). Building those
to widen the benchmark would reopen settled phasing and conflate
substrate-maturity risk with measurement risk. One task, two configurations,
one clean comparison — and an honest distribution, including "no measurable
difference" or "variance too high to call," which `strata-design.md`
§ "What success looks like" explicitly names as legitimate publishable
results.

The scoping decision (verticalized T03-only benchmark now) is **settled** and
is not reopened by this spec. This document writes the approved design down
rigorously and grounds every part of it in the existing Phase 1/3
implementation.

## Background

**Phase 0/1 state.** Phase 0 proved ingest → SQLite statement nodes →
render → `tsc --noEmit` round-trips without semantic loss. Phase 1
verticalized on `rename_symbol`: identifier-level lowering, a
`node_references` index resolved via the TypeScript `TypeChecker`
(`getChildren` traversal, public APIs only), an in-memory transaction
overlay, an append-only `operations` log, render splicing, and a separate
`@strata/verify` package owning `validate(db, tx)` and the validating
`commit(db, tx)`. The programmatic T03 path in
`packages/cli/src/commands/t03.ts` passes all 11 acceptance criteria.

**Phase 3 state.** `@strata/agent` wraps the store/verify spine as eight
in-process `@anthropic-ai/claude-agent-sdk` tools over one shared
`{ db, actor }` session context. `runAgentT03` (in
`packages/agent/src/session.ts`) ingests `examples/medium`, runs a headless
`query(...)` session against the **verbatim T03 prompt** with a hermetic
options block, iterates the message stream, and scores the agent-produced
store state via `evaluateT03Criteria` (now in `@strata/verify`, per the
Phase 3 plan's Amendment 1). The session log (`packages/agent/src/log.ts`)
already captures, per run: `SDKResultMessage` usage (input/output tokens,
cache-read/cache-creation tokens), `total_cost_usd`, `num_turns`,
`duration_ms`, `duration_api_ms`, per-`tool_call` events with `ok`/`error`
and `durationMs`, and the runtime-invariant guard from the `init` message.
The hermetic isolation contract is settled and enforced in code
(`decisions.md` 2026-05-15 "Agent hermetic isolation"): `tools: []`,
`disallowedTools` including `LSP`, `strictMcpConfig: true`,
`settingSources: []`, `permissionMode: 'bypassPermissions'` +
`allowDangerouslySkipPermissions: true`. There is a deterministic replay
path for key-free CI; live runs require an API key and are
operator-pending.

**Phase 4 in the design doc.** `strata-design.md` § "Phase 4: Benchmarks"
calls for a benchmark harness with multiple tasks, the same tasks runnable
against Claude Code (baseline) and the Strata agent (substrate), metrics
captured (tokens, time, success/failure, retries), and results documented —
"5–10 tasks of varying complexity, run each 3–5 times per configuration for
statistical signal." § "Benchmark design" adds the cost budget
("$200–500 per benchmark round at Sonnet 4.6 prices") and the explicit
"report distributions, not just averages."

**What this spec narrows it to, and why verticalized.** One task (T03), two
configurations (substrate = the existing `runAgentT03`; baseline = a new
file-based SDK agent on a temp checkout), N trials each, with a
provably-equivalent scorer and a real cost budget. The narrowing is a
phasing choice, not a scope cut:

- **The substrate side can only do T03.** The Strata agent has exactly one
  mutation tool, `rename_symbol`. T01/T02/T04–T10 in `docs/benchmarks.md`
  require `add_parameter`, `extract_function`, `replace_body`,
  `inline_function`, `create_function`, etc. — none of which exist in
  `@strata/store` (Phase 1 spec § "Out of scope"; `decisions.md`
  2026-05-15 "Phase 1 verticalizes around `rename_symbol`"). Inventing them
  to widen the benchmark reopens settled phasing and is explicitly
  rejected here.
- **T03 is the right hero.** It has a proven 11-check pass/fail acceptance
  test with built-in anti-cheat negatives (the `"User"` audit literal must
  survive; the only-remaining-`User` invariant), exactly the property that
  made it the Phase 1 and Phase 3 hero. A green run is unambiguous, and the
  same criteria can score *both* configurations.
- **Verticalizing isolates the measurement.** With one task and a
  provably-identical success bar, any signal (or absence of signal) is
  attributable to the substrate-vs-files difference, not to task
  selection, scorer drift, or an immature second tool.

## Approach

Two configurations, **identical task and identical success bar**, run N
trials each by one harness, measured by the `strata-design.md` § "Metrics"
schema, reported as distributions.

1. **Substrate (Strata).** The existing Phase 3 `runAgentT03` — a headless
   SDK agent whose *entire world is the node graph*, with only the eight
   hermetic Strata tools, no filesystem/bash/LSP tools, operating on an
   in-memory store ingested from `examples/medium`, scored by
   `evaluateT03Criteria` against committed store state. **Reused as-is. Not
   forked.** Phase 4 calls it; it does not modify it.

2. **Baseline (file-based / "Claude Code").** A new headless SDK agent given
   the **same verbatim T03 prompt** and the **same model and `maxTurns`
   budget class**, but with the normal Claude Code file tool surface
   (Read/Write/Edit/Glob/Grep/Bash) and **no Strata tools**, operating on a
   **fresh checkout of `examples/medium` in a temp directory**. It edits
   real `.ts` files. It is allowed to run `tsc --noEmit` and the corpus's
   own test suite to verify its own work.

**The deliberate contrast — and why it is not a methodological flaw.** The
substrate config is hermetic by settled decision (`decisions.md` 2026-05-15
"Agent hermetic isolation": `tools: []`, `disallowedTools` incl. `LSP`,
`strictMcpConfig: true`, `settingSources: []`). The baseline config does the
**deliberate opposite**: real file tools, real working tree, free typecheck
and test execution. This asymmetry is the entire point of the experiment.
`strata-design.md` § "Configurations" — "Only the substrate differs" — and
`docs/benchmarks.md` Open Questions ("Baseline tool surface … Default
position: yes, both configurations can run typecheck/tests freely; the
comparison is on substrate, not on tooling deprivation") both require the
baseline to be *given full file-based tooling*. Handicapping the baseline
(e.g. denying it `tsc`/test feedback so the substrate's built-in `validate`
looks like a free win) would invalidate the result. The thing held constant
across configs is **model, prompt, and success bar**; the thing varied is
**substrate (node graph + structural ops) vs. files (text + edit tools)**.
That is the hypothesis under test (`strata-design.md` § "What Strata is":
"agents are bottlenecked by the file abstraction").

This does **not** violate the CLAUDE.md "files are not first-class"
invariant. That invariant governs the **substrate side** — `store`, `agent`,
the tool layer must never accept a file path as the unit of work, and they
do not. The baseline is, by construction and by `strata-design.md`
§ "Configurations", a file-based agent that is *not part of the substrate*;
it is the control group the substrate is measured against. Files being
first-class to the baseline is the experimental condition, not a leak into
Strata.

## Scorer equivalence (the crux)

The comparison is valid **only if "did T03 succeed" is judged identically
for both configurations**. This is the highest-rigor section of the spec and
the part most likely to be gotten wrong. If it cannot be made
provably-equivalent, BS-Bench-B fires and no comparison number ships.

### What exists today

`evaluateT03Criteria(db, batch, srcRoot, input)` in
`packages/verify/src/t03Criteria.ts` (read in full for this spec) does the
following: for every module in `batch.modules`, it renders the **committed
store state** to TypeScript text via `renderModule(db, moduleId)`, keys the
rendered text by the module's path-relative-to-`srcRoot` (POSIX),
`mustGet`s seven specific module texts plus `index.ts`, and applies a fixed
set of **regexes over that text** plus two **cross-module counting checks**
(`remainingUserOccurrences` across all rendered modules vs.
`auditUserOccurrences` in `server/audit.ts`). Of its 11 criteria, **nine are
pure functions of the rendered module text** keyed by module path:
`importRenamed`, `typeAnnotationRenamed`, `genericPromiseRenamed`,
`namespaceImportRenamed`, `auditLiteralUntouched`,
`auditLiteralOnlyRemainingUser`, `indexReExportRenamed`,
`jsdocReferencesRenamed`, and the cross-module
`auditLiteralOnlyRemainingUser` count. Two are **substrate-only**:
`operationRowAppended` (inspects the `operations` SQL table for a single
`RenameSymbol` row with `old_name: "User"`, `new_name: "Account"`,
`affected.length > 1`), and the pair `commitReturnedOk` /
`validateAfterCommitClean` which today come from `T03CriteriaInput` supplied
by the substrate caller (`runT03` / `runAgentT03` pass their own commit +
post-commit-revalidate outcome).

### The shared-core refactor

Factor `t03Criteria.ts` into two layers, **behavior-preserving for the
existing substrate path**:

1. **A pure text-criteria core.** A new exported function — proposed
   `evaluateT03TextCriteria(modules: Map<string, string>): T03TextCriteria`
   — that takes a `Map<modulePath, finalSourceText>` (paths POSIX-relative
   to the corpus `src/` root) and the operation/negative inputs baked into
   the regexes, and returns the **nine text-derived criteria**. This is
   literally the existing `renderedBySuffix` block from
   `evaluateT03Criteria` lifted to take the map as a parameter instead of
   building it from `db`. **Same regexes, same `\bUser\b` counting, same
   anti-cheat negatives, same `mustGet` keys, same pass/fail.** No regex is
   rewritten; the diff is "where does the `Map` come from," nothing else.

2. **Two adapters that produce the `Map`, then both call the same core.**
   - **Substrate adapter** (the existing path, refactored, not
     re-implemented): for each `batch.modules` entry, `renderModule(db,
     moduleId)` → `Map`. This is exactly today's `renderedBySuffix`
     construction; `evaluateT03Criteria` keeps its current signature and
     internally builds the `Map` then delegates to
     `evaluateT03TextCriteria`. `runT03` and `runAgentT03` are unchanged.
   - **Baseline adapter** (new, in `packages/bench`): after the baseline
     agent finishes, read the **post-edit files off the baseline's working
     tree** — walk `<tempCheckout>/src/**/*.ts`, key each by its path
     relative to `<tempCheckout>/src` (POSIX), `readFileSync` the final
     text → `Map` — then call the **same `evaluateT03TextCriteria`**. Same
     core, same regexes, same negatives, same pass/fail. The baseline's
     `.ts` files on disk are the analog of the substrate's rendered store
     modules: both are "the final TypeScript text of each module," and the
     scorer cannot tell which produced it.

This makes the nine text criteria provably equivalent: a single function,
two `Map` producers, byte-identical scoring logic. The substrate renders to
text; the baseline already is text; the scorer sees only text.

### The `commitReturnedOk` / `validateAfterCommitClean` pair

These two are *not* substrate-internal in a way that breaks fairness — they
have a natural file-based analog: "did the change apply, and does the
resulting code typecheck?" Specify them per-config as part of the **shared
bar**, defined symmetrically:

- **Substrate:** as today — `commitReturnedOk` = the agent's
  `commit_transaction` returned `{ ok: true }`;
  `validateAfterCommitClean` = a fresh post-commit `validate(db, tx)` on a
  throwaway transaction returns zero diagnostics (this is what
  `runAgentT03` already computes via the `checkTx` block).
- **Baseline:** `commitReturnedOk` = the baseline agent terminated with
  `SDKResultMessage.subtype: 'success'` **and** at least one file under
  `<tempCheckout>/src` was modified (a "the agent claims it did the work"
  signal symmetric to "commit returned ok"); `validateAfterCommitClean` =
  the harness runs `tsc --noEmit` over `<tempCheckout>` (via the corpus's
  own `tsconfig.json`, consistent with `decisions.md` 2026-05-15 "Validate
  uses the nearest corpus tsconfig") and it reports zero errors. This is
  the same question — "did it apply and does it still typecheck" — asked of
  the file tree instead of the store overlay.

### The `operationRowAppended` fairness decision (explicit)

`operationRowAppended` inspects the `operations` SQL table. A file-based
baseline has **no operation log** — there is no git, no commit ledger, and
`strata-design.md` § "The operation log" makes the op log a
*substrate-specific* artifact ("There is no git, no commits in the
traditional sense"). There is no honest file-based analog: any
reconstructed "the rename structurally happened" check for files would
re-derive the answer from the same final text the nine text criteria
already cover, adding nothing but a false appearance of symmetry.

**Decision: drop `operationRowAppended` from the shared pass/fail bar.
Report it as a substrate-only sub-metric, not as part of the comparison's
success definition.** The shared success bar is the **ten criteria** that
have a faithful file analog (nine text + the symmetric
`commitReturnedOk`/`validateAfterCommitClean` pair, treating the pair as
two of the ten). `operationRowAppended` is recorded for the substrate trial
as an additional substrate-only observation in the report (it is part of
the substrate's correctness story — the operation log being canonical
history per CLAUDE.md — and worth surfacing), but a substrate trial is
"successful for comparison purposes" on the same ten-criterion bar the
baseline is judged on.

**Justification.** The alternative — define a file-based analog — would
have to be "the rename happened in the files," which is *exactly what the
nine text criteria already prove*. Adding a synthetic file-side
`operationRowAppended` would either (a) duplicate the text criteria under a
different name (no information, false symmetry) or (b) inspect something the
baseline genuinely lacks and score it as a failure every trial (a built-in
substrate handicap-in-reverse that biases toward the substrate). Both are
worse than honestly excluding it from the shared bar and reporting it as
what it is: a substrate-only property. This is a real fairness decision and
it is made here explicitly; it is revisited only if Open Question 2's
implementation finding contradicts it.

## Metrics & statistics

Per trial, per config, matching `strata-design.md` § "Metrics" exactly.
Schema (the harness `Metrics` type, `packages/bench/src/metrics.ts`):

| Metric | Definition (both configs unless noted) | Source |
|---|---|---|
| `totalTokens` | `inputTokens + outputTokens` (and separately `cacheReadInputTokens`, `cacheCreationInputTokens` for cache-hit context) | `SDKResultMessage` usage — already captured by the Phase 3 session log `result` event for the substrate; the baseline runs through the same SDK and yields the same `SDKResultMessage` |
| `wallTimeMs` | `duration_ms` from `SDKResultMessage` (end-to-end), plus harness-measured `Date.now()` bracket as a cross-check | `SDKResultMessage.duration_ms`; harness wall clock |
| `toolInvocations` | count of tool/edit invocations | substrate: count of `tool_call` log events; baseline: count of file-tool invocations (Read/Write/Edit/Glob/Grep/Bash) parsed from the baseline's own session log, same `tool_use`-pairing mechanism `runLiveSession` already implements |
| `failuresRetries` | the symmetric retry rule below | derived from each config's session log |
| `success` | **all ten shared criteria pass** (nine text + the `commitReturnedOk`/`validateAfterCommitClean` pair) | `evaluateT03TextCriteria` + the per-config commit/typecheck pair |
| `resultQuality` | does the corpus typecheck after (`tsc --noEmit` clean) **and** does its own vitest suite pass (`pnpm vitest run` exit 0) | substrate: render all modules to a temp dir, `tsc`+vitest there; baseline: `tsc`+vitest in the working tree |
| `terminalReason` | `success` / `error_max_turns` / `error_wall_time` / `error_during_execution` / `error_other` | already a `TerminalReason` union in `session.ts`; baseline gets the analogous mapping |
| `operationRowAppended` | substrate-only sub-metric (see fairness decision) | substrate `operations` table; `null` for baseline |

### The symmetric retry/failure counting rule (resolves the benchmarks.md ambiguity)

`docs/benchmarks.md` Open Questions flags this explicitly ("What counts as a
'retry' for the baseline … Need a concrete counting rule before running, or
the metric is meaningless"). Resolved here, symmetric and defensible:

> **A "failure/retry" is one observed self-correction event: a verification
> action that returned a negative result and was followed by at least one
> further mutating action in the same session.** Counted identically in
> spirit for both configs:
>
> - **Substrate retry** = a `validate` tool call that returned a non-empty
>   `Diagnostic[]`, **or** a `commit_transaction` that returned
>   `{ ok: false }`, that is followed by any further mutating tool call
>   (`rename_symbol`, another `begin_transaction`, `rollback_transaction`)
>   before the terminal result. (Both are already first-class in the
>   Phase 3 session log: `validate`/`commit_transaction` `tool_call` events
>   carry `ok`/`error`; `rollback_transaction` is a logged tool.)
> - **Baseline retry** = a `Bash` invocation running `tsc`/`vitest`/test
>   that exited non-zero, **or** an `Edit`/`Write` to a file path that had
>   already been edited earlier in the same session (a re-edit of
>   already-touched code), that is followed by any further `Edit`/`Write`
>   before the terminal result.
>
> The unifying definition both specialize: **"the agent checked its work,
> the check failed, and it changed the code again."** A failed check with
> no subsequent edit (the agent gave up or finished anyway) is recorded in
> `terminalReason`/`success`, not double-counted as a retry.

This is symmetric (a failed verification + subsequent edit, on each side's
native verification and edit primitives), measurable from each config's
session log with no extra instrumentation, and resilient to the
configs' different tool vocabularies. It is proposed here and **validated
during implementation** (Open Question 1): the first live trials will be
inspected to confirm the rule classifies obvious self-corrections correctly
and doesn't over/under-count; if it mis-fires, the corrected rule is logged
as a `decisions.md` entry, not silently changed.

### Distributions, not means

`strata-design.md` § "Metrics" is explicit: "Report distributions, not just
averages. Outlier behavior is informative." The report (`src/report.ts`)
emits, per config, per numeric metric: **N, min, max, median, mean, p25,
p75, stddev, and the raw per-trial values** — never a bare mean. `success`
and `terminalReason` are reported as counts/rates over N (e.g. "substrate:
5/5 success; baseline: 3/5 success, 2× `error_max_turns`"). The comparison
section states the per-metric distributions side by side and explicitly
labels "overlapping distributions / no separable signal at this N" when
that is what the data shows — that is a legitimate result
(`strata-design.md` § "What success looks like": "If the benchmark shows no
improvement, that's also a result"), not something to massage.

### Cost budget (real, documented up front)

`strata-design.md` § "Cost budget": "$200–500 per benchmark round at Sonnet
4.6 prices." A round here is `2 configs × N trials` **live** model runs
(replay does not apply to metric runs — see § Determinism). The harness:

- Defaults **N = 3**, configurable up to 5 (`strata-design.md` § "Phase 4":
  "3–5 times per configuration"). Lower bound 3 chosen to keep a default
  round cheap (6 live runs) while still yielding a distribution; the
  operator opts into 5 (10 live runs) when budget allows.
- **Estimates and logs the projected spend before running.** Before the
  first trial it prints `2 × N` and a rough per-run cost band derived from
  the Phase 3 single-run `total_cost_usd` (once a Phase 3 live number
  exists; until then it prints "unknown — first live round establishes
  baseline cost" and BS-Bench-C is evaluated from round one's actuals).
- Records actual `total_cost_usd` per trial (substrate already does via the
  session log `result` event; baseline gets the same) and the round total
  in the report, so every round's real spend is on the record.

## Configurations in detail

### Substrate config — reuse `runAgentT03` as-is

`packages/bench/src/configs/substrate.ts` is a **thin wrapper**, not a
re-implementation:

- It calls `runAgentT03({ corpusRoot: <examples/medium>, model, maxTurns,
  wallTimeMs, logPath: <per-trial> })` from `@strata/agent` once per trial,
  live (no `replayTranscript`).
- `runAgentT03` already ingests `examples/medium`, runs the hermetic
  session, scores via `evaluateT03Criteria`, and returns
  `{ criteria, terminalReason, log, transcript }`. The wrapper extracts the
  metrics from `result.log` (the `result` event has tokens/cost/turns/wall
  time; `tool_call` events give invocation count and the substrate retry
  signal) and the ten shared criteria from `result.criteria` (ignoring
  `operationRowAppended` for the shared bar; recording it as the
  substrate-only sub-metric).
- `resultQuality` for the substrate: render every module of the committed
  store to a temp dir and run `tsc --noEmit` + `pnpm vitest run` there.
  (The substrate has no working tree; rendering to a scratch dir is the
  established pattern — `evaluateT03Criteria` already renders modules; this
  reuses `@strata/render` the same way `@strata/verify` does.)

**The substrate path is not modified.** Phase 4 consumes its public
`@strata/agent` barrel surface (`runAgentT03`, `AgentT03Result`,
`SessionLog`). The only change to existing packages is the
behavior-preserving `evaluateT03TextCriteria` extraction inside
`@strata/verify` (additive export; existing `evaluateT03Criteria` signature
and `t03.test.ts` unchanged — same discipline as the Phase 3 plan's
Amendment 1 scorer extraction).

### Baseline config — file-based SDK agent on a temp checkout

`packages/bench/src/configs/baseline.ts`. Per trial:

1. **Materialize a fresh corpus working tree** in an OS temp dir
   (`<tmp>/strata-bench-baseline-<trialId>/`). Mechanism: recommend
   **`git clone --depth=1 file://<repo> <tmp>` then sparse/checkout only
   `examples/medium`, or simpler: a recursive copy of `examples/medium`
   plus `git init` so the baseline's own `git`-aware tooling (and the
   re-edit detection) has a clean tree.** A copy is sufficient because the
   baseline never needs repo history; what it needs is an isolated,
   writable, real `.ts` tree with the corpus `tsconfig.json` and
   `package.json` so `tsc`/`vitest` work. **Recommended: recursive copy of
   `examples/medium` into the temp dir (no clone).** Validated during
   implementation (Open Question 3): if the corpus's tests need installed
   `node_modules`, the harness either pre-installs once into the temp tree
   or symlinks the corpus's resolved deps; the copy-vs-clone choice is
   confirmed by what actually makes `pnpm vitest run` green in the temp
   tree, and the outcome is logged in `decisions.md`.
2. **Run a headless `query(...)` session** with:
   - **The same model** as the substrate trial (passed in by the runner so
     both configs in a round are pinned identically).
   - **The verbatim T03 prompt** — the exact `T03_PROMPT` string exported
     from `@strata/agent`/`session.ts` (imported, not re-typed, so it
     cannot drift), prepended only with the minimal context a file agent
     needs that the substrate agent gets for free: the working-tree root
     path. (The substrate agent is told "you operate on a graph"; the
     baseline agent is told "the codebase is at `<tmp>/…`". This is the
     irreducible framing difference between "graph world" and "file world";
     the *task text* is byte-identical.)
   - **The Claude Code file tool surface**: `tools: ['Read', 'Write',
     'Edit', 'Glob', 'Grep', 'Bash']` (or the `{ type: 'preset', preset:
     'claude_code' }` tools preset if that is the cleaner SDK expression of
     "normal Claude Code tools" — confirm the exact preset/allow-list
     during implementation against installed `sdk.d.ts`), **no
     `mcpServers`**, **no Strata tools**. `permissionMode:
     'bypassPermissions'` + `allowDangerouslySkipPermissions: true` so the
     headless run never blocks (it may freely Read/Write/Edit/Bash in its
     temp tree). `cwd: <tempCheckout>` so file tools are scoped to the
     working tree.
   - **The same `maxTurns` budget class** and an `abortController`
     wall-time ceiling, set to the **same values** the substrate trial uses
     in that round (budget parity is part of "same success bar").
   - `systemPrompt`: the SDK's default Claude Code system prompt (the
     `{ type: 'preset', preset: 'claude_code' }` form) — the baseline
     *should* get Claude Code's real file-centric instructions; that is
     what "the Claude Code baseline" means. It must **not** get the Strata
     worldview prompt (that would be incoherent — there is no graph).
3. **Capture the same metrics** by iterating the `Query` async generator
   with the **same message-pairing logic `runLiveSession` already
   implements** (the `tool_use`/`tool_use_result` pairing, the
   `SDKResultMessage` usage capture). Factor that loop so both configs
   share it (see § "Package / file layout"); the only per-config difference
   is the options block and the post-run scoring adapter.
4. **Score** by reading the post-edit `.ts` files off `<tempCheckout>/src`
   into a `Map<modulePath, text>` and calling the shared
   `evaluateT03TextCriteria` (the baseline adapter from § "Scorer
   equivalence"). `resultQuality` runs `tsc --noEmit` + `pnpm vitest run`
   in `<tempCheckout>`.
5. **Tear down** the temp tree after metrics + final text are captured
   (keep it on failure, gated by a `--keep-artifacts` flag, for
   post-mortem).

**Fairness rules, restated as invariants the harness asserts:**

- Same model string in both configs of a round (asserted, not assumed).
- Byte-identical task text (`T03_PROMPT` imported from one source; the
  harness asserts the string it sends to the baseline `.includes(...)` /
  equals the substrate's `T03_PROMPT`).
- Same `maxTurns` and wall-time ceiling in both configs of a round.
- Baseline gets full file tooling including the ability to run `tsc`/tests
  (it is **not** denied verification feedback — the explicit
  `docs/benchmarks.md` stance; denying it would invalidate the result).
- Identical success bar: the same ten shared criteria, same
  `evaluateT03TextCriteria`, applied to "final text of each module"
  regardless of how that text was produced.

## Determinism & the no-key / CI story

Phase 3's determinism problem was "make a live-model acceptance test
reproducible in key-free CI" — solved with recorded-transcript replay.
**Phase 4's situation is the opposite and must be stated explicitly:
benchmarking *wants* many live, nondeterministic runs — measuring variance
across trials is the entire point** (`strata-design.md` § "Metrics":
"Report distributions … Outlier behavior is informative"). Replay does
**not** apply to metric runs: a replayed transcript has zero token cost and
zero wall-time variance, so replaying would fabricate the very numbers the
benchmark exists to measure. The metric runs are, by definition, live.

This is reconciled with "`pnpm -r test` must stay green with no API key"
(Phase 3 plan operator/implementer split; CLAUDE.md working style) as
follows:

- **Harness logic gets key-free unit tests with synthetic/mocked
  sessions.** The trial loop, the metrics aggregation/distribution math
  (`metrics.ts`), the shared `evaluateT03TextCriteria` core, the baseline
  file-reading adapter, the symmetric retry counter, and the report
  formatter are all pure or mockable. `packages/bench/tests/*` exercises
  them against **synthetic session logs and synthetic working trees** (e.g.
  a fixture `Map<modulePath, text>` representing a correct rename, a
  half-rename, an audit-literal-clobbered rename — proving the shared
  scorer rejects/accepts exactly as the substrate path does on the real
  store). **No live model call in the test suite.** `pnpm -r test` is green
  with no key.
- **The actual benchmark is an explicit, key-gated command, not a CI
  test.** Proposed: `pnpm --filter @strata/bench bench:t03`
  (a `package.json` script invoking `src/runner.ts`). It requires
  `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, **writes a results
  artifact** (JSON + Markdown) under `packages/bench/results/`, and is run
  by the operator (mirrors the Phase 3 operator-pending live-run pattern).
  It is **not** wired into `pnpm -r test`; a benchmark round is an operator
  action with a real dollar cost, not a gate that must pass on every
  commit.
- **Equivalence is proved key-free.** The scorer-equivalence claim
  (§ "Scorer equivalence") is verified without a key: a unit test feeds the
  *same* `Map<modulePath, text>` (rendered from a committed real-store T03
  run fixture, and the equivalent file text) through both the substrate
  `evaluateT03Criteria` path and the baseline `evaluateT03TextCriteria`
  adapter and asserts the ten shared criteria are identical. Provable
  equivalence does not need the model; only the *variance numbers* do.

## Package / file layout

New package `packages/bench` (the design doc reserves it,
`strata-design.md` § "Project layout"). Mirrors the existing package shape
(`@strata/<name>`, `main`/`types` → `dist`, `tsconfig.json` extending
`../../tsconfig.base.json` with `composite: true`, `src/`, `tests/`). The
`packages/*` workspace glob already includes it; no workspace-config change.

```
packages/bench/
├── package.json          # name "@strata/bench"; deps below; "bench:t03" script
├── tsconfig.json         # extends ../../tsconfig.base.json; references agent, verify, ingest, store
├── src/
│   ├── index.ts          # barrel: runner, Metrics types, report types
│   ├── runner.ts         # trial loop: for trial in 1..N, run substrate then baseline; aggregate
│   ├── configs/
│   │   ├── substrate.ts  # thin wrapper over @strata/agent runAgentT03 (live, per-trial)
│   │   └── baseline.ts   # file-based SDK agent on a temp checkout of examples/medium
│   ├── session.ts        # shared headless query() loop + tool_use/result pairing + SDKResult capture
│   │                     #   (factored so substrate metric-extraction and baseline reuse one loop;
│   │                     #    substrate config reuses @strata/agent's loop, baseline reuses this one)
│   ├── score.ts          # baseline file-reading adapter -> Map<modulePath,text> -> evaluateT03TextCriteria
│   ├── metrics.ts         # Metrics schema + aggregation/distribution stats (min/max/median/p25/p75/stddev)
│   └── report.ts         # JSON + Markdown comparison report writer
├── tests/
│   ├── score.test.ts      # scorer-equivalence: same Map -> identical ten criteria (key-free)
│   ├── metrics.test.ts    # distribution math on synthetic per-trial values (key-free)
│   ├── retry.test.ts      # symmetric retry rule on synthetic session logs (key-free)
│   └── baselineAdapter.test.ts # post-edit-files -> Map on a synthetic temp tree (key-free)
└── results/               # round artifacts (gitignored except a .gitkeep); JSON + Markdown
```

**Dependency edges (acyclic; `bench` is a top-level leaf consumer, above
`agent`):**

- `@strata/bench` **depends on** `@strata/agent` (`runAgentT03`,
  `AgentT03Result`, `SessionLog`, `T03_PROMPT`, `STRATA_*` names),
  `@strata/verify` (`evaluateT03TextCriteria` + the existing
  `evaluateT03Criteria`/`T03Criteria` types, all from the verify barrel),
  `@strata/ingest` (only if a test fixture needs to build a `batch`;
  test-scoped — add under `devDependencies` if so, mirroring how `verify`
  carries `@strata/ingest` as a test-only dev dep), and
  `@anthropic-ai/claude-agent-sdk` + `zod` (the baseline runs the SDK
  directly). It depends on `@strata/render`/`@strata/store` only
  transitively via `agent`/`verify` — a direct dep is added only if the
  substrate `resultQuality` render-to-temp path needs `@strata/render`
  directly (likely yes for rendering committed modules to a scratch dir;
  add `@strata/render` + `@strata/store` as direct deps if so, mirroring
  `@strata/verify`'s deps).
- **`@strata/bench` depends on `@strata/agent`; nothing depends on
  `@strata/bench`.** It does **not** depend on `@strata/cli` (Phase 3
  plan Amendment 1 discipline: `cli` is the top of the graph, nothing feeds
  back through it; the shared scorer lives in `verify` precisely so `bench`
  reaches it without a `cli` edge). This preserves the
  `strata-design.md` § "Architecture" layering (bench sits above the agent;
  the design doc's layout already places `bench/` as a sibling leaf).
- `tsconfig.json` `references`: `../agent`, `../verify`, plus `../ingest`
  / `../store` / `../render` as needed by the resultQuality render path
  (mirror `packages/agent/tsconfig.json`'s `references` pattern; list every
  package actually imported so project-references `tsc -b` is correct — the
  Phase 3 plan's "build first, then test; vitest does not typecheck" trap
  applies here too).
- `package.json` deps: `@strata/agent`, `@strata/verify` as
  `workspace:*`; `@anthropic-ai/claude-agent-sdk` and `zod` as regular
  `dependencies` (promoted into the package since it ships against them,
  same as the Phase 3 plan promoted them into `@strata/agent`).

## Bail signals

Exit criteria for "stop and surface, don't work around." Same rigor as the
Phase 1/3 spec bail signals. A surfaced wall is more valuable than a
papered-over one. Each is logged in the task that surfaces it and appended
newest-first to `decisions.md` (per the Phase 3 plan's per-task-decisions
convention). BS-Bench-C and BS-Bench-D are *measurement findings* —
recorded and published honestly, not massaged.

### BS-Bench-A — the baseline cannot complete T03 with file tools at all

If the file-based baseline agent, given full Claude Code file tooling, a
fresh working tree, and free `tsc`/test feedback, **cannot complete the T03
rename at all** across the trial set (zero successes; e.g. it cannot find
all references, cannot make `tsc` clean, or loops to `error_max_turns`
every trial), that is **itself a finding to surface, not hide**. Rename is
Claude Code's core competency; if it genuinely cannot do T03 with files,
either the corpus/prompt is broken for the baseline (fix the harness, not
the substrate) or the result is "files make even a routine rename
unreliable," which is a publishable substrate argument — but it must be
*reported as observed*, not engineered away by quietly making T03 easier
for the baseline than for the substrate. Stop, inspect, log; do not tune
the baseline's task to manufacture a comparison.

### BS-Bench-B — substrate and baseline scorers cannot be made provably-equivalent

If the shared `evaluateT03TextCriteria` core **cannot** be made to score
the substrate's rendered text and the baseline's post-edit file text
identically (e.g. rendering canonicalizes whitespace/quotes such that a
regex that passes on baseline text fails on rendered text for a
semantically-identical rename, and it cannot be reconciled within the
shared core without per-config special-casing), then the comparison is
**apples-to-oranges and invalid**. Do **not** ship a number. Stop, surface
the specific divergence, and either reconcile it in the shared core
(canonical-form the baseline text the same way render does, before scoring
— legitimate, since both are then judged on canonical text) or log that the
T03 scorer is not config-portable and the benchmark needs a different
success oracle. A wrong equivalence is worse than no number.

### BS-Bench-C — cost explosion

If `2 × N` live runs exceed a sane per-round budget (`strata-design.md`
§ "Cost budget": $200–500/round) — e.g. the baseline thrashes for hundreds
of turns per trial, or per-run cost is an order of magnitude above the
Phase 3 single-run figure — **stop before burning the budget**. N must stay
small and configurable (default 3); the projected spend is printed and the
operator confirms before a round. A round that would blow the budget is
halted and the cost driver (which config, which behavior) is logged; it is
not "absorbed" by running anyway.

### BS-Bench-D — variance so high that no signal is distinguishable

If, at N = 3–5, the per-trial distributions for the two configs **overlap
so heavily that no metric separates them**, that is **a legitimate result,
not a failure to massage** (`strata-design.md` § "What success looks
like": "If the benchmark shows no improvement, that's also a result");
report it honestly as overlapping distributions with the raw per-trial
values shown. Do **not**: cherry-pick trials, drop "outliers" to force
separation, increase N silently until a difference appears, or report a
mean that hides the overlap. The honest finding ("no measurable difference
at this N" or "variance dominates the effect at this N") is published as
the result; raising N to chase significance is an explicit, budgeted,
logged operator decision, not a quiet retry.

## Open questions

Deliberately unresolved; answered by what implementation observes, not
pre-decided on paper. Each carries a recommendation to validate.

### 1. Exact symmetric retry/failure counting rule

The rule in § "Metrics & statistics" ("a failed verification action
followed by a further mutating action") is the proposed definition.
**Recommendation:** ship it as specified, then inspect the first live
round's session logs by hand to confirm it classifies obvious
self-corrections correctly on both sides and does not over-count (e.g. a
single failed `validate` immediately followed by `rollback` then a corrected
`rename_symbol` should count as **one** retry, not three). If it
mis-classifies, log a corrected rule as a newest-first `decisions.md`
entry; do not silently retune. The metric is reported with its exact
counting rule stated alongside it so a reader can audit it.

### 2. Does `operationRowAppended` belong in the shared bar or as a substrate-only sub-metric?

**Recommendation: substrate-only sub-metric, excluded from the shared
pass/fail bar** (justified in § "Scorer equivalence"). The file baseline
has no operation log and any synthetic file analog either duplicates the
text criteria (false symmetry) or scores the baseline as failing every
trial for lacking a substrate-specific artifact (reverse handicap).
Confirm during implementation that excluding it does not weaken the
substrate's success definition in practice — i.e. verify on the Phase 1/3
real-store T03 run that whenever the nine text criteria + the commit/
validate pair all pass, `operationRowAppended` also passes (it should, by
construction: a correct rename goes through one `RenameSymbol` op). If a
case is found where the text criteria pass but the op row is absent (a
correctness gap the text criteria miss), that finding reopens this question
and is logged.

### 3. Baseline temp-checkout mechanism (clone vs. copy)

**Recommendation: recursive copy of `examples/medium` into an OS temp dir
(plus `git init` so re-edit detection and any git-aware tooling have a
clean tree), not `git clone`.** The baseline needs an isolated writable
real `.ts` tree with the corpus `tsconfig.json`/`package.json` and working
`tsc`/`vitest`, not repo history. Validate during implementation that
`pnpm vitest run` is actually green in the copied tree (the corpus may need
`node_modules` — pre-install once into the temp tree, or symlink the
corpus's resolved deps, whichever makes the suite pass reproducibly). The
confirmed mechanism (copy vs. clone, deps handling) is logged in
`decisions.md`.

## Suggested build order

A suggestion, not a prescription. Resequence if a different order surfaces
problems earlier. Steps 1–7 need no API key; only step 8 (a live round)
does. Both `pnpm -r build` and `pnpm -r test` must be green at every task
boundary (the Phase 3 plan's "vitest does not typecheck" trap applies).

1. **Extract `evaluateT03TextCriteria` in `@strata/verify`,
   behavior-preserving.** Lift the `renderedBySuffix`-consuming block of
   `evaluateT03Criteria` into a pure `Map<modulePath,text>`-taking
   function; have `evaluateT03Criteria` build the map (unchanged) and
   delegate. Re-export from the verify barrel. Confirm `pnpm -r test`
   green (existing `t03.test.ts` / Phase 3 scorer tests unchanged). This
   de-risks the crux before any bench code.
2. **Scaffold `packages/bench`.** `package.json` (deps: `@strata/agent`,
   `@strata/verify`, sdk, zod; `bench:t03` script), `tsconfig.json`
   (references agent/verify and any render/store needed),
   `src/index.ts` barrel. Operator runs `pnpm install`.
3. **`src/metrics.ts`.** The `Metrics` schema + distribution stats
   (min/max/median/p25/p75/mean/stddev + raw values). Unit-test the math
   on synthetic per-trial arrays (key-free).
4. **`src/score.ts`.** The baseline file-reading adapter
   (`<tempCheckout>/src/**/*.ts` → `Map`) calling
   `evaluateT03TextCriteria`. **Scorer-equivalence test (key-free):** feed
   one `Map` (from a committed real-store T03 fixture rendering, and the
   equivalent file text) through both the substrate `evaluateT03Criteria`
   path and this adapter; assert the ten shared criteria identical. This is
   BS-Bench-B's gate — do not proceed past here until equivalence holds.
5. **`src/session.ts`.** The shared headless `query()` loop +
   `tool_use`/`tool_use_result` pairing + `SDKResultMessage` capture
   (factor from the Phase 3 `runLiveSession` pattern). Unit-test the
   pairing + the symmetric retry counter on synthetic message streams
   (key-free).
6. **`src/configs/substrate.ts`.** Thin wrapper over `runAgentT03`;
   extract metrics from its returned log; map the ten shared criteria;
   record `operationRowAppended` as the substrate-only sub-metric;
   `resultQuality` via render-to-temp + `tsc`/vitest. Unit-test the
   metric-extraction from a synthetic `AgentT03Result` (key-free).
7. **`src/configs/baseline.ts` + `src/report.ts`.** The file-based SDK
   agent on a temp copy of `examples/medium` (Open Question 3 mechanism);
   the JSON+Markdown report writer with distributions. Unit-test the report
   formatter on synthetic per-trial metrics (key-free); unit-test the
   temp-tree materialization + post-edit `Map` read on a synthetic tree
   (key-free). The live `query()` path is exercised only in step 8.
8. **`src/runner.ts` + the live round (operator).** The trial loop
   (for trial in 1..N: substrate then baseline; aggregate; write artifact).
   Print projected spend (BS-Bench-C) before running. Operator runs
   `pnpm --filter @strata/bench bench:t03` with a key. Record actual cost,
   the distributions, and any BS-Bench-A/C/D observation as a newest-first
   `decisions.md` entry regardless of outcome.

## Glossary

- **Round.** One full benchmark execution: `2 configs × N trials` live
  model runs, producing one results artifact under
  `packages/bench/results/`.
- **Trial.** One live run of one config (one `runAgentT03` call for
  substrate; one baseline `query()` session on a fresh temp tree). N trials
  per config per round.
- **Configuration / config.** Either **substrate** (the hermetic
  `runAgentT03`, node graph, eight Strata tools) or **baseline** (the
  file-based Claude Code-style SDK agent on a temp working tree). Held
  constant across configs: model, task prompt, success bar, turn/wall
  budget. Varied: substrate vs. files.
- **Shared bar / shared criteria.** The **ten** criteria judged identically
  for both configs: the nine text-derived criteria from
  `evaluateT03TextCriteria` plus the symmetric
  `commitReturnedOk`/`validateAfterCommitClean` pair. `success` ⇔ all ten
  pass.
- **`evaluateT03TextCriteria`.** The new pure function (extracted
  behavior-preservingly from `evaluateT03Criteria` in `@strata/verify`)
  that takes `Map<modulePath, finalSourceText>` and returns the nine
  text-derived criteria. The single source of scoring truth both configs
  call.
- **Substrate adapter / baseline adapter.** The two `Map` producers:
  substrate renders committed store modules to text (existing path);
  baseline reads post-edit `.ts` files off its temp working tree. Both feed
  the identical core.
- **Substrate-only sub-metric.** `operationRowAppended` — recorded for
  substrate trials, `null` for baseline, **not** part of the shared
  pass/fail bar (see § "Scorer equivalence" fairness decision).
- **Retry / failure (counting rule).** One observed self-correction: a
  failed verification action (substrate: failed `validate` /
  `commit_transaction`; baseline: non-zero `tsc`/test run or re-edit of an
  already-edited file) followed by at least one further mutating action
  before the terminal result.
- **Distribution report.** Per config, per numeric metric: N, min, max,
  median, mean, p25, p75, stddev, and the raw per-trial values — never a
  bare mean. Overlapping distributions / no separable signal at the chosen
  N is reported as the result, not massaged.
