# T01 stronger-model probe — pre-registration

*Pre-committed BEFORE the round, frozen. Classify from persisted transcripts AFTER, per project discipline. Logged newest-first in `decisions.md` whatever the outcome. Round: `pnpm --filter @strata/bench bench -- --trials=2 --tasks=T01,T03 --model=claude-opus-4-7 --keep-artifacts`, N=2, on a branch off `main` @ `d7d38c4`.*

## Purpose

T01 is the one remaining failing task, isolated (decisions.md 2026-05-16) to a **non-gate** lever: the agent never reaches a correct committed change — it hand-patches callsites with `replace_body` that collide with what `add_parameter` already queued, hitting `validate✗ oldText mismatch at [52,110)` repeatedly, then wall-aborts. Two candidate root levers were named: **(L1) model-capability ceiling** at the 11-tool multi-decision surface, or **(L2) `add_parameter` tool-illegibility** (the agent distrusts/doesn't understand the tool's callsite fan-out). Prompt tuning is already falsified (2026-05-15 BS-P-B terminal); the commit gate is closed and not the lever. This probe cheaply disambiguates L1 vs L2 by swapping **only the model** (`claude-sonnet-4-6` → `claude-opus-4-7`), holding tools/prompt/harness fixed, with **T03 as the regression guard**. N=2 (qualitative/mechanistic signal; not a distribution claim). Honest cost note: Opus is materially pricier per token and T01 walls long — projected ~$3–5, not the earlier "~$1" sonnet-framing estimate; N=2 bounds it. No budget inflation (artifact-derived per-task budgets: T01 40t/420000ms, T03 25t/240000ms).

## Pre-committed bail signals (MP-1..MP-3)

- **MP-1 (T03 regression guard under the swapped model).** In every trial, T03 substrate must remain the canonical single clean rename transaction (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 1 transaction, 0 unrelated `replace_body`, success). If T03 breaks or distorts under `claude-opus-4-7`, that is a **model/harness-interaction finding to surface explicitly** (the probe's T01 read is then confounded and must be reported as such) — not silently passed, not a project STOP.
- **MP-2 (the discriminating signal — L1 vs L2, pre-committed both ways).** Classified from T01 substrate transcripts:
  - If T01 reaches a **correct committed change** (`operationRowAppended` true AND T08-style task-criteria/text success) in **≥1 of 2** trials under Opus → the sonnet failure was **at least partly a model-capability ceiling (L1)**. The `add_parameter` redesign is then **not** the priority lever; a stronger model is the lever, and the honest framing becomes "the multi-step generalization gap narrows with model capability."
  - If T01 **fails in both** trials by **never reaching a correct committed change** → a stronger model does **not** rescue T01 → the failure is **tool-design (L2, `add_parameter` illegibility), not model capability**. The `add_parameter` legibility redesign is the warranted next lever (its own brainstorm→spec→plan→build cycle).
- **MP-3 (mechanism, not just outcome).** The L1/L2 call must be made from the transcript *mechanism*, not the aggregate success bar. Specifically: does Opus still hand-patch callsites with `replace_body` and hit `validate✗ oldText mismatch` (the *same* diagnosed collision thrash), or does it fail/succeed via a *different* path? A different failure mechanism under Opus is a **new finding to characterize on its own terms**, not assimilated to the sonnet diagnosis.

## Classification rules (frozen)

- Classify from the persisted substrate transcripts (`packages/bench/results/logs/*.jsonl`), not aggregate report inference.
- N=2 is a qualitative/mechanistic probe, explicitly **not** a distribution or significance claim; report raw per-trial.
- Both MP-2 outcomes are pre-committed and equally valid to log; neither is a "retry" trigger. No budget/model/tool/prompt change mid-probe.
- The probe answers *which lever* (L1 vs L2); it does **not** itself build either. Building is a separate, subsequent decision/cycle.
