# Rust–Node Two-Operation Bridge Design

**Status:** Operator-reviewed and approved for implementation planning

**Date:** 2026-07-15 (revised same day after repo-grounded review: idempotency
mapping pinned to product code, G+1 fixture ID-stability constraint,
arity-risk reference policy, `@strata/ingest` dependency, sealing-test
extension requirement)

**Scope:** Iteration 5 “Two-operation proof” only

## Purpose

Prove that the Rust/redb coordination kernel can execute the real TypeScript
`rename_symbol` and `add_parameter` operations without surrendering canonical
storage or scheduling authority.

The proof must preserve the approved Phase-6 split:

- Rust owns the immutable hot graph, resource clocks, scheduling, leases,
  fencing, candidate containment, canonical operation history, and redb
  publication.
- TypeScript owns TypeScript-specific semantic discovery, the existing mutation
  implementations, rendering, compiler validation, and optional behavioral
  validation.
- Node workers never open redb or mutate canonical storage.
- Clients submit typed intent parameters only. They never submit scope,
  reservation keys, resource versions, fencing data, worker configuration, or
  a semantic-provider implementation.

This design follows the approved coordination-kernel design and closes only the
open `docs/product-roadmap.md` “Two-operation proof” item. It does not claim the
later full key-free acceptance gate or authorize a live model comparison.

## Success criteria

The gate passes when deterministic, key-free tests on an ingest-derived
`examples/medium` graph demonstrate all of the following:

1. `rename_symbol` is analyzed, built, validated, contained, published, and
   recovered through the Rust kernel using the existing TypeScript mutation.
2. `add_parameter` is analyzed, built, validated, contained, published, and
   recovered through the same path using its current uniform callsite value
   semantics.
3. Claim-time analysis discovers a direct callsite that appeared after an
   `add_parameter` change set was submitted and requeues the change set before
   candidate construction.
4. A change set containing supported intents is applied in one TypeScript
   scratch transaction and publishes one Rust graph generation and one
   canonical aggregate operation.
5. Worker failure, malformed protocol data, validation failure, stale binding,
   and out-of-scope deltas publish no canonical state.
6. The existing SQLite product path and existing Rust coordination tests remain
   supported.

## Non-goals

- A long-lived Node worker, worker pool, cache, or multiplexed JSONL protocol.
- A network service, authentication protocol, public client SDK, or live agent
  run.
- Transport or process-startup performance optimization.
- Porting TypeScript semantics or either mutation to Rust.
- Making SQLite part of canonical coordination storage.
- Supporting operations other than `rename_symbol` and `add_parameter`.
- Per-callsite `add_parameter` values. The existing operation inserts one
  uniform `defaultValue ?? "undefined"` value at every resolved direct
  callsite.
- Structural insert, delete, or move as a production operation.
- Sandboxing a malicious semantic worker. The worker is kernel-owned trusted
  code, although it has no canonical-write authority.
- Completing the later full deterministic acceptance matrix or live
  Strata-versus-worktrees experiment.

## Selected approach

Use one Node child process per bridge request with a strict, versioned,
single-request/single-response JSON protocol.

This is deliberately less efficient than a resident worker. It has the right
failure model for the proof: every request begins without cached graph state,
cross-request contamination is impossible, and a crash invalidates only that
request. Process startup is measured separately but has no pass/fail threshold
in this gate.

Rejected alternatives:

- **Long-lived JSONL worker:** requires request multiplexing, cache invalidation,
  out-of-order response handling, restart semantics, and a stale-cache test
  matrix that do not answer the two-operation question.
- **Rust mutation port:** creates two semantic implementations and contradicts
  the decision that the existing TypeScript stack remains authoritative.
- **Shared canonical SQLite:** contradicts the Rust/redb sole-writer boundary.
  SQLite is allowed only as disposable worker-local scratch state.

## Components

### Private TypeScript bridge package

A new private workspace package, `@strata/kernel-bridge`, owns the Node process
entry point and bridge-only adapters. It depends on the existing store, ingest,
and verify packages; no agent tool or existing product package depends on it.
The canonical `KernelSnapshotV1` wire format lives in `@strata/ingest`
(`kernelSnapshot.ts`) and is imported, never duplicated.

Its responsibilities are limited to:

- strict protocol parsing and response encoding;
- hydrating an in-memory SQLite database from an immutable wire snapshot;
- TypeScript semantic discovery for the two supported intents;
- applying supported intents through `rename_symbol` and `add_parameter` in one
  scratch transaction;
- validating through the existing verify package;
- exporting and deterministically diffing scratch nodes and references; and
- returning bounded diagnostics or a graph-delta proposal.

The package emits exactly one JSON response on stdout. Logs go to stderr and
are size-bounded. It never receives or opens a redb path.

### Rust bridge runner

A crate-private bridge runner in `strata-kernel`:

- starts the configured, kernel-owned Node entry point;
- writes one bounded request and closes stdin;
- reads one bounded stdout response and bounded stderr;
- enforces a hard deadline and kills a timed-out child;
- rejects nonzero exit, extra stdout frames, malformed JSON, unknown fields,
  unknown versions, oversized messages, and mismatched response bindings; and
- converts successful wire values into internal Rust types.

The worker executable and validation profile are trusted service-startup
configuration. They are not fields in a client request and cannot vary per
intent.

### Production semantic adapter

`NodeSemanticProvider` implements the existing crate-private
`SemanticProvider`. `analyze_change_set` continues to invoke the provider once
per intent and continues to own multi-intent aggregation, canonical ordering,
strictest-policy selection, and scope fingerprinting.

The provider sends one `analyzeIntent` request. Node returns semantic membership
facts, not an `InferredScope`. Rust validates every returned ID against the
exact snapshot and converts the facts into `ResourceVersion` values,
reservation keys, validation resources, and semantic-index keys using the
kernel's existing resource-key rules.

The facts include the TypeScript program dependencies whose versions make the
analysis and validation reusable. This is load-bearing for optimistic rebase:
an omitted semantic or validation dependency can make an apparently disjoint
publication unsafe. Completeness of those TypeScript dependencies is part of
the trusted semantic-worker contract; Rust verifies their identities and
versions but does not independently rediscover them.

Coordination policy remains Rust-owned:

- `rename_symbol` uses `RequiresDecision` idempotency;
- `add_parameter` uses `ReplaySafe` idempotency; and
- dynamic expansion uses the existing bounded requeue policy.

Node cannot select or weaken those policies.

This proof promotes that idempotency mapping from test fixtures into kernel
product code. No `src/` code currently binds an intent kind to an idempotency
class: the graph-derived acceptance fixture uses the mapping above, while
`tests/coordination_scope.rs` deliberately uses the opposite one, so the
production mapping must be pinned in `strata-kernel` source rather than
inherited from whichever fixture an implementer reads first. Rationale:
`add_parameter` scope growth is already governed by the bounded requeue
policy, so replaying an unchanged-scope intent is safe; a `rename_symbol`
whose reference closure drifted while queued is a material semantic decision.
Fixtures may keep divergent mappings only where a test exercises policy
mechanics rather than production semantics.

### Production candidate executor

The publication path gains a crate-private candidate-executor seam available in
normal builds. The production executor sends `buildValidateCandidate` to Node.
Existing feature-gated test builders adapt to the same internal seam; arbitrary
builder injection remains unavailable in a default build.

The public execution operation accepts a current `ClaimHandle` and time only.
It uses the kernel-owned provider and executor. It does not accept a builder,
scope, worker path, validation profile, or storage handle.

The publication state machine, optimistic checks, resource clocks, containment,
digest validation, fencing, redb transaction, readiness recomputation, and
recovery semantics remain Rust-owned and unchanged in meaning.

## Trust and authority boundary

The Node worker is trusted for TypeScript semantics:

- which references are symbol references;
- which references are direct callsites or arity-risk uses;
- which graph proposal results from applying the existing mutations; and
- whether TypeScript and the configured behavioral fixtures accept the
  candidate.

Rust does not attempt to reimplement those TypeScript judgments. A compromised
worker could therefore lie about semantic completeness; malicious-worker
sandboxing is outside this proof.

The worker is not trusted with coordination authority. Rust alone:

- resolves returned memberships against the bound graph snapshot;
- constructs resource keys and versions;
- constructs reservation keys;
- selects expansion and idempotency policy;
- computes the scope fingerprint;
- checks response freshness;
- computes the candidate digest;
- checks delta containment and dependency clocks;
- issues and checks fencing tokens;
- constructs the canonical operation record; and
- publishes to redb.

The worker has no redb path and no canonical store handle, so even a buggy
worker cannot directly mutate canonical state.

## Protocol v1

The protocol is a discriminated JSON union. One process handles exactly one
request. All object schemas reject unknown fields.

Every request contains:

```text
protocolVersion: 1
requestId: non-empty opaque string
kind: "analyzeIntent" | "buildValidateCandidate"
binding:
  serviceEpoch: canonical unsigned decimal string
  graphGeneration: canonical unsigned decimal string
  graphDigest: lowercase hexadecimal digest
snapshot:
  schemaVersion: 1
  generation: canonical unsigned decimal string
  nodes: canonical NodeRecord array
  references: canonical ReferenceRecord array
```

Unsigned 64-bit wire values use canonical decimal strings so JavaScript number
precision cannot silently alter an epoch or generation. `childIndex` remains a
validated safe JSON integer because it is a bounded structural index in the
current schema.

The snapshot arrays must already be in canonical Rust order. Node verifies
uniqueness, referential integrity, schema version, and snapshot generation
equality before semantic work. `graphDigest` is the Rust generation digest and
is echoed as an opaque binding; Rust verifies it against the prepared immutable
generation before sending and again when accepting the response. Hydration
never rewrites IDs or payloads.

Every response echoes `protocolVersion`, `requestId`, `kind`, and the complete
binding. Rust rejects a mismatch before interpreting the payload.

### `analyzeIntent`

The request adds one kernel-owned `IntentRecord`. Supporting one intent rather
than a list preserves the current Rust aggregation boundary.

The success response returns an operation-specific semantic-facts union:

- `renameSymbol`: target declaration ID, declaration-name identifier ID,
  resolved symbol-reference edges, their enclosing writable statement IDs, and
  TypeScript validation dependencies;
- `addParameter`: target function ID, declaration-name identifier ID, resolved
  direct-call edges and enclosing writable statement IDs, non-call arity-risk
  references, unresolved-reference diagnostics, and references originating in
  the function body that form read dependencies, plus TypeScript validation
  dependencies.

Facts are canonically sorted and duplicate-free. Node does not return resource
versions, reservation keys, a scope fingerprint, expansion policy, idempotency
class, or fencing data.

Non-call arity-risk references do not fail analysis. They join the inferred
read and validation scope, and TypeScript validation of the candidate decides
whether the widened function type actually breaks them. This matches the
existing store mutation, which proceeds while surfacing arity-risk counts
rather than refusing.

Unresolved references are a fail-closed semantic-analysis error for this proof;
the kernel does not schedule from a knowingly incomplete scope.

### `buildValidateCandidate`

The request adds:

```text
attemptId: non-empty opaque string
scopeFingerprint: lowercase hexadecimal digest
changeSet:
  changeSetId
  actor
  reasoning
  orderedIntents: one or more supported IntentRecord values
validationProfile:
  mode: "tscOnly" | "behavioral"
  sourceRoot
  corpusRoot
  behavioralFixtures
  strictSrcOnlyTscScope
```

The validation profile is copied from trusted kernel-startup configuration,
not from a client request. Paths exist only inside the bridge/verify boundary.

Node hydrates fresh scratch SQLite, opens one store transaction with the
change-set actor, and applies every ordered intent. Any unsupported intent,
mutation error, overlapping edit error, or invalid argument fails the whole
request.

For `tscOnly`, Node uses the existing in-process validate/commit path. For
`behavioral`, it uses the existing task-scoped behavioral gate. Validation must
finish before scratch commit and graph export.

On success Node exports only nodes and references, compares them with the input
snapshot, and returns a canonical delta. It does not return scratch transaction
or operation rows, and it does not compute the authoritative candidate digest.

The response binding additionally echoes `attemptId` and `scopeFingerprint`.
Rust checks both, constructs the candidate envelope and digest itself, and then
runs the existing publication checks.

The response is valid only for the prepared request binding. If another
generation publishes while the worker runs, Rust may reuse the validated delta
only through the existing optimistic rebase path: every bound dependency clock
must still match, fresh semantic analysis must produce an unchanged scope,
delta containment must pass against the current graph, and the service epoch
must be unchanged. Otherwise the response cannot publish and the current
requeue/retry policy applies. A mismatched or fabricated response generation is
never rebase-eligible.

### Error response

Errors are structured and bounded:

```text
stage: "protocol" | "hydrate" | "analyze" | "mutate" | "validate" | "export"
code: stable machine-readable code
message: bounded human-readable summary
diagnostics: bounded normalized diagnostic list
```

Stack traces and arbitrary subprocess output are not part of stdout protocol.

Initial hard limits are part of v1 and fail closed: 32 MiB request, 16 MiB
response, 64 KiB combined normalized diagnostics, and one response object. The
implementation plan may lower a limit after measuring `examples/medium`, but
may not silently make a field unbounded.

## Scratch hydration and deterministic diff

Hydration uses `openDb(":memory:")`, bulk node insertion, then bulk reference
insertion. It does not run ingest and does not infer new IDs. The hydrated
nodes/references must export byte-equivalent canonical JSON to the input
snapshot before an intent is processed; failure stops the request.

After a successful scratch commit, the bridge exports all nodes and references
in canonical order and computes changes by stable identity:

- nodes keyed by node ID;
- references keyed by `fromNodeId`, matching the current one-outgoing-edge
  schema;
- deletes before upserts within each resource class; and
- a final total canonical ordering defined and shared by Rust tests.

Rust reparses the proposed delta, requires schema version 1 and the bound base
generation, recomputes its digest, and applies the delta to an immutable
generation before publication.

Scratch SQLite operation rows are intentionally discarded. The Rust
publication path already derives `affected_node_ids` from the accepted delta
and constructs one canonical `OperationRecord` from the change set's actor,
reasoning, and intent kind (or `CompositeChangeSet(n)`). Preserving scratch rows
would create two competing histories.

## Stable identity boundary

The bridge does not introduce a new ID algorithm.

- Existing declaration and statement IDs touched by either operation must
  remain stable.
- `rename_symbol` changes existing identifier payloads without changing their
  IDs.
- `add_parameter` may create new identifier nodes and may exercise the existing,
  documented per-statement identifier re-derivation behavior.
- ID churn outside statements actually changed by the operation is a stop
  condition.
- Structural insert/delete/move support remains deferred.

## Validation context

Module payloads continue to carry the current render/verify paths. Paths are
never exposed as an agent unit of work.

The bridge profile supplies the exact source root, corpus root, compiler scope,
and optional behavioral fixture list needed by the existing verify package.
Missing configuration, a path escaping the trusted corpus root, or a mismatch
between rendered module paths and `sourceRoot` fails closed.

The two-operation gate uses `examples/medium` and always requires TypeScript
validation. Behavioral mode is proven separately with an explicitly scoped
fixture; the bridge must not run the whole medium suite accidentally because
that corpus intentionally contains unrelated fail-before fixtures.

## Lifecycle and failure semantics

Analysis and candidate construction run outside the kernel's global publication
mutexes, matching the current optimistic publication design.

Any of the following produces no canonical graph, operation, event, ticket, or
fence mutation:

- spawn failure or nonzero worker exit;
- timeout or forced termination;
- truncated, oversized, malformed, duplicate, or extra stdout response;
- protocol/schema/binding mismatch;
- hydrate roundtrip mismatch;
- semantic-analysis failure or unresolved reference;
- mutation or validation failure;
- stale service epoch, graph digest, scope fingerprint, attempt ID, dependency
  clock, or claim;
- a response generation that does not match its prepared request, or a later
  graph generation that fails the explicit optimistic-rebase checks;
- candidate digest mismatch; or
- delta-containment failure.

A failed analysis leaves submission/claim handling in its current error path. A
failed candidate build leaves the active claim unchanged until the existing
explicit release/expiry policy acts; the bridge must not invent a lifecycle
transition.

Worker crash recovery is therefore process-local: discard the response and
rerun from a fresh immutable snapshot when the kernel's existing lifecycle
permits. There is no worker-local durable state to recover.

## Production API sealing

Normal builds gain only the production behavior needed by the proof:

- the internal publication module and candidate envelope compile outside the
  test feature;
- a crate-private `CandidateExecutor` is installed by the kernel runtime;
- `NodeSemanticProvider` remains crate-private;
- the public claim-execution call uses the installed provider/executor and
  accepts no injectable authority; and
- test-only semantic providers, builders, envelopes, hooks, and failpoints stay
  feature-gated through adapters.

The service/runtime bootstrap may configure the trusted worker executable,
deadline, size limits, and validation profile. None of those values are part of
the agent/client coordination protocol.

The existing default kernel without installed production semantics must keep
failing semantic execution without side effects; this preserves the current API
sealing regression guard.

Moving the publication module and candidate envelope out of the test feature is
the highest-risk mechanical refactor in this proof: it re-opens exactly the
surface the 2026-07-14 authority correction sealed. Today the publication
module, `CandidateEnvelope`, and builder injection compile only under
`coordination-test-api`, and the executor seam described here is new (the
current seam is the feature-gated `CandidateBuilder` trait). The trybuild
compile-fail sealing tests must be extended to cover the newly compiled
normal-build surface — no injectable provider, builder, or envelope
constructor — not merely kept passing against the old one.

## Deterministic acceptance

All bridge tests are key-free and use the real ingest-derived
`examples/medium` graph.

### Protocol and adapters

1. Schema-v1 requests and responses round-trip in Rust and TypeScript.
2. Unknown versions, kinds, fields, unsafe integers, duplicate IDs, dangling
   references, oversized messages, and binding mismatches fail closed.
3. Snapshot → scratch SQLite → snapshot is byte-equivalent after canonical
   ordering.
4. Diff ordering is deterministic regardless of SQLite query or insertion
   order, and Rust applying the delta produces the worker's exported snapshot.
5. Client-facing begin/add/submit/claim/execute inputs contain no provider,
   worker, resource, reservation, scope, fence, or storage fields.

### `rename_symbol`

1. TypeScript analysis returns the real wide reference closure for the chosen
   `examples/medium` declaration.
2. Rust derives the expected scope and fingerprint without accepting Node-made
   resource keys.
3. The candidate uses the existing TypeScript rename, is TypeScript-clean,
   passes containment, publishes one generation/operation, and renders the
   expected rename.
4. Two disjoint rename claims can build concurrently and publish through the
   existing dependency-clock/scope-checked optimistic rebase path; a changed
   validation dependency forces rebuild/requeue instead.

### `add_parameter`

1. TypeScript analysis distinguishes resolved direct callsites, non-call
   arity-risk references, and unresolved references on `examples/medium`.
2. Candidate construction uses the existing uniform-value mutation and is
   TypeScript-clean; no per-callsite override is added.
3. A queued change set is analyzed at generation G. The deterministic harness
   then publishes an ingest-derived G+1 fixture containing one additional real
   direct callsite. Claim-time bridge analysis observes the callsite and the
   kernel requeues before candidate construction. The fixture publication uses
   existing test-only graph injection and does not create a production
   structural-insert API. Because node IDs hash the structural child path, the
   added callsite must not shift any existing sibling's child index: the
   fixture appends the new statement at the end of an existing module or adds
   a new module, so the G→G+1 delta is exactly the new callsite subtree and
   its reference. A fixture whose diff churns unrelated node IDs is invalid
   and is rebuilt, not accommodated.
4. On the next claim, the candidate delta contains the new callsite edit and
   publishes once.

### Composite and failures

1. A supported multi-intent change set applies all intents in one scratch
   transaction and publishes one generation with one
   `CompositeChangeSet(n)` operation.
2. Mutation or validation failure returns diagnostics and publishes nothing.
3. Worker crash, timeout, invalid JSON, mismatched response generation, and
   stale epoch/digest/scope/attempt each publish nothing. A later disjoint graph
   generation publishes only through the explicit optimistic-rebase checks.
4. A well-formed malicious or buggy delta outside inferred scope is rejected by
   Rust containment.
5. Same-attempt/same-digest replay follows the current idempotent replay rule;
   same-attempt/different-digest is rejected.
6. Restart recovery reproduces the published graph and canonical operation
   without consulting the Node worker.
7. Existing default-feature Rust tests, coordination feature tests, redb
   recovery tests, SQLite store tests, and verify tests retain their established
   behavior. Known unrelated baseline failures are reported, not folded into
   this gate.

## Stop conditions

Stop implementation and append a decision before changing direction if:

- inverse hydration cannot round-trip `examples/medium` deterministically;
- TypeScript validation requires filesystem state that cannot be supplied by
  the explicit trusted validation profile;
- production correctness would require Node to choose resource keys,
  reservation keys, scope fingerprints, fencing data, or canonical storage;
- the current `add_parameter` operation requires per-callsite custom values for
  the selected proof fixture;
- either mutation causes declaration or statement ID churn, or causes
  identifier churn outside touched statements;
- correct multi-intent execution requires silently materializing between
  intents and thereby violates one-transaction atomicity;
- a worker failure can change canonical graph or lifecycle state;
- protocol payloads exceed the bounded one-shot design on
  `examples/medium`; or
- making the publication path available in normal builds would expose test
  provider/builder injection to clients.

Crossing one of these boundaries requires a new design decision, not a local
workaround, worker pooling, a Rust semantic port, or a broader operation scope.

## Evidence and review

This design is grounded in the current `SemanticProvider`,
`analyze_change_set`, publication containment/fencing path, Rust graph model,
`toKernelSnapshot`, SQLite hydration primitives, `rename_symbol`,
`add_parameter`, and verify commit gates.

An independent read-only, repo-grounded Codex CLI review using `gpt-5.5` with
`xhigh` reasoning compared the one-shot, long-lived-worker, and Rust-port/shared-
SQLite approaches. It recommended the one-shot architecture and identified the
inverse hydration/diff work, operation-log authority, compiler context,
deterministic ordering, current uniform `add_parameter` policy, and response
binding as the load-bearing risks. Those claims were checked against the
current code before inclusion here.
