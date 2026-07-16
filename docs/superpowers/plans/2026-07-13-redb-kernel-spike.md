# Redb Kernel Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a Rust memory-native graph backed by redb can atomically publish graph deltas with operation/event/ticket/fencing state, recover from process crashes, serve immutable concurrent readers, and load a real `examples/medium` graph exported by the existing TypeScript ingest pipeline.

**Architecture:** Add an isolated `strata-kernel` Rust workspace member. The kernel holds immutable graph generations in memory and uses redb only for snapshots, ordered deltas, durable events/tickets, service epochs, and fencing counters. Existing TypeScript ingest exports a versioned JSON snapshot; the current SQLite runtime and all twenty production tools remain unchanged.

**Tech Stack:** Rust 1.89+, redb 4.1.0, serde/serde_json, sha2, anyhow, tempfile; existing TypeScript 5.8, pnpm 10.26.2, and Vitest 3.2.

> **Pre-execution review applied.** This plan was reviewed before execution; the amendments and their rationale are logged in `decisions.md` (2026-07-14 entry). Two things that plan review usually flags here were checked against the real code and are **correct as designed** — do not "fix" them: (a) one outgoing reference per node (`packages/store/src/schema.ts:44` makes `from_node_id` a PRIMARY KEY; verified 614/614 distinct on `examples/medium`), and (b) `redb 4.1.0` with MSRV 1.89.

## Global Constraints

- This plan is the redb stop gate only. Do not build the scheduler, remote service, live agent integration, or port mutation tools.
- Keep the existing SQLite product path byte-for-byte functional; no current store schema or transaction behavior changes.
- Use `examples/medium` for the cross-language acceptance path. Small Rust fixtures are allowed only for focused unit tests.
- No model/API calls and no keyed benchmark runs.
- Redb commit must complete before the new in-memory generation is published.
- Every persisted payload carries `schemaVersion: 1`; Rust uses serde `camelCase` field names matching TypeScript. **This includes struct-variant fields inside enums** — container-level `rename_all` renames variants only, so `GraphChange` needs `rename_all_fields = "camelCase"`.
- **Durability is pinned to `Durability::Immediate` and asserted by test.** Never set `Durability::None` or `Eventual` to improve a measured number.
- **The digest is persisted at publish time**, and recovery compares its replayed digest against the stored value. A digest that is only ever recomputed through the same `apply` path it is meant to check proves nothing.
- The operation log plus snapshots reconstruct canonical state.
- Opening the authoritative store increments a durable service epoch. Tokens from a previous epoch can never publish. **Read-only inspection must use `Kernel::open_read_only`, which never bumps the epoch and never opens a write transaction.**
- Publication accepts one complete `Publication` value and persists its delta, operations, events, ticket transitions, generation pointer, digest, and consumed fences in one redb write transaction. **The record vectors are composite so that `schemaVersion: 1` matches the approved design; this spike always publishes exactly one element per vector and builds no scheduler logic.** `operations` and `events` must be non-empty; `tickets` may legitimately be empty.
- The spike records latency but has no absolute speed threshold. Correctness gates are dispositive.
- **The spike performs only Identifier payload rewrites — no structural insert, delete, or move.** `GraphChange` carries `UpsertNode`/`DeleteNode` and `NodeRecord` carries `child_index`, but nothing here may exercise sibling reindexing: position-derived identity is gated by the approved design (spec line 223) behind stable logical IDs.
- **A gate that cannot fail is worse than a missing gate.** Every assertion added here must be checked against the question "could this pass while the property it names is false?" Five gates originally failed that test; see the 2026-07-14 `decisions.md` entry.
- If a redb durability/recovery/fencing gate fails, stop and append the failure to `decisions.md` before considering LMDB, RocksDB, or a custom WAL.

## Known and accepted limits of this spike

State these in the report; do not let a green suite imply otherwise.

- **fsync ordering and torn-write recovery are NOT tested.** `std::process::abort()` leaves the OS page cache intact, so an aborting process and its recovering successor share unsynced bytes. The four failpoints prove **process-level atomicity only**. These properties are inherited from redb on trust — which is exactly why the design rejected a custom WAL. (A fault-injecting `redb::StorageBackend` shim would close this; explicitly rejected as scope, see `decisions.md`.)
- **Fencing here is safety-only, not liveness.** `issue_fence` is an unconditional increment with no ownership, so two concurrent issuers can livelock, each invalidating the other. Mutual exclusion in this spike comes from `publish_lock`, not from fences. Liveness is the scheduler's job.
- **A fence claim is one-use, but is not bound to its content.** A claim issued for one publication can authorize a different one, once. Binding claims to a scope fingerprint and validation result is spec lines 161-162 and is scheduler work.
- **No ticket lifecycle is proven.** Tickets are written in a terminal state; there is no queued ticket, no state machine, and no acknowledgement cursor.
- **`OperationRecord.change_set_id` is a foreign key into a table nothing persists** until the scheduler adds `change_sets`/`intents`.

## File Structure

### Repository integration

- Create `Cargo.toml` — root Rust workspace containing `crates/strata-kernel`.
- Create `rust-toolchain.toml` — pin Rust 1.89.0, the minimum supported by redb 4.1.0.
- Modify `.gitignore` — ignore Cargo `target/` and local `*.redb` spike files.
- Modify `package.json` — add explicit `kernel:build` and `kernel:test` scripts; do not add Cargo to existing pnpm recursive build/test yet.

### Rust kernel

- Create `crates/strata-kernel/Cargo.toml` — crate dependencies (Task 1); the `redb-spike` `[[bin]]` target is added later, in Task 7.
- Create `crates/strata-kernel/src/lib.rs` — public module/export boundary only.
- Create `crates/strata-kernel/src/model.rs` — versioned nodes, references, snapshots, deltas, operations, tickets, events, fences, and publication types.
- Create `crates/strata-kernel/src/graph.rs` — immutable `GraphGeneration`, deterministic indexes/digest, and delta application.
- Create `crates/strata-kernel/src/storage.rs` — redb tables, seed/open, atomic publication, snapshots, and durable reads.
- Create `crates/strata-kernel/src/kernel.rs` — authoritative epoch, in-memory generation publication, fence issuance/checking, and recovery.
- Create `crates/strata-kernel/src/bin/redb_spike.rs` — fixture seed/inspect/publish/crash/measure harness.
- Create focused integration tests under `crates/strata-kernel/tests/`.

### TypeScript snapshot bridge

- Create `packages/ingest/src/kernelSnapshot.ts` — versioned, sorted snapshot conversion.
- Create `packages/ingest/src/exportKernelSnapshotCli.ts` — deterministic corpus walk and `--out` writer.
- Modify `packages/ingest/src/index.ts` — export snapshot types/converter.
- Modify `packages/ingest/package.json` — add `export:kernel-snapshot`.
- Create `packages/ingest/tests/kernelSnapshot.test.ts`.
- Generate `crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json` from `examples/medium`.

---

### Task 1: Rust workspace and versioned graph model

**Files:**
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `crates/strata-kernel/Cargo.toml`
- Create: `crates/strata-kernel/src/lib.rs`
- Create: `crates/strata-kernel/src/model.rs`
- Test: `crates/strata-kernel/tests/model_roundtrip.rs`

**Interfaces:**
- Consumes: none.
- Produces: `NodeRecord`, `ReferenceRecord`, `GraphSnapshot`, `GraphChange`, `GraphDelta`, `OperationRecord`, `TicketRecord`, `EventRecord`, `FenceClaim`, `Publication`, and `SCHEMA_VERSION`.

- [ ] **Step 1: Add the failing model round-trip test**

```rust
use strata_kernel::{
    GraphChange, GraphDelta, GraphSnapshot, NodeRecord, ReferenceRecord, SCHEMA_VERSION,
};

#[test]
fn snapshot_and_delta_json_are_versioned_camel_case_and_round_trip() {
    let snapshot = GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![NodeRecord {
            id: "decl".into(),
            kind: "FunctionDeclaration".into(),
            parent_id: Some("module".into()),
            child_index: Some(0),
            payload: "export function f() {}".into(),
        }],
        references: vec![ReferenceRecord {
            from_node_id: "use".into(),
            to_node_id: "decl".into(),
            kind: "value".into(),
        }],
    };
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(encoded.contains("\"schemaVersion\":1"));
    assert!(encoded.contains("\"parentId\":\"module\""));
    assert_eq!(
        serde_json::from_str::<GraphSnapshot>(&encoded).unwrap(),
        snapshot
    );

    let delta = GraphDelta {
        schema_version: SCHEMA_VERSION,
        base_generation: 0,
        changes: vec![GraphChange::UpsertNode {
            node: snapshot.nodes[0].clone(),
        }],
    };
    assert_eq!(
        serde_json::from_slice::<GraphDelta>(&serde_json::to_vec(&delta).unwrap()).unwrap(),
        delta
    );
}

// A Rust->Rust round-trip is symmetric and passes under EITHER casing, so it
// cannot catch the enum-field bug. Assert the wire bytes directly.
#[test]
fn graph_change_struct_variant_fields_are_camel_case() {
    let encoded = serde_json::to_string(&GraphChange::DeleteReference {
        from_node_id: "use".into(),
    })
    .unwrap();
    assert!(encoded.contains("\"fromNodeId\""), "got {encoded}");
    assert!(!encoded.contains("from_node_id"), "got {encoded}");

    let encoded = serde_json::to_string(&GraphChange::DeleteNode {
        node_id: "decl".into(),
    })
    .unwrap();
    assert!(encoded.contains("\"nodeId\""), "got {encoded}");
    assert!(!encoded.contains("node_id"), "got {encoded}");
}
```

- [ ] **Step 2: Run the test and verify the Rust workspace does not exist yet**

Run: `cargo test -p strata-kernel --all-features --test model_roundtrip`
Expected: FAIL because the root `Cargo.toml` and `strata-kernel` crate do not exist.

- [ ] **Step 3: Create the workspace and dependency manifests**

`Cargo.toml`:

```toml
[workspace]
members = ["crates/strata-kernel"]
resolver = "2"
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.89.0"
profile = "minimal"
components = ["rustfmt", "clippy"]
```

`crates/strata-kernel/Cargo.toml`:

```toml
[package]
name = "strata-kernel"
version = "0.1.0"
edition = "2024"
rust-version = "1.89"

[lib]
name = "strata_kernel"
path = "src/lib.rs"

[features]
# Off by default. Gates BOTH the crash failpoints and the test-only
# inspection helpers. Integration tests under tests/ link the lib compiled
# WITHOUT cfg(test), so `#[cfg(test)]` items are invisible to them -- a
# feature is the only mechanism that reaches both tests/ and the bin.
# Every cargo test/clippy command in this plan passes --all-features; the
# redb-spike bin is run with --features spike-testing.
spike-testing = []

[dependencies]
anyhow = "1.0"
redb = "4.1.0"
serde = { version = "1.0.181", features = ["derive"] }
serde_json = "1.0"
sha2 = "0.10"

[dev-dependencies]
tempfile = "3.0"
```

Notes on the manifest, all verified against the real crate:

- `serde` is floored at `1.0.181` because `rename_all_fields` (Step 4) was introduced there.
- There is no `uuid` dependency. Every ID in this spike is a `String` set from a literal or a counter; `uuid` was declared in an earlier draft and used nowhere. `-D warnings` will not catch an unused dependency.
- redb 4.1.0's MSRV genuinely is 1.89, so the toolchain pin is not arbitrary. Both were verified against the registry.
- **redb 3.0 moved `begin_read()` (and `cache_stats()`) onto the `ReadableDatabase` trait.** Any module calling `db.begin_read()` needs `use redb::ReadableDatabase;` or it fails to compile. Snippets copied from redb 1.x/2.x examples will hit this.

Add `/target/` and `*.redb` to `.gitignore`. Add these root scripts without changing `build` or `test`:

```json
"kernel:build": "cargo build -p strata-kernel",
"kernel:test": "cargo test -p strata-kernel --all-features"
```

Every `cargo test`/`cargo clippy` command in this plan passes `--all-features`, and `cargo run` for the spike binary passes `--features spike-testing`. The `spike-testing` feature gates the crash failpoints and the test-only inspection helpers, and integration tests under `tests/` cannot see `#[cfg(test)]` items, so without the flag those tests fail to compile. Keeping the flag uniform across all tasks — even the early ones that do not need it yet — is deliberate: a command that silently omits it later produces a confusing "method not found" rather than an obvious error.

`kernel:build` deliberately omits it: a plain `cargo build` is the closest thing this plan has to a check that the crate compiles *without* the spike surface, which is the configuration the eventual coordination kernel ships.

- [ ] **Step 4: Implement the versioned model**

In `model.rs` define every public type with `Clone, Debug, PartialEq, Eq, Serialize, Deserialize` and `#[serde(rename_all = "camelCase")]`. Use this exact public surface:

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub id: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub child_index: Option<i64>,
    pub payload: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceRecord {
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub schema_version: u32,
    pub generation: u64,
    pub nodes: Vec<NodeRecord>,
    pub references: Vec<ReferenceRecord>,
}

// `rename_all` on an enum renames VARIANTS only. Without `rename_all_fields`,
// `node_id`/`from_node_id` serialize as snake_case and silently violate the
// camelCase constraint on a durably persisted payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GraphChange {
    UpsertNode { node: NodeRecord },
    DeleteNode { node_id: String },
    UpsertReference { reference: ReferenceRecord },
    DeleteReference { from_node_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDelta {
    pub schema_version: u32,
    pub base_generation: u64,
    pub changes: Vec<GraphChange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub operation_id: String,
    pub change_set_id: String,
    pub actor: String,
    pub kind: String,
    pub reasoning: String,
    pub affected_node_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRecord {
    pub ticket_id: String,
    pub state: String,
    pub scope_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub event_id: String,
    pub sequence: u64,
    pub kind: String,
    pub graph_generation: u64,
    pub payload_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceClaim {
    pub service_epoch: u64,
    pub resource_tokens: BTreeMap<String, u64>,
}

// Composite by design. The approved spec (line 164) publishes "the operation
// records ... change-set/ticket transitions ... event records" -- all plural --
// and acceptance item 10 requires related operations to commit together.
// This spike always publishes vectors of length one and builds NO scheduler
// logic, but schemaVersion 1 must certify a shape the scheduler can grow into,
// or the scheduler's first act is a breaking migration of the format this
// spike just blessed. See decisions.md 2026-07-14.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub schema_version: u32,
    pub idempotency_key: String,
    pub change_set_id: String,
    pub delta: GraphDelta,
    pub operations: Vec<OperationRecord>,
    pub tickets: Vec<TicketRecord>,
    pub events: Vec<EventRecord>,
    pub fence: FenceClaim,
}
```

Re-export these types and `SCHEMA_VERSION` from `lib.rs`.

Extend the Step 1 test to cover the composite shape: build a `Publication` with one element in each vector, assert it round-trips, and assert the encoded JSON contains `"changeSetId"` and `"operations":[`. Do not add multi-element publications — vectors of length one are the whole spike surface.

- [ ] **Step 5: Format and run the model test**

Run: `cargo fmt --all && cargo test -p strata-kernel --all-features --test model_roundtrip`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml rust-toolchain.toml Cargo.lock .gitignore package.json crates/strata-kernel
git commit -m "build(kernel): scaffold Rust workspace and graph model"
```

---

### Task 2: Immutable graph generations and deterministic digest

**Files:**
- Create: `crates/strata-kernel/src/graph.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Test: `crates/strata-kernel/tests/graph_generation.rs`

**Interfaces:**
- Consumes: `GraphSnapshot`, `GraphDelta`, `GraphChange`.
- Produces: `GraphGeneration::from_snapshot`, `GraphGeneration::apply`, `GraphGeneration::snapshot`, `GraphGeneration::digest`, `GraphGeneration::generation`, `GraphGeneration::node`, `GraphGeneration::references_to`, and the free function `digest_of`.

- [ ] **Step 1: Write failing generation tests**

```rust
use strata_kernel::{
    GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, SCHEMA_VERSION,
};

fn seed() -> GraphGeneration {
    GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: vec![NodeRecord {
            id: "n1".into(),
            kind: "Identifier".into(),
            parent_id: Some("s1".into()),
            // Real ingest sets childIndex NULL for every Identifier
            // (emitIdentifiers.ts:40) -- ~90% of nodes on examples/medium.
            // Identifier ordinal lives in the ID hash, not in child_index.
            // Do not "helpfully" put Some(0) here; it teaches the wrong model.
            child_index: None,
            payload: r#"{"text":"Old","offset":0}"#.into(),
        }],
        references: vec![],
    })
    .unwrap()
}

#[test]
fn applying_a_delta_publishes_a_new_generation_without_mutating_the_old_one() {
    let old = seed();
    let mut renamed = old.node("n1").unwrap().clone();
    renamed.payload = r#"{"text":"New","offset":0}"#.into();
    let next = old
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: renamed }],
        })
        .unwrap();

    assert_eq!(old.generation(), 0);
    assert!(old.node("n1").unwrap().payload.contains("Old"));
    assert_eq!(next.generation(), 1);
    assert!(next.node("n1").unwrap().payload.contains("New"));
    assert_ne!(old.digest(), next.digest());
}

// The assertion above is NOT evidence the digest covers content: `snapshot()`
// includes `generation`, so it is satisfied by the generation bump alone. A
// digest hashing nothing but the generation number passes it. These two tests
// are what actually pin the digest to content.
#[test]
fn digest_is_content_sensitive_at_a_fixed_generation() {
    let a = seed();
    let mut changed = a.node("n1").unwrap().clone();
    changed.payload = r#"{"text":"Old","offset":1}"#.into(); // one byte
    let b = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0, // SAME generation as `a`
        nodes: vec![changed],
        references: vec![],
    })
    .unwrap();
    assert_eq!(a.generation(), b.generation());
    assert_ne!(a.digest(), b.digest(), "digest ignores node payload");
}

#[test]
fn identical_content_reached_by_different_paths_has_an_equal_digest() {
    // Direct: seed already at the target content.
    let direct = GraphGeneration::from_snapshot(GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 1,
        nodes: vec![NodeRecord {
            id: "n1".into(),
            kind: "Identifier".into(),
            parent_id: Some("s1".into()),
            child_index: None,
            payload: r#"{"text":"New","offset":0}"#.into(),
        }],
        references: vec![],
    })
    .unwrap();

    // Replayed: seed at "Old", apply a delta to reach "New".
    let mut renamed = seed().node("n1").unwrap().clone();
    renamed.payload = r#"{"text":"New","offset":0}"#.into();
    let replayed = seed()
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 0,
            changes: vec![GraphChange::UpsertNode { node: renamed }],
        })
        .unwrap();

    // This is the property recovery depends on: replay must converge on the
    // same digest as the generation it is reconstructing.
    assert_eq!(direct.generation(), replayed.generation());
    assert_eq!(direct.digest(), replayed.digest());
}

#[test]
fn wrong_base_generation_is_rejected() {
    let err = seed()
        .apply(&GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: 9,
            changes: vec![],
        })
        .unwrap_err();
    assert!(err.to_string().contains("base generation 9"));
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `cargo test -p strata-kernel --all-features --test graph_generation`
Expected: FAIL because `GraphGeneration` is undefined.

- [ ] **Step 3: Implement `GraphGeneration`**

Use deterministic collections:

```rust
#[derive(Clone, Debug)]
pub struct GraphGeneration {
    generation: u64,
    nodes: BTreeMap<String, NodeRecord>,
    references_from: BTreeMap<String, ReferenceRecord>,
    references_to: BTreeMap<String, BTreeSet<ReferenceRecord>>,
    digest: String,
}
```

Also expose the digest encoding as a free function — it is the **single** definition, and Task 4's recovery check plus Task 7's read-time recompute both call it:

```rust
// graph.rs, public. Lowercase hex SHA-256 over serde_json::to_vec(snapshot).
// GraphGeneration::digest() is this applied to snapshot(). Any test that
// recomputes a digest MUST call this rather than reimplement the encoding --
// a test that disagrees about hex casing proves nothing.
pub fn digest_of(snapshot: &GraphSnapshot) -> String;
```

`from_snapshot` must reject non-v1 input, duplicate node IDs, duplicate `from_node_id` references, and references with missing endpoints. `apply` must reject the wrong base generation, apply all changes to cloned maps, rebuild `references_to`, validate endpoints, increment generation by exactly one, and set the digest from `digest_of(&snapshot())`. `snapshot()` returns nodes and references in deterministic key order.

Use `anyhow::bail!` messages containing the bad schema, duplicate ID, missing endpoint, or base generation so tests can assert the cause.

- [ ] **Step 4: Add reference-index assertions**

Extend the test with two nodes and one reference. Assert `references_to("decl")` returns the use-site reference, then delete it with `DeleteReference` and assert the old generation still has it while the new generation does not.

- [ ] **Step 5: Run graph tests and clippy**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings && cargo test -p strata-kernel --all-features --test graph_generation`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/graph_generation.rs
git commit -m "feat(kernel): add immutable graph generations"
```

---

### Task 3: Redb seed, durable tables, and atomic publication

**Files:**
- Create: `crates/strata-kernel/src/storage.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Test: `crates/strata-kernel/tests/storage_atomic.rs`

**Interfaces:**
- Consumes: `GraphSnapshot` and `Publication`.
- Produces: `DurableStore::DURABILITY`, `DurableStore::create`, `DurableStore::open`, `DurableStore::seed`, `DurableStore::publish`, `DurableStore::current_generation`, `DurableStore::operations`, `DurableStore::ticket`, `DurableStore::events_at`, `DurableStore::delta`, `DurableStore::digest`, `DurableStore::was_published`, and `PublishOutcome`.

- [ ] **Step 1: Write the failing atomic-publication test**

Create a temp redb file, seed generation 0, issue a publication changing one node, close/reopen, and assert all seven durable facts agree:

```rust
assert_eq!(reopened.current_generation().unwrap(), 1);
assert_eq!(reopened.operations(1).unwrap(), publication.operations);
assert_eq!(
    reopened.ticket(&publication.tickets[0].ticket_id).unwrap().unwrap(),
    publication.tickets[0]
);
assert_eq!(reopened.events_at(1).unwrap(), publication.events);
assert!(reopened.was_published(&publication.idempotency_key).unwrap());
assert_eq!(reopened.delta(1).unwrap().unwrap(), publication.delta);
assert_eq!(reopened.digest(1).unwrap().unwrap(), expected_digest);
```

Add a second test that submits the same idempotency key twice. The second call must return `PublishOutcome::AlreadyPublished { generation: 1 }` and must not append another event or operation.

Add a third test pinning the durability level, since the whole crash-recovery gate rests on it and nothing else would notice a regression:

```rust
// Durability::None would make every failpoint test in Task 7 pass while
// real power loss drops committed generations. Assert the level explicitly.
#[test]
fn publish_uses_immediate_durability() {
    assert_eq!(DurableStore::DURABILITY, redb::Durability::Immediate);
}
```

Expose it as `pub const DURABILITY: redb::Durability = redb::Durability::Immediate;` on `DurableStore` and use that constant on every write transaction, so there is exactly one place to get it wrong.

Define the outcome exactly:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    Published { generation: u64 },
    AlreadyPublished { generation: u64 },
}
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --all-features --test storage_atomic`
Expected: FAIL because `DurableStore` and `PublishOutcome` do not exist.

- [ ] **Step 3: Define redb tables and metadata keys**

In `storage.rs` define:

```rust
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("graph_metadata");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");
const OPERATIONS: TableDefinition<u64, &[u8]> = TableDefinition::new("operations");
const DELTAS: TableDefinition<u64, &[u8]> = TableDefinition::new("deltas");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("events");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("tickets");
const IDEMPOTENCY: TableDefinition<&str, u64> = TableDefinition::new("idempotency_keys");
const FENCES: TableDefinition<&str, u64> = TableDefinition::new("fence_tokens");
const CONSUMED_FENCES: TableDefinition<&str, u64> =
    TableDefinition::new("consumed_fence_tokens");
// Digest per generation. Recovery compares its REPLAYED digest against the
// value stored here at publish time. Without an independently persisted
// expected value, "verify the digest" only re-runs the code under test.
const DIGESTS: TableDefinition<u64, &str> = TableDefinition::new("generation_digests");

const CURRENT_GENERATION: &str = "current_generation";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";
const SERVICE_EPOCH: &str = "service_epoch";
```

`OPERATIONS` and `EVENTS` store a JSON array per generation (the composite vectors), not a single record.

This is a deliberate ten-table narrowing of the approved spec's twelve; the divergence and its consequences are logged in `decisions.md` (2026-07-14). Do not add `nodes`/`references_from`/`references_to` (snapshots carry them) or `change_sets`/`intents` (scheduler-owned).

Encode structured values with `serde_json::to_vec`. Encode metadata `u64` values as `to_le_bytes()` and reject any metadata value whose length is not eight. Add `use redb::ReadableDatabase;` for `begin_read()` (moved to that trait in redb 3.0).

- [ ] **Step 4: Implement seed and publication**

State these two signatures explicitly; both take a caller-computed digest, because `storage.rs` must not depend on `graph.rs` (see this task's Interfaces — it consumes `GraphSnapshot` and `Publication` only). If storage computed digests itself, it would recreate exactly the same-code-path circularity that persisting the digest exists to eliminate:

```rust
pub fn seed(&self, snapshot: &GraphSnapshot, digest: &str) -> Result<()>;
pub fn publish(&self, publication: &Publication, digest: &str) -> Result<PublishOutcome>;
```

`Kernel::create` and `Kernel::publish` both hold a `GraphGeneration` and supply the digest from it.

`seed` must create every table in one write transaction, require generation 0, store the initial snapshot under key 0, store the caller's digest under `DIGESTS[0]`, set generation/event sequence/epoch to zero, and refuse a second seed.

`publish` must:

1. Open one redb write transaction, with durability set from `DurableStore::DURABILITY`.
2. Return `AlreadyPublished { generation }` if the idempotency key exists, where `generation` is **the generation that key originally published at** — read it from `IDEMPOTENCY`, never substitute the current generation.
3. Require `publication.schema_version == SCHEMA_VERSION` and `delta.schema_version == SCHEMA_VERSION`. (`from_snapshot` validates the snapshot's version; nothing was validating the delta's, so a v2 delta was being accepted.)
4. Require `delta.base_generation == current_generation`.
5. Require non-empty `operations` and `events`.
6. Require `events` sequences to be contiguous starting at `current_event_sequence + 1`, and every `event.graph_generation == current_generation + 1`.
7. Verify the fence claim (added in Task 5).
8. Write `operations` and `delta` under `current_generation + 1`, and the caller's digest under `DIGESTS[current_generation + 1]`.
9. Upsert every ticket; write the whole `events` array under `current_generation + 1` (keyed by generation, matching `OPERATIONS` — **not** keyed by each event's sequence, which would break the moment a publication carries two events).
10. Record idempotency key → new generation.
11. Update current generation and event sequence (the latter to the last event's sequence).
12. Commit once.

Do not mutate in-memory graph state in this module.

`Publication.change_set_id` is **not** persisted to a table of its own — `OperationRecord.change_set_id` carries it into `OPERATIONS`. Do not add an eleventh table for it; `change_sets`/`intents` are scheduler-owned (see `decisions.md` 2026-07-14).

`DurableStore::create` opens or creates the redb file without seeding; `DurableStore::open` requires an already-seeded file and errors otherwise. Both take a path.

Use `anyhow::bail!` messages containing the offending schema version, base generation, event sequence, or idempotency key, so tests can assert the cause rather than merely that an error occurred.

> **Known forward constraint, deliberately accepted.** Step 6 couples event sequence to generation 1:1, which holds for publication-time events but not for the scheduler's `IntentQueued`/`IntentReady`/`LeaseExpired` — none of which change the generation. Those need a separate `append_event` path outside `publish`. Do not build it here; it is logged in `decisions.md` as a scheduler-time revisit. Because every publish in this spike bumps both counters by exactly one, no test here can distinguish sequence from generation — that is a limit of the spike, not a proven property.

- [ ] **Step 5: Prove failed validation leaves every table unchanged**

Add table-count/current-generation helpers gated `#[cfg(feature = "spike-testing")]` — **not** `#[cfg(test)]`. `tests/storage_atomic.rs` is a separate crate linking the lib built without `cfg(test)`, so `#[cfg(test)]` items are invisible to it and the test would not compile.

Submit a publication with the wrong event sequence and assert generation, operation count, event count, ticket, digest count, and idempotency count are unchanged. Repeat for a rejected `schema_version` and a rejected `base_generation`.

- [ ] **Step 6: Run storage tests**

Run: `cargo fmt --all && cargo test -p strata-kernel --all-features --test storage_atomic`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/storage_atomic.rs
git commit -m "feat(kernel): persist atomic publications in redb"
```

---

### Task 4: Snapshot replay and authoritative restart recovery

**Files:**
- Create: `crates/strata-kernel/src/kernel.rs`
- Modify: `crates/strata-kernel/src/storage.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Test: `crates/strata-kernel/tests/recovery.rs`

**Interfaces:**
- Consumes: `DurableStore`, `GraphGeneration`.
- Produces: `Kernel::create`, `Kernel::open`, `Kernel::open_read_only`, `Kernel::snapshot`, `Kernel::publish`, `Kernel::write_snapshot`, `RecoveryReport`, `PublicationReport`, `DurableStore::begin_service_epoch`, `DurableStore::latest_snapshot`, `DurableStore::deltas_after`, and `DurableStore::write_snapshot`.

- [ ] **Step 1: Write failing recovery tests**

Test this sequence. Note the ordering: the snapshot at generation 1 must be written **while generation 1 is live**. The original sequencing ("publish 1 and 2, then write a snapshot at generation 1") is not implementable — by then `live` is generation 2 and there is no API to materialize a historical generation, and there must not be one in this spike.

1. Create and seed generation 0.
2. Publish a delta for generation 1.
3. Write a snapshot at generation 1 (`kernel.write_snapshot()` captures the live generation).
4. Publish a delta for generation 2.
5. Drop the kernel explicitly (`drop(kernel)`) — redb holds a file lock, so reopening without dropping fails with a lock error, not the intended assertion.
6. Reopen and recover snapshot 1 plus delta 2.
7. Assert generation, digest, nodes, and references equal the pre-drop generation 2.

Assert the recovery report distinguishes its inputs: `snapshot_generation == 1` and `replayed_operations == 1`. A recovery that silently replayed from generation 0 would otherwise produce an identical graph and pass.

Add corruption tests for a missing delta and a replayed delta whose base generation does not match. Both must fail opening with an error containing the expected generation.

Add the test that gives the digest gate teeth — replay divergence is the one bug class it exists to catch:

```rust
// Corrupt the STORED digest for generation 2, leaving the delta intact.
// Recovery replays correctly, so generation and content match; only the
// persisted expected value disagrees. If open() succeeds here, the digest
// is decorative and acceptance item 9 is vacuous.
store.overwrite_digest_for_test(2, "0000deadbeef").unwrap();
drop(store); // redb holds a file lock; Kernel::open would fail on the lock,
             // not on the digest, and the test would pass for the wrong reason.
let err = Kernel::open(path).unwrap_err();
assert!(err.to_string().contains("digest mismatch"), "{err}");
```

`overwrite_digest_for_test` is `#[doc(hidden)] pub` behind `#[cfg(feature = "spike-testing")]`, for the same reason as Task 3's count helpers.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --all-features --test recovery`
Expected: FAIL because `Kernel` and recovery APIs do not exist.

- [ ] **Step 3: Implement latest-snapshot lookup and ordered delta scan**

Add:

```rust
// All three live on DurableStore. `Kernel::write_snapshot` is a thin wrapper
// that captures the LIVE generation and delegates here -- callers never choose
// which generation gets snapshotted.
pub fn latest_snapshot(&self) -> Result<GraphSnapshot>;
pub fn deltas_after(&self, generation: u64) -> Result<Vec<(u64, GraphDelta)>>;
pub fn write_snapshot(&self, snapshot: &GraphSnapshot, digest: &str) -> Result<()>;
```

`deltas_after` must iterate redb keys in ascending order, require no generation gaps through `current_generation`, and deserialize every value before returning.

`write_snapshot` must reject a snapshot whose generation exceeds `current_generation`, and must reject one whose digest disagrees with `DIGESTS[snapshot.generation]`. An unvalidated snapshot permanently poisons every future recovery, and there is no later opportunity to notice.

- [ ] **Step 4: Implement authoritative `Kernel` publication ordering**

`Kernel` owns:

```rust
#[derive(Debug)] // required: Step 1 calls Kernel::open(..).unwrap_err()
pub struct Kernel {
    store: DurableStore,
    live: RwLock<Arc<GraphGeneration>>,
    publish_lock: Mutex<()>,
    service_epoch: u64,
}
```

Define the report types exactly. Both derive `Debug` — `Kernel` must too, since `Kernel::open(...).unwrap_err()` in Step 1 requires `(Kernel, RecoveryReport): Debug`:

```rust
#[derive(Debug)]
pub struct RecoveryReport {
    pub snapshot_generation: u64,
    pub replayed_operations: u64,
    pub generation: u64,
    pub digest: String,
    pub service_epoch: u64,
}

#[derive(Debug)]
pub struct PublicationReport {
    pub generation: u64,
    pub digest: String,
    /// GraphGeneration::apply + digest. Dominant term: it clones the node
    /// BTreeMap, rebuilds references_to, and SHA-256s a serde_json encoding
    /// of the WHOLE corpus. Statement payloads are raw source text, so this
    /// scales with the graph, not the delta.
    pub apply_ns: u128,
    pub persistence_ns: u128,
    pub memory_publish_ns: u128,
    /// End-to-end span under `publish_lock`. This -- not persistence_ns -- is
    /// what the design's "deliberately short commit sequencer" claim must be
    /// judged against.
    pub critical_section_ns: u128,
    pub already_published: bool,
}
```

`apply_ns` and `critical_section_ns` exist because the original two fields measured the redb call and a pointer swap while the dominant cost sat between them, unmeasured. Reporting only those two would have produced excellent numbers describing the wrong span.

State the constructors' signatures explicitly — every caller needs the `Kernel` *and* the report, and the tests in Step 1 publish through the reopened kernel:

```rust
pub fn create(path: &Path, snapshot: GraphSnapshot) -> Result<Kernel>;
pub fn open(path: &Path) -> Result<(Kernel, RecoveryReport)>;
pub fn open_read_only(path: &Path) -> Result<(Kernel, RecoveryReport)>;
pub fn snapshot(&self) -> Arc<GraphGeneration>;
pub fn write_snapshot(&self) -> Result<()>;   // captures the LIVE generation
// Takes the publication by reference and ONE argument: the kernel owns the
// GraphGeneration, so it computes the digest itself and passes it down to
// DurableStore::publish. Callers never supply a digest.
pub fn publish(&self, publication: &Publication) -> Result<PublicationReport>;
```

Every call site in Tasks 5, 7, and 8 uses exactly this shape: `kernel.publish(&some_publication)?`. (`digest_of` is `graph.rs`'s, defined in Task 2 — do not redefine it here.)

`Kernel::create` seeds a new database from a `GraphSnapshot` at generation 0 and calls `begin_service_epoch` exactly once, returning a `Kernel` whose `live` is that generation.

`Kernel::open` increments the durable service epoch, loads the latest snapshot, applies later deltas, compares the result generation **and digest** with durable metadata, and returns the recovered kernel plus `RecoveryReport { snapshot_generation, replayed_operations, generation, digest, service_epoch }`. A digest mismatch is a hard error whose message contains `digest mismatch` and names both values — this is the check that catches replay diverging from the original apply.

`Kernel::open_read_only` loads and replays identically but **never calls `begin_service_epoch` and never opens a write transaction**. Its `RecoveryReport.service_epoch` reports the stored epoch as read. Every diagnostic path (`redb-spike inspect`) uses this. The distinction is load-bearing: an authoritative open from a read-only diagnostic would invalidate every outstanding fence token, and would need a write transaction — so it would fail exactly when the database is damaged and you most need to inspect it.

Implement `DurableStore::begin_service_epoch()` here as one redb write transaction that reads `SERVICE_EPOCH`, increments it with checked arithmetic, stores it, commits, and returns the new value. `Kernel::create` and `Kernel::open` call it exactly once; `Kernel::open_read_only` never does.

Note that `seed` sets the epoch to 0 and `Kernel::create` then bumps it to 1, so **no live claim ever carries `service_epoch: 0`** — the zero-valued placeholder claim in Task 7 is therefore never valid, which is intended.

`Kernel::publish` must:

1. Hold `publish_lock`.
2. Query the idempotency table before applying the delta. If the key already maps to a committed generation, return **that key's original generation and its stored digest** with `already_published: true`, and do not apply or publish anything. Do **not** return the current generation: a key that published at generation 5, retried after two later publishes, must not report generation 7 — a client resolving "the operation my publish created" would fetch someone else's operation, and this is the exact crash-retry path idempotency exists for. This must agree with `DurableStore::publish`'s `AlreadyPublished { generation }`; add a kernel-level test that publishes K, then two other keys, then retries K and asserts it still reports generation 5.
3. Clone the current `Arc<GraphGeneration>` **in a scoped block so the read guard drops before step 6**. The natural `let live = self.live.read().unwrap();` held across the whole function self-deadlocks on the `write()` below.
4. Build the next generation with `GraphGeneration::apply`, timing it as `apply_ns`.
5. Call `DurableStore::publish`, passing the new generation's digest. Keep the storage-level idempotency check as the atomic race guard. (In this spike redb's file lock makes a cross-process race impossible and `publish_lock` serializes in-process, so this guard is untested defense-in-depth — do not remove it, and do not claim it is proven.)
6. Only after redb commits, replace `live` with the new `Arc`.
7. Return `PublicationReport` with `already_published: false`.

Use `.lock()`/`.read()`/`.write()` results with explicit poison handling rather than bare `.unwrap()`: any panic under `publish_lock` otherwise poisons it and turns every subsequent publish into a permanent panic with no recovery path. Recovering the guard (`unwrap_or_else(|e| e.into_inner())`) is acceptable for the spike; note the choice in the report.

- [ ] **Step 5: Run recovery and existing tests**

Run: `cargo fmt --all && cargo test -p strata-kernel --all-features`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/recovery.rs
git commit -m "feat(kernel): recover graph generations from snapshot and log"
```

---

### Task 5: Service epochs and fenced publication

**Files:**
- Modify: `crates/strata-kernel/src/storage.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Test: `crates/strata-kernel/tests/fencing.rs`

**Interfaces:**
- Consumes: `FenceClaim.service_epoch`, `FenceClaim.resource_tokens`, and the service epoch established by `Kernel::create` / `Kernel::open`.
- Produces: `Kernel::issue_fence`, `DurableStore::issue_fence`, `DurableStore::verify_fence_in_write_txn`, and `Kernel::publish` rejection of stale-epoch, stale-token, missing-resource, and reused claims.

- [ ] **Step 1: Write failing fencing tests**

Cover:

```rust
let resources = ["symbol:User".to_string()];
let first = kernel.issue_fence(&resources).unwrap();
let newer = kernel.issue_fence(&resources).unwrap();
assert!(
    kernel
        .publish(&publication_with(first, "first-attempt"))
        .unwrap_err()
        .to_string()
        .contains("stale fence")
);
assert!(
    kernel
        .publish(&publication_with(newer, "newer-attempt"))
        .is_ok()
);
```

Define a local `publication_with(claim: FenceClaim, idempotency_key: &str) -> Publication` helper at the top of the test using the complete model from Task 1; give each invocation a distinct idempotency key unless the test is explicitly exercising idempotency.

Then drop the kernel, reopen it, assert `service_epoch` increased by one, and prove a claim from the previous process is rejected even when its resource token is numerically current. Assert the rejection names the epoch (`contains("service epoch")`), not merely that publishing failed — with the token checks alone this case is accepted, so a test that only asserts `is_err()` after a *different* fix would still pass while the epoch went unchecked.

Because this file asserts an exact epoch value, keep it in its own test file with its own temp database, and use `Kernel::open_read_only` for any inspection: any sibling command that opens authoritatively silently bumps the count.

Add an all-or-nothing test: issuing a fence for `["symbol:User", "node:caller"]` increments both tokens in one redb transaction and returns both; injected failure before commit increments neither. `PublishFailpoint` (Task 7) covers publication boundaries only and has no fence-issuance variant, so do **not** reach for it here — inject the failure with `DurableStore::issue_fence_failing_before_commit(&self, service_epoch: u64, resources: &[String])`, gated `#[cfg(feature = "spike-testing")]`, which performs every increment and then drops the write transaction without committing. Assert both counters are absent afterward.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --all-features --test fencing`
Expected: FAIL because `issue_fence` does not exist and publication ignores `FenceClaim`.

- [ ] **Step 3: Implement durable epoch and resource-token methods**

Add:

```rust
pub fn issue_fence(&self, service_epoch: u64, resources: &[String]) -> Result<FenceClaim>;
pub fn verify_fence_in_write_txn(
    &self,
    write_txn: &WriteTransaction,
    claim: &FenceClaim,
) -> Result<()>;
```

Sort and deduplicate resource keys before opening the write transaction. Reuse the `begin_service_epoch` method introduced in Task 4. `issue_fence` rejects a non-current epoch and increments all resource counters in one transaction.

`Kernel::issue_fence(&self, resources: &[String])` is a wrapper that supplies the kernel's own epoch and delegates to `DurableStore::issue_fence(service_epoch, resources)`. Clients never choose an epoch.

Call `verify_fence_in_write_txn` inside the same `DurableStore::publish` transaction. Check the idempotency table first so an already-committed retry returns `AlreadyPublished` even after a service restart. For a new publication it must require, in order:

1. **`claim.service_epoch` equals `SERVICE_EPOCH` read from inside this write transaction.** This check is the entire point of the epoch and was missing from the original spec for this function, which listed only the three token checks below. Because `FENCES` counters do **not** reset on reopen, a pre-restart claim's token is still numerically current, so the token checks alone accept it — making `FenceClaim.service_epoch` a dead field and falsifying the design's "startup… invalidat[es] every pre-crash fencing token immediately". Read the epoch from the transaction, **not** from `Kernel`'s cached `service_epoch` field: a cached value can never observe another opener's bump. That is untestable today only because redb's file lock prevents two kernels from coexisting; it becomes a live bug the moment the service wrapper lands.
2. At least one resource token.
3. Every claimed resource has a **present** `FENCES` entry. A missing key is a hard error, never `unwrap_or(0)` — otherwise the zero-valued placeholder claim from Task 7 publishes on its own.
4. Every claimed token equals its current `FENCES` counter.
5. Every claimed token is greater than its `CONSUMED_FENCES` value.

Write each consumed token to `CONSUMED_FENCES` in the same transaction as the delta, operations, events, tickets, idempotency key, digest, and generation pointer. This makes a fence one-use.

Use `anyhow::bail!` messages containing the exact substrings the tests assert, so a rejection for the *wrong reason* cannot pass: `service epoch` for check 1 (naming both the claim's epoch and the durable one), `stale fence` for checks 4 and 5, and `unknown fence resource` for check 3.

> Precisely: one-use means **a claim authorizes at most one publication**. It does *not* mean the claim is bound to a particular publication's content — a claim issued for rename A can be pasted into publication B and will publish. Binding a claim to its scope fingerprint and validation result is spec lines 161-162 and is scheduler work. Do not let the report imply otherwise.

**Update the earlier tests in this step.** Adding "at least one resource token equal to its `FENCES` counter" to `DurableStore::publish` retroactively breaks every test written before this task: `storage_atomic.rs` (Task 3) and `recovery.rs` (Task 4) publish without ever calling `issue_fence`, so `FENCES` is empty and every claim fails. Task 5's Step 4 runs the full suite and expects PASS, so this must be resolved deliberately rather than improvised.

Create `crates/strata-kernel/tests/common/mod.rs` and add `mod common;` to each test file that publishes. The path matters: `tests/common.rs` would be compiled as its own test binary, `tests/common/mod.rs` is not.

It needs **two** variants, because the two layers issue fences differently:

```rust
// Store-level: storage_atomic.rs seeds a DurableStore directly and has no
// Kernel, so it passes the seeded epoch (0) explicitly.
pub fn fenced_store_publication(
    store: &DurableStore, epoch: u64, resources: &[String], key: &str,
) -> Publication;

// Kernel-level: recovery.rs / fencing.rs / concurrent_readers.rs go through
// Kernel::issue_fence, which supplies the kernel's own epoch (>= 1).
pub fn fenced_kernel_publication(
    kernel: &Kernel, resources: &[String], key: &str,
) -> Publication;
```

Both issue a real fence and stamp the returned claim into the publication immediately before publishing. Task 7 must route `concurrent_readers.rs` — which does not exist yet at this task — through `fenced_kernel_publication` as well.

Note this qualifies the "no live claim ever carries `service_epoch: 0`" statement above: it holds for any `Kernel`-created database, but `storage_atomic.rs` drives a directly-seeded store whose epoch is legitimately 0, since `begin_service_epoch` is a `Kernel` responsibility.

**Do not** weaken the check to skip empty claims. That is the tempting fix and it silently guts gate #5, which is the gate this task exists to build.

- [ ] **Step 4: Run fencing and full kernel tests**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings && cargo test -p strata-kernel --all-features`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/fencing.rs
git commit -m "feat(kernel): fence publications by service epoch and resource"
```

---

### Task 6: Real TypeScript graph export from `examples/medium`

**Files:**
- Create: `packages/ingest/src/kernelSnapshot.ts`
- Create: `packages/ingest/src/exportKernelSnapshotCli.ts`
- Modify: `packages/ingest/src/index.ts`
- Modify: `packages/ingest/package.json`
- Create: `packages/ingest/tests/kernelSnapshot.test.ts`
- Generate: `crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json`
- Test: `crates/strata-kernel/tests/examples_medium_fixture.rs`

**Interfaces:**
- Consumes: `ingestBatch(inputs)`.
- Produces: `KernelSnapshotV1` and `toKernelSnapshot(batch)` with byte-deterministic ordering.

- [ ] **Step 1: Write the failing TypeScript snapshot test**

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch, toKernelSnapshot } from "../src/index";

describe("kernel snapshot bridge", () => {
  it("emits sorted schema-v1 camelCase records", () => {
    const batch = ingestBatch([
      { path: "/project/b.ts", text: "export const b = 1;\n" },
      { path: "/project/a.ts", text: "export const a = 1;\n" }
    ]);
    const snapshot = toKernelSnapshot(batch);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generation).toBe(0);
    expect(snapshot.nodes.map((n) => n.id)).toEqual(
      [...snapshot.nodes.map((n) => n.id)].sort()
    );
    expect(snapshot.references.map((r) => r.fromNodeId)).toEqual(
      [...snapshot.references.map((r) => r.fromNodeId)].sort()
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @strata/ingest test kernelSnapshot`
Expected: FAIL because `toKernelSnapshot` is not exported.

Note the missing `--`. `pnpm ... test -- kernelSnapshot` passes `--` through literally, producing `vitest run -- kernelSnapshot`, and vitest ignores the pattern — verified: `test -- nonexistentxyz` runs the whole suite and passes. Without `--`, the filter works. (CLAUDE.md documents the same broken form for `@strata/agent test -- replay`; out of scope here, but it has the same defect.)

- [ ] **Step 3: Implement the bridge types and converter**

```typescript
import type { IngestBatchResult } from "./batch";

export interface KernelNodeV1 {
  id: string;
  kind: string;
  parentId: string | null;
  childIndex: number | null;
  payload: string;
}

export interface KernelReferenceV1 {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
}

export interface KernelSnapshotV1 {
  schemaVersion: 1;
  generation: 0;
  nodes: KernelNodeV1[];
  references: KernelReferenceV1[];
}

export function toKernelSnapshot(batch: IngestBatchResult): KernelSnapshotV1 {
  return {
    schemaVersion: 1,
    generation: 0,
    // Sort by code unit (default .sort()), NOT localeCompare: the Rust side
    // compares these with BTreeMap's UTF-8 byte order. The two agree today
    // only because node IDs are fixed-length lowercase hex (sha1().slice(0,16))
    // and ref kinds are lowercase ASCII -- i.e. by coincidence, not by design.
    // Expressing byte order directly removes the locale dependence.
    nodes: batch.allNodes
      .map(({ id, kind, parentId, childIndex, payload }) => ({
        id, kind, parentId, childIndex, payload
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    references: batch.references
      .map(({ fromNodeId, toNodeId, kind }) => ({ fromNodeId, toNodeId, kind }))
      .sort((a, b) =>
        a.fromNodeId < b.fromNodeId ? -1 : a.fromNodeId > b.fromNodeId ? 1 :
        a.toNodeId < b.toNodeId ? -1 : a.toNodeId > b.toNodeId ? 1 :
        a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
      )
  };
}
```

`childIndex` is `null` for every Identifier node (`emitIdentifiers.ts:40`) — roughly 90% of nodes on `examples/medium`, since the Identifier ordinal lives in the ID hash rather than in `childIndex`. `Option<i64>` handling on the Rust side is the common path, not an edge case.

Export the interfaces and function from `index.ts`.

- [ ] **Step 4: Implement deterministic corpus export**

`exportKernelSnapshotCli.ts` accepts exactly `<corpusRoot> --out <path>`. Recursively read `.ts` files, skip `node_modules`, `.git`, and `dist`, and map every module to `/project/<POSIX-relative-path>` before calling `ingestBatch`. Write `JSON.stringify(snapshot, null, 2) + "\\n"` to the requested output. Resolve the output path but do not include it in the snapshot.

Add:

```json
"export:kernel-snapshot": "node dist/exportKernelSnapshotCli.js"
```

- [ ] **Step 5: Generate and pin the real fixture**

Run:

```bash
pnpm --filter @strata/ingest build
node packages/ingest/dist/exportKernelSnapshotCli.js examples/medium --out crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json
```

Expected: the JSON has `schemaVersion: 1`, generation 0, paths rooted under `/project/`, and non-empty nodes/references.

- [ ] **Step 6: Add the Rust fixture compatibility test**

Read the committed fixture with `include_str!`, deserialize `GraphSnapshot`, build `GraphGeneration`, and assert:

```rust
assert_eq!(snapshot.schema_version, 1);
assert_eq!(snapshot.generation, 0);
assert!(snapshot.nodes.len() > 100);
assert!(!snapshot.references.is_empty());
assert_eq!(generation.snapshot(), snapshot);

// Hermeticity: Module payloads ARE the module path (verified against ingest),
// so this is the only assertion protecting the /project/ rewrite.
// Do NOT use `!payload.contains(env!("CARGO_MANIFEST_DIR"))` -- that is the
// RUST crate's path, while the leak to catch is the TypeScript host path.
// A payload of /Users/<someone>/Strata/examples/medium/src/foo.ts does not
// contain the crate path, so that guard passes while the leak ships. It is
// also baked in at compile time, making it machine-dependent.
assert!(
    snapshot
        .nodes
        .iter()
        .filter(|n| n.kind == "Module")
        .all(|n| n.payload.starts_with("/project/")),
    "module payload escaped the /project/ rewrite"
);
```

Expect roughly 1282 nodes and 614 references from the current `examples/medium` (25 `.ts` files). Do not assert an exact node count; source additions to `examples/medium` should update the fixture without weakening the real-corpus gate.

`vitest.config.ts` imports `vitest/config`, which is unresolvable in the in-memory program. This does not throw — `tryResolve` returns early — it just yields fewer references. That is expected, not a failure.

- [ ] **Step 7: Run both sides**

Run: `pnpm --filter @strata/ingest test kernelSnapshot && cargo test -p strata-kernel --all-features --test examples_medium_fixture`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ingest crates/strata-kernel/tests/fixtures crates/strata-kernel/tests/examples_medium_fixture.rs
git commit -m "feat(kernel): export real TypeScript graphs for the Rust kernel"
```

---

### Task 7: Process-crash boundaries and concurrent immutable readers

**Files:**
- Modify: `crates/strata-kernel/Cargo.toml`
- Create: `crates/strata-kernel/src/bin/redb_spike.rs`
- Create: `crates/strata-kernel/tests/crash_recovery.rs`
- Create: `crates/strata-kernel/tests/concurrent_readers.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`

**Interfaces:**
- Consumes: real snapshot fixture, `Kernel::publish`, `Kernel::issue_fence`, `Kernel::open`, `Kernel::open_read_only`, `Kernel::snapshot`, `GraphGeneration::references_to`, `digest_of`, and `tests/common/mod.rs`.
- Produces: `PublishFailpoint` and `Kernel::publish_with_failpoint`, both behind the `spike-testing` feature and never on `DurableStore`; JSON `inspect` output.

- [ ] **Step 1: Write the failing child-process crash test**

Use `env!("CARGO_BIN_EXE_redb-spike")` and a temp database. **Every failpoint aborts** — `std::process::abort()`, never `exit(1)`. This matters: `exit(1)` runs destructors and cleanly drops the redb `Database`, which is a graceful shutdown, not a crash, and would make `afterRedbCommitBeforeMemoryPublish` prove nothing. (An earlier draft described three of these as "exits non-zero" while the implementation step said `abort()`; abort is correct.)

- `beforeRedbTransaction` → child aborts; recovery is generation 0.
- `insideRedbTransaction` → child aborts with an open write transaction; recovery is generation 0.
- `afterRedbCommitBeforeMemoryPublish` → child aborts; recovery is generation 1.
- `afterMemoryPublish` → child aborts; recovery is generation 1.

For each case assert **all** of the following. The generation alone is not sufficient evidence: a successful, non-crashing publish also yields generation 1, so the last two cases cannot otherwise distinguish "the failpoint fired at the right boundary" from "the failpoint was never wired up at all".

```rust
// The child must have died by SIGABRT, not exited.
// abort() => code() is None and signal() is Some(6).
use std::os::unix::process::ExitStatusExt;
assert_eq!(status.code(), None, "child exited instead of aborting");
assert_eq!(status.signal(), Some(6), "child did not die by SIGABRT");
// It must not have printed a success object.
assert!(stdout.trim().is_empty(), "aborting child emitted success JSON: {stdout}");
```

After each child abort, invoke `redb-spike inspect` (which uses `Kernel::open_read_only`, so it neither bumps the epoch nor needs a write transaction) and assert its JSON reports the expected generation, and that the generation's digest equals the value stored in `DIGESTS`. Comparing `inspect`'s digest against an independently replayed `Kernel::open` — as the original step said — compares two runs of the same replay code and agrees by construction even when both are wrong; the persisted digest is the only independent expected value.

Assert the epoch behaves across the crash: `inspect` must report the same epoch twice in a row, and a subsequent authoritative `Kernel::open` must report exactly one higher.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --all-features --test crash_recovery`
Expected: FAIL because the binary and failpoints do not exist.

- [ ] **Step 3: Implement the spike binary**

Support these exact commands:

```text
redb-spike seed --db <path> --snapshot <path>
redb-spike inspect --db <path>
redb-spike make-rename-publication --snapshot <path> --out <path>
redb-spike publish --db <path> --publication <path> [--failpoint <name>]
redb-spike measure --db <path> --snapshot <path> --publication <path> --iterations <n>
```

Specify the two output objects explicitly rather than leaving them to the implementer — Task 7 and Task 8 assert against these fields:

```jsonc
// inspect (uses Kernel::open_read_only: no epoch bump, no write txn)
{ "generation": 2, "digest": "…", "serviceEpoch": 3,
  "snapshotGeneration": 1, "replayedOperations": 1,
  "nodeCount": 1282, "referenceCount": 614 }

// measure -- re-seeds from --snapshot, so it owns the seed and recovery
// numbers Task 8 asks for; PublicationReport carries none of them.
{ "iterations": 100, "nodeCount": 1282, "referenceCount": 614,
  "redbFileBytes": 0, "seedMs": 0, "recoveryMs": 0, "replayedOperations": 0,
  "applyNs":            { "p50": 0, "p95": 0, "max": 0 },
  "persistenceNs":      { "p50": 0, "p95": 0, "max": 0 },
  "memoryPublishNs":    { "p50": 0, "p95": 0, "max": 0 },
  "criticalSectionNs":  { "p50": 0, "p95": 0, "max": 0 },
  "generation": 100, "digest": "…" }
```

Add the binary target to `crates/strata-kernel/Cargo.toml` in this task:

```toml
[[bin]]
name = "redb-spike"
path = "src/bin/redb_spike.rs"
```

All successful commands print one JSON object to stdout. Errors print to stderr and exit 1. Crash failpoints call `std::process::abort()` at the named boundary; they run only when the binary receives an explicit `--failpoint`.

**An unrecognized `--failpoint` value must be a hard error naming the accepted values.** There is no `clap` dependency, so parsing is hand-rolled across five subcommands and six flags; a `_ => PublishFailpoint::None` fallback or a typo would silently produce a clean success, generation 1, and a green crash test. Reject unknown flags and unknown subcommands the same way. Parse into an explicit struct per subcommand rather than scanning `args()` inline.

`make-rename-publication` reads the real fixture and builds the affected-node set **through the reference closure**, not a corpus-wide string match: resolve the declaration's name Identifier, then take `GraphGeneration::references_to(declaration_identifier_id)` and include those use sites. Task 2 already builds this index, and the design calls `rename_symbol` "wide reference-closure inference" — that closure is precisely why it is one of the two proof operations. A `text == "User"` match would sweep in any unrelated identifier named `User` (a shadowed local, a distinct type in another module, an import specifier for a different symbol) while wearing the `RenameSymbol` label in the durable operation log.

It changes only the matched Identifier payloads' `text` to `Account`, preserving `offset` — which mirrors real product semantics: `packages/store/src/rename.ts` only updates identifier payload text, and statement payloads keep the old text while `render` splices at offsets. It writes one `Publication` with `change_set_id`, a single-element `operations` vec (actor `redb-spike`, kind `RenameSymbol`, reasoning `real-corpus atomic publication proof`), a single-element `tickets` vec (state `committed`), a single-element `events` vec (kind `IntentCommitted`), and resource key `symbol:User`. It refuses an empty affected-node set and writes through `--out`; it never prints the publication into a shell redirection.

> The ticket is written in a terminal state with no prior state, so this proves the write transaction *spans* the ticket table — not that any ticket state machine works. Do not let the report imply ticket-lifecycle coverage.

The generated publication uses a zero-valued placeholder `FenceClaim` whose map contains only `symbol:User`. The `publish` command opens the authoritative kernel, extracts those resource keys, calls `issue_fence`, and replaces the placeholder before publishing. The `measure` command repeats that fence issuance for every iteration. Neither command accepts a client-supplied epoch/token as authority.

Define the failpoint enum exactly:

```rust
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishFailpoint {
    None,
    BeforeRedbTransaction,
    InsideRedbTransaction,
    AfterRedbCommitBeforeMemoryPublish,
    AfterMemoryPublish,
}
```

Refactor `Kernel::publish` into a private `publish_inner(publication, failpoint)` so production `publish` always uses `PublishFailpoint::None`. Expose `#[doc(hidden)] pub fn publish_with_failpoint` on `Kernel` only, gated `#[cfg(feature = "spike-testing")]` (declared in Task 1's manifest; every cargo command in this plan already passes `--all-features`). Do **not** expose it on `DurableStore`: a public failpoint publish on the store lets any in-process caller write canonical storage while bypassing kernel authority and in-memory publication — which is the exact failure mode of design acceptance item 12 ("no client or Node worker can mutate canonical storage outside the kernel"). It costs nothing to keep the boundary now and is expensive to reclaim once the service wrapper exists.

The inside-transaction failpoint must abort after all redb inserts but before `write_txn.commit()`. The after-commit failpoint must abort before acquiring the in-memory write lock.

On macOS, `abort()` triggers the crash reporter (`ReportCrash`), which adds seconds of latency and writes core dumps across 4 failpoints × 5 repeat runs. This is expected noise, not a failure.

- [ ] **Step 4: Write the concurrent-reader test**

Seed the real fixture. Spawn eight reader threads. Each repeatedly clones `kernel.snapshot()` while the main thread publishes 25 sequential deltas (routing each through the fence helper from Task 5).

The original assertion — "every observed `(generation, digest)` pair is one of the 26 fully computed pairs" — **cannot fail, and must not be the gate.** `digest` is a field of `GraphGeneration` computed at construction, and `snapshot()` clones one `Arc` to one immutable struct, so the two values are fields of a single allocation and agree by construction. That assertion would pass under a `Mutex`, an `ArcSwap`, or an outright data race on the `Arc` pointer. It proves the struct has two fields.

Assert these instead:

1. **Recompute the digest at read time** with `digest_of(&observed.snapshot())` and compare it to the observed `generation.digest()` field. This is the property that actually matters: it catches in-place mutation of an already-published generation, which the field comparison cannot see. Call the public `digest_of` — a test that reimplements the SHA-256/hex encoding can disagree with the implementation and prove nothing.
2. **The observed generations must span the publish window.** Record the union of observed generations and assert it contains at least two distinct values, and specifically both 0 and 25. Without this, readers that all finish before the first publish (or start after the last) observe a single generation and pass, having proven nothing. Make both endpoints deterministic rather than timing-dependent, since Step 5 runs this five times and expects every run to pass: hold readers at a barrier until after they take one mandatory sample (guaranteeing generation 0), and have them loop until the publisher sets a "publishing complete" flag, then take one mandatory final sample (guaranteeing generation 25).
3. Every observed snapshot is internally consistent: no missing nodes, no dangling references.

Add the Kernel-level immutable-reader test that nothing currently covers — Task 2 proves this for `GraphGeneration` in isolation, but never through `Kernel`:

```rust
// Hold a reader across a publish and prove the published generation was not
// mutated underneath it -- content, not just the generation number.
let held = kernel.snapshot();
let before = held.node(&some_id).unwrap().clone();
kernel
    .publish(&fenced_kernel_publication(&kernel, &resources, "held-reader"))
    .unwrap();
assert_eq!(held.generation(), 0);
assert_eq!(held.digest(), digest_of_generation_0);
assert_eq!(held.node(&some_id).unwrap(), &before);
```

- [ ] **Step 5: Run the crash and reader tests repeatedly**

Run:

```bash
cargo test -p strata-kernel --all-features --test crash_recovery -- --nocapture
for i in 1 2 3 4 5; do cargo test -p strata-kernel --all-features --test concurrent_readers; done
```

Expected: every run passes; aborted child processes do not abort the test runner.

- [ ] **Step 6: Commit**

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests
git commit -m "test(kernel): prove crash recovery and immutable readers"
```

---

### Task 8: Spike report, full verification, and decision gate

**Files:**
- Create: `docs/spikes/2026-07-13-redb-kernel-spike.md`
- Modify: `decisions.md`
- Modify: `docs/product-roadmap.md`

**Interfaces:**
- Consumes: all spike commands and acceptance tests.
- Produces: an evidence-backed pass/fail decision. A pass unlocks a separate coordination-scheduler plan; a failure stops that plan.

- [ ] **Step 1: Create the real-corpus publication input**

Run the helper implemented in Task 7:

```bash
cargo run -p strata-kernel --features spike-testing --bin redb-spike -- \
  make-rename-publication \
  --snapshot crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json \
  --out target/examples-medium.rename-publication.json
```

Expected: exit 0 and a JSON summary with a non-zero `affectedNodeCount`.

- [ ] **Step 2: Run the complete key-free gate**

Run:

```bash
pnpm --filter @strata/ingest build
pnpm --filter @strata/ingest test
cargo fmt --all -- --check
cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings
cargo test -p strata-kernel --all-features
pnpm -r build
pnpm -r test
```

Expected: all commands pass. The existing pnpm suite proves the isolated Rust work did not regress the SQLite product.

- [ ] **Step 3: Measure without setting a performance pass threshold**

Run 100 publications through `redb-spike measure` using `target/examples-medium.rename-publication.json`.

`measure` owns its database end to end: it takes `--snapshot`, seeds a fresh file at `--db` itself (that is where its `seedMs`/`recoveryMs` numbers come from), and **requires `--db` to not already exist**, erroring otherwise. Do not pre-seed the path — `DurableStore::seed` refuses a second seed by design, so a pre-seeded file makes `measure` fail. Give each of the three runs its own `--db` path (`target/redb-spike.run1.redb`, `.run2`, `.run3`).

The measure command must rewrite, per iteration: base generation, operation/event IDs, event sequence, **`event.graph_generation`**, and idempotency key — while preserving the same real affected-node set, and issuing a fresh fence each iteration. `event.graph_generation` is easy to miss and `DurableStore::publish` validates it as `current_generation + 1`, so omitting it fails on iteration 2 of 100.

The fresh-database-per-run rule above is why `measure` re-seeds rather than reusing a file: if the database persisted across runs and idempotency keys are deterministic, runs 2 and 3 would hit the already-published early return for all 100 iterations and report `p50 ≈ 0` — and "do not average away a slow run" then gives false comfort over two garbage objects.

Record:

- node/reference counts;
- redb file bytes;
- seed duration;
- recovery duration;
- replayed operation count;
- `apply_ns` p50/p95/max;
- publication persistence p50/p95/max;
- in-memory generation-swap p50/p95/max;
- `critical_section_ns` p50/p95/max;
- resulting generation and digest.

Run the command three times and retain all three JSON outputs. Do not average away a slow run and do not compare against SQLite in this spike.

- [ ] **Step 4: Write the spike report with observed values**

`docs/spikes/2026-07-13-redb-kernel-spike.md` must contain:

1. Exact commit and toolchain versions.
2. Commands run.
3. The three unedited measurement JSON objects.
4. A twelve-row table mapping every deterministic acceptance item in the approved design to its test and result, using **exactly three labels**:
   - `pass — <test name>`, only with a named test that could have failed;
   - `not part of redb spike — gated by approved follow-on plan`, only for items the scheduler owns;
   - `not proven by this spike — <one-line reason>`, for everything else.

   The third label is mandatory and was missing. Without it four rows have no honest label and will drift into `pass`:
   - **#7** (queued tickets and unacknowledged events survive restart) is a durability item, not a scheduler item — but this spike never persists a *queued* ticket, never restarts with one pending, and has no acknowledgement concept. The `TICKETS`/`EVENTS` tables existing and surviving a reopen is **not** this property. This row is the most likely to be wrongly marked `pass`.
   - **#10** (composite change set) — the v1 schema now expresses it, but nothing validates two operations together; that is scheduler work.
   - **#11** (duplicate event delivery harmless via IDs and cursors) — publication idempotency is a different property; there is no delivery and no cursor.
   - **#12** (no client or worker mutates canonical storage outside the kernel) — no clients or workers exist.
5. Crash-boundary outcomes, stating plainly: **process-level atomicity proven at four boundaries; fsync ordering and torn-write recovery NOT tested** and inherited from redb on trust, because `abort()` preserves the OS page cache and cannot distinguish fsync'd from buffered writes.
6. Gate-by-gate results against the design's six spike gates, with these three stated honestly rather than as unqualified passes:
   - **Gate 1** (atomically persist delta, operation, event, ticket transition, fencing update): partial — there is no ticket *transition*, only a terminal-state upsert.
   - **Gate 3** (rebuild from snapshot plus later operations): report as **snapshot + delta replay**. `OPERATIONS` is written but never read by any recovery path; its only reader is a test assertion.
   - **Gate 6** (report publication-critical-section latency separately from validation and agent time): **not meetable by this spike** — there is no validation and no agent, so there is nothing to report it *separately from*. Report `critical_section_ns` and note that the gate's comparative intent is unmet until the validation bridge exists.
7. Final `PASS` only if atomic publication, recovery/replay **including the persisted-digest comparison**, concurrent readers, and stale fencing **including the service-epoch rejection** all passed.

> Before writing `PASS` on any row, apply the standing test: **could this have passed while the property it names is false?** Five gates originally failed that test (`decisions.md`, 2026-07-14). A vacuous gate on a stop-gate spike does not merely fail to inform — it manufactures evidence for unblocking the scheduler.

- [ ] **Step 5: Record the decision**

If PASS, prepend a `decisions.md` entry titled `Redb kernel spike passes; coordination scheduler unblocked` and check only the roadmap's `Redb spike gate` item.

If FAIL, prepend an entry titled `Redb kernel spike falsified: <failed property>` containing the failing command/output, leave the roadmap unchecked, and stop. Do not select another engine in the same task.

- [ ] **Step 6: Final repository verification**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only the spike report, decision, and intended roadmap update remain uncommitted.

- [ ] **Step 7: Commit**

```bash
git add docs/spikes/2026-07-13-redb-kernel-spike.md decisions.md docs/product-roadmap.md
git commit -m "docs(kernel): record redb spike result"
```

---

## Follow-on plan boundaries

Do not include these in this execution:

1. **Coordination scheduler plan:** typed intent analyzers, inferred read/write/validation/reservation scopes, all-or-ticket queues, FIFO aging, ready offers, durable event cursors, and composite change sets.
2. **TypeScript validation bridge plan:** candidate-generation rendering, worker protocol, scoped validation, result binding, worker crash handling, and `rename_symbol`/`add_parameter` intent analyzers.
3. **Multi-client service plan:** network transport, authentication boundary, reconnect/event replay, remote-latency injection, and live agent tool gateway.
4. **Paradigm experiment plan:** deterministic concurrency matrix first, then the budgeted Strata-vs-worktrees two-agent comparison.

Write the coordination scheduler plan only after Task 8 records a PASS.
