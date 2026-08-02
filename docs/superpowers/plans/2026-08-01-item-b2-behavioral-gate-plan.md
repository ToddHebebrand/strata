# Item B-2 — Behavioral Gate Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review — READY TO EXECUTE. The v1 methodology review
returned RE-GROUND (archive with in-session verification notes:
`docs/superpowers/specs/2026-08-01-item-b2-plan-review-codex.md`; brief:
`2026-08-01-item-b2-plan-review-brief.md`). v2 is a re-grounded rewrite:
all four Blockers and five Majors are constitutive here, not bolted on.
Governing spec: `docs/superpowers/specs/2026-07-31-item-b-design.md`
(Slice B-2 + Hard boundaries). Baseline: main ≥ ce93a06 (B-1 merged).

**Review corrections constitutive in v2** (numbering = the archive's):
1. (Blocker) `ValidationProfile` timeout fields are OPTIONAL/omitted on
   `TscOnly` and REQUIRED on `Behavioral` — the no-manifest wire stays
   byte-identical (the exact five-key pin in
   `full_key_free_acceptance.rs:1943` keeps passing untouched); a
   manifest-backed tscOnly profile may carry them.
2. (Blocker) Real PROCESS-GROUP supervision: new ASYNC bounded runners
   (`spawn` + `detached: true` + `kill(-pid, SIGKILL)`) used by the
   kernel-bridge behavioral/baseline paths; the candidate validate stage
   becomes async end-to-end in the worker. The sync product `commit` path
   is untouched. No `--pool=threads` substitute, no "divergence" framing.
3. (Blocker) Operational candidate failures RELEASE-AND-REQUEUE atomically
   (`Kernel::release_claim_for_retry`, modeled on the lease-expiry
   optimistic transition) so `retryable: true` is honest — a later
   `advance` genuinely re-drives; no strandable claim.
4. (Blocker) Persistent-path deadline split: the transport total =
   `QUEUE_ALLOWANCE_MS + candidate_deadline`, with typed transport PHASES
   (`Queued` / `Sync` / `Exchange`) on persistent-host errors so the
   executor classifies without string matching; queue/sync time can no
   longer consume the validation budget; existing persistent pins
   (`persistent.rs:1143`, `:1164`) preserved by explicit tests.
5. (Major) Semantic set = {`validate/typescriptFailed`,
   `validate/behavioralFailed`, `mutate/intentRejected`}. The worker
   gains `intentRejected` for KNOWN application rejections (pre-checked
   targets); residual `mutationFailed` (unexpected store/invariant
   errors) is OPERATIONAL. Unknown codes default operational.
6. (Major) Green-state fixes: Task 1's tests live in the protocol
   module (the parser is `pub(crate)`); Task 2 stages session.rs (the
   `Diagnostic` literal at ~811 must compile); Task 3's sweep names and
   stages `local_service_recovery.rs:915` and explicitly EXCLUDES
   `live-compare/src/runner.ts:25` (a benchmark category, not the
   fabricated diagnostic); Task 5 updates + stages
   `full_key_free_acceptance.rs`, `bridge_protocol.rs:91`, and
   `live-compare/tests/tasks.test.ts:268`.
7. (Major) Task 9 (timeout gate) proves rollback/health/rehydration with
   DISCRIMINATING observations: worker-start/rehydration/fallback
   counter deltas across the failed and follow-up requests, a
   deterministic pidfile-based group-kill proof, and a real
   requeue-re-drive assertion — not "later publication happened".
8. (Major) Seed-green runs for ANY supplied manifest (a tscOnly manifest
   gets its tsc baseline; only the no-manifest default skips);
   `service_started`/`service_recovered` audit finalization MOVES to
   after the baseline (a refusing daemon never audits a start); audit
   fields are optional/defaulted with a historical-line reopen test.
9. (Major) Manifest fixtures get CANONICAL containment (canonicalize root
   + fixture, containment before digesting, verified identity retained
   for reads) — a symlinked fixture cannot make the reader a general
   file reader.
10. (Minor) Disclosure counters are optional/omitted in tsc-only records;
    metrics implementation (Task 10) split from chain wiring + close
    (Task 11).
Also: the Task-9 lever fixture imports `../../src/users/greet.ts`
(verified real path; v1's `src/features/greet` was wrong), and the
`hello` fixture sweep updates NEGATIVE ready fixtures so they stay
discriminating.

**Goal:** Wire the kernel's commit gate honestly for behavioral
validation: typed candidate rejection carrying the worker's real
diagnostics, a committed digested validation manifest with a seed-green
startup invariant, safely nested subprocess deadlines with process-group
cleanup and timeout/savepoint recovery proofs, a manifest-pinned fixture
reader, and cost disclosure — while the no-manifest tsc-only default
stays byte-identical.

**Architecture:** The worker already types its failures; B-2 stops the
Rust side from collapsing them: a downcastable `CandidateRejected` flows
from `into_candidate_result`/the mirror router through `execute_claimed`
to the session, which maps real bounded diagnostics (corpus-relative
`modulePath`) onto the wire and reserves `ValidationFailed` for semantic
rejections; operational failures atomically release-and-requeue and
return retryable `candidate_execution_failed`. A per-corpus manifest
(`--validation-manifest`, single flag) governs mode, fixtures (canonical
containment), strict tsc scope, and subprocess deadlines; any
manifest-backed daemon refuses to serve on a red generation-zero
baseline; the manifest digest rides readiness/audit/hello. Two read-only
client actions expose the registered fixtures, digest-pinned.

**Tech Stack:** Rust (strata-kernel crate + service bin, serde, anyhow
downcast, thiserror-style typed errors), TypeScript (kernel-bridge async
validation pipeline, zod bridge schemas, live-compare client/protocol/
tools, Vitest), shared golden fixtures, pnpm gate scripts.

## Global Constraints

- **No-manifest tsc-only default byte-identical (spec, hard).** Without
  `--validation-manifest`: same `NodeBridgeConfig::tsc_only`, same 30s
  deadlines, same wire bytes, same audit sequencing for the start event
  relative to bind (see Task 7's sequencing note), and
  `full_key_free_acceptance.rs`'s exact five-key profile pin passes
  UNMODIFIED. Every task keeps the pre-B-2 suites green except where a
  task explicitly lists a test update.
- **Semantic/operational partition (fail-closed):** semantic =
  {`validate/typescriptFailed`, `validate/behavioralFailed`,
  `mutate/intentRejected`} → SUCCESS response, state
  `validation_failed`, REAL bounded diagnostics, cancel follow-up.
  EVERYTHING else — including unknown future codes, `mutationFailed`,
  `candidateFinalizeFailed`, `tscTimedOut`, `vitestTimedOut`, transport,
  spawn, poison — is OPERATIONAL → atomic release-and-requeue + error
  response `candidate_execution_failed`, `retryable: true`; a later
  `advance` re-drives. The `candidate_validation_failed` fabrication is
  retired. `OptimisticRetryExhausted` arm untouched.
- **A validation timeout is NEVER auto-replayed through the one-shot
  fallback**: mirror candidate errors with timeout codes AND
  `Exchange`-phase transport timeouts on candidate frames surface as
  operational; only `Queued`-phase failures (worker untouched — the
  existing pinned semantics) may fall back one-shot.
- **Manifest:** ONE `--validation-manifest <path>`; defines mode
  (`tscOnly`|`behavioral`), fixtures (unique, corpus-relative POSIX,
  CANONICAL containment, sha256), `strictSrcOnlyTscScope`,
  `tscTimeoutMs`, `vitestTimeoutMs`; validated before binding;
  behavioral UNCONSTRUCTIBLE with zero fixtures (constructor + validate()
  + worker check); digest on readiness/audit/hello/artifacts.
- **Seed-green:** ANY manifest-backed daemon runs its baseline (tsc, plus
  fixtures in behavioral mode) once against generation zero and REFUSES
  to serve red — before the start event is audited and before the socket
  binds. Red-by-design task fixtures out of scope.
- **Deadline nesting:** `tscTimeoutMs + vitestTimeoutMs` (inner) <
  `candidate_deadline` = inner + `CANDIDATE_OVERHEAD_MS` (30_000) <
  transport total = `QUEUE_ALLOWANCE_MS` (30_000) + `candidate_deadline`
  ≤ `MAX_DEADLINE_MS` (300_000). Analyze deadline stays the existing
  separate 30s. Without a manifest, candidate frames keep today's 30s.
- **Process cleanup:** bounded subprocesses run detached as group
  leaders; timeout kills the WHOLE GROUP (`kill(-pid, SIGKILL)`);
  fixture-spawned descendants die with it; the timeout gate proves it
  with a pidfile.
- **Savepoint compatibility:** vitest reads a materialized temp tree;
  the Task-7 savepoint + fingerprint assertion unchanged; the timeout
  gate proves generation unchanged, savepoint rollback, fingerprint
  equality, cleanup, healthy SAME-WORKER recovery (counter deltas), and
  re-drive.
- **Fixture reader:** digest-pinned, manifest-registered files only.
- **Cost disclosure, not gating:** metrics/audit surfaces; optional
  fields; tsc-only records byte-identical. Exit-gate artifacts immutable.
- **B-1 conventions:** lockstep dual-language wire tasks + golden-fixture
  sweeps; protocol v1 lockstep; `tasks.ts` untouched/never staged;
  deterministic key-free only; PATH prefix; no `--` in pnpm test
  filters; NEVER `git stash`; no concurrent builds/tests in one tree;
  known pre-existing worktree/load failures per decisions.md 2026-08-01.
- **Out of scope:** red-by-design fixtures, per-change-set profiles,
  general file reads, product-gate refactors (`commitWithBehavioralGate`
  is the parity oracle, consumed as-is), item C, keyed runs.

## File Structure

As v1, plus: `packages/verify/src/boundedRun.ts` (NEW — async
process-group bounded runner), coordinator requeue method
(`crates/strata-kernel/src/coordination/coordinator.rs` + kernel
passthrough), typed transport phases (`bridge/persistent.rs` error
surface), audit.rs (optional fields + reopen test). Name table as v1
with these additions:

| Concept | Name |
|---|---|
| Bounded async runner | `boundedProcessRun({ command, args, cwd, timeoutMs }) → Promise<{ status, stdout, stderr, timedOut }>` (verify/boundedRun.ts) |
| Known application rejection | worker code `intentRejected` (stage `mutate`) |
| Release-and-requeue | `Kernel::release_claim_for_retry(change_set_id: &str, tick: u64) -> Result<()>` |
| Transport phase | `TransportPhase { Queued, Sync, Exchange }` on persistent-host errors (typed, downcastable) |
| Baseline frame | `BridgeRequest::ValidateBaseline` (new kind — the Rust candidate protocol rejects empty `orderedIntents` at bridge/protocol.rs:528, so reusing the candidate frame would weaken a valid invariant) |

---

### Task 1: Typed candidate rejection in the Rust bridge

As v1 Task 1 with two corrections: (a) ALL new tests live in
`bridge/protocol.rs`'s `#[cfg(test)]` module (the parser surface is
`pub(crate)` — no integration-test seam is added); (b) the semantic set
is {`validate/typescriptFailed`, `validate/behavioralFailed`,
`mutate/intentRejected`} — `mutationFailed` is OPERATIONAL.

**Files:** Modify `crates/strata-kernel/src/bridge/protocol.rs`,
`router.rs`; verify-only `executor.rs`; Modify `lib.rs` (re-exports).

**Interfaces:** `CandidateRejected` / `RejectionDiagnostic` structs and
the shared `candidate_failure_to_error` helper exactly as v1's Task 1
block, with the discriminator:

```rust
fn is_semantic_rejection(stage: ErrorStage, code: &str) -> bool {
    matches!(
        (stage, code),
        (ErrorStage::Validate, "typescriptFailed")
            | (ErrorStage::Validate, "behavioralFailed")
            | (ErrorStage::Mutate, "intentRejected")
    )
}
```

`MirrorCandidateResponse::Failed` gains
`diagnostics: Vec<BridgeDiagnostic>`; both paths build the identical
typed error.

- [ ] **Step 1 (RED):** in protocol.rs's test module, write the v1 Task-1
  test cases (typescript/behavioral/intentRejected downcast with intact
  diagnostics; `mutationFailed`, `candidateFinalizeFailed`,
  `vitestTimedOut`, `hydrate/*` do NOT downcast; `.context()` wrapping
  preserves downcast; mirror-failure diagnostics carried). Construct
  frames with the same JSON-building style the module's existing tests
  use. Run
  `cargo test -p strata-kernel --lib` (or the module filter) — genuine
  red, non-zero count.
- [ ] **Step 2 (GREEN):** implement; re-export; whole crate green
  (`PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` — session
  behavior is unchanged in this task).
- [ ] **Step 3: Commit**

```bash
git add crates/strata-kernel/src/bridge/protocol.rs crates/strata-kernel/src/bridge/router.rs crates/strata-kernel/src/bridge/executor.rs crates/strata-kernel/src/lib.rs
git commit -m "feat(kernel): typed CandidateRejected carrying worker diagnostics; mutationFailed classified operational"
```

---

### Task 2: Worker `intentRejected` for known application rejections

**Files:** Modify `packages/kernel-bridge/src/candidate.ts`; Test
`packages/kernel-bridge/tests/candidate.test.ts`.

**Interfaces:** before invoking `rename_symbol`/`add_parameter`, the
mutate stage pre-checks the intent's target in the hydrated store:
target node must exist and be a supported declaration (rename) /
function (add_parameter) — on failure `throw new
CandidateFailure("mutate", "intentRejected", [], "intent target
<id> does not exist or is not applicable")`. Residual mutate-stage
exceptions keep mapping to `mutationFailed` (candidate.ts:181 —
unchanged, now OPERATIONAL downstream). This is a classification
pre-check only: no store behavior changes.

- [ ] **Step 1 (RED):** kernel-bridge candidate tests: a rename intent
  whose `declarationId` does not exist in the snapshot → `CandidateError`
  with stage `mutate`, code `intentRejected` (today: `mutationFailed`);
  an `add_parameter` whose `functionId` names a non-function →
  `intentRejected`; an internal invariant failure path (reuse/extend the
  existing corrupted-payload style test if present) stays
  `mutationFailed`. Run
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test candidate`
  — red.
- [ ] **Step 2 (GREEN):** implement the pre-checks; kernel-bridge suite
  green.
- [ ] **Step 3: Commit**

```bash
git add packages/kernel-bridge/src/candidate.ts packages/kernel-bridge/tests
git commit -m "feat(kernel-bridge): intentRejected for known application rejections; mutationFailed reserved for unexpected failures"
```

---

### Task 3: Client-wire `Diagnostic.modulePath` (dual-language + fixtures)

As v1 Task 2, with the review's compile fix: `session.rs` IS a listed
and staged file — the existing fabricated-`Diagnostic` literal
(~session.rs:811) gains `module_path: None` in this task so the crate
compiles (the literal itself is retired in Task 4).

**Files:** Modify service `protocol.rs`, `session.rs` (literal only),
live-compare `protocol.ts`, golden fixtures, `protocol.test.ts`.

Steps as v1 Task 2 (optional field + `validate_module_path` when
present; TS `.optional()`; accepted fixture with-and-without the key;
rejected absolute-path case; red → green both sides).

- [ ] **Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs packages/live-compare/src/protocol.ts packages/live-compare/tests/fixtures/protocol-v1 packages/live-compare/tests/protocol.test.ts
git commit -m "feat(kernel): optional corpus-relative modulePath on wire diagnostics, dual-language + fixtures"
```

---

### Task 4: Release-and-requeue + session failure taxonomy

**Files:** Modify
`crates/strata-kernel/src/coordination/coordinator.rs` (new method),
`crates/strata-kernel/src/kernel.rs` (passthrough), service
`session.rs`; Test `crates/strata-kernel/tests/local_service.rs`,
`crates/strata-kernel/tests/local_service_recovery.rs` (updated
assertion), plus a coordinator-level unit test beside the existing
lease-expiry tests.

**Interfaces:**
- `Coordinator::release_claim_for_retry(change_set_id, now_tick)`
  modeled ON the lease-expiry transition (`expire_leases`,
  coordinator.rs:558: simulate release, recompute readiness without a
  lock, persist expiry + fresh offers as ONE optimistic lifecycle
  transition) but targeted at ONE claimed change set: claim released,
  ticket back to `queued`, fresh offer emitted, `intent_queued`-class
  event recorded. `Kernel::release_claim_for_retry` passthrough.
- Session advance `Err` arm split (replacing v1 Task 3's design):
  - `downcast_ref::<CandidateRejected>()` → SUCCESS response, state
    `validation_failed`, diagnostics via `rejection_diagnostics` (the
    v1 mapping block verbatim: `take(64)`, `code:
    "{rejected.code}:{d.code}"`, projected-or-absent `module_path`,
    non-empty fallback diagnostic), audit `validation_failed`, cancel
    follow-up unchanged.
  - otherwise (OPERATIONAL) →
    `self.kernel.release_claim_for_retry(change_set_id, tick)?` FIRST,
    then error response `("candidate_execution_failed", "candidate
    execution failed before a validation verdict; the change set has
    been requeued", retryable: true)`, audit
    `candidate_execution_failed`, NO cancel follow-up. If the requeue
    itself fails, fall through to the generic `request_failed` surface
    (fail closed, claim state honest in the response).
  - `change_set_result` diagnostic parameter → `Vec<Diagnostic>`
    (compiler-led sweep).
- Consumed by: Task 9's re-drive assertion.

- [ ] **Step 1 (RED, coordinator unit):** beside the existing
  lease/requeue tests: claim a change set (existing test helpers), call
  `release_claim_for_retry`, assert ticket state `queued`, a fresh
  offer exists, and a subsequent claim+publish succeeds; calling it on
  a non-claimed change set errors. Red (method absent).
- [ ] **Step 2 (RED, daemon):** local_service `taxonomy_` tests as v1
  Task 3 Step 1 (semantic `NoSuchType` add_parameter → real tsc
  diagnostics with corpus-relative modulePaths; rejection audits +
  cancels; clean rename unaffected by the Vec refactor). Red.
- [ ] **Step 3 (GREEN):** implement coordinator + kernel + session;
  sweep `candidate_validation_failed` assertions — the review-verified
  inventory: `crates/strata-kernel/tests/local_service_recovery.rs:915`
  (update to the new taxonomy) and session.rs comments; do NOT touch
  `packages/live-compare/src/runner.ts:25` (benchmark failure category,
  unrelated). Whole crate green.
- [ ] **Step 4: Commit**

```bash
git add crates/strata-kernel/src/coordination/coordinator.rs crates/strata-kernel/src/kernel.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs crates/strata-kernel/tests/local_service.rs crates/strata-kernel/tests/local_service_recovery.rs
git commit -m "feat(kernel): candidate failure taxonomy — real diagnostics for rejections; operational failures atomically release-and-requeue"
```

  (Plus the coordinator test file per its actual location.)

---

### Task 5: Validation manifest — schema, digest, canonical containment, argv

As v1 Task 4 plus review Major 9: after the lexical checks,
`load_validation_manifest` CANONICALIZES the corpus root and each
fixture path (`std::fs::canonicalize`) and enforces containment of the
canonical fixture under the canonical root BEFORE hashing; the
`LoadedManifest` retains the canonical absolute path per fixture as the
verified identity that Task 10's reader serves from (re-verified per
read). A symlinked fixture escaping the root fails startup.

All other Interfaces/steps/bounds exactly as v1 Task 4 (schema, digest,
`--validation-manifest` in the allowed list, duplicate-flag pin,
`ValidationProfile::behavioral` constructor + validate() invariant,
nesting arithmetic at load time, tempdir-corpus unit tests + the
symlink-escape case on platforms where tempdir symlinks are creatable —
`std::os::unix::fs::symlink`, this repo is macOS/unix-only).

- [ ] Steps: stub+`mod manifest;` first → RED → implement → GREEN →
  commit as v1 Task 4 Step 5 (same staged files).

---

### Task 6: Bounded subprocesses (process groups) + per-kind deadlines + typed transport phases

**Files:**
- Create: `packages/verify/src/boundedRun.ts`
- Modify: `packages/verify/src/corpusRun.ts` (async bounded variants
  BESIDE the untouched sync ones), `packages/verify/src/validate.ts`
  (`commitWithBehavioralGate` gains an async bounded sibling used by the
  worker — the sync product path untouched),
  `packages/kernel-bridge/src/candidate.ts` + `worker.ts` (async
  validate stage), `packages/kernel-bridge/src/protocol.ts` (profile
  timeouts)
- Modify: `crates/strata-kernel/src/bridge/protocol.rs`
  (`ValidationProfile` timeouts — OPTIONAL on TscOnly, REQUIRED on
  Behavioral), `process.rs` (`candidate_deadline` + per-kind selection
  in `run`), `persistent.rs` (typed `TransportPhase` error wrapper +
  transport total = queue allowance + candidate deadline for candidate
  frames), `router.rs` (candidate call sites), `executor.rs`
  (classification: `Queued`-phase failure → one-shot fallback allowed;
  `Sync`/`Exchange`-phase failure or worker timeout codes on candidate
  frames → operational error, NO fallback), `kernel.rs` (wiring)
- Update + stage: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
  (five-key pin must still pass for the default path — add a SEPARATE
  assertion for a manifest-backed behavioral profile's seven keys),
  `crates/strata-kernel/tests/bridge_protocol.rs` (direct
  `NodeBridgeConfig` construction at :91),
  `packages/live-compare/tests/tasks.test.ts` (request builder at :268),
  persistent deadline-preservation tests (the :1143 poison and :1164
  queued-before-worker pins get explicit sibling tests for the new
  split).

**Interfaces:**
- boundedRun.ts:

```ts
export interface BoundedRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
/**
 * Spawns the command DETACHED as its own process group and awaits exit.
 * On timeout, SIGKILLs the whole group (kill(-pid)) so descendants the
 * child spawned die with it, then resolves { timedOut: true }.
 */
export function boundedProcessRun(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<BoundedRunResult>;
```

  Implementation: `spawn(command, args, { cwd, detached: true, stdio:
  ["ignore", "pipe", "pipe"] })`; collect bounded output; timer →
  `process.kill(-child.pid, "SIGKILL")` (fallback to `child.kill` if
  the group kill throws ESRCH); always `unref`-free (we await exit).
- corpusRun.ts gains `boundedTscNoEmit(treeRoot, timeoutMs)` and
  `boundedRunVitest(treeRoot, fixtures, timeoutMs)` (async, via
  `boundedProcessRun`, same tsc/vitest argv as the sync versions);
  validate.ts gains `commitWithBehavioralGateBounded(db, tx, acceptance
  & { tscTimeoutMs, vitestTimeoutMs }): Promise<GatedCommitResult>`;
  the SYNC `tscNoEmit`/`runVitest`/`commitWithBehavioralGate` are
  byte-identical untouched (product path).
- candidate.ts: the pipeline becomes async
  (`Promise<BuildValidateCandidateResult>`) — the validate bracket
  awaits the bounded gate in behavioral mode and keeps the sync
  `commit` call in tscOnly mode; worker.ts awaits; the mirror savepoint
  wrapper brackets the awaited pipeline (single-connection sqlite —
  holding the savepoint across the await is safe and is asserted by the
  existing fingerprint machinery). Timeouts surface as
  `CandidateFailure("validate", "tscTimedOut" | "vitestTimedOut", [],
  …)` (operational downstream).
- Rust profile:

```rust
    TscOnly {
        source_root: String,
        corpus_root: String,
        behavioral_fixtures: Vec<String>,
        strict_src_only_tsc_scope: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tsc_timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vitest_timeout_ms: Option<u64>,
    },
    Behavioral {
        source_root: String,
        corpus_root: String,
        behavioral_fixtures: Vec<String>,
        strict_src_only_tsc_scope: bool,
        tsc_timeout_ms: u64,
        vitest_timeout_ms: u64,
    },
```

  (`tsc_only()` fills `None` — the default wire is BYTE-IDENTICAL and
  the five-key acceptance pin passes untouched; `behavioral(…)` requires
  both.) TS zod mirrors the split (optional on tscOnly variant, required
  on behavioral). `validate()` bounds present values `1_000..=180_000`.
- Deadlines: `NodeBridgeConfig.candidate_deadline: Duration` — equals
  `deadline` (30s) without a manifest; manifest-derived
  (`tsc + vitest + CANDIDATE_OVERHEAD_MS`) with one. `process.rs::run`
  selects by `request.kind()`. Persistent candidate calls pass
  `QUEUE_ALLOWANCE_MS + candidate_deadline` as the transport deadline;
  the host's error surface wraps failures in a typed
  `TransportFailure { phase: TransportPhase, source }` (thiserror-style,
  downcastable) where phase is `Queued` (deadline elapsed before any
  worker interaction — the existing :1164 semantics), `Sync`
  (hydration/attestation), or `Exchange` (semantic frame in flight).
  executor.rs: candidate mirror errors — `Queued` → one-shot fallback
  (worker untouched, replay safe); `Sync`/`Exchange`/worker timeout
  codes → operational error, no fallback. Analyze path classification
  unchanged.

- [ ] **Step 1 (RED, TS):** boundedRun tests: a script that spawns a
  detached-grandchild sleeper writing `process.pid` of BOTH processes to
  files, timeoutMs 1000 → `timedOut: true`, and `process.kill(pid, 0)`
  throws ESRCH for BOTH pids within a bounded wait (group kill proven);
  a fast command → `timedOut: false`, status 0. Kernel-bridge candidate
  test: behavioral profile with `vitestTimeoutMs: 1500` + sleeping
  fixture → `CandidateError` code `vitestTimedOut`. Red.
- [ ] **Step 2 (GREEN, TS):** implement boundedRun + bounded gate +
  async pipeline; kernel-bridge + verify suites green (product-path
  suites untouched by construction — verify this claim by running
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/verify test`).
- [ ] **Step 3 (RED, Rust):** profile serde tests (TscOnly default omits
  the keys — assert EXACT key set; Behavioral requires them; bounds);
  per-kind deadline selection test; `TransportPhase` classification
  tests (Queued → fallback, Exchange → no fallback) via the persistent
  test harness patterns; the :1143/:1164 sibling preservation tests. Red.
- [ ] **Step 4 (GREEN, Rust):** implement; update + stage
  `full_key_free_acceptance.rs` (default pin unchanged + new behavioral
  seven-key assertion), `bridge_protocol.rs`, `tasks.test.ts`. Whole
  crate + kernel:bridge:test green.
- [ ] **Step 5: Commit**

```bash
git add packages/verify/src packages/verify/tests packages/kernel-bridge/src packages/kernel-bridge/tests crates/strata-kernel/src/bridge crates/strata-kernel/src/kernel.rs crates/strata-kernel/tests/full_key_free_acceptance.rs crates/strata-kernel/tests/bridge_protocol.rs packages/live-compare/tests/tasks.test.ts
git commit -m "feat(kernel): process-group-bounded tsc/vitest, per-kind deadlines with typed transport phases, no replay of validation timeouts"
```

---

### Task 7: Seed-green startup gate + manifest identity (any manifest)

As v1 Task 6 with review Major 8 constitutive:
- Baseline runs for ANY supplied manifest: tscOnly manifest → tsc-only
  baseline (no fixtures); behavioral → tsc + fixtures. Only the
  no-manifest default skips (and its startup sequencing stays
  byte-identical).
- Audit sequencing: `ServiceSession::open` is split — the
  `service_started`/`service_recovered` audit append moves OUT of
  `open()` into a new `finalize_startup()` called by `server::serve`
  AFTER a green baseline (and immediately after `open()` in the
  no-manifest path, preserving today's ordering). A red daemon audits
  NOTHING and exits 2 pre-readiness with bounded diagnostics.
- Audit fields `validation_mode`/`validation_manifest_digest` are
  `#[serde(default)]`-optional on `AuditEvent` (strict deserializer at
  audit.rs:291 keeps reopening HISTORICAL lines — add a reopen test
  feeding a pre-B-2 audit line verbatim); `audit.rs` is listed and
  staged.
- `hello` `Ready` fields required + digest nullable (v1 design), with
  the fixture sweep ALSO updating negative/rejected ready fixtures so
  they remain discriminating (fail for their original reason, not for
  the missing new fields).
- `ValidateBaseline` stays a NEW frame kind (the candidate protocol's
  non-empty `orderedIntents` invariant at bridge/protocol.rs:528 stays
  intact); the worker factors shared materialize/validate internals
  (using Task 6's bounded runners) without conflating wire kinds.

Files/steps/tests otherwise as v1 Task 6 (worker baseline.ts red/green;
Rust frame round-trip; the three daemon spawn tests gain a fourth:
`seed_tsc_only_manifest_daemon_gets_tsc_baseline` — a tscOnly manifest
over a corpus with a type error refuses to serve).

- [ ] **Commit**

```bash
git add crates/strata-kernel/src packages/kernel-bridge/src packages/kernel-bridge/tests packages/live-compare/src/protocol.ts packages/live-compare/tests crates/strata-kernel/tests crates/strata-kernel/src/bin/strata_kernel_service/audit.rs
git commit -m "feat(kernel): seed-green baseline for any manifest; audited start only after green; manifest identity on readiness, audit, hello"
```

---

### Task 8: Behavioral rejection/parity gate

As v1 Task 7 with the corrected fixture import (verified real corpus
path):

```ts
import { greet } from "../../src/users/greet";
import type { User } from "../../src/types/user";

describe("greet behavioral contract", () => {
  it("greets by name", () => {
    const user = { name: "Ada", email: "ada@example.com" } as unknown as User;
    expect(greet(user)).toContain("Ada");
  });
});
```

(Resolve `User`'s actual required fields from `src/types/user.ts` when
writing the fixture; it must pass at generation zero — the seed-green
gate enforces it.) Scenario, assertions, parity oracle, and the STOP
rule on parity divergence exactly as v1 Task 7. `startKernelService`
gains the optional `validationManifestPath` passthrough.

- [ ] **Commit** as v1 Task 7 Step 3.

---

### Task 9: Timeout / savepoint recovery gate (discriminating observations)

As v1 Task 8 with review Major 7 + Blocker 3 constitutive. Lever
(review-validated): fixture

```ts
import * as mod from "../../src/users/greet";
import { writeFileSync } from "node:fs";

it("contract", async () => {
  if (!("greet" in mod)) {
    writeFileSync(process.env.STRATA_TEST_PID_FILE ?? "/dev/null", String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  expect(true).toBe(true);
});
```

Generation zero: `greet` exported → no sleep → seed-green fast. After
rename `greet` → `welcomeUser`: namespace import still loads, `"greet"
in mod` false → pidfile written → sleep → `vitestTimeoutMs: 2_000`
times out deterministically. Daemon spawned with
`STRATA_TEST_PID_FILE` in its env (inherited down to vitest),
`--persistent-bridge`, `--metrics`.

Assertions (all deterministic):
1. advance → `ok: false`, `candidate_execution_failed`,
   `retryable: true`.
2. generation unchanged.
3. REQUEUE + RE-DRIVE: the change set is observably `queued` after the
   failure; a SECOND advance of the SAME change set re-drives it (the
   fixture still sleeps → same operational failure again — proving the
   re-drive actually re-executed, via a fresh metrics record for the
   second attempt); then `cancel_change_set` succeeds and a DIFFERENT
   clean rename publishes.
4. Same-worker health (discriminating): parse the metrics sink —
   `worker_starts_total` delta across the whole scenario is exactly the
   eagerly-hydrated 1 (no respawn, no one-shot fallback spawn); the
   rehydration/fallback counters (Task 10 adds them — THIS assertion is
   added in Task 10's step and cross-referenced here; Task 9 asserts
   the spawn counter which already exists).
5. Group-kill proof: the pidfile's pid is dead
   (`process.kill(pid, 0)` throws ESRCH) within a bounded wait — a
   deterministic cleanup gate, replacing v1's skippable `ps` check.
6. Savepoint/fingerprint: the clean publish after cancellation succeeds
   on the SAME daemon — combined with assertion 4's no-respawn proof,
   this discriminates same-worker rollback health from
   respawn-rehydration (a poisoned-then-respawned worker would show a
   spawn-counter increment).

- [ ] **Steps:** write gate → run
  (`PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test behavioralTimeout`)
  → PASS → commit as v1 Task 8 Step 3.

---

### Task 10: Registered-fixture reader + disclosure metrics

Reader exactly as v1 Task 9 (wire lockstep, digest-pinned reads served
from the manifest's CANONICAL verified identities per Task 5, bounds,
wrappers, 2 tools → 15 total, daemon integration tests incl. the
tamper-after-startup pin).

Disclosure metrics (v1 Task 10's metrics half, corrected per Minor 10):
ALL new record fields optional/omitted —

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_wall_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    one_shot_fallbacks_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rehydrations_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_timeouts_total: Option<u64>,
```

populated only on behavioral-mode advances (kernel AtomicU64 counters +
persistent queue-wait measurement per v1); a serialization unit test
pins that tsc-only records are byte-identical to pre-B-2 records.
Extend `behavioralTimeout.test.ts` with the counter assertions
cross-referenced by Task 9 assertion 4 (`validation_timeouts_total`
increments across the two failed attempts; `rehydrations_total` and
`one_shot_fallbacks_total` stay 0).

- [ ] **Steps:** wire RED (B-1 Task-1 pattern) → daemon reader tests RED
  → implement → GREEN full live-compare + crate → commit:

```bash
git add crates/strata-kernel/src packages/live-compare/src packages/live-compare/tests crates/strata-kernel/tests
git commit -m "feat(kernel): digest-pinned fixture reader + behavioral cost-disclosure metrics (optional fields, tsc-only records byte-identical)"
```

---

### Task 11: Gate wiring, full chain, closing records

v1 Task 10's wiring/close half, standalone:

```json
"kernel:behavioral:test": "pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && pnpm --filter @strata-code/verify build && cargo build -p strata-kernel && pnpm --filter @strata-code/verify test behavioralParity && pnpm --filter @strata-code/live-compare test behavioralGate behavioralTimeout"
```

appended to `kernel:full-key-free:test` after `kernel:discovery:test`.
Full chain detached (Orca) with log evidence; workspace sweep with the
documented pre-existing exceptions; decisions.md APPENDED close entry
recording: what shipped; the semantic/operational code partition (exact
lists); `intentRejected`'s introduction; the release-and-requeue
contract; transport phases; the optional-timeout profile split
preserving the five-key pin; canonical fixture containment; anything
discovered during build. Roadmap: item B fully complete (B-1 + B-2),
item D unblocked. `strata-design.md` untouched.

- [ ] **Steps:** wiring → `PATH=/opt/homebrew/bin:$PATH pnpm
  kernel:behavioral:test` green → full chain green (evidence) →
  workspace sweep → records → commit:

```bash
git add package.json decisions.md docs/product-roadmap.md
git commit -m "chore(kernel): behavioral gate wired into key-free chain; record B-2 close"
```

---

## Explicit non-goals

As v1 (no red-by-design fixtures, no per-change-set profiles, no general
file reads, product gate is the oracle not a refactor target, no
exit-gate re-adjudication, no item C, no keyed runs, `tasks.ts` never
staged).

## Self-Review (v2)

All ten review findings mapped: 1→Task 6 profile split (+acceptance-pin
preservation), 2→Task 6 boundedRun group supervision (+Task 9 pidfile
proof), 3→Task 4 release-and-requeue (+Task 9 re-drive assertion),
4→Task 6 transport phases + queue-allowance split (+preservation tests),
5→Tasks 1-2 (`intentRejected`), 6→Tasks 1/3/4/6 staging+seam fixes,
7→Task 9 discriminating observations, 8→Task 7 any-manifest baseline +
audit sequencing + reopen test, 9→Task 5 canonical containment, 10→Task
10/11 split + optional counters. Spec gates: (a) Tasks 1-7 units,
(b) Task 7, (c) Task 8, (d) Task 9 (+Task 10 counters), (e) Tasks
10-11. Type-consistency pass done. Open items intentionally left to
execution-time discovery: exact coordinator internals for
`release_claim_for_retry` (the lease-expiry transition is the named
model; the implementer follows it), and the `User` fixture literal in
Task 8 (resolved against the real type at write time).
