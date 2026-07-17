# Phase-6 live pilot results (rounds 1–6, 2026-07-17)

**Model:** `claude-sonnet-5` (operator-selected). **Seed:** `pilot-seed-1`.
**Bounds:** registered task 25t/240s/$0.75, integration 40t/420s/$4.00, team
900s. **Total spend across all six rounds: USD 9.40** against a USD 55.00
per-round ceiling. Approvals, per-round manifests, and stop records are in
`decisions.md` (six 2026-07-17 entries); artifacts are immutable under
`packages/live-compare/results/run-*`.

## Matched-trial results (round 6, `run-2026-07-17T05-43-24-572Z`)

| Scenario | Strata (cost / makespan) | Baseline (cost / makespan) | Cost ratio | Time ratio |
| --- | --- | --- | --- | --- |
| D (disjoint propagation) | $0.057 / 30s | $0.823 / 246s | 14.4× | 8.2× |
| M (same-module, amended) | $0.105 / 62s | $0.475 / 314s | 4.5× | 5.1× |
| R (reference-mediated) | $0.085 / 83s | $0.422 / 355s | 5.0× | 4.3× |
| S (same-node overlap) | $0.085 / 39s | $0.538 / 202s | 6.3× | 5.2× |
| G (aggregate + disjoint) | $0.060 / 90s | $0.319 / 531s | 5.3× | 5.9× |
| X (dynamic expansion) | **failed** $0.234 / 128s | **failed** $0.719 / 360s | — | — |

Five of six matched trials completed with both arms green; Strata won every
completed comparison on both primary metrics. D — the bulk-propagation hero
case — showed the largest margin, exactly as the historical single-agent
taxonomy predicted. Earlier rounds' completed arms (four additional Strata S
successes at $0.084–$0.134, S/R baseline completions) are consistent.

## The X failure, both arms

- **Strata:** X1's rename published (generation 1); X2 never published. X is
  the only flow whose fresh decision requires *rewriting the intent content*
  (`UserTypes.displayUser(user)` → `UserTypes.formatUser(user)`); R/S
  resubmit byte-identical intents and passed live, but the X2 session could
  not derive the rewrite within bounds. The deterministic X gate passed with
  scripted choreography; live protocol usability of content-rewriting fresh
  decisions is a real, now-isolated gap (candidates: name the current symbol
  in the `needs_decision` context; sharpen the system prompt's fresh-decision
  guidance).
- **Baseline:** over-delivery beyond the registered delta in serializer.ts —
  its third elaboration-class failure.

## Baseline failure modes observed across rounds (all preserved as evidence)

1. Fixing the corpus's intentionally red historical test (rounds 2, 4 —
   induced; prompts now disclose the trap).
2. Spec over-delivery: wiring an added parameter into behavior (round 5 R;
   round 6 X). Structurally inexpressible in Strata's typed operations.

## Harness defects found and fixed by live rounds (each with a regression row)

worktree `.git` pointer files (round 1); lockfile install exhaust (round 3);
verifier-error observability (rounds 1–2); a stale approval digest correctly
refused by the guard at zero cost (round 5); the arm-scoped dispositive stop
amendment (post round 5, operator-approved).

## Claims supported (per the design's claims section)

Two independent live agents reached one shared, externally verified green
codebase through the Strata service in five of six scenarios, with no
correctness or authority failure in any Strata arm across eleven live arms
(the X failure was a liveness/usability failure — no publication — not a
correctness one). Observed paired differences favor Strata 4–14× on cost and
4–8× on makespan **under this exact model, prompts, bounds, corpus, seed, and
machine, at N=1 per scenario**. `dynamic_scope_observed` was not achieved
live; X supports no live claim. No prevalence, generality, or
population-level claim is made.
