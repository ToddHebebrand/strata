# Item B-2 — Behavioral Gate Implementation Plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v1, pre-review. Per the item-B spec's process section this plan
goes v1 → independent methodology review → v2 before any build. Governing
spec: `docs/superpowers/specs/2026-07-31-item-b-design.md` (Slice B-2 +
Hard boundaries). B-1 is merged (main d708662); everything here builds on
that state.

**Goal:** Wire the kernel's commit gate honestly for behavioral validation:
typed candidate rejection carrying the worker's real diagnostics, a
committed digested validation manifest with a seed-green startup invariant,
safely nested subprocess deadlines with timeout/savepoint recovery proofs,
a manifest-pinned fixture reader, and cost disclosure — while the tsc-only
default stays byte-identical.

**Architecture:** The worker already types its failures (`CandidateFailure`
→ `CandidateError` responses with stage/code/diagnostics); B-2 stops the
Rust side from collapsing them: a downcastable `CandidateRejected` error
flows from `into_candidate_result`/the mirror router through
`execute_claimed` to the session, which maps real bounded diagnostics
(with corpus-relative `modulePath`) onto the wire and reserves
`ValidationFailed` for semantic rejections only. A per-corpus manifest
(`--validation-manifest`, single option) governs mode, fixtures, strict
tsc scope, and subprocess deadlines; the daemon refuses to serve if the
manifest suite is red at generation zero; the manifest digest rides
startup/audit/hello. Two new read-only client actions expose the
registered fixtures, digest-pinned.

**Tech Stack:** Rust (strata-kernel crate + service bin, serde, anyhow
downcast chains), TypeScript (kernel-bridge worker, zod bridge schemas,
live-compare client/protocol/tools, Vitest), shared golden fixtures, pnpm
gate scripts.

## Global Constraints

- **tsc-only default byte-identical (spec, hard).** A daemon started
  without `--validation-manifest` behaves exactly as today: same
  `NodeBridgeConfig::tsc_only`, same 30s deadline, same wire bytes for
  every existing suite. Every task must keep the full pre-B-2 test corpus
  green without modification EXCEPT where a task explicitly updates a test
  (each such update is listed in that task).
- **Only `CandidateRejected` produces `ValidationFailed`** (spec Blocker
  1). Semantic rejection = worker `CandidateError` with stage `validate`
  and code `typescriptFailed` or `behavioralFailed`, or stage `mutate` and
  code `mutationFailed`. Everything else (protocol/hydrate/analyze/export
  stages, `candidateFinalizeFailed`, `candidateExportFailed`,
  `vitestTimedOut`, `tscTimedOut`, transport/spawn/poison errors) is
  OPERATIONAL: error response code `candidate_execution_failed`,
  `retryable: true`, change set stays claimed (no cancel follow-up, no
  fabricated diagnostic). The generic `candidate_validation_failed`
  fabrication is retired.
- **A known validation timeout is NEVER auto-replayed through the one-shot
  fallback** (spec point 1): the executor's mirror-fallback branch must
  not re-run a candidate whose mirror error is a validation timeout.
- **Manifest (spec point 2):** ONE `--validation-manifest <path>` option
  (the argv parser already rejects repeated flags — pin it); manifest
  defines mode (`tscOnly`|`behavioral`), normalized unique fixture entries
  + content sha256 digests, strict tsc scope, `tscTimeoutMs`,
  `vitestTimeoutMs`; Rust validates BEFORE binding the service; behavioral
  mode is UNCONSTRUCTIBLE with zero fixtures (Rust construction invariant
  + validate() + the existing worker check); manifest digest recorded in
  startup readiness line, audit, `hello`, and artifacts.
- **Seed-green invariant (spec point 2):** in behavioral mode the daemon
  runs the manifest suite once against generation zero at startup and
  REFUSES to serve if it is red. Red-by-design task fixtures are OUT of
  scope (recorded house history — the manifest is a shared seed-green
  regression gate).
- **Deadline nesting (spec point 3):** manifest `tscTimeoutMs` +
  `vitestTimeoutMs` (inner) < behavioral-candidate bridge deadline
  (= tsc + vitest + `CANDIDATE_OVERHEAD_MS` 30_000, covering
  materialization + rollback + fingerprint + cleanup) < client deadline +
  queue allowance (`QUEUE_ALLOWANCE_MS` 30_000), all ≤ the protocol's
  `MAX_DEADLINE_MS` 300_000. The fast analyze deadline stays the existing
  separate 30s. Subprocess cleanup leaves no orphaned processes.
- **Savepoint compatibility (spec point 4):** vitest reads a materialized
  temp tree, never the mirror DB; the Task-7 savepoint + full-fingerprint
  assertion is unchanged; timeout-recovery gates prove generation
  unchanged, savepoint rolled back, fingerprint equality, temp/process
  cleanup, healthy rehydration.
- **Fixture reader (spec point 5):** `list_validation_fixtures` and
  bounded chunked `read_validation_fixture { fixtureId, offset, length }`
  pinned to the manifest digest; NOT a general filesystem tool; source
  files stay non-first-class.
- **Cost disclosure, not gating (spec point 6):** behavioral runs disclose
  validation duration, persistent-worker queue wait, fallback/rehydration
  and timeout counts. Recorded exit-gate artifacts are immutable and not
  re-adjudicated.
- **B-1 conventions carry over:** dual-language client-wire changes land
  in lockstep with shared golden fixtures in one task; collection/bounds
  contract; `packages/live-compare/src/tasks.ts` untouched and never
  staged; protocol version stays 1 (lockstep).
- **Deterministic, key-free gates only; no keyed spend.**
- **Environment:** prefix all test commands with
  `PATH=/opt/homebrew/bin:$PATH`; never `pnpm --filter X test -- name`
  (write `pnpm --filter X test name`); NEVER `git stash` in any form;
  never run builds/tests concurrently with another suite in the same tree;
  worktree runs of verify/agent/bench suites hit known pre-existing
  checkout-path/load failures (see memory + decisions.md 2026-08-01) —
  reproduce on pristine main before attributing any failure to this
  branch.
- **Out of scope:** item-C stable IDs, multi-language, task
  orchestration, changing the SQLite product gate's semantics
  (`commitWithBehavioralGate` is consumed as-is for parity, not
  refactored), re-running keyed benchmarks.

## File Structure

- `crates/strata-kernel/src/bridge/protocol.rs` — `CandidateRejected`
  typed error + semantic/operational discriminator; `ValidationProfile`
  gains timeouts + behavioral construction invariant;
  `MirrorCandidateResponse::Failed` gains diagnostics; new
  `ValidateBaseline` request/response frames.
- `crates/strata-kernel/src/bridge/executor.rs`, `router.rs`,
  `process.rs` — typed error propagation, per-kind deadlines
  (`candidate_deadline`), no-replay-on-validation-timeout, baseline
  invocation plumbing.
- `crates/strata-kernel/src/bin/strata_kernel_service/manifest.rs` — NEW:
  manifest schema, validation, canonical digest.
- `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` —
  `--validation-manifest` argv; config construction.
- `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` —
  taxonomy split in the advance path; diagnostics mapping + projection;
  fixture-reader read handlers; manifest digest for audit/hello.
- `crates/strata-kernel/src/bin/strata_kernel_service/server.rs` —
  seed-green startup gate; readiness fields.
- `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs` +
  `packages/live-compare/src/protocol.ts` + protocol-v1 golden fixtures —
  client-wire changes (Diagnostic.modulePath; hello validation fields;
  fixture-reader actions/results).
- `packages/kernel-bridge/src/candidate.ts`, `worker.ts`, `protocol.ts`,
  NEW `baseline.ts` — worker-side timeouts, `validateBaseline` handler.
- `packages/verify/src/corpusRun.ts` — bounded tsc/vitest subprocesses.
- `packages/live-compare/src/client.ts`, `tools.ts`, tests — wrappers,
  tools, behavioral/timeout/parity/reader gates.
- `package.json`, `decisions.md`, `docs/product-roadmap.md` — gate wiring
  and closing records.

Name table (used consistently in every task):

| Concept | Rust | Wire (client) | TS |
|---|---|---|---|
| Typed semantic rejection | `CandidateRejected { stage, code, message, diagnostics }` | change_set result, state `validation_failed`, real diagnostics | — |
| Operational failure | anyhow error (not downcastable to `CandidateRejected`) | error response code `candidate_execution_failed`, retryable true | — |
| Diagnostic path | `Diagnostic.module_path: Option<String>` | `modulePath?` (optional, corpus-relative POSIX) | `modulePath: modulePathSchema.optional()` |
| Manifest | `ValidationManifest { schema_version, mode, strict_src_only_tsc_scope, tsc_timeout_ms, vitest_timeout_ms, fixtures: Vec<ManifestFixture { path, sha256 }> }` | `hello` → `validationMode`, `validationManifestDigest` (nullable) | mirrored |
| Fixture reader | `RequestAction::ListValidationFixtures {}` / `ReadValidationFixture { fixture_id, offset, length }` | `list_validation_fixtures` / `read_validation_fixture` | wrappers `listValidationFixtures()` / `readValidationFixture(fixtureId, offset, length)` |
| Baseline frame | `BridgeRequest::ValidateBaseline` (internal bridge wire) | — | worker `validateBaseline` handler |

---

### Task 1: Typed candidate rejection in the Rust bridge

**Files:**
- Modify: `crates/strata-kernel/src/bridge/protocol.rs`
- Modify: `crates/strata-kernel/src/bridge/router.rs` (~line 400 mirror
  failure arm)
- Modify: `crates/strata-kernel/src/bridge/executor.rs` (only if the
  typed error needs explicit passthrough — expected no-op)
- Test: `crates/strata-kernel/tests/bridge_rejection.rs` (NEW)

**Interfaces:**
- Produces (protocol.rs, `pub(crate)`, re-exported from
  `crate::bridge` so session.rs can downcast; make it `pub` at the crate
  root via the existing `lib.rs` re-export style since the service bin
  links the lib crate):

```rust
/// A SEMANTIC candidate rejection: the worker evaluated the candidate and
/// the candidate itself is wrong (type-check red, behavioral red, or the
/// mutation could not apply). Distinct from every operational failure
/// (timeout, crash, transport, invariant), which stays an untyped anyhow
/// error. Only this error may produce a `validation_failed` change-set
/// state downstream.
#[derive(Clone, Debug)]
pub struct CandidateRejected {
    pub stage: String,        // "validate" | "mutate" (ErrorStage, lowercased)
    pub code: String,         // "typescriptFailed" | "behavioralFailed" | "mutationFailed"
    pub message: String,
    pub diagnostics: Vec<RejectionDiagnostic>,
}

/// The worker diagnostic surface preserved for the client: raw payload
/// paths stay raw HERE (the service projects them before the wire).
#[derive(Clone, Debug)]
pub struct RejectionDiagnostic {
    pub node_id: Option<String>,
    pub module_path: Option<String>,
    pub message: String,
    pub code: i64,
}

impl std::fmt::Display for CandidateRejected { /* "candidate rejected at {stage}/{code}: {message}" */ }
impl std::error::Error for CandidateRejected {}
```

- Discriminator (protocol.rs, private):

```rust
fn is_semantic_rejection(stage: ErrorStage, code: &str) -> bool {
    matches!(
        (stage, code),
        (ErrorStage::Validate, "typescriptFailed")
            | (ErrorStage::Validate, "behavioralFailed")
            | (ErrorStage::Mutate, "mutationFailed")
    )
}
```

- `into_candidate_result` (protocol.rs:1084): the `CandidateError` arm
  becomes:

```rust
            Self::CandidateError(response) => {
                let error = response.error;
                if is_semantic_rejection(error.stage, &error.code) {
                    return Err(anyhow::Error::new(CandidateRejected {
                        stage: format!("{:?}", error.stage).to_lowercase(),
                        code: error.code,
                        message: error.message,
                        diagnostics: error
                            .diagnostics
                            .into_iter()
                            .map(|diagnostic| RejectionDiagnostic {
                                node_id: diagnostic.node_id,
                                module_path: diagnostic.module_path,
                                message: diagnostic.message,
                                code: diagnostic.code,
                            })
                            .collect(),
                    }));
                }
                bail!(
                    "Node bridge candidate failed at {:?}/{}: {}",
                    error.stage,
                    error.code,
                    error.message
                )
            }
```

- `MirrorCandidateResponse::Failed` gains
  `diagnostics: Vec<BridgeDiagnostic>` (populated from
  `inner.error.diagnostics` in `parse_mirror_candidate_delta`); router.rs's
  `MirrorCandidateResponse::Failed` arm builds the SAME typed error via a
  shared helper `candidate_failure_to_error(stage, code, message,
  diagnostics) -> anyhow::Error` used by both paths, so mirror and
  one-shot rejections are indistinguishable downstream.
- Consumed by: Task 3 (session downcast), Task 5 (no-replay
  classification).

- [ ] **Step 1: Write failing tests in
  `crates/strata-kernel/tests/bridge_rejection.rs`.** This test file uses
  `parse_bridge_response` + `into_candidate_result` on hand-built JSON
  frames (copy the request/response construction pattern from
  `bridge/executor.rs`'s existing
  `candidate_response_rejects_malformed_or_misbound_data_before_rust_digesting`
  unit test — same fixture snapshot, same binding fields). Cases:
  - `typescript_failure_downcasts_to_candidate_rejected_with_diagnostics`:
    a `CandidateError` frame with stage `"validate"`, code
    `"typescriptFailed"`, two diagnostics (one with `modulePath` and
    `nodeId`, one with nulls) → `into_candidate_result()` errors AND
    `error.downcast_ref::<CandidateRejected>()` yields the exact
    diagnostics (paths intact, codes intact).
  - `behavioral_failure_downcasts_with_message`: code
    `"behavioralFailed"` → downcast succeeds, `code == "behavioralFailed"`.
  - `mutation_failure_downcasts`: stage `"mutate"`, code
    `"mutationFailed"` → downcast succeeds.
  - `operational_failures_do_not_downcast`: stage `"hydrate"` code
    `"hydrateFailed"`, stage `"validate"` code
    `"candidateFinalizeFailed"`, stage `"validate"` code
    `"vitestTimedOut"` → each errors but
    `downcast_ref::<CandidateRejected>()` is `None`.
  - `context_wrapping_preserves_downcast`: wrap the typed error with
    `.context("outer")` and assert `downcast_ref::<CandidateRejected>()`
    still finds it (this pins the property Task 3 depends on across
    `execute_claimed`'s context chain).
  - `mirror_failure_carries_diagnostics`: `parse_mirror_candidate_delta`
    on a `CandidateError` value → `MirrorCandidateResponse::Failed`
    exposes the same diagnostics vector.

- [ ] **Step 2: Run to verify failure** —
  `cargo test -p strata-kernel --test bridge_rejection` — expected: FAIL
  to compile (types absent). Add `bail!("unimplemented")`-style stubs only
  if a compiling red is preferred; confirm genuine red either way.

- [ ] **Step 3: Implement** per the Interfaces block: the two structs +
  Display/Error impls, `is_semantic_rejection`, the shared
  `candidate_failure_to_error` helper, the new `into_candidate_result`
  arm, the `MirrorCandidateResponse::Failed { stage, code, message,
  diagnostics }` field + `parse_mirror_candidate_delta` population, and
  the router.rs arm switching to `candidate_failure_to_error`. Re-export
  `CandidateRejected` + `RejectionDiagnostic` following `lib.rs`'s
  existing bridge re-export style. executor.rs's
  `Ok(MirrorCandidate::Failed(error)) => return Err(error)` already
  passes the typed error through unchanged — verify by reading, adjust
  only if the mirror path wraps errors in a way that drops the source
  chain.

- [ ] **Step 4: Run** —
  `cargo test -p strata-kernel --test bridge_rejection` to green, then
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` (whole crate
  — the session still treats every candidate error identically in this
  task, so nothing else changes behavior). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bridge/protocol.rs crates/strata-kernel/src/bridge/router.rs crates/strata-kernel/src/bridge/executor.rs crates/strata-kernel/src/lib.rs crates/strata-kernel/tests/bridge_rejection.rs
git commit -m "feat(kernel): typed CandidateRejected carrying worker diagnostics through one-shot and mirror candidate paths"
```

---

### Task 2: Client-wire `Diagnostic.modulePath` (dual-language + fixtures)

One lockstep task, B-1 Task-1 style: both strict parsers + shared golden
fixtures move together.

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
  (`Diagnostic` struct ~line 373 + its `validate`)
- Modify: `packages/live-compare/src/protocol.ts` (`diagnosticSchema`)
- Modify: `packages/live-compare/tests/fixtures/protocol-v1/{accepted,rejected}.json`
- Modify: `packages/live-compare/tests/protocol.test.ts`

**Interfaces:**
- Produces (Rust):

```rust
pub(super) struct Diagnostic {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) node_id: Option<String>,
    /// Corpus-relative POSIX display path of the module the diagnostic
    /// points at, when the service could project one. NEVER a raw payload
    /// path — the session projects (B-1 `project_module_path`) and drops
    /// to absent on failure. Optional on the wire (absent when None) so
    /// every pre-B-2 frame stays valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) module_path: Option<String>,
}
```

  `Diagnostic::validate` gains: when `Some`, `validate_module_path`
  (the B-1 validator — same rules: non-empty, ≤512 bytes, POSIX-relative,
  no `.`/`..`/empty segments).
- Produces (TS): `diagnosticSchema` gains
  `modulePath: modulePathSchema.optional()` (the B-1 `modulePathSchema`).
- Consumed by: Task 3's diagnostics mapping; Task 7's gate assertions.

- [ ] **Step 1: Write the failing Rust unit test** in protocol.rs's test
  module:

```rust
#[test]
fn diagnostic_module_path_is_optional_but_validated() {
    let bare = Diagnostic { code: "c".into(), message: "m".into(), node_id: None, module_path: None };
    bare.validate().expect("absent modulePath must validate");
    assert!(!serde_json::to_string(&bare).unwrap().contains("modulePath"));
    let good = Diagnostic { module_path: Some("src/x.ts".into()), ..bare.clone() };
    good.validate().expect("relative POSIX modulePath must validate");
    for bad in ["/abs/x.ts", "src/../x.ts", ""] {
        let diagnostic = Diagnostic { module_path: Some(bad.into()), ..bare.clone() };
        assert!(diagnostic.validate().is_err(), "{bad:?} must be rejected");
    }
}
```

  (Derive or hand-write the `Clone` needed; if `Diagnostic` isn't
  `Clone`, construct each case explicitly.)

- [ ] **Step 2: Red** —
  `cargo test -p strata-kernel --bin strata-kernel-service diagnostic_module_path`
  — expected: FAIL to compile (field absent). Confirm genuine red.

- [ ] **Step 3: Implement both parsers** per Interfaces. TS: add
  `modulePath: modulePathSchema.optional()` to `diagnosticSchema` — note
  `.optional()`, NOT `.nullable()`: the Rust side omits the key entirely
  when `None`, and existing fixtures without the key must keep passing.

- [ ] **Step 4: Update shared fixtures.** In `accepted.json`: extend one
  existing diagnostics-carrying response case (or add
  `change-set-validation-failed-response` if none carries diagnostics)
  with a diagnostic including
  `"modulePath": "src/types/user.ts"`, plus a sibling diagnostic without
  the key. In `rejected.json`: `diagnostic-module-path-absolute-response`
  (a diagnostics-carrying response whose diagnostic has
  `"modulePath": "/etc/passwd"`).

- [ ] **Step 5: Green both sides** —
  `cargo test -p strata-kernel --bin strata-kernel-service` +
  `cargo test -p strata-kernel --test local_service` +
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build && PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test protocol`
  — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs packages/live-compare/src/protocol.ts packages/live-compare/tests/fixtures/protocol-v1 packages/live-compare/tests/protocol.test.ts
git commit -m "feat(kernel): optional corpus-relative modulePath on wire diagnostics, dual-language + fixtures"
```

---

### Task 3: Session failure taxonomy — real diagnostics for rejections, `candidate_execution_failed` for operational

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (the advance `Err(_error)` arm ~line 795-827, `change_set_result`'s
  diagnostic parameter, audit kinds)
- Test: `crates/strata-kernel/tests/local_service.rs`

**Interfaces:**
- Consumes: `strata_kernel::CandidateRejected` (Task 1),
  `Diagnostic.module_path` (Task 2), `project_module_path` +
  `canonical_corpus_root` (B-1).
- Produces (session behavior):
  - `error.downcast_ref::<CandidateRejected>()` present → SUCCESS response
    with state `validation_failed`, diagnostics = the rejection's
    diagnostics mapped:

```rust
fn rejection_diagnostics(&self, rejected: &CandidateRejected) -> Vec<Diagnostic> {
    rejected
        .diagnostics
        .iter()
        .take(MAX_WIRE_DIAGNOSTICS) // 64, mirror protocol MAX_DIAGNOSTICS
        .map(|diagnostic| Diagnostic {
            code: format!("{}:{}", rejected.code, diagnostic.code),
            message: bounded_message(&diagnostic.message),
            node_id: diagnostic.node_id.clone(),
            // Projection failure or raw-path weirdness degrades to absent —
            // never a raw payload path on the wire, and a display-path
            // problem must not hide the diagnostic itself.
            module_path: diagnostic.module_path.as_deref().and_then(|payload| {
                project_module_path(&self.canonical_corpus_root, payload).ok()
            }),
        })
        .collect()
}
```

    Empty rejection diagnostics (possible for `behavioralFailed` whose
    single synthetic diagnostic carries the vitest output, and for
    `mutationFailed`) → one diagnostic
    `{ code: rejected.code, message: bounded_message(&rejected.message), node_id: None, module_path: None }`
    so the state is never diagnostic-free. Audit kind stays
    `"validation_failed"`. Cancel follow-up unchanged for rejections.
  - No downcast → OPERATIONAL: `LocalServiceResponse::error(request_id,
    "candidate_execution_failed", "candidate execution failed before a
    validation verdict", /* retryable */ true, Vec::new())`; audit kind
    `"candidate_execution_failed"`; NO cancel follow-up (the claim stays
    intact — the lease machinery re-offers, exactly the
    `OptimisticRetryExhausted` precedent in the arm above); the
    `OptimisticRetryExhausted` arm itself is untouched.
  - `change_set_result`'s `Option<Diagnostic>` parameter becomes
    `Vec<Diagnostic>` (compiler-led sweep of its call sites inside
    session.rs; all existing callers pass `Vec::new()` or a one-element
    vec).
- Consumed by: Task 7 (gate asserts real diagnostics), Task 8 (operational
  taxonomy under timeout).

- [ ] **Step 1: Write failing daemon integration tests** in
  local_service.rs (prefix `taxonomy_`, real spawned daemon, tsc-only
  mode — semantic tsc rejection needs no manifest):
  - `taxonomy_semantic_rejection_carries_real_tsc_diagnostics`: submit an
    `add_parameter` intent on the registered `greet` function
    (`FORMAT_TIMESTAMP_ID`-style: resolve `greet` via the B-1 discovery
    actions or reuse an existing test constant) with
    `typeText: "NoSuchType"`, `position: 1`, `value: "undefined as never"`
    → advance to terminal → state `validation_failed`, diagnostics
    non-empty, at least one diagnostic's `code` starts with
    `"typescriptFailed:"` and its `message` contains `"NoSuchType"`
    (the real tsc text, not "candidate validation failed"); every
    diagnostic with a `modulePath` has a corpus-relative one
    (`starts_with("src/")`); NO diagnostic has code
    `candidate_validation_failed`.
  - `taxonomy_rejection_still_cancels_and_audits`: after the rejection,
    the audit log contains a `validation_failed` event and the change set
    ends cancelled (follow-up preserved).
  - `taxonomy_diagnostics_survive_needs_decision_free_path`: guard test —
    a CLEAN rename still publishes with empty diagnostics (no regression
    from the `Vec` refactor).

  Operational-branch coverage at daemon level is deliberately deferred to
  Task 8 (a deterministic operational failure needs the manifest timeout
  machinery); the branch itself is covered here by a session-level unit
  test if the module structure allows, otherwise by Task 8 alone — state
  which in the report.

- [ ] **Step 2: Red** —
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service taxonomy_`
  — expected: FAIL (today the diagnostics are the fabricated generic one).

- [ ] **Step 3: Implement** per Interfaces: the downcast split,
  `rejection_diagnostics`, the `Vec<Diagnostic>` refactor, the audit
  kinds, `bounded_message` reuse, `MAX_WIRE_DIAGNOSTICS: usize = 64`
  const with a comment naming protocol `MAX_DIAGNOSTICS` as its mirror.

- [ ] **Step 4: Green** — the `taxonomy_` filter, then
  `cargo test -p strata-kernel --test local_service`, then the whole
  crate. Expected: PASS (the pre-existing red-validation tests that
  asserted the FABRICATED diagnostic must be updated in this task — grep
  `candidate_validation_failed` across `crates/` and
  `packages/live-compare/` and update every assertion to the new
  taxonomy; list each file touched in the report).

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/session.rs crates/strata-kernel/tests/local_service.rs
git commit -m "feat(kernel): candidate failure taxonomy — real worker diagnostics for rejections, retryable candidate_execution_failed for operational"
```

  (Plus any test files the `candidate_validation_failed` sweep touched.)

---

### Task 4: Validation manifest — schema, digest, argv, construction invariant

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/manifest.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
  (`mod manifest;`, `--validation-manifest` in the allowed list, config
  construction)
- Modify: `crates/strata-kernel/src/bridge/protocol.rs`
  (`ValidationProfile::behavioral` constructor + non-empty invariant)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  (`ServiceConfig` gains `validation: ValidationSettings`)

**Interfaces:**
- Produces (manifest.rs):

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ValidationManifest {
    pub(super) schema_version: u32,               // must be 1
    pub(super) mode: ManifestMode,                // TscOnly | Behavioral
    pub(super) strict_src_only_tsc_scope: bool,
    pub(super) tsc_timeout_ms: u64,               // 1_000..=180_000
    pub(super) vitest_timeout_ms: u64,            // 1_000..=180_000
    pub(super) fixtures: Vec<ManifestFixture>,    // unique normalized paths
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManifestFixture {
    pub(super) path: String,    // corpus-relative POSIX, validate_module_path rules,
                                // first segment "test"|"tests", .test./.spec. extension
    pub(super) sha256: String,  // 64 lowercase hex
}

pub(super) struct LoadedManifest {
    pub(super) manifest: ValidationManifest,
    pub(super) digest: String, // sha256 hex of the canonical serde_json bytes
}

pub(super) fn load_validation_manifest(path: &Path, corpus_root: &Path) -> Result<LoadedManifest>;
```

  `load_validation_manifest`: read, parse (strict), validate — bounds
  above; fixture paths unique + sorted check NOT required on disk but
  entries are normalized and deduped-rejected (duplicate → error);
  behavioral mode requires ≥1 fixture; tscOnly requires 0 fixtures; each
  fixture file must exist under `corpus_root` and its sha256 must match;
  `tsc_timeout_ms + vitest_timeout_ms + CANDIDATE_OVERHEAD_MS +
  QUEUE_ALLOWANCE_MS ≤ 300_000` (the wire `MAX_DEADLINE_MS`) — the
  deadline-nesting arithmetic lives HERE so an unsatisfiable manifest
  fails before any daemon work. Digest = sha256 of
  `serde_json::to_vec(&manifest)` (field order is struct order —
  deterministic).
- Produces (protocol.rs):

```rust
    pub(crate) fn behavioral(
        source_root: impl Into<String>,
        corpus_root: impl Into<String>,
        behavioral_fixtures: Vec<String>,
        strict_src_only_tsc_scope: bool,
    ) -> Result<Self> {
        ensure!(
            !behavioral_fixtures.is_empty(),
            "behavioral validation profile requires at least one fixture"
        );
        Ok(Self::Behavioral { /* … */ })
    }
```

  and `validate()`'s Behavioral arm gains
  `ensure!(!behavioral_fixtures.is_empty(), …)` (the review-verified gap:
  Rust never required non-empty fixtures).
- Produces (session.rs):

```rust
pub(super) struct ValidationSettings {
    pub mode: &'static str,                 // "tscOnly" | "behavioral"
    pub manifest_digest: Option<String>,    // None without --validation-manifest
    pub fixtures: Vec<(String, String)>,    // (corpus-relative path, sha256); empty in tscOnly
    pub tsc_timeout_ms: u64,
    pub vitest_timeout_ms: u64,
}
```

  stored on `ServiceSession` (consumed by Tasks 6/9). Constructed in
  main.rs: without the flag → `mode: "tscOnly", manifest_digest: None,
  fixtures: vec![], timeouts: the DEFAULT_* consts below` and — the
  byte-identical guarantee — `NodeBridgeConfig::tsc_only` built EXACTLY
  as today.
- Constants (manifest.rs): `CANDIDATE_OVERHEAD_MS: u64 = 30_000`,
  `QUEUE_ALLOWANCE_MS: u64 = 30_000`, `DEFAULT_TSC_TIMEOUT_MS: u64 =
  60_000`, `DEFAULT_VITEST_TIMEOUT_MS: u64 = 90_000`.
- Consumed by: Tasks 5 (timeouts into the bridge config), 6 (seed-green +
  identity), 9 (fixture reader).

- [ ] **Step 1: Write failing unit tests** in manifest.rs's
  `#[cfg(test)]` module (declare `mod manifest;` in main.rs FIRST with a
  bailing stub so the red run compiles with a non-zero test count — the
  B-1 Task-2 lesson). Cases: valid behavioral manifest round-trips with a
  stable digest (same bytes → same digest, field mutation → different
  digest); zero-fixture behavioral rejected; fixture-carrying tscOnly
  rejected; duplicate fixture path rejected; wrong sha256 rejected;
  missing file rejected; absolute/`..` fixture path rejected; timeout of
  0 and of 200_000 rejected; nesting bound rejected when
  `tsc + vitest + 60_000 > 300_000`; unknown JSON field rejected. Use a
  tempdir corpus with one real fixture file whose sha256 the test
  computes.

- [ ] **Step 2: Red** —
  `cargo test -p strata-kernel --bin strata-kernel-service manifest` —
  expected: genuine failures against the stub, non-zero test count.

- [ ] **Step 3: Implement** manifest.rs per Interfaces; add
  `"--validation-manifest"` to main.rs's `allowed` vec and the
  construction split; add the `ValidationProfile::behavioral` constructor
  + invariant; add one protocol.rs unit test:

```rust
#[test]
fn behavioral_profile_is_unconstructible_with_zero_fixtures() {
    assert!(ValidationProfile::behavioral("/c/src", "/c", Vec::new(), true).is_err());
    let manual = ValidationProfile::Behavioral {
        source_root: "/c/src".into(),
        corpus_root: "/c".into(),
        behavioral_fixtures: Vec::new(),
        strict_src_only_tsc_scope: true,
    };
    assert!(manual.validate().is_err(), "validate() must also enforce the invariant");
}
```

  Also pin the single-flag property in local_service.rs (or a main-level
  unit test if one exists for argv): spawning `serve` with
  `--validation-manifest a --validation-manifest b` exits non-zero with
  "invalid or duplicate option".

- [ ] **Step 4: Green** — the manifest filter, then
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` — expected:
  PASS; every pre-existing suite untouched (no manifest → identical
  config path).

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/manifest.rs crates/strata-kernel/src/bin/strata_kernel_service/main.rs crates/strata-kernel/src/bin/strata_kernel_service/session.rs crates/strata-kernel/src/bridge/protocol.rs crates/strata-kernel/tests/local_service.rs
git commit -m "feat(kernel): committed digested validation manifest — single flag, nesting arithmetic, behavioral unconstructible without fixtures"
```

---

### Task 5: Subprocess timeouts + per-kind bridge deadlines (worker + Rust)

**Files:**
- Modify: `crates/strata-kernel/src/bridge/protocol.rs`
  (`ValidationProfile` gains `tsc_timeout_ms`/`vitest_timeout_ms`)
- Modify: `crates/strata-kernel/src/bridge/process.rs` (`NodeBridgeConfig`
  gains `candidate_deadline: Duration`; `run` picks the deadline by
  request kind)
- Modify: `crates/strata-kernel/src/bridge/router.rs` (mirror candidate
  path passes `candidate_deadline`; the validation-timeout no-replay
  classification)
- Modify: `crates/strata-kernel/src/bridge/executor.rs` (no-replay branch)
- Modify: `crates/strata-kernel/src/kernel.rs` (config wiring)
- Modify: `packages/kernel-bridge/src/protocol.ts` (profile schema),
  `candidate.ts` (thread timeouts), `packages/verify/src/corpusRun.ts`
  (`tscNoEmit`/`runVitest` gain `timeoutMs`)
- Test: `packages/kernel-bridge/tests/candidate.test.ts` additions;
  `crates/strata-kernel/tests/bridge_protocol.rs` or `node_bridge.rs`
  additions

**Interfaces:**
- Wire (bridge protocol, ships lockstep Rust↔worker): BOTH
  `ValidationProfile` variants gain

```rust
    tsc_timeout_ms: u64,
    vitest_timeout_ms: u64,
```

  (required fields — the internal bridge wire has no cross-version
  clients; update `tsc_only()` to fill `DEFAULT_TSC_TIMEOUT_MS`/
  `DEFAULT_VITEST_TIMEOUT_MS` — move those two consts into the bridge
  layer (protocol.rs) and have manifest.rs import them so there is ONE
  definition), `behavioral(…)` gains the two parameters, `validate()`
  bounds them `1_000..=180_000`.
- TS mirror (kernel-bridge/src/protocol.ts): profile schema gains
  `tscTimeoutMs: z.number().int().min(1000).max(180000)`,
  `vitestTimeoutMs: …` (required).
- corpusRun.ts:

```ts
export function tscNoEmit(treeRoot: string, timeoutMs?: number): { tscClean: boolean; output: string; timedOut: boolean }
export function runVitest(treeRoot: string, fixtures?: string[], timeoutMs?: number): { vitestPassed: boolean; output: string; timedOut: boolean }
```

  Both `spawnSync` calls gain `timeout: timeoutMs, killSignal: "SIGKILL"`
  when provided; `timedOut = result.error?.code === "ETIMEDOUT" ||
  result.signal === "SIGKILL"`. `runVitest` additionally appends
  `"--pool=threads"` to its args so test execution stays inside the ONE
  vitest process — killing it therefore leaves no orphaned pool children.
  **This satisfies the spec's "kills the spawned process groups" intent
  by construction (single-process subprocesses) rather than by group
  kill; flag this as an explicit divergence-of-mechanism in the closing
  decisions entry.** All existing callers (product `commit` path) pass
  no timeout → byte-identical behavior.
- candidate.ts: `commitWithBehavioralGate` acceptance context gains the
  two timeouts (threaded from `request.validationProfile`); a timeout
  surfaces as `CandidateFailure("validate", "tscTimedOut" |
  "vitestTimedOut", [], "…")` — codes the Rust discriminator (Task 1)
  already classifies as OPERATIONAL. (verify's `commitWithBehavioralGate`
  signature change: additive optional fields on its options object; the
  product `commit` path is untouched.)
- Rust deadlines: `NodeBridgeConfig` gains
  `candidate_deadline: Duration`; `tsc_only()` sets it =
  `Duration::from_millis(DEFAULT_TSC_TIMEOUT_MS + DEFAULT_VITEST_TIMEOUT_MS + CANDIDATE_OVERHEAD_MS)`
  — WAIT: the byte-identical constraint. Today one-shot candidates run
  under the single 30s `deadline`. Changing the default candidate
  deadline changes tsc-only behavior (a >30s tsc-only candidate that
  timed out today would now succeed). RESOLUTION (spec-faithful,
  documented): `candidate_deadline` defaults to the EXISTING
  `config.deadline` (30s) when no manifest is supplied — byte-identical —
  and is derived from the manifest timeouts
  (`tsc + vitest + CANDIDATE_OVERHEAD_MS`) only when a manifest is
  loaded. `process.rs::run` and the router's candidate request path pick
  `candidate_deadline` for `BuildValidateCandidate` frames and `deadline`
  for everything else. `MirrorCandidateResponse`-level classification: a
  mirror candidate error that is a TIMEOUT (transport deadline exceeded
  OR worker `tscTimedOut`/`vitestTimedOut`) must NOT fall through to the
  one-shot retry in executor.rs:150-157 — it returns the operational
  error directly. Non-timeout transport failures keep the existing
  fallback.
- Consumed by: Tasks 6 (baseline uses the same bounded runs), 8 (timeout
  gates).

- [ ] **Step 1: Write failing TS tests** (kernel-bridge candidate tests +
  a corpusRun-focused test in packages/verify): a fixture test tree whose
  vitest fixture sleeps 10s; `runVitest(tree, [fixture], 1500)` returns
  `{ vitestPassed: false, timedOut: true }` in <5s and leaves no
  `vitest` process running (`ps` check by absence of the scratch-tree cwd
  in the process list — keep the assertion loose enough for CI);
  `tscNoEmit(tree, 60000)` on a real tree still passes with
  `timedOut: false`. Kernel-bridge test: a behavioral candidate request
  whose profile carries `vitestTimeoutMs: 1500` against the sleeping
  fixture returns a `CandidateError` with code `vitestTimedOut` and stage
  `validate`.

- [ ] **Step 2: Red** — the named test filters
  (`PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/verify test corpusRun`,
  `… --filter @strata-code/kernel-bridge test candidate`) — expected:
  FAIL (signatures/behavior absent).

- [ ] **Step 3: Implement TS side** per Interfaces (corpusRun bounded
  runs, schema fields, candidate threading, timeout failure codes).

- [ ] **Step 4: Write failing Rust tests**: `ValidationProfile` validate
  bounds (0 and 200_000 rejected on both fields);
  `tsc_only()` fills the defaults; a `bridge_protocol.rs` round-trip of a
  profile with timeouts; a `process.rs`/`router.rs` unit or integration
  test pinning per-kind deadline selection (candidate frames get
  `candidate_deadline`) — follow the existing test seam
  (`test_with_deadline`) style; and an executor-level test that a mirror
  candidate failure with code `vitestTimedOut` does NOT reach the
  one-shot path (assert via the existing spawn counter:
  `worker_starts_total` unchanged across the failed request in persistent
  mode — reuse the `node_bridge_failures.rs` harness patterns).

- [ ] **Step 5: Implement Rust side**, run
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` +
  `PATH=/opt/homebrew/bin:$PATH pnpm kernel:bridge:test` — expected: PASS
  (tsc-only defaults keep every existing suite green).

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src/bridge crates/strata-kernel/src/kernel.rs packages/kernel-bridge/src packages/kernel-bridge/tests packages/verify/src/corpusRun.ts packages/verify/tests
git commit -m "feat(kernel): bounded tsc/vitest subprocesses, per-kind bridge deadlines, no one-shot replay of validation timeouts"
```

---

### Task 6: Seed-green startup gate + manifest identity on startup/audit/hello

**Files:**
- Modify: `crates/strata-kernel/src/bridge/protocol.rs` (internal
  `ValidateBaseline` frames), `process.rs`/`router.rs` (dispatch),
  `kernel.rs` (a `pub fn validate_baseline(&self) -> Result<BaselineVerdict>`)
- Create: `packages/kernel-bridge/src/baseline.ts` (+ `worker.ts`
  dispatch, `protocol.ts` schema)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`
  (seed-green refusal + readiness fields), `session.rs` (audit fields,
  `hello` result), `main.rs` (threading)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
  + `packages/live-compare/src/protocol.ts` + golden fixtures (`hello`
  `Ready` gains validation fields — lockstep)
- Test: `crates/strata-kernel/tests/local_service.rs` (behavioral daemon
  spawn tests), kernel-bridge baseline tests

**Interfaces:**
- Internal bridge frame (Rust + TS, lockstep):

```rust
// request: kind "validateBaseline", carries binding + snapshot + validation_profile
// response: { ok: true, result: { green: bool, diagnostics: Vec<BridgeDiagnostic> } } or standard error
pub(crate) struct ValidateBaselineRequest { /* binding, snapshot, validation_profile */ }
```

  Worker `baseline.ts`: hydrate snapshot → materialize tree (reuse the
  candidate pipeline's materialization WITHOUT any mutation step) → run
  `tscNoEmit(tree, tscTimeoutMs)` + `runVitest(tree, fixtures,
  vitestTimeoutMs)` → `{ green, diagnostics }` (red carries the bounded
  tsc/vitest output as diagnostics; timeout is an error response with the
  Task-5 timeout codes).
- `Kernel::validate_baseline()` → runs the frame one-shot (baseline runs
  once at startup; no mirror involvement) against the CURRENT snapshot;
  returns `BaselineVerdict { green: bool, diagnostics: Vec<…> }`.
- server.rs: when `config.validation.mode == "behavioral"`, AFTER
  `ServiceSession::open` and BEFORE `bind_private_socket`:
  `session.validate_baseline()?` — red → `bail!` with up to 8 bounded
  diagnostic lines (daemon exits 2 pre-readiness, the existing
  startup-failure surface); operational baseline error → also refuse
  (fail-closed startup). `Readiness` gains

```rust
    validation_mode: String,                    // "tscOnly" | "behavioral"
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_manifest_digest: Option<String>,
```

- Client wire `hello` (lockstep, B-1 style): `ResponseResult::Ready {}` →

```rust
    Ready {
        validation_mode: String,
        validation_manifest_digest: Option<String>,  // null on the wire when absent? NO:
    },
```

  Use `#[serde(default, skip_serializing_if = "Option::is_none")]` on the
  digest and `#[serde(default)]`… — NO DEFAULTS on a strict wire: make
  BOTH fields required with digest NULLABLE
  (`Option<String>` serialized as `null`), update the TS `ready` schema
  to `{ type, validationMode: z.enum(["tscOnly","behavioral"]),
  validationManifestDigest: digestSchema.nullable() }`, and update every
  golden fixture + hand-built `ready` result in tests (grep
  `"type":"ready"` / `type: "ready"` across live-compare and
  local_service fixtures — same sweep discipline as B-1's `hasMore`).
- Audit: `service_started`/`service_recovered` events gain
  `validation_mode` + `validation_manifest_digest` fields (audit schema is
  service-internal JSONL — additive).
- Consumed by: Task 7 (behavioral daemons), Task 9 (digest pinning).

- [ ] **Step 1: Write failing kernel-bridge baseline tests** (TS):
  `validateBaseline` on a green tree+fixture → `{ green: true }`; on a
  tree whose fixture asserts false → `{ green: false }` with diagnostics
  containing the vitest failure text; sleeping fixture + small timeout →
  error with code `vitestTimedOut`.

- [ ] **Step 2: Red, implement worker side, green** (kernel-bridge
  filters).

- [ ] **Step 3: Write failing Rust tests**: internal frame round-trip +
  binding validation (bridge_protocol.rs pattern); local_service
  behavioral daemon tests:
  - `seed_green_daemon_serves_and_reports_digest`: temp corpus copy of
    `examples/medium` + one PASSING fixture
    (`tests/behavioral/baseline-pin.test.ts` asserting a trivial true
    import-free property of the corpus — e.g. importing `greet` and
    asserting its current output) + manifest JSON with correct sha256 →
    daemon starts; readiness JSON carries `validationMode: "behavioral"`
    and the manifest digest; `hello` echoes both; audit start event
    carries both.
  - `seed_red_daemon_refuses_to_serve`: same corpus but the fixture
    asserts a false property → daemon exits non-zero BEFORE any readiness
    line; stderr contains the fixture failure text.
  - `tsc_only_daemon_reports_null_digest`: existing tsc-only spawn now
    asserts `validationMode: "tscOnly"`, digest null, `hello` matches.

- [ ] **Step 4: Red** (the new filters), **implement Rust + wire + fixture
  sweep, green** — including
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test`
  full package (hello shape changed — client.test/service.test/gate
  harness assertions may pin `ready`; sweep and update, list files in
  report).

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src packages/kernel-bridge/src packages/kernel-bridge/tests packages/live-compare/src/protocol.ts packages/live-compare/tests crates/strata-kernel/tests
git commit -m "feat(kernel): seed-green behavioral startup gate; manifest identity on readiness, audit, and hello"
```

---

### Task 7: Behavioral rejection/parity gate

**Files:**
- Create: `packages/live-compare/tests/behavioralGate.test.ts`
- Create: `packages/verify/tests/behavioralParity.test.ts`
- Modify: `packages/live-compare/src/service.ts` (`startKernelService`
  gains optional `validationManifestPath` passed through as
  `--validation-manifest`; additive, default absent)

**Interfaces:**
- Consumes: everything from Tasks 1–6 over the wire; `examples/medium`;
  `commitWithBehavioralGate` (verify) as-is.
- Gate scenario (deterministic, key-free): temp corpus = copy of
  `examples/medium` + `tests/behavioral/greet-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { greet } from "../../src/features/greet";   // adjust to the real module path

describe("greet behavioral contract", () => {
  it("greets by name", () => {
    expect(greet("Ada")).toContain("Ada");
  });
});
```

  (Resolve the real import path/signature from the corpus before writing
  the fixture; the fixture MUST pass at generation zero — the seed-green
  startup gate enforces this, which is itself part of the test.)
  Manifest: behavioral, that one fixture + its sha256, strict scope true,
  timeouts 60_000/90_000.
  - **Rejected mutation (compiles-but-behaviorally-wrong):** rename
    `greet` → `welcomeUser`. Under `strictSrcOnlyTscScope` the tsc pass
    covers `src/**` only → tree compiles; the fixture's `import { greet }`
    then fails at vitest time → behavioral red. Assert: state
    `validation_failed`; diagnostics non-empty; at least one diagnostic
    `code` starts with `"behavioralFailed"`; message contains the vitest
    failure text (`"greet"`); generation unchanged; NO
    `candidate_validation_failed` anywhere.
  - **Clean mutation publishes:** rename `User` → `Account` (the fixture
    imports only `greet`) → published, fixture still green (implicitly:
    publication passed the behavioral gate), digest present.
  - **Parity (same inputs through the product gate):**
    `behavioralParity.test.ts` in packages/verify: ingest the same temp
    corpus into a SQLite store, apply the same rename `greet` →
    `welcomeUser` via `rename_symbol`, `commitWithBehavioralGate` with
    the same fixture list → `ok: false` with `testFailures` containing
    the same vitest failure marker; the clean `User` → `Account` rename →
    `ok: true`. (Product gate consumed AS-IS — any behavioral difference
    between kernel and product verdicts on these two mutations is a
    genuine finding: STOP and report, do not normalize.)
- Produces: the spec's B-2 gate (c).

- [ ] **Step 1: Write both test files** (they are acceptance gates against
  Tasks 1–6 behavior — label them as such, not failing-first TDD; the
  service.ts passthrough is the only production edit and is covered by
  the gate itself).
- [ ] **Step 2: Run** —
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test behavioralGate`
  and `… --filter @strata-code/verify test behavioralParity` — expected:
  PASS. On the parity assertion failing: STOP, report both verdicts
  verbatim (this is the gate doing its job).
- [ ] **Step 3: Commit**

```bash
git add packages/live-compare/tests/behavioralGate.test.ts packages/live-compare/src/service.ts packages/verify/tests/behavioralParity.test.ts
git commit -m "test(kernel): behavioral rejection + product parity gate — real diagnostics on the kernel path, identical product verdicts"
```

---

### Task 8: Timeout / savepoint recovery gates

**Files:**
- Create: `packages/live-compare/tests/behavioralTimeout.test.ts`
- Test additions: `crates/strata-kernel/tests/local_service.rs` only if a
  Rust-side assertion (metrics parse) is easier there — default is the TS
  file.

**Interfaces:**
- Consumes: Tasks 1–7. Scenario: temp corpus + a manifest whose fixture
  set includes BOTH the green `greet-contract` fixture AND
  `tests/behavioral/slow.test.ts` (sleeps 10s)… **No** — seed-green would
  hang on the slow fixture at startup. Instead: manifest carries the
  green fixture with `vitestTimeoutMs: 120_000` for startup? The manifest
  is per-daemon and startup uses the same timeouts. RESOLUTION: the slow
  fixture sleeps only when an env-independent MARKER FILE exists in the
  tree — no: candidate trees are materialized from the graph, and
  `tests/**` ride the corpus copy, so the fixture content is identical at
  startup and at candidate time. CORRECT deterministic lever: the sleep
  triggers on the MUTATED content — the fixture does
  `if (greet("Ada").includes("Bonjour")) { await sleep(10_000); }` and
  the test's mutation is an `add_parameter`-free rename… renames don't
  change strings. USE `add_parameter` on `greet` with
  `value: "\"Bonjour\""`-style? `add_parameter` appends a parameter with
  a uniform value at callsites — it does not change `greet`'s output
  either. FINAL, SIMPLE LEVER: the fixture sleeps
  `if (typeof (globalThis as Record<string, unknown>).__strataNever === "undefined")`
  — i.e. ALWAYS sleeps — and the DAEMON manifest sets
  `vitestTimeoutMs: 2_000` while the fixture sleeps 10s. Seed-green would
  then fail at startup… which means: **the timeout gate cannot use the
  startup-gated manifest path with an always-slow fixture.** Resolve by
  testing the timeout at the WORKER/bridge layer instead (Task 5 already
  pins `vitestTimedOut` at the kernel-bridge layer) and, at the daemon
  layer, by driving the operational branch via the one REMAINING
  deterministic daemon-level lever: a behavioral daemon whose manifest is
  green, plus a candidate whose mutation makes the fixture slow — a
  rename `greet` → name the fixture keys its sleep on:

```ts
import * as mod from "../../src/features/greet";
it("contract", async () => {
  if (!("greet" in mod)) { await new Promise((r) => setTimeout(r, 10_000)); }
  expect(true).toBe(true);
});
```

  Generation zero: `greet` exists → no sleep → seed-green fast. After
  rename `greet` → `welcomeUser`: the export disappears → fixture sleeps
  10s → with `vitestTimeoutMs: 2_000` the candidate validation TIMES OUT
  deterministically. This is the timeout lever.
- Assertions (the spec's point-4 gate, all in one daemon lifetime,
  persistent-bridge mode `--persistent-bridge`):
  1. advance of the sleepy rename → `ok: false`, code
     `candidate_execution_failed`, `retryable: true` (operational, NOT
     `validation_failed`).
  2. generation unchanged (hello/`list_modules` generation identical
     before/after).
  3. no one-shot auto-replay: with `--metrics` active, the metrics JSONL
     shows `worker_starts_total` (or the per-run records) consistent with
     ZERO one-shot candidate spawns for that request — parse the sink;
     exact field names from `metrics.rs` (read it during implementation
     and pin the real field).
  4. savepoint rolled back + mirror healthy: a subsequent CLEAN rename
     (`User` → `Account`) on the SAME daemon publishes green (the Task-7
     poison latch + fingerprint assertion would refuse if the savepoint
     had leaked — publishing at all proves rollback + fingerprint
     equality + healthy rehydration).
  5. process cleanup: within a bounded wait after the timeout response,
     no vitest process whose cwd is under the daemon's scratch tree
     remains (best-effort `ps`-based assertion with a generous
     tolerance; skip-with-note on platforms where `ps` output is
     unavailable).
  6. change set non-terminal: a follow-up `advance` returns a
     non-terminal state (claim intact), and after `cancel_change_set` the
     daemon is fully usable.
- Produces: spec gate (d).

- [ ] **Step 1: Write the gate** (acceptance style, per above, timeout
  240_000).
- [ ] **Step 2: Run** —
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test behavioralTimeout`
  — expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add packages/live-compare/tests/behavioralTimeout.test.ts
git commit -m "test(kernel): behavioral timeout recovery gate — operational taxonomy, intact claim, healthy mirror, no one-shot replay"
```

---

### Task 9: Registered-fixture reader (client wire, lockstep)

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`,
  `session.rs`; `packages/live-compare/src/protocol.ts`, `client.ts`,
  `tools.ts`; golden fixtures; `packages/live-compare/tests/{protocol,client,tools}.test.ts`
- Test: `crates/strata-kernel/tests/local_service.rs` (reader integration)

**Interfaces:**
- Wire requests (read-only, no idempotency key — extend `is_mutating`
  omission lists BOTH sides):

```rust
    ListValidationFixtures {},
    ReadValidationFixture {
        fixture_id: String,          // the fixture's sha256 (64 lowercase hex)
        offset: u64,                 // byte offset
        length: u32,                 // 1..=8_192
    },
```

- Wire results:

```rust
    ValidationFixtures {
        validation_mode: String,
        validation_manifest_digest: Option<String>,
        fixtures: Vec<FixtureSummary>,   // ≤ 64
    },
    // FixtureSummary { fixture_id: String (sha256), path: String (corpus-relative POSIX), bytes: u64 }
    ValidationFixtureChunk {
        fixture_id: String,
        offset: WireU64,
        content_base64: String,          // ≤ ceil(8192/3)*4 bytes
        eof: bool,
    },
```

  TS mirrors with `.strict()` schemas; bounds pinned in both validators;
  golden fixtures for accepted (list on behavioral, list on tscOnly
  (empty, digest null), chunk with eof) and rejected (length 0, length
  8193, bad fixture_id hex).
- Session semantics: reads the fixture file from disk at request time,
  re-verifies its sha256 against `ValidationSettings.fixtures`
  (digest-pinned: content drift after startup → `request_failed`, never
  stale bytes); unknown fixture_id → `request_failed`; offset past EOF →
  empty content + `eof: true`. tscOnly mode: list returns empty + null
  digest; read → `request_failed` ("no registered fixtures").
- Client wrappers:

```ts
listValidationFixtures(deadlineMs = DEFAULT_REQUEST_DEADLINE_MS)
readValidationFixture(fixtureId: string, offset: string, length: number, deadlineMs = DEFAULT_REQUEST_DEADLINE_MS)
```

  (offset as canonical-u64 string, the `WireU64` convention.)
- Tools (2 new, 15 total), descriptions in the worldview register:
  - `list_validation_fixtures`: "List the registered behavioral fixtures
    that define this codebase's validation contract: stable fixture IDs,
    display paths, sizes, and the validation manifest digest they are
    pinned to. Empty under tsc-only validation. These are the tests your
    change must keep green; read them with read_validation_fixture before
    choosing a change that could alter behavior."
  - `read_validation_fixture`: "Read one registered validation fixture in
    bounded chunks by its fixture ID: base64 content from a byte offset,
    at most 8192 bytes per call, with eof marking the end. This is not a
    general file reader — only manifest-registered fixtures are readable,
    and content is verified against the manifest digest on every read."
- Produces: spec point 5 + gate (e) reader schemas.

- [ ] **Step 1: Failing wire tests** (B-1 Task-1 pattern: types first
  compile-only, validator tests red, validators green, fixtures, TS
  lockstep, `is_mutating` omission lists, journal-replay bail arm).
- [ ] **Step 2: Failing daemon integration tests** (`fixture_reader_`
  prefix): behavioral daemon lists the manifest fixture with matching
  sha256/bytes; chunked read at length 64 reassembles the exact file
  bytes with correct eof; tscOnly daemon lists empty; tampering with the
  fixture file after startup makes the read fail (digest pin); bounds
  rejections.
- [ ] **Step 3: Implement session handlers + wrappers + tools; green** the
  filters, then full live-compare suite + whole crate.
- [ ] **Step 4: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service packages/live-compare/src packages/live-compare/tests crates/strata-kernel/tests/local_service.rs
git commit -m "feat(kernel): digest-pinned registered-fixture reader — list_validation_fixtures + chunked read_validation_fixture, dual-language + tools"
```

---

### Task 10: Cost disclosure, gate wiring, full chain, closing records

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/metrics.rs`
  (+ the request-record emission path in session.rs),
  `crates/strata-kernel/src/bridge/persistent.rs` (queue-wait
  measurement)
- Modify: `package.json`, `decisions.md`, `docs/product-roadmap.md`

**Interfaces:**
- Cost disclosure (spec point 6 — disclosure surfaces are the metrics
  sink + audit, NOT the client wire): the per-request metrics record for
  behavioral-mode advances gains

```rust
    // all Option/defaulted so tsc-only records are byte-identical
    validation_wall_ms: Option<u64>,       // candidate bracket wall (worker self-metrics validate stage)
    queue_wait_ms: Option<u64>,            // persistent host: started -> lock acquired
    one_shot_fallbacks_total: u64,         // session-lifetime counters, emitted per record
    rehydrations_total: u64,
    validation_timeouts_total: u64,
```

  `persistent.rs::request_at_with_size` measures `started → after
  lock_state` and exposes it to the router's per-run record (follow the
  existing `WorkerRunMetrics` plumbing; read `metrics.rs` +
  `router.rs`'s record fields and extend in-style). Counters live on the
  kernel (AtomicU64, same style as `spawns_total`). Behavioral-mode-only:
  when `ValidationSettings.mode == "tscOnly"` and no `--metrics`, no
  behavior change at all.
- Gate wiring:

```json
"kernel:behavioral:test": "pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && pnpm --filter @strata-code/verify build && cargo build -p strata-kernel && cargo test -p strata-kernel --test bridge_rejection && pnpm --filter @strata-code/verify test behavioralParity && pnpm --filter @strata-code/live-compare test behavioralGate behavioralTimeout"
```

  appended to `kernel:full-key-free:test` (after `kernel:discovery:test`).
- Closing records: decisions.md APPENDED entry (2026-08-0X): what shipped
  (taxonomy, manifest, seed-green, nesting, reader, disclosure); explicit
  divergences to record: (a) the `--pool=threads` single-process
  mechanism standing in for literal process-group kill; (b) the tsc-only
  `candidate_deadline` defaulting to the legacy 30s for byte-identical
  behavior (manifest-driven daemons get the derived deadline); (c) the
  semantic/operational code partition (exact code lists); (d) anything
  discovered during build. Roadmap: item B complete (B-1 + B-2), next
  item unblocked (D). `strata-design.md` NOT edited.
- Produces: spec gates (a)–(e) all wired key-free; slice close.

- [ ] **Step 1: Failing metrics tests** (unit: record serialization with
  the new optional fields absent → byte-identical to today's records;
  integration: a behavioral daemon with `--metrics` emits
  `validation_wall_ms` + `queue_wait_ms` on a published behavioral
  mutation and increments `validation_timeouts_total` across the Task-8
  timeout scenario — extend `behavioralTimeout.test.ts`'s metrics
  parsing).
- [ ] **Step 2: Implement, green the filters.**
- [ ] **Step 3: package.json wiring; run
  `PATH=/opt/homebrew/bin:$PATH pnpm kernel:behavioral:test` green.**
- [ ] **Step 4: Full chain** —
  `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test`, detached
  (Orca), log evidence captured; known load-sensitive steps per the B-1
  ledger (gate3) handled the same way: sole-failure → check `uptime`,
  re-run that step once, document.
- [ ] **Step 5: Workspace sweep** with the known pre-existing exceptions
  (verify extraction, agent replay, bench — see decisions.md 2026-08-01);
  anything NEW is yours.
- [ ] **Step 6: decisions.md + roadmap; commit**

```bash
git add crates/strata-kernel/src packages package.json decisions.md docs/product-roadmap.md
git commit -m "chore(kernel): behavioral-gate cost disclosure, gate wiring into key-free chain; record B-2 close"
```

---

## Explicit non-goals

- No red-by-design task fixtures, no task-scoped/baseline-relative gate
  design (recorded house history — B-2's manifest is seed-green shared
  regression only).
- No change-set-selectable validation profiles (every agent pays the same
  gate).
- No general file reads; the reader serves manifest-registered fixtures
  only.
- No refactor of `commitWithBehavioralGate`/product-gate semantics; it is
  the parity ORACLE.
- No re-adjudication of recorded exit-gate artifacts; no keyed runs.
- No item-C structural-ID work; no changes to `tasks.ts` (never staged).

## Self-Review (v1)

Spec coverage: point 1 → Tasks 1–3; point 2 → Tasks 4+6; point 3 → Task 5;
point 4 → Task 8 (+ Task 5 worker bounds); point 5 → Task 9; point 6 →
Task 10; gates (a) unit surfaces spread across 1–6, (b) Task 6, (c) Task
7, (d) Task 8, (e) Tasks 9–10. Type-consistency pass done (CandidateRejected /
ValidationSettings / manifest names used identically across tasks).
Known open questions deliberately left for the methodology review:
1. The semantic/operational CODE PARTITION (is `mutationFailed` semantic?
   is stage-based dispatch robust against future worker codes — should
   unknown validate-stage codes default operational (fail-closed) as
   drafted?).
2. `--pool=threads` as the process-cleanup mechanism vs literal group
   kill (divergence of mechanism, spec-intent argument in Task 5).
3. tsc-only `candidate_deadline` staying 30s for byte-identicality vs
   deriving from defaults (Task 5 resolution).
4. Operational failures leaving the claim intact relying on lease-expiry
   re-offer (Task 3) — is a stuck-claim scenario reachable if the lease
   never expires under a quiet scheduler?
5. Task 8's export-disappearance sleep lever — is there a simpler
   deterministic timeout lever?
6. `hello` Ready gaining REQUIRED fields (strict, lockstep) vs optional —
   drafted required+nullable; fixture sweep cost is real.
7. Whether Task 6's `ValidateBaseline` should reuse the candidate frame
   with zero intents instead of a new frame kind.
