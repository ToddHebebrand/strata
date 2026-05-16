# N=3 hardening round — pre-registration

*Pre-committed BEFORE the round, frozen. Classify from persisted substrate transcripts AFTER, per the project's discipline. Logged newest-first in `decisions.md` whatever the outcome. Round: `pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=3, on branch `feat/gate-scope-redesign`.*

## Purpose

Convert the N=1 observations from the 2026-05-16 keyed validation ("GS-1..GS-4 ALL PASS") into claim-grade evidence. This is a **replication/hardening** round, not a new lever. The harness is now valid (BG-4 fixed, task-scoped gate). No design change is in scope; no budget inflation (artifact-derived per-task budgets only; N=3 is the claim bar, do not escalate to N=5 without an explicit separate budget decision).

## Pre-committed bail signals (HN-1..HN-4)

- **HN-1 (T03 regression guard — HARD STOP).** In **every** trial, T03 substrate must be the canonical single clean rename transaction (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`), 0 unrelated `replace_body`, 1 transaction, metrics within the proven band (~1200–1473 tok / 6–11 tools / 24–30 s), still beating baseline. **Any single trial showing the BG-4 pattern (second transaction / unrelated collateral edit) ⇒ STOP** — the gate-scope fix is not robust; re-diagnose, do not proceed or claim.
- **HN-2 (T08 clean win replicates).** T08 substrate succeeds in a clean single transaction with only its own edits and separates from baseline. **3/3 = robust win; 2/3 = win with noted variance; ≤1/3 ⇒ the N=1 T08 win was noise — honestly downgrade the claim** (not a STOP).
- **HN-3 (T05 gate-driven success replicates).** T05 substrate reaches commit and succeeds via the scoped behavioral gate. **≥2/3 = the gate-driven T05 success is real; ≤1/3 ⇒ the N=1 T05 success was variance — report T05 as still effectively unrescued** (not a STOP; T05 was always the edge/control).
- **HN-4 (T01 stays isolated to a non-gate lever).** T01 continues to fail by **never reaching `commit_transaction`** (validate-thrash / `oldText mismatch` / wall-abort) in the majority of trials, confirming the gate is not its lever. **Any trial where T01 succeeds is recorded as informative variance at the 11-tool surface** (not a STOP — it would sharpen the model-capability question).

## Classification rules (frozen)

- Classify from the persisted substrate transcripts (`packages/bench/results/logs/*.jsonl`), not aggregate report inference, per the project standard. The aggregate "cross-task pattern" line remains a known definitional artifact and is not a signal here.
- Report per-task as a distribution (raw values, not just means), matching the proven-T03 reporting style.
- Honest-downgrade outcomes (HN-2 ≤1/3, HN-3 ≤1/3) are valid results to log, not failures to retry.
- No budget inflation, no prompt/tool/design change mid-round (any such need is a separate logged decision, not part of this round).
