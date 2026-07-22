# Bridge-persistence slice — design (post gate-3 falsifier-5)

**Status:** chartered 2026-07-22 (operator delegated the direction call; see
decisions.md 2026-07-22 chartering entry). Independent design review completed
BEFORE this spec was written: brief at
`2026-07-22-bridge-optimization-review-brief.md`, Codex gpt-5.6-sol xhigh
read-only output archived at `2026-07-22-bridge-optimization-review-codex.md`.
All pivotal review claims source-verified in-session (worker-trip counts,
one-shot EOF transport, commit-materialization, characterizer stage-timing
discard). Implementation plan: not yet written — this spec governs it.

## Why this slice exists

Gate 3 recorded FAIL / falsifier-5 (decisions.md 2026-07-22): kernel p95
mutation wall 4.2-4.8× SQLite on medium, 12.2-12.9× at 1012 modules, against a
1.25× contract. The coordination semantics passed gates 1-2; the cost is
bridge mechanics. The review corrected the mechanism model in one important
way: the cost is not one worker trip per mutation but **six** — submit performs
two full-snapshot analysis trips (its own analysis + readiness planning,
`coordinator.rs:205-313`, `planner.rs:102-121`), advance performs three
analyses plus candidate construction (`coordinator.rs:355-365`,
`publication.rs:388-421,487-494`) — each trip spawning a fresh Node worker and
serializing the full snapshot (gate-2 profile: 6 worker starts per mutation).
Per-trip big1k cost ≈ 4.4-4.5 s (consistency check: 6 trips ≈ the measured
9.0 s submit + 17.4 s advance).

## The design (amended candidate A, per review)

One **persistent, delta-synchronized bridge worker (N=1)** serving **all**
bridge requests (analyzeIntent AND buildValidateCandidate), replacing the
spawn-per-request one-shot transport.

1. **Multi-frame protocol.** The current transport is one-shot EOF-framed
   (`process.rs:500-508` drops stdin to signal end-of-request; one child per
   request). Persistence requires a bounded multi-frame protocol: length-
   prefixed frames, request correlation IDs, per-request deadlines, stderr
   bounds, crash/reap/respawn, clean shutdown. The existing full-snapshot
   one-shot path REMAINS as the fallback and cold-start path.
2. **Eager hydration.** The worker hydrates once at service start (before the
   daemon announces readiness), mirroring SQLite's out-of-window ingest.
3. **Exact, transactional delta sync.** Worker holds a SQLite mirror at
   generation G with digest D. Sync messages carry: base (G, D) → contiguous
   canonical deltas → expected target (G', D'). Worker applies, recomputes its
   mirror digest, and ATTESTS (G', D') before serving any semantic work.
   Gap/mismatch/ahead-of-request → refuse and fall back to exact-generation
   full snapshot. Kill workers on service-epoch change. No probabilistic
   checking for production correctness (sampling is allowed only in the
   differential shadow oracle below). Forward-only sync; a worker ahead of a
   request's generation never serves it.
4. **Candidate isolation by savepoint rollback.** Today's candidate handler
   hydrates a throwaway db and `commit()` permanently materializes overlay +
   operation log (`candidate.ts:48-178`, `validate.ts:237-273`) — unusable on
   a persistent mirror. Candidate execution wraps in an outer SQLite
   savepoint: validate, capture diagnostics/export delta, ALWAYS roll back.
   Post-candidate assertion (both success and failure): mirror generation and
   digest byte-identical to pre-candidate. Only published redb deltas advance
   the mirror.
5. **Coordination authority unchanged.** Worker results stay non-authoritative;
   all publication-time checks (dependency clocks, graph generation, scheduler
   revision, epoch, claim state, candidate binding — `publication.rs:727-783`)
   remain exactly as today. Worker queue order never defines ticket priority.
6. **Optional lever, after profiling only:** exact-generation semantic-fact
   memoization keyed by (graph digest, intent parameters) — identical
   immutable inputs across the repeated analyses of one mutation. Then D
   (render caching) only if render is measured material; C (tsc builder-program
   reuse with mandatory differential-diagnostics equivalence) last, and only
   if fresh-program construction remains decisive. C stays INSIDE the
   unchanged gate (adjudicated by the review: the gate compares product paths,
   not internal algorithms; disclose the optimization, never touch the SQLite
   arm).

## Cost budget (honest targets, from the review)

- big1k allowance at ratio 1.25: ≈ 2.43-2.50 s per mutation window.
- medium allowance: ≈ 0.70-0.85 s — **medium is the tighter target.**
- Known residuals A does not remove: full render + fresh whole-corpus tsc per
  candidate (`validate.ts:50-150`), full-graph export/diff
  (`candidate.ts:157-177`), 8 fsynced journal records per mutation window
  (`audit.rs:170-253`, `session.rs:420-456`). Medium candidate-validate alone
  measured 786 ms — the medium target is NOT assured. ≤1.25× is plausible,
  not predicted; the slice can honestly fail.

## Step 0 — diagnostic experiment (before any implementation)

One key-free big1k metrics-on mutation, PRESERVING the raw metrics JSONL (the
workerRun records already carry hydrate/analyze/validate/export stage timings;
the gate-3 characterizer discarded them, `characterize.ts:262-288` — no new
instrumentation needed). Deliverable: a per-stage decomposition of the ~4.4 s
big1k trip (snapshot build / serialize+write / spawn+module load / hydrate /
analyze-or-validate / export / publication) committed as a small spike doc.
This pins which stages A must eliminate and sizes the memoization lever.

## Gate structure (deterministic, key-free, in order)

1. Multi-frame protocol unit gates: frame bounds, correlation, deadlines,
   stderr bounds, crash/reap/respawn, concurrent callers, clean EOF.
2. Mirror-sync gates: ordered/duplicate/gapped deltas, exact digest
   attestation, ahead-generation refusal, epoch reset, failpoints around
   delta transactions.
3. Candidate-isolation gates: success AND failure leave the mirror
   byte-identical (generation + digest).
4. Differential shadow oracle: pooled vs one-shot full-snapshot results
   (semantic facts, diagnostics, delta bytes, candidate digest) across fixed
   sampled rename/add-parameter sequences.
5. Gate-1 suite unchanged, green (`pnpm kernel:full-key-free:test`).
6. True-process memory guard: daemon + persistent worker RSS/leak check
   (fixes the gate-3 harness-RSS blind spot for THIS slice's predicate;
   gate-3's recorded artifact is not modified).
7. **Exit gate: the unchanged gate-3 harness** (same thresholds, windows, N,
   seeds, corpora) — PASS requires UCB95 ≤ 1.25 both corpora, machine verdict.

**Pre-registered stopping rule:** if the exit gate still FAILs after A (+
memoization if profiled-in), accept the provisional SQLite-authority split and
stop — no stacking of unmeasured optimizations, no threshold changes.

## Build order

Persistent full-snapshot loop first (B-as-scaffold; one ablation measurement,
not a standalone slice) → delta sync + attestation → candidate isolation →
step-4 differential oracle → profile residual → memoization if indicated →
exit gate. Worker pool stays N=1 for the exit gate (N>1 multiplies the ~508 MB
big1k worker footprint and adds generation-affinity complexity with no exit-
gate benefit).

## Top risks (from the review, accepted)

1. Silent mirror divergence supplying wrong semantic scope (mitigated by exact
   attestation + differential oracle + fallback path; containment cannot catch
   under-reported scope, so attestation is load-bearing).
2. Render + fresh tsc + journal fsyncs blow the ~0.8 s medium allowance even
   after A (the honest-fail case; stopping rule applies).
3. Persistent-worker lifecycle complexity (head-of-line blocking, crash
   lifecycle, RSS footprint).

## Hard boundaries (unchanged from the kernel design)

Clients never open canonical storage; Node workers never mutate redb; TS
semantics stay in Node; validation never bypassed; agent-visible protocol and
lifecycle unchanged; deterministic key-free gates before any keyed spend; the
SQLite product path remains supported.
