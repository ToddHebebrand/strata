# Phase-6 live X/M retry results (2026-07-18)

**Purpose:** re-run the six-scenario live comparison after the
validation-circle narrowing (branch head e236895) to test the two things the
2026-07-17 pilot could not: (1) M under its recovered pre-amendment clause —
same-module concurrent publication with zero fresh decisions; (2) X's
content-rewriting fresh-decision path, whose pilot failure was a liveness
gap the `needs_decision`+`renamedSymbols` change was built to close.

**Setup:** executed from `.worktrees/phase6-live-comparison` at e236895
(the exact code that passed the full deterministic gate), operator approval
`approval-2026-07-17-xm-retry.json` (sourceCommit e236895, credential
ANTHROPIC_API_KEY), model `claude-sonnet-5`, seed `pilot-seed-1`, trials 1,
registered bounds (task 25t/240s/$0.75, integration 40t/420s/$4.00, team
900s), ceiling USD 55.00. Run `run-2026-07-18T03-57-27-079Z`. **Total
spend: USD 4.73.** The guard chain was validated key-free before launch
(every approval assertion passed; stopped only at the unset credential).

## Matched-trial results

| Scenario | Strata (cost / makespan) | Baseline (cost / makespan) | Cost ratio | Time ratio |
| --- | --- | --- | --- | --- |
| D (disjoint propagation) | $0.075 / 19s | $0.720 / 208s | 9.6× | 11.1× |
| M (same-module, original clause) | $0.073 / 17s | $0.723 / 182s | 9.9× | 10.4× |
| R (reference-mediated) | $0.096 / 45s | $0.739 / 185s | 7.7× | 4.1× |
| S (same-node overlap) | $0.130 / 44s | $0.682 / 173s | 5.3× | 3.9× |
| G (aggregate + disjoint) | $0.066 / 30s | $1.101 / 315s | 16.6× | 10.5× |
| X (dynamic expansion) | **$0.100 / 30s, green** | **failed** $0.226 / 456s | — | — |

**Strata: six for six.** Every Strata arm succeeded and verified green,
including both scenarios this retry existed to test:

- **M ran under the original (pre-amendment) clause** and published both
  same-module operations concurrently to one green tree in 17s — the live
  confirmation of the validation-circle narrowing's acceptance scenario.
- **X succeeded live for the first time.** X1's rename published at
  generation 1; X2 then completed the content-rewriting fresh-decision path
  (`UserTypes.displayUser` → `UserTypes.formatUser`) and published at
  generation 2, with the final tree matching the exact registered X allowed
  delta. `dynamic_scope_observed` — the claim the pilot explicitly could not
  support — is now supported at N=1. The pilot-isolated liveness gap
  (deriving the rewrite within bounds) is closed by the
  `needs_decision`+`renamedSymbols` protocol change.

**Baseline: five green, X failed again** — `invalid_final_code`,
`unexpected source change outside registered normalized delta:
src/users/serializer.ts`. This is the same elaboration-class over-delivery
the pilot documented (its fourth occurrence across the pilot and this
retry): a file-tools agent wiring behavior beyond the registered delta, a
failure class Strata's typed operations are structurally incapable of.

## Claims supported

Two independent live agents reached one shared, externally verified green
codebase through the Strata service in **six of six** scenarios, with no
correctness, authority, or liveness failure in any Strata arm. Observed
paired differences favor Strata 5.3–16.6× on cost and 3.9–11.1× on makespan
**under this exact model, prompts, bounds, corpus, seed, and machine, at
N=1 per scenario**. No prevalence, generality, or population-level claim is
made. The X comparison supports no paired ratio (baseline failed); it
supports the Strata-side liveness claim only.

## Relation to the stable-root fix

This round ran at e236895 with the pre-fix approval digests — the worktree
is the only place those digests reproduce. Any future round runs from main
(5872bbf or later) and needs a fresh approval file with the stable-root
registration digest (`628bd6da…`); see decisions.md 2026-07-17
(stable-root entry).
