# Review brief: bridge-optimization slice (post gate-3 FAIL) — independent design review

**To the reviewer:** you are reviewing a PROPOSED next research slice for Strata's
multi-agent coordination kernel, before any design is committed. Be adversarial:
your job is to find the flaw in the diagnosis, the cost model, or the candidate
designs — or to surface a better lever inside the hard constraints. Repo-grounded
claims beat plausible prose; cite file:line for anything load-bearing.

## Context (read first)

- `decisions.md` — top two entries (2026-07-22): gate-3 FAIL / falsifier-5
  recording with the full measured table, mechanism, and disclosures.
- `docs/spikes/gate3-noninferiority-profile.md` — the committed measurement
  artifact (provenance-bound).
- `docs/spikes/gate2-observability-profile.md` — per-stage server costs.
- `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`
  — the kernel design; §semantic boundary.
- `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md`
  — the gate map (gates 1-2 PASS, gate 3 FAIL recorded in-file).
- Bridge implementation: `crates/strata-kernel/src/bridge/` (worker spawn,
  `process.rs` frame limits), `packages/kernel-bridge/` (the Node worker:
  hydrate → render → tsc validate), `packages/live-compare/src/gate3/` (the
  measurement harness — reusable as the acceptance oracle).

## Diagnosis (measured, not hypothesized)

Gate 3 (unkeyed noninferiority, p95 mutation wall, kernel `submit+advance` vs
SQLite in-process `validate+commit`, 1.25× contract, paired bootstrap):

| corpus | mode | p95 kernel | p95 sqlite | ratio | lcb95 |
|---|---|---|---|---|---|
| medium (22 mod) | cold | 2360 ms | 558 ms | 4.23 | 3.92 |
| medium | warm | 2236 ms | 677 ms | 3.30 | 3.21 |
| big1k (1012 mod) | cold | 24528 ms | 2003 ms | 12.25 | 12.15 |
| big1k | warm | 25032 ms | 1942 ms | 12.89 | 12.89 |

Server characterization (metrics-on): medium submit p95 634 ms / advance p95
1559 ms; big1k submit p95 8982 ms / advance p95 17386 ms. Worker peak RSS
508 MB at big1k. Kernel snapshot ~11 MB serialized at 1012 modules.

Mechanism: per candidate validation the daemon spawns a FRESH Node bridge
worker, serializes the FULL kernel snapshot into the request frame, the worker
hydrates it into a `:memory:` SQLite mirror, renders, runs one tsc pass,
responds, dies. Every component of that fixed cost (serialize, spawn, hydrate)
scales with corpus size — so scale made the ratio worse (4× → 12×), falsifying
the amortization theory. The kernel runs FEWER tsc passes than the SQLite arm
(1 vs 2) and still loses 4-13×. The coordination semantics themselves passed
gates 1 (determinism/crash/parity, 21/21) and 2 (observability).

## Hard constraints (violating any of these disqualifies a candidate)

1. Clients never open canonical storage; canonical state lives in redb behind
   the daemon. Node workers must NOT mutate canonical storage.
2. TypeScript semantics (render, tsc validation) stay in Node. No moving TS
   semantics into Rust.
3. Validation is never bypassed or weakened; a candidate must be validated
   before publication exactly as today.
4. Agent-visible protocol and lifecycle unchanged: same 4 lifecycle calls, no
   extra agent-visible calls, no digest/audit-journal changes.
5. Deterministic, key-free gates before any keyed spend. The acceptance oracle
   for this slice is the EXISTING gate-3 harness re-run unchanged (same
   thresholds, windows, N, seeds, corpora): PASS requires UCB95 ≤ 1.25 on both
   corpora. No threshold changes, ever.
6. Gate-1 invariants (crash-recovery, restart replay, FIFO-per-resource,
   concurrency parity) must remain green with the new bridge.
7. The SQLite product path remains supported unchanged.

## Falsified levers (do not re-propose)

- Full-snapshot-per-call worker architecture at scale (measured as the cost).
- Anything crossing the semantic boundary (see constraints 1-4).
- Re-running measurements hoping for different numbers; weakening gates.

## Candidate designs (pressure-test these; propose better if you see it)

**A. Persistent pooled worker + generation-tagged delta feed (primary).**
Daemon keeps 1..N long-lived Node workers. Each worker holds a hydrated SQLite
mirror at a known published generation G. On candidate validation for a change
set built on generation G_base: daemon sends only the delta (changed
node/edge records since the worker's G) + the candidate ops; worker applies
delta to its mirror, renders + validates, returns. Worker crash or delta gap →
respawn via today's full-snapshot path (which stays as fallback and is already
proven). Divergence protection: worker replies include a mirror digest the
daemon can spot-check against redb's canonical digest (cheap, probabilistic
or per-K-calls).
Projected p95 at big1k: IPC (small delta) + delta apply (ms) + render subset +
1 tsc (~0.9-2 s measured in-process for 1012 modules) + redb publish — i.e.
plausibly ≤ SQLite's 2-tsc ~2 s window. The remaining asymmetry is IPC + delta
apply vs the SQLite arm's second tsc.

**B. Warm worker, full snapshot per call (increment of A, fallback position).**
Removes spawn only; serialize+hydrate remain (~9-17 s at 1k). Predicted
insufficient alone at scale — but cheap to build first as A's skeleton and
gives a clean ablation measurement.

**C. tsc incremental-program reuse inside a persistent worker (stretch).**
Same tsc semantics, but reuse the ts.Program/builder across candidate
validations in the warm worker. Risk: stale-program correctness; must be
behind the same validation oracle. Only worth it if A alone doesn't reach
1.25× — note the SQLite arm deliberately gets NO incremental caching in the
gate (fresh Program per validate, `validate.ts:92`), so giving the kernel
worker incremental reuse changes the fairness framing — flag how the gate
should treat this (candidate C may belong OUTSIDE the noninferiority gate's
symmetric-window rules; adjudicate).

**D. Anything we missed inside the constraints** — e.g. snapshot mmap/shared
memory transport, binary (non-JSON) delta encoding, render-only-changed-
modules with cached rendered text for unchanged modules (rendered-text cache
keyed by node digest), skipping re-render of unchanged modules in the worker.
Evaluate render cost share before endorsing.

## Questions for the reviewer

1. Is candidate A sound against the coordination semantics — generation
   tagging vs claim/publication ordering, FIFO-per-resource, crash-recovery
   replay (gate-1 invariants)? What is the sharpest failure story (worker
   mirror divergence, delta gap across a crash, publication racing a stale
   validation)? Cite the actual scheduler/publication code paths.
2. Is the cost model credible from the repo's own measurements? Specifically:
   what does the big1k advance p95 (17.4 s) decompose into per the gate-2/3
   characterization records, and does removing spawn+serialize+hydrate
   plausibly land ≤ 1.25× vs the SQLite 2-tsc window (~2 s)? Identify the
   largest residual cost A does not remove.
3. Where exactly does the ~9 s big1k submit p95 come from (submit should not
   validate)? If it is snapshot-serialize on the submit path, does A remove it
   or does submit need its own fix? Cite code.
4. What is the smallest honest gate structure for this slice? (Proposal:
   deterministic worker-pool unit gates + delta-correctness oracle vs
   full-snapshot shadow validation on a sampled subset + re-run the unchanged
   gate-3 harness as the exit gate.)
5. Which candidate order minimizes wasted work if the thesis fails again
   (B-then-A ablation vs A-direct)?
6. What did we miss — a better lever inside the constraints, or a reason this
   slice is not worth running at all (i.e. accept the SQLite-authority split
   now)?

## Output format

Numbered findings; for each: verdict (sound / flawed / needs-evidence), the
evidence (file:line), and what you'd change. End with: (a) your recommended
candidate + build order, (b) the top 3 risks, (c) any pivotal empirical claim
in this brief you believe is WRONG (say so plainly).
