# Phase-6 N=3 directional extension results (2026-07-18)

**Purpose:** execute the pre-registered N=3 directional extension
(`docs/superpowers/specs/2026-07-18-phase-6-n3-directional-extension-design.md`):
repeat the six-scenario live comparison at three trials per scenario and
score each scenario × metric with the pre-registered sign taxonomy, where
"N=3 directional consistency" is reserved for the exact pattern `+++`.

**Setup:** executed from main at 752818f (clean tree), operator approval
`approval-2026-07-18-n3-directional.json` (sourceCommit 752818f, source
digest 41c9059a…, registration digest 628bd6da…, credential
ANTHROPIC_API_KEY), model `claude-sonnet-5`, seed `pilot-seed-1`, trials 3,
registered bounds (task 25t/240s/$0.75, integration 40t/420s/$4.00, team
900s), ceiling USD 130.00. Key-free dry-run passed immediately before
launch (90 planned sessions across 18 matched trials, summed budgets USD
126.00). Scored run: `run-2026-07-18T08-53-01-703Z`, exit 0. **Total
spend: USD 9.99.**

## Execution provenance — two externally killed attempts precede the scored round

The design pre-registers "no re-runs." This round nevertheless took three
launches, and that must be read with the following facts:

- Attempts 1 (`run-2026-07-18T07-19-12-687Z`) and 2
  (`run-2026-07-18T08-07-39-116Z`) were killed by the operator's terminal
  environment (the Claude Code session runs under a supervisor that was
  observed killing the session's background processes; a canary process
  launched the same way was killed within a minute while a
  `setsid`-detached sibling survived). Neither kill was a harness stop:
  no guard tripped, no budget threshold was reached, and the processes
  died mid-worktree-setup with no error output. Attempt 3 was launched
  fully detached and completed.
- The relaunches were not result-dependent: the interim metric values
  were not inspected before either relaunch decision, only trial
  completion states. Seed, bounds, approval, corpus, and code were
  byte-identical across all three attempts.
- For transparency, the killed partials' evaluable pairs are scored in
  the same taxonomy: 13 evaluable pairs across both partials (7 and 6),
  **all `+` on cost and `+` on makespan**; every partial X and G/R
  incompleteness was a baseline-side failure or an unfinished baseline
  arm at kill time, never a Strata failure. The partial records remain on
  disk unmodified. The scored claims below use only the completed round.
- Combined spend on the two killed partials: ~USD 13 (real, disclosed,
  outside the scored round's USD 9.99).

## Pre-registered sign taxonomy results (scored round only)

| Scenario | Cost signs | Makespan signs | Directional consistency |
| --- | --- | --- | --- |
| D (disjoint propagation) | `+++` | `+++` | **yes, both metrics** |
| G (aggregate + disjoint) | `+++` | `+++` | **yes, both metrics** |
| M (same-module) | `+++` | `+++` | **yes, both metrics** |
| R (reference-mediated) | `+++` | `+++` | **yes, both metrics** |
| S (same-node overlap) | `+++` | `+++` | **yes, both metrics** |
| X (dynamic expansion) | missing ×3 | missing ×3 | not evaluable (0 pairs) |

No `−` and no `0` occurred in any evaluable cell. Per-pair raw ratios
(baseline/Strata, descriptive only, no pooling):

| Scenario | Cost ratios (r1, r2, r3) | Makespan ratios (r1, r2, r3) |
| --- | --- | --- |
| D | 9.7×, 6.5×, 10.6× | 9.7×, 9.6×, 9.7× |
| G | 6.5×, 4.7×, 7.1× | 19.2×, 17.3×, 25.6× |
| M | 2.5×, 5.6×, 8.1× | 22.9×, 7.6×, 8.9× |
| R | 3.8×, 4.1×, 10.7× | 5.2×, 14.5×, 8.3× |
| S | 5.0×, 6.1×, 4.7× | 4.6×, 5.4×, 4.6× |

## Secondary endpoints

- **Strata reliability: 18/18 arms green** (this round, reported
  separately from the pilot/retry 16/17 tally per the registered
  provenance rule — the registered prompt changed between pilot and
  retry; this round replicates the retry configuration).
- **X liveness replication: 3/3.** All three X Strata arms completed the
  content-rewriting fresh-decision path and verified green. The retry's
  N=1 `dynamic_scope_observed` result is now observed at N=4 total
  (retry + three here) under the retry protocol.
- **Baseline X: 0/3**, all `invalid_final_code` (source change outside
  the registered normalized delta) — the same elaboration-class
  over-delivery the pilot and retry documented, now at seven occurrences
  across pilot, retry, and this round (including both killed partials'
  X-r1 arms makes nine). Per the design, X contributes zero pairs to the
  directional claim and the baseline failure count is itself the
  registered observation.

## Claims supported

Under this exact model, prompts, bounds, corpus, seed, and machine, the
five evaluable scenarios show **N=3 directional consistency on both cost
and makespan** — the exact `+++` pattern in every evaluable cell, with no
reversal and no tie anywhere in the round. Strata arms were 18/18 green.
X remains a Strata-side liveness win with an unpaired baseline failure
mode. No effect-size, significance, prevalence, or generality claim is
made; the parent design's limits carry over wholesale.
