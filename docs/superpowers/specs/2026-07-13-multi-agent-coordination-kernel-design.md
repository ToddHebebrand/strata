# Multi-agent coordination kernel — design

**Status:** approved 2026-07-13

**Iteration:** 5 (recover the original multi-agent thesis)

**Scope:** a Rust, memory-native coordination kernel with redb durability and Node TypeScript validation workers. The first proof supports `rename_symbol` and `add_parameter`; it does not replace the existing SQLite product path.

## Problem

Strata began from the observation that files are too coarse a coordination unit for coding agents working in parallel. The implemented product proved a narrower result: structural operations are effective for bulk propagation, especially rename-class tasks. It did not test whether many agents can safely share one canonical codebase without Git branches, worktrees, or manual text merges.

The current store cannot serve as that proof. Transaction overlays are process-local, some structural operations mutate canonical SQLite rows before logical commit, transaction recovery cannot reconstruct those in-memory undo records, and commits have no durable semantic reservation, fencing, or ticket protocol. Pointing multiple agent processes at one database would therefore test SQLite contention and current implementation accidents, not the intended Strata paradigm.

The approved direction makes Strata an active code-coordination authority. Agents arrive with tasks chosen elsewhere. Strata coordinates their structural code activity: typed intents, inferred reservation scopes, tickets, events, fresh-state wakeups, validation, and atomic publication.

## Research hypothesis

A memory-native structural substrate can coordinate multiple coding agents at semantic-node granularity, automatically ordering overlapping work while allowing disjoint work to proceed, and can reach one integrated green codebase with less integration overhead than Git worktrees.

The claim is not that incompatible semantic intentions cease to exist. The claim is that branches, worktrees, text conflicts, and manual integration cease to be the coordination mechanism. When meaning has changed, Strata presents the waiting agent with the completed operation and fresh structural state so the agent can revise, cancel, or resubmit its intent.

## Goals

- Multiple independent clients share one canonical structural codebase through one Strata service.
- Agents never access canonical storage directly and never enumerate raw lock sets.
- Mutation tools submit typed semantic intents; Strata infers affected read, write, validation, and reservation scopes from the operation and graph.
- Agents reason and draft without holding code locks.
- Busy work returns a durable ticket; agents may continue disjoint work and receive durable events.
- A released ticket wakes the agent with relevant before/after state and a new graph generation. Blind automatic retry is opt-in only for operations Strata proves safe and idempotent.
- Tickets, intents, events, graph state, and fencing epochs survive service restart.
- Related operations that are only valid together can be validated and committed as one change set.
- The first proof is deterministic and key-free before any live multi-agent comparison.

## Non-goals

- Task decomposition, assignment, staffing, or agent selection. Strata coordinates code activity; it is not the team orchestrator.
- Direct multi-process access to the embedded database.
- Multi-host consensus, leader election, or production distributed deployment.
- CRDT or operational-transformation text editing.
- Git compatibility, FUSE, bidirectional file sync, or a human editing surface.
- Replacing the TypeScript Compiler API, Prettier, or the existing test runner with Rust implementations.
- Porting all twenty structural tools in the first proof.
- Treating WAL mode, busy timeouts, or another SQL database as semantic concurrency control.

## Chosen architecture

### Rust memory-native kernel

`strata-kernel` is a long-lived Rust service and the only canonical writer. Its hot state is memory-native:

- immutable graph generations for readers;
- node, parent/child, declaration, and reference indexes;
- typed intent analyzers;
- semantic reservation scopes;
- ticket queues, scheduling, and event subscriptions;
- lease epochs and fencing-token validation;
- candidate-delta construction and commit sequencing.

Readers hold an immutable generation while newer generations are published. An operation produces a graph delta rather than mutating the live generation in place. Publication swaps in a new generation only after durability succeeds.

The kernel is transport-independent. Deterministic proof tests call its Rust API directly. The live proof wraps it in a multi-client service; the existing agent tool host may act as a gateway, but it cannot bypass kernel authority.

### Redb durability

Redb is the intended durable engine because it is embedded, pure Rust, ACID, crash-safe, MVCC-based, and supports savepoints and rollback. Its single write-transaction path matches the design: Strata has one deliberately short commit sequencer, while graph reads, agent reasoning, scope analysis, and most validation work happen outside that critical section.

Logical redb tables are:

- `graph_metadata`: format version, current generation, service epoch, snapshot pointers;
- `nodes`: durable node records used by snapshots/recovery;
- `references_from` and `references_to`: durable reference indexes;
- `operations`: canonical ordered history and graph deltas;
- `snapshots`: periodic generation snapshots and replay boundaries;
- `change_sets` and `intents`: actor, reasoning, parameters, base generation, state, and idempotency key;
- `tickets`: durable queue state, inferred scope fingerprint, priority, and claim offer;
- `events`: ordered at-least-once delivery log;
- `lease_epochs`: monotonic service epoch and resource fencing counters;
- `idempotency_keys`: duplicate-submission protection.

Normal structural queries use in-memory indexes. Redb provides atomic durability, restart recovery, and audit history rather than serving as the hot query engine.

### Node TypeScript workers

The existing TypeScript packages remain authoritative for language semantics:

- `@strata/ingest` produces the initial graph loaded into the kernel;
- `@strata/render` and Prettier render bounded candidate modules;
- `@strata/verify` runs TypeScript diagnostics and behavioral tests;
- the agent package continues to expose the structural worldview.

Validation workers receive an immutable candidate generation or bounded rendered inputs plus a validation request. They return diagnostics and a result bound to the candidate generation, scope fingerprint, and service epoch. Workers never receive commit authority.

The proof uses a simple versioned request/response bridge between Rust and Node. Transport optimization is deferred until measurements show it matters.

## Typed intents and inferred scopes

Agents submit operations such as:

```text
RenameSymbol(declarationId, newName)
AddParameter(functionId, name, type, position, defaultValue)
EditNode(nodeId, edit)
MoveDeclaration(declarationId, targetModuleId)
```

Each operation owns an `IntentAnalyzer`. Given an immutable graph generation and typed parameters, the analyzer returns:

- `read_set`: nodes and edges whose values determine the result;
- `write_set`: nodes and edges the operation may change;
- `validation_set`: dependency and module scope whose versions make validation meaningful;
- `reservation_keys`: semantic resources used for scheduling;
- `scope_fingerprint`: deterministic digest of the inferred scope and relevant versions;
- `dynamic_expansion_policy`: how the operation reacts if its scope grows;
- `idempotency_class`: whether an unchanged intent may execute automatically after waiting.

Reservation keys are internal graph resources, not file paths. Initial key classes are `symbol:<id>`, `node:<id>`, `statement:<id>`, and `module-structure:<id>`. A wide operation may also retain its exact inferred node/edge sets internally. The agent neither supplies nor manipulates these keys.

Scope inference occurs at least twice: when a change set is submitted and immediately before candidate execution/publication. If the graph changed while an intent waited, the analyzer derives the scope again. Scope expansion into unavailable resources returns the change set to the queue before any canonical side effect.

## Change-set and ticket lifecycle

### 1. Draft

`begin_change_set` records actor, task reasoning, and base graph generation. Structural mutation tools add typed intents to a private workspace and preview them against that generation. Canonical state is untouched and no reservation is held while the agent reasons.

### 2. Submit and analyze

`submit_change_set` analyzes the complete intent set and unions its read, write, validation, and reservation scopes. This supports several related operations that must validate together.

### 3. Schedule

If the complete scope is schedulable, the change set receives queue priority and candidate construction begins. If any resource is unavailable, Strata persists a ticket and returns immediately. Acquisition is all-or-nothing; an intent never waits while holding part of its scope.

### 4. Ready event and claim

When a queued scope becomes runnable, Strata emits `IntentReady` with:

- the blocking operation that completed;
- relevant before/after structural state;
- the current graph generation;
- the newly inferred scope and fingerprint;
- a time-limited claim token.

The claim token briefly preserves queue priority without granting durable commit authority. If the client does not claim it, the offer expires and the ticket remains durable.

### 5. Fresh execution

On claim, Strata re-runs the typed intents against the current graph. It never applies stale text or a previously generated delta. A material semantic change produces `IntentNeedsDecision`; the agent may revise, cancel, or resubmit. Automatic continuation is allowed only when the analyzer's idempotency rule, relevant versions, and scope fingerprint prove it safe.

### 6. Validate candidate

The kernel builds an immutable candidate generation. A Node worker renders and validates it. During validation, the change set owns queue priority for its semantic scope so newer conflicting work cannot starve it, but it does not hold the redb write transaction or final fencing lease.

### 7. Fenced publication

Publication acquires the complete hard scope atomically with fresh fencing tokens. The kernel verifies:

- the service epoch and every fencing token are current;
- read, write, and validation-set versions still match;
- the scope fingerprint has not changed;
- the validation result belongs to the candidate being published.

One redb transaction then writes the operation records, graph delta, change-set/ticket transitions, event records, generation pointer, and fencing state. Only after that transaction commits does the kernel publish the new in-memory graph generation.

### 8. Release and notify

The kernel releases hard reservations, emits `IntentCommitted`, and reconsiders affected tickets. Disjoint work remains runnable throughout.

## Scheduling and fairness

- Reservation acquisition is all-or-nothing, which eliminates lock-order deadlocks.
- Each semantic resource has FIFO ordering.
- Ticket age raises scheduling priority.
- Newer work may pass an older ticket only when the complete scopes are disjoint.
- A wide rename may wait for already-active small work, but a stream of new edits cannot starve it.
- Repeated dynamic expansion beyond a bounded retry count produces `IntentNeedsDecision` instead of an infinite requeue loop.
- Idempotency keys make duplicate client submissions harmless.

## Events

Events are durable, sequenced, and delivered at least once. Clients acknowledge a cursor and deduplicate by stable event ID.

Initial event types are:

```text
IntentQueued
IntentReady
IntentNeedsDecision
IntentCommitted
IntentCancelled
IntentFailed
LeaseExpired
ScopeExpanded
```

Event payloads contain the current graph generation and only the bounded structural context necessary for the agent to understand what changed.

## Crash and recovery semantics

### Service crash

- Before the redb publication transaction commits, the canonical generation is unchanged.
- After redb commits but before memory publication, restart observes and replays the committed delta.
- Startup increments the durable service epoch, invalidating every pre-crash fencing token immediately.
- Durable queued tickets survive restart.
- Executing intents return to `queued` when their typed input is reconstructable; otherwise they become `IntentNeedsDecision`.
- Recovery loads the latest valid snapshot, replays later operations, rebuilds in-memory indexes, and verifies the resulting generation digest.

### Client and worker crash

- An abandoned draft holds no reservation and expires after the configured retention window.
- An unclaimed ready offer expires without deleting its ticket.
- A validation-worker crash discards only its candidate result; canonical state is unchanged.
- Delayed worker results and stale clients cannot publish because their service epoch or fencing tokens are invalid.

### Dynamic scope expansion

Scope analysis and candidate construction are side-effect free. If a later pass discovers new resources, the candidate is discarded, the expanded scope is persisted, and the change set re-enters the queue atomically.

## Stable identity boundary

The proof may use current node IDs for `rename_symbol` and `add_parameter`, whose top-level targets remain identifiable across the tested flows. Position-derived identity is not accepted as the long-term concurrency model for structural insertion, deletion, or move operations. Stable logical IDs that survive sibling reindexing are a gate before those operation classes join the concurrent surface.

## Alternatives considered

### Keep SQLite as canonical hot state

Rejected as the target architecture. A single coordinating service could make SQLite safe, but SQL rows would remain the hot graph representation and the design would continue to work around process-local overlays and record-level impedance. SQLite may remain as the current product backend and migration source while the proof is isolated.

### LMDB

Viable C alternative: memory-mapped, cheap readers, and one writer. Rejected for the first proof in favor of redb's pure-Rust API and safer integration surface.

### RocksDB

Viable for large sustained write workloads and snapshots, but its LSM compaction, tuning, binary weight, and operational surface are unnecessary for this proof.

### Custom append-only WAL

Offers maximum control, but would make Strata responsible for fsync ordering, checksums, torn-write recovery, format migration, compaction, backup, and corruption repair before the coordination hypothesis is tested. Revisit only if a redb spike falsifies a required property.

### Coordinator plus validation-worker actors

The selected architecture already isolates Node validation workers. Sharding the Rust coordinator or commit sequencer is deferred until one service demonstrates a real throughput bottleneck.

### Fully event-sourced kernel from day one

The operation log and durable events preserve an event-sourced evolution path. Rebuilding every projection solely from events in the first proof adds replay and schema burden without answering the concurrency question faster; snapshots and explicit durable tables are the chosen starting point.

## First proof

### Components

- New Rust `strata-kernel` crate/binary, isolated from the existing SQLite runtime.
- Redb durability and restart recovery.
- Node bridge reusing existing ingest, render, verify, and behavioral-test code.
- Direct Rust multi-client test harness with deterministic scheduling and failure injection.
- Live service wrapper only after key-free correctness passes.

### Supported operations

- `rename_symbol`: wide reference-closure inference.
- `add_parameter`: dynamic callsite scope that can expand while queued.

These reuse semantic analyses the current store already performs and exercise both wide and changing reservation scopes. Other tools remain on the existing path.

### Redb spike gate

Before building the full coordinator, the kernel must prove on `examples/medium` that it can:

1. Atomically persist a graph delta, operation, event, ticket transition, and fencing update.
2. Recover correctly from process termination at every publication boundary.
3. Rebuild the live graph from a snapshot plus later operations.
4. Serve concurrent immutable readers while the commit sequencer publishes a generation.
5. Reject stale fencing tokens and pre-restart service epochs.
6. Report publication-critical-section latency separately from validation and agent time.

Failure of any durability or recovery property stops the redb direction and records a new decision before another engine is selected.

## Deterministic acceptance tests

All tests are key-free and use `examples/medium` rather than toy code.

1. Two disjoint renames remain independently runnable and both commit.
2. Two renames of the same symbol are ordered; the second receives fresh state and `IntentNeedsDecision`.
3. A rename and an operation touching one of its references are inferred as overlapping.
4. `add_parameter` discovers a callsite added while it waited and requeues before mutation.
5. An older wide rename cannot be starved by newer small edits.
6. Stale fencing tokens and old service epochs cannot publish.
7. Queued tickets and unacknowledged events survive restart.
8. Failure injection at every redb boundary yields either the complete old generation or complete new generation, never partial state.
9. Snapshot-plus-operation replay produces byte-equivalent node/reference/index state and the same generation digest.
10. Two changes that type-check only together commit as one change set.
11. Duplicate event delivery is harmless through event IDs and acknowledged cursors.
12. No client or Node worker can mutate canonical storage outside the kernel.

Hard correctness gates are zero lost updates, zero dirty reads, zero partial commits, explicit ordering or agent decision for every overlap, and independent progress for every disjoint scope. Model calls are forbidden until all gates pass.

## Live paradigm experiment

After deterministic acceptance, run the same two-agent task set through:

- Strata shared coordination kernel;
- Git worktrees plus an integration agent.

Use the same model, orchestrator, corpus, tasks, and final `tsc`/test acceptance. Count integration-agent time and tokens in the worktree arm. Scenarios cover disjoint modules, the same module with disjoint nodes, a shared symbol, an overlapping same-node intent, dynamic scope expansion, and a grouped change that is only green together.

Primary metric: time from task dispatch to one shared green canonical codebase. Secondary metrics are total agent/tool tokens, queue wait, validation attempts, integration actions, manual interventions, and parallel speedup. Any silent overwrite, dirty read, partial commit, or rollback that changes another session's committed state falsifies the proof regardless of speed.

This is the specific, falsifiable product question that justifies a new benchmark. It does not reopen the settled single-agent bulk-propagation measurements.

## References

- `strata-design.md` — original parallel-agent motivation and architectural contract.
- `decisions.md` — newer decisions supersede the original SQLite/multi-client scope assumptions.
- [`DeusData/codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) — reference for a native static code-intelligence service with a RAM-first graph pipeline and durable embedded persistence; its read-mostly design is inspiration, not a concurrency implementation to copy.
- [`redb`](https://docs.rs/redb/latest/redb/) — intended embedded durability engine for the proof.
