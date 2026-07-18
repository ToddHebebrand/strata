# Phase-6 N=3 directional extension — design

**Status:** independent review complete — Codex `gpt-5.6-sol` (xhigh,
read-only, repo-grounded) returned GO-WITH-AMENDMENTS; all five amendments
are folded in below (each verified against the code before adoption). Live
execution requires a fresh operator approval file minted from main.

## The falsifiable question

The pilot (2026-07-17, N=1 per scenario) and the post-narrowing retry
(2026-07-18, N=1, six for six) observed Strata ahead on every completed
paired comparison — 4.5–16.6× on model cost and 3.9–11.1× on makespan. Both
rounds are single samples per scenario. The question this extension asks:

> Under identical model, prompts, bounds, corpus, and seed, does the
> **direction** of the paired cost and makespan differences hold across
> three fresh matched repetitions per scenario, or was N=1 favorable
> variance?

This is a directional-consistency question, not an effect-size estimate.
N=3 cannot support magnitudes, confidence intervals, or population claims,
and this design pre-registers that it will not try.

**Selection and provenance disclosure (review amendment).** This extension
was chosen after two rounds of unblinded favorable N=1 results; it is a
prospectively specified follow-up, not an independent confirmatory
experiment. Its configuration freezes the current post-narrowing/retry
state — which is *not* byte-identical to the original pilot: the registered
Strata system prompt gained the `renamedSymbols` fresh-decision guidance
after the pilot (commit 4dd020d), so this round replicates the **retry**
configuration. Prior pilot/retry observations are not pooled into the N=3
tally. The primary output is twelve descriptive cells (six scenarios × two
metrics); there is no omnibus success test, no multiplicity-adjusted
inference, and no family-wide claim.

## What is already settled (do not re-litigate in review)

- The harness natively supports repetition: `createSchedule` produces
  `trialsPerScenario` repetitions with a per-repetition scenario reshuffle,
  arm-order alternation against the pilot assignment (repetition 1 = pilot
  order, repetition 2 = flipped, repetition 3 = pilot), and a fixed
  per-scenario task→process mapping. `--trials=3` requires zero harness
  changes: the key-free dry-run already passes (90 planned sessions, 18
  matched trials, USD 126.00 summed per-query budgets).
- The stop rule stays the operator-amended arm-scoped form (decisions.md
  2026-07-17): only a Strata-arm dispositive failure halts the round; a
  baseline dispositive failure marks its matched trial failed and the round
  continues. This is load-bearing for N=3 — the pilot showed the baseline
  X arm fails dispositively, and a symmetric stop would end the round at
  the first X trial.
- The X liveness gap is closed (2026-07-18 retry) and the stable-root
  ingest landed (main 5872bbf); qualification digests are
  location-independent.

## Method

One approved round, executed from main, with the registered retry
configuration (see the provenance disclosure above) except trial count and
ceiling:

| Parameter | Value | Same as pilot/retry? |
| --- | --- | --- |
| Model | `claude-sonnet-5` | yes |
| Seed | `pilot-seed-1` | yes — see below |
| Trials per scenario | **3** | was 1 |
| Task bounds | 25t / 240s / $0.75 | yes |
| Integration bounds | 40t / 420s / $4.00 | yes |
| Team wall | 900s | yes |
| Projected max | **USD 130.00** | was 55 — scales with 90 sessions |
| Corpus | `x-namespace-enriched-v1` | yes |
| Task set | D, M, R, S, X, G | yes |

**Seed stays `pilot-seed-1`.** Choosing a new seed after seeing two rounds
of results invites seed-shopping; the registered seed is the conservative,
continuity-preserving choice, and the schedule already varies across
repetitions by construction (per-repetition shuffle + arm alternation).
Repetition 1's schedule coincides with the retry round's schedule; its
trials are still fresh live samples.

**Spend (review amendment — enforcement semantics).** Summed per-query
budgets are USD 126.00 (72 task sessions × $0.75 + 18 integration sessions
× $4.00); exact exhaustion of every session totals 126, and `planRound`
rejects any projected maximum below that sum. The approved projected
maximum is **USD 130 — a $4 reserve above the sum, and a between-arms stop
threshold, not a hard billing ceiling**: the orchestrator checks accumulated
cost before launching the next arm, so the arm in flight can overshoot by
up to its own per-session budgets (the parent design § accounting carries
the same disclosure). Expected ~USD 15, from USD 4.73 observed for the
identical six-trial round. Expected wall-clock ~90 minutes (28.5 minutes
observed for six trials, arms sequential within a trial).

## Pre-registered analysis

Each scenario × metric (cost, makespan) trial is scored with a
pre-registered sign taxonomy (review amendment — no vacuous consistency):

- `+` — both arms green, Strata strictly lower;
- `0` — both arms green, tie;
- `−` — both arms green, baseline strictly lower;
- `missing` — one or both arms not green or unattempted; the arm statuses
  and failure-taxonomy values are recorded in place of a sign.

1. **Directional consistency (primary).** "N=3 directional consistency"
   for a scenario/metric is reserved for the exact pattern `+++`. A `−`
   falsifies it; a `0` breaks the strict criterion without being a
   reversal; patterns with missing trials are reported as "consistent
   among k evaluable pairs; incomplete at N=3" (and 0 evaluable pairs is
   "not evaluable", never "consistent"). Report the full sign pattern per
   scenario/metric. No pooling across scenarios; no means of ratios;
   per-pair ratios are reported as raw descriptive distributions exactly
   as the bench convention requires.
2. **Strata reliability count (secondary).** Strata arms green / attempted,
   with the failure taxonomy breakdown for any non-green arm. Historical
   context (review amendment — corrected tally): the pilot's eleven live
   Strata arms had one failure (X liveness) and the retry's six had none —
   16/17 green. This round's up-to-18 Strata arms are reported separately,
   not pooled, because the registered prompt changed between pilot and
   retry.
3. **X liveness replication (secondary).** X contributes Strata-side
   publication replication (k/3 X Strata arms green with the fresh-decision
   rewrite). If the baseline X arm keeps failing its elaboration-class
   pattern, X contributes zero pairs to (1) and that is reported as-is —
   the baseline failure count is itself a pre-registered observation, not
   a nuisance.
4. **No result-dependent action.** No re-runs, no seed changes, no bound
   changes mid-round. A Strata-arm dispositive stop ends the round; the
   partial record publishes with the stop reason, exactly as the pilot's
   rounds did.

**What would falsify the directional claim:** a `−` in any scenario/metric
cell — a completed pair where the baseline arm is strictly cheaper (or
strictly faster) than the Strata arm. One `−` breaks that cell's `+++`;
a `0` breaks strict consistency without being a reversal; both publish
either way, as does any incomplete pattern.

## Claims this round can and cannot support

**Can:** per-scenario directional consistency at N≤3 under this exact
configuration; Strata-arm reliability counts; X liveness replication.
**Cannot:** effect sizes, statistical significance, generality across
models/repos/prompts, production reliability, anything the parent design's
"cannot support" list already excludes. This section inherits the parent
design (`2026-07-16-phase-6-live-comparison-design.md`) wholesale.

## Approval requirements (operator gate)

A fresh approval file minted from main HEAD at launch time. The guard
asserts **every** field below by `JSON.stringify` equality (review
amendment — exact schema; bound-object key order and task-set order must
match):

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "taskSet": ["D", "M", "R", "S", "X", "G"],
  "corpusVariant": "x-namespace-enriched-v1",
  "trials": 3,
  "seed": "pilot-seed-1",
  "taskRoleBounds": { "maxTurns": 25, "wallTimeMs": 240000, "maxBudgetUsd": 0.75 },
  "integrationRoleBounds": { "maxTurns": 40, "wallTimeMs": 420000, "maxBudgetUsd": 4 },
  "teamWallMs": 900000,
  "projectedMaxUsd": 130,
  "sourceCommit": "<clean main HEAD at launch>",
  "sourceDigest": "41c9059a91e814995471708fa3cd165dc15a1f45f492b809d01831978b3c6eb8",
  "taskRegistrationDigest": "628bd6dabedc2e99b09375bb3b05da1663e6c25f86933113fd64497c1a140233",
  "verifierDigest": "<computed at mint time>",
  "credentialSource": "ANTHROPIC_API_KEY"
}
```

Notes: `sourceDigest` is content-only and unchanged; the registration
digest is the stable-root value; `verifierDigest` hashes the sorted
`packages/live-compare/src/*.ts` **sources** (not built JavaScript) and
changed with the stable-root fix — compute it at mint time, never copy it
from the retry approval. The other credential source must be unset. The
key-free dry-run and the guard-chain validation (run command without
credentials, expecting the credential-source refusal as the only failure)
both run before the operator signs.

## Execution and artifacts

`node packages/live-compare/dist/cli.js run --model=claude-sonnet-5
--trials=3 ... --projected-max-usd=130.00 --seed=pilot-seed-1
--approval=<path> --execute-live` from the main checkout. Artifacts land
immutable under `packages/live-compare/results/run-*` as before; results
doc under `docs/spikes/`; decisions.md entry closes the round either way.

## Non-goals

No new scenarios, no corpus changes, no prompt changes, no bound tuning,
no structural insert/delete/move concurrency, no multi-host anything. If a
harness defect surfaces mid-round, the round stops, the defect is fixed
with a regression row, and the *next* round gets a fresh approval — the
pilot's precedent.
