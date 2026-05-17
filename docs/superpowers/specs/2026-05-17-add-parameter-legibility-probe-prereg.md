# `add_parameter` legibility — keyed validation pre-registration

*Pre-committed BEFORE the round, frozen and tamper-evident. Classify from persisted transcripts AFTER, per project discipline. Logged newest-first in `decisions.md` whatever the outcome. Spec: `docs/superpowers/specs/2026-05-17-add-parameter-legibility-design.md` (merged to `main` @ 643e953). Round run from a branch whose code is identical to `main` @ 643e953.*

## Round shape (frozen)

`pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T03 --keep-artifacts`
- Model: `claude-sonnet-4-6` (the model the benchmark's claims are on; model-capability already isolated out by the 2026-05-17 Opus probe — this round measures the manifest's effect, holding the model fixed).
- N = 3 (the project's claim bar, matching the N=3 hardening).
- Tasks: `T01` (the lever's target) + `T03` (the regression guard).
- Artifact-derived per-task budgets: T01 `40t/420000ms`, T03 `25t/240000ms`. `--keep-artifacts` (substrate transcripts persisted for classification).
- Single changed variable vs. all prior T01 rounds: the `add_parameter` tool now returns/surfaces the `AddParameterManifest`; the tool **description is byte-identical** (deliberate control). No prompt/gate/model/budget change.
- Honest cost note: T01 walls long; projected ~$3–5.

## Pre-committed bail signals (AP-1..AP-4) — frozen

- **AP-1 (T03 regression guard — HARD STOP).** In every trial, T03 substrate must be the canonical single clean rename (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 1 transaction, 0 unrelated `replace_body`, success, metrics within the proven band ~1200–1473 tok / 6–11 tools / 24–30 s). The change is `add_parameter`-return-only and T03 never calls `add_parameter`; therefore **any** T03 movement (a second transaction, unrelated collateral, success regression) indicates unexpected coupling ⇒ **STOP, do not interpret T01.**
- **AP-2 (does the manifest move T01) — both outcomes pre-committed.** Classified from the persisted substrate transcripts (not aggregate inference):
  - T01 substrate reaches a **correct committed change** (`operationRowAppended` true AND T01 task-criteria `success`) in **≥1 of 3** trials ⇒ **the manifest is effective** (legibility was the lever; the file-abstraction multi-step gap is narrowed by tool legibility).
  - T01 substrate still **0/3, never reaching a correct committed change** ⇒ **the manifest did not move T01** — an honest, valid logged negative (a believable itemized manifest of the tool's own edits is insufficient; the residual lever is deeper than tool-result legibility). Not a retry trigger.
- **AP-3 (mechanism — the real readout regardless of AP-2).** From the transcripts: does the agent still hand-patch callsites with `replace_body` after `add_parameter` and hit the `oldText mismatch` collision (the diagnosed thrash), or does the presence of the itemized manifest cause it to stop hand-patching and proceed `validate → commit`? The behavioral change (or its absence) is characterized even if T01 still fails for another reason. A *different* failure mechanism under the manifest is a new finding characterized on its own terms, not assimilated to the prior diagnosis.
- **AP-4 (no scripting / contamination — integrity).** Confirm from the artifacts that the manifest carried only what `add_parameter` itself did (declaration + its own callsite edits + arity-risk sites — no task hints, no directive prose); any T01 win is the agent declining to hand-patch given verifiable evidence, not the harness performing the task. The `add_parameter` description must remain byte-identical to base (the control); confirm it was not altered for the round.

## Classification rules (frozen)

- Classify from the persisted substrate transcripts (`packages/bench/results/logs/*.jsonl`), not aggregate report inference.
- Report per-trial raw values; N=3 is the claim bar but separations are observed, not significance claims.
- Both AP-2 outcomes are equally valid to log; an honest negative is a result, not a failure to retry. No budget/description/prompt/model change mid-round or to "rescue" a negative.
- The finding is logged as its own newest-first `decisions.md` entry whatever it shows, referencing this frozen pre-reg's commit.
