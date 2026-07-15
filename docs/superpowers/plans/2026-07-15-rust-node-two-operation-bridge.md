# Rust–Node Two-Operation Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task. Because this work touches concurrency, canonical history, crash recovery, and code that protects coordination authority, use `test-driven-development` for every behavior change, `verification-before-completion` before any completion claim, and one `requesting-code-review` round after the full gate is green.

**Goal:** Prove that the Rust/redb kernel can analyze, validate, publish, and recover the real TypeScript `rename_symbol` and uniform-value `add_parameter` operations through a bounded one-shot Node bridge while Rust remains the sole coordination and canonical-storage authority.

**Architecture:** Add a private `@strata/kernel-bridge` package that accepts one strict schema-v1 JSON request, hydrates an immutable graph into in-memory SQLite, performs TypeScript semantic work, and returns semantic facts or a contained graph delta. Add a crate-private Rust bridge runner, semantic provider, and candidate executor. Rust validates all bindings, derives scope and policy, computes the candidate digest, runs the existing optimistic publication state machine, writes redb, and creates the one canonical operation record.

**Tech stack:** TypeScript 5.8, Zod 4, `better-sqlite3` through `@strata/store`, Vitest 3, Rust 1.89/edition 2024, serde/serde_json, redb 4.1, `wait-timeout`, trybuild, pnpm workspaces.

**Approved design:** `docs/superpowers/specs/2026-07-15-rust-node-two-operation-bridge-design.md`

## Non-negotiable constraints

- Node never receives a redb path or canonical store handle and never returns resource keys, reservations, clocks, policies, fingerprints, fencing data, or canonical operation rows.
- Rust remains authoritative for the immutable graph generation, graph digest, resource clocks, scope fingerprint, policies, candidate digest, containment, publication, fencing, aggregate operation history, and recovery.
- `rename_symbol` maps to `IdempotencyClass::RequiresDecision`; `add_parameter` maps to `IdempotencyClass::ReplaySafe` in normal-build Rust product code.
- One process handles exactly one request and emits exactly one stdout JSON object. Request, response, diagnostics, stderr, and deadline limits fail closed.
- All wire `u64` values are canonical unsigned decimal strings. `childIndex` remains a validated safe JSON integer.
- Candidate construction applies every ordered intent in one scratch transaction. Scratch operation rows are discarded.
- Non-call `add_parameter` arity-risk references widen read/validation scope; unresolved references fail analysis.
- Reuse after a later disjoint generation is allowed only through the existing dependency-clock, fresh-scope, containment, service-epoch, and claim checks. A response whose generation does not match its prepared request is never rebase-eligible.
- The G+1 callsite fixture adds a new module (or appends a final statement) so no existing structural child index or node ID shifts.
- Existing SQLite product behavior remains supported. Do not broaden the operation set or add per-callsite parameter values.
- If a design stop condition is reached, stop and append a dated entry to `decisions.md` before changing direction.

## Planned file structure

### TypeScript

- Modify `packages/ingest/src/kernelSnapshot.ts` and `packages/ingest/tests/kernelSnapshot.test.ts` for the canonical bridge snapshot generation and explicit legacy Rust-fixture adapter.
- Modify `packages/ingest/src/exportKernelSnapshotCli.ts` to preserve the current numeric `GraphSnapshot` fixture format through that adapter.
- Create `packages/kernel-bridge/{package.json,tsconfig.json}`.
- Create `packages/kernel-bridge/src/{index,protocol,snapshot,analyze,candidate,worker}.ts`.
- Create `packages/kernel-bridge/tests/{protocol,snapshot,analyze,candidate,worker}.test.ts`.
- Create `packages/kernel-bridge/tests/fixtures/{crash,extra-frame,oversized-stderr}.mjs` for process-failure tests.
- Create `packages/kernel-bridge/tests/fixtures/protocol-v1/{analyze-request,analyze-response,candidate-request,candidate-response,error-response}.json` as shared TypeScript/Rust golden messages.
- Modify root `package.json` only to add deterministic bridge build/test scripts.

### Rust

- Create `crates/strata-kernel/src/bridge/{mod,protocol,process,provider,executor}.rs`.
- Modify `crates/strata-kernel/Cargo.toml`, `src/lib.rs`, `src/kernel.rs`, and `src/coordination/{mod,authority,analyzer,publication}.rs`.
- Create `crates/strata-kernel/tests/{bridge_protocol,node_bridge,node_bridge_failures}.rs`.
- Create `crates/strata-kernel/tests/fixtures/examples-medium-add-parameter-g1.snapshot.json` from a temp copy of `examples/medium` containing a new final module that imports and calls `greet`.
- Create `crates/strata-kernel/tests/ui/production_execution_authority_is_sealed.{rs,stderr}` and update `tests/api_sealing.rs`.

### Evidence

- Modify `docs/product-roadmap.md` only after the deterministic gate passes.
- Append `decisions.md` only for an actual divergence or stop condition; do not manufacture an entry for faithful implementation.
- Create `docs/spikes/2026-07-15-rust-node-two-operation-bridge.md` with commands, timings, payload sizes, and pass/fail evidence.

## Task 1: Freeze the canonical snapshot and protocol vocabulary

**Files:**

- Modify: `packages/ingest/src/kernelSnapshot.ts`
- Modify: `packages/ingest/src/index.ts`
- Modify: `packages/ingest/src/exportKernelSnapshotCli.ts`
- Modify: `packages/ingest/tests/kernelSnapshot.test.ts`
- Create: `packages/kernel-bridge/package.json`
- Create: `packages/kernel-bridge/tsconfig.json`
- Create: `packages/kernel-bridge/src/protocol.ts`
- Create: `packages/kernel-bridge/src/index.ts`
- Create: `packages/kernel-bridge/tests/protocol.test.ts`
- Create: `packages/kernel-bridge/tests/fixtures/protocol-v1/analyze-request.json`
- Create: `packages/kernel-bridge/tests/fixtures/protocol-v1/analyze-response.json`
- Create: `packages/kernel-bridge/tests/fixtures/protocol-v1/candidate-request.json`
- Create: `packages/kernel-bridge/tests/fixtures/protocol-v1/candidate-response.json`
- Create: `packages/kernel-bridge/tests/fixtures/protocol-v1/error-response.json`

- [ ] **Step 1: Add failing ingest tests for canonical unsigned decimal generations.**

  Cover `"0"`, `"18446744073709551615"`, and rejection of negatives, signs, leading zeroes, fractions, exponent notation, whitespace, numbers, and values above `u64::MAX`. Assert `toKernelSnapshot(batch)` returns generation `"0"`.

- [ ] **Step 2: Add a failing compatibility test for the existing Rust fixture exporter.**

  Add an explicit `toRustGraphSnapshotFixture(snapshot)` adapter test that converts only `generation` back to a safe numeric value and leaves nodes/references byte-equivalent. This adapter exists solely for the current static Rust `GraphSnapshot` fixtures; it is not accepted by the bridge protocol.

- [ ] **Step 3: Run the ingest test and confirm RED.**

  Run: `pnpm --filter @strata/ingest test -- kernelSnapshot`

  Expected: FAIL because canonical-u64 parsing and the fixture adapter do not exist.

- [ ] **Step 4: Implement the canonical snapshot type in `@strata/ingest`.**

  Use a branded string, not a template-literal approximation:

  ```ts
  export type CanonicalU64 = string & {
    readonly __canonicalU64: unique symbol;
  };

  export function parseCanonicalU64(value: unknown): CanonicalU64;

  export interface KernelSnapshotV1 {
    schemaVersion: 1;
    generation: CanonicalU64;
    nodes: KernelNodeV1[];
    references: KernelReferenceV1[];
  }

  export function toKernelSnapshot(
    batch: IngestBatchResult,
    generation?: CanonicalU64
  ): KernelSnapshotV1;
  ```

  Implement parsing with `^(0|[1-9][0-9]*)$` plus `BigInt(value) <= 2n ** 64n - 1n`. Keep the existing canonical node/reference sorting.

- [ ] **Step 5: Preserve static Rust fixture generation explicitly.**

  Export `toRustGraphSnapshotFixture` from ingest and have `exportKernelSnapshotCli.ts` call it before writing JSON. Preserve the existing `<corpusRoot> --out <path>` invocation and add an optional `<corpusRoot> --generation <canonical-u64> --out <path>` form for reproducible later-generation fixtures. Reject any fixture generation above `Number.MAX_SAFE_INTEGER`; the default remains zero. Do not teach the bridge parser to accept numeric generations.

- [ ] **Step 6: Scaffold the private bridge package and strict Zod protocol.**

  `@strata/kernel-bridge` depends on `@strata/ingest`, `@strata/store`, `@strata/verify`, and `zod`. Add workspace references to ingest/store/verify. Define strict schemas and inferred types for:

  ```ts
  type BridgeKind = "analyzeIntent" | "buildValidateCandidate";
  type BridgeBinding = {
    serviceEpoch: CanonicalU64;
    graphGeneration: CanonicalU64;
    graphDigest: string;
  };
  type ValidationProfile =
    | { mode: "tscOnly"; sourceRoot: string; corpusRoot: string;
        behavioralFixtures: []; strictSrcOnlyTscScope: boolean }
    | { mode: "behavioral"; sourceRoot: string; corpusRoot: string;
        behavioralFixtures: string[]; strictSrcOnlyTscScope: boolean };
  ```

  Mirror the existing camelCase `IntentParameters` variants exactly: `renameSymbol { declarationId, newName }` and `addParameter { functionId, name, typeText, position, defaultValue }`. Make every object `.strict()` and every array bounded. Define structured success/error responses that echo request ID, kind, and binding; candidate responses also echo attempt ID and scope fingerprint.

- [ ] **Step 7: Add protocol rejection tests.**

  Test unknown fields/versions/kinds, numeric or noncanonical u64s, unsafe `childIndex`, duplicate IDs, dangling parents/references, snapshot/binding generation mismatch, invalid hashes, empty IDs, unsupported intents, and empty candidate intent lists. Serialize the five committed golden messages and assert byte-stable JSON so Rust consumes the same examples rather than a hand-copied schema.

- [ ] **Step 8: Run focused tests and build.**

  Run:

  ```bash
  pnpm --filter @strata/ingest test -- kernelSnapshot
  pnpm --filter @strata/kernel-bridge test -- protocol
  pnpm --filter @strata/kernel-bridge build
  ```

  Expected: PASS; bridge declarations import `KernelSnapshotV1` from ingest and contain no duplicate snapshot interface.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/ingest packages/kernel-bridge pnpm-lock.yaml
  git commit -m "feat(kernel-bridge): define canonical bridge protocol"
  ```

## Task 2: Hydrate scratch SQLite and compute deterministic deltas

**Files:**

- Create: `packages/kernel-bridge/src/snapshot.ts`
- Create: `packages/kernel-bridge/tests/snapshot.test.ts`
- Modify: `packages/kernel-bridge/src/index.ts`

- [ ] **Step 1: Write failing inverse-hydration tests on `examples/medium`.**

  Ingest the real corpus, hydrate with `openDb(":memory:")`, `insertNodes`, then `insertReferences`, export it, and compare canonical JSON to the input bridge snapshot. Repeat with reversed insertion order to prove query order is irrelevant.

- [ ] **Step 2: Write failing integrity and diff tests.**

  Reject duplicate node IDs, duplicate reference `fromNodeId` values, dangling parents/endpoints, illegal child indexes, and hydrate/export mismatches. Test node/reference deletion and upsert ordering, with deletes before upserts inside each resource class. Test that applying the delta to the input produces the exported result.

- [ ] **Step 3: Run the snapshot test and confirm RED.**

  Run: `pnpm --filter @strata/kernel-bridge test -- snapshot`

  Expected: FAIL because snapshot adapters do not exist.

- [ ] **Step 4: Implement the adapters.**

  Export package-private helpers:

  ```ts
  export interface KernelGraphDeltaV1 {
    schemaVersion: 1;
    baseGeneration: CanonicalU64;
    changes: KernelGraphChangeV1[];
  }

  export function hydrateSnapshot(snapshot: KernelSnapshotV1): Db;
  export function exportSnapshot(db: Db, generation: CanonicalU64): KernelSnapshotV1;
  export function diffSnapshots(before: KernelSnapshotV1, after: KernelSnapshotV1): KernelGraphDeltaV1;
  export function applyDelta(before: KernelSnapshotV1, delta: KernelGraphDeltaV1): KernelSnapshotV1;
  ```

  Key nodes by ID and references by `fromNodeId`. Reuse the ingest code-unit comparator. Export only graph rows; never inspect or return scratch operation rows.

- [ ] **Step 5: Prove byte-equivalent inverse hydration.**

  Run:

  ```bash
  pnpm --filter @strata/kernel-bridge test -- snapshot
  pnpm --filter @strata/kernel-bridge build
  ```

  Expected: PASS on the ingest-derived `examples/medium` snapshot.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/kernel-bridge
  git commit -m "feat(kernel-bridge): hydrate and diff graph snapshots"
  ```

## Task 3: Return TypeScript semantic facts for both operations

**Files:**

- Create: `packages/kernel-bridge/src/analyze.ts`
- Create: `packages/kernel-bridge/tests/analyze.test.ts`
- Modify: `packages/kernel-bridge/src/protocol.ts`
- Modify: `packages/kernel-bridge/src/index.ts`

- [ ] **Step 1: Write failing real-corpus rename analysis tests.**

  Select the `User` declaration in `examples/medium`. Assert facts contain its declaration ID, declaration-name identifier ID, every resolved incoming symbol-reference edge, each enclosing writable statement, and the module/program dependencies used by TypeScript validation. Assert arrays are canonical and duplicate-free.

- [ ] **Step 2: Write failing real-corpus add-parameter analysis tests.**

  Analyze `greet`. Assert direct callsites, non-call arity-risk uses, function-body read references, unresolved diagnostics, declaration-name ID, and validation dependencies are separately represented. Add a focused scratch fixture with a higher-order `greet` use and assert it widens read/validation facts rather than failing.

- [ ] **Step 3: Write the fail-closed unresolved-reference test.**

  Delete a referenced identifier row after hydration and assert analysis returns a bounded `analyze/unresolvedReference` error and no facts.

- [ ] **Step 4: Run tests and confirm RED.**

  Run: `pnpm --filter @strata/kernel-bridge test -- analyze`

  Expected: FAIL because `analyzeIntent` is not implemented.

- [ ] **Step 5: Implement semantic fact discovery using existing store helpers.**

  Use `resolveDeclarationNameIdentifier`, `getReferencesByTo`, `findNodeById`, `modulePathOf`, and `resolveCallsites`. Do not manufacture Rust resource-key strings. For rename, classify incoming edges and enclosing statements. For add-parameter, preserve the three `resolveCallsites` buckets; include arity-risk statements in read/validation facts and reject a non-empty unresolved bucket.

- [ ] **Step 6: Derive complete validation dependencies.**

  Build the TypeScript program from the rendered snapshot. Seed the validation slice with modules containing the declaration, resolved references/callsites, arity-risk uses, and function-body read dependencies; follow resolved graph imports needed to type-check those modules. Return the stable IDs of every node and reference in that closed slice so Rust clocks internal changes, not merely unchanged module-path nodes. External library state is fixed startup/toolchain context, not graph state. Keep paths inside the bridge/verify boundary; wire facts identify graph members only by IDs. Add a regression proving the `User` and `formatTimestamp` rename slices are disjoint, plus a mutation inside one returned slice that changes its Rust dependency clock.

- [ ] **Step 7: Canonicalize and bound facts.**

  Sort every ID/edge/diagnostic array, deduplicate exact facts, and normalize diagnostic messages. No response field may select idempotency or expansion policy.

- [ ] **Step 8: Run focused tests and build.**

  Run:

  ```bash
  pnpm --filter @strata/kernel-bridge test -- analyze
  pnpm --filter @strata/kernel-bridge build
  ```

  Expected: PASS; facts contain semantic memberships only.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/kernel-bridge
  git commit -m "feat(kernel-bridge): analyze rename and parameter intents"
  ```

## Task 4: Build and validate one atomic scratch candidate

**Files:**

- Create: `packages/kernel-bridge/src/candidate.ts`
- Create: `packages/kernel-bridge/tests/candidate.test.ts`
- Modify: `packages/kernel-bridge/src/protocol.ts`
- Modify: `packages/kernel-bridge/src/index.ts`

- [ ] **Step 1: Write failing `rename_symbol` candidate tests on `examples/medium`.**

  Hydrate generation G, begin one transaction with the change-set actor, invoke the existing `rename_symbol`, validate through `@strata/verify`, commit scratch, export, and diff. Apply the returned delta to the input and assert `User` and all resolved references render as `Account` while untouched stable IDs remain unchanged.

- [ ] **Step 2: Write failing uniform `add_parameter` candidate tests.**

  Add `excited: boolean` at position 1 to `greet` with `defaultValue: "false"`. Assert the existing mutation inserts the same `false` value at every direct callsite, does not add per-callsite overrides, and produces a TypeScript-clean delta. Assert ID churn is confined to touched statements and newly derived identifiers.

- [ ] **Step 3: Write failing composite and rollback tests.**

  Apply an ordered rename plus add-parameter change set in one scratch transaction. Assert one combined delta and no partial result. Follow with a valid first intent and invalid second intent and assert rollback returns the exact original snapshot.

- [ ] **Step 4: Write failing validation-profile tests.**

  Cover `tscOnly` via `commit` and behavioral mode via `commitWithBehavioralGate`. Use one explicitly scoped passing fixture; prove the bridge never implicitly runs all medium tests. Reject missing roots, path escape, module paths outside `sourceRoot`, and behavioral mode with an untrusted/empty fixture selection.

- [ ] **Step 5: Run candidate tests and confirm RED.**

  Run: `pnpm --filter @strata/kernel-bridge test -- candidate`

  Expected: FAIL because candidate construction does not exist.

- [ ] **Step 6: Implement `buildValidateCandidate`.**

  ```ts
  export type CandidateSuccess = {
    delta: KernelGraphDeltaV1;
    diagnostics: [];
  };

  export function buildValidateCandidate(
    request: BuildValidateCandidateRequest
  ): CandidateSuccess | BridgeErrorPayload;
  ```

  Begin exactly one store transaction. Apply `orderedIntents` sequentially with `rename_symbol` or `add_parameter`; pass `typeText` to the current store function's `type` argument and map `defaultValue: null` to `undefined`. Validate and finalize scratch before export. On every thrown mutation/validation/export error, roll back if the transaction remains open, normalize diagnostics, and return no delta.

- [ ] **Step 7: Enforce graph-history and identity boundaries.**

  Ignore SQLite operation rows when exporting. Compare before/after stable IDs and fail with `export/unexpectedIdChurn` if declaration/statement IDs change or identifiers churn outside touched statements. Return only a base-generation delta; do not calculate a candidate digest.

- [ ] **Step 8: Run focused tests and build.**

  Run:

  ```bash
  pnpm --filter @strata/kernel-bridge test -- candidate
  pnpm --filter @strata/kernel-bridge build
  ```

  Expected: PASS for rename, add-parameter, composite, rollback, tsc-only, and scoped behavioral cases.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/kernel-bridge
  git commit -m "feat(kernel-bridge): build validated scratch candidates"
  ```

## Task 5: Add the bounded one-shot Node worker

**Files:**

- Create: `packages/kernel-bridge/src/worker.ts`
- Create: `packages/kernel-bridge/tests/worker.test.ts`
- Create: `packages/kernel-bridge/tests/fixtures/crash.mjs`
- Create: `packages/kernel-bridge/tests/fixtures/extra-frame.mjs`
- Create: `packages/kernel-bridge/tests/fixtures/oversized-stderr.mjs`
- Modify: `packages/kernel-bridge/package.json`
- Modify: root `package.json`

- [ ] **Step 1: Write failing worker process tests.**

  Spawn the compiled entry point, write one request, close stdin, and assert one newline-terminated JSON response and no stdout logs. Cover analyze success, candidate success, malformed/truncated input, extra input objects, unknown fields, thrown handler errors, and bounded stderr.

- [ ] **Step 2: Write request/response/diagnostic limit tests.**

  Pin constants at `32 * 1024 * 1024`, `16 * 1024 * 1024`, and `64 * 1024`. Assert oversized input fails before `JSON.parse`; oversized success/error output becomes a bounded protocol error or nonzero exit; combined normalized diagnostics are truncated deterministically.

- [ ] **Step 3: Run worker tests and confirm RED.**

  Run: `pnpm --filter @strata/kernel-bridge test -- worker`

  Expected: FAIL because the executable does not exist.

- [ ] **Step 4: Implement one-shot stdin/stdout behavior.**

  Accumulate stdin through a size-counting reader, require EOF, parse exactly one JSON value, dispatch by `kind`, and write exactly one serialized response. Send bounded operational logs only to stderr. Set a nonzero exit code only when no valid bounded error response can be emitted.

- [ ] **Step 5: Add deterministic package/root scripts.**

  Add package scripts `build`, `test`, and `start:worker`. Add root scripts:

  ```json
  "kernel:bridge:build": "pnpm --filter @strata/kernel-bridge build && cargo build -p strata-kernel",
  "kernel:bridge:test": "pnpm --filter @strata/kernel-bridge build && pnpm --filter @strata/kernel-bridge test && cargo test -p strata-kernel --test node_bridge -- --ignored --nocapture"
  ```

  The Rust integration test is ignored during ordinary `cargo test` because it requires the prebuilt Node artifact; the explicit root gate builds it first.

- [ ] **Step 6: Run worker/package gates.**

  Run:

  ```bash
  pnpm --filter @strata/kernel-bridge test
  pnpm kernel:bridge:build
  ```

  Expected: PASS and `packages/kernel-bridge/dist/worker.js` exists.

- [ ] **Step 7: Commit.**

  ```bash
  git add package.json pnpm-lock.yaml packages/kernel-bridge
  git commit -m "feat(kernel-bridge): add bounded one-shot worker"
  ```

## Task 6: Parse protocol v1 and run Node safely from Rust

**Files:**

- Modify: `crates/strata-kernel/Cargo.toml`
- Create: `crates/strata-kernel/src/bridge/mod.rs`
- Create: `crates/strata-kernel/src/bridge/protocol.rs`
- Create: `crates/strata-kernel/src/bridge/process.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Create: `crates/strata-kernel/tests/bridge_protocol.rs`

- [ ] **Step 1: Write failing Rust schema tests from shared golden JSON.**

  Deserialize/serialize analyze, candidate, and error messages. Cover `u64::MAX`, noncanonical decimal strings, unknown fields/variants, numeric generations, unsafe child indexes, duplicate IDs, dangling references, invalid digest/fingerprint shape, empty identifiers, and binding mismatch.

- [ ] **Step 2: Write failing process-runner unit tests.**

  Use tiny test scripts to cover successful echo, spawn failure, nonzero exit, timeout/kill/reap, truncated JSON, extra stdout frames, stdout over 16 MiB, stderr over its configured bound, and a child that writes enough stdout before reading stdin to expose pipe deadlock.

- [ ] **Step 3: Run Rust protocol tests and confirm RED.**

  Run: `cargo test -p strata-kernel --test bridge_protocol`

  Expected: FAIL because the bridge module and dependency do not exist.

- [ ] **Step 4: Implement strict Rust protocol structs.**

  Add serde structs/enums with `#[serde(rename_all = "camelCase", deny_unknown_fields)]`. Implement a canonical decimal `WireU64` newtype with custom serde. Convert between `GraphSnapshot`'s internal `u64` and the wire string only at this boundary. Validate snapshot canonical order/integrity and response bindings before decoding success facts/delta.

- [ ] **Step 5: Implement `NodeBridgeConfig` and `NodeBridgeClient`.**

  Startup-owned config includes executable/argument list, deadline, max request bytes, max response bytes, max stderr bytes, diagnostics bytes, and validation profile. It is never serde-deserialized from an intent. Keep `NodeBridgeClient` and raw protocol types crate-private.

- [ ] **Step 6: Implement deadlock-safe bounded process I/O.**

  Spawn with piped stdin/stdout/stderr. Take stdout/stderr immediately and start separate bounded reader threads before writing the request or waiting. Serialize/check request size, write/close stdin, call `wait_timeout`, kill and reap on timeout, join readers, then reject exit/status/size/frame errors. Never wait for the child before draining both output pipes.

- [ ] **Step 7: Run focused/default Rust gates.**

  Run:

  ```bash
  cargo test -p strata-kernel --test bridge_protocol
  cargo test -p strata-kernel --lib
  cargo check -p strata-kernel --no-default-features
  ```

  Expected: PASS; bridge internals are inaccessible from the crate root.

- [ ] **Step 8: Commit.**

  ```bash
  git add crates/strata-kernel
  git commit -m "feat(kernel): add bounded Node bridge runner"
  ```

## Task 7: Convert semantic facts into Rust-owned scope and policy

**Files:**

- Create: `crates/strata-kernel/src/bridge/provider.rs`
- Modify: `crates/strata-kernel/src/bridge/mod.rs`
- Modify: `crates/strata-kernel/src/coordination/analyzer.rs`
- Modify: `crates/strata-kernel/src/coordination/authority.rs`
- Modify: `crates/strata-kernel/src/coordination/resources.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Create: `crates/strata-kernel/tests/node_bridge.rs`

- [ ] **Step 1: Write failing production-policy unit tests.**

  Add a normal-build function test proving `RenameSymbol -> RequiresDecision` and `AddParameter -> ReplaySafe`. Preserve deliberately inverted test fixtures only where they test generic policy mechanics, and label them as non-production policy.

- [ ] **Step 2: Write failing fact-to-scope tests.**

  Feed validated semantic facts plus the exact immutable `GraphGeneration`. Assert Rust resolves every ID, hashes exact node/reference records into current `ResourceVersion` values, and constructs node, edge, reverse-membership (`references-to:<target>`), child-membership (`children:<parent>`), namespace, and absence resources with crate-private helpers. Membership-resource versions hash their canonical current members, so a newly added callsite or statement child changes both dependency clocks and fresh scope. Assert reservations, arity-risk/validation dependencies, canonicalization, and fingerprinting. Reject any unknown/missing/mis-typed member. For rename, derive old/new namespace and absence keys in Rust from the target/container plus intent; Node never returns those strings.

- [ ] **Step 3: Write failing materialized-descendant containment tests.**

  Existing store commits re-derive `Identifier` children and their outgoing reference edges inside a touched statement. Extend Rust containment narrowly: an explicitly writable statement may authorize upsert/delete of its direct `Identifier` children and their `edge:<identifier-id>` records. Reject any other child kind, any grandchild, any identifier under a non-writable statement, and any unrelated endpoint. Test rename and add-parameter deltas plus malicious near-misses. This is a Rust rule derived from statement IDs in semantic facts, not a Node-supplied resource key.

- [ ] **Step 4: Write failing real-worker analysis tests.**

  In ignored `node_bridge.rs`, start a kernel configured with the built worker and analyze `User` rename and `greet` add-parameter on the committed medium snapshot. Assert the expected wide closure and that no Node response contains Rust authority fields.

- [ ] **Step 5: Run tests and confirm RED.**

  Run:

  ```bash
  cargo test -p strata-kernel --lib production_idempotency
  pnpm kernel:bridge:build
  cargo test -p strata-kernel --test node_bridge -- --ignored --nocapture
  ```

  Expected: FAIL because `NodeSemanticProvider` and production policy mapping do not exist.

- [ ] **Step 6: Implement the crate-private provider.**

  `NodeSemanticProvider` owns an `Arc<NodeBridgeClient>`, sends one `analyzeIntent` request per existing `SemanticProvider::analyze` call, checks complete binding, and converts facts into `IntentAnalysis`. Keep multi-intent aggregation in the existing `analyze_change_set` function.

- [ ] **Step 7: Pin coordination policy in source.**

  Add crate-private functions such as `idempotency_for_intent` and `expansion_policy_for_intent`; do not accept either value from Node. Use the existing bounded requeue policy for add-parameter dynamic expansion.

- [ ] **Step 8: Add production bootstrap without injectable authority.**

  Add `Kernel::create_with_node_bridge(path, snapshot, NodeBridgeConfig)` and matching `open_with_node_bridge`. Internally install the provider and later executor. Keep `Kernel::create/open` behavior unchanged: semantic submission/execution without configured production semantics fails without side effects.

- [ ] **Step 9: Run focused gates.**

  Run:

  ```bash
  cargo test -p strata-kernel --lib
  pnpm kernel:bridge:build
  cargo test -p strata-kernel --test node_bridge -- --ignored --nocapture
  ```

  Expected: PASS for both real analyses and product policy assertions.

- [ ] **Step 10: Commit.**

  ```bash
  git add crates/strata-kernel
  git commit -m "feat(kernel): derive coordination scope from Node facts"
  ```

## Task 8: Promote the publication engine without reopening authority injection

**Files:**

- Create: `crates/strata-kernel/src/bridge/executor.rs`
- Modify: `crates/strata-kernel/src/bridge/mod.rs`
- Modify: `crates/strata-kernel/src/coordination/authority.rs`
- Modify: `crates/strata-kernel/src/coordination/publication.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Modify: `crates/strata-kernel/tests/api_sealing.rs`
- Create: `crates/strata-kernel/tests/ui/production_execution_authority_is_sealed.rs`
- Create: `crates/strata-kernel/tests/ui/production_execution_authority_is_sealed.stderr`

- [ ] **Step 1: Extend compile-fail tests before moving any cfg gate.**

  The new UI case must fail to import `CandidateEnvelope`, `CandidateExecutor`, `NodeSemanticProvider`, `PreparedCandidate`, or raw bridge protocol types from `strata_kernel`; fail to construct a candidate envelope; and fail to pass a provider/builder/worker path/validation profile into public claim execution. Keep the existing raw-publication and semantic-authority cases.

- [ ] **Step 2: Add failing default-kernel behavior tests.**

  In a normal build, retain the current assertion that a default `Kernel::create/open` cannot submit semantically analyzed work and changes no graph/lifecycle state. Under `coordination-test-api`, configure only `TestSemanticProvider`, drive a claim to Executing, call the normal `execute_claimed(&claim, now_tick)`, and assert missing installed production execution without graph, operation, event, ticket, claim, fence, or clock mutation. This tests the new executor absence without inventing a constructible normal-build claim.

- [ ] **Step 3: Run sealing/default tests and confirm RED.**

  Run:

  ```bash
  cargo test -p strata-kernel --test api_sealing
  cargo test -p strata-kernel --no-default-features
  ```

  Expected: the new test is RED because the safe production entry point does not exist; existing compile-fail tests remain GREEN.

- [ ] **Step 4: Promote only the internal data needed by normal publication.**

  Remove the file-wide test cfg from `publication.rs`. Compile `PreparedCandidate`, `CandidateEnvelope`, digest validation, `ValidatedCandidate`, and the publication state machine in normal builds, but keep their fields/constructors crate-private. Compile `publish_lock` in every build. Promote the safe `PublishClaimOutcome` enum to the crate's normal public API because `execute_claimed` returns it; it contains only publication/lifecycle reports, not injectable authority.

- [ ] **Step 5: Add the sealed executor seam.**

  Define crate-private:

  ```rust
  pub(crate) trait CandidateExecutor: Send + Sync {
      fn build_candidate(&self, prepared: &PreparedCandidate)
          -> anyhow::Result<CandidateEnvelope>;
  }
  ```

  Store `Option<Arc<dyn CandidateExecutor>>` beside the semantic provider. `NodeCandidateExecutor` sends `buildValidateCandidate`, checks request/attempt/epoch/generation/digest/scope bindings, converts and reparses the delta, checks base generation, and calls the crate-private digest constructor. It does not apply/publish the delta itself.

- [ ] **Step 6: Add the sole normal-build execution entry point.**

  ```rust
  pub fn execute_claimed(
      &self,
      claim: &ClaimHandle,
      now_tick: u64,
  ) -> anyhow::Result<PublishClaimOutcome>;
  ```

  It obtains the installed executor and enters the same existing publication engine. It accepts no builder, envelope, semantic provider, worker config, scope, fence, store, or hook.

- [ ] **Step 7: Preserve feature-gated test adapters.**

  Keep public `CandidateBuilder`, `TestSemanticProvider`, external-envelope helpers, hooks, and failpoints under `coordination-test-api`/`redb-spike-api`. Adapt `CandidateBuilder` to the crate-private executor/source seam so existing tests retain meaning instead of duplicating the publication path.

- [ ] **Step 8: Regenerate and run compile-fail evidence.**

  Generate only the expected `.stderr` for the new UI case, inspect it to confirm failures are unresolved/private authority imports and forbidden method signatures—not unrelated syntax errors—then run:

  ```bash
  cargo test -p strata-kernel --test api_sealing
  cargo check -p strata-kernel --no-default-features
  cargo check -p strata-kernel --features coordination-test-api
  cargo test -p strata-kernel --test coordination_publication --features coordination-test-api
  cargo test -p strata-kernel --test coordination_optimistic --features coordination-test-api
  ```

  Expected: PASS in both default and feature builds; test builders remain available only with the feature.

- [ ] **Step 9: Commit.**

  ```bash
  git add crates/strata-kernel
  git commit -m "feat(kernel): seal production claim execution"
  ```

## Task 9: Publish and recover a real rename through the full bridge

**Files:**

- Modify: `crates/strata-kernel/tests/node_bridge.rs`
- Modify: `crates/strata-kernel/src/bridge/{provider,executor}.rs`
- Modify: `crates/strata-kernel/src/coordination/publication.rs` only if a test exposes a bridge-specific integration defect without changing state-machine meaning

- [ ] **Step 1: Write the failing full-path rename test.**

  Load the ingest-derived medium snapshot, configure the built worker in tsc-only mode with trusted roots, create a `User -> Account` change set, submit, claim, and call `execute_claimed`. Assert generation 0→1, one operation, `RenameSymbol` operation kind, actor/reasoning preservation, expected affected IDs, rendered references renamed, and no SQLite operation rows represented in redb history.

- [ ] **Step 2: Write the failing restart assertion.**

  Drop and reopen the kernel with the same startup bridge config. Assert recovered generation/digest/graph/operation equal the pre-drop state without invoking Node during recovery.

- [ ] **Step 3: Write failing optimistic concurrency tests.**

  Claim disjoint `User -> Account` and `formatTimestamp -> renderTimestamp` renames before either candidate publishes. First assert their worker-returned TypeScript dependency slices are actually disjoint. Use a barrier-controlled test hook only under the test feature to make both worker builds observe G. Publish in both orders and assert the second uses the existing rebase checks. Then change one member of the second claim's returned validation dependency slice and assert rebuild/requeue rather than reuse.

- [ ] **Step 4: Run the explicit bridge gate and confirm RED.**

  Run: `pnpm kernel:bridge:test`

  Expected: FAIL until the executor and exact wire/Rust delta mapping complete the real path.

- [ ] **Step 5: Implement only integration fixes required by the failing assertions.**

  Preserve `publish_claimed_inner` semantics: fresh analysis on release/rebase paths, dependency-clock equality, unchanged fresh scope, service epoch, response prepared-generation binding, digest validation, and containment all remain Rust checks. Do not add a special bridge bypass.

- [ ] **Step 6: Run bridge and publication regression gates.**

  Run:

  ```bash
  pnpm kernel:bridge:test
  cargo test -p strata-kernel --test node_bridge --features coordination-test-api -- --ignored --nocapture
  cargo test -p strata-kernel --test coordination_optimistic --features coordination-test-api
  cargo test -p strata-kernel --test coordination_recovery --features coordination-test-api
  ```

  Expected: PASS; real rename publishes and recovers, and old optimistic/recovery tests retain behavior.

- [ ] **Step 7: Commit.**

  ```bash
  git add crates/strata-kernel
  git commit -m "feat(kernel): publish real rename through Node bridge"
  ```

## Task 10: Prove add-parameter expansion and atomic composite execution

**Files:**

- Modify: `crates/strata-kernel/tests/node_bridge.rs`
- Create: `crates/strata-kernel/tests/fixtures/examples-medium-add-parameter-g1.snapshot.json`
- Modify: `packages/kernel-bridge/tests/candidate.test.ts`
- Modify: `crates/strata-kernel/src/bridge/{provider,executor}.rs` only for defects exposed by these tests

- [ ] **Step 1: Generate and validate the ingest-derived G+1 fixture.**

  In a temp copy of `examples/medium`, add the new final module `src/kernel-bridge-callsite.ts`:

  ```ts
  import { greet } from "./users/greet.ts";

  export const kernelBridgeGreeting = greet({
    id: "kernel-bridge",
    email: "bridge@example.test"
  });
  ```

  Build ingest, then export with `node packages/ingest/dist/exportKernelSnapshotCli.js <temp-medium> --generation 1 --out crates/strata-kernel/tests/fixtures/examples-medium-add-parameter-g1.snapshot.json`. Assert the G→G+1 diff contains exactly the new module subtree and its references: no existing node/reference changes or deletions and no shifted existing child IDs. If this assertion fails, rebuild the fixture rather than weakening it.

- [ ] **Step 2: Write the failing direct add-parameter full-path test.**

  Start from G+1, add `excited: boolean` at position 1 to `greet` with uniform value `false`, execute, and assert the declaration and `kernelBridgeGreeting` call both change, validation is clean, the delta is contained, and exactly one Rust operation/generation publishes.

- [ ] **Step 3: Write the failing claim-time expansion test.**

  Submit the add-parameter change set on G, then use the existing feature-gated graph-injection helper to publish the validated G+1 fixture delta before claim-time analysis. Assert the newly discovered direct callsite expands the scope and requeues before candidate construction (worker candidate invocation count remains zero). Claim again and assert the published candidate edits the new callsite exactly once.

- [ ] **Step 4: Write the failing composite test.**

  Submit one ordered change set containing a disjoint rename plus add-parameter. Assert the Node worker uses one scratch transaction, Rust publishes one generation and one operation whose kind is `CompositeChangeSet(2)`, and actor/reasoning/affected IDs cover the aggregate. Force the second mutation to fail and assert no partial canonical state.

- [ ] **Step 5: Run the explicit bridge gate and confirm RED.**

  Run: `pnpm kernel:bridge:test`

  Expected: FAIL until add-parameter scope expansion and composite mapping are complete.

- [ ] **Step 6: Make the smallest integration changes needed.**

  Keep add-parameter values uniform. Non-call arity-risk facts stay in read/validation scope and are judged by TypeScript validation; unresolved references remain fail closed. Do not expose production structural insertion—the G+1 publication uses the existing feature-only fixture mechanism.

- [ ] **Step 7: Run focused and regression gates.**

  Run:

  ```bash
  pnpm kernel:bridge:test
  cargo test -p strata-kernel --test node_bridge --features coordination-test-api -- --ignored --nocapture
  cargo test -p strata-kernel --test coordination_acceptance --features coordination-test-api
  pnpm --filter @strata/store test -- addParameter
  pnpm --filter @strata/verify test -- behavioralGate
  ```

  Expected: PASS; expansion occurs before candidate construction and composite publication is atomic.

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/kernel-bridge crates/strata-kernel
  git commit -m "feat(kernel): prove parameter expansion and composite execution"
  ```

## Task 11: Close failure, stale-binding, containment, and recovery cases

**Files:**

- Create: `crates/strata-kernel/tests/node_bridge_failures.rs`
- Modify: `crates/strata-kernel/tests/node_bridge.rs`
- Modify: `packages/kernel-bridge/tests/worker.test.ts`
- Modify: `crates/strata-kernel/src/bridge/{protocol,process,provider,executor}.rs` only for defects exposed by tests

- [ ] **Step 1: Build a no-side-effects assertion helper.**

  Capture graph generation/digest, latest operation/event, coordination table counts, scheduler revision, tickets, claims, fence state, and resource clocks before execution. After each failure, assert all canonical values are unchanged. Candidate-build failure specifically leaves the active claim unchanged for normal release/expiry policy.

- [ ] **Step 2: Add process/protocol failure cases.**

  Cover spawn failure, nonzero crash, timeout/kill, invalid/truncated JSON, duplicate/extra stdout objects, request/response/stderr/diagnostics limits, unknown fields/version, hydrate mismatch, and validation failure. Every case uses the helper.

- [ ] **Step 3: Add every binding failure case.**

  Use test-only response mutators around the process boundary to fabricate stale/mismatched request ID, kind, service epoch, prepared graph generation, graph digest, attempt ID, and scope fingerprint. Assert a fabricated response-generation mismatch is rejected immediately and never enters optimistic rebase.

- [ ] **Step 4: Add stale and containment cases.**

  Change dependency clocks during worker execution; change fresh inferred scope; expire/release the claim; and return a well-formed delta touching an out-of-scope medium node. Assert rebuild/requeue/decision only where the existing state machine specifies it, and otherwise no publication.

- [ ] **Step 5: Add digest/idempotency and crash-recovery cases.**

  Assert same attempt/same digest returns the original report, same attempt/different digest fails, and failpoints recover complete-old or complete-new graph plus exactly one canonical operation without Node consultation.

- [ ] **Step 6: Run failures and confirm at least one RED before fixes.**

  Run:

  ```bash
  pnpm kernel:bridge:build
  cargo test -p strata-kernel --test node_bridge_failures --features coordination-test-api -- --nocapture
  ```

  Expected: newly added cases expose any missing guard; if all are immediately green, inspect each case to prove it reaches the intended boundary rather than accepting a false positive.

- [ ] **Step 7: Fix boundary defects without changing lifecycle policy.**

  Keep errors stage/code stable and diagnostics bounded. The bridge must not invent release, cancellation, expiry, or retry transitions.

- [ ] **Step 8: Run the complete focused failure/recovery set.**

  Run:

  ```bash
  pnpm --filter @strata/kernel-bridge test
  cargo test -p strata-kernel --test bridge_protocol
  cargo test -p strata-kernel --test node_bridge_failures --features coordination-test-api -- --nocapture
  cargo test -p strata-kernel --test coordination_recovery --features coordination-test-api
  cargo test -p strata-kernel --test coordination_recovery_default
  ```

  Expected: PASS; every rejected request leaves canonical state unchanged.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/kernel-bridge crates/strata-kernel
  git commit -m "test(kernel): close Node bridge failure boundaries"
  ```

## Task 12: Run the full gate, record evidence, and review once

**Files:**

- Create: `docs/spikes/2026-07-15-rust-node-two-operation-bridge.md`
- Modify: `docs/product-roadmap.md`
- Modify: `decisions.md` only if an actual divergence occurred
- Modify implementation/tests only for defects found by this gate/review

- [ ] **Step 1: Run formatting and static checks.**

  ```bash
  pnpm -r build
  cargo fmt --all -- --check
  cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings
  cargo check -p strata-kernel --no-default-features
  cargo check -p strata-kernel --features coordination-test-api
  ```

  Expected: PASS.

- [ ] **Step 2: Run all TypeScript and Rust tests.**

  ```bash
  pnpm --filter @strata/kernel-bridge test
  pnpm --filter @strata/ingest test
  pnpm --filter @strata/store test
  pnpm --filter @strata/verify test
  pnpm -r test
  cargo test -p strata-kernel
  cargo test -p strata-kernel --features coordination-test-api
  cargo test -p strata-kernel --features redb-spike-api
  pnpm kernel:bridge:test
  ```

  Expected bridge/kernel result: PASS. At plan-writing baseline, the broad TypeScript run has one unrelated `@strata/verify` TS2454 failure at `packages/verify/tests/extractFunctionCommit.test.ts:228` and two stale agent replay fixtures. Recheck rather than assuming: if still present and unchanged, record them precisely as pre-existing and do not fold them into this gate; any new failure is in scope.

- [ ] **Step 3: Measure proof payloads without adding a benchmark claim.**

  Record analyze/candidate request and response bytes, normalized diagnostic maximum, worker startup+wall time, and the hard limits for the real medium cases. This is feasibility evidence only; there is no performance pass threshold and no live model spend.

- [ ] **Step 4: Verify every acceptance assertion from the design.**

  Cross-check protocol/adapters, rename, add-parameter G+1, composite, failures, idempotency, rebase, containment, recovery, and API sealing. Confirm the G+1 diff has no unrelated ID churn and the public API accepts no injectable authority.

- [ ] **Step 5: Request one independent repo-grounded code review.**

  Use `requesting-code-review` once. Give the reviewer the approved spec, this plan, the commit range, the authority split, stop conditions, known baseline failures, and the full gate output. Ask specifically for concurrency/rebase correctness, process deadlocks/limits, semantic-dependency completeness, containment, recovery, and normal-build sealing. Verify pivotal claims against code/tests before accepting them.

- [ ] **Step 6: Address accepted findings and rerun affected plus full gates.**

  Do not recurse into a second review round unless a review fix itself changes a high-blast-radius authority/concurrency/recovery surface. For such a fix, review that delta only.

- [ ] **Step 7: Write the spike report and roadmap update.**

  The report must state pass/fail for each criterion, commands, environment, fixture provenance, payload/time observations, known unrelated failures, any stop condition/divergence, and whether the later full key-free gate remains unapproved. Mark only the roadmap's “Two-operation proof” item complete; do not claim the live comparison or broader operation support.

- [ ] **Step 8: Commit evidence and final corrections.**

  ```bash
  git add docs/product-roadmap.md docs/spikes/2026-07-15-rust-node-two-operation-bridge.md decisions.md packages crates package.json pnpm-lock.yaml
  git commit -m "docs(kernel): record two-operation bridge proof"
  ```

- [ ] **Step 9: Confirm the handoff is clean and scoped.**

  Run:

  ```bash
  git status --short
  git log --oneline --decorate -12
  git diff --stat f82d91d..HEAD
  ```

  Expected: clean worktree; commits are task-scoped; diff contains only bridge, kernel integration, fixtures, tests, and evidence described above.

## Plan self-review checklist

- [x] Every design success criterion maps to at least one deterministic test task.
- [x] Every production behavior starts with a failing test and includes an exact command/expected result.
- [x] Snapshot wire generation is a canonical decimal string, while the old numeric Rust fixture format survives only through an explicit adapter.
- [x] Rust—not Node—owns scope, policy, digest, containment, fencing, redb, operation history, and recovery.
- [x] Process readers start before child wait, preventing full-pipe deadlock.
- [x] The promoted normal-build publication surface has new compile-fail coverage, and test injection stays feature-gated.
- [x] G+1 adds a new final module and proves zero unrelated node-ID churn.
- [x] Known unrelated baseline failures are rechecked and reported, not silently accepted or broadened into this work.
- [x] The final review is capped at one independent round unless its fix changes a high-risk surface.
