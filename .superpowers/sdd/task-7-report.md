# Task 7 (gate 3) — Gate-3 report builder, provenance, tri-state, artifact writer: report

> Note: `.superpowers/sdd/task-N-report.md` paths are reused per gate slice
> (documented precedent in this same file's gate-2 Task-7 report, commit
> 8b10f4c). The prior contents of this path were the gate-2 Task-7
> observability-suite report — safe in history at that commit; this task's
> brief directs the gate-3 Task-7 report here, so it is overwritten.

**Status: DONE.** `packages/live-compare/src/gate3/report.ts` and
`.../provenance.ts` are implemented per the brief; the fixture-only unit
suite (`gate3Report.unit.test.ts`, 21 tests) is green, TDD RED confirmed
first, and the full `gate3` group (11 files / 75 tests) is green after the
build.

## Implementation

- **Created** `packages/live-compare/src/gate3/provenance.ts`:
  - `Provenance` interface exactly per the brief: `{ headSha, dirty,
    harnessDigest, daemonBinarySha, os, cpu, nodeVersion, rustVersion,
    scheduleSeed?, timestamp? }`.
  - `collectProvenance(options?: { scheduleSeed?, timestamp? })` — the only
    exported entrypoint; ALL impurity (git `rev-parse HEAD` / `status
    --porcelain` via `execFileSync`, `rustc --version`, filesystem hashing,
    `os.cpus()/platform()/release()`, `process.version`) lives here,
    isolated from `report.ts`. `timestamp` is never generated inside this
    module (no `Date.now()`/`new Date()`) — always caller-injected.
  - `harnessDigest(distGate3Dir?)` — sha256 over the sorted
    `{relPath: sha256(contents)}` map of every file under the built
    `dist/gate3/**` (mirrors `corpus.ts`'s `sha256Hex` pattern exactly:
    sorted-keys JSON, so directory-walk order never perturbs the digest).
    Throws if the directory doesn't exist rather than hashing nothing.
  - `daemonBinarySha(binaryPath?)` — sha256 of the `strata-kernel-service`
    binary, defaulting to `kernelServiceBinary()` (gate1.ts's existing
    env-override-or-`target/debug` resolver — reused, not reimplemented).
    Throws if missing.

- **Created** `packages/live-compare/src/gate3/report.ts` — pure
  assembly/verdict/rendering only, no I/O beyond the final artifact write:
  - `Gate3CorpusReport` — `{ cold, warm, warmTrend, memory:{kernel,sqlite},
    lifecycle:{kernel,sqlite}, server? }` per the plan's shared vocabulary,
    plus two **optional** additions: `coldPairs?`/`warmPairs?`
    (`SchedulePair[]`) so the committed JSON can retain every raw sample
    behind the summary `RatioVerdict`s (the brief's "JSON retains ALL raw
    samples" — `RatioVerdict` itself carries only the bootstrap summary
    numbers, not the pairs it was computed from) without forcing every
    caller, including hand-built unit fixtures that never ran a real child,
    to supply them.
  - `buildGate3CorpusReport(inputs)` — a deliberate, documented pass-through:
    it assembles already-computed pieces (Tasks 3-6's `ratioVerdict`,
    `memoryVerdict`, `lifecycleParity`, `characterizeKernelServer`,
    `runCold`/`runWarm`'s pairs), it does not compute any of them itself.
  - `corpusState(report)` — **the corpus-state derivation rule this task
    defines** (the plan's `Gate3CorpusReport` shape carries no `state`
    field of its own): worst-of-four over `cold.state`, `warm.state`,
    `memory.kernel.state`, `memory.sqlite.state`, precedence FAIL ≺
    INCONCLUSIVE ≺ PASS. `lifecycle` is deliberately excluded — it's a
    pass/fail-by-inspection call-count pair (4 vs 4), not itself a
    tri-state verdict, and Task 8's own acceptance suite already asserts
    lifecycle parity as an independent condition ("AND lifecycle 4/4")
    rather than folding it into the noninferiority tri-state; `server`
    (metrics-on characterization) is excluded too, per the plan's "feeds
    the gate-3 REPORT, never the wall verdict".
  - `buildGate3Report(provenance, {medium, big1k?})` — overall verdict =
    worst state across corpora present, **except** overall PASS additionally
    requires BOTH corpora present: `big1k` absent + medium PASS is capped
    down to INCONCLUSIVE; medium-only FAIL/INCONCLUSIVE is NOT capped (those
    are genuine findings regardless of what a bigger corpus would show).
  - `renderGate3Markdown(report)` — provenance header; one
    `(corpus, mode)` row per present corpus with n/p50/p95 (n/p50 derived
    from `coldPairs`/`warmPairs` via `nearestRankDistribution` when present,
    else "n/a" — `RatioVerdict` itself has no `n`/`p50` field), ratio,
    ucb95/lcb95, tri-state; a memory table; lifecycle parity line; a verdict
    banner that literally names the overall verdict word and its measured
    UCB (or, for FAIL, the falsifying LCB) via `decisiveRatioVerdict` — the
    corpus/mode whose own state equals the overall verdict, preferring
    `big1k` over `medium` and `warm` over `cold`.
  - `writeGate3Artifacts(report, outDir, {deterministicName?})` — JSON is
    `JSON.stringify(report, null, 2)` verbatim (nothing summarized away —
    provenance + every raw sample the caller attached comes along for free
    since it's just the object graph); Markdown from
    `renderGate3Markdown`. Deterministic name
    `gate3-noninferiority-profile.{json,md}` (mirrors `writeGate2Artifacts`'s
    existing `{deterministicName}` convention exactly); default name
    `gate3-profile-<ISO>.{json,md}`.

## TDD RED → GREEN

- **RED:** wrote `gate3Report.unit.test.ts` first, then moved
  `report.ts`/`provenance.ts` out of the tree and ran
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test
  gate3Report` → `Cannot find module '../src/gate3/provenance.js'`, 1 file
  failed, 0 tests collected.
- Restored both files, re-ran → **GREEN:** `Test Files 1 passed (1)` /
  `Tests 21 passed (21)` on the first implementation attempt (no fix-up
  round needed).
- `pnpm --filter @strata-code/live-compare build` → clean, no `tsc -b`
  errors.
- Gate-3 group: `PATH=/opt/homebrew/bin:$PATH pnpm --filter
  @strata-code/live-compare test gate3` → **`Test Files 11 passed (11)` /
  `Tests 75 passed (75)`**, 72.5s (includes the real cold/warm/child/daemon
  suites from Tasks 1-6, unaffected by this task).

## Unit-suite coverage (21 tests, `gate3Report.unit.test.ts`)

- `corpusState`: the brief's PASS (ucb95 1.18)/FAIL (lcb95 1.4)/
  INCONCLUSIVE (straddle) fixtures resolve correctly; a FAIL memory
  verdict alone (ratios PASS) still drives FAIL; a lifecycle mismatch does
  NOT affect corpusState (proves the exclusion rule).
- `buildGate3Report` precedence: PASS+PASS→PASS, PASS+FAIL→FAIL (both
  orders), PASS+INCONCLUSIVE→INCONCLUSIVE, FAIL+INCONCLUSIVE→FAIL;
  provenance threaded through unchanged (`toEqual`).
- Medium-only never PASS: PASS-only corpus → INCONCLUSIVE (`big1k`
  `undefined`); FAIL-only → FAIL (not capped); INCONCLUSIVE-only →
  INCONCLUSIVE.
- Markdown banner: PASS report contains `## Verdict: PASS` and the literal
  `1.1800` (decisive corpus's ucb95); FAIL contains `## Verdict: FAIL` and
  `1.4000` (the falsifying lcb95); INCONCLUSIVE contains `## Verdict:
  INCONCLUSIVE` and `1.3200`; provenance fields (headSha/harnessDigest/
  daemonBinarySha) and both `### medium`/`### big1k` sections present.
- `writeGate3Artifacts`: deterministic-name files exist at the expected
  paths, JSON round-trips to the same verdict/provenance, `coldPairs`/
  `warmPairs` retained verbatim (length + a spot-checked field); default
  (non-deterministic) name matches the timestamped pattern.
- **One real, unmocked `collectProvenance()` smoke test** (no mocks): 40-hex
  `headSha`, boolean `dirty`, two real 64-hex sha256 digests
  (`harnessDigest` over the actually-built `dist/gate3/**`,
  `daemonBinarySha` over the actually-built `target/debug/strata-kernel-
  service`), non-empty `os`/`cpu`, `nodeVersion` matching `v\d+\.`,
  `rustVersion` containing "rustc", and the injected `scheduleSeed`/
  `timestamp` passed through untouched. 441ms.

## Files changed

- `packages/live-compare/src/gate3/report.ts` (new)
- `packages/live-compare/src/gate3/provenance.ts` (new)
- `packages/live-compare/tests/gate3Report.unit.test.ts` (new, 21 tests)
- `.superpowers/sdd/task-7-report.md` (this report)

## Self-review

- Verdict precedence, corpus-state derivation, and the medium-only-never-
  PASS cap are implemented exactly as specified in the orchestrator brief
  and independently re-derived from the plan's own vocabulary section; both
  match.
- `collectProvenance`'s impure collectors are fully isolated in
  `provenance.ts`, imported into `report.ts` only as a type — verified by
  the RED run (deleting the impl files, not just report.ts, still failed
  cleanly on the missing module, and the fixture tests never call
  `collectProvenance`).
- No existing file was modified — `gate1.ts`'s `kernelServiceBinary()` and
  `gate3/schedule.ts`'s `SchedulePair`/`Sample` types were consumed as-is,
  not changed. `index.ts` was left unchanged: no other `gate3/*` module is
  re-exported there either (confirmed by grep before starting), so
  `report.ts`/`provenance.ts` follow the same "import directly from
  `src/gate3/...js`" convention every other gate3 test file already uses.
- Markdown row n/p50 fields are `RatioVerdict`-external (that type has no
  `n`/`p50`) — derived from the optional `coldPairs`/`warmPairs` when
  present, else "n/a"; this is a judgment call flagged for operator
  awareness below since the plan text doesn't spell out where n/p50 come
  from.

## Concerns

1. **n/p50 in the Markdown table are derived, not part of `RatioVerdict`.**
   The plan's `RatioVerdict` shape (already landed, Task 3) is
   `{p95Kernel, p95Sqlite, pointRatio, ucb95, lcb95, state}` — no `n`, no
   `p50`. To satisfy "one row per (corpus, mode) with n/p50/p95" I added
   optional `coldPairs`/`warmPairs` to `Gate3CorpusReport` and compute n/p50
   from them via the existing `nearestRankDistribution` when a caller
   supplies the raw pairs (Task 8/9's real runs will); fixture-only
   `Gate3CorpusReport`s (this task's own tests) render "n/a" there. This is
   an additive, backward-compatible extension of the plan's sketch, not a
   change to any already-landed type.
2. **A foreign uncommitted change was left out of my commit**, matching the
   documented gate-2 Task-7 precedent: `.superpowers/sdd/task-6-report.md`
   shows modified in `git status` (Task 6's own report update, not
   authored by me this session). I did not `git add -A`; I staged only my
   three files explicitly.
