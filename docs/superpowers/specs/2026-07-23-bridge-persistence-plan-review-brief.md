# Review brief: bridge-persistence slice implementation plan v1 (methodology review)

You are performing an independent, adversarial, READ-ONLY methodology review
of an implementation plan before any code is written. Your output will be
archived verbatim and its pivotal claims source-verified before acceptance.
Be specific: file:line evidence for every empirical claim, severity-ranked
findings (Blocker / Major / Minor), and explicit adjudications where asked.

## What to review

`docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md` (plan v1) —
an 11-task plan implementing the chartered bridge-persistence slice:
`docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md`.

Grounding documents (read them):
- The chartered design spec (above) and its chartering decision entry
  (decisions.md, 2026-07-22 entries).
- Step-0 diagnostic: `docs/spikes/bridge-persistence-step0.md` + raw
  artifacts in `docs/spikes/bridge-persistence-step0/` (debug + release).
- Prior art for plan style + rigor bar:
  `docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md` (v2) and
  the recorded gate-3 outcome (decisions.md 2026-07-22, artifact
  `docs/spikes/gate3-noninferiority-profile.{json,md}`).

## Context and diagnosis (verified in-session; re-verify what you rely on)

- Gate 3 recorded FAIL/falsifier-5: kernel p95 mutation wall 4.2–4.8× SQLite
  (medium), 12.2–12.9× (big1k 1012 modules) vs a 1.25× UCB95 contract.
- Step-0 (N=1 big1k metrics-on, tie-out to gate-3 p95s within 1%): the six
  bridge worker trips sum to only ~5.7 s of the 26.3 s debug window; the
  rest is daemon-side. Release binary: 14.1 s total, 8.2 s daemon residual.
- Trace attribution (source-verified): ≈6.5–7 s of the release residual is
  `children_resource` doing a full `graph.snapshot()` clone (all 1012 node
  payloads) per touched node inside `intent_analysis_from_facts`
  (`crates/strata-kernel/src/coordination/resources.rs:136-149`; call sites
  `provider.rs:382,407,416,488,491,528`) — O(R·N). A non-cloning
  `children_bounded` projection exists (`src/graph.rs`) but is unused there.
  Per-trip snapshot build/serialize + metrics-only extra serialization ≈
  1.0 s; `validate_delta_containment` ×2 + digest recompute ≈ 0.3–0.5 s.
- Gate 3 measured `target/debug` by harness default (`gate1.ts:139-143`;
  root `package.json` `kernel:gate3:big` builds without `--release`).

## Falsified levers — do NOT re-propose

- Candidate-validation-only persistence (moves a fraction of trip cost; the
  2026-07-22 review already killed it).
- Anything crossing the semantic boundary: Node workers mutating redb, TS
  semantics in Rust, validation bypass, agent-visible protocol changes.
- Threshold changes, corpus drops, N shrinkage, SQLite-arm changes.
- N>1 worker pools (charter: no exit-gate benefit, big RSS cost).
- Re-running bench rounds for their own sake.

## What the plan proposes (candidates under review)

1. Task 1 (charter amendment A1): parent→children index fix for the O(R·N)
   scope build, equivalence-gated (byte-identical resource-version strings).
2. Tasks 2–7: canonical cross-language sync digest; bounded multi-frame
   protocol (Rust host + Node persistent loop); persistent full-snapshot
   scaffold with ablation; eager hydration + exact attested delta sync with
   refusal fallback; savepoint-rollback candidate isolation.
3. Task 8: differential shadow oracle (pooled vs one-shot) in the canonical
   key-free chain.
4. Task 9: true-process RSS leak guard (`LEAK_FACTOR = 1.15` pre-registered).
5. Task 10: memoization only if the post-landing profile indicates.
6. Task 11 (charter amendment A2): exit gate = unchanged gate-3 harness with
   kernel binary pinned to `target/release` via the existing
   `STRATA_KERNEL_SERVICE_BIN` override, new artifact path, machine verdict,
   stopping rule verbatim.

## Hard constraints (non-negotiable, from the charter)

- Coordination authority unchanged (`publication.rs:727-783` checks stay).
- Clients never open canonical storage; workers never mutate redb; TS
  semantics stay in Node; validation never bypassed.
- Exit gate: the UNCHANGED gate-3 harness — same thresholds (1.25 UCB95),
  windows (submit+advance vs validate+commit), N, seeds, corpora, bootstrap.
- Pre-registered stopping rule: exit-gate FAIL after the slice (+ profiled-in
  memoization) → accept the provisional SQLite-authority split, stop.
- Deterministic key-free gates before any keyed spend.
- The one-shot path remains supported (fallback, cold start, oracle arm).

## Questions you MUST adjudicate explicitly

1. **A1 (scope-builder fix in scope):** legitimate measured lever inside the
   charter's spirit, or scope creep that should go back to the operator? Is
   the equivalence gate (byte-identical resource-version strings + full
   key-free chain) sufficient to call it correctness-preserving?
2. **A2 (release binary at the exit gate):** fair pre-registered
   configuration disclosure, or threshold motion in disguise? Note the
   SQLite arm runs production-optimized native code; note gate-3's recorded
   artifact is immutable and not re-adjudicated. If you reject A2, say what
   the honest binary policy is.
3. **Canonical sync digest design:** new dual-implementation digest (Rust +
   TS, shared vectors) vs alternatives (delta-chain digest; reusing
   `GraphGeneration::digest`; exporting canonical bytes from one side).
   Adjudicate: is byte-identical dual-serialization across serde_json and
   JSON.stringify actually achievable and testable enough (non-ASCII,
   escaping, number formatting), or is a delta-chain/other design more
   honest? If you pick a different design, spell out its attestation
   semantics and what silent-divergence risk it leaves.
4. **Daemon in-memory delta log unbounded within a service session** —
   acceptable, or must it be capped (and what refresh semantics)?
5. **Eager hydration before the readiness line** — out-of-window per the
   charter's "mirroring SQLite's out-of-window ingest"; confirm or refute
   that this is measurement-honest w.r.t. the gate-3 windows (check what the
   gate-3 kernel-child actually times: cold sample includes daemon start?
   verify against `packages/live-compare/src/gate3/kernel-child.ts` and
   `runners.ts`).
6. **Savepoint isolation:** today's candidate handler `commit()`s into its
   db (`packages/kernel-bridge/src/candidate.ts`, `validate.ts:237-273`).
   Is SAVEPOINT/ROLLBACK sufficient to guarantee byte-identity of the
   mirror, including WAL/vacuum/auto-increment/sqlite_sequence side effects
   that survive rollback? If not, what does the byte-identity assertion have
   to check (and is (generation, canonical digest) the right check vs raw
   file bytes)?
7. **Projection honesty:** the plan projects ≈2.4 s big1k post-slice vs
   ≈2.5 s allowance and flags medium (allowance 0.70–0.85 s, candidate
   validate alone 786 ms) as the live honest-fail risk. Check the arithmetic
   against the step-0 artifacts. Is the plan's "borderline, may honestly
   fail" framing correct, or is it optimistic/pessimistic in a way that
   should change the build order (e.g. attack medium's validate cost first,
   or stop now and accept the split)?
8. **Gate completeness:** do the plan's gates actually cover the charter's
   seven-gate structure, and are there failure modes with no gate (e.g.
   protocol deadlock under concurrent sync+request, attestation staleness
   races, worker poisoned-state handling, delta-log truncation during an
   in-flight sync)?
9. **Task-order and ablation discipline:** is the build order right
   (scope-builder fix first vs scaffold first), and are the ablation
   checkpoints (step-0 driver re-runs) sufficient to catch a wrong
   attribution early?

## Output format

Severity-ranked findings (Blocker/Major/Minor) with file:line evidence, then
explicit answers to the nine questions, then a one-paragraph overall verdict:
is this plan sound to execute as v2 after incorporating your findings, or
does it need re-chartering with the operator?
