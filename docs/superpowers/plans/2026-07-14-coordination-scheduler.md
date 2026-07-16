# Coordination Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, deterministic coordination scheduler to `strata-kernel` that accepts composite typed change sets, infers semantic scopes through a stable analyzer contract, queues overlapping work without partial reservations, issues fresh-state ready offers, survives restart, delivers at-least-once events, and atomically composes a claimed change-set transition with graph publication.

**Architecture:** The scheduler is a focused Rust layer inside `strata-kernel`. Pure scope analysis and queue selection operate over immutable graph generations; redb stores change sets, typed intents, tickets, ready offers, events, cursors, and queue counters; `Kernel` owns the in-memory scheduling projection and remains the only graph publisher. This plan uses deterministic Rust analyzers in tests to prove scheduler semantics. The next TypeScript validation-bridge plan will implement the real `rename_symbol` and `add_parameter` analyzers, candidate construction, rendering, and validation workers against these interfaces.

**Tech Stack:** Rust 1.89, redb 4.1.0, serde/serde_json, sha2, uuid, anyhow, tempfile; existing immutable `GraphGeneration`, fenced `Kernel`, and `examples/medium` fixture.

## Global Constraints

- This plan is the coordination-scheduler gate only. Do not build the Node validation bridge, network service, live agent gateway, or paradigm benchmark.
- Keep the existing SQLite product path and all twenty current TypeScript tools unchanged.
- The agent/client supplies typed intent parameters, never reservation keys, fencing tokens, scope fingerprints, or ready-offer authority.
- Scope inference is side-effect free and runs at submit, claim, and immediately before coordinated publication.
- Reservation acquisition is all-or-nothing. A queued change set never holds a subset of its semantic scope.
- Per-resource ordering is FIFO. Newer work may pass older work only when the complete reservation scopes are disjoint.
- Ready offers preserve queue priority for a bounded logical-time lease but are not commit authority.
- Service restart invalidates every ready offer and claim through the durable service epoch; reconstructable executing change sets return to `queued`.
- Events are durable, sequenced, at-least-once, and deduplicated by stable event ID plus a monotonic acknowledged cursor.
- A composite change set publishes one graph generation. Its graph delta, aggregate operation, change-set/ticket transitions, coordination events, digest, kernel-derived commit idempotency key, and issued-and-consumed fences commit in one redb write transaction.
- The default library API has no caller-supplied fence or raw-publication path. The old spike surface is isolated behind a non-default `redb-spike-api` feature used only by the spike binary and its legacy proof tests; future service code must never enable it.
- `publish_claimed` accepts an executing claim plus analyzer/candidate-builder traits. The kernel derives the operation, ticket transition, events, successor offers, commit idempotency key, and fences; callers cannot assemble a `Publication` or coordination envelope.
- Every candidate `GraphChange` must be contained by the fresh inferred write and reservation scope before publication. Structural integrity alone is not scheduling authority.
- Real operation semantics remain authoritative in TypeScript. Test analyzers in this plan may return deterministic scopes/deltas but must be defined in test modules, never as production semantic substitutes.
- Use `examples/medium` for the end-to-end scheduler acceptance harness. Toy graphs are allowed only for focused model/storage unit tests.
- No model/API calls and no keyed benchmark runs.
- The known pre-existing `extract_function` real-corpus verify test remains outside this plan; report it truthfully if `pnpm -r test` reproduces it.

## File Structure

### Coordination module

- Create `crates/strata-kernel/src/coordination/mod.rs` — public exports only.
- Create `crates/strata-kernel/src/coordination/model.rs` — typed intents, change sets, scopes, tickets, offers, claims, events, and outcomes.
- Create `crates/strata-kernel/src/coordination/analyzer.rs` — analyzer trait, canonical scope union, fingerprinting, and expansion classification.
- Create `crates/strata-kernel/src/coordination/durable.rs` — redb coordination tables and transaction-scoped transition helpers.
- Create `crates/strata-kernel/src/coordination/scheduler.rs` — pure all-or-nothing selection and per-resource FIFO/aging rules.
- Create `crates/strata-kernel/src/coordination/coordinator.rs` — `Kernel` lifecycle methods and in-memory scheduler projection.

### Existing kernel integration

- Modify `crates/strata-kernel/src/model.rs` — add internal candidate/commit records without adding caller-owned publication authority.
- Modify `crates/strata-kernel/src/storage.rs` — initialize coordination tables, share exact-width metadata decoding, and compose coordination/fence transitions into publication transactions.
- Modify `crates/strata-kernel/src/kernel.rs` — own/recover scheduler state and expose coordinated lifecycle methods.
- Modify `crates/strata-kernel/src/lib.rs` — export the stable coordination API.
- Modify `crates/strata-kernel/Cargo.toml` and `crates/strata-kernel/src/bin/redb_spike.rs` — isolate the legacy raw-publication surface behind `redb-spike-api`.

### Tests and evidence

- Add focused integration tests under `crates/strata-kernel/tests/coordination_*.rs`.
- Create `docs/spikes/2026-07-14-coordination-scheduler.md` — key-free acceptance evidence.
- Modify `decisions.md` and `docs/product-roadmap.md` only after the scheduler gate passes.

---

### Task 1: Versioned coordination domain model

**Files:**
- Create: `crates/strata-kernel/src/coordination/mod.rs`
- Create: `crates/strata-kernel/src/coordination/model.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Test: `crates/strata-kernel/tests/coordination_model.rs`

**Interfaces:**
- Consumes: `SCHEMA_VERSION` and existing graph node IDs.
- Produces: `IntentParameters`, `IntentRecord`, `ChangeSetRecord`, `InferredScope`, `CoordinationTicket`, `ReadyOffer`, `ClaimHandle`, `CoordinationEvent`, `EventCursor`, `SubmissionOutcome`, `ClaimOutcome`, and lifecycle enums.

- [ ] **Step 1: Write the failing serde and lifecycle model test**

Create a schema-v1 `ChangeSetRecord` containing both supported typed intents, a canonical scope, and a queued ticket. Assert JSON uses `schemaVersion`, `changeSetId`, `baseGeneration`, `reservationKeys`, `scopeFingerprint`, and camel-case enum tags; round-trip every public record. Also assert an intent cannot be constructed with a different `change_set_id` than its parent fixture.

```rust
use strata_kernel::{
    ChangeSetRecord, ChangeSetState, DynamicExpansionPolicy, IdempotencyClass,
    IntentParameters, IntentRecord, SCHEMA_VERSION,
};

#[test]
fn coordination_records_are_schema_v1_camel_case_and_round_trip() {
    let intent = IntentRecord {
        schema_version: SCHEMA_VERSION,
        intent_id: "intent:rename".into(),
        change_set_id: "change-set:1".into(),
        base_generation: 7,
        parameters: IntentParameters::RenameSymbol {
            declaration_id: "decl:User".into(),
            new_name: "Account".into(),
        },
    };
    let json = serde_json::to_string(&intent).unwrap();
    assert!(json.contains("\"schemaVersion\":1"));
    assert!(json.contains("\"changeSetId\":\"change-set:1\""));
    assert!(json.contains("\"type\":\"renameSymbol\""));
    assert_eq!(serde_json::from_str::<IntentRecord>(&json).unwrap(), intent);

    let state = ChangeSetState::Queued;
    assert_eq!(serde_json::to_string(&state).unwrap(), "\"queued\"");
    assert_eq!(
        DynamicExpansionPolicy::Requeue { max_expansions: 3 },
        serde_json::from_str(r#"{"type":"requeue","maxExpansions":3}"#).unwrap()
    );
    assert_eq!(IdempotencyClass::RequiresDecision, IdempotencyClass::RequiresDecision);
}
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_model`

Expected: FAIL because the coordination module and records do not exist.

- [ ] **Step 3: Implement the exact public model**

All records derive `Clone, Debug, PartialEq, Eq, Serialize, Deserialize` and use `#[serde(rename_all = "camelCase")]`. Enums with named fields also use `rename_all_fields = "camelCase"`.

```rust
pub enum IntentParameters {
    RenameSymbol { declaration_id: String, new_name: String },
    AddParameter {
        function_id: String,
        name: String,
        type_text: String,
        position: u32,
        default_value: Option<String>,
    },
}

pub enum ChangeSetState {
    Draft,
    Queued,
    Ready,
    Executing,
    Committed,
    NeedsDecision,
    Cancelled,
    Failed,
}

pub enum TicketState { Queued, Ready, Claimed, Completed, Cancelled, Failed }
pub enum CoordinationEventKind {
    IntentQueued,
    IntentReady,
    IntentNeedsDecision,
    IntentCommitted,
    IntentCancelled,
    IntentFailed,
    LeaseExpired,
    ScopeExpanded,
}
pub enum IdempotencyClass { ReplaySafe, RequiresDecision }
pub enum DynamicExpansionPolicy {
    Requeue { max_expansions: u32 },
    NeedsDecision,
}

pub struct ResourceVersion { pub resource_key: String, pub version: String }

pub struct InferredScope {
    pub read_set: Vec<ResourceVersion>,
    pub write_set: Vec<ResourceVersion>,
    pub validation_set: Vec<ResourceVersion>,
    pub reservation_keys: Vec<String>,
    pub scope_fingerprint: String,
    pub dynamic_expansion_policy: DynamicExpansionPolicy,
    pub idempotency_class: IdempotencyClass,
}

pub struct IntentRecord {
    pub schema_version: u32,
    pub intent_id: String,
    pub change_set_id: String,
    pub base_generation: u64,
    pub parameters: IntentParameters,
}

pub struct ChangeSetRecord {
    pub schema_version: u32,
    pub change_set_id: String,
    pub actor: String,
    pub reasoning: String,
    pub base_generation: u64,
    pub state: ChangeSetState,
    pub submission_idempotency_key: String,
    pub intent_ids: Vec<String>,
    pub inferred_scope: Option<InferredScope>,
    pub queue_sequence: Option<u64>,
    pub expansion_count: u32,
    pub blocking_change_set_id: Option<String>,
    pub committed_generation: Option<u64>,
}

pub struct CoordinationTicket {
    pub schema_version: u32,
    pub ticket_id: String,
    pub change_set_id: String,
    pub state: TicketState,
    pub scope_fingerprint: String,
    pub reservation_keys: Vec<String>,
    pub queue_sequence: u64,
    pub age_rounds: u64,
    pub ready_offer_id: Option<String>,
    pub active_claim_id: Option<String>,
}

pub struct ReadyOffer {
    pub schema_version: u32,
    pub offer_id: String,
    pub change_set_id: String,
    pub service_epoch: u64,
    pub graph_generation: u64,
    pub scope_fingerprint: String,
    pub claim_token: String,
    pub expires_at_tick: u64,
    pub blocking_event_sequence: Option<u64>,
}

pub struct ClaimHandle {
    pub claim_id: String,
    pub change_set_id: String,
    pub offer_id: String,
    pub service_epoch: u64,
    pub graph_generation: u64,
    pub scope_fingerprint: String,
    pub reservation_keys: Vec<String>,
}

pub struct CoordinationEvent {
    pub schema_version: u32,
    pub event_id: String,
    pub sequence: u64,
    pub kind: CoordinationEventKind,
    pub change_set_id: String,
    pub graph_generation: u64,
    pub payload_json: String,
}

pub struct EventCursor { pub client_id: String, pub acknowledged_sequence: u64 }
```

Define `SubmissionOutcome::{Ready { ticket, offer }, Queued { ticket }, Duplicate { change_set }}` and `ClaimOutcome::{Claimed(ClaimHandle), Requeued { ticket, event }, NeedsDecision { change_set, event }}` with camel-case serde. `submission_idempotency_key` is client-provided only when the draft is begun; the later graph-publication key is a separate kernel-derived value and is never part of this public model.

- [ ] **Step 4: Expand model invariants**

Add constructors that reject non-v1 records, empty IDs, duplicate intent IDs, an intent whose `change_set_id` differs from its change set, and terminal-to-nonterminal state transitions. Error messages name the offending ID/state.

- [ ] **Step 5: Run model tests and commit**

Run: `cargo fmt --all && cargo test -p strata-kernel --test coordination_model`

Expected: PASS.

```bash
git add crates/strata-kernel/src/coordination crates/strata-kernel/src/lib.rs crates/strata-kernel/tests/coordination_model.rs
git commit -m "feat(kernel): add coordination domain model"
```

---

### Task 2: Analyzer contract, canonical scope union, and expansion classification

**Files:**
- Create: `crates/strata-kernel/src/coordination/analyzer.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Test: `crates/strata-kernel/tests/coordination_scope.rs`

**Interfaces:**
- Consumes: immutable `GraphGeneration`, `IntentRecord`, `GraphDelta`, and scope model types.
- Produces: `IntentAnalyzer`, `IntentAnalysis`, `analyze_change_set`, `canonical_scope_fingerprint`, `required_delta_authority`, `validate_delta_containment`, and `ScopeChange`.

- [ ] **Step 1: Write failing scope tests**

Use a test-local `StaticAnalyzer` keyed by intent ID. Prove two intent analyses union into sorted/deduplicated read/write/validation sets and reservation keys; the same logical scope in different input order has the same SHA-256 fingerprint; changing a relevant version changes it. Cover `Unchanged`, `Expanded`, and `MateriallyChanged` classification.

```rust
struct StaticAnalyzer(BTreeMap<String, IntentAnalysis>);

impl IntentAnalyzer for StaticAnalyzer {
    fn analyze(&self, _: &GraphGeneration, intent: &IntentRecord) -> anyhow::Result<IntentAnalysis> {
        self.0.get(&intent.intent_id).cloned().context("missing static analysis")
    }
}

#[test]
fn composite_scope_is_canonical_and_order_independent() {
    let scope = analyze_change_set(&seed_graph(), &[rename(), add_parameter()], &analyzer()).unwrap();
    assert_eq!(scope.reservation_keys, vec!["node:caller", "symbol:User"]);
    assert_eq!(scope.scope_fingerprint.len(), 64);
}
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_scope`

Expected: FAIL because the analyzer contract is undefined.

- [ ] **Step 3: Implement the analyzer seam and canonical hashing**

```rust
pub trait IntentAnalyzer: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
}

pub struct IntentAnalysis {
    pub read_set: Vec<ResourceVersion>,
    pub write_set: Vec<ResourceVersion>,
    pub validation_set: Vec<ResourceVersion>,
    pub reservation_keys: Vec<String>,
    pub dynamic_expansion_policy: DynamicExpansionPolicy,
    pub idempotency_class: IdempotencyClass,
}

pub enum ScopeChange { Unchanged, Expanded, MateriallyChanged }
```

`analyze_change_set` rejects an empty intent list, calls the analyzer once per intent against the same immutable generation, sorts/deduplicates every set by `(resource_key, version)`, sorts/deduplicates reservation keys, chooses the strictest policy (`NeedsDecision` beats `Requeue`; lowest expansion limit wins), chooses `RequiresDecision` if any intent requires it, then hashes the canonical JSON of all fields except `scope_fingerprint` with SHA-256 lowercase hex.

`classify_scope_change(old, new)` returns `Unchanged` only for equal fingerprints; `Expanded` only when old read/write/validation entries and reservation keys are subsets of new and the new scope adds something; every removal/version replacement is `MateriallyChanged`.

Add one kernel-owned mapping from graph changes to the two kinds of authority they require:

- `UpsertNode` / `DeleteNode`: write resource `node:<id>`; reservation coverage for `node:<id>` plus old/new `node:<parentId>` when present;
- `UpsertReference` / `DeleteReference`: write resource `edge:<fromNodeId>`; reservation coverage for old/new `node:<fromNodeId>` and `node:<toNodeId>` endpoints.

`required_delta_authority(current, delta)` returns canonical `write_resources` and `reservation_coverage` sets. `validate_delta_containment` rejects publication unless every required write resource appears in `scope.write_set[*].resource_key` and every coverage key appears in `scope.reservation_keys`. `edge:*` is a write-set identity, not a new scheduler key class; reservation coverage stays within the design's node/symbol/statement/module resource classes. Extra semantic keys such as `symbol:<declarationId>` are allowed. Add focused tests for payload-only node updates, parent moves, reference retargeting/deletion, and a rogue delta that edits a node outside the inferred scope.

- [ ] **Step 4: Prove production has no fake semantic analyzer or candidate builder**

Add a dependency-guard test that scans `src/coordination` and rejects production structs named `StaticAnalyzer`, `FakeAnalyzer`, `TestAnalyzer`, `StaticCandidateBuilder`, or `FakeCandidateBuilder`. Test analyzers/builders stay under `tests/`; the later TypeScript bridge supplies the production implementations.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel --test coordination_scope`

Expected: PASS.

```bash
git add crates/strata-kernel/src/coordination crates/strata-kernel/tests/coordination_scope.rs
git commit -m "feat(kernel): define inferred semantic scopes"
```

---

### Task 3: Durable change sets, intents, tickets, offers, and queue counters

**Files:**
- Create: `crates/strata-kernel/src/coordination/durable.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/storage.rs`
- Test: `crates/strata-kernel/tests/coordination_durable.rs`

**Interfaces:**
- Consumes: coordination records from Tasks 1–2 and the existing redb `Database`.
- Produces: `CoordinationDurable`, schema initialization, atomic draft/intent/submit transitions, ordered loads, and test-only table counts.

- [ ] **Step 1: Write the failing durable lifecycle test**

Create a kernel database, begin one draft, append two intents, submit its inferred scope, close/reopen, and assert the complete change set, both intents, ticket, queue sequence, and submission-idempotency mapping round-trip. Reusing the same submission key returns the original change set without another ticket or event sequence in every state (`Draft`, `Queued`, `Ready`, `Executing`, `Committed`); it never means “retry graph commit.”

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_durable`

Expected: FAIL because coordination tables and storage APIs do not exist.

- [ ] **Step 3: Define isolated redb tables and metadata**

In `coordination/durable.rs` define:

```rust
const CHANGE_SETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_change_sets");
const INTENTS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_intents");
const TICKETS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_tickets");
const READY_OFFERS: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_ready_offers");
const EVENTS: TableDefinition<u64, &[u8]> = TableDefinition::new("coordination_events");
const EVENT_CURSORS: TableDefinition<&str, u64> = TableDefinition::new("coordination_event_cursors");
const SUBMISSION_IDEMPOTENCY: TableDefinition<&str, &str> = TableDefinition::new("coordination_submission_idempotency");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("coordination_metadata");
const NEXT_QUEUE_SEQUENCE: &str = "next_queue_sequence";
const CURRENT_EVENT_SEQUENCE: &str = "current_event_sequence";
```

`DurableStore::create`, `seed`, and `open` call `ensure_coordination_schema()` so a database created by the redb spike is upgraded idempotently. Factor the existing private `read_metadata` logic into one `pub(crate)` exact-eight-byte little-endian helper in `storage.rs`; graph and coordination metadata both call it rather than duplicating decoding rules.

- [ ] **Step 4: Implement transaction-scoped transition helpers**

Create `CoordinationDurable<'a> { database: &'a redb::Database }` and `DurableStore::coordination()`. Implement:

```rust
pub fn create_draft(&self, record: &ChangeSetRecord) -> Result<CreateDraftOutcome>;
pub fn append_intent(&self, intent: &IntentRecord) -> Result<()>;
pub fn submit(&self, change_set: &ChangeSetRecord, ticket: &CoordinationTicket,
              event: &CoordinationEvent) -> Result<()>;
pub fn change_set(&self, id: &str) -> Result<Option<ChangeSetRecord>>;
pub fn intents_for(&self, change_set_id: &str) -> Result<Vec<IntentRecord>>;
pub fn active_tickets(&self) -> Result<Vec<CoordinationTicket>>;
pub fn ready_offers(&self) -> Result<Vec<ReadyOffer>>;
```

Draft creation checks submission idempotency first. A duplicate key always resolves to the same durable change-set ID and returns its current record; a key paired with a different requested change-set ID is still a duplicate, not a second draft. Intent append requires a durable draft in `Draft`, matching base generation/change-set ID, and a unique intent ID. Submit writes the scoped change set, ticket, queue counter, and `IntentQueued` event in one transaction after verifying every referenced intent exists.

Keep commit idempotency separate: Task 7 derives `coordination-commit:<changeSetId>` inside the kernel and stores its generation in the existing graph-publication idempotency table plus `ChangeSetRecord.committed_generation`. The client never supplies that key.

- [ ] **Step 5: Prove rollback leaves every coordination table unchanged**

Add a `CoordinationFailpoint::BeforeCommit` test seam. Capture full table counts and metadata, inject failure after all inserts but before commit, reopen, and assert exact equality plus no idempotency mapping.

- [ ] **Step 6: Verify and commit**

Run: `cargo fmt --all && cargo test -p strata-kernel --test coordination_durable && cargo test -p strata-kernel`

Expected: PASS.

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/coordination_durable.rs
git commit -m "feat(kernel): persist coordination lifecycle"
```

---

### Task 4: Pure all-or-nothing scheduler with per-resource FIFO and aging

**Files:**
- Create: `crates/strata-kernel/src/coordination/scheduler.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Test: `crates/strata-kernel/tests/coordination_scheduler.rs`

**Interfaces:**
- Consumes: all nonterminal `CoordinationTicket` records, durable ready offers, and active claimed scopes.
- Produces: `SchedulerState::recover`, `enqueue`, `select_ready`, `claim`, `release`, and `expire_offer`.

- [ ] **Step 1: Write failing deterministic scheduling tests**

Cover:

1. Tickets on `symbol:A` and `symbol:B` are both selected.
2. Two tickets on `symbol:A` are selected in `queue_sequence` order.
3. A ticket requiring `[symbol:A, node:X]` is never partially selected while `node:X` is active.
4. An older wide ticket waiting for active `symbol:A` blocks every newer ticket overlapping any of its keys, while a disjoint `symbol:C` ticket passes.
5. Every skipped scheduling round increments `age_rounds` with checked arithmetic.
6. An older `Ready` ticket holds priority across its full scope until claim or expiry; a younger overlapping ticket cannot receive an offer during that lease.
7. Expiring a ready offer returns its ticket to `Queued` without changing queue sequence, so it still precedes younger overlapping work.
8. Recovery rejects duplicate queue sequences, ticket/state-to-offer/claim mismatches, overlapping active claims, and overlapping ready offers instead of silently scheduling from corrupt durable state.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_scheduler`

Expected: FAIL because `SchedulerState` does not exist.

- [ ] **Step 3: Implement the exact selection rule**

```rust
pub struct SchedulerState {
    tickets: BTreeMap<u64, CoordinationTicket>,
    active: BTreeMap<String, BTreeSet<String>>,
    offers: BTreeMap<String, ReadyOffer>,
}

pub fn select_ready(&mut self) -> Result<Vec<String>> {
    let mut ordered: Vec<&CoordinationTicket> = self.tickets.values()
        .filter(|ticket| ticket.state == TicketState::Queued)
        .collect();
    ordered.sort_by_key(|ticket| (Reverse(ticket.age_rounds), ticket.queue_sequence));
    let mut selected_keys = BTreeSet::new();
    let mut ready = Vec::new();
    for ticket in ordered {
        let keys: BTreeSet<_> = ticket.reservation_keys.iter().cloned().collect();
        let active_overlap = self.active.values().any(|active| !active.is_disjoint(&keys));
        let offered_overlap = self.offers.values().any(|offer| {
            self.ticket_for_offer(offer)
                .is_some_and(|offered| offered.reservation_keys.iter().any(|key| keys.contains(key)))
        });
        let selected_overlap = !selected_keys.is_disjoint(&keys);
        let older_overlap = self.tickets.range(..ticket.queue_sequence).any(|(_, older)| {
            matches!(older.state, TicketState::Queued | TicketState::Ready)
                && older.reservation_keys.iter().any(|key| keys.contains(key))
        });
        if !active_overlap && !offered_overlap && !selected_overlap && !older_overlap {
            selected_keys.extend(keys);
            ready.push(ticket.ticket_id.clone());
        }
    }
    Ok(ready)
}
```

Treat the code above as pseudocode: implement helpers without conflicting mutable/immutable borrows. `recover` validates state/offer/claim cardinality, unique sequences, and disjoint ready/active scopes before returning. When a queued ticket cannot run, increment `age_rounds`. Selection order is `age_rounds` descending then `queue_sequence` ascending only among tickets already eligible under per-resource FIFO. Age never lets overlapping newer work pass older queued or offered work. A ready offer is a priority hold across its complete reservation scope; `claim` atomically replaces that offer with the complete active scope, and expiry atomically returns it to queued with the same sequence. `release` removes the active scope only as part of a durable terminal/requeue transition.

- [ ] **Step 4: Add property-style interleaving coverage**

Enumerate every permutation of four fixed tickets (two overlapping, two disjoint), including intermediate ready-but-unclaimed offers. Assert no returned ready batch or existing-offer combination contains overlapping scopes, all disjoint tickets eventually run, and per-key offer/claim sequence is monotonically increasing.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel --test coordination_scheduler`

Expected: PASS.

```bash
git add crates/strata-kernel/src/coordination crates/strata-kernel/tests/coordination_scheduler.rs
git commit -m "feat(kernel): schedule semantic scopes fairly"
```

---

### Task 5: Submit, ready-offer, claim, expiry, and dynamic-expansion lifecycle

**Files:**
- Create: `crates/strata-kernel/src/coordination/coordinator.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Modify: `crates/strata-kernel/Cargo.toml`
- Test: `crates/strata-kernel/tests/coordination_lifecycle.rs`
- Test: `crates/strata-kernel/tests/ui/claim_has_no_fence.rs`
- Test: `crates/strata-kernel/tests/ui/claim_has_no_fence.stderr`

**Interfaces:**
- Consumes: `IntentAnalyzer`, durable coordination records, `SchedulerState`, current graph generation/service epoch, and caller-supplied logical `now_tick`.
- Produces: `Kernel::begin_change_set`, `add_intent`, `submit_change_set`, `claim_ready`, `expire_ready_offers`, `cancel_change_set`, and `reconsider_tickets`.

- [ ] **Step 1: Write failing lifecycle tests**

Prove:

- A disjoint submit returns `SubmissionOutcome::Ready` with a durable offer.
- An overlapping submit returns immediately as `Queued` and holds no active reservation.
- A ready offer contains the current generation, service epoch, scope fingerprint, opaque UUID claim token, and `expires_at_tick = now_tick + READY_OFFER_TTL_TICKS`.
- While that offer is unclaimed, its complete scope remains a priority hold and younger overlapping submissions stay queued; disjoint submissions still become ready.
- Wrong token, stale epoch, expired offer, and already-claimed offer all fail without state change.
- Claim re-runs analysis on the current graph.
- A strict scope expansion requeues and emits `ScopeExpanded`; the fourth expansion with max `3` becomes `IntentNeedsDecision`.
- A material scope change becomes `IntentNeedsDecision` immediately.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_lifecycle`

Expected: FAIL because coordinator methods do not exist.

- [ ] **Step 3: Add scheduler state to `Kernel` and recover it**

Add:

```rust
pub struct Kernel {
    pub(crate) store: DurableStore,
    live: RwLock<Arc<GraphGeneration>>,
    publish_lock: Mutex<()>,
    service_epoch: u64,
    pub(crate) scheduler: Mutex<SchedulerState>,
}
```

`Kernel::create/open` loads active tickets/offers after graph recovery. Opening invalidates persisted offers from the prior epoch before exposing the kernel; Task 6 adds the corresponding events/cursors.

- [ ] **Step 4: Implement public lifecycle methods**

Use exact input records rather than free-form maps:

```rust
pub struct BeginChangeSet {
    pub change_set_id: String,
    pub actor: String,
    pub reasoning: String,
    pub submission_idempotency_key: String,
}

pub fn begin_change_set(&self, input: BeginChangeSet) -> Result<ChangeSetRecord>;
pub fn add_intent(&self, change_set_id: &str, parameters: IntentParameters) -> Result<IntentRecord>;
pub fn submit_change_set(&self, change_set_id: &str, analyzer: &dyn IntentAnalyzer,
                         now_tick: u64) -> Result<SubmissionOutcome>;
pub fn claim_ready(&self, offer_id: &str, claim_token: &str,
                   analyzer: &dyn IntentAnalyzer, now_tick: u64) -> Result<ClaimOutcome>;
pub fn expire_ready_offers(&self, now_tick: u64) -> Result<Vec<String>>;
```

Set `READY_OFFER_TTL_TICKS = 30`. Every method locks scheduler state once, calculates a complete transition, persists it in one redb transaction, then mutates the in-memory projection. A persistence error leaves memory unchanged. Submission persists the scoped change set/ticket and `IntentQueued`; when immediately eligible, that same transaction also persists `Ready`, its offer, and `IntentReady`—there is no crash-visible queued-with-missing-offer interval. Creating an offer changes the durable ticket/change set to `Ready`; claiming consumes the offer token, generates a fresh opaque `claim_id`, and changes the ticket/change set to `Claimed`/`Executing`; expiry restores `Queued` while preserving sequence and age and may atomically offer newly eligible tickets. The durable ticket stores exactly one of `ready_offer_id` or `active_claim_id` in those states, and the claim handle echoes the latter. In every state, reusing `submission_idempotency_key` returns the same current change set and creates no duplicate lifecycle event.

Claim reanalysis rules are exact:

- `Unchanged` → `Executing` and return `ClaimHandle`.
- `Expanded` plus `Requeue { max_expansions }` and `expansion_count < max_expansions` → increment count, persist new scope, queue, emit `ScopeExpanded`.
- `Expanded` at the limit or policy `NeedsDecision` → `NeedsDecision`.
- `MateriallyChanged` → `NeedsDecision` regardless of idempotency class.

- [ ] **Step 5: Prove offers do not grant fencing authority**

Assert serialized `ClaimHandle` contains reservation keys but no `FenceClaim`, resource tokens, raw delta, or publication method. Add `trybuild = "1"` as a dev dependency and a compile-fail UI test proving external code cannot extract a fence/publication or call a raw publish method through the default API. Task 7 updates the fixture to show that callers can only pass the opaque claim back to `Kernel::publish_claimed` with the analyzer/candidate-builder seams.

- [ ] **Step 6: Verify and commit**

Run: `cargo fmt --all && cargo test -p strata-kernel --test coordination_lifecycle && cargo test -p strata-kernel`

Expected: PASS.

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/coordination_lifecycle.rs
git commit -m "feat(kernel): add durable ticket and claim lifecycle"
```

---

### Task 6: Durable at-least-once events, cursors, and restart recovery

**Files:**
- Modify: `crates/strata-kernel/src/coordination/durable.rs`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Test: `crates/strata-kernel/tests/coordination_recovery.rs`

**Interfaces:**
- Consumes: coordination transitions/events and the incremented service epoch from `Kernel::open`.
- Produces: `Kernel::events_after`, `ack_events`, restart requeue, offer invalidation, and monotonic cursor semantics.

- [ ] **Step 1: Write failing event and restart tests**

Test:

1. `events_after("client:A", 0, 100)` returns ordered events without consuming them.
2. Calling it twice returns the same stable event IDs.
3. `ack_events("client:A", 2)` advances the cursor; acknowledging `1` afterward is harmless and does not move backward.
4. Another client has an independent cursor.
5. After restart, queued tickets and unacknowledged events remain.
6. A prior-epoch `Ready` or `Executing` change set returns to `Queued`, its offer is deleted, and one `LeaseExpired` event is appended.
7. A terminal change set is unchanged by restart.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_recovery`

Expected: FAIL because event/cursor/recovery APIs are missing.

- [ ] **Step 3: Implement event reads and monotonic acknowledgements**

```rust
pub fn events_after(&self, client_id: &str, after_sequence: u64,
                    limit: usize) -> Result<Vec<CoordinationEvent>>;
pub fn ack_events(&self, client_id: &str, sequence: u64) -> Result<EventCursor>;
```

Reject `limit == 0` and acknowledgements beyond the current durable event sequence. `events_after` starts strictly after `max(after_sequence, acknowledged_sequence_for_client)`. `ack_events` stores `max(existing, sequence)` in one transaction. Event IDs are generated once when the event is persisted and never regenerated on delivery.

- [ ] **Step 4: Implement restart transition in one transaction**

Refactor open-time epoch advancement and coordination recovery into `begin_service_epoch_and_recover_coordination`: one redb write transaction increments the service epoch, scans nonterminal change sets, deletes prior offers, changes every `Ready`/`Executing` record and ticket to `Queued`, clears `ready_offer_id` and `active_claim_id`, preserves queue sequence/scope/age, and appends one `LeaseExpired` event containing old/new epochs. Graph recovery may be prepared before this write, but `Kernel::open` does not expose the kernel or reconstruct `SchedulerState` until the combined transaction commits.

An injected before-commit failure must leave the service epoch and every prior coordination record unchanged; the next successful open performs the transition exactly once.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel --test coordination_recovery`

Expected: PASS.

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/coordination_recovery.rs
git commit -m "feat(kernel): recover tickets and replay events"
```

---

### Task 7: Atomic claimed publication and composite change sets

**Files:**
- Modify: `crates/strata-kernel/src/model.rs`
- Modify: `crates/strata-kernel/src/coordination/model.rs`
- Modify: `crates/strata-kernel/src/coordination/analyzer.rs`
- Modify: `crates/strata-kernel/src/coordination/durable.rs`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs`
- Modify: `crates/strata-kernel/src/storage.rs`
- Modify: `crates/strata-kernel/src/kernel.rs`
- Modify: `crates/strata-kernel/src/lib.rs`
- Modify: `crates/strata-kernel/Cargo.toml`
- Modify: `crates/strata-kernel/src/bin/redb_spike.rs`
- Modify: existing spike integration tests that call raw publication APIs
- Test: `crates/strata-kernel/tests/coordination_publication.rs`

**Interfaces:**
- Consumes: an executing `ClaimHandle`, fresh analyzer result, and a kernel-invoked `CandidateBuilder`.
- Produces: `Kernel::publish_claimed` and one redb transaction composing kernel-owned graph publication, fence issuance/consumption, coordination completion/release, and successor ready transitions.

- [ ] **Step 1: Write failing coordinated-publication tests**

Using the real `examples/medium` graph and a test-local analyzer, prove:

- A claim whose service epoch, graph generation, offer, or scope fingerprint is stale cannot publish.
- Publication re-runs analysis immediately before invoking the candidate builder; a changed scope requeues/needs-decision without ever building or applying a candidate.
- The kernel, not the caller or candidate builder, derives the aggregate operation, graph event, ticket transition, coordination events, successor offers, commit idempotency key, and final fences.
- A candidate that changes a node, parent relation, or reference outside the fresh write/reservation scope is rejected without graph or coordination side effects.
- A two-intent change set publishes one graph generation and one aggregate `OperationRecord` whose `change_set_id` matches the durable change set.
- Graph delta, operation, digest, idempotency mapping, consumed fences, change-set `Committed`, ticket `Completed`, `IntentCommitted`, and successor `IntentReady` offers are all present after reopen.
- Injected failure after every graph and coordination insert but before commit leaves the complete old graph and old coordination state.
- Injected failure after in-transaction fence issuance/consumption but before commit also leaves both fence tables unchanged.
- Retrying a committed change set returns `committed_generation` without duplicate graph or coordination events, whether the duplicate arrives while another call is finishing or after reopen.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test -p strata-kernel --test coordination_publication`

Expected: FAIL because `CandidateBuilder`, contained coordinated publication, and the atomic coordination transaction do not exist.

- [ ] **Step 3: Add the candidate-builder seam and close default raw-publication bypasses**

Define the production interface but no production implementation:

```rust
pub trait CandidateBuilder: Send + Sync {
    fn build_candidate(
        &self,
        graph: &GraphGeneration,
        change_set: &ChangeSetRecord,
        intents: &[IntentRecord],
    ) -> Result<GraphDelta>;
}
```

The scheduler tests implement this trait locally. The TypeScript bridge will later provide the real worker-backed implementation and validation-result binding. The kernel rejects a candidate with the wrong schema/base generation and calls `validate_delta_containment` before applying it.

Do not add a coordination field to public `Publication`. Instead, make the default crate surface incapable of raw publication:

```toml
[features]
default = []
redb-spike-api = []

[[bin]]
name = "redb-spike"
path = "src/bin/redb_spike.rs"
required-features = ["redb-spike-api"]
```

Gate `Kernel::issue_fence`, `Kernel::publish`, `Kernel::publish_with_failpoint`, `DurableStore`/`PublishOutcome`, and the `Publication`/`FenceClaim` exports behind `redb-spike-api`. Gate the existing raw-publication integration tests with the same feature and run them explicitly in the final gate. The default API and future service build cannot supply fences or publications. Add a `trybuild` default-feature fixture proving those imports/methods are unavailable. The feature is a preserved research harness, not a supported authority path, and service crates must not enable it.

- [ ] **Step 4: Refactor coordinated publication into one transaction, including fresh fences**

Keep `Publication` as a crate-internal legacy storage record and add a crate-internal `CoordinatedCommit` assembled only by `Kernel`. Extract shared graph inserts into a transaction-local helper; add:

```rust
fn publish_coordinated(
    &self,
    commit: &CoordinatedCommit,
    expected_digest: &str,
) -> Result<PublishOutcome>;

fn issue_and_consume_fences_in_write_txn(
    &self,
    write: &redb::WriteTransaction,
    service_epoch: u64,
    reservation_keys: &[String],
) -> Result<FenceClaim>;
```

`publish_coordinated` opens exactly one redb write transaction. It first checks kernel-derived `coordination-commit:<changeSetId>` in the existing graph idempotency table, verifies current generation/service epoch/durable executing state, increments and consumes fresh tokens for the complete reservation set inside that same transaction, writes graph operation/delta/event/digest/idempotency/generation, writes change-set/ticket completion and committed generation, releases the claim, and writes all successor offers/events before one `commit()`. It never calls the existing separately committing `issue_fence` path.

Add a failpoint immediately after `issue_and_consume_fences_in_write_txn` and before other inserts. Aborting or returning an error at that point must leave `FENCES`, `CONSUMED_FENCES`, graph tables, and coordination tables byte-for-byte unchanged after reopen. Preserve the spike failpoints for the feature-gated legacy path.

- [ ] **Step 5: Implement `Kernel::publish_claimed`**

```rust
pub fn publish_claimed(
    &self,
    claim: &ClaimHandle,
    analyzer: &dyn IntentAnalyzer,
    candidate_builder: &dyn CandidateBuilder,
) -> Result<PublicationReport>;
```

Lock order is always `scheduler` → `publish_lock` → redb write transaction → `live` write lock. Audit every kernel method and add a lock-order regression comment/test so no path acquires those locks in reverse. Before claim validation, check the kernel-derived commit idempotency key; an already committed change set returns its original generation/digest. Otherwise, under scheduler/publish locks, validate the durable executing claim and re-run all durable intents against one captured immutable snapshot. Any fingerprint change durably requeues/needs-decision and releases the active scope without calling the builder or changing the graph.

For an unchanged scope, invoke the builder, validate schema/base generation and delta containment, prepare the next immutable generation, and precompute the scheduler state after releasing the complete active scope. From that projection, create successor offers only for now-eligible tickets; ready offers remain priority holds. The kernel derives stable operation/event IDs, affected nodes, bounded wake context (`blocking_operation_id`, before/after generations, affected node IDs), aggregate kind/actor/reasoning, the ticket completion, all successor events/offers, and `coordination-commit:<changeSetId>`. Pass the internal commit to storage once, swap `live` only after redb commit, then install the precomputed scheduler projection. A post-redb/pre-memory crash is repaired by normal reopen/recovery.

- [ ] **Step 6: Verify and commit**

Run: `cargo fmt --all && cargo clippy -p strata-kernel --all-targets -- -D warnings && cargo test -p strata-kernel --test coordination_publication && cargo test -p strata-kernel`

Expected: PASS.

```bash
git add crates/strata-kernel/src crates/strata-kernel/tests/coordination_publication.rs
git commit -m "feat(kernel): publish claimed change sets atomically"
```

---

### Task 8: Deterministic multi-client scheduler acceptance on `examples/medium`

**Files:**
- Create: `crates/strata-kernel/tests/coordination_acceptance.rs`
- Create: `crates/strata-kernel/tests/support/coordination.rs`

**Interfaces:**
- Consumes: the complete coordination API, real graph fixture, and test-local deterministic analyzer.
- Produces: key-free acceptance evidence for scheduler-owned items 1, 2, 3, 5, 7, and 11 plus scheduler-level dynamic expansion/composite grouping.

- [ ] **Step 1: Build a test-only deterministic analyzer over the real graph**

The analyzer fixture must derive its scope by matching `IntentParameters::{RenameSymbol, AddParameter}` against the supplied `GraphGeneration`: declaration/function IDs select actual nodes, graph reference indexes discover related nodes, and resource versions come from node/reference payload SHA-256 values plus graph generation. It must not look up a pre-authored scope by intent ID. Only the appearance of an extra callsite after a selected generation may be scripted for interleaving control.

Add sensitivity assertions: changing `declaration_id` or `function_id` changes the derived scope; an unknown ID fails analysis; serialized begin/add/submit inputs contain no reservation keys, scope fingerprints, fences, or tokens. This is still a test semantic analyzer—not the deferred TypeScript implementation—but it proves the scheduler consumes intent-and-graph-derived scopes rather than client hints.

- [ ] **Step 2: Prove disjoint progress and overlapping order**

Scenario A submits two disjoint rename-shaped intents; both receive ready offers, claim, and commit in either order without waiting on one another.

Scenario B submits two same-symbol renames; the first claims, the second remains queued, then receives an `IntentReady` event containing the blocking operation, before/after generations, new fingerprint, and bounded affected-node context. Its fresh analysis differs and produces `IntentNeedsDecision`; it never applies the stale requested delta.

- [ ] **Step 3: Prove overlap inference and dynamic expansion**

Submit a rename-shaped scope and an edit touching one inferred reference; assert overlap is inferred even though the client supplied no keys.

Queue an add-parameter-shaped intent, advance the graph with a newly scripted callsite, then claim. Assert reanalysis expands read/write/validation/reservation sets, discards the old candidate, persists `ScopeExpanded`, and requeues before any graph mutation.

Have a malicious test candidate builder return a delta for a different real node and another that retargets an unreserved reference. Assert both fail containment before the redb transaction and leave the claim, graph, events, fences, and scheduler projection unchanged.

- [ ] **Step 4: Prove FIFO aging and restart/event behavior**

Hold one small active scope, queue an older wide ticket, then submit ten newer tickets alternating overlapping and disjoint keys. Assert every disjoint ticket progresses, no overlapping newer ticket passes the wide ticket, and the wide ticket claims immediately after the active scope releases.

Restart with one queued ticket and unacknowledged events. Assert ticket/event IDs survive, old offers are invalid, duplicate delivery is byte-equal, and independent client cursors deduplicate safely.

- [ ] **Step 5: Prove composite atomicity**

Create a two-intent change set whose synthetic delta changes two real nodes. Claim and publish once. Assert generation increments exactly one, both node changes appear together, and injected pre-commit failure exposes neither.

- [ ] **Step 6: Run repeatedly and commit**

Run:

```bash
cargo test -p strata-kernel --test coordination_acceptance -- --nocapture
for i in 1 2 3 4 5; do cargo test -p strata-kernel --test coordination_acceptance; done
```

Expected: every run passes with no sleeps, model calls, nondeterministic wall-clock dependence, lost updates, partial reservations, or stale publication.

```bash
git add crates/strata-kernel/tests/coordination_acceptance.rs crates/strata-kernel/tests/support
git commit -m "test(kernel): prove deterministic coordination scheduling"
```

---

### Task 9: Scheduler report, decision, and roadmap gate

**Files:**
- Create: `docs/spikes/2026-07-14-coordination-scheduler.md`
- Modify: `decisions.md`
- Modify: `docs/product-roadmap.md`

**Interfaces:**
- Consumes: all scheduler tests and final repository verification.
- Produces: a bounded scheduler PASS/FAIL decision. PASS unlocks the separate TypeScript validation-bridge plan; it does not check the roadmap's two-operation or key-free full-acceptance items.

- [ ] **Step 1: Run the complete key-free scheduler gate**

Run:

```bash
cargo fmt --all -- --check
cargo clippy -p strata-kernel --all-targets -- -D warnings
cargo test -p strata-kernel
cargo test -p strata-kernel --features redb-spike-api
pnpm --filter @strata/ingest build
pnpm --filter @strata/ingest test
pnpm -r build
pnpm -r test
```

Expected: Rust/ingest/build gates pass. If the known pre-existing `extract_function` verify test remains the only pnpm failure, record its exact output and do not misclassify it as a scheduler regression. Any new failure is a scheduler FAIL.

- [ ] **Step 2: Write the evidence matrix**

`docs/spikes/2026-07-14-coordination-scheduler.md` records exact commit/toolchains/commands and maps:

| Approved acceptance item | Scheduler result |
|---|---|
| 1 disjoint renames | pass only if deterministic test passes |
| 2 same-symbol ordering/fresh decision | pass only if deterministic test passes |
| 3 inferred reference overlap | pass only if deterministic test passes |
| 4 real add-parameter new-callsite analysis | `not part of scheduler gate — TypeScript validation bridge` |
| 5 wide-ticket starvation prevention | pass only if deterministic test passes |
| 6 stale fences/epochs | pass only if in-transaction coordinated-fence tests and feature-gated legacy fencing tests pass |
| 7 tickets/events survive restart | pass only if recovery test passes |
| 8 redb crash atomicity | inherited bounded redb spike pass |
| 9 snapshot/replay equivalence | inherited redb spike pass |
| 10 real grouped validation | `not part of scheduler gate — TypeScript validation bridge` |
| 11 duplicate delivery/cursors | pass only if cursor test passes |
| 12 service/worker authority boundary | default Rust API raw-publication bypass closed; transport/auth/worker isolation remains `not part of scheduler gate — multi-client service plan` |

The final result is `PASS` only if all scheduler-owned rows pass with zero partial reservations, starvation, lost tickets/events, stale claims, out-of-scope deltas, or non-atomic coordinated publications. Label rows 1–5 explicitly as scheduler-level proofs using an intent-and-graph-derived test analyzer; they do not prove real TypeScript rename/add-parameter semantics or validation, which remain gated on the bridge.

- [ ] **Step 3: Record decision and roadmap status**

If PASS, prepend `Coordination scheduler passes; TypeScript validation bridge unblocked` to `decisions.md`. Check only the roadmap's **Coordination kernel** item. Leave **Two-operation proof**, **Key-free acceptance**, and **Live falsifiable comparison** unchecked.

If FAIL, prepend `Coordination scheduler falsified: <property>` with the exact failing command/output, leave the roadmap unchecked, and stop. Do not begin the bridge in the same task.

- [ ] **Step 4: Verify docs and commit**

Run: `git diff --check && git status --short`

Expected: only the report, decision, and intended roadmap edit remain uncommitted.

```bash
git add docs/spikes/2026-07-14-coordination-scheduler.md decisions.md docs/product-roadmap.md
git commit -m "docs(kernel): record coordination scheduler result"
```

---

## Follow-on plan boundaries

Do not include these in this execution:

1. **TypeScript validation bridge:** real `rename_symbol` and `add_parameter` analyzers, candidate generation, bounded render inputs, worker protocol, tsc/vitest validation, result binding, and worker-crash handling.
2. **Multi-client service:** transport, authentication, connection identity, reconnect/event replay, remote latency injection, and a tool gateway that makes bypass APIs unreachable.
3. **Live paradigm experiment:** model-backed agents, worktree comparison arm, integration-agent accounting, and time/token measurements.

Write the validation-bridge plan only after Task 9 records a scheduler PASS.
