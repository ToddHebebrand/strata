# Phase-6 Live Multi-Agent Comparison Implementation and Execution Plan

> **Approval gate:** This plan is documentation only. Do not execute Task 1 or
> change production code until Task 0's read-only, repo-grounded Codex design
> review is attached and the operator approves the reviewed
> `docs/superpowers/specs/2026-07-16-phase-6-live-comparison-design.md`, including
> one corpus variant. Use
> `executing-plans`, strict `test-driven-development`,
> `subagent-driven-development` where tasks are independent, and
> `verification-before-completion`. Run one `requesting-code-review` round with
> a read-only, repo-grounded outside model after the deterministic gate is
> green. Do not make a keyed model call until the separate Task 9 budget gate is
> explicitly approved.

**Goal:** Build and deterministically validate the minimal single-host service,
independent Strata clients, matched Git-worktree/integration baseline, task
packets, common verifier, event/artifact pipeline, and approval-locked live
runner needed for the first Phase-6 comparison.

**Architecture:** A Rust daemon is the sole redb/kernel owner and exposes a
strict bounded Unix-socket protocol. A new private `@strata/live-compare`
package supplies an unprivileged client, coordination-only MCP tools, two-agent
Strata runner, two-worktree-plus-integration baseline runner, shared verifier,
seeded schedule, and immutable artifacts. `@strata/agent` extracts its existing
hermetic Agent SDK loop so both the current SQLite agent and the coordination
agent use the same model/session accounting without sharing storage contexts.

**Tech stack:** Rust 1.89/edition 2024, redb 4.1, serde/serde_json, Unix domain
sockets, TypeScript 5.8, Zod 4, Vitest 3, `@anthropic-ai/claude-agent-sdk`
0.2.118, pnpm 10, Git worktrees, existing Strata ingest/render/verify packages.

**Design:**
`docs/superpowers/specs/2026-07-16-phase-6-live-comparison-design.md`

## Non-negotiable constraints

- No experimental Agent SDK model process may start in Tasks 1-8. All session
  tests use scripted fakes or replay fixtures with API credentials removed from
  the environment. The only model calls permitted before Task 9 are the
  explicitly required read-only Codex reviews in Tasks 0 and 8.
- Model clients never receive or open a redb/canonical path, bridge worker
  configuration, filesystem path to canonical Strata state, scope, resource
  key, clock, reservation, claim, fence, attempt, candidate delta, or raw
  operation table.
- Rust assigns logical ticks and retains every authority-bearing value.
- Node returns only bounded semantic facts or validated graph deltas through
  the existing private bridge. It never coordinates or publishes.
- Only `rename_symbol` and uniform-value `add_parameter` are admitted.
- The SQLite product path and all existing agent behavior remain supported.
- Existing full key-free tests are not edited to accommodate the service.
- Feature-gated publishers, failpoints, and raw accessors stay unavailable in
  default builds; live code never enables their features.
- Every new behavior begins with a failing deterministic test and a recorded
  RED command before implementation.
- X is a stop gate: no live dynamic packet without exact deterministic
  two-order proof and a real `ScopeExpanded` event before candidate build.
- The operator-selected `current` or `caller-enriched` corpus variant is frozen
  before task-manifest generation and cannot change after any digest is
  registered.
- Recommended pilot task-role bounds are 25 turns, 240,000 ms, and USD 0.75 in
  both arms; the baseline-only integration role uses 40 turns, 420,000 ms, and
  USD 4.00; both arms use one 900,000 ms team deadline. Any approved change is
  frozen per role in the manifest before a live call.
- Append `decisions.md` only if implementation reality diverges from the
  approved design or reaches a stop condition.

## Planned file structure

### Shared Agent SDK extraction

- Create `packages/agent/src/hermeticSession.ts`.
- Modify `packages/agent/src/session.ts`, `src/index.ts`, and package exports.
- Create `packages/agent/tests/hermeticSession.test.ts`.
- Extend `packages/agent/tests/sessionSmoke.test.ts` and
  `tests/sessionError.test.ts` for compatibility and budget termination.

### Rust local service

- Create
  `crates/strata-kernel/src/bin/strata_kernel_service/{main,protocol,server,session,audit}.rs`.
- Add a default-build `strata-kernel-service` binary entry in
  `crates/strata-kernel/Cargo.toml`.
- Modify only the normal public kernel query surface necessary to return a
  bounded node projection; do not export raw durable/publication authority.
- Create `crates/strata-kernel/tests/{local_service,local_service_recovery,local_service_sealing}.rs`.
- Create `crates/strata-kernel/tests/ui/local_service_test_authority_is_sealed.{rs,stderr}`
  and extend `tests/api_sealing.rs`.

### Live-comparison package

- Create `packages/live-compare/{package.json,tsconfig.json}`.
- Create
  `packages/live-compare/src/{index,protocol,client,tools,agent,tasks,verify,baseline,artifacts,schedule,runner,cli}.ts`.
- Create matching tests under `packages/live-compare/tests/`.
- Create strict fixture/golden messages under
  `packages/live-compare/tests/fixtures/`.
- Modify root `package.json` for key-free build/test/dry-run scripts and one
  separately guarded live script.

### Evidence and documentation

- Create `docs/spikes/2026-07-16-phase-6-live-comparison-design-review.md`
  before design approval.
- Create `docs/spikes/2026-07-16-phase-6-live-comparison-harness.md` after the
  deterministic gate passes.
- Modify `docs/product-roadmap.md` only after deterministic completion.
- Append `decisions.md` only for an actual divergence.
- Live artifacts, if separately approved, go under a new ignored or explicitly
  operator-selected results directory and are never rewritten.

## Task 0: Complete independent design review and record approval

**Files:**

- Create: `docs/spikes/2026-07-16-phase-6-live-comparison-design-review.md`
- Create after explicit approval:
  `docs/spikes/2026-07-16-phase-6-live-comparison-implementation.md`
- Modify: `docs/superpowers/specs/2026-07-16-phase-6-live-comparison-design.md`
  only for verified review findings.
- Modify: `docs/superpowers/plans/2026-07-16-phase-6-live-comparison.md` only for
  verified review findings.

- [ ] Run the `delegating-to-codex` review with `gpt-5.5`, reasoning `xhigh`,
  read-only sandbox, and no web search. Give it a self-contained brief covering
  the revised design, authority boundary, six task packets, current versus
  caller-enriched corpus choice, role-specific bounds, symmetric 900-second
  team deadline, failure/stop rules, falsified alternatives, and governing
  repository documents. Ask specifically about authority escape, baseline
  fairness, accounting arithmetic, task equivalence, service minimality,
  claim strength, and implementation-plan coverage.
- [ ] Verify every pivotal empirical claim from the review against the indexed
  repository, code/tests, or governing documents before accepting it. Record
  accepted findings, rejected findings with evidence, model/effort/sandbox,
  reviewed commit, and command in the design-review spike.
- [ ] Commit any verified documentation-only corrections and the review spike.
  Do not change production code or `decisions.md`.
- [ ] Present the reviewed design and review attachment to the operator. Obtain
  an explicit choice of `current` or `caller-enriched` corpus plus approval of
  the experiment design and production-code implementation. Do not infer this
  from the request to revise or review the documents.
- [ ] Record the approval date/message reference and selected corpus variant in
  the implementation spike before Task 1.
- [ ] Confirm the implementation worktree still starts from
  `9aed98c1ceeaaf5d175aeea7993c4abb26b4ba88` plus only approved documentation
  commits and is clean.
- [ ] Re-run, without API credentials:

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm kernel:full-key-free:test
  ```

  Expected: PASS before the first production edit.

## Task 1: Extract a generic hermetic Agent SDK session and enforce query budgets

**Files:**

- Create: `packages/agent/src/hermeticSession.ts`
- Modify: `packages/agent/src/session.ts`
- Modify: `packages/agent/src/index.ts`
- Create: `packages/agent/tests/hermeticSession.test.ts`
- Modify: `packages/agent/tests/sessionSmoke.test.ts`
- Modify: `packages/agent/tests/sessionError.test.ts`

- [ ] **Step 1: Add failing tests for a storage-agnostic session.**

  Inject a fake SDK query and fake MCP server. Assert the generic runner accepts
  an explicit system prompt, server name, exact allowed-tool list, `tools: []`,
  banned built-ins, `maxTurns`, wall timeout, and `maxBudgetUsd` without a
  `StrataSessionContext` or SQLite handle. Assert init rejects every unexpected
  tool.

- [ ] **Step 2: Add failing compatibility tests.**

  Assert the existing `runLiveSession` wrapper produces its current T03 prompt,
  Strata server, tool allowlist, log events, transcript, terminal
  classification, and transaction observations byte-equivalently through the
  new generic runner.

- [ ] **Step 3: Add failing budget classification tests.**

  Feed `error_max_budget_usd` and assert a distinct `max_budget` terminal value,
  preserved reported cost/usage, and no retry classification. Assert the
  configured dollar limit is present in SDK options.

- [ ] **Step 4: Run RED.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/agent test -- hermeticSession sessionSmoke sessionError
  ```

  Expected: FAIL because the generic runner and budget field do not exist.

- [ ] **Step 5: Implement the smallest extraction.**

  Move only the SDK query/event loop and hermetic option construction. Keep
  SQLite/T03-specific result observation in the existing wrapper callbacks.
  Add `maxBudgetUsd` as an optional explicit parameter; do not change existing
  defaults for current callers.

- [ ] **Step 6: Run GREEN and package checks.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/agent test
  pnpm --filter @strata/agent build
  ```

  Expected: the focused Task-1 tests and package build PASS with no keyed
  process. The full package run may retain only the two documented stale replay
  fixture baseline failures in `labSeam.test.ts` and `replay.test.ts`; any new
  failure blocks Task 1. Do not regenerate or alter those unrelated fixtures in
  this task.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/agent
  git commit -m "refactor(agent): extract hermetic model session"
  ```

## Task 2: Freeze the local-service protocol before implementing the daemon

**Files:**

- Modify: `crates/strata-kernel/Cargo.toml`
- Create:
  `crates/strata-kernel/src/bin/strata_kernel_service/{main,protocol}.rs`
- Create: `crates/strata-kernel/tests/local_service.rs`
- Create: `packages/live-compare/package.json`
- Create: `packages/live-compare/tsconfig.json`
- Create: `packages/live-compare/src/{index,protocol}.ts`
- Create: `packages/live-compare/tests/protocol.test.ts`
- Create: `packages/live-compare/tests/fixtures/protocol-v1/*.json`

- [ ] **Step 1: Add shared failing protocol-golden tests.**

  Cover hello/ready, inspect, begin, add-intent, submit, advance, event read/ack,
  cancel, success/error envelopes, canonical unsigned decimal sequences,
  idempotency keys, request IDs, client identity, deadlines, and strict unknown
  field rejection. Rust and TypeScript must accept/reject the same golden
  messages.

- [ ] **Step 2: Add failing negative/bound tests.**

  Reject oversized frames, multiple frames per request, invalid UTF-8/JSON,
  duplicate IDs with different bodies, cross-client change-set access, client
  ticks, keys, clocks, reservations, claims, fences, deltas, redb paths, bridge
  configuration, and unknown intent types.

- [ ] **Step 3: Run RED.**

  ```bash
  pnpm --filter @strata/live-compare test -- protocol
  cargo test -p strata-kernel --test local_service protocol -- --nocapture
  ```

  Expected: FAIL because the package, binary, and protocol do not exist.

- [ ] **Step 4: Implement strict version-1 schemas only.**

  Use one bounded request and response frame per connection for the first
  service. Keep the transport local and serializable; do not add TCP, auth
  servers, discovery, streaming multiplexing, or remote features.

- [ ] **Step 5: Run GREEN.**

  ```bash
  pnpm --filter @strata/live-compare test -- protocol
  cargo test -p strata-kernel --test local_service protocol -- --nocapture
  cargo build -p strata-kernel --bin strata-kernel-service
  ```

- [ ] **Step 6: Commit.**

  ```bash
  git add crates/strata-kernel/Cargo.toml \
    crates/strata-kernel/src/bin/strata_kernel_service \
    crates/strata-kernel/tests/local_service.rs \
    packages/live-compare
  git commit -m "feat(kernel): freeze local coordination service protocol"
  ```

## Task 3: Implement the Rust-owned daemon lifecycle and seal authority

**Files:**

- Create:
  `crates/strata-kernel/src/bin/strata_kernel_service/{server,session,audit}.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
- Modify bounded read-only kernel query code only if required.
- Modify: `crates/strata-kernel/tests/local_service.rs`
- Create: `crates/strata-kernel/tests/local_service_recovery.rs`
- Create: `crates/strata-kernel/tests/local_service_sealing.rs`
- Create:
  `crates/strata-kernel/tests/ui/local_service_test_authority_is_sealed.{rs,stderr}`
- Modify: `crates/strata-kernel/tests/api_sealing.rs`

- [ ] **Step 1: Add failing black-box lifecycle tests.**

  Spawn one daemon on a temp socket/redb with an ingest-derived
  `examples/medium` snapshot. Use two logical clients to prove independent
  identities, actor ownership, daemon-assigned ticks, begin/add/submit/advance,
  queue/event/ack behavior, one final canonical graph, and idempotent duplicate
  requests. Assert responses contain no forbidden authority fields.

  Bind the socket below `/tmp/strata-lc/` with a hashed run token. Assert the
  daemon rejects a UTF-8 socket path longer than 96 bytes before bind and never
  derives a socket path from the deep repository/worktree path.

- [ ] **Step 2: Add failing disconnect/restart tests.**

  Disconnect after every mutating request boundary, resend the same idempotency
  key, restart the service on the same database, and prove exactly-once durable
  state, advanced service epoch, fenced in-memory authority, event continuity,
  and recovery to a complete old or complete new state.

- [ ] **Step 3: Add failing actor and containment tests.**

  Attempt cross-client draft mutation/cancel/event ack, fabricated stable IDs,
  malformed intent parameters, stale advance calls, and bridge failures. Assert
  no unauthorized publication and unchanged canonical/history tables.

- [ ] **Step 4: Add failing default-build sealing tests.**

  Compile-fail a consumer that tries to reach failpoints, fixture publishers,
  raw publication, claim/fence internals, bridge configuration through the
  service, or any test-only access. Assert the service binary builds with
  default features only.

- [ ] **Step 5: Run RED.**

  ```bash
  cargo test -p strata-kernel --test local_service -- --nocapture
  cargo test -p strata-kernel --test local_service_recovery -- --nocapture
  cargo test -p strata-kernel --test local_service_sealing -- --nocapture
  cargo test -p strata-kernel --test api_sealing -- --nocapture
  ```

- [ ] **Step 6: Implement the daemon.**

  The daemon owns the kernel, service epoch, monotonic tick counter, bridge
  config, claims, event access, and hash-chained audit stream. `advance` performs
  claim plus execution server-side and returns only safe state/diagnostics.
  `inspect_nodes` reads a bounded projection from the in-memory kernel snapshot;
  it never returns the redb handle or full canonical snapshot.

- [ ] **Step 7: Run GREEN plus existing Rust suites.**

  ```bash
  cargo test -p strata-kernel --test local_service -- --nocapture
  cargo test -p strata-kernel --test local_service_recovery -- --nocapture
  cargo test -p strata-kernel --test local_service_sealing -- --nocapture
  cargo test -p strata-kernel
  cargo test -p strata-kernel --features coordination-test-api
  cargo test -p strata-kernel --features redb-spike-api
  cargo test -p strata-kernel --test api_sealing -- --nocapture
  ```

- [ ] **Step 8: Commit.**

  ```bash
  git add crates/strata-kernel
  git commit -m "feat(kernel): host sealed local coordination authority"
  ```

## Task 4: Build the unprivileged Node client and coordination MCP tools

**Files:**

- Create: `packages/live-compare/src/{client,tools,agent}.ts`
- Modify: `packages/live-compare/src/index.ts`
- Create: `packages/live-compare/tests/{client,tools,agent}.test.ts`
- Create service-fixture scripts under
  `packages/live-compare/tests/fixtures/service/` only if black-box Rust process
  tests cannot cover a transport fault.

- [ ] **Step 1: Add failing client transport tests.**

  Assert bounded connect/request deadlines, request IDs, idempotency retry,
  disconnect handling, strict response parsing, client-token redaction, and no
  environment/config field that can reveal a redb path or bridge config.

- [ ] **Step 2: Add failing MCP surface tests.**

  Assert the exact tools and descriptions from the design. Assert tool schemas
  accept stable node IDs and typed intent fields but reject keys, scope, clocks,
  reservations, ticks, claims, fences, attempts, deltas, paths, arbitrary
  command execution, or unsupported operations.

- [ ] **Step 3: Add failing hermetic-agent tests.**

  Use the extracted fake SDK session to prove the coordination agent has
  `tools: []`, exactly one MCP server, no ambient servers/settings, no SQLite
  context, no filesystem/bash tools, the configured dollar/turn/wall bounds,
  complete cost logs, and task-specific prompt hashes.

- [ ] **Step 4: Run RED.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- client tools agent
  ```

- [ ] **Step 5: Implement the smallest client/tools/agent adapters.**

  Keep task assignment in the harness. The MCP tool descriptions explain the
  lifecycle but never decompose work. A fresh-decision response instructs the
  model to inspect bounded targets, cancel obsolete work, and submit a new typed
  change set; it does not expose the other task.

- [ ] **Step 6: Run GREEN and build.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- client tools agent
  pnpm --filter @strata/live-compare build
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/live-compare
  git commit -m "feat(live-compare): add sealed coordination agent client"
  ```

## Task 5: Freeze task packets, common verification, and dynamic qualification

> **Status 2026-07-16: BLOCKED at Step 7's X stop gate.** After correction of a
> physical-path ingest bug in the test harness, the exact X2 candidate validates
> and exports a delta, but the real daemon advances the already-analyzed X1 to
> `NeedsDecision`, not `ScopeExpanded`. Task 6 and later tasks must not begin
> until the operator selects and approves a semantic redesign, a fully
> requalified X task/corpus redesign, or a design amendment removing X and the
> dynamic-live-coordination claim. Partial Task-5 production/test work remains
> uncommitted; no live-model call occurred.

**Files:**

- Create: `packages/live-compare/src/{tasks,verify}.ts`
- Create: `packages/live-compare/tests/{tasks,verify,dynamicPreflight}.test.ts`
- Create task fixtures under `packages/live-compare/tests/fixtures/tasks/`.
- If and only if Task 0 selected `caller-enriched`, create an appended
  `examples/medium/src/users/greetCallers.ts` module and a matching test of a
  stable wrapper without reordering existing source structure or naming a task
  target from the non-canonical test.
- Modify root `package.json` only for a deterministic preflight command if
  useful.

- [ ] **Step 1: Add failing task-manifest tests.**

  Resolve D, M, R, S, X, and G targets from a fresh `examples/medium` ingest.
  Pin source digest, stable IDs, intent parameters, baseline locators,
  byte-identical task bodies, arm appendices, prompt hashes, and semantic
  predicates. Reject any structural operation or unresolved target.

  Read the approved `corpusVariant`. For `current`, assert `greet` has zero
  importers, callers, and test references and mark R/S/G as single-site. For
  `caller-enriched`, first add failing corpus tests for real imported `greet`
  calls, then add the final source module/test, regenerate all source/graph/task
  digests, assert existing logical IDs remain stable, and mark the registered
  callsites as required propagation targets. Reject a manifest whose variant or
  digest differs from Task 0's approval record.

- [ ] **Step 2: Add failing common-verifier tests.**

  Feed equivalent rendered Strata and filesystem baseline trees. Assert the
  same strict `src/**` TypeScript root-name set/options, registered per-packet
  Phase-6 Vitest fixture allowlist/digests, task predicates,
  duplicate-argument checks, residual-name checks, unexpected-change policy,
  output bounds, and digest calculation. Prove `tests/format.test.ts` and
  `tests/dateRange.test.ts` are not run as Phase-6 fixtures, are hashed as
  excluded historical inputs, and cannot be edited by the baseline. Prove
  harness-owned Phase-6 fixtures cannot be modified by either arm. Mutate each
  required fact and prove the verifier fails closed. G's allowed delta must
  explicitly accept only the exact
  `account: Account = undefined as never` declaration parameter and, in the
  caller-enriched variant only, one exact `undefined as never` argument at each
  registered callsite. A different default, duplicate insertion, or insertion
  outside those stable IDs must fail as unexpected scope.

  Add a generation-zero row for every registered packet configuration. The
  untouched corpus must pass the exact source-only TypeScript roots/options,
  that packet's behavioral fixture allowlist, excluded-fixture digest checks,
  and canonical-boundary classification before any mutation. Fixtures must
  express behavior invariant under the registered rename/add-parameter result;
  final-state AST/text predicates are hashed at generation zero but evaluated
  only after mutation. Prove one failing generation-zero configuration stops
  qualification rather than becoming an arm failure.

- [ ] **Step 3: Add the failing canonical-boundary preflight.**

  Enumerate every textual occurrence and resolved reference to each D/M/R/S/X/G
  target outside the publishable `src/**` graph. Freeze path, target,
  classification, content digest, and disposition in the manifest. Fail if an
  accepted task predicate requires rewriting non-canonical content, if an
  occurrence is unclassified, if an excluded historical fixture changes, or if
  either arm can use a worktree test edit to satisfy the common verifier. In the
  caller-enriched variant, its test must import only a stable wrapper from the
  appended source module and must not name a rename target.

  For the current corpus, assert the expected discovered dispositions:
  `tests/format.test.ts` is a frozen, excluded historical fixture for D2/G2 via
  `formatTimestamp` and M1/X1 via `logEvent`; `tests/dateRange.test.ts` is a
  frozen, excluded historical fixture with no Phase-6 task-target reference.
  Do not hard-code these as the search result: change either file or add a new
  non-canonical target occurrence and prove the preflight detects the mismatch.

- [ ] **Step 4: Add failing D/M/R/S/G deterministic tests through the service.**

  Use two scripted clients and both publication orders. Require one shared green
  final graph, correct operation-log actor/reasoning/generations, no lost
  update, and exact task predicates. M must prove same-module node scopes are
  concurrently ready and disjoint. S must prove compatible same-node ordering
  with a stable declaration ID. G must prove the standalone parameter intent
  publishes nothing while the ordered pair publishes once as one aggregate
  generation alongside the second client's disjoint rename.

- [ ] **Step 5: Add the failing X stop-gate tests.**

  On the exact ingest-derived `logEvent` and `eventLine` IDs, run X2-first and
  X1-first. X2-first must emit `ScopeExpanded` before X1 candidate construction;
  both orders must converge to `recordEvent` including the new default
  reference, preserve stable IDs, and pass the common verifier. No fixture
  publisher or feature-gated hook is allowed.

- [ ] **Step 6: Run RED.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- tasks verify dynamicPreflight
  ```

- [ ] **Step 7: Implement manifests and verifier; then evaluate X.**

  If X cannot pass without changing operation semantics or adding a
  task-specific hook, stop. Append the actual finding to `decisions.md`, update
  the design status, and request operator direction. Do not substitute a task.

- [ ] **Step 8: Run GREEN.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- tasks verify dynamicPreflight
  ```

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/live-compare package.json
  git commit -m "test(live-compare): qualify stable-id coordination tasks"
  ```

## Task 6: Implement the matched multi-worktree baseline

**Files:**

- Create: `packages/live-compare/src/baseline.ts`
- Create: `packages/live-compare/tests/baseline.test.ts`
- Add deterministic fake-session fixtures under
  `packages/live-compare/tests/fixtures/baseline/`.

- [ ] **Step 1: Add failing worktree/isolation tests.**

  From a temp Git repository mirroring `examples/medium`, assert two clean task
  worktrees and a clean integration worktree start at the same commit, task
  sessions launch concurrently, neither sees the other branch, and task outputs
  are mechanically captured as standardized commits without repair.

- [ ] **Step 2: Add failing integration-accounting tests.**

  Use a scripted integration agent to merge disjoint, conflicting, incomplete,
  and invalid branch results. Assert its full wall time, tokens, cost, tool
  events, repair edits, and failures are included in team totals. Assert it
  receives both registered tasks but no Strata artifacts or scorer internals.
  Assert every task role in both arms receives 25 turns, 240,000 ms, and USD
  0.75, while every baseline integration role receives the separately
  registered 40 turns, 420,000 ms, and USD 4.00. Any per-trial bound drift must
  invalidate the manifest.

- [ ] **Step 3: Add failing no-human and cleanup tests.**

  Reject dirty starting trees, interactive Git prompts, external/global Git
  configuration dependence, manual edits, missing event records, or cleanup
  that destroys evidence. Preserve failed trees and commits until artifact
  finalization.

- [ ] **Step 4: Run RED.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- baseline
  ```

- [ ] **Step 5: Implement using injected session runners.**

  Production live execution uses the same generic Agent SDK runner and model as
  Strata. Comparable task roles use identical bounds across arms; the
  baseline-only integration role uses its fixed pre-registered bounds. Tests
  inject deterministic task/integration sessions. The harness, not a model,
  creates worktrees and captures branch commits.

- [ ] **Step 6: Run GREEN.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- baseline
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/live-compare
  git commit -m "feat(live-compare): add matched worktree integration baseline"
  ```

## Task 7: Add schedule, artifacts, runner, and hard live guard

**Files:**

- Create: `packages/live-compare/src/{artifacts,schedule,runner,cli}.ts`
- Create:
  `packages/live-compare/tests/{artifacts,schedule,runner,cli}.test.ts`
- Modify: `packages/live-compare/src/index.ts`
- Modify: root `package.json`

- [ ] **Step 1: Add failing schedule tests.**

  Prove seeded D/M/R/S/X/G scenario permutations, exactly balanced pilot AB/BA
  arm order and alternation per scenario on extension, stable task-process
  mapping, concurrent within-arm release, and identical reconstruction from a
  manifest. Reject result-dependent schedule mutation.

- [ ] **Step 2: Add failing artifact-schema tests.**

  Cover manifest/tasks/team/sessions/service/kernel-events/canonical-audit/
  git-events/verification/summary schemas, wall plus monotonic timestamps,
  content hashes, redaction, append/finalize semantics, crash-safe partial
  records, and refusal to overwrite a finalized run. The verifier schema must
  bind exact TypeScript options/root names, Phase-6 fixture allowlists/digests,
  excluded historical-fixture digests, and every non-canonical-reference
  disposition.

- [ ] **Step 3: Add failing accounting/failure tests.**

  Exercise every taxonomy value, team makespan, summed model cost including
  integration, per-query budget terminal, team timeout, dynamic-observed flag,
  dispositive stop, one narrowly permitted zero-output provider rerun, and
  preservation of all failed attempts. Prove a baseline may use the full
  240-second task phase plus full 420-second integration phase and still retain
  240 seconds of the symmetric 900-second team deadline for capture and common
  verification. Reject the old 480-second team deadline as structurally
  insufficient.

- [ ] **Step 4: Add failing live-guard tests.**

  The live command must refuse to start unless a strict approval file matches
  the manifest's provider, model, task set, corpus variant, trial count, seed,
  task-role max turns/wall/budget, integration-role max turns/wall/budget,
  900-second team wall time, projected maximum spend, source commit, and
  verifier/task digests. It must also require an explicit `--execute-live` flag
  and a supported credential variable. Dry-run must never read credentials or
  call the SDK.

- [ ] **Step 5: Run RED.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm --filter @strata/live-compare test -- artifacts schedule runner cli
  ```

- [ ] **Step 6: Implement the runner and scripts.**

  Add:

  ```text
  pnpm live-compare:test
  pnpm live-compare:dry-run -- <manifest options>
  pnpm live-compare:run -- --approval <path> --execute-live
  ```

  `test` and `dry-run` must work with credentials removed. `run` validates the
  approval before importing/starting the live session adapter.

- [ ] **Step 7: Run GREEN and a key-free dry run.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm live-compare:test
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
    pnpm live-compare:dry-run -- \
      --model=claude-sonnet-4-6 \
      --trials=1 \
      --corpus-variant=<approved-current-or-caller-enriched> \
      --task-max-turns=25 \
      --task-wall-ms=240000 \
      --task-max-budget-usd=0.75 \
      --integration-max-turns=40 \
      --integration-wall-ms=420000 \
      --integration-max-budget-usd=4.00 \
      --team-wall-ms=900000 \
      --projected-max-usd=55.00 \
      --seed=<recorded-test-seed>
  ```

  Expected: PASS, print exactly 30 planned sessions and USD 42.00 summed query
  budgets, report USD 55.00 projected round maximum, write no live result, and
  make no keyed call.

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/live-compare package.json
  git commit -m "feat(live-compare): preregister guarded comparison harness"
  ```

## Task 8: Run the full deterministic gate, document evidence, and obtain review

**Files:**

- Create: `docs/spikes/2026-07-16-phase-6-live-comparison-harness.md`
- Modify: `docs/product-roadmap.md`
- Modify: `decisions.md` only for a real divergence.
- Modify implementation/tests only for findings from the single review round.

- [ ] **Step 1: Run scoped package gates without credentials.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm --filter @strata/agent test
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm --filter @strata/live-compare test
  pnpm --filter @strata/agent build
  pnpm --filter @strata/live-compare build
  cargo test -p strata-kernel --test local_service -- --nocapture
  cargo test -p strata-kernel --test local_service_recovery -- --nocapture
  cargo test -p strata-kernel --test local_service_sealing -- --nocapture
  ```

- [ ] **Step 2: Run repository and authority gates.**

  ```bash
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm -r test
  pnpm -r build
  cargo test -p strata-kernel
  cargo test -p strata-kernel --features coordination-test-api
  cargo test -p strata-kernel --features redb-spike-api
  cargo test -p strata-kernel --test api_sealing -- --nocapture
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm kernel:full-key-free:test
  env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm live-compare:test
  ```

- [ ] **Step 3: Capture evidence.**

  Record exact commits, toolchain versions, commands, pass counts, timings,
  service/protocol bounds, dynamic preflight events, default-build sealing,
  dry-run manifest/session count/spend projection, known stale replay-fixture
  baselines, and confirmation that no key/model spend was used.

- [ ] **Step 4: Obtain one independent repo-grounded review.**

  Use the `delegating-to-codex` skill with `gpt-5.5`, reasoning `xhigh`,
  read-only. Give it the approved design, hard boundaries, falsified
  alternatives, changed files, test evidence, and explicit questions about
  authority escape, baseline fairness, accounting, task equivalence, stopping
  rules, and claim strength. Verify every pivotal empirical claim against
  code/tests before accepting it. This is the single post-implementation review
  round and is distinct from Task 0's pre-implementation design review; do not
  recurse unless its fix touches a new high-blast surface.

- [ ] **Step 5: Address valid findings with RED/GREEN.**

  Each behavior fix begins with a failing deterministic regression test. Re-run
  the smallest gate and then all commands in Steps 1-2. Log a decision only if
  the approved design changed.

- [ ] **Step 6: Update roadmap/evidence and commit.**

  Mark only the deterministic harness/service gate complete. Leave the live
  comparison unchecked. Then:

  ```bash
  git add docs/product-roadmap.md \
    docs/spikes/2026-07-16-phase-6-live-comparison-harness.md decisions.md
  git commit -m "docs(phase6): record live comparison harness gate"
  ```

  Omit `decisions.md` from `git add` if unchanged.

- [ ] **Step 7: Prove clean handoff.**

  ```bash
  git status --short
  git log --oneline --decorate -12
  ```

  Expected: clean worktree with scoped commits. Report all evidence and request
  separate live budget approval.

## Task 9: Obtain exact live budget approval and execute the frozen pilot

**This task is not authorized by design or implementation approval.**

**Files:** Live artifact directory only. Production source and prompts are
frozen before this task.

- [ ] **Step 1: Present the final dry-run manifest.**

  It must state exact provider, model, approved corpus variant,
  D/M/R/S/qualified-X/G task hashes, one matched trial per scenario,
  seed/schedule, task-role `maxTurns=25`, `wallTimeMs=240000`, and
  `maxBudgetUsd=0.75`, integration-role `maxTurns=40`,
  `wallTimeMs=420000`, and `maxBudgetUsd=4.00`,
  `teamWallTimeMs=900000`, 30 maximum sessions, USD 42.00 summed query budgets,
  USD 55.00 projected round maximum, credential source, source commit,
  verifier digest, and stopping rules.

- [ ] **Step 2: Obtain an explicit operator approval matching every field.**

  A response that approves implementation, says “run it,” or supplies a key
  without matching the exact budget fields is insufficient. Regenerate and
  reapprove the manifest after any change.

- [ ] **Step 3: Run the single approved command once.**

  ```bash
  ANTHROPIC_API_KEY=... pnpm live-compare:run -- \
    --approval <exact-approved-manifest> \
    --execute-live
  ```

  Use `CLAUDE_CODE_OAUTH_TOKEN` instead only if that exact credential source was
  approved. Do not run both.

- [ ] **Step 4: Follow pre-registered stop/rerun rules.**

  Flush and finalize evidence after a dispositive failure or stop condition.
  Do not repair, edit prompts, change ordering, or rerun a billable attempt.
  Only the exact zero-output provider exception in the design permits one
  recorded rerun.

- [ ] **Step 5: Report without overclaiming.**

  Separate correctness, observed paired time/cost, integration overhead,
  dynamic-event qualification, failures, and censored trials. The N=1 pilot
  supports feasibility/falsification only. Any N=3 extension requires a new
  manifest and separate budget approval.
