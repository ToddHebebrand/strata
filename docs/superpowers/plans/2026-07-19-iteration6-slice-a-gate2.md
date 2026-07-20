# Iteration 6 slice A — gate 2 (per-stage observability) Implementation Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**v2 (2026-07-19):** revised after the independent Codex review (gpt-5.6-sol,
xhigh, read-only; report saved at
`docs/superpowers/specs/2026-07-19-slice-a-gate2-review-codex.md`, brief at
`...-review-brief.md`). All findings were source-verified by the requesting
session and accepted: the blocker (metrics must be opt-in end-to-end and must
never perturb the semantic response, including at the 16 MiB response bound;
Rust consumer lands before the TS producer) and the majors (snapshot-bytes vs
whole-request bytes split + snapshot-build/serialize timing; per-phase
attribution across the four analysis sites; `ExecutedEffect`-carried
publication report + self-attributed worker records instead of a global slot
and drain-causality; retry-accumulated candidate/analysis timing;
spawn-anchored worker-start counting with terminal records for error runs;
`coreGraphRecordValueBytes` honesty rename; deterministic committed evidence
artifact under `docs/spikes/`) and the minor (measured `seed_ns`,
storage-returned snapshot byte lengths).

**Goal:** Land gate 2 of the convergence slice: key-free per-stage observability — wall time, peak memory, serialized snapshot bytes, Node-worker starts, SQLite hydration time, validation time, redb publication time, and restart replay time — instrumented on both the Rust daemon and the TS bridge, producing a machine-checked kernel-arm T03 observability profile.

**Architecture:** Metrics are opt-in end-to-end from a single `--metrics <path>` daemon flag: it opens a JSONL sink (separate from the hash-chained audit journal), sets `collect_metrics` on `NodeBridgeConfig`, and the bridge passes `--emit-metrics` to spawned workers. The worker self-reports stage timings + its own peak RSS in an optional `metrics` block appended to the bridge stdout response only when asked, and only when it fits under the existing response bound (the semantic response is serialized and bound-checked first and is never altered). The Rust bridge counts worker starts at spawn, records one terminal `WorkerRunMetrics` per spawned child (success or error class), tags each with a coordination phase + snapshot-byte/build-cost context from a thread-local observer context set at the analysis/candidate call sites, and buffers records for drain; records are self-attributed (`changeSetId` + `phase`), never drain-causally. In-kernel stage timings extend `PublicationReport` (accumulated across optimistic retries) and `RecoveryReport` (open/replay/seed). The session emits per-request records (wall, `getrusage` peak RSS) with the publication report carried on `ExecutedEffect`. A `gate2.ts` harness in `packages/live-compare` drives the kernel-arm T03 flow (fresh seed → discovery → lifecycle → publish → restart → replay) with metrics enabled, aggregates the JSONL into a typed profile, and a vitest suite asserts all eight observability categories plus cross-invariants. Canonical evidence is a deterministic artifact committed under `docs/spikes/`.

**Tech Stack:** Rust (redb, serde, libc for `getrusage`), TypeScript (zod, vitest, `process.hrtime.bigint()`, `process.resourceUsage()`).

**Design:** Gate 2 of `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4 (item 2), as framed by `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md` (gate map: "Instrumentation lands on both the daemon and the bridge; no keyed spend").

## Global Constraints

- **Observability must not change coordination semantics or any semantic byte.** No instrumentation may alter scope inference, fresh analysis, validation binding, reservations, fenced publication, scheduler decisions, digest inputs, or the bytes of any semantic response. Metrics are observer-only: RAII thread-local context, return-struct extensions, interior-mutability buffers, and a side-channel file. **With metrics off (the default), the worker emits byte-identical responses to today, no recorder is created, and no `resourceUsage`/`getrusage` call happens per request.** If a measurement cannot be taken without touching a semantic path, STOP and log a decision (falsifier 1).
- **The semantic response is bound-checked first and never displaced.** The worker's existing 16 MiB response bound applies to the metrics-free semantic frame exactly as today; the metrics block is appended only if the combined frame still fits, and is silently dropped otherwise. A metrics-bearing build must never turn a valid candidate into `responseTooLarge`.
- **Rust consumer before TS producer.** The `#[serde(default)]` optional `metrics` field lands (Task 1) before any worker can emit it (Task 2), so every intermediate commit keeps the bridge round-trip green.
- **Zero agent-visible wire change.** The Unix-socket protocol (`LocalServiceRequest`/`LocalServiceResponse`) gains no fields, request types, or response bytes. Gate 3 forbids extra agent-visible lifecycle calls; gate 5 compares token cost.
- **The hash-chained audit journal is untouched.** `audit.rs` record kinds and chaining gain nothing; metrics get their own sink.
- **Attribution is by tag, never by drain adjacency.** Worker records carry `changeSetId` + `phase`; request records carry their own wall/RSS and (for the publishing advance) the `ExecutedEffect`-carried publication report. No metric is described as "caused by" the request that happened to drain it.
- **Byte counts are honestly named.** `coreGraphRecordValueBytes` is the encoded value bytes of exactly the operation+delta+ticket+event records; it is not total transaction bytes nor physical redb bytes and must never be labeled "publication bytes" in artifacts. Full-transaction byte accounting is a logged gate-3 residual if needed.
- **Key-free:** no model calls, no API keys anywhere in this plan.
- **No persisted SQLite in the kernel arm:** better-sqlite3 only via `openDb(":memory:")` (worker-internal, already true).
- **Units convention:** durations are nanoseconds as JSON numbers; byte counts are bytes as JSON numbers; RSS is bytes (Node `process.resourceUsage().maxRSS` is KiB on all platforms via libuv → ×1024; Rust `getrusage` `ru_maxrss` is bytes on macOS, KiB on Linux → `#[cfg]` normalize).
- **Low overhead when on; nothing when off:** the metrics file uses buffered writes + flush, no fsync (metrics are not canonical history). Emission failures never fail a request; a `--metrics` path that cannot open fails startup loudly.
- **Green claims** only via `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` plus `pnpm -r test`.
- **Feature matrix for Rust changes:** `cargo test -p strata-kernel`, `--features coordination-test-api`, AND `--features redb-spike-api`.
- **Deadlines:** harness requests budget ≥30.1 s remaining for `submit_change_set`, ≥60.1 s for `advance_change_set` (`session.rs:27-29`).
- **Long commands:** run test suites foreground with explicit generous timeouts (the supervisor kills detached background tasks).
- **No new bench rounds / no cross-arm numbers:** gate 2 profiles the kernel arm only; cross-arm methodology is gate 3's plan. Do not quote any cross-arm ratio from gate-2 artifacts.
- Commit after every task; push after every 2–3 tasks.

## Shared vocabulary (referenced by every task)

- **`WorkerStageMetrics`** (TS) / **`WorkerSelfMetrics`** (Rust): the worker's self-report — `{ hydrateNs?, analyzeNs?, mutateNs?, validateNs?, exportNs?, totalNs, peakRssBytes }`. Stage fields optional; `totalNs` + `peakRssBytes` required.
- **`RunPhase`** (Rust, `&'static str` values on the wire-facing record): `"submitAnalysis" | "claimAnalysis" | "preCandidateAnalysis" | "postCandidateAnalysis" | "candidate" | "unattributed"` — set by RAII guards at the five call sites (Task 4); `"unattributed"` when no guard is active (e.g. test-harness direct calls).
- **`WorkerRunMetrics`** (Rust): one terminal record per **spawned** worker child —
  `{ request_kind, change_set_id, phase, outcome, bridge_wall_ns, snapshot_bytes, total_request_bytes, snapshot_build_ns, request_serialize_ns, response_bytes, worker: Option<WorkerSelfMetrics> }`.
  - `outcome`: `"ok" | "writeFailed" | "timedOut" | "nonzeroExit" | "stderrOverLimit" | "responseOverLimit" | "parseFailed" | "lifecycleError"` — one record for every spawn, including failures (`worker` present only when a parseable response carried it).
  - `snapshot_bytes` = serialized length of just the request's `snapshot` field (measured only when collecting); `total_request_bytes` = full stdin payload; `snapshot_build_ns` = request-construction time in provider/executor (from the thread-local context); `request_serialize_ns` measured in `run()`.
  - `change_set_id` from the bridge request (`bridge/protocol.rs:426,521`); attribution is by this tag + `phase`, never drain order (the session serializes per change set only — `session.rs:61`).
- **Metrics JSONL record kinds** (camelCase on disk; `seq` = per-process monotonic `AtomicU64` on every record; no wall-clock timestamps):
  - `{"kind":"recovery","recovered":bool,"openNs":n,"replayNs":n,"seedNs":n,"replayedOperations":n,"snapshotGeneration":n,"generation":n,"snapshotBytes":n,"seq":n}` — one per daemon start; create path has `replayNs:0`, `seedNs>0`; open path has `seedNs:0`.
  - `{"kind":"workerRun", ...camelCase WorkerRunMetrics fields..., "seq":n}`
  - `{"kind":"request","action":"submit_change_set"|...,"wallNs":n,"daemonPeakRssBytes":n,"publication":{"generation":n,"preCandidateAnalysisNs":n,"postCandidateAnalysisNs":n,"candidateNs":n,"persistenceNs":n,"memoryPublishNs":n,"coreGraphRecordValueBytes":n,"alreadyPublished":bool}|null,"seq":n}` — publication non-null only on the publishing advance, carried via `ExecutedEffect`.

---

### Task 1: Rust bridge-protocol consumer — optional `metrics` on worker responses

**Files:**
- Modify: `crates/strata-kernel/src/bridge/protocol.rs` (add `WorkerSelfMetrics`; optional field on the response structs `parse_bridge_response` deserializes — the `deny_unknown_fields` success/error structs around protocol.rs:392-448)
- Test: existing `#[cfg(test)]` mod in `bridge/protocol.rs`

**Interfaces:**
- Produces: `pub struct WorkerSelfMetrics { pub hydrate_ns: Option<u64>, pub analyze_ns: Option<u64>, pub mutate_ns: Option<u64>, pub validate_ns: Option<u64>, pub export_ns: Option<u64>, pub total_ns: u64, pub peak_rss_bytes: u64 }` — serde camelCase, `deny_unknown_fields`, derive `Clone, Debug, PartialEq, Eq, Serialize, Deserialize`. Response structs gain `#[serde(default, skip_serializing_if = "Option::is_none")] pub metrics: Option<WorkerSelfMetrics>`. A helper `BridgeResponse::metrics_ref(&self) -> Option<&WorkerSelfMetrics>` across variants.
- Consumed by: Task 2 (field name/shape), Task 3 (recording).

- [ ] **Step 1: Write the failing serde test** in the existing test mod, using one of its existing valid serialized response fixtures: deserialize without `metrics` → `metrics.is_none()`; append `"metrics":{"totalNs":5,"peakRssBytes":2048,"hydrateNs":3}` → `Some(WorkerSelfMetrics { hydrate_ns: Some(3), total_ns: 5, peak_rss_bytes: 2048, .. })`; `"metrics":{"totalNs":5,"peakRssBytes":2048,"bogus":1}` → parse error.
- [ ] **Step 2: Run to verify failure.** `cargo test -p strata-kernel bridge` → FAIL (unknown field `metrics`).
- [ ] **Step 3: Implement** (struct + field + helper; update any struct-literal fixtures with `metrics: None`).
- [ ] **Step 4: Feature matrix** (`cargo test -p strata-kernel`, `--features coordination-test-api`, `--features redb-spike-api`) → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel): accept optional worker self-metrics on bridge responses (consumer first)"`

---

### Task 2: TS worker producer — opt-in stage metrics, semantic response untouched

**Files:**
- Create: `packages/kernel-bridge/src/metrics.ts`
- Modify: `packages/kernel-bridge/src/protocol.ts`, `candidate.ts`, `analyze.ts`, `worker.ts`
- Test: `packages/kernel-bridge/tests/metrics.test.ts`

**Interfaces:**
- Produces: `StageRecorder` (`metrics.ts`): `time<T>(stage: "hydrate"|"analyze"|"mutate"|"validate"|"export", fn: () => T): T`, `finish(): WorkerStageMetrics`. `workerStageMetricsSchema` (zod `.strict()`, `totalNs`+`peakRssBytes` required int nonnegative, stage fields optional) + `WorkerStageMetrics` type in `protocol.ts`; `metrics: workerStageMetricsSchema.optional()` on all four response schemas (inside the base object of `candidateSuccessResponseSchema`, before its `.superRefine`). `buildValidateCandidate`/`buildValidateCandidateInScratch`/`analyzeIntent` accept an optional trailing `recorder?: StageRecorder` (no-op when absent — **no recorder is constructed unless the worker was asked to emit metrics**). Worker opt-in trigger: the literal argv flag `--emit-metrics` (Task 3's bridge appends it when collecting).
- Consumes: Task 1's field shape (camelCase members exactly as in `WorkerSelfMetrics`).

- [ ] **Step 1: Write the failing tests** in `packages/kernel-bridge/tests/metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StageRecorder } from "../src/metrics";
import { bridgeResponseSchema } from "../src/protocol";

describe("StageRecorder", () => {
  it("accumulates per-stage nanoseconds and reports peak RSS in bytes", () => {
    const recorder = new StageRecorder();
    const value = recorder.time("hydrate", () => {
      let sink = 0;
      for (let index = 0; index < 100_000; index += 1) sink += index;
      return sink;
    });
    expect(value).toBeGreaterThan(0);
    const metrics = recorder.finish();
    expect(metrics.hydrateNs).toBeGreaterThan(0);
    expect(metrics.totalNs).toBeGreaterThanOrEqual(metrics.hydrateNs!);
    expect(metrics.peakRssBytes).toBeGreaterThan(0);
    expect(metrics.peakRssBytes % 1024).toBe(0); // KiB → bytes conversion
    expect(metrics.analyzeNs).toBeUndefined();
  });

  it("records a stage even when the bracketed function throws", () => {
    const recorder = new StageRecorder();
    expect(() =>
      recorder.time("validate", () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(recorder.finish().validateNs).toBeGreaterThan(0);
  });
});

describe("bridge response metrics field", () => {
  // Copy a currently-valid error-response fixture from this package's existing
  // worker/protocol tests as `base` — do not invent the binding shape.
  it("accepts absent metrics, valid metrics, and rejects unknown members", () => {
    /* base = <copied fixture>; three bridgeResponseSchema.parse assertions:
       base ok; {...base, metrics:{totalNs:5,peakRssBytes:1024,hydrateNs:3}} ok;
       {...base, metrics:{totalNs:5,peakRssBytes:1024,bogus:1}} throws. */
  });
});
```

- [ ] **Step 2: Run to verify failure.** `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test -- metrics` → FAIL.
- [ ] **Step 3: Implement `metrics.ts`** (`WORKER_STARTED = process.hrtime.bigint()` module constant; `time()` accumulates per stage via `Map<string, bigint>` in a `finally`; `finish()` returns `{ totalNs: Number(now - WORKER_STARTED), peakRssBytes: process.resourceUsage().maxRSS * 1024, ...perStageNs }` — `resourceUsage()` is called only inside `finish()`, so a never-finished recorder costs nothing).
- [ ] **Step 4: Schema + optional-parameter threading.** Add schema/type to `protocol.ts`; add the optional `recorder` parameter to `buildValidateCandidate` / `buildValidateCandidateInScratch` / `analyzeIntent` with bracketing:
  - candidate: `db = recorder ? recorder.time("hydrate", () => hydrateSnapshot(...)) : hydrateSnapshot(...)` — or, cleaner, a local `const bracket = <T>(stage, fn) => (recorder ? recorder.time(stage, fn) : fn());` used at all four sites (`hydrate` around `hydrateSnapshot` (candidate.ts:55), `mutate` around the intent loop, `validate` around the `commit`/`commitWithBehavioralGate` expression (candidate.ts:112-121), `export` around `exportSnapshot`+`diffSnapshots` (candidate.ts:146-157)). Control flow, error paths, and thrown values are unchanged — `time()` re-throws.
  - analyze: `hydrate` around its `hydrateSnapshot` (analyze.ts:54), `analyze` around the rest of the body.
- [ ] **Step 5: Worker opt-in + bound-preserving attach** in `worker.ts`:

```ts
const emitMetrics = process.argv.includes("--emit-metrics");
const recorder = emitMetrics ? new StageRecorder() : undefined;
```

  Thread `recorder` into `dispatch`/handlers (update `WorkerHandlers` signatures). In `emitResponse` (worker.ts:149-173) the existing logic is untouched for the semantic frame: serialize, apply the 16 MiB bound with the existing `responseTooLarge` substitution, exactly as today. Then, only if a recorder exists: build `const withMetrics = serializeFrame({ ...finalResponse, metrics: recorder.finish() });` and emit `withMetrics` **only if** `Buffer.byteLength(withMetrics) <= MAX_RESPONSE_BYTES`, else emit the already-validated semantic frame unchanged. (Implementation note: restructure `emitResponse` so the chosen semantic frame and its response object are both in hand before the metrics attach; the metrics-bearing frame is a strict superset and never replaces a semantic decision.)
- [ ] **Step 6: Run** the new test + `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test` → all PASS. Existing worker-shape tests must pass **unchanged** (no `--emit-metrics` in their argv → byte-identical responses); add one new worker-level test spawning/invoking `runOneShotWorker` the way the existing worker tests do, with `process.argv` including `--emit-metrics`, asserting the response carries `metrics` with `hydrateNs > 0`.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(kernel-bridge): opt-in worker stage metrics behind --emit-metrics, semantic frame untouched"`

---

### Task 3: Bridge run recording — spawn-anchored counter, terminal records, observer context

**Files:**
- Modify: `crates/strata-kernel/src/bridge/process.rs` (config flag, spawn counter, terminal records, serialize timing)
- Create: `crates/strata-kernel/src/bridge/observer.rs` (thread-local run context + `WorkerRunMetrics`)
- Modify: `crates/strata-kernel/src/bridge/provider.rs`, `executor.rs` (context: snapshot bytes/build ns; phase comes from Task 4's guards)
- Modify: `crates/strata-kernel/src/kernel.rs` (drain + counter accessors)
- Test: `#[cfg(test)]` in `process.rs`/`observer.rs` (stub-worker pattern already used by `process.rs` tests)

**Interfaces:**
- Produces:
  - `NodeBridgeConfig` gains `pub(crate) collect_metrics: bool` (default `false` in every constructor; `pub fn with_metrics_collection(mut self, collect: bool) -> Self` builder). When true, `run()` appends `--emit-metrics` to the spawned command's arguments (after `self.config.arguments`).
  - `bridge/observer.rs`: `pub struct WorkerRunMetrics { pub request_kind: String, pub change_set_id: String, pub phase: &'static str, pub outcome: &'static str, pub bridge_wall_ns: u64, pub snapshot_bytes: u64, pub total_request_bytes: u64, pub snapshot_build_ns: u64, pub request_serialize_ns: u64, pub response_bytes: u64, pub worker: Option<WorkerSelfMetrics> }` (derive `Clone, Debug, PartialEq, Eq, Serialize` with camelCase); thread-local context API:

```rust
pub(crate) struct RunContextGuard { /* restores previous on Drop */ }
pub(crate) fn enter_phase(phase: &'static str) -> RunContextGuard;
pub(crate) fn set_request_build(snapshot_bytes: u64, snapshot_build_ns: u64); // no-op without an active collector
pub(crate) fn current_phase() -> &'static str; // "unattributed" default
```

  - `NodeBridgeProcess`: `worker_starts: AtomicU64` incremented **immediately after successful `Command::spawn`** (process.rs:124); `run_metrics: Mutex<Vec<WorkerRunMetrics>>`; `pub(crate) fn take_worker_run_metrics(&self) -> Vec<WorkerRunMetrics>`; `pub(crate) fn worker_starts_total(&self) -> u64`. The existing `#[cfg(test)] run_count` (attempt counter, pre-spawn) stays test-only under its current name.
  - `Kernel`: `pub fn take_worker_run_metrics(&self) -> Vec<WorkerRunMetrics>`, `pub fn worker_starts_total(&self) -> u64` (empty/0 without a node bridge). No feature gate — production observability surface.
- Consumes: Task 1's `metrics_ref()`; the request structs' `change_set_id` (`bridge/protocol.rs:426,521`) and kind.

- [ ] **Step 1: Write the failing tests** (stub-worker pattern from `process.rs` tests):
  - success run with a stub emitting a `metrics` block → one record: `outcome == "ok"`, `total_request_bytes > 0`, `bridge_wall_ns > 0`, `request_serialize_ns > 0`, `worker.unwrap().total_ns == <stub value>`, `phase == "unattributed"`, `change_set_id` matches the request; second `take` → empty; `worker_starts_total() == 1`.
  - timeout run (stub sleeps past a short deadline) → record with `outcome == "timedOut"`, `worker.is_none()`; `worker_starts_total() == 2`.
  - `collect_metrics == false` (default config) → `take_worker_run_metrics()` empty, `worker_starts_total()` still counts, spawned argv does NOT contain `--emit-metrics`; with `collect_metrics == true` argv DOES (assert via a stub that echoes its argv into the response or stderr).
  - `enter_phase` guard: records made inside `enter_phase("candidate")` carry `"candidate"`; after the guard drops, `"unattributed"`.
- [ ] **Step 2: Run to verify failure.** `cargo test -p strata-kernel bridge` → FAIL.
- [ ] **Step 3: Implement.**
  - Recording must cover **every** post-spawn exit path of `run()` (process.rs:103-275 has many). Restructure: after the spawn succeeds and the counter increments, delegate the remainder to an inner `run_spawned(...) -> (Result<BridgeResponse>, &'static str /* outcome */)` (or classify at the existing single-exit points: map `timed_out → "timedOut"`, writer error → `"writeFailed"`, stderr/stdout over-limit → `"stderrOverLimit"`/`"responseOverLimit"`, nonzero status → `"nonzeroExit"`, `parse_bridge_response` error → `"parseFailed"`, other lifecycle errors → `"lifecycleError"`, success → `"ok"`). Exactly one record per spawn, pushed when `collect_metrics` (poisoned-lock → skip recording, never error).
  - `request_serialize_ns`: bracket `serialize_bridge_request` (process.rs:106). `snapshot_bytes`/`snapshot_build_ns`: taken from the thread-local context (set in Step 4); 0 when unset.
  - `provider.rs`/`executor.rs`: when the client's config collects, bracket request construction (provider.rs:42-64, executor.rs:32-79) with `Instant` and compute `snapshot_bytes = serde_json::to_vec(&<the snapshot field>)?.len() as u64` (this extra serialization happens **only when collecting**); call `set_request_build(...)` before `self.client.run(&request)`.
- [ ] **Step 4: Feature matrix** → PASS (existing tests that used `run_count()` unchanged).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel): spawn-anchored worker-run records with outcome, phase context, and snapshot byte/build costs"`

---

### Task 4: In-kernel stage timing — phases, retry-accumulated publication, seed/recovery

**Files:**
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs` (phase guards at submit analysis ~:224-227 and claim planning ~:352-358)
- Modify: `crates/strata-kernel/src/coordination/publication.rs` (phase guards at pre-candidate analysis :363-369, post-candidate planning :436-454, candidate build :375-399; retry-accumulated timings through `PublicationExecution` :695-721; report construction :732-780)
- Modify: `crates/strata-kernel/src/kernel.rs` (`PublicationReport`, `RecoveryReport` fields; seed/open timing at :138-193 and :250-324)
- Modify: `crates/strata-kernel/src/storage.rs` (`seed` returns snapshot bytes :119; `latest_snapshot` returns encoded length :648-668; `PublishOutcome::Published` gains `core_graph_record_value_bytes` from :345-390)
- Test: existing publication/recovery suites (locate via `persistence_ns` / `replayed_operations` in `crates/strata-kernel/tests/`), plus unit mods

**Interfaces:**
- Produces:
  - `PublicationReport` gains `pub pre_candidate_analysis_ns: u128, pub post_candidate_analysis_ns: u128, pub candidate_ns: u128, pub core_graph_record_value_bytes: u64` (existing `persistence_ns`/`memory_publish_ns` unchanged). **All four timing fields are accumulated across optimistic-retry attempts of the same publication** via new observer-only fields on `PublicationExecution` (e.g. `accumulated: AttemptTimings { pre_candidate_analysis_ns, post_candidate_analysis_ns, candidate_ns }`) threaded through the recursion at publication.rs:695-721 — a retried publication reports the **sum** of all its attempts' analysis time plus the original candidate build time; `candidate_ns` is 0 only for `coordination-test-api` pre-validated sources (comment this at the construction site). `AlreadyPublished` reports carry zeros.
  - `RecoveryReport` gains `pub open_ns: u128, pub replay_ns: u128, pub seed_ns: u128, pub snapshot_bytes: u64` (create path: `replay_ns: 0`, `seed_ns` = measured `store.seed` bracket, `snapshot_bytes` = seed's returned encoded length; open path: `seed_ns: 0`, `replay_ns` = replay-loop bracket, `snapshot_bytes` = `latest_snapshot`'s returned encoded length; `open_ns` = whole open/create body, both paths).
  - `DurableStore::seed` returns `Result<u64>` (encoded snapshot length — `snapshot_bytes.len()` at storage.rs:119); `latest_snapshot` returns `Result<(GraphSnapshot, u64)>` (encoded length measured where the bytes are read, storage.rs:648-668) — update its callers.
  - `PublishOutcome::Published { generation, core_graph_record_value_bytes: u64 }` — the sum of the four encoded record lengths (`operation+delta+ticket+event`) from `write_graph_publication_in_txn_with_hook` (return type becomes `Result<(u64, u64)>`); threaded through `publish_inner` (storage.rs:182) and `publish_coordinated` (storage.rs:231). Six construct/match sites total incl. `kernel.rs:701`, `publication.rs:752`, redb-spike bin.
  - Phase guards (from Task 3's `observer.rs`): `let _phase = enter_phase("submitAnalysis");` around `analyze_change_set` in the submit path (coordinator.rs:226); `"claimAnalysis"` around `plan_change_set` in claim (coordinator.rs:357); `"preCandidateAnalysis"` around publication.rs:368; `"candidate"` around the `build_candidate` catch_unwind block (publication.rs:385-399); `"postCandidateAnalysis"` around `plan_change_set` at publication.rs:453. Guards are RAII locals — zero control-flow change.
- Consumed by: Task 5's records; Task 6's profile.

- [ ] **Step 1: Write the failing tests.**
  - Publication suite (the test already asserting on a `PublicationReport`): `assert!(report.pre_candidate_analysis_ns > 0); assert!(report.core_graph_record_value_bytes > 0);` plus one targeted test where the (in-process) executor sleeps ≥1 ms → `candidate_ns > 0`, and — reusing the existing optimistic-retry test choreography (the suite that exercises `MAX_OPTIMISTIC_RETRIES`/requeue) — a retried publication's report has `pre_candidate_analysis_ns` strictly greater than a single-attempt baseline's (accumulation observable) and `candidate_ns > 0` (not reset by retry).
  - Recovery suite: after one publication + reopen — `replay_ns > 0`, `snapshot_bytes > 0`, `open_ns >= replay_ns`, `seed_ns == 0`; on the create path — `seed_ns > 0`, `replay_ns == 0`, `snapshot_bytes > 0`.
  - Phase guards: a kernel-level test with the node-bridge stub (or unit test at the call-site level) asserting a submit's analyze runs record `phase == "submitAnalysis"` — if only feasible in the ignored node-bridge integration tests, put it there and mark accordingly.
- [ ] **Step 2: Run to verify failure.** Feature matrix → FAIL (unknown fields).
- [ ] **Step 3: Implement** per the interface block. Fix every construct/match site across the crate (including `src/bin/redb_spike.rs`).
- [ ] **Step 4: Feature matrix** → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel): phase-tagged analysis, retry-accumulated publication timing, seed/replay measurement"`

---

### Task 5: Daemon `--metrics` JSONL sink

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/metrics.rs`
- Modify: `main.rs` (flag + config plumbing incl. `NodeBridgeConfig.with_metrics_collection`), `session.rs` (config field, `ExecutedEffect.publication`, emission)
- Modify: `crates/strata-kernel/Cargo.toml` (add `libc = "0.2"`)
- Test: `crates/strata-kernel/tests/local_service_metrics.rs` (new; default-feature build, ungated)

**Interfaces:**
- Produces:
  - `MetricsSink` (metrics.rs): `open(path: &Path) -> Result<MetricsSink>` (create/truncate; open failure fails startup), `emit(&mut self, record: &MetricsRecord)` (serialize + `\n` + flush, no fsync; serialization errors swallowed); `MetricsRecord` enum, serde `#[serde(tag = "kind", rename_all = "camelCase")]`, variants `Recovery`/`WorkerRun`/`Request` matching the Shared-vocabulary shapes exactly (`seq: u64` stamped by the sink from its own `AtomicU64`).
  - `peak_rss_bytes() -> u64` in metrics.rs via `libc::getrusage(RUSAGE_SELF)`:

```rust
pub(super) fn peak_rss_bytes() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let max_rss = unsafe { usage.assume_init() }.ru_maxrss.max(0) as u64;
    #[cfg(target_os = "macos")]
    { max_rss }
    #[cfg(not(target_os = "macos"))]
    { max_rss.saturating_mul(1024) }
}
```

  - `ServiceConfig` gains `pub metrics_path: Option<PathBuf>`; `ServiceSession` holds `metrics: Option<Mutex<MetricsSink>>`.
  - `ExecutedEffect` (session.rs:1051) gains `publication: Option<PublicationReport>`; `ExecutedEffect::response(...)` sets `None`; a new constructor/`with_publication(report)` used at the `Published` arm of `advance()` (session.rs:645-651). **No global `last_publication` slot** — the report travels with the effect to the emission point, so concurrent requests cannot cross-attribute.
  - Emission points: at the response-return sites of `handle_request` (read path, session.rs:184-198) and where `handle_mutation`'s `ExecutedEffect` is resolved to a response — when the sink exists: first `for run in self.kernel.take_worker_run_metrics() { emit WorkerRun }` (records are self-attributed via `changeSetId`+`phase`; the drain point is incidental and a code comment must say so), then one `Request` record `{ action: <wire action name — add a small action_name(&RequestAction) -> &'static str helper>, wall_ns: started.elapsed().as_nanos(), daemon_peak_rss_bytes: peak_rss_bytes(), publication: effect.publication.map(into_record) }`. Idempotent-replay short-circuits (session.rs:225-235) may skip emission — comment that replays are unmeasured by design (they do no coordination work).
  - `ServiceSession::open` (session.rs:71-110): bracket the `Kernel::open_with_node_bridge`/`create_with_node_bridge` call; emit one `Recovery` record from the `RecoveryReport` + `recovered` flag (the report now carries `open_ns`/`replay_ns`/`seed_ns`/`snapshot_bytes` from Task 4).
  - `main.rs`: `"--metrics"` added to `allowed` (main.rs:53-60, unconditional — production surface); optional value (add an `optional_path` helper beside `required_path`); when present, `bridge_config = bridge_config.with_metrics_collection(true)` before `server::serve`, and `metrics_path` into `ServiceConfig`.
- Consumes: Tasks 3–4 types.

- [ ] **Step 1: Write the failing integration test** `local_service_metrics.rs` (copy an existing `local_service*` harness): daemon with `--metrics <tmp>/cold.jsonl`, run the minimal lifecycle (hello → begin → add_intent → submit → advance to published), SIGTERM, parse, assert:
  - one `recovery` record: `recovered == false`, `openNs > 0`, `seedNs > 0`, `replayNs == 0`, `snapshotBytes > 0`;
  - ≥1 `workerRun` with `phase == "submitAnalysis"` and ≥1 with `phase == "candidate"`; every record `outcome == "ok"`, `totalRequestBytes > 0`, `snapshotBytes > 0`, `worker.totalNs > 0`, `worker.hydrateNs > 0`; the candidate record has `worker.validateNs > 0`;
  - `request` records for submit and each advance: `wallNs > 0`, `daemonPeakRssBytes > 0`; exactly one has `publication` non-null with `persistenceNs > 0`, `preCandidateAnalysisNs > 0`, `candidateNs > 0`, `coreGraphRecordValueBytes > 0`;
  - `seq` strictly increasing;
  - restart on the same directory with `--metrics <tmp>/restart.jsonl` → `recovery` record with `recovered == true`, `replayNs > 0`, `seedNs == 0`, `replayedOperations == 1`, `snapshotBytes > 0`;
  - a run WITHOUT `--metrics` writes no metrics file AND its worker spawns carry no `--emit-metrics` (assert indirectly: responses still parse; optionally assert via the audit/absence of the file only — keep it simple: file absence).
- [ ] **Step 2: Run to verify failure.** `cargo test -p strata-kernel --test local_service_metrics` → FAIL (`--metrics` rejected).
- [ ] **Step 3: Implement** per interfaces.
- [ ] **Step 4: Run** the new test + feature matrix + `PATH=/opt/homebrew/bin:$PATH pnpm kernel:gate1:test` (gate-1 must stay green with metrics off) → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(kernel-service): opt-in --metrics JSONL sink; publication report carried on ExecutedEffect"`

---

### Task 6: Gate-2 profile runner (`packages/live-compare/src/gate2.ts`)

**Files:**
- Create: `packages/live-compare/src/gate2.ts`
- Modify: `packages/live-compare/src/gate1.ts` only to export existing flow helpers if module-private (no behavior change)
- Test: `packages/live-compare/tests/gate2Profile.unit.test.ts` (pure parser/builder)

**Interfaces:**
- Produces:
  - `parseMetricsJsonl(text: string): MetricsRecord[]` — zod-validated union of the three record kinds (unknown kind → throw).
  - `buildGate2Profile(records: MetricsRecord[]): Gate2Profile` — pure; throws on: zero or >1 publications, missing cold or restart recovery, any `workerRun.outcome !== "ok"`.
  - `runGate2KernelFlow(corpusRoot: string): Promise<{ records: MetricsRecord[]; profile: Gate2Profile }>` — `startKernelService(corpus, { directory, extraArgs: ["--metrics", coldPath] })` → hello → `find_declarations` (T03 target) → begin → add_intent (rename) → submit (deadline ≥30.1 s + margin, gate-1 values) → advance until published (deadline ≥60.1 s) → read_operation → `stop({ preserveDirectory: true })` → `startKernelService(corpus, { directory, extraArgs: ["--metrics", restartPath] })` → hello → stop → concatenate cold+restart JSONL → parse → build.
  - `writeGate2Artifacts(profile, records, outDir, options?: { deterministicName?: boolean })` — `gate2-profile-<ISO>.{json,md}` by default (local reruns, gitignored `packages/live-compare/results/`), or `gate2-observability-profile.{json,md}` with `deterministicName: true` (Task 8 commits those under `docs/spikes/`). The Markdown table: one row per review category (stage, measured value(s), source record kind), with `coreGraphRecordValueBytes` explicitly footnoted as the four graph-record value bytes only — not total transaction or physical redb bytes.
  - `Gate2Profile`:

```ts
export interface Gate2Profile {
  seed: { snapshotBytes: number; seedNs: number };
  requests: Array<{ action: string; wallNs: number; daemonPeakRssBytes: number }>;
  workerRuns: Array<{
    requestKind: "analyzeIntent" | "buildValidateCandidate";
    changeSetId: string;
    phase: string;
    outcome: string;
    bridgeWallNs: number;
    snapshotBytes: number;
    totalRequestBytes: number;
    snapshotBuildNs: number;
    requestSerializeNs: number;
    responseBytes: number;
    worker: { hydrateNs?: number; analyzeNs?: number; mutateNs?: number; validateNs?: number; exportNs?: number; totalNs: number; peakRssBytes: number } | null;
  }>;
  publication: { generation: number; preCandidateAnalysisNs: number; postCandidateAnalysisNs: number; candidateNs: number; persistenceNs: number; memoryPublishNs: number; coreGraphRecordValueBytes: number };
  recovery: { cold: RecoveryLeg; restart: RecoveryLeg };
  totals: { workerStarts: number; daemonPeakRssBytes: number; maxWorkerPeakRssBytes: number };
}
export interface RecoveryLeg { recovered: boolean; openNs: number; replayNs: number; seedNs: number; replayedOperations: number; snapshotBytes: number }
```

  (`totals.workerStarts` = workerRun record count; `seed` derives from the cold recovery record's `seedNs`/`snapshotBytes`.)
- Consumes: Tasks 1–5 record shapes; `startKernelService` (`service.ts` — `extraArgs` suffices, no change); gate-1 flow helpers.

- [ ] **Step 1: Write the failing parser/builder unit test** with a hand-written JSONL fixture (one of each kind, Shared-vocabulary values): field-by-field profile assertions; malformed line → throw; two publications → throw; missing restart recovery → throw; a `workerRun` with `outcome: "timedOut"` → throw.
- [ ] **Step 2: Run to verify failure.** `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test -- gate2Profile` → FAIL.
- [ ] **Step 3: Implement `gate2.ts`.**
- [ ] **Step 4: Run unit test** → PASS; build kernel-bridge + live-compare.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(live-compare): gate-2 observability profile runner, parser, and artifacts"`

---

### Task 7: Gate-2 acceptance suite + scripts

**Files:**
- Create: `packages/live-compare/tests/gate2Observability.test.ts`
- Modify: root `package.json` (`kernel:gate2:test`; extend `kernel:full-key-free:test`)

**Interfaces:** Consumes Task 6's exports.

- [ ] **Step 1: Write the acceptance test** — the gate oracle; eight numbered categories + cross-invariants; 300 s timeout:

```ts
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { runGate2KernelFlow, writeGate2Artifacts } from "../src/gate2.js";

const repoRoot = resolve(__dirname, "../../..");

describe("gate 2: per-stage observability profile (key-free)", () => {
  it("produces a complete, internally consistent kernel-arm T03 profile", async () => {
    const { records, profile } = await runGate2KernelFlow(join(repoRoot, "examples/medium"));

    // 1. Per-stage wall time
    const submit = profile.requests.find((request) => request.action === "submit_change_set")!;
    const advances = profile.requests.filter((request) => request.action === "advance_change_set");
    expect(submit.wallNs).toBeGreaterThan(0);
    expect(advances.length).toBeGreaterThan(0);
    for (const advance of advances) expect(advance.wallNs).toBeGreaterThan(0);

    // 2. Peak memory (daemon + worker)
    expect(profile.totals.daemonPeakRssBytes).toBeGreaterThan(1024 * 1024);
    expect(profile.totals.maxWorkerPeakRssBytes).toBeGreaterThan(1024 * 1024);

    // 3. Serialized snapshot bytes: seed, per-worker request (snapshot vs total), recovery
    expect(profile.seed.snapshotBytes).toBeGreaterThan(0);
    for (const run of profile.workerRuns) {
      expect(run.snapshotBytes).toBeGreaterThan(0);
      expect(run.totalRequestBytes).toBeGreaterThanOrEqual(run.snapshotBytes);
    }
    expect(profile.recovery.restart.snapshotBytes).toBeGreaterThan(0);

    // 4. Node-worker starts, phase-attributed, all clean
    expect(profile.totals.workerStarts).toBe(profile.workerRuns.length);
    for (const run of profile.workerRuns) expect(run.outcome).toBe("ok");
    const phases = new Set(profile.workerRuns.map((run) => run.phase));
    for (const phase of ["submitAnalysis", "claimAnalysis", "preCandidateAnalysis", "postCandidateAnalysis", "candidate"]) {
      expect(phases).toContain(phase);
    }

    // 5. SQLite hydration time (inside the worker)
    for (const run of profile.workerRuns) expect(run.worker!.hydrateNs).toBeGreaterThan(0);

    // 6. Validation time (candidate tsc gate)
    const candidate = profile.workerRuns.find((run) => run.phase === "candidate")!;
    expect(candidate.worker!.validateNs).toBeGreaterThan(0);

    // 7. redb publication time (+ honestly-scoped record bytes)
    expect(profile.publication.persistenceNs).toBeGreaterThan(0);
    expect(profile.publication.memoryPublishNs).toBeGreaterThanOrEqual(0);
    expect(profile.publication.preCandidateAnalysisNs).toBeGreaterThan(0);
    expect(profile.publication.postCandidateAnalysisNs).toBeGreaterThan(0);
    expect(profile.publication.candidateNs).toBeGreaterThan(0);
    expect(profile.publication.coreGraphRecordValueBytes).toBeGreaterThan(0);

    // 8. Restart replay time
    expect(profile.recovery.cold.recovered).toBe(false);
    expect(profile.recovery.cold.seedNs).toBeGreaterThan(0);
    expect(profile.recovery.restart.recovered).toBe(true);
    expect(profile.recovery.restart.replayedOperations).toBe(1);
    expect(profile.recovery.restart.replayNs).toBeGreaterThan(0);

    // Cross-invariants
    for (const run of profile.workerRuns) {
      if (run.worker !== null) expect(run.bridgeWallNs).toBeGreaterThanOrEqual(run.worker.totalNs);
    }
    const publishingAdvanceWall = Math.max(...advances.map((advance) => advance.wallNs));
    expect(publishingAdvanceWall).toBeGreaterThanOrEqual(profile.publication.persistenceNs);
    expect(profile.publication.candidateNs).toBeGreaterThanOrEqual(candidate.bridgeWallNs);

    const artifacts = writeGate2Artifacts(profile, records, join(repoRoot, "packages/live-compare/results"));
    expect(artifacts.jsonPath).toContain("gate2-profile-");
  }, 300_000);
});
```

  (Adjust call signatures to Task 6's actuals; the eight categories, the phase-coverage assertion, the all-`ok` outcome assertion, and the cross-invariants are the acceptance content and must survive.)
- [ ] **Step 2: Build + run.** `pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel --bin strata-kernel-service`, then `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test -- gate2` → PASS.
- [ ] **Step 3: Scripts.** Root `package.json`: `"kernel:gate2:test"` mirroring `kernel:gate1:test`'s build prelude (package.json:17) with `test gate2`; append `&& pnpm kernel:gate2:test` to `kernel:full-key-free:test` (package.json:16).
- [ ] **Step 4: Full verification.** `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` then `PATH=/opt/homebrew/bin:$PATH pnpm -r test` → all green.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(gate2): per-stage observability acceptance suite and kernel:gate2:test script"`

---

### Task 8: Record the gate — evidence artifact, decisions.md, roadmap, design note

**Files:**
- Create: `docs/spikes/gate2-observability-profile.json` + `.md` (deterministic names — committed evidence; `packages/live-compare/results/*` stays gitignored for reruns)
- Modify: `decisions.md` (new top entry), `docs/product-roadmap.md`, `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md` (gate-map bullet)

- [ ] **Step 1: Produce the committed evidence.** Run the gate-2 flow once via a small script call or the acceptance test with `writeGate2Artifacts(profile, records, "docs/spikes", { deterministicName: true })` (add a tiny `packages/live-compare/src/bin`-style invocation or a one-off node call — whatever is smallest; do NOT weaken `.gitignore` for `results/`). Verify `git status` shows the two `docs/spikes/` files as addable.
- [ ] **Step 2: decisions.md entry** (top, actual date): the gate-2 contract (review §4 item 2 quoted); the chosen architecture (opt-in end-to-end `--metrics` → `collect_metrics` → `--emit-metrics`; semantic-frame-first response bound; consumer-before-producer landing; phase-tagged worker records with spawn-anchored counting and terminal outcome classes; `ExecutedEffect`-carried publication report; retry-accumulated timings; `coreGraphRecordValueBytes` honesty rename; `getrusage`/`resourceUsage` unit normalization); the independent review round (1 blocker + 7 majors + 1 minor, all source-verified and incorporated — link both review files); headline profile numbers from the committed artifact stated as examples/medium N=1 observations, not claims; residuals (full-transaction byte accounting deferred to gate 3 if needed; idempotent replays unmeasured by design; submit/claim in-process analysis residual not separately timed — covered via phase-tagged worker runs + request walls; gate 3 owns percentile methodology and the ~1k-module corpus).
- [ ] **Step 3: Roadmap + design-doc lines.** Roadmap (under the gate-1 PASS line): `Gate 2 PASS (key-free), <date>. Evidence: packages/live-compare/tests/gate2Observability.test.ts via pnpm kernel:gate2:test; committed profile: docs/spikes/gate2-observability-profile.md. Gate 3 (unkeyed noninferiority) is next; no keyed spend before gate 5 approval.` — slice-A checkbox stays unchecked. Design doc gate-map Gate 2 bullet: append `(landed <date>, plan: 2026-07-19-iteration6-slice-a-gate2.md)`.
- [ ] **Step 4: Commit + push.** `git add -A && git commit -m "docs: gate 2 (per-stage observability) recorded — slice A continues at gate 3" && git push`

## Self-review notes (v2)

- All nine review findings mapped: F1→Tasks 1/2 ordering + opt-in + bound handling; F2→Task 3 snapshot/total bytes + build/serialize timing; F3→Task 3 observer context + Task 4 phase guards + acceptance phase-coverage; F4→Task 5 `ExecutedEffect.publication` + tag-attribution constraint; F5→Task 4 retry accumulation + retained `candidateNs >= bridgeWallNs` invariant (now valid because `candidate_ns` accumulates); F6→Task 3 spawn-anchored counter + terminal outcome records + acceptance all-`ok`; F7→`coreGraphRecordValueBytes` rename + footnote + residual; F8→Task 8 deterministic `docs/spikes/` evidence; F9→Task 4 `seed_ns` + storage-returned lengths.
- Type consistency: camelCase/snake_case pairs checked across TS zod, Rust serde, JSONL records, and `Gate2Profile`.
- The only wire-adjacent change is the daemon-internal bridge stdout envelope (optional field, consumer-first) and the worker argv flag; the agent-visible socket protocol is untouched by construction.
