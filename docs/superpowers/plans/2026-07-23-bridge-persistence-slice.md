# Bridge-persistence slice Implementation Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: v2 — APPROVED FOR EXECUTION.** The operator approved A3 (and
> acknowledged A1/A2) on 2026-07-24. The chartered v1 → independent review
> → v2 sequence is complete; Task 11 Step 0's gate is satisfied.

**v2 (2026-07-23):** revised after the independent Codex review (gpt-5.6-sol,
xhigh, read-only; output archived at
`docs/superpowers/specs/2026-07-23-bridge-persistence-plan-review-codex.md`,
brief at `...-review-brief.md`). All 11 findings — 3 blockers, 6 majors, 2
minors — source-verified in-session and incorporated. Load-bearing
corrections:
- **B1 → A3 (operator approval REQUIRED):** the unchanged gate-3 harness can
  NEVER exit 0 — `mediumMemoryPlaceholder` (`report.ts`) hardcodes
  `INCONCLUSIVE` into medium's corpus state, and overall PASS requires both
  corpora PASS. The chartered "exit gate = unchanged harness, PASS = exit 0"
  is internally impossible. A3 defines the amended exit verdict below.
- **B2:** publication runs `plan_readiness` against the speculative
  `next = graph.apply(&delta)` BEFORE final authority checks and durable
  commit (`publication.rs:522-578` region, verified). The persistent mirror
  must sync ONLY published canonical generations; speculative analysis stays
  on the one-shot path (Task 6).
- **B3:** the daemon is thread-per-connection (`server.rs` `thread::spawn`,
  verified) — attestation check / sync / dispatch must be one atomic
  `request_at` operation under the host mutex; single-flight, no
  out-of-order correlation (unsolicited response = poison) (Task 3).
- **M1:** generation crosses the wire as a canonical decimal string
  (`WireU64` / `canonicalU64Schema` convention, verified) — the sync digest
  uses an explicit canonical writer, not object-key behavior (Task 2).
- **M3:** the mirror is `:memory:` (verified) — raw file bytes are
  meaningless; the candidate-isolation assertion is a logical fingerprint
  over ALL relevant tables + integrity checks, not graph-only (Task 7).
- **M4:** v1's ≈2.4 s projection was bottom-up optimistic; top-down
  subtraction gives ≈2.86–3.36 s pre-memoization (independently recomputed).
  A hard go/no-go checkpoint lands right after Task 1 (Task 1b).
- **M2/M5/M6, minors:** delta-log bounds, memory-guard strengthening + A3
  wiring, exit-artifact provenance/CI, real-corpus equivalence coverage,
  poison-state test — all folded into the tasks below.

**Goal:** Make the kernel arm pass the gate-3 noninferiority contract (UCB95 ≤ 1.25× SQLite p95 mutation wall, both corpora; A3-amended memory component) by (a) eliminating the measured O(R·N) daemon-side scope-build cost, and (b) replacing spawn-per-request one-shot bridge workers with one persistent, delta-synchronized, attested worker — or record an honest FAIL and fire the pre-registered stopping rule.

**Architecture:** Two independent measured levers (step-0, `docs/spikes/bridge-persistence-step0.md`). Lever 1 (Rust daemon): a parent→children index so `children_resource` stops cloning the full graph per touched node (≈6.5–7 s of the 8.2 s release big1k residual). Lever 2 (bridge): a persistent N=1 Node worker holding a `:memory:` SQLite mirror, synchronized by exact generation/digest-attested deltas of PUBLISHED generations only, serving analyze/candidate requests through one atomic single-flight `request_at` operation over a bounded multi-frame protocol, with savepoint-rollback candidate isolation asserted by a full logical fingerprint. Coordination authority untouched; one-shot remains fallback/cold-start/speculative-analysis path. Exit gate: the gate-3 harness with wall/lifecycle components unchanged, the A3-amended memory component, and the kernel binary pinned to release (disclosed).

**Tech Stack:** Rust (`crates/strata-kernel`: coordination, bridge host, redb), TypeScript (`packages/kernel-bridge` worker, `packages/live-compare` gates), vitest, cargo test, the existing gate-1/2/3 harnesses.

**Design:** `docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md` (chartered), amended by step-0 (`docs/spikes/bridge-persistence-step0.md`, a0f32ed) and this review round.

## Charter amendments (operator decision points)

**A1 — Daemon scope-builder fix is IN scope (Task 1).** Adjudicated by the
review: a legitimate measured lever, an internal complexity correction on the
same coordination path with unchanged semantics/thresholds/boundaries; no
operator approval required, disclosed here for the record. Equivalence gate:
byte-identical resource-version strings on synthetic AND real corpora
(medium + big1k), including post-`apply` states.

**A2 — Exit-gate kernel binary pinned to release (Task 11).** Adjudicated
fair: "both arms use their production-optimized implementation" is the honest
symmetry rule (the SQLite arm already runs optimized native code). Gate-3's
recorded artifact stays immutable; the new exit artifact records the exact
release binary sha. Via the existing `STRATA_KERNEL_SERVICE_BIN` override.

**A3 — Amended exit verdict (REQUIRES operator approval before execution).**
The unchanged harness cannot exit 0 (B1, verified). A3 keeps the wall-time
schedules, seeds, windows, corpora, N, bootstrap method, and the 1.25 UCB95
threshold EXACTLY as recorded, and replaces the obsolete medium-memory
placeholder component with Task 9's true-process memory predicate: exit
verdict = (wall tri-state per corpus, unchanged) ∧ (lifecycle parity 4/4,
unchanged) ∧ (A3 memory predicate: pre-registered absolute combined
daemon+worker RSS cap on big1k + leak check). No other harness change beyond
the artifact-path/provenance surface in Task 11, every line of which is
disclosed in the decisions entry. **If the operator rejects A3, the slice
stops here** (the chartered exit gate is unsatisfiable as written — that
itself goes to decisions.md).

## Global Constraints

- **Exit-gate wall contract unchanged:** same thresholds (1.25 UCB95), windows (submit+advance vs validate+commit), N, seeds, corpora, bootstrap as recorded gate 3. Never weaken a threshold, drop a corpus, shrink N, or touch the SQLite arm. Memory component per A3 only.
- **Pre-registered stopping rule (charter, verbatim):** if the exit gate still FAILs after the slice (+ memoization if profiled-in), accept the provisional SQLite-authority split and stop — no stacking of unmeasured optimizations, no threshold changes.
- **Go/no-go discipline (review Q7/Q9):** Task 1b recomputes the projection from measurements before any protocol work; if irreducible candidate+publication work exceeds the medium allowance, STOP and report to the operator rather than building the protocol on hope.
- **Published-only mirror sync (B2):** deltas enter the sync log ONLY after `PublishOutcome::Published` and the in-memory publication swap. Speculative graphs (readiness planning against unpublished `next`) NEVER touch the persistent mirror — those trips use the one-shot path.
- **Atomic dispatch (B3):** attestation validation, delta selection/hydration, sync-response verification, and the semantic request/response happen inside ONE `request_at` critical section on the host. Queue wait consumes the request deadline. Single-flight: any unsolicited or requestId-mismatched response poisons and restarts the worker.
- **Coordination authority unchanged.** Worker results stay non-authoritative; all publication-time checks (`publication.rs:727-783`) remain exactly as today. Worker queue order never defines ticket priority.
- **Hard boundaries (kernel design, verbatim):** clients never open canonical storage; Node workers never mutate redb; TS semantics stay in Node; validation never bypassed; agent-visible protocol and lifecycle unchanged; deterministic key-free gates before any keyed spend; the SQLite product path remains supported.
- **Semantic equivalence is gated, not assumed:** resource-version equality (Task 1) and the differential shadow oracle (Task 8) precede any measured claim.
- **Exact, transactional, forward-only sync** with attestation; gap/digest-mismatch/ahead/below-retention-floor → refuse + exact-generation full-snapshot fallback; epoch change kills workers; no probabilistic checking outside the oracle.
- **Candidate isolation is absolute:** both paths leave the mirror logically identical (full fingerprint, Task 7), asserted after every candidate.
- **One-shot path preserved** (fallback, cold start, speculative analysis, oracle reference arm). `kernel-child.ts` stays metrics-OFF.
- **Frame limits stay asymmetric as today:** 32 MiB request / 16 MiB response (`process.rs`, `worker.ts`) — do not apply the request bound to every frame.
- **Timing discipline (gate-3 B1):** dispositive timing is metrics-OFF both arms.
- **Worker pool stays N=1.** **Key-free.**
- **Gate order:** protocol unit gates → mirror-sync gates → candidate-isolation gates → differential oracle → full-key-free chain green → memory guard → exit gate. A red gate stops the slice at that gate.
- **Commands:** `PATH=/opt/homebrew/bin:$PATH` prefix; `pnpm kernel:full-key-free:test` is the canonical green claim. Long runs foreground with generous timeouts.
- Commit after every task; push after every 2–3 tasks.

## Shared vocabulary

- **`GraphIdentity`**: `{ generation: CanonicalU64String, digest: string }` — generation ALWAYS transported as the canonical decimal string (existing `WireU64`/`canonicalU64Schema` convention).
- **`SyncFrame`** (daemon→worker): `{ kind:"sync", base: GraphIdentity, deltas: CanonicalDelta[], target: GraphIdentity }`.
- **`Attestation`** (worker→daemon): `{ kind:"attest", identity: GraphIdentity }` — after applying a `SyncFrame` or full hydration.
- **`RefusalFrame`** (worker→daemon): `{ kind:"refuse", reason:"gap"|"digest-mismatch"|"ahead", have: GraphIdentity }`.
- **`WireFrame`**: length-prefixed (u32 LE) JSON frame with `requestId`; request frames bounded by 32 MiB, response frames by 16 MiB (today's asymmetric bounds). Malformed/oversized/deadline/unsolicited → poison: kill + reap + lazy respawn; in-flight request falls back one-shot.
- **`CanonicalDelta`**: the exact published graph delta the daemon applies at publication, serialized canonically, one per generation step — appended to the sync log ONLY after `PublishOutcome::Published` + in-memory swap; never coalesced or reordered.
- **`DeltaLog`**: daemon-side `VecDeque<(generation, CanonicalDelta, digestAfter)>` capped at **4096 entries or 16 MiB serialized, whichever first** (pre-registered); eviction from the front; sync reads extract an owned/Arc'd contiguous batch under the log lock (append/evict during an in-flight sync cannot mutate the batch). Base below the retained floor, or a batch that would exceed one request frame → full-snapshot hydrate to the exact target.
- **`canonical sync digest`**: SHA-256 (lowercase hex) over an EXPLICIT canonical byte writer (no reliance on serializer object-key behavior): `{"schema":1,"generation":"<decimal-u64-string>","nodes":[...],"references":[...]}` — nodes sorted by id (byte-wise UTF-8 comparator, stated), each `[id, kind, parentId|null, childIndex|null, payload]`; references sorted by (fromNodeId, toNodeId), each `[fromNodeId, toNodeId, kind]`; strings JSON-escaped per RFC 8259 minimal escaping (both languages' standard serializers produce this for strings — proven by hostile fixtures); no whitespace. Implemented in `crates/strata-kernel/src/sync_digest.rs` and `packages/kernel-bridge/src/sync-digest.ts` against shared fixture vectors PLUS a randomized cross-language differential test. New digest for sync attestation only; `GraphGeneration::digest` untouched.
- **`MirrorState`**: `GraphIdentity` recomputed (never cached) for attestation and post-candidate assertions.
- **`MirrorFingerprint`** (Task 7): SHA-256 over a canonical dump of ALL mutable mirror tables — nodes, edges/references, transactions, operations/operation-log, and any auxiliary tables (enumerated from the store schema at implementation time, including `sqlite_sequence` if present) — plus `PRAGMA integrity_check` and `PRAGMA foreign_key_check` results. Strictly stronger than `MirrorState`; used for candidate isolation.
- **Step-0 driver**: `packages/live-compare/src/gate3/step0-stage-decomposition.ts` — the measurement instrument for every ablation checkpoint (`--copies 46 --n 1`, debug AND release).

---

### Task 1: Daemon scope-builder fix — parent→children index, no full-graph clones (A1)

**Files:**
- Modify: `crates/strata-kernel/src/graph.rs` (add `children_of` index built in `GraphGeneration::build`)
- Modify: `crates/strata-kernel/src/coordination/resources.rs:136-157` (`children_resource` stops calling `graph.snapshot()`; `references_to_resource` verified already index-backed)
- Test: unit + equivalence tests in the resources test module

**Interfaces:**
- Produces: `GraphGeneration::children_of(&self, parent_id: &str) -> impl Iterator<Item = &NodeRecord>` — index-backed (`BTreeMap<String, Vec<String>>` parent_id → child node ids, built once in `build()` alongside `references_to`), no cloning. `children_bounded` re-implemented on top of it, behavior identical.
- **Resource-version strings MUST be byte-identical to today's** — same members `(id, kind, child_index)`, same sort, same `hashed_resource` call.

- [ ] **Step 1: Write the failing equivalence test.** Synthetic graphs (≥3 parents, ≥5 children each, equal `childIndex` values to pin sort stability, non-ASCII identifiers, parentless nodes, zero-children parents): old snapshot-clone implementation (kept temporarily as a test-local reference copy) vs new index path — every resource-version string byte-identical.
- [ ] **Step 2: Real-corpus equivalence (review Minor 1).** Extend the test to a hydrated medium corpus graph AND a post-`apply` mutated state (apply a rename delta, then compare every node's `children_resource` old vs new). big1k-scale spot-check behind a slow/ignored marker.
- [ ] **Step 3: Run to verify failure** → compile FAIL (`children_of` missing).
- [ ] **Step 4: Implement** the index + rewrite `children_resource`.
- [ ] **Step 5: Run** equivalence tests → PASS; `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` → green.
- [ ] **Step 6: Ablation.** Rebuild debug + release; step-0 driver big1k both profiles. Expected: release advance residual ≈5.0 s → ≈1 s. If not, STOP — attribution wrong; report before proceeding.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "perf(kernel): parent-index children_resource — remove O(R·N) scope-build clones (equivalence-gated; ablation: <numbers>)"`

---

### Task 1b: Go/no-go checkpoint — recomputed projection + release-mode medium profile (review M4/Q7/Q9)

**Files:**
- Create: `docs/spikes/bridge-persistence-step0/post-task1/` (summary.json + metrics.jsonl, big1k AND a medium-shaped 1-copy corpus run, release)
- Modify: this plan (record the numbers in the checkpoint block below)

- [ ] **Step 1: Measure.** Step-0 driver, release binary: `--copies 46 --n 1` and `--copies 1 --n 1` (1-copy = medium-scale indicative profile). Preserve artifacts.
- [ ] **Step 2: Recompute the projection top-down.** big1k: measured post-Task-1 window minus the persistence saving (Node spawn/hydrate/deserialize + daemon per-trip snapshot build/serialize, re-derived from the NEW workerRun records, not v1's 4.2 s). Medium: measured 1-copy window minus the same; compare against allowances (big1k ≈2.5 s; medium cold ≈0.70 s / warm ≈0.85 s).
- [ ] **Step 3: Decide, honestly.** (a) Projected big1k ≤ allowance AND projected medium within reach (≤ allowance + memoization headroom) → proceed to Task 2. (b) Irreducible candidate+publication work (validate/render/tsc + journal fsyncs + items 5–6) already exceeds the medium allowance → **STOP: report to the operator** with the numbers (options: design amendment for another profiled lever; or accept the split now). Do NOT proceed to protocol work on hope.
- [x] **Step 4: Commit** the artifacts + the recorded decision. `git add -A && git commit -m "docs(spike): post-task1 go/no-go — <proceed|stop>: <numbers>"`

**CHECKPOINT RECORD (2026-07-24): PROCEED.** Measured (release, N=1,
step-0 driver, artifacts in `docs/spikes/bridge-persistence-step0/
post-task1{,-medium}/`):
- big1k: 6.80 s (submit 1.83 + advance 4.97; trips 5.63, residual 1.16).
  Top-down persistence projection: trips → ≈1.96 s (analyze 5×≈0.12 +
  candidate validate/export ≈1.36) + residual → ≈0.56 s (snapshotBuild+
  serialize 6×≈0.105 removed) ≈ **2.5 s vs 2.50 s allowance** — at the
  line; memoization headroom → ≈2.0 s.
- medium-scale (1 copy): 1.86 s (submit 0.50 + advance 1.37). Dominant cost
  is 6×≈0.2 s spawn/transport — precisely what persistence removes.
  Projection ≈ **0.55 s vs 0.697 s cold allowance** (candidate validate
  0.378 s + analyze ≈0.06 + residual ≈0.11) — under allowance with ~20%
  margin. (Note: candidate validate measured 378 ms here vs the 786 ms
  gate-2-era figure quoted in the charter — the earlier number was a
  debug-binary measurement.)
- No irreducible floor exceeds an allowance → protocol work is justified.
  Both margins are thin; the exit gate remains honestly winnable-or-losable
  and the stopping rule stands.

---

### Task 2: Canonical sync digest, Rust + TS, explicit writer, shared + randomized vectors

**Files:**
- Create: `crates/strata-kernel/src/sync_digest.rs`, `packages/kernel-bridge/src/sync-digest.ts`
- Create: `crates/strata-kernel/tests/fixtures/sync-digest-vectors.json`
- Test: Rust unit tests; TS `packages/kernel-bridge/tests/syncDigest.test.ts`; a randomized cross-language differential test (Rust generates N random graphs + digests to a temp JSON via a `#[test]`-guarded generator binary or build-script-free test helper; the TS test consumes and must reproduce every digest)

**Interfaces:**
- Rust: `pub fn canonical_sync_digest(generation: u64, nodes: &[NodeRecord], references: &[ReferenceRecord]) -> String`; TS: `canonicalSyncDigest(generation: CanonicalU64String, nodes: MirrorNode[], references: MirrorReference[]): string` — generation handled as the decimal string on the wire and inside the encoding; both sides use an EXPLICIT canonical writer per Shared vocabulary (assemble the byte string manually; only string-escaping delegates to the standard serializer).
- Fixture vectors (≥9): empty; one node; sort-forcing sets; equal childIndex; payloads with `"`\\/newline/U+2028/U+2029; non-BMP (surrogate pairs); `u64::MAX` generation; max-safe childIndex; reference sort-forcing.

- [ ] **Step 1: Write failing Rust + TS tests** against the vectors (generated once by the Rust implementation, then pinned) and the failing randomized differential test.
- [ ] **Step 2: Run both to verify failure.**
- [ ] **Step 3: Implement both writers.**
- [ ] **Step 4: Run** → all PASS; builds green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sync): canonical sync digest — explicit writer, Rust+TS byte-identical, pinned + randomized cross-language vectors"`

---

### Task 3: Multi-frame protocol — Rust persistent-worker host with atomic `request_at`

**Files:**
- Create: `crates/strata-kernel/src/bridge/persistent.rs`
- Modify: `crates/strata-kernel/src/bridge/mod.rs`, `crates/strata-kernel/src/bridge/process.rs` (extract shared constants only; one-shot unchanged)
- Test: unit tests in `persistent.rs` with a scripted fake worker (`crates/strata-kernel/tests/fixtures/fake-worker.js`)

**Interfaces:**
- `PersistentWorkerHost::spawn(config) -> Result<Self>` (worker entry, roots, per-request deadline, stderr byte bound, service epoch).
- **`host.request_at(identity: GraphIdentity, frame: WireFrame, deadline) -> Result<WireFrame>`** — THE only semantic entry point (B3). Inside one mutex-held critical section: validate last attestation against `identity`; if stale, select the delta batch (or full snapshot) and run sync + verify the attest/refusal response; then send the semantic frame and await its response. Queue wait consumes the deadline. No public `sync`/`last_attestation` surface.
- Single-flight strictly: one outstanding frame; ANY response whose `requestId` mismatches, or any unsolicited frame → poison (kill + reap; error to caller; lazy respawn with attestation cleared).
- Crash/deadline/oversize/stderr-overflow → poison, caller falls back one-shot. `host.shutdown()` = clean EOF + bounded wait + kill. Epoch mismatch → coordinator kills host.

- [ ] **Step 1: Write failing unit gates** against the scripted fake worker: (a) frame bounds (request 32 MiB / response 16 MiB asymmetry enforced); (b) single-flight violation — fake sends an extra unsolicited frame → poison + respawn; (c) requestId mismatch → poison; (d) deadline (sleepy fake) → poison, queue-wait counted (two callers, slow first: second's deadline includes wait); (e) stderr bound overflow → poison; (f) crash mid-request → error + lazy respawn; (g) clean shutdown EOF → exit 0 reaped; (h) **G/G+1 atomicity race**: two threads call `request_at` with different identities; assert each request's sync+dispatch pair is uninterleaved (fake logs frame order; no sync of thread B lands between thread A's sync and semantic frame).
- [ ] **Step 2: Run to verify failure** → compile FAIL.
- [ ] **Step 3: Implement `persistent.rs`.**
- [ ] **Step 4: Run** `cargo test -p strata-kernel persistent` → PASS; `pnpm kernel:full-key-free:test` green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(bridge): persistent-worker host — atomic single-flight request_at, poison-on-violation, G/G+1 race gates"`

---

### Task 4: Multi-frame protocol — Node worker persistent loop

**Files:**
- Modify: `packages/kernel-bridge/src/worker.ts` (persistent mode via `--persistent`; `runOneShotWorker` unchanged)
- Create: `packages/kernel-bridge/src/frames.ts`
- Test: `packages/kernel-bridge/tests/frames.test.ts`, `packages/kernel-bridge/tests/persistentLoop.test.ts`

**Interfaces:**
- `readFrames(stream): AsyncIterator<Buffer>` / `writeFrame(stream, buffer)` — u32 LE prefix; reader enforces the 32 MiB request bound, writer the 16 MiB response bound; throw on overflow.
- Loop: strictly serial (single-flight mirror of the host): read one frame → dispatch (`sync` | `analyzeIntent` | `buildValidateCandidate` | `shutdown`) → write exactly one response with the same `requestId` → next. EOF → exit 0. Per-request errors → error-response frame; process exit reserved for unrecoverable states.
- `StageRecorder` per request, so `workerRun` records stay per-trip comparable.

- [ ] **Step 1: Write failing frame tests** (round-trip, chunk-split reads, both bounds, overflow throws) and a failing loop test (2 sequential correlated requests + shutdown; a response is never emitted before its request fully read).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; kernel-bridge suite green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel-bridge): serial persistent worker loop over bounded length-prefixed frames"`

---

### Task 5: Persistent full-snapshot loop (B-as-scaffold) + ablation

**Files:**
- Modify: `crates/strata-kernel/src/bridge/provider.rs`, `executor.rs` (route through `request_at` when enabled; full snapshot still sent per request)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/` (flag `--persistent-bridge`, default OFF)
- Test: live-compare integration test — one medium mutation, flag on vs off, identical published result

**Interfaces:**
- Consumes: Task 3 host, Task 4 loop. UNCHANGED semantics — isolates the transport change for ablation (charter build order).

- [ ] **Step 1: Write the failing integration test** (published operation, affected set, rendered result equal one-shot's; exactly one worker process across the mutation's trips).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement routing + flag.**
- [ ] **Step 4: Run** → PASS; `pnpm kernel:full-key-free:test` green (flag OFF by default).
- [ ] **Step 5: Ablation.** Step-0 driver big1k release, flag on vs off; record.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(bridge): persistent full-snapshot transport behind --persistent-bridge (ablation: <numbers>)"`

---

### Task 6: Eager hydration + published-only exact delta sync + attestation

**Files:**
- Modify: `crates/strata-kernel/src/bridge/persistent.rs` (sync inside `request_at`), the publication path (append `CanonicalDelta` to the `DeltaLog` ONLY after `PublishOutcome::Published` + in-memory swap), service startup (eager hydrate before the readiness line)
- Modify: `packages/kernel-bridge/src/worker.ts` (long-lived mirror), create `packages/kernel-bridge/src/sync.ts`
- Test: Rust gates in `persistent.rs`; TS `packages/kernel-bridge/tests/sync.test.ts`; live-compare integration

**Interfaces:**
- `DeltaLog` per Shared vocabulary (4096 entries / 16 MiB cap, owned batch under lock, floor semantics).
- Inside `request_at`: attested == request identity → dispatch; behind → batch sync (contiguous, published-only) or full hydrate (below floor / oversized batch / refusal); worker ahead → refuse, request served one-shot, mirror untouched (forward-only).
- **Speculative-analysis routing (B2):** analysis requests whose graph is NOT a published generation (readiness planning against `next` during publication) are ALWAYS dispatched one-shot with their own snapshot — never through the persistent mirror. The routing predicate is the request's graph identity being present in the published-generation index, not a caller-supplied flag.
- Worker `sync.ts`: BEGIN → apply deltas in order asserting pre-generation each step → recompute canonical sync digest → match target → COMMIT + attest; mismatch → ROLLBACK + refuse(digest-mismatch). Gap/ahead detected before touching the db.
- Eager hydration at service start (after seed/recovery, before the stdout readiness line) — honest per review Q5 (the gate-3 child times only submit+advance; daemon start is out-of-window both arms); the exit artifact discloses service-start/hydration wall separately.

- [ ] **Step 1: Write failing mirror-sync gates:** ordered apply + attest; duplicate → refuse; gapped → refuse; digest mismatch (corrupted delta) → refuse + mirror unchanged; ahead → refuse + one-shot serve; below-floor → full hydrate + attest; oversized batch → full hydrate; epoch reset → kill + rehydrate; failpoint kill mid-sync → respawn + full hydrate + correct attest; **append-during-sync truncation** — evict from the log while a captured batch is in flight, sync still applies the captured batch correctly; **speculative-publication failpoint (B2)** — publication whose readiness planning completes but whose final authority check invalidates it: assert the persistent mirror never advanced and the delta log contains no entry for the aborted generation.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** delta log + published-only append + routing predicate + worker sync + eager hydration.
- [ ] **Step 4: Run** all gates + `pnpm kernel:full-key-free:test` → green.
- [ ] **Step 5: Ablation.** Step-0 driver big1k release: analysis trips should now skip hydrate + snapshot build/serialize. Record.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(bridge): published-only attested delta sync + eager hydration, bounded delta log, speculative-publication failpoint gates (ablation: <numbers>)"`

---

### Task 7: Savepoint candidate isolation with full logical fingerprint

**Files:**
- Modify: `packages/kernel-bridge/src/candidate.ts` (savepoint wrapper on the persistent mirror; one-shot throwaway path unchanged)
- Create: `packages/kernel-bridge/src/mirror-fingerprint.ts`
- Test: `packages/kernel-bridge/tests/candidateIsolation.test.ts`

**Interfaces:**
- `mirrorFingerprint(db, generation): string` — the `MirrorFingerprint` of Shared vocabulary: canonical dump of nodes, references/edges, transactions, operations/operation-log, and every other mutable table enumerated from the store schema (assert at build time that the enumeration covers all tables in `sqlite_master` minus an explicit allowlist, so a future schema addition fails loudly rather than silently escaping the fingerprint), plus `PRAGMA integrity_check` + `PRAGMA foreign_key_check`.
- Candidate on the mirror: compute pre-fingerprint → `SAVEPOINT candidate` → today's mutate/validate/export pipeline (its `commit()` lands inside the savepoint) → capture diagnostics/export delta/candidate digest → `ROLLBACK TO candidate; RELEASE candidate` (ALWAYS) → post-fingerprint must equal pre-fingerprint. Mismatch → poison the worker (refuse all further work; error to host; host kills + lazy-respawns + full-rehydrates).
- Only published deltas (Task 6) advance the mirror.

- [ ] **Step 1: Write failing isolation gates:** (a) successful candidate — result equals one-shot's for the same request AND fingerprints equal; (b) failing candidate (type-error fixture) — failure reported, fingerprints equal; (c) thrown mid-pipeline exception — fingerprints equal; (d) crash injected mid-candidate — respawn path rehydrates + attests correctly; (e) **poison-state test (review Minor 2)** — deliberately corrupt the mirror inside the savepoint via a test seam that commits behind the wrapper's back; assert the post-fingerprint mismatch is detected, the worker refuses subsequent requests, and the host kills + rehydrates; (f) JS overlay/scratch state cleanup verified between candidates (no cross-candidate leakage of the in-process store handles).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** fingerprint + savepoint wrapper + poison propagation.
- [ ] **Step 4: Run** → PASS; `pnpm kernel:full-key-free:test` green.
- [ ] **Step 5: Savepoint ablation (review Q9).** Step-0 driver big1k release before/after: isolation overhead measured, not absorbed. Record.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(kernel-bridge): savepoint candidate isolation — full logical fingerprint, poison-on-divergence (ablation: <numbers>)"`

---

### Task 8: Differential shadow oracle (pooled vs one-shot), including concurrency + failpoints

**Files:**
- Create: `packages/live-compare/src/persistence/differential-oracle.ts`
- Test: `packages/live-compare/tests/persistenceOracle.test.ts` (medium, key-free, canonical chain)

**Interfaces:**
- `runDifferentialOracle(corpusRoot, {sequences, seed}): Promise<OracleReport>` — fixed seeded sequences of rename + add-parameter mutations through arm P (persistent) and arm O (one-shot); per step compare semantic facts, diagnostics, export delta bytes, candidate digest, published operation + affected set, final rendered tree digest. ANY mismatch fails with the full diff.
- **Concurrency + failpoint coverage (review Q8):** at least one sequence drives two overlapping client connections (interleaved change sets) through arm P and asserts equality with arm O's serialized result set; at least one sequence includes an induced publication failure (failpoint) mid-sequence and asserts both arms converge to the same post-failure state.

- [ ] **Step 1: Write the failing oracle test** (2 sequential sequences ×≥6 mutations + 1 concurrent sequence + 1 failpoint sequence; `mismatches.length === 0`).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. Wire into `kernel:full-key-free:test`; run the whole chain green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(persistence): differential shadow oracle incl. concurrent + publication-failpoint sequences, in the canonical chain"`

---

### Task 9: True-process memory guard (A3 predicate)

**Files:**
- Create: `packages/live-compare/src/persistence/memory-guard.ts`
- Test: `packages/live-compare/tests/persistenceMemory.test.ts`

**Interfaces:**
- `measureTrueRss(pids): { daemonRss, workerRss, combined }` via `ps -o rss= -p` sampling; **PID continuity asserted** (daemon and worker PIDs recorded at start must be alive and identical at every sample — a silent respawn invalidates the sample and fails the run).
- Sampling protocol (review M5): sample after each mutation completes AND after a defined quiescence beat (200 ms post-publish); per-iteration high-water retained.
- Predicates, pre-registered: (a) medium leak check — last-4 high-water ≤ first-4 high-water × `LEAK_FACTOR = 1.15` over N=12 warm mutations; (b) **absolute big1k cap** — combined daemon+persistent-worker RSS ≤ `PERSISTENT_1K_RSS_CAP` (set from the Task 1b/Task 6 ablation measurements and stated in the artifact BEFORE the exit run; candidate value recorded at Task 1b). Both feed the A3 exit verdict.

- [ ] **Step 1: Write the failing test** (medium leak check + PID continuity + a fixture-level cap predicate unit test).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; chain green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(persistence): true-process RSS guard — PID continuity, quiescence sampling, pre-registered big1k cap (A3 predicate)"`

---

### Task 10: Profile residual; memoization ONLY if indicated

**Files:**
- Possibly modify: `crates/strata-kernel/src/bridge/persistent.rs` + `packages/kernel-bridge/src/analyze.ts`
- Test: oracle extension (memo on vs off) if implemented

**Interfaces:**
- Decision input: step-0 driver big1k + 1-copy release with Tasks 1–7 landed, against the Task 1b projection. Margin comfortable (big1k ≤ ~2.2 s AND medium within allowance) → SKIP (record + proceed). In the 2.2–2.6 s band or medium marginal → implement exact-generation semantic-fact memoization: key `(target digest, intent parameters)`, worker-side, invalidated on any sync; oracle memo-on run must show zero mismatches. Render caching (D) and tsc builder-program reuse (C) stay OUT (stopping-rule discipline).

- [ ] **Step 1: Run the profile; record the decision with numbers.**
- [ ] **Step 2 (only if implementing): failing memo tests** (hit/miss/invalidation-on-sync) + oracle memo-on.
- [ ] **Step 3: Implement minimal memo.**
- [ ] **Step 4: Run** → PASS; chain green.
- [ ] **Step 5: Commit** (either outcome recorded).

---

### Task 11: Exit gate — A3-amended verdict, pinned release binary, new artifact; record and decide

**Files:**
- Modify: `packages/live-compare/src/gate3/run-big.ts` + `report.ts` — ONLY: (a) an `--artifact-base <name>` flag (default unchanged, so the recorded gate-3 artifact path is untouched); (b) the A3 memory component: when running in exit-gate mode (`--exit-gate persistence`), medium's memory component uses the Task 9 predicate result instead of `mediumMemoryPlaceholder`, and big1k's adds the absolute combined-RSS cap; (c) provenance additions: `binaryProfile`, `persistentBridge`, `task1Enabled`, `memoizationEnabled`, full argv. Wall/lifecycle/schedule/bootstrap/threshold code paths untouched — the diff is enumerated in the decisions entry.
- Create: `packages/live-compare/tests/persistenceExitArtifact.ci.test.ts` (schema + raw-pair recomputation + head binding for the NEW artifact; the existing `gate3Artifact.ci.test.ts` stays pointed at the recorded gate-3 artifact)
- Create: `docs/spikes/bridge-persistence-exit-gate.{json,md}` (the run's output)
- Modify: `decisions.md`, `docs/product-roadmap.md`, `docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md` (status)

**Interfaces:**
- Command: `cargo build --release -p strata-kernel && PATH=/opt/homebrew/bin:$PATH STRATA_KERNEL_SERVICE_BIN=$PWD/target/release/strata-kernel-service pnpm kernel:gate3:big -- --exit-gate persistence --artifact-base bridge-persistence-exit-gate` with `--persistent-bridge` as the daemon configuration for the kernel arm (disclosed). Same N, seeds, thresholds, windows, corpora, bootstrap as recorded gate 3.
- Verdict: machine only. Exit 0 → slice PASS. Exit 2 → **stopping rule fires** (record FAIL, accept the provisional SQLite-authority split, stop). Exit 1 → INCONCLUSIVE (larger pre-registered N re-run before any conclusion).

- [ ] **Step 0: GATE — operator has approved A3 (and acknowledged A1/A2).** Without it, stop here.
- [ ] **Step 1: Implement the Task-11 harness surface** (flag, A3 wiring, provenance, new CI test) with unit tests proving the default path (no flags) produces byte-identical behavior to today (snapshot the report for a fixture run, flag off vs before-change).
- [ ] **Step 2: Preflight.** Full chain green (`pnpm kernel:full-key-free:test` incl. oracle + memory guard); both binaries built; release sha recorded; `PERSISTENT_1K_RSS_CAP` stated.
- [ ] **Step 3: Run the exit gate** (foreground, ≥90 min timeout). Capture exit code + artifact.
- [ ] **Step 4: decisions.md entry:** slice as executed (levers, memo in/out), amendments A1/A2/A3 with adjudications + operator approval, the enumerated Task-11 harness diff, all ablation numbers (Tasks 1, 1b, 5, 6, 7, 10), exit verdict with UCB/LCB both corpora, binary provenance, consequence (PASS → next; FAIL → split accepted, stopping rule verbatim; INCONCLUSIVE → re-run plan).
- [ ] **Step 5: Roadmap + spec status lines; commit + push.**

## Projection (corrected per review M4 — from step-0 release measurements)

| configuration | projected big1k window | vs ≈2.5 s allowance |
|---|---|---|
| gate-3 recorded (debug, one-shot) | 26.3 s measured | 10.5× |
| release, one-shot (measured) | 14.1 s measured | 5.6× |
| + Task 1 scope-builder fix | ≈ 7.1–7.6 s (to be MEASURED at Task 1b) | ≈3× |
| + persistence (Tasks 5–7) | **≈ 2.9–3.4 s projected top-down** | above allowance |
| + memoization (if profiled-in) | ≈ 2.5–3.0 s | **borderline-to-over** |

The bottom-up estimate (surviving work only: ≈2.0 s trips + ≈0.4 s daemon
items 5–6) is ≈2.4 s; the gap between the two estimates is unattributed
residual that Task 1b must resolve with measurements. Medium: cold allowance
≈0.70 s (SQLite p95 558 ms × 1.25), warm ≈0.85 s; candidate validate alone
previously measured 786 ms — **medium is the live honest-fail risk, and the
Task 1b go/no-go exists precisely to stop before protocol work if the
irreducible floor already exceeds it.** The stopping rule is pre-registered
and will be honored.

## Self-review notes (v2)

- All 11 review findings incorporated: B1→A3 + Task 9/11 wiring; B2→published-only delta log + speculative routing predicate + failpoint gate (Task 6); B3→atomic `request_at`, single-flight poison semantics, G/G+1 race gate (Task 3); M1→decimal-string generation + explicit canonical writer + hostile/randomized vectors (Task 2); M2→bounded `DeltaLog` + captured-batch + truncation tests (Task 6); M3→full `MirrorFingerprint` + integrity pragmas + schema-coverage assertion (Task 7); M4→corrected projection + Task 1b go/no-go; M5→PID continuity + quiescence sampling + absolute big1k cap feeding A3 (Task 9); M6→artifact-base flag + new CI test + full configuration provenance, default path byte-identical (Task 11); Minor 1→real-corpus equivalence (Task 1 Step 2); Minor 2→poison-state test (Task 7 Step 1e).
- Review adjudications recorded: A1 in scope (no operator approval needed), A2 fair with symmetric production-policy framing, dual state digest over delta-chain (Q3), delta-log caps (Q4), eager hydration honest with disclosure (Q5), savepoint sufficient only with full logical fingerprint (Q6), Task 1 first + early go/no-go (Q9).
- Execution remains blocked on the operator: **approve/reject A3** (and acknowledge A1/A2). A rejected A3 ends the slice with a decisions entry (chartered exit gate unsatisfiable as written).
- Type consistency: `GraphIdentity`/`SyncFrame`/`Attestation`/`RefusalFrame`/`WireFrame`/`CanonicalDelta`/`DeltaLog`/`MirrorState`/`MirrorFingerprint` used identically across Tasks 2–9; `request_at` is the only semantic dispatch surface everywhere.
