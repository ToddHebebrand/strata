# Redb Kernel Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a Rust memory-native graph backed by redb can atomically publish graph deltas with operation/event/ticket/fencing state, recover from process crashes, serve immutable concurrent readers, and load a real `examples/medium` graph exported by the existing TypeScript ingest pipeline.

**Architecture:** Add an isolated `strata-kernel` Rust workspace member. The kernel holds immutable graph generations in memory and uses redb only for snapshots, ordered deltas, durable events/tickets, service epochs, and fencing counters. Existing TypeScript ingest exports a versioned JSON snapshot; the current SQLite runtime and all twenty production tools remain unchanged.

**Tech Stack:** Rust 1.89+, redb 4.1.0, serde/serde_json, sha2, uuid, anyhow, tempfile; existing TypeScript 5.8, pnpm 10.26.2, and Vitest 3.2.

## Global Constraints

- This plan is the redb stop gate only. Do not build the scheduler, remote service, live agent integration, or port mutation tools.
- Keep the existing SQLite product path byte-for-byte functional; no current store schema or transaction behavior changes.
- Use `examples/medium` for the cross-language acceptance path. Small Rust fixtures are allowed only for focused unit tests.
- No model/API calls and no keyed benchmark runs.
- Redb commit must complete before the new in-memory generation is published.
- Every persisted payload carries `schemaVersion: 1`; Rust uses serde `camelCase` field names matching TypeScript.
- The operation log plus snapshots reconstruct canonical state. Recovery must verify the reconstructed generation digest.
- Opening the authoritative store increments a durable service epoch. Tokens from a previous epoch can never publish.
- Publication accepts one complete `Publication` value and persists its delta, operation, event, ticket transition, generation pointer, and consumed fence in one redb write transaction.
- The spike records latency but has no absolute speed threshold. Correctness gates are dispositive.
- If a redb durability/recovery/fencing gate fails, stop and append the failure to `decisions.md` before considering LMDB, RocksDB, or a custom WAL.

## File Structure

### Repository integration

- Create `Cargo.toml` — root Rust workspace containing `crates/strata-kernel`.
- Create `rust-toolchain.toml` — pin Rust 1.89.0, the minimum supported by redb 4.1.0.
- Modify `.gitignore` — ignore Cargo `target/` and local `*.redb` spike files.
- Modify `package.json` — add explicit `kernel:build` and `kernel:test` scripts; do not add Cargo to existing pnpm recursive build/test yet.

### Rust kernel

- Create `crates/strata-kernel/Cargo.toml` — crate dependencies and `redb-spike` binary.
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
- Produces: `NodeRecord`, `ReferenceRecord`, `GraphSnapshot`, `GraphChange`, `GraphDelta`, `OperationRecord`, `TicketRecord`, `EventRecord`, `FenceClaim`, and `Publication`.

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
```

- [ ] **Step 2: Run the test and verify the Rust workspace does not exist yet**

Run: `cargo test -p strata-kernel --test model_roundtrip`
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

[dependencies]
anyhow = "1.0"
redb = "4.1.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
sha2 = "0.10"
uuid = { version = "1.0", features = ["serde", "v4"] }

[dev-dependencies]
tempfile = "3.0"
```

Add `/target/` and `*.redb` to `.gitignore`. Add these root scripts without changing `build` or `test`:

```json
"kernel:build": "cargo build -p strata-kernel",
"kernel:test": "cargo test -p strata-kernel"
```

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    pub schema_version: u32,
    pub idempotency_key: String,
    pub delta: GraphDelta,
    pub operation: OperationRecord,
    pub ticket: TicketRecord,
    pub event: EventRecord,
    pub fence: FenceClaim,
}
```

Re-export these types and `SCHEMA_VERSION` from `lib.rs`.

- [ ] **Step 5: Format and run the model test**

Run: `cargo fmt --all && cargo test -p strata-kernel --test model_roundtrip`
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
- Produces: `GraphGeneration::from_snapshot`, `GraphGeneration::apply`, `GraphGeneration::snapshot`, `GraphGeneration::digest`, `GraphGeneration::node`, `GraphGeneration::references_to`.

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
            child_index: Some(0),
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

Run: `cargo test -p strata-kernel --test graph_generation`
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

`from_snapshot` must reject non-v1 input, duplicate node IDs, duplicate `from_node_id` references, and references with missing endpoints. `apply` must reject the wrong base generation, apply all changes to cloned maps, rebuild `references_to`, validate endpoints, increment generation by exactly one, and compute SHA-256 over `serde_json::to_vec(snapshot())`. `snapshot()` returns nodes and references in deterministic key order.

Use `anyhow::bail!` messages containing the bad schema, duplicate ID, missing endpoint, or base generation so tests can assert the cause.

- [ ] **Step 4: Add reference-index assertions**

Extend the test with two nodes and one reference. Assert `references_to("decl")` returns the use-site reference, then delete it with `DeleteReference` and assert the old generation still has it while the new generation does not.

- [ ] **Step 5: Run graph tests and clippy**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel --test graph_generation`
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
- Produces: `DurableStore::create`, `DurableStore::open`, `DurableStore::seed`, `DurableStore::publish`, `DurableStore::current_generation`, `DurableStore::operation`, `DurableStore::ticket`, `DurableStore::event`, `DurableStore::was_published`.

- [ ] **Step 1: Write the failing atomic-publication test**

Create a temp redb file, seed generation 0, issue a publication changing one node, close/reopen, and assert all six durable facts agree:

```rust
assert_eq!(reopened.current_generation().unwrap(), 1);
assert_eq!(reopened.operation(1).unwrap().unwrap(), publication.operation);
assert_eq!(
    reopened.ticket(&publication.ticket.ticket_id).unwrap().unwrap(),
    publication.ticket
);
assert_eq!(reopened.event(1).unwrap().unwrap(), publication.event);
assert!(reopened.was_published(&publication.idempotency_key).unwrap());
assert_eq!(reopened.delta(1).unwrap().unwrap(), publication.delta);
```

Add a second test that submits the same idempotency key twice. The second call must return `PublishOutcome::AlreadyPublished { generation: 1 }` and must not append another event or operation.

Define the outcome exactly:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishOutcome {
    Published { generation: u64 },
    AlreadyPublished { generation: u64 },
}
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test storage_atomic`
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

const CURRENT_GENERATION: &str = "current_generation";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";
const SERVICE_EPOCH: &str = "service_epoch";
```

Encode structured values with `serde_json::to_vec`. Encode metadata `u64` values as `to_le_bytes()` and reject any metadata value whose length is not eight.

- [ ] **Step 4: Implement seed and publication**

`seed` must create every table in one write transaction, require generation 0, store the initial snapshot under key 0, set generation/event sequence/epoch to zero, and refuse a second seed.

`publish` must:

1. Open one redb write transaction.
2. Return `AlreadyPublished` if the idempotency key exists.
3. Require `delta.base_generation == current_generation`.
4. Require `event.sequence == current_event_sequence + 1` and `event.graph_generation == current_generation + 1`.
5. Write the operation and delta under `current_generation + 1`.
6. Upsert the ticket and event.
7. Record idempotency key → new generation.
8. Update current generation and event sequence.
9. Commit once.

Do not mutate in-memory graph state in this module.

- [ ] **Step 5: Prove failed validation leaves every table unchanged**

Add table-count/current-generation helpers under `#[cfg(test)]`. Submit a publication with the wrong event sequence and assert generation, operation count, event count, ticket, and idempotency count are unchanged.

- [ ] **Step 6: Run storage tests**

Run: `cargo fmt --all && cargo test -p strata-kernel --test storage_atomic`
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
- Produces: `Kernel::create`, `Kernel::open`, `Kernel::snapshot`, `Kernel::publish`, `Kernel::write_snapshot`, `RecoveryReport`, and `DurableStore::begin_service_epoch`.

- [ ] **Step 1: Write failing recovery tests**

Test this sequence:

1. Create and seed generation 0.
2. Publish deltas for generations 1 and 2.
3. Write a snapshot at generation 1.
4. Drop the kernel.
5. Reopen and recover snapshot 1 plus delta 2.
6. Assert generation, digest, nodes, and references equal the pre-drop generation 2.

Add corruption tests for a missing delta and a replayed delta whose base generation does not match. Both must fail opening with an error containing the expected generation.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test recovery`
Expected: FAIL because `Kernel` and recovery APIs do not exist.

- [ ] **Step 3: Implement latest-snapshot lookup and ordered delta scan**

Add:

```rust
pub fn latest_snapshot(&self) -> Result<GraphSnapshot>;
pub fn deltas_after(&self, generation: u64) -> Result<Vec<(u64, GraphDelta)>>;
pub fn write_snapshot(&self, snapshot: &GraphSnapshot) -> Result<()>;
```

`deltas_after` must iterate redb keys in ascending order, require no generation gaps through `current_generation`, and deserialize every value before returning.

- [ ] **Step 4: Implement authoritative `Kernel` publication ordering**

`Kernel` owns:

```rust
pub struct Kernel {
    store: DurableStore,
    live: RwLock<Arc<GraphGeneration>>,
    publish_lock: Mutex<()>,
    service_epoch: u64,
}
```

Define the report types exactly:

```rust
pub struct RecoveryReport {
    pub snapshot_generation: u64,
    pub replayed_operations: u64,
    pub generation: u64,
    pub digest: String,
    pub service_epoch: u64,
}

pub struct PublicationReport {
    pub generation: u64,
    pub digest: String,
    pub persistence_ns: u128,
    pub memory_publish_ns: u128,
    pub already_published: bool,
}
```

`Kernel::open` increments the durable service epoch, loads the latest snapshot, applies later deltas, compares the result generation with durable metadata, and returns `RecoveryReport { snapshot_generation, replayed_operations, generation, digest, service_epoch }`.

Implement `DurableStore::begin_service_epoch()` here as one redb write transaction that reads `SERVICE_EPOCH`, increments it with checked arithmetic, stores it, commits, and returns the new value. `Kernel::create` and every authoritative `Kernel::open` call it exactly once.

`Kernel::publish` must:

1. Hold `publish_lock`.
2. Query the idempotency table before applying the delta. If the key already maps to a committed generation, return the current generation/digest with `already_published: true` and do not apply or publish anything.
3. Clone the current `Arc<GraphGeneration>`.
4. Build the next generation with `GraphGeneration::apply`.
5. Call `DurableStore::publish`. Keep the storage-level idempotency check as the atomic race guard.
6. Only after redb commits, replace `live` with the new `Arc`.
7. Return `PublicationReport` containing persistence and in-memory-swap nanoseconds with `already_published: false`.

- [ ] **Step 5: Run recovery and existing tests**

Run: `cargo fmt --all && cargo test -p strata-kernel`
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
- Consumes: `FenceClaim.resource_tokens` and the service epoch created by `Kernel::open`.
- Produces: `Kernel::issue_fence` and `Kernel::publish` rejection of stale/missing claims.

- [ ] **Step 1: Write failing fencing tests**

Cover:

```rust
let resources = ["symbol:User".to_string()];
let first = kernel.issue_fence(&resources).unwrap();
let newer = kernel.issue_fence(&resources).unwrap();
assert!(
    kernel
        .publish(publication_with(first, "first-attempt"))
        .unwrap_err()
        .to_string()
        .contains("stale fence")
);
assert!(
    kernel
        .publish(publication_with(newer, "newer-attempt"))
        .is_ok()
);
```

Define a local `publication_with(claim: FenceClaim, idempotency_key: &str) -> Publication` helper at the top of the test using the complete model from Task 1; give each invocation a distinct idempotency key unless the test is explicitly exercising idempotency.

Then reopen the kernel, assert `service_epoch` increased by one, and prove a claim from the previous process is rejected even when its resource token is numerically current.

Add an all-or-nothing test: issuing a fence for `["symbol:User", "node:caller"]` increments both tokens in one redb transaction and returns both; injected failure before commit increments neither.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test fencing`
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

Call `verify_fence_in_write_txn` inside the same `DurableStore::publish` transaction. Check the idempotency table first so an already-committed retry returns `AlreadyPublished` even after a service restart. For a new publication, require at least one resource token, require every claimed token to equal its current `FENCES` counter, and require every token to be greater than its `CONSUMED_FENCES` value. Write each consumed token to `CONSUMED_FENCES` in the same transaction as the delta, operation, event, ticket, idempotency key, and generation pointer. This makes a fence one-use: the same claim cannot authorize a different publication.

- [ ] **Step 4: Run fencing and full kernel tests**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel`
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

Run: `pnpm --filter @strata/ingest test -- kernelSnapshot`
Expected: FAIL because `toKernelSnapshot` is not exported.

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
    nodes: batch.allNodes
      .map(({ id, kind, parentId, childIndex, payload }) => ({
        id, kind, parentId, childIndex, payload
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    references: batch.references
      .map(({ fromNodeId, toNodeId, kind }) => ({ fromNodeId, toNodeId, kind }))
      .sort((a, b) =>
        a.fromNodeId.localeCompare(b.fromNodeId) ||
        a.toNodeId.localeCompare(b.toNodeId) ||
        a.kind.localeCompare(b.kind)
      )
  };
}
```

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
assert!(snapshot.nodes.iter().all(|n| !n.payload.contains(env!("CARGO_MANIFEST_DIR"))));
assert_eq!(generation.snapshot(), snapshot);
```

Do not assert an exact node count; source additions to `examples/medium` should update the fixture without weakening the real-corpus gate.

- [ ] **Step 7: Run both sides**

Run: `pnpm --filter @strata/ingest test -- kernelSnapshot && cargo test -p strata-kernel --test examples_medium_fixture`
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
- Consumes: real snapshot fixture, `Kernel::publish`, and `Kernel::open`.
- Produces: `PublishFailpoint` available only to the spike binary/tests and JSON `inspect` output.

- [ ] **Step 1: Write the failing child-process crash test**

Use `env!("CARGO_BIN_EXE_redb-spike")` and a temp database. For each failpoint:

- `beforeRedbTransaction` → child exits non-zero; recovery is generation 0.
- `insideRedbTransaction` → child aborts with an open write transaction; recovery is generation 0.
- `afterRedbCommitBeforeMemoryPublish` → child exits non-zero; recovery is generation 1.
- `afterMemoryPublish` → child exits non-zero; recovery is generation 1.

After each child exit, invoke `redb-spike inspect` and assert its JSON contains the expected generation and the digest returned by an independently replayed `Kernel::open`.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test crash_recovery`
Expected: FAIL because the binary and failpoints do not exist.

- [ ] **Step 3: Implement the spike binary**

Support these exact commands:

```text
redb-spike seed --db <path> --snapshot <path>
redb-spike inspect --db <path>
redb-spike make-rename-publication --snapshot <path> --out <path>
redb-spike publish --db <path> --publication <path> [--failpoint <name>]
redb-spike measure --db <path> --publication <path> --iterations <n>
```

Add the binary target to `crates/strata-kernel/Cargo.toml` in this task:

```toml
[[bin]]
name = "redb-spike"
path = "src/bin/redb_spike.rs"
```

All successful commands print one JSON object to stdout. Errors print to stderr and exit 1. Crash failpoints call `std::process::abort()` at the named boundary; they run only when the binary receives an explicit `--failpoint`.

`make-rename-publication` reads the real fixture, finds every `Identifier` node whose payload JSON has `text == "User"`, changes only that payload text to `Account` while preserving `offset`, and writes one `Publication` with actor `redb-spike`, kind `RenameSymbol`, reasoning `real-corpus atomic publication proof`, ticket state `committed`, event kind `IntentCommitted`, and resource key `symbol:User`. It refuses an empty affected-node set and writes through `--out`; it never prints the publication into a shell redirection.

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

Refactor `Kernel::publish` into a private `publish_inner(publication, failpoint)` so production `publish` always uses `PublishFailpoint::None`. Expose `#[doc(hidden)] pub fn publish_with_failpoint` on `Kernel` and `DurableStore` solely because the package binary is a separate Rust crate target; no normal caller uses it. The inside-transaction failpoint must abort after all redb inserts but before `write_txn.commit()`. The after-commit failpoint must abort before acquiring the in-memory write lock.

- [ ] **Step 4: Write the concurrent-reader test**

Seed the real fixture. Spawn eight reader threads. Each repeatedly clones `kernel.snapshot()` and records `(generation, digest)` while the main thread publishes 25 sequential deltas. Assert every observed pair is one of the 26 fully computed generation/digest pairs; no reader sees a generation paired with another generation's digest, missing nodes, or dangling references.

- [ ] **Step 5: Run the crash and reader tests repeatedly**

Run:

```bash
cargo test -p strata-kernel --test crash_recovery -- --nocapture
for i in 1 2 3 4 5; do cargo test -p strata-kernel --test concurrent_readers; done
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
cargo run -p strata-kernel --bin redb-spike -- \
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
cargo clippy -p strata-kernel --all-targets -- -D warnings
cargo test -p strata-kernel
pnpm -r build
pnpm -r test
```

Expected: all commands pass. The existing pnpm suite proves the isolated Rust work did not regress the SQLite product.

- [ ] **Step 3: Measure without setting a performance pass threshold**

Seed `target/redb-spike.redb` from the real fixture and run 100 publications through `redb-spike measure` using `target/examples-medium.rename-publication.json`. The measure command must rewrite each iteration's base generation, operation/event IDs, event sequence, and idempotency key while preserving the same real affected-node set. Record:

- node/reference counts;
- redb file bytes;
- seed duration;
- recovery duration;
- replayed operation count;
- publication persistence p50/p95/max;
- in-memory generation-swap p50/p95/max;
- resulting generation and digest.

Run the command three times and retain all three JSON outputs. Do not average away a slow run and do not compare against SQLite in this spike.

- [ ] **Step 4: Write the spike report with observed values**

`docs/spikes/2026-07-13-redb-kernel-spike.md` must contain:

1. Exact commit and toolchain versions.
2. Commands run.
3. The three unedited measurement JSON objects.
4. A twelve-row table mapping every deterministic acceptance item in the approved design to its test and result. Items belonging to the later scheduler must read `not part of redb spike — gated by approved follow-on plan`, not `pass`.
5. Crash-boundary outcomes.
6. Final `PASS` only if atomic publication, recovery/replay, concurrent readers, and stale fencing all passed.

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
