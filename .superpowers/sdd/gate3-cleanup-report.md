# Gate 3 post-recording cleanup report

Applied after the gate-3 FAIL verdict was recorded and committed
(`docs/spikes/gate3-noninferiority-profile.{json,md}`). Nothing in this
change touches the committed artifact, the recorded verdicts, the dispositive
machinery semantics (`ratioVerdict`, the 1.25 threshold, seeds, N, timed
windows), or the pinned acceptance suite's assertions. All items are
non-verdict-relevant hygiene triaged from the final whole-branch review.

## 1. Cap-mask fix — `packages/live-compare/src/gate3/run-big.ts` (`memoryVerdictTolerant`, ~line 173)

**What changed:** in the degenerate-denominator branch (`values.medium <=
values.baseline`), `state` was unconditionally `"INCONCLUSIVE"` even when
`absoluteCapPass` was `false`. The absolute cap is an independent predicate
from the growth ratio; a cap breach must be dispositive (`FAIL`) regardless of
whether the growth denominator is computable. Fixed: `state = absoluteCapPass
? "INCONCLUSIVE" : "FAIL"`.

Also exported `memoryVerdictTolerant` (was module-private) and added a
`require.main === module` guard around the `main()` invocation at the bottom
of `run-big.ts` (mirroring the identical pattern already in `cli.ts`) so the
pure function can be imported by a unit test without executing the real
operator run (children, corpus builds, artifact write).

**Test:** `packages/live-compare/tests/gate3RunBig.unit.test.ts` (new file) —
3 cases: cap breached + degenerate denominator → `FAIL`; cap ok + degenerate
denominator → `INCONCLUSIVE` (both the `medium === baseline` and `medium <
baseline` forms of degeneracy); boundary/arm-threading sanity case.

**Result:** `pnpm --filter @strata-code/live-compare test gate3RunBig` — 3
passed.

## 2. False comment fix — same file, same function's doc comment

**What changed:** the doc comment claimed "memory stays non-dispositive in
`gate3MachineVerdict`" — false. Both arms' `MemoryVerdict.state` feed
`corpusState` (worst-of-four: cold/warm/memory-kernel/memory-sqlite), which
feeds `report.verdict`, which `gate3MachineVerdict` exits on — so a memory
verdict CAN and DOES drive the process exit code (this is plan-consistent,
not a bug). Rewrote the comment to describe this actual data flow instead of
the false "non-dispositive" claim.

**Test:** covered by the existing `gate3Report.unit.test.ts` case ("a FAIL
memory verdict alone (ratios PASS) still drives the corpus to FAIL"), which
already demonstrates the real behavior the comment now describes; no new
test needed for a comment-only change.

## 3. Dead constant — `packages/live-compare/src/gate3/config.ts` (~line 126)

**What changed:** removed `GATE3_BIG1K_BASELINE_SEED` (confirmed unused via
repo-wide grep — the only other hits were the pre-existing compiled
`dist/gate3/config.js`/`.d.ts`, not source). Removed rather than marked
reserved, per the instruction's stated preference.

**Test:** covered by the package build (`tsc -b`, clean) plus the full
targeted test run below; no dedicated test for a constant removal.

## 4. Shared `MAX_ADVANCE_ATTEMPTS` — `gate2.ts`, `kernel-child.ts`, `characterize.ts`

**What changed:** the identical `const MAX_ADVANCE_ATTEMPTS = 10` poll-loop
bound was defined independently in all three files. Exported one shared
`MAX_ADVANCE_ATTEMPTS = 10` from `packages/live-compare/src/gate1.ts` (all
three already import their deadline-budget constants from this file, so it's
the natural common module — no new file needed) and updated all three call
sites to import and consume it instead of their own local copy. Behavior is
unchanged (same value, same usage).

Files touched: `packages/live-compare/src/gate1.ts` (new export),
`packages/live-compare/src/gate2.ts` (`advanceUntilPublished`),
`packages/live-compare/src/gate3/kernel-child.ts` (`runOneMutation`),
`packages/live-compare/src/gate3/characterize.ts`.

**Test:** `pnpm --filter @strata-code/live-compare test gate2` — 12 passed.
Package rebuilt (`tsc -b`, clean) then `test gate3Child` — 5 passed (real
kernel-child/sqlite-child cold+warm runs against `examples/medium`, per the
instruction to confirm the kernel-child change with a real spawn). Also ran
`test gate3CharacterizeUnit` (pure-function suite, no daemon) — 8 passed —
since item 4 also touched `characterize.ts`; the daemon-spawning
`gate3Characterize.test.ts` was left un-rerun as it wasn't required and isn't
a child-spawning path item 4's edit could plausibly break (import + constant
relocation only).

## 5. Dup import — `packages/live-compare/tests/gate3Corpus.unit.test.ts` (~lines 14-15)

**What changed:** merged
```ts
import { buildCorpusInputs } from "../src/tasks.js";
import { createQualifiedKernelSnapshot } from "../src/tasks.js";
```
into one `import { buildCorpusInputs, createQualifiedKernelSnapshot } from "../src/tasks.js";`.

**Test:** `pnpm --filter @strata-code/live-compare test gate3Corpus` — 6
passed (includes the real 1012-module full-scale preflight).

## 6. corpus/mode cross-check guard — `packages/live-compare/src/gate3/schedule.ts` (`runBalancedSchedule`)

**What changed:** added two guards alongside the existing arm-label guard —
`runPair`'s returned `kernel`/`sqlite` samples now have their `corpus` and
`mode` fields checked against the `corpus`/`mode` the caller requested via
`opts`; a mismatch on either throws (`corpus` guard, `mode` guard), mirroring
the existing arm-mismatch throw style and message shape.

**Test:** added to `packages/live-compare/tests/gate3Schedule.test.ts`
("throws if runPair reports a corpus/mode that doesn't match what
runBalancedSchedule was asked to run") — two sub-cases (corpus mismatch,
mode mismatch), mirroring the existing arm-mismatch test's structure.

**Result:** `pnpm --filter @strata-code/live-compare test gate3Schedule` — 5
passed (includes the real balanced-schedule acceptance case against
`examples/medium`).

## 7. Reordered-trace test case — `packages/live-compare/tests/gate3Lifecycle.test.ts`

**What changed:** added a synthetic unit case feeding `lifecycleParity` a
same-length-but-reordered kernel trace (submit/advance swapped, still 4
calls) against the canonical sqlite sequence — asserts `{ kernel: 4, sqlite:
4, equal: false }`, protecting the order-sensitivity guarantee (count
equality alone must not pass).

**Test:** `pnpm --filter @strata-code/live-compare test gate3Lifecycle` — 4
passed (includes the real kernel/sqlite cold-run trace case).

## 8. Artifact-CI verdict recomputation — `packages/live-compare/tests/gate3Artifact.ci.test.ts`

**What changed:** added a new `it.skipIf(!ARTIFACT_EXISTS)` case that
recomputes `ratioVerdict` directly from the committed artifact's own
`coldPairs`/`warmPairs` (both `medium` and `big1k`), using the seed the
artifact itself records the schedule under (`GATE3_BOOTSTRAP_SEED` from
`config.ts` — confirmed by inspecting `run-big.ts`'s
`ratioVerdict(walls(pairs), GATE3_BOOTSTRAP_SEED)` call sites, which use the
same fixed bootstrap seed for every cold/warm call, not the per-schedule
`schedules.cold.seed`/`schedules.warm.seed`, which govern the AB/BA pairing
order instead), and asserts the recomputed `state` (and, going further than
strictly asked, the exact `ucb95`/`lcb95` values) equal the artifact's
recorded ones on all four (corpus, mode) combinations.

**This ran against the real committed artifact and PASSED** — no BLOCKED
condition. The committed verdict is bound to the committed samples: medium
cold/warm and big1k cold/warm all reproduce their recorded `FAIL` states
exactly.

**Test:** `pnpm --filter @strata-code/live-compare test gate3Artifact` — 3
tests, 1 skipped (the "artifact not yet generated" skip-message case, which
correctly does not run since the artifact exists), 2 passed (schema/marker
validation + the new recomputation case).

## 9. `decisiveRatioVerdict` fallback — `packages/live-compare/src/gate3/report.ts` (`renderGate3Markdown`, ~line 368)

**What changed:** when an overall `FAIL` is driven purely by a memory
verdict (no cold/warm ratio candidate on either corpus is itself `FAIL`),
`decisiveRatioVerdict`'s fallback (`candidates[0]`, since nothing matches
`report.verdict`) would silently pick an arbitrary non-failing ratio
candidate, and the banner would render its `lcb95` dressed up as "> 1.25" —
mislabeling a non-falsifying number as the falsifier. Added
`isMemoryDrivenFail(report)` (checks `report.verdict === "FAIL"` and no
cold/warm state across present corpora is `"FAIL"`) and branched
`renderGate3Markdown`'s banner: when true, it renders "driven by memory
verdict (no ratio candidate itself failed — see the Memory arm table(s)
below)" instead of calling into the mislabeled LCB path.

Verified against the real committed artifact: the actual gate-3 FAIL is
ratio-driven (cold/warm both `FAIL` on both corpora), so this fallback path
is NOT what produced the committed report's banner — this is a latent-bug
fix for a case that didn't fire this time, not a change to the recorded
verdict's rendering.

**Test:** added to `packages/live-compare/tests/gate3Report.unit.test.ts` — a
synthetic memory-only-FAIL fixture (cold/warm both `PASS`, only kernel memory
`FAIL`) asserts the banner contains "driven by memory verdict" and does NOT
contain the mislabeled "> 1.25" string.

**Result:** `pnpm --filter @strata-code/live-compare test gate3Report` — 22
passed.

## Full targeted run (final)

```
pnpm --filter @strata-code/live-compare build            # tsc -b, clean
pnpm --filter @strata-code/live-compare test \
  gate3RunBig gate3Artifact gate3Lifecycle gate3Report \
  gate3Stats gate3Corpus gate3Schedule
# 7 test files, 53 passed | 1 skipped (54)
pnpm --filter @strata-code/live-compare test gate2        # 12 passed
pnpm --filter @strata-code/live-compare test gate3Child   # 5 passed (real children)
pnpm --filter @strata-code/live-compare test gate3CharacterizeUnit  # 8 passed
```

Not re-run (per instructions, not required and no code path touched): the
pinned acceptance suite, `gate3Characterize.test.ts` (daemon-spawning,
not required), and any other child-spawning suite outside the above.

## Files changed

- `packages/live-compare/src/gate1.ts` — new shared `MAX_ADVANCE_ATTEMPTS`.
- `packages/live-compare/src/gate2.ts` — consumes shared constant.
- `packages/live-compare/src/gate3/characterize.ts` — consumes shared constant.
- `packages/live-compare/src/gate3/kernel-child.ts` — consumes shared constant.
- `packages/live-compare/src/gate3/config.ts` — removed dead
  `GATE3_BIG1K_BASELINE_SEED`.
- `packages/live-compare/src/gate3/run-big.ts` — cap-mask fix, honest
  comment, exported `memoryVerdictTolerant`, guarded `main()`.
- `packages/live-compare/src/gate3/report.ts` — honest memory-driven-FAIL
  banner fallback.
- `packages/live-compare/src/gate3/schedule.ts` — corpus/mode cross-check
  guard.
- `packages/live-compare/tests/gate3RunBig.unit.test.ts` (new) — item 1 tests.
- `packages/live-compare/tests/gate3Artifact.ci.test.ts` — item 8 test.
- `packages/live-compare/tests/gate3Corpus.unit.test.ts` — item 5 dedup.
- `packages/live-compare/tests/gate3Lifecycle.test.ts` — item 7 test.
- `packages/live-compare/tests/gate3Report.unit.test.ts` — item 9 test.
- `packages/live-compare/tests/gate3Schedule.test.ts` — item 6 tests.

## Skipped items

None. All 9 items applied and verified.
