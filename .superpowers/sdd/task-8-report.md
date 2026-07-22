# Task 8 (gate 3) — pilot, medium acceptance suite: report

> **CONTINUATION (2026-07-22, operator-approved):** the BLOCKED finding below
> was verified and recorded (decisions.md 2026-07-22, commit 7b6975b; plan
> addendum). Operator decision: complete the big1k evidence run under amended
> semantics. Task 8 is now COMPLETE. See "Continuation" at the bottom for the
> amended acceptance suite (pins the recorded FAIL), run-big.ts + smoke, the
> artifact CI check, scripts, the three Task-7 obligations, and a NEW harness
> finding the smoke caught (kernel arm could not resolve a rename target in a
> replicated corpus). The original BLOCKED report is retained verbatim below.

> Note: `.superpowers/sdd/task-N-report.md` paths are reused per gate slice
> (documented precedent in the gate-2/gate-3 Task-7 reports). The prior contents
> of this path were an earlier slice's Task-8 report — safe in history; this
> task's brief directs the gate-3 Task-8 report here, so it is overwritten.

**Status: BLOCKED.** The medium acceptance corpus produces a **confident
noninferiority FAIL** — the kernel arm's p95 wall is ~4.0-4.8× the SQLite
arm's on `examples/medium`, with the bootstrap lower confidence bound (~3.9-4.8)
far above the 1.25× threshold, in **both** cold and warm modes. This is exactly
the brief's STOP condition ("a medium FAIL — kernel > 1.25× SQLite with
confidence even on 22 modules — fails the suite as a genuine finding → STOP +
report BLOCKED, never weaken"). Reproduced three independent times (pilot n=5,
pilot n=12, and the actual specified acceptance test). Downstream deliverables
(run-big.ts, artifact CI test, scripts, the three Task-7 type-extension
obligations) are intentionally **deferred** — they are premised on a not-FAIL
medium gate and on the operator's decision about how to handle this finding.
Nothing was committed.

## The finding (decision-grade)

On `examples/medium` (22 modules), at the pre-registered `N_MEDIUM=12` and
fixed seeds, computed with the **real production** `runCold`/`runWarm` +
`ratioVerdict` (not a probe reimplementation):

| Mode | p95 kernel | p95 sqlite | point ratio | ucb95 | lcb95 | state |
| --- | --- | --- | --- | --- | --- | --- |
| cold (pilot n=12) | 2169.5ms | 476.6ms | 4.552 | 4.605 | 4.499 | **FAIL** |
| warm (pilot n=12) | 2110.5ms | 441.3ms | 4.782 | 6.253 | 4.782 | **FAIL** |
| cold (acceptance test, N=12) | 2149.0ms | 538.6ms | 3.990 | 4.480 | **3.917** | **FAIL** |

The acceptance test (`tests/gate3Noninferiority.test.ts`) failed precisely on
`expect(report.medium.cold.state).not.toBe("FAIL")` — the noninferiority
contract, never weakened. Suite runtime: **76s** (confirms N is CI-viable).

### Mechanism (verified against the code, not assumed)

The timed windows are fair and are the plan's intended symmetric windows
(confirmed by reading `kernel-child.ts` / `sqlite-child.ts`):

- **kernel arm** times `submit_change_set` + advance-until-published — the
  daemon is started OUTSIDE the window; the window is 1 candidate validation,
  driven through the coordinator, which **spawns a fresh bridge worker (a Node
  subprocess) per advance** to render + `tsc`-validate the candidate.
- **sqlite arm** times in-process `validate` + `commit` = **2 `tsc` passes**,
  no process spawn, against an already-ingested `:memory:` db.

So even though the kernel does *fewer* type-checks (1 vs 2), its fixed
per-mutation **cross-process worker-spawn + IPC overhead (~2s)** dwarfs the
tiny 22-module `tsc` (~0.25-0.5s). This is architecture, not a harness bug: on
a small corpus the fixed orchestration cost swamps the type-check the corpus is
too small to make expensive. Whether **big1k** (1012 modules, where each `tsc`
is seconds-to-minutes) amortizes that fixed ~2s enough to reach the ratio → 1
is precisely the decisive, operator-run question the plan reserved for big1k —
but the medium corpus **cannot** demonstrate noninferiority and confidently
falsifies it at this scale.

## Pilot numbers (Step 1 — non-dispositive) and how each constant was chosen

Foreground, `examples/medium`, this machine (Homebrew node v26 / macOS arm64):

- cold n=5: kernel wall min/p50/p95 = 2101/2125/4163ms; sqlite = 482/492/497ms;
  kernel RSS 163MB, sqlite RSS 307MB. (~20s)
- warm n=8: kernel 1949/2035/2123ms; sqlite 297/312/425ms; kernel RSS 163MB,
  sqlite RSS 369MB; trend {first 5.00, last 5.14}. (~20s)
- baseline (1-copy) cold n=2: kernel RSS 163MB, sqlite RSS 305MB;
  moduleCount 22, digest 9f3de359fac4…. (~7s)
- per-pair wall: cold ≈ 4.5s, warm ≈ 2.5s post-warmup.

Pre-registered in `src/gate3/config.ts` (fixed BEFORE the dispositive run,
never tuned to a verdict):

- `N_MEDIUM = 12` — cold ≈ 54s + warm ≈ 30s ≈ 90s timed work (measured 76s incl.
  build/lifecycle probes), well under the ~25-30 min CI ceiling; 12 pairs give a
  non-degenerate paired bootstrap. Not undersized: CIs at N=12 are already tight.
- `N_BIG1K = 8` — smaller because each big1k sample is a 1012-module `tsc`
  (minutes/pair); 8 bounds each big1k mode to low-tens-of-minutes while keeping
  a usable bootstrap.
- `N_BASELINE = 3`, `WARM_HORIZON = 32` (finite ceiling, headroom over 12/8),
  `GROWTH_FACTOR = 4` (plan candidate).
- `KERNEL_1K_RSS_CAP` / `SQLITE_1K_RSS_CAP` = pilot medium harness-process peak
  RSS (164MB / 369MB) × **8** (stated conservative multiplier). Rationale in the
  file: big1k has 46× the modules but each harness process's RSS is dominated by
  a fixed Node/tsc(-client) baseline plus a per-module increment, so an 8×
  ceiling accommodates 46× growth of the incremental component while still
  catching a genuine unbounded leak. Marked PROVISIONAL — must be tightened
  after the operator's first big1k run yields real peak RSS (log a decision).
- Timeouts: cold kernel 300s, cold sqlite 180s, warm step 300s (big1k headroom).
- Fixed seeds for every (corpus, mode) schedule + bootstrap.

## What was built (and what was deferred)

**Built:**
- `packages/live-compare/src/gate3/config.ts` (new) — all pre-registered
  constants with pilot-derived rationale documented inline.
- `packages/live-compare/tests/gate3Noninferiority.test.ts` (new) — the medium
  acceptance suite, faithful to spec: real cold+warm at `N_MEDIUM`/seeds, real
  lifecycle traces (via `runChild` per arm), builds a medium-only `Gate3Report`
  via `buildGate3CorpusReport`/`buildGate3Report`, asserts `cold.state !==
  "FAIL"` AND `warm.state !== "FAIL"` AND lifecycle `{kernel:4,sqlite:4}` equal
  AND both arms' RSS > 0. No retries, no tolerance widening. The medium-only
  memory field is a documented non-dispositive placeholder (real growth
  predicate needs big1k).

**Deferred (premised on a not-FAIL medium + the operator decision):**
- `src/gate3/run-big.ts` (operator big run, tri-state exit, `--smoke`).
- `tests/gate3Artifact.ci.test.ts` (validates the committed artifact — which
  does not and should not exist while the gate is red).
- Root `package.json` scripts (`kernel:gate3:test`, `kernel:gate3:big`, chain
  append).
- The three Task-7 provenance/raw-pairs/lifecycle-dispositive type extensions
  (obligations 1-3) — those extend the **committed artifact** produced by
  run-big; producing that artifact from a red gate would be committing a FAIL as
  if it were a profile. They should be closed in the same session that resolves
  the gate.

Rationale for deferring rather than building-then-discarding: the operator's
decision on a confident medium FAIL may reshape the harness itself (e.g. the
per-advance worker-spawn cost may need addressing before gate 3 is winnable at
any corpus size where `tsc < ~2s`), which would change run-big's design.
Building it speculatively now, uncommitted, would be gold-plating against a
premise the finding has already falsified for the medium corpus.

## TDD / verification evidence

- The acceptance test is the specification of the gate; it was run against the
  real substrate and **failed red exactly on the noninferiority assertion**
  (`tests/gate3Noninferiority.test.ts:135`), with the driving verdict printed in
  the failure message (`lcb95 3.917 > 1.25`). This is the genuine finding
  surfaced through the real gate, not a hand-wave.
- `pnpm --filter @strata-code/live-compare build` is clean (config.ts + test
  compile).
- The finding is reproduced across three independent runs and both modes.

## Working-tree state (nothing committed)

- `?? packages/live-compare/src/gate3/config.ts` (new, mine)
- `?? packages/live-compare/tests/gate3Noninferiority.test.ts` (new, mine — RED
  by design, encoding the finding)
- ` M .superpowers/sdd/task-6-report.md` (pre-existing foreign change, not mine;
  matching the documented gate-2/gate-3 precedent, left untouched)

HEAD unchanged at `a92c8f5`.

## Operator decision required

The medium noninferiority gate is a **confident FAIL** driven by fixed
per-mutation cross-process worker-spawn overhead that a 22-module corpus is too
small to amortize. Options for the operator:

1. **Proceed to the big1k operator run anyway** — the plan's stated theory is
   that at 1012 modules `tsc` dominates and the fixed ~2s amortizes toward ratio
   → 1. If so, big1k could PASS while medium FAILs; the acceptance suite would
   then need its medium clause reconsidered (the plan currently treats a medium
   FAIL as terminal). This requires building run-big + closing obligations 1-3.
2. **Address the harness/kernel overhead first** — e.g. a warm/pooled bridge
   worker so a mutation does not pay a full Node process spawn per advance —
   then re-pilot. This would change run-big's design, which is why it was not
   pre-built.
3. **Revise the gate** — decide the noninferiority ratio/threshold or the
   timed-window definition needs to change (out of scope to weaken unilaterally;
   requires a logged decision).

Recommendation: log this finding as a decision (`decisions.md`) and pick between
(1) and (2) before any further gate-3 build. The pre-registered constants and
the real medium numbers above are the inputs for that decisions entry.

## Self-review

- **Reproduced before concluding** (MEMORY: feedback-reproduce-before-rerunning):
  three runs, both modes, real production functions — not a single noisy number.
- **Verified the mechanism against source** (MEMORY: independent-review /
  verify-pivotal-claims): read both child entrypoints; the timed windows are the
  plan's intended symmetric windows and the kernel does *fewer* tsc passes, so
  the slowdown is genuinely orchestration overhead, not an unfair window.
- **Never weakened the test** — it asserts the real 1.25× contract and is red
  because the finding is real. No retries, no threshold widening.
- **Did not commit** a red gate into the green chain (MEMORY: kernel-canonical-
  test-gate — green claims require the full suite; a committed red acceptance
  test would violate that).
- **Did not gold-plate** speculative big1k infrastructure the operator decision
  may invalidate (CLAUDE.md: ship the smaller honest piece; don't chase).
- **Did not prematurely declare impossibility** (MEMORY: working-style) — big1k
  may still amortize; the finding is scoped to the medium corpus and routed to
  the operator, not generalized to "the kernel can't win."

---

# Continuation (2026-07-22) — completed under amended semantics

**Status: DONE.** All deferred deliverables built, the three Task-7 obligations
closed, `kernel:gate3:test` GREEN (exit 0), the run-big smoke validated
end-to-end (exit 2, the recorded FAIL), committed.

## 1. Acceptance suite amended to PIN the recorded FAIL

`tests/gate3Noninferiority.test.ts` now asserts `medium.cold.state === "FAIL"`
AND `medium.warm.state === "FAIL"` (plus lifecycle 4/4, both arms' RSS > 0). A
prominent comment block cites decisions.md 2026-07-22 and states the 1.25x
threshold, windows, N, seeds, and bootstrap are UNCHANGED — the suite now
protects the integrity of the recorded finding (catches a silent machinery
regression that would flip the verdict), it is NOT a weakened gate. GREEN:
cold FAIL, warm FAIL, lifecycle 4/4, RSS captured (72–80s, CI-viable).

## 2. Deferred deliverables built

- `src/gate3/run-big.ts` — builds ×46 big1k + 1-copy baseline into FRESH
  mkdtemp dirs; runs cold+warm+characterization+lifecycle+memory on medium AND
  big1k; writes `docs/spikes/gate3-noninferiority-profile.{json,md}` FIRST + a
  sibling `.head` marker; then exits tri-state (0 PASS / 2 FAIL / 1
  INCONCLUSIVE-or-infra). Prints verdict + per-(corpus,mode) UCB/LCB. `--smoke`
  (2 copies, N=2) writes to a throwaway tmpdir, never docs/spikes.
- `tests/gate3Artifact.ci.test.ts` — zod-validates the committed artifact,
  asserts mandatory non-empty raw pairs + N consistency, and binds
  `provenance.headSha` to the sibling `.head` marker (mechanism: run-big writes
  marker = provenance.headSha alongside the artifact; the test asserts they
  agree, catching a hand-edited/stale artifact). SKIPS GRACEFULLY with a clear
  message while the artifact does not exist (Task 9 produces it) — verified
  (1 skipped, chain stays green).
- Root `package.json`: `kernel:gate3:test` (gate2-style prelude → `test
  gate3Noninferiority gate3Artifact`), `kernel:gate3:big` (prelude → `node
  packages/live-compare/dist/gate3/run-big.js`), and `&& pnpm kernel:gate3:test`
  appended to `kernel:full-key-free:test`.

## 3. Three Task-7 obligations closed (file:line)

1. **Provenance carries the plan-required fields (additive).**
   - `provenance.ts:41` `Provenance.metricsMode?` + `GATE3_METRICS_MODE`
     (`report.ts` provenance header renders it).
   - `report.ts:34-58` `ScheduleProvenance` (seed + N + realizedOrder) and
     `CorpusInfo` (digest + moduleCount + copies); `report.ts:~90-105`
     `Gate3CorpusReport.corpusInfo?`/`schedules?`. run-big threads real values
     (`run-big.ts` `runCorpus`: `corpusInfo`, `schedules.{cold,warm}` with
     `realizedOrder(pairs)` and `n=pairs.length`). All additive/optional — the
     21-test fixture unit suite still passes unchanged.
2. **Raw pairs mandatory on the real path.** `report.ts` `writeGate3Artifacts`
   gains `requireRawPairs?`; run-big passes `requireRawPairs: true`, which
   throws if any present corpus has empty coldPairs/warmPairs. The artifact CI
   test independently asserts non-empty `coldPairs`/`warmPairs` and
   `schedules.*.n === pairs.length`. (Fixture unit writes omit the flag, stay
   green.)
3. **Lifecycle parity dispositive in the machine verdict.** `report.ts`
   `gate3MachineVerdict(report)`: an overall PASS additionally REQUIRES 4-vs-4
   lifecycle on every present corpus — a mismatch collapses to exit 1 (cannot
   certify PASS), a measured FAIL to exit 2. run-big exits on it. (With the
   recorded medium FAIL present the exit is 2, but the lifecycle gate is correct
   standalone — unit-reasoned in the function doc.)

## 4. NEW harness finding the smoke caught (decision-relevant for Task 9)

The `--smoke` run (its stated purpose: not letting Task 9 be the first
execution of this path) **failed on the first attempt** with `kernel-child: no
interface named "User" found in module src/copy01/types/user.ts`. Root cause,
verified by probing the live daemon: the kernel graph's `Module` nodes carry an
**empty `payload`** (`inspect_nodes` returns `""`), so — unlike the SQLite arm
(`modulePathOf`) — the kernel arm has NO module-path information to select a
specific replicated copy by. `kernel-child.ts` / `characterize.ts`'s
`resolveTargetDeclarationId` multi-match branch (matching `node.payload ===
target.modulePath`) was therefore dead for ANY multi-copy corpus; it had never
run before because every prior gate-3 suite uses single-copy `examples/medium`
(exactly one match, early return).

**Fix (measurement-sound, documented in both files):** on multiple matches the
kernel arm now picks the lexicographically-smallest `nodeId` deterministically
instead of matching an unavailable path. This is valid because every
`src/copyNN` replica is verbatim-identical (same source, same intra-copy
reference count, imports copy-relative) and validation tsc-checks the WHOLE
corpus regardless of which copy is mutated — so renaming any single match is a
measurement-equivalent, reproducible timed mutation. The SQLite arm keeps its
precise `modulePath` selection; the arms may rename different copies but perform
the identically-shaped mutation. Single-copy medium is unaffected (25/25 daemon
suites still green). **Operator note:** if Task 9 wants the two arms to target
the *same* copy, the daemon would need to expose module path (a Rust
model/registration change) — out of scope here; logged as a limitation.

Post-fix smoke: exit 2, verdict FAIL, all four legs printed (medium cold
3.808/FAIL, warm 1.958/FAIL; big1k-2copy cold 4.067/FAIL, warm 7.740/FAIL),
artifact + marker written to tmpdir. (2-copy ratios are NOT representative of
1012 modules — amortization remains Task 9's question.)

## 5. Verification (exactly what was run)

- `kernel:gate3:test` → **exit 0**, GREEN (gate3Noninferiority pins FAIL;
  gate3Artifact skips).
- Affected single-copy daemon suites (gate3Child, gate3Runners, gate3Lifecycle,
  gate3Characterize + their unit siblings) → 25/25 GREEN (confirms the
  kernel-child/characterize fix is safe for medium).
- `gate3Report.unit.test.ts` → 21/21 GREEN (additive type changes compatible;
  one transient 5s-timeout of the real collectProvenance test under concurrent
  load, GREEN in isolation at 1228ms).
- run-big `--smoke` → exit 2, full pipeline validated.
- Full package `build` (`tsc -b`) clean throughout.
- I did NOT run the full `kernel:full-key-free:test` (30+ min, mostly Rust +
  gate1 + gate2 I did not touch) — my entire blast radius is gate3-scoped
  (report/provenance/config/run-big/kernel-child/characterize consumed only by
  gate3 suites + run-big), and all of it is GREEN via the runs above.
- I did NOT run the full-size big1k measurement — that is Task 9's operator run.

## 6. Concerns for the operator (Task 9)

1. **Kernel/SQLite arms rename different replicated copies** (fix in §4). Sound
   for the wall-ratio measurement (identical mutation shape); flagged in case
   Task 9 wants same-copy parity (needs a daemon module-path change).
2. **Memory growth predicate is degenerate for the 1-copy-baseline design.**
   baseline (1 copy = 22 modules) and medium (examples/medium = 22 modules) are
   the SAME size, so `(medium - baseline)` ≈ 0 — the growth ratio is not
   computable. run-big's `memoryVerdictTolerant` returns INCONCLUSIVE (sentinel
   growthAdjusted = -1) in that case rather than crashing/emitting NaN. The
   absolute RSS caps still evaluate. Memory is non-dispositive for the overall
   gate (FAIL rests on the wall-ratio), but the operator may want a smaller
   baseline corpus for a meaningful growth denominator.
3. **Provisional RSS caps** (pilot medium × 8) are untested at 1012 modules;
   tighten after Task 9's first real big1k RSS (log a decision).
