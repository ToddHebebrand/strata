# Deterministic Full Key-Free Acceptance Implementation Plan

> **For agentic workers:** Execute with `subagent-driven-development`. Every production behavior starts with a failing test under `test-driven-development`. Run `verification-before-completion` before each completion claim and one independent repo-grounded review after the full gate is green. Do not run live models or benchmarks.

**Goal:** Close all twelve deterministic Phase-6 acceptance rows with multiple independent clients, real `examples/medium` typed operations, the sealed Rust/Node execution path, redb durability/recovery, and one named key-free gate command.

**Architecture:** Add a dedicated integration acceptance target around the public `Kernel` API and production Node bridge. Reuse the existing exhaustive scheduler, publication, crash, replay, event, and sealing suites for operation-independent properties, adding thin real-bridge joins where necessary. Rust retains all authority; Node supplies bounded facts and validated deltas. Candidate validation remains limited to the approved exact `src/**` projection.

**Approved design:** `docs/superpowers/specs/2026-07-15-deterministic-full-key-free-acceptance-design.md`

## Non-negotiable constraints

- No production-code change before this plan is approved.
- No behavior implementation before a focused failing test demonstrates the gap.
- Clients submit typed intents and never enumerate resource keys, reservations, clocks, fences, or containment.
- Node never receives canonical-storage access or returns authority fields.
- Normal-build authority remains sealed; all injection stays feature-gated.
- No live-model calls, API keys, benchmark rounds, wall-clock scheduling, or direct redb access by clients.
- Preserve stable logical IDs, aggregate operation history, optimistic rebase rules, and the SQLite product path.
- Do not add operation classes, per-callsite parameter values, structural insert/delete/move concurrency, or any excluded Phase-6 scope.
- Stop on any design stop condition and record the divergence in `decisions.md` before proceeding.

## Planned file structure

### Acceptance harness and fixtures

- Create `crates/strata-kernel/tests/full_key_free_acceptance.rs`.
- Create `crates/strata-kernel/tests/support/full_key_free.rs` for deterministic client actors, projected-corpus setup, canonical assertions, and test-only crash child orchestration.
- Reuse `crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json` and `examples-medium-add-parameter-g1.snapshot.json`; do not create toy graph fixtures.
- Modify `crates/strata-kernel/tests/node_bridge.rs` only to extract reusable projected-corpus helpers or remove duplicate coverage after the dedicated target owns it.
- Modify `crates/strata-kernel/tests/coordination_acceptance.rs`, `coordination_publication.rs`, `recovery.rs`, or redb crash tests only when a failing acceptance test reveals a missing assertion or production defect.

### Production files, only if RED proves a gap

- `crates/strata-kernel/src/coordination/{analyzer,coordinator,durable,planner,publication,scheduler}.rs`
- `crates/strata-kernel/src/bridge/{process,provider,executor}.rs`
- `crates/strata-kernel/src/{kernel,storage,graph}.rs`
- `packages/kernel-bridge/src/{analyze,candidate,protocol,worker}.ts`

No production file is changed merely to make the harness convenient.

### Gate and evidence

- Modify root `package.json` with `kernel:full-key-free:test`.
- Create `docs/spikes/2026-07-15-deterministic-full-key-free-acceptance.md` after the gate passes.
- Modify `docs/product-roadmap.md` only after all evidence is green.
- Append `decisions.md` only for an actual divergence.

## Task 1: Build the deterministic multi-client acceptance shell

**Files:**

- Create: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Create: `crates/strata-kernel/tests/support/full_key_free.rs`
- Modify: `crates/strata-kernel/tests/node_bridge.rs`
- Modify: `package.json`

- [ ] Add a compile-only failing acceptance target that references deterministic `ClientActor`, projected-corpus, reopen, event-cursor, and canonical-final-state helpers that do not exist.
- [ ] Run the focused target with both test features and confirm RED from the missing harness, not environment setup.
- [ ] Extract the exact source-projection and validation-profile setup from `node_bridge.rs`; keep the asserted full/projected counts and excluded references byte-for-byte equivalent.
- [ ] Implement independent logical actors with fixed IDs and only public `Kernel` calls. Do not wrap or expose storage.
- [ ] Add canonical assertions for graph generation/digest, nodes, references, operations, tickets, events, cursors, and final TypeScript validation.
- [ ] Add `kernel:full-key-free:test` initially targeting only the bridge build plus the new ignored real-worker acceptance binary. Later tasks expand it to the full matrix.
- [ ] Run the focused acceptance target and existing bridge tests.
- [ ] Commit: `test(kernel): scaffold deterministic full-key-free gate`.

## Task 2: Close real disjoint, same-symbol, and inferred-overlap rows

**Acceptance rows:** 1, 2, 3

**Files:**

- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Modify only on demonstrated defect: `crates/strata-kernel/src/coordination/{analyzer,planner,lifecycle,scheduler,publication}.rs`
- Modify only on demonstrated bridge defect: `crates/strata-kernel/src/bridge/provider.rs`, `packages/kernel-bridge/src/analyze.ts`

- [ ] Add a row-1 regression case for two independent disjoint rename clients publishing in both orders, including final green state and two-operation history. Existing behavior may make this green immediately; do not manufacture a product change.
- [ ] Add a row-2 case for `User -> Account` followed by `User -> Customer`; assert FIFO, fresh generation/context, and `IntentNeedsDecision` with no second publication.
- [ ] Add a row-3 case for `rename_symbol(greet)` versus `add_parameter(greet)`; assert the inferred reservation overlap exists before mutation and prevents concurrent claims.
- [ ] Run only the three cases and record which integrated assertions are already green. For any product defect, preserve the failing assertion as the RED step before implementation.
- [ ] Make the minimum production correction only if an existing real bridge path fails. Keep Node outputs fact-only and Rust scope/policy authoritative.
- [ ] Run the focused cases, `node_bridge`, and `coordination_acceptance` suites.
- [ ] Commit: `test(kernel): prove real overlap and decision ordering` (or `fix(kernel): ...` if RED exposes a product defect).

## Task 3: Close dynamic expansion, starvation, restart, fencing, and event rows

**Acceptance rows:** 4, 5, 6, 7, 11

**Files:**

- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Modify: `crates/strata-kernel/tests/support/full_key_free.rs`
- Modify only on demonstrated defect: `crates/strata-kernel/src/coordination/{coordinator,durable,planner,scheduler,publication}.rs`

- [ ] Port the real G+1 callsite case into the named gate and add the missing independent publisher/client-history assertions, pre-mutation requeue, expanded scope fingerprint, and final green state.
- [ ] Add a logical-tick starvation case using production Node-derived scopes. Assert disjoint bypass is allowed, overlapping bypass is bounded, and the old wide rename becomes claimable without sleeps.
- [ ] Add a reopen case containing a real queued ticket, an unacknowledged event, and a held claim. Assert durable recovery of the queue/cursor and rejection of the old epoch/fence through normal `execute_claimed`.
- [ ] Add a duplicate-delivery assertion over a real bridge publication: the same event ID may be observed again before acknowledgement, acknowledgement is monotonic/idempotent, and no operation republishes.
- [ ] Run each case against the unmodified product first. Any production correction begins only after its focused assertion is demonstrably RED.
- [ ] Implement only proven scheduler/recovery corrections. Test hooks remain feature-gated.
- [ ] Run the focused cases plus existing scheduler, recovery, publication, and event tests under both feature configurations.
- [ ] Commit: `test(kernel): prove fair restart-safe client coordination` (or a scoped `fix(kernel): ...`).

## Task 4: Join the real bridge to exhaustive crash and replay evidence

**Acceptance rows:** 6, 8, 9

**Files:**

- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Modify: `crates/strata-kernel/tests/support/full_key_free.rs`
- Modify existing redb crash/replay tests only to share the authoritative boundary enumeration.
- Modify only on demonstrated defect: `crates/strata-kernel/src/coordination/publication.rs`, `crates/strata-kernel/src/{storage,graph}.rs`

- [ ] Add a child-process test that carries one real claimed Node candidate to each existing authorized redb boundary enumeration, crashes, reopens, and classifies the durable tuple as complete-old or complete-new.
- [ ] Assert every boundary is covered exactly once and no graph/operation/event/ticket/fence tuple is mixed. Keep the existing raw boundary matrix as the exhaustive owner; the bridge test must call the same enumeration rather than define a second list.
- [ ] Add a real replay case: publish two real bridge generations, force/cross a snapshot boundary through existing test support, publish a later operation, reopen, and compare canonical node/reference/index bytes plus generation digest and operation order.
- [ ] Run both cases against the unmodified product first. Any storage/publication correction begins only after its focused assertion is demonstrably RED.
- [ ] Confirm recovery after publication needs no Node process and rejects every held pre-restart claim.
- [ ] Make the minimum storage/publication correction only if RED exposes a defect; never add a client-visible failpoint.
- [ ] Run the focused crash/replay tests and the complete `redb-spike-api` suite.
- [ ] Commit: `test(kernel): join bridge execution to crash recovery` (or a scoped `fix(kernel): ...`).

## Task 5: Prove the only-green-together aggregate change set

**Acceptance row:** 10

**Files:**

- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Modify only on demonstrated defect: `crates/strata-kernel/src/bridge/executor.rs`, `crates/strata-kernel/src/coordination/publication.rs`, `packages/kernel-bridge/src/candidate.ts`

- [ ] Add a negative-control test submitting only `add_parameter(greet, account: Account, defaultValue: "undefined as never")` on G0. The candidate must fail TypeScript validation while the test asserts bounded diagnostics and unchanged graph/history/generation.
- [ ] Add a grouped test with ordered `rename_symbol(User, Account)` then the same `add_parameter`. Assert one scratch transaction, successful TypeScript validation, one generation, one aggregate operation, two ordered intent results, and no visible intermediate graph.
- [ ] Run both tests against the unmodified product first. Any atomic-composite correction begins only after its focused assertion is demonstrably RED.
- [ ] Add canonical final-state assertions: renamed declaration/references, updated function declaration/calls, stable IDs, and green projected corpus.
- [ ] If the negative control does not fail or the aggregate cannot pass with current semantics, stop and record the finding; do not add a new operation or weaken the gate.
- [ ] Implement the minimum atomic-composite correction only if the existing path fails for a reason covered by the approved design.
- [ ] Run focused bridge candidate tests, the grouped acceptance case, and all publication/composite tests.
- [ ] Commit: `test(kernel): prove only-green-together publication` (or a scoped `fix(kernel): ...`).

## Task 6: Seal the named twelve-row gate

**Acceptance rows:** all, especially 12

**Files:**

- Modify: `package.json`
- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs`
- Modify: `crates/strata-kernel/tests/api_sealing.rs`
- Modify UI compile-fail fixtures only if a new authority surface was added by a justified production fix.

- [ ] Add a checked row-to-test manifest in the acceptance source so all integers 1–12 have one primary owner and the test fails if a row is missing or duplicated.
- [ ] Add a failing protocol assertion that production worker requests contain no redb path, canonical store handle, resource keys, clocks, reservations, fences, policies, candidate digest, or publication instructions.
- [ ] Run default-feature trybuild/runtime sealing and prove test-only constructors, hooks, envelopes, and storage APIs remain unavailable.
- [ ] Finalize `kernel:full-key-free:test` to build/test the bridge, run real-worker multi-client acceptance, run default Rust, `coordination-test-api`, and `redb-spike-api` suites, and rerun default sealing explicitly.
- [ ] Run the named command from a key-free environment and confirm it neither reads model credentials nor invokes benchmark/live-agent packages.
- [ ] Commit: `test(kernel): seal deterministic full-key-free gate`.

## Task 7: Evidence, roadmap, and final independent review

**Files:**

- Create: `docs/spikes/2026-07-15-deterministic-full-key-free-acceptance.md`
- Modify: `docs/product-roadmap.md`
- Modify: `decisions.md` only for actual divergence

- [ ] Run fresh verification from the implementation HEAD:

  ```bash
  pnpm kernel:full-key-free:test
  pnpm -r build
  pnpm -r test
  git status --short
  ```

- [ ] Record exact test counts, commands, timings, fixture counts, digests, crash boundaries, and the twelve-row evidence mapping. Classify the known verify TS2454 and stale replay-fixture baselines without modifying them unless this work caused a regression.
- [ ] Update the roadmap key-free item only when every hard invariant is green. Keep live comparison unchecked and explicitly forbidden until this gate is approved.
- [ ] Append `decisions.md` only if implementation diverged from the approved design; otherwise state that no decision entry was required.
- [ ] Request one independent read-only, repo-grounded review using the strongest available Codex model at `xhigh`. Supply the diagnosis, falsified/forbidden levers, exact acceptance matrix, hard boundaries, commits, and verification evidence.
- [ ] Verify every pivotal reviewer claim against code/tests. Fix Critical or Important findings test-first; because such a fix touches authority/concurrency/recovery, run one additional review only for the changed surface as permitted by the task rule.
- [ ] Rerun the complete named gate after any fix, ensure a clean worktree, and commit evidence/docs as `docs(kernel): approve deterministic key-free gate`.

## Final handoff requirements

The handoff must include the worktree/branch and commit range, acceptance-row evidence, full commands and outcomes, any known unrelated failures, design divergences, final reviewer verdict, clean-worktree proof, and a plain statement that live-model comparison remains unrun and unauthorized.
