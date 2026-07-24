# Bridge-persistence slice Implementation Plan — v1 (pre-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: v1 — NOT executable yet.** Per the charter (decisions.md
> 2026-07-22), this plan goes through an independent methodology review
> (Codex, xhigh, read-only) and becomes v2 before any build. Two charter
> amendments proposed below (§ "Charter amendments") require that review's
> adjudication.

**Goal:** Make the kernel arm pass the unchanged gate-3 noninferiority harness (UCB95 ≤ 1.25× SQLite p95 mutation wall, both corpora) by (a) eliminating the measured O(R·N) daemon-side scope-build cost, and (b) replacing spawn-per-request one-shot bridge workers with one persistent, delta-synchronized, attested worker — or, failing that, to record an honest FAIL and trigger the pre-registered stopping rule.

**Architecture:** Two independent levers, both measured by step-0 (`docs/spikes/bridge-persistence-step0.md`). Lever 1 (daemon, Rust): a parent→children index on `GraphGeneration` so `children_resource` stops cloning the full graph per touched node (≈6.5–7 s of the 8.2 s release-mode big1k residual). Lever 2 (bridge): a persistent N=1 Node worker holding a SQLite mirror, synchronized by exact generation/digest-attested deltas, serving all analyze/candidate requests over a bounded multi-frame protocol, with savepoint-rollback candidate isolation (≈4.2 s: Node spawn/hydrate/deserialize + daemon per-trip snapshot build/serialize). Coordination authority is untouched; the one-shot full-snapshot path remains as fallback and cold-start. Exit gate: the unchanged gate-3 harness with the kernel binary configuration pinned to release (disclosed, via the existing `STRATA_KERNEL_SERVICE_BIN` override — no harness change).

**Tech Stack:** Rust (`crates/strata-kernel`: coordination, bridge host, redb), TypeScript (`packages/kernel-bridge` worker, `packages/live-compare` gates), vitest, cargo test, the existing gate-1/2/3 harnesses.

**Design:** `docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md` (chartered), amended by step-0 findings (`docs/spikes/bridge-persistence-step0.md`, commit a0f32ed). Review provenance: brief + Codex output alongside the spec (2026-07-22), step-0 trace source-verified in-session 2026-07-23.

## Charter amendments proposed by this plan (review must adjudicate)

**A1 — Daemon scope-builder fix is IN scope (Task 1).** The chartered slice
(persistent worker) removes ≈4.2 s of a 14.1 s release-mode big1k window;
step-0 attributes ≈6.5–7 s to `children_resource`'s full-graph clone per
touched node inside `intent_analysis_from_facts`
(`resources.rs:136-149`, call sites `provider.rs:382,407,416,488,491,528`) —
daemon-side work that worker persistence cannot remove. Without this fix the
slice lands at ≈9.9 s vs a ≈2.5 s allowance and the exit gate cannot pass;
with it, projection is ≈2.4 s (borderline). The fix is measured, attributed,
correctness-preserving (identical resource-version strings, gated by
equivalence tests), and does not touch thresholds, windows, arms, or
semantics. It is nevertheless an addition to the chartered lever list, so it
is flagged here rather than silently included. The stopping rule is
unchanged: these are the ONLY two levers (plus the spec's already-optional
memoization if profiled-in); if the exit gate still FAILs, accept the
SQLite-authority split.

**A2 — Exit-gate kernel binary pinned to release (Task 11).** Gate 3
measured `target/debug` (harness default `gate1.ts:139-143`; the
`kernel:gate3:big` script builds without `--release`) against a
production-grade SQLite arm — step-0 shows this alone accounts for ~half the
recorded gap (26.3 s → 14.1 s). The exit gate runs the UNCHANGED harness
(same thresholds, windows, N, seeds, corpora, bootstrap) with
`STRATA_KERNEL_SERVICE_BIN` pointing at `target/release`, disclosed in the
artifact's existing `daemonBinarySha` provenance plus an explicit
`binaryProfile: "release"` note in the decisions entry. The SQLite arm is
untouched. Gate-3's recorded FAIL artifact is not modified or
re-adjudicated. The review must confirm this is a fair pre-registered
configuration, not threshold motion.

## Global Constraints

- **The exit gate is the unchanged gate-3 harness** (`run-big.ts`, same thresholds 1.25 UCB95, same windows submit+advance vs validate+commit, same N/seeds/corpora/bootstrap). PASS requires machine verdict exit 0 on both corpora. Never weaken a threshold, drop a corpus, shrink N, or touch the SQLite arm.
- **Pre-registered stopping rule (charter, verbatim):** if the exit gate still FAILs after the slice (+ memoization if profiled-in), accept the provisional SQLite-authority split and stop — no stacking of unmeasured optimizations, no threshold changes.
- **Coordination authority unchanged.** Worker results stay non-authoritative; all publication-time checks (dependency clocks, graph generation, scheduler revision, epoch, claim state, candidate binding — `publication.rs:727-783`) remain exactly as today. Worker queue order never defines ticket priority.
- **Hard boundaries (kernel design, verbatim):** clients never open canonical storage; Node workers never mutate redb; TS semantics stay in Node; validation never bypassed; agent-visible protocol and lifecycle unchanged; deterministic key-free gates before any keyed spend; the SQLite product path remains supported.
- **Semantic equivalence is gated, not assumed.** Every performance change ships with a deterministic equivalence gate (resource-version equality for Task 1; differential shadow oracle for the persistent worker) BEFORE it can affect any measured run.
- **Exact, transactional, forward-only sync.** Mirror sync carries base (G, D) → contiguous canonical deltas → expected target (G′, D′); the worker attests (G′, D′) after applying or refuses. Gap/digest-mismatch/ahead-of-request → refuse + exact-generation full-snapshot fallback. Kill workers on service-epoch change. No probabilistic checking outside the differential shadow oracle.
- **Candidate isolation is absolute.** Both success and failure paths leave the mirror byte-identical (generation + digest) — asserted after every candidate, not sampled.
- **One-shot path preserved.** The existing spawn-per-request full-snapshot transport remains buildable and selectable (fallback, cold start, differential oracle reference arm). `kernel-child.ts` stays metrics-OFF by design.
- **Timing discipline (gate-3 B1, unchanged):** dispositive timing is metrics-OFF both arms; metrics-on runs only characterize.
- **Worker pool stays N=1** for this slice (charter: N>1 multiplies the ~508 MB big1k worker footprint with no exit-gate benefit).
- **Key-free.** No model calls anywhere in this plan.
- **Gate order is the charter's:** protocol unit gates → mirror-sync gates → candidate-isolation gates → differential oracle → full-key-free suite green → memory guard → exit gate. A red gate stops the slice at that gate.
- **Commands:** `PATH=/opt/homebrew/bin:$PATH` prefix for anything touching native modules; `pnpm kernel:full-key-free:test` is the canonical green claim (plain `cargo test` skips feature-gated suites). Long runs foreground with generous timeouts.
- Commit after every task; push after every 2–3 tasks.

## Shared vocabulary

- **`SyncFrame`** (daemon→worker): `{ kind:"sync", baseGeneration:number, baseDigest:string, deltas:CanonicalDelta[], targetGeneration:number, targetDigest:string }`.
- **`Attestation`** (worker→daemon): `{ kind:"attest", generation:number, digest:string }` — sent after applying a `SyncFrame` (or after full hydration); the daemon refuses to dispatch semantic work to a worker whose last attestation ≠ the request's (G, D).
- **`RefusalFrame`** (worker→daemon): `{ kind:"refuse", reason:"gap"|"digest-mismatch"|"ahead", haveGeneration:number, haveDigest:string }` → daemon falls back to exact-generation full snapshot for that request and re-hydrates the worker.
- **`WireFrame`**: length-prefixed (u32 LE byte length, bounded by the existing 32 MiB `max_request_bytes`) JSON frame with `requestId:string` correlation; direction-tagged. Malformed length/overflow/deadline → kill + reap + respawn worker, fall back one-shot for in-flight requests.
- **`CanonicalDelta`**: the exact published graph delta the daemon already applies at `publication.rs:522` (`graph.apply(&delta)`), serialized in the canonical encoding (below), one per generation step — never coalesced, never reordered.
- **`canonical digest`**: SHA-256 over the canonical encoding of the graph state: nodes sorted by id, each encoded as the JSON array `[id, kind, parentId|null, childIndex|null, payload]`, then references sorted by (fromNodeId, toNodeId) encoded as `[fromNodeId, toNodeId, kind]`, the two lists wrapped as `{"schema":1,"generation":G,"nodes":[...],"references":[...]}` with no whitespace. Implemented byte-identically in Rust (`crates/strata-kernel/src/sync_digest.rs`) and TypeScript (`packages/kernel-bridge/src/sync-digest.ts`) against shared fixture vectors. This is a NEW digest for sync attestation only — the existing `GraphGeneration::digest` (serde-shaped, `graph.rs` `build()`) is untouched and remains what publication checks use.
- **`MirrorState`** (worker-side): `{ generation:number, digest:string }` for the persistent SQLite mirror; recomputed (not cached) for every attestation and every post-candidate assertion.
- **Step-0 driver**: `packages/live-compare/src/gate3/step0-stage-decomposition.ts` — the measurement instrument for every ablation checkpoint in this plan (`--copies 46 --n 1`, debug AND release).

---

### Task 1: Daemon scope-builder fix — parent→children index, no full-graph clones (amendment A1)

**Files:**
- Modify: `crates/strata-kernel/src/graph.rs` (add `children_of` index built in `GraphGeneration::build`)
- Modify: `crates/strata-kernel/src/coordination/resources.rs:136-157` (`children_resource`, `references_to_resource` — stop calling `graph.snapshot()`)
- Test: `crates/strata-kernel/src/coordination/resources.rs` unit tests (same file or existing test module), plus a new equivalence test

**Interfaces:**
- Produces: `GraphGeneration::children_of(&self, parent_id: &str) -> impl Iterator<Item = &NodeRecord>` — index-backed (a `BTreeMap<String, Vec<String>>` of parent_id → sorted child node ids, built once in `build()` alongside `references_to`), no cloning, no full-snapshot materialization. `children_bounded` (graph.rs) re-implemented on top of it, behavior identical.
- **Resource-version strings MUST be byte-identical to today's.** `children_resource` must produce the same `hashed_resource("children:{parent_id}", &members)` output where `members: Vec<(String, String, Option<i64>)>` sorted — the members list and its sort order must not change, only how it is gathered.

- [ ] **Step 1: Write the failing equivalence test.** In the resources test module: build a synthetic `GraphGeneration` (≥3 parents, ≥5 children each, interleaved kinds/child_index values, plus nodes with no parent). Compute `children_resource` and `references_to_resource` for every node via the CURRENT snapshot-clone implementation (keep it temporarily as `children_resource_reference` in the test) and via the new index path; assert every resource-version string is byte-identical. Add a case where `parent_id` has zero children.
- [ ] **Step 2: Run to verify failure** (new `children_of` doesn't exist): `cargo test -p strata-kernel children_resource` → compile FAIL.
- [ ] **Step 3: Implement** the `children_of` index in `GraphGeneration::build` + rewrite `children_resource` to iterate the index (collect `(id, kind, child_index)` tuples, same sort, same `hashed_resource` call). `references_to_resource` already uses the `references_to` index — verify and leave.
- [ ] **Step 4: Run the equivalence test** → PASS; then the canonical suite: `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` → green (this includes the gate-1/2/3-medium coordination suites; any behavior drift shows here).
- [ ] **Step 5: Ablation measurement.** Rebuild (`cargo build -p strata-kernel && cargo build --release -p strata-kernel`), re-run the step-0 driver debug + release (`--copies 46 --n 1 --out <scratch>`); record submit/advance walls + residuals in the task's commit message. Expected: release advance residual drops from ≈5.0 s to ≈1 s; if it does not, STOP — the attribution was wrong; report before proceeding.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "perf(kernel): parent-index children_resource — remove O(R·N) full-graph clones from scope build (equivalence-gated; step-0 ablation: <numbers>)"`

---

### Task 2: Canonical sync digest, Rust + TS, shared fixture vectors

**Files:**
- Create: `crates/strata-kernel/src/sync_digest.rs`
- Create: `packages/kernel-bridge/src/sync-digest.ts`
- Create: `crates/strata-kernel/tests/fixtures/sync-digest-vectors.json` (checked in; both languages' tests read it)
- Test: Rust unit tests in `sync_digest.rs`; TS `packages/kernel-bridge/tests/syncDigest.test.ts`

**Interfaces:**
- Rust: `pub fn canonical_sync_digest(generation: u64, nodes: &[NodeRecord], references: &[ReferenceRecord]) -> String` (lowercase hex SHA-256 of the canonical encoding defined in Shared vocabulary; sorts internally, does not require pre-sorted input).
- TS: `canonicalSyncDigest(generation: number, nodes: MirrorNode[], references: MirrorReference[]): string` with `MirrorNode = { id, kind, parentId: string|null, childIndex: number|null, payload }`, `MirrorReference = { fromNodeId, toNodeId, kind }` — same encoding, byte-identical output.
- Fixture vectors: ≥5 cases — empty graph; one node; nodes requiring sort; payloads with non-ASCII + JSON-escaping-sensitive characters (`"`, `\`, newline, U+2028); references requiring sort — each with the expected digest, generated ONCE by the Rust implementation and asserted by both.

- [ ] **Step 1: Write the failing Rust test** (vectors file with placeholder digests → generate; then pin) and the failing TS test reading the same file.
- [ ] **Step 2: Run both to verify failure.** `cargo test -p strata-kernel sync_digest` FAIL; `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test` FAIL.
- [ ] **Step 3: Implement both.** JSON string escaping must match exactly: use each language's standard JSON serializer on the assembled canonical value (`serde_json::to_string` of a `serde_json::Value` built with explicit arrays; `JSON.stringify` in TS) — both emit identical minimal escaping for the same strings; the vectors with hostile payloads prove it.
- [ ] **Step 4: Run both** → PASS. `cargo build -p strata-kernel` + kernel-bridge build.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sync): canonical sync digest, Rust+TS byte-identical against shared vectors"`

---

### Task 3: Multi-frame protocol — Rust persistent-worker host

**Files:**
- Create: `crates/strata-kernel/src/bridge/persistent.rs`
- Modify: `crates/strata-kernel/src/bridge/mod.rs` (export), `crates/strata-kernel/src/bridge/process.rs` (extract shared frame-size constant; one-shot path unchanged)
- Test: unit tests in `persistent.rs` using a scripted fake worker (a tiny Node script fixture under `crates/strata-kernel/tests/fixtures/fake-worker.js`)

**Interfaces:**
- `PersistentWorkerHost::spawn(config) -> Result<Self>` where config carries the worker entry path, corpus/source roots, per-request deadline, stderr byte bound, and service epoch.
- `host.request(frame: WireFrame, deadline: Duration) -> Result<WireFrame>` — writes a length-prefixed frame, awaits the correlated response frame (requestId match), enforces the deadline. Serialized single-flight (N=1): concurrent callers queue on a mutex; queue order is explicitly NOT ticket priority (authority stays in the scheduler).
- `host.sync(frame: SyncFrame, deadline) -> Result<Attestation | RefusalFrame>`; `host.last_attestation() -> Option<(u64, String)>`.
- Crash/reap/respawn: worker exit, malformed frame, oversized frame (> existing `max_request_bytes`), stderr overflow, or deadline → kill + reap; host reports the error to the caller (who falls back one-shot) and respawns lazily on next use with attestation cleared.
- `host.shutdown()` — clean EOF + bounded wait + kill.
- Epoch: `host.epoch()` recorded at spawn; the coordinator kills hosts whose epoch ≠ current service epoch.

- [ ] **Step 1: Write failing unit gates against the scripted fake worker** (gate structure item 1, all seven): (a) frame bounds — oversized length prefix → error + respawn; (b) correlation — out-of-order responses matched by requestId; (c) deadlines — sleepy fake → deadline error, worker killed; (d) stderr bounds — chatty fake → bounded capture, overflow kills; (e) crash/reap/respawn — fake exits mid-request → error surfaces, next request respawns; (f) concurrent callers — two threads, both complete, single child observed; (g) clean shutdown — EOF observed by fake, exit 0 reaped.
- [ ] **Step 2: Run to verify failure** → compile FAIL.
- [ ] **Step 3: Implement `persistent.rs`.** Reuse `process.rs`'s spawn plumbing where extractable without changing the one-shot path's behavior.
- [ ] **Step 4: Run** `cargo test -p strata-kernel persistent` → PASS; `pnpm kernel:full-key-free:test` still green (one-shot untouched).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(bridge): persistent-worker host — bounded multi-frame protocol with crash/reap/respawn unit gates"`

---

### Task 4: Multi-frame protocol — Node worker persistent loop

**Files:**
- Modify: `packages/kernel-bridge/src/worker.ts` (add persistent mode entry; `runOneShotWorker` unchanged)
- Create: `packages/kernel-bridge/src/frames.ts` (length-prefixed frame reader/writer)
- Test: `packages/kernel-bridge/tests/frames.test.ts`, `packages/kernel-bridge/tests/persistentLoop.test.ts`

**Interfaces:**
- Worker starts in persistent mode when argv includes `--persistent` (the host passes it; one-shot invocation unchanged for `kernel-child.ts` and fallback).
- `readFrames(stream): AsyncIterator<Buffer>` / `writeFrame(stream, buffer)` — u32 LE length prefix, hard cap mirroring the Rust bound, throw on overflow.
- Persistent loop: for each request frame, dispatch by kind — `sync` (Task 6), `analyzeIntent`, `buildValidateCandidate` (Task 5/7), `shutdown` → respond with the same `requestId`; on EOF exit 0. Errors inside one request produce an error-response frame, never process exit (process exit is reserved for unrecoverable states — the host treats exit as crash).
- Stage metrics: the existing `StageRecorder` is created per request (not per process) so `workerRun` records stay per-trip comparable.

- [ ] **Step 1: Write failing frame tests** (round-trip, split-across-chunks reads, overflow throw) and a failing persistent-loop test driving the compiled worker over stdio with 2 correlated requests + shutdown.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test` green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel-bridge): persistent worker loop over length-prefixed correlated frames (one-shot path unchanged)"`

---

### Task 5: Persistent full-snapshot loop (B-as-scaffold) + ablation measurement

**Files:**
- Modify: `crates/strata-kernel/src/bridge/provider.rs`, `crates/strata-kernel/src/bridge/executor.rs` (route through `PersistentWorkerHost` when enabled; snapshot still sent per request at this task)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/` (flag `--persistent-bridge`, default OFF at this task)
- Modify: `packages/kernel-bridge/src/analyze.ts`, `candidate.ts` (accept requests via the persistent dispatch; hydrate per request still)
- Test: extend `packages/live-compare` gate-1-style integration test to run one medium mutation with `--persistent-bridge` on and assert identical published result vs off

**Interfaces:**
- Consumes: Task 3 host, Task 4 loop.
- Produces: end-to-end persistent transport with UNCHANGED semantics (same full snapshot per request, same handlers) — isolating the transport change for ablation, per the charter's build order ("persistent full-snapshot loop first; one ablation measurement, not a standalone slice").

- [ ] **Step 1: Write the failing integration test** (medium corpus, one rename, `--persistent-bridge` on): published operation, affected set, and rendered result equal the one-shot run's; exactly one worker process observed across the mutation's 6 trips.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement routing + flag.**
- [ ] **Step 4: Run** → PASS; `pnpm kernel:full-key-free:test` green (flag default OFF cannot regress).
- [ ] **Step 5: Ablation.** Step-0 driver on big1k, release, `--persistent-bridge` on vs off; record the delta (expected: spawn/module-load portion of spawn/transport disappears, ~0.1 s × 6; hydrate/serialize remain). Numbers in the commit message.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(bridge): persistent full-snapshot transport behind --persistent-bridge (ablation: <numbers>)"`

---

### Task 6: Eager hydration + exact delta sync + attestation

**Files:**
- Modify: `crates/strata-kernel/src/bridge/persistent.rs` (sync orchestration), the publication path (retain per-generation `CanonicalDelta`s in memory from `publication.rs:522`'s applied delta), service startup (eager hydrate before readiness line)
- Modify: `packages/kernel-bridge/src/worker.ts` persistent state: long-lived mirror db; `packages/kernel-bridge/src/sync.ts` (new: apply deltas transactionally, recompute digest, attest/refuse)
- Test: Rust failpoint-style unit gates in `persistent.rs`; TS `packages/kernel-bridge/tests/sync.test.ts`; integration in live-compare

**Interfaces:**
- Daemon keeps an in-memory contiguous delta log `{ fromGeneration, deltas: Vec<(u64, CanonicalDelta, digestAfter)> }` since service start (big1k scale: deltas are small; bounded by session lifetime — a restart re-hydrates full-snapshot, which is the existing cold path).
- Before dispatching semantic work at generation G′: if `host.last_attestation() == (G′, D′)` dispatch immediately; else send `SyncFrame` with the contiguous deltas from the worker's attested generation; on `RefusalFrame` or missing coverage → exact-generation full-snapshot request (one-shot handler semantics) + full re-hydrate of the mirror, then attest.
- Worker `sync.ts`: BEGIN; apply each delta in order asserting expected pre-generation; recompute `canonicalSyncDigest` from the mirror; digest == targetDigest → COMMIT + attest; else ROLLBACK + refuse (digest-mismatch). Gap/ahead detected before touching the db.
- Eager hydration: service start (after seed/recovery, before the stdout readiness line) spawns the host and full-hydrates the mirror, so the first mutation pays no hydration.
- Forward-only: a worker attested ahead of a request's generation refuses (`ahead`) — the daemon uses one-shot for that request; it never rolls the mirror back.

- [ ] **Step 1: Write failing mirror-sync gates** (gate structure item 2): ordered deltas apply + attest; duplicate delta → refuse; gapped → refuse; digest mismatch (corrupted delta fixture) → refuse + mirror unchanged (rolled back); ahead-generation refusal; epoch reset kills + re-hydrates; failpoint around the delta transaction (kill worker mid-sync → respawn → full-hydrate → attest correct digest).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** daemon delta log + sync orchestration + worker sync + eager hydration.
- [ ] **Step 4: Run** all sync gates + `pnpm kernel:full-key-free:test` → green.
- [ ] **Step 5: Ablation.** Step-0 driver big1k release, persistent+sync on: analyze trips should now skip hydrate + snapshot build/serialize (expected ≈0.1–0.15 s per analysis trip). Record.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(bridge): eager hydration + exact attested delta sync with refusal fallback (ablation: <numbers>)"`

---

### Task 7: Savepoint candidate isolation on the persistent mirror

**Files:**
- Modify: `packages/kernel-bridge/src/candidate.ts` (savepoint wrapper when running against the persistent mirror; one-shot throwaway-db path unchanged)
- Test: `packages/kernel-bridge/tests/candidateIsolation.test.ts`

**Interfaces:**
- Candidate execution on the mirror: `SAVEPOINT candidate;` → run today's mutate/validate/export pipeline against the mirror db → capture diagnostics + export delta + candidate digest → `ROLLBACK TO candidate; RELEASE candidate;` — ALWAYS, success and failure alike (`commit()`'s materialization happens inside the savepoint and is rolled back).
- Post-candidate assertion (both paths): recomputed `MirrorState` (generation + canonical digest) equals pre-candidate — assertion failure poisons the worker (refuse all further work, host respawns + re-hydrates) and surfaces as an error to the daemon; it must never be swallowed.
- Only published deltas (Task 6 sync) ever advance the mirror.

- [ ] **Step 1: Write failing isolation gates** (gate structure item 3): (a) successful candidate → result equals the one-shot handler's result for the same request (diagnostics, export delta, candidate digest) AND mirror (G, D) byte-identical before/after; (b) failing candidate (fixture with a type error) → failure reported AND mirror byte-identical; (c) a crash injected mid-candidate (kill the worker) → host respawn path re-hydrates and attests the correct (G, D).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm kernel:full-key-free:test` green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel-bridge): savepoint-rollback candidate isolation with byte-identical mirror assertion"`

---

### Task 8: Differential shadow oracle (pooled vs one-shot)

**Files:**
- Create: `packages/live-compare/src/persistence/differential-oracle.ts`
- Test: `packages/live-compare/tests/persistenceOracle.test.ts` (medium-sized, key-free, in the canonical chain)

**Interfaces:**
- `runDifferentialOracle(corpusRoot, {sequences, seed}): Promise<OracleReport>` — drives FIXED seeded sequences of rename + add-parameter mutations twice: arm P (persistent bridge) and arm O (one-shot), comparing per step: semantic facts returned to the daemon, diagnostics, export delta bytes, candidate digest, published operation + affected set, and final rendered tree digest. `OracleReport = { steps, mismatches: [] }`; ANY mismatch fails the gate with the full diff.
- Consumes: Tasks 5–7; sequences reuse the gate-1 task manifest machinery.

- [ ] **Step 1: Write the failing oracle test** (the oracle module doesn't exist): 2 seeded sequences × ≥6 mutations each on medium, assert `mismatches.length === 0`.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. Wire into the canonical suite (root `package.json` `kernel:full-key-free:test` chain) and run the whole chain green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(persistence): differential shadow oracle — pooled vs one-shot equivalence in the canonical chain"`

---

### Task 9: True-process memory guard (gate structure item 6)

**Files:**
- Create: `packages/live-compare/src/persistence/memory-guard.ts`
- Test: `packages/live-compare/tests/persistenceMemory.test.ts`

**Interfaces:**
- `measureTrueRss(pids): { daemonRss, workerRss, combined }` sampled via `ps -o rss= -p <pid>` (true process RSS — fixes the gate-3 harness-RSS blind spot for THIS slice's predicate; gate-3's recorded artifact untouched).
- Leak check: N=12 warm mutations on medium with the persistent bridge; combined RSS high-water of the last 4 iterations must not exceed the first 4's high-water by more than a pre-registered `LEAK_FACTOR = 1.15` (adjudicated by review); absolute worker bound stays informational at this corpus size, the big1k ~508 MB figure is re-measured (not gated) and recorded for the decisions entry.

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; chain green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(persistence): true-process RSS leak guard for daemon + persistent worker"`

---

### Task 10: Profile residual; memoization ONLY if indicated

**Files:**
- Possibly modify: `crates/strata-kernel/src/bridge/persistent.rs` + `packages/kernel-bridge/src/analyze.ts` (memo layer)
- Test: extension of the differential oracle (memo on vs off equivalence) if implemented

**Interfaces:**
- Decision input: step-0 driver big1k release with Tasks 1–7 landed. If projected window ≤ allowance with margin (≤ ~2.2 s), SKIP memoization (YAGNI; record the profile and move to the exit gate). If in 2.2–2.6 s, implement exact-generation semantic-fact memoization: cache key `(targetDigest, intent parameters)`, worker-side, invalidated on any sync; the 5 analyses of one mutation are identical immutable inputs (step-0: ≈0.49 s total analyze + per-trip protocol overhead — expected saving ≈0.4 s). Render caching (D) and tsc builder-program reuse (C) stay OUT unless the review explicitly profiles them in; C would additionally require the differential-diagnostics equivalence rig the charter describes.
- Equivalence: memo on vs off through the differential oracle, zero mismatches.

- [ ] **Step 1: Run the profile** (step-0 driver, both corpora sizes — big1k and medium via `--copies 1` against `examples/medium` semantics is NOT valid; medium profile uses the driver pointed at a 1-copy corpus, recorded as indicative only). Record the decision (skip / implement) with numbers.
- [ ] **Step 2 (only if implementing): failing memo tests** (hit/miss/invalidation-on-sync) + oracle memo-on run.
- [ ] **Step 3: Implement minimal memo.**
- [ ] **Step 4: Run** → PASS; chain green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "perf(bridge): exact-generation semantic-fact memoization (profiled-in: <numbers>)" ` or `docs: memoization skipped — profile shows margin`.

---

### Task 11: Exit gate — unchanged gate-3 harness, pinned binary config; record and decide

**Files:**
- Create: updated `docs/spikes/gate3-noninferiority-profile.{json,md}` — NO. **The recorded gate-3 artifact is immutable.** The exit-gate run writes a NEW artifact: `docs/spikes/bridge-persistence-exit-gate.{json,md}` (the same writer, different deterministic name, wired via the existing artifact-path parameter — if `run-big.ts` hard-codes the path, add a path flag WITHOUT touching thresholds/schedule; that one-line surface is disclosed in the decisions entry).
- Modify: `decisions.md` (slice outcome entry), `docs/product-roadmap.md`, `docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md` (status line)

**Interfaces:**
- Command: `cargo build --release -p strata-kernel && PATH=/opt/homebrew/bin:$PATH STRATA_KERNEL_SERVICE_BIN=$PWD/target/release/strata-kernel-service pnpm kernel:gate3:big` with `--persistent-bridge` made the daemon default for this run (the flag flip is part of the measured configuration and disclosed). Same N, seeds, thresholds, windows, corpora, bootstrap as the recorded gate 3.
- Verdict handling is gate-3 Task-9 semantics verbatim: machine verdict only; exit 0 → slice PASS; exit 2 → **stopping rule fires**: record FAIL, accept the provisional SQLite-authority split, stop — no threshold changes, no optimization stacking; exit 1 → INCONCLUSIVE, larger pre-registered N re-run before any conclusion.

- [ ] **Step 1: Preflight.** Full chain green: `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` (now including oracle + memory guard). Both binaries built; release binary sha recorded.
- [ ] **Step 2: Run the exit gate** (foreground, ≥90 min timeout). Capture exit code + artifact.
- [ ] **Step 3: decisions.md entry** (top, dated): slice scope as executed (levers 1+2, memo in/out), the two amendments (A1, A2) with the review's adjudication, all ablation numbers (Tasks 1, 5, 6, 10), the exit-gate verdict with UCB/LCB both corpora, binary provenance (debug vs release shas), and the consequence (PASS → next; FAIL → SQLite-authority split accepted, verbatim stopping rule; INCONCLUSIVE → re-run plan).
- [ ] **Step 4: Roadmap + spec status lines.**
- [ ] **Step 5: Commit + push.** `git add -A && git commit -m "docs: bridge-persistence exit gate recorded — <verdict>" && git push`

## Projection (from step-0, release, big1k — honesty budget)

| configuration | projected window | vs ≈2.5 s allowance |
|---|---|---|
| gate-3 recorded (debug, one-shot) | 26.3 s measured | 10.5× |
| release, one-shot (measured) | 14.1 s measured | 5.6× |
| + Task 1 scope-builder fix | ≈ 7.5 s | 3.0× |
| + Tasks 5–7 persistent worker | ≈ 2.4 s | ≈1.0× allowance — borderline |
| + Task 10 memoization (if in) | ≈ 2.0 s | inside allowance, thin margin |

Medium remains the tighter target (allowance ≈0.70–0.85 s; candidate
validate alone measured 786 ms; per-mutation journal fsyncs remain). **The
slice can honestly fail on medium — the stopping rule is pre-registered and
will be honored.**

## Self-review notes (v1)

- Charter gate structure → tasks: protocol unit gates (Task 3), mirror-sync gates (Task 6), candidate isolation (Task 7), differential oracle (Task 8), full-key-free green (every task's step + Task 11 preflight), memory guard (Task 9), exit gate (Task 11). Build order follows the charter (scaffold → sync → isolation → oracle → profile → memo → exit).
- Step-0 amendments surfaced as explicit review questions (A1, A2), not silently folded in.
- Known open questions for the reviewer, beyond A1/A2: (1) canonical-digest design (new digest vs reusing `GraphGeneration::digest`) — chosen for cross-language byte-identity, is the dual-digest surface acceptable? (2) daemon in-memory delta log unbounded within a service session — acceptable for this slice's scale, or must it be capped with full-snapshot refresh? (3) eager hydration before the readiness line changes service-start latency (out-of-window by charter, mirroring SQLite's out-of-window ingest — confirm). (4) `LEAK_FACTOR = 1.15` pre-registration. (5) the exit-gate artifact-path flag (one-line harness surface) — acceptable as disclosed, or should the exit gate overwrite-protect differently?
