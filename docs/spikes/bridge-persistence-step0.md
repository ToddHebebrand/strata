# Bridge-persistence slice — step-0 stage decomposition (big1k, N=1, metrics-on)

**Date:** 2026-07-23. **Chartered by:**
`docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md` ("Step 0
— diagnostic experiment"). **Driver:**
`packages/live-compare/src/gate3/step0-stage-decomposition.ts` (reads only what
`--metrics` already emits — no new instrumentation). **Raw artifact:**
`docs/spikes/bridge-persistence-step0/{metrics.jsonl,summary.json}` (debug
binary, the gate-3 parity configuration). A release-binary comparison run was
also performed; its raw artifacts are committed at
`docs/spikes/bridge-persistence-step0/release/{metrics.jsonl,summary.json}`.

Metrics-on runs never feed a timing verdict (gate-3 B1); this diagnostic feeds
the bridge-persistence implementation plan only.

## Tie-out to gate 3

One N=1 debug-binary mutation reproduces the recorded gate-3 characterization
almost exactly (gate-3 `server` p95: submit 8.98 s, advance 17.39 s):

| | this run (debug) | gate-3 recorded p95 |
|---|---|---|
| submit_change_set wall | 8.99 s | 8.98 s |
| advance_change_set wall | 17.29 s | 17.39 s |

So this single window is representative of the regime gate 3 FAILed in.
Allowance context: gate-3 big1k SQLite p95 ≈ 2.0 s → 1.25× allowance ≈ 2.5 s;
medium allowance ≈ 0.70–0.85 s.

## Headline decomposition (big1k, 1012 modules, one rename mutation)

Six worker trips per mutation, confirmed (submit: `submitAnalysis` +
`unattributed`; advance: `claimAnalysis`, `preCandidateAnalysis`, `candidate`,
`postCandidateAnalysis`).

| component | debug | release |
|---|---|---|
| **total mutation window** (submit + publishing advance) | **26.33 s** | **14.13 s** |
| six bridge-trip walls, summed (`bridgeWallNs`) | 5.72 s | 5.92 s |
| daemon-side coordination residual (wall − trips) | **20.61 s** | **8.21 s** |
| — submit residual (2 trips) | 7.51 s | 3.16 s |
| — advance residual (4 trips) | 13.04 s | 4.98 s |
| worker hydrate, summed (6 trips) | 1.89 s | 1.95 s |
| worker analyze, summed (5 analysis trips) | 0.56 s | 0.49 s |
| worker validate (candidate trip) | 1.10 s | 1.27 s |
| worker export (candidate trip) | 0.17 s | 0.17 s |
| daemon ingest+seed+ready (out-of-window) | 4.12 s | 2.43 s |

Per analysis trip (release): bridge ≈ 0.74 s = snapshotBuild 0.06 + serialize
0.05 + spawn/transport ≈ 0.11 + worker total ≈ 0.53 (hydrate ≈ 0.32, analyze
≈ 0.10). The candidate trip: bridge 2.19 s, dominated by worker validate
(1.27 s render+tsc) + hydrate (0.33 s) + export (0.17 s).

## Finding 1 — the review's per-trip cost is real but mostly OUTSIDE the bridge wall

The chartered spec (from the independent review) modeled the big1k cost as six
~4.4 s worker trips. The measured bridge walls are ~0.72–0.77 s per analysis
trip (~2.2 s candidate). The remaining ~3.4 s per trip (debug) sits in the
**daemon**, between/around the bridge calls: submit residual 7.5 s over 2
trips, advance residual 13.0 s over 4 trips. The `publication` stage timers
confirm it phase-by-phase: e.g. debug `preCandidateAnalysis` phase = 4.63 s
against a contained bridge trip of only 0.77 s.

Consequence for the slice: a persistent worker that eliminates only
Node-side per-trip work (spawn + hydrate + snapshot deserialize) removes
~2–4 s of a 26 s (debug) / 14 s (release) window. The slice's viability
depends on the daemon-side residual ALSO being per-trip snapshot mechanics
(construction/serialization of the 10.5 MiB snapshot per trip) — see
Finding 3.

## Finding 2 — roughly half the gate-3 FAIL magnitude is an unoptimized-binary artifact

`kernelServiceBinary()` defaults to `target/debug` and the `kernel:gate3:big`
script builds without `--release`, so gate 3 measured an **unoptimized** Rust
daemon against a production-grade SQLite arm (better-sqlite3 native release +
Node). The same N=1 window on `target/release`: 26.33 s → 14.13 s (submit
8.99 → 4.70, advance 17.29 → 9.35). Worker-trip (Node-side) time is unchanged;
the daemon residual drops 20.6 → 8.2 s and snapshotBuild/serialize drop
~10×/~10× (0.29→0.06, 0.50→0.05 s per trip).

Implication (not a re-adjudication): gate-3's recorded FAIL stands as recorded.
But the implementation plan must pin the exit-gate binary configuration
explicitly — an optimized kernel arm is the honest comparison against the
optimized SQLite arm, reachable via the existing `STRATA_KERNEL_SERVICE_BIN`
override without touching the harness. Release alone is nowhere near
sufficient (14.1 s vs a 2.5 s allowance), so this does not soften the slice's
task; it changes the baseline the slice must optimize from. **Flagged for the
independent methodology review of the implementation plan.**

## Finding 3 — where the daemon-side residual goes (code-path trace, pivotal claims source-verified)

Timing-window framing first: `bridgeWallNs` covers ONLY spawn + IPC + wait
(`process.rs:178-197`); `snapshotBuildNs` (provider.rs:38-42,
executor.rs:102-110) and `requestSerializeNs` (process.rs:152-154) are
separate, and the `publication` phase timers wrap the whole provider/executor
call (`publication.rs:388-395,411-421,487-494`). So phase − bridge = daemon
work, attributed as follows (release-run sizing):

| # | what (file:line) | cost class | ≈ release cost | removed by persistent delta-synced worker? |
|---|---|---|---|---|
| 1 | `children_resource` full `graph.snapshot()` clone (all 1012 node payloads) per touched node inside `intent_analysis_from_facts` — `resources.rs:136-149`, call sites `provider.rs:382,407,416,488,491,528`; plus `references_to_resource` | **O(R·N)** | **≈ 6.5–7 s** (≈1.45–1.6 s × 5 analysis phases) | **No** — daemon-side scope build on returned facts |
| 2–4 | per-trip snapshot clone + wire conversion + validate (`graph.rs` `snapshot()`, `protocol.rs:276-369`), full-graph serialize + re-validate (`protocol.rs:1154-1157`), metrics-only extra `serde_json::to_vec` (`provider.rs:44-48`, `executor.rs:112-115`) | O(N) × 6 trips | ≈ 1.0 s | **Yes** |
| 5 | `validate_delta_containment` ×2 → `required_delta_authority` full snapshot clone (`publication.rs:466,502`, `analyzer.rs:216-225`) | O(N), untimed | ≈ 0.3–0.5 s (with #6) | No |
| 6 | `graph.apply` rebuild + digest = serde_json of whole snapshot + SHA-256 per publish (`graph.rs` `build()`) | O(N), untimed | (in #5's bucket) | No |

Verified in-session: `children_resource` really does clone the full graph per
call and filter for one parent; a bounded, non-cloning `children_bounded`
projection already exists on `GraphGeneration` (graph.rs) and is unused on
this path; `persistenceNs` = 16 ms confirms redb I/O is NOT the bottleneck —
the graph lives in memory behind `Arc`, and all the residual is in-memory
cloning/serialization/hashing.

Measurement caveat: item 4 (metrics-only full-snapshot serialization) runs
outside every measured window, so metrics-on runs carry a small invisible
overhead per trip; it does not change any conclusion here.

## Sizing the levers (release baseline, one big1k mutation ≈ 14.1 s, allowance ≈ 2.5 s)

- **Persistent hydrated delta-synced worker (the chartered slice):** removes
  Node-side spawn/hydrate/snapshot-deserialize (≈ 0.54 s × 5 analysis trips +
  ≈ 0.55 s candidate) AND daemon-side items 2–4 (≈ 1.0 s) → saves ≈ 4.2 s.
  Remaining trips ≈ 2.0 s (analyze ≈ 0.49 s + candidate validate/export
  ≈ 1.45 s + protocol).
- **Daemon scope-builder fix (item 1, NOT in the chartered slice):**
  `children_resource` → bounded/indexed child lookup. ≈ 6.5–7 s — the single
  largest lever, and without it the slice cannot reach the allowance:
  persistence alone lands at ≈ 14.1 − 4.2 ≈ 9.9 s. This is a measured,
  attributed, correctness-preserving algorithmic fix, but it is a scope
  amendment to the charter — flagged for the plan + independent review.
- **Projection with slice + item-1 fix (+ release binary):** ≈ 2.0 s trips +
  ≈ 0.4 s items 5–6 + persistence ≈ 0.02 s ≈ **2.4 s vs ≈ 2.5 s allowance —
  borderline**; exact-generation memoization of the 5 repeated analyses
  (≈ 0.4 s more) is the buffer. Medium stays the tighter target: candidate
  validate alone measured 786 ms against a 0.70–0.85 s allowance — the
  honest-fail branch of the charter remains live.
- Candidate validate (render + fresh whole-corpus tsc, 1.27 s) + export
  (0.17 s) are the known residuals the spec already lists as not removed by
  the slice.

## Method notes

- One mutation (N=1) — a diagnostic, not a distribution; the tie-out to
  gate-3's p95s is what licenses reading it as representative.
- `spawn/transport` is a residual (bridgeWall − snapshotBuild − serialize −
  workerTotal, floored at 0); in the debug run component overlap makes it 0
  for big1k. Component fields overlap; only bridgeWall and request wall are
  end-to-end.
- Debug-run raw JSONL + summary committed under
  `docs/spikes/bridge-persistence-step0/`, release run under its `release/`
  subdirectory; both used the same driver, same corpus digest
  (`845af2a91899…`), same machine, same session.
