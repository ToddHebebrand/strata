# Independent review brief — slice A gate 2 (per-stage observability) plan

**Reviewer task:** adversarially review the implementation plan at
`docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md` before any code
is written. Read the plan, the governing docs, and the actual source anchors it
cites. Report blockers (plan would build the wrong thing, violate a hard
constraint, or encode a false claim about the code), majors (plan would land
but with a real defect or measurement-validity gap), and minors. For every
claim you make about existing code, cite file:line.

## Governing frame (read these)

1. `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4
   item 2 — the gate-2 contract: record per-stage wall time, peak memory,
   serialized snapshot bytes, Node-worker starts, SQLite hydration time,
   validation time, redb publication time, restart replay time. Purpose:
   distinguish coordination semantics from bridge mechanics before keyed spend.
2. `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md`
   — gate map ("Gate 2: … Instrumentation lands on both the daemon and the
   bridge; no keyed spend"), falsifiers, out-of-scope list.
3. `docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md` — the
   gate-1 plan whose conventions (constraints block, green-claim commands,
   feature matrix) gate 2 inherits. Gate 1 is merged and green on main.

## Hard constraints the plan claims to honor (verify it actually does)

- Observability is observer-only: no change to scope inference, fresh
  analysis, validation binding, reservations, fenced publication, scheduler
  decisions, or any digest input (falsifier 1 kills the slice otherwise).
- Zero agent-visible wire change: the Unix-socket protocol
  (`crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`) gains
  nothing; gate 3 forbids extra agent-visible lifecycle calls and gate 5
  compares token cost.
- The hash-chained audit journal (`audit.rs`) is untouched; metrics get a
  separate non-fsynced JSONL sink behind an optional `--metrics` flag.
- Key-free; no persisted SQLite in the kernel arm; feature-matrix testing;
  green claims only via `pnpm kernel:full-key-free:test` + `pnpm -r test`.
- Gate 2 produces kernel-arm observations only; cross-arm comparison
  methodology is explicitly gate 3.

## Decisions the plan makes (the review targets)

- **D-g2-1:** Worker self-reports stage timings + own peak RSS in an optional
  `metrics` field added to the daemon-internal bridge stdout envelope
  (`packages/kernel-bridge/src/protocol.ts` response schemas;
  `crates/strata-kernel/src/bridge/protocol.rs` structs with
  `deny_unknown_fields` + `#[serde(default)]`). Rejected: threading metrics
  through `CandidateEnvelope` (digest-adjacency risk).
- **D-g2-2:** The Rust bridge (`bridge/process.rs`) gains an always-compiled
  run counter (promoting the current `#[cfg(test)] run_count`) and an
  interior-mutability `Vec<WorkerRunMetrics>` buffer with a drain exposed via
  `Kernel::take_worker_run_metrics()`; error-path runs are counted but not
  stage-attributed. Rejected: a metrics callback on `NodeBridgeConfig`
  (breaks Clone/Debug, couples config to sinks).
- **D-g2-3:** `PublicationReport` gains `analysis_ns`, `candidate_ns`,
  `publication_bytes`; `PublishOutcome::Published` carries
  `publication_bytes` = encoded operation+delta+ticket+event lengths
  (`storage.rs` `write_graph_publication_in_txn_with_hook`); `RecoveryReport`
  gains `open_ns`, `replay_ns`, `snapshot_bytes`. Note: publications write no
  full snapshot — the per-mutation "snapshot bytes" cost is the worker stdin
  request (full graph snapshot), measured as `request_bytes` per worker run;
  seed and recovery snapshot bytes are measured at their own sites.
- **D-g2-4:** Daemon-side sink: `--metrics <path>` (production flag, default
  off) writing per-request records (wall, `getrusage` peak RSS via new `libc`
  dep, drained worker runs, publication block), plus seed/recovery records
  emitted from `ServiceSession::open`. A `last_publication:
  Mutex<Option<PublicationReport>>` on the session carries the report from
  `advance()` to the emission point (observer-only state).
- **D-g2-5:** Gate oracle: `packages/live-compare/tests/gate2Observability.test.ts`
  asserts all eight categories present plus cross-invariants
  (`bridge_wall_ns >= worker.total_ns`, publishing-advance wall ≥
  `persistence_ns`, `candidate_ns >= bridge_wall_ns` of the candidate run);
  profile artifact committed under `packages/live-compare/results/`.

## Questions we specifically want pressure on

1. Measurement validity: does the chosen decomposition actually let gate 3
   separate "coordination semantics" from "bridge mechanics"? What stage or
   byte cost is missing or double-counted? (E.g. serialize/deserialize of the
   bridge request inside the daemon, `analyze` runs at submit time, scheduler
   time, socket framing.)
2. The bridge-envelope `metrics` field: any place where
   `deny_unknown_fields`, the zod `.strict()` schemas, response-byte bounds
   (`max_response_bytes`), or existing fixture tests make the optional field a
   breaking change the plan underestimates?
3. The `run_count` promotion and buffer: any concurrency or lifetime hazard
   (multiple concurrent requests share one `NodeBridgeProcess`?) that makes
   drain-per-request attribution wrong — e.g. a concurrent client B's worker
   run drained into client A's request record?
4. `PublishOutcome`/report field threading: does any call site (redb-spike
   bin, coordination tests, recovery paths) make the enum change more invasive
   than planned? Is `candidate_ns = 0` on optimistic-retry republication an
   acceptable semantic or a measurement lie?
5. `getrusage`/`resourceUsage` peak-RSS: platform-unit claims correct?
   (Plan asserts: Node maxRSS is KiB everywhere via libuv; macOS ru_maxrss
   bytes, Linux KiB.) Anything materially wrong for the darwin-primary,
   Linux-CI-possible reality?
6. The restart leg: does reusing `startKernelService` with
   `options.directory` + a second `--metrics` path actually exercise
   snapshot+replay recovery with exactly one replayed operation, per
   `session.rs`/`kernel.rs` recovery behavior?
7. Overhead honesty: is default-off truly zero-agent-visible-cost, and is the
   always-on buffer push per worker run acceptable, given gate-5 token/cost
   comparisons and gate-3 wall-time comparisons?
8. Anything in the plan that quietly weakens a gate-1 oracle or invariant
   (audit chain, digests, FIFO, idempotent replay)?

## Output format

Numbered findings, each: severity (Blocker/Major/Minor), claim, evidence
(file:line), and the concrete plan amendment you recommend. End with a
verdict: "plan ready" or "plan needs amendment" and the minimal amendment set.
