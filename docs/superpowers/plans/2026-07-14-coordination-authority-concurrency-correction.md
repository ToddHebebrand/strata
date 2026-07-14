# Coordination Authority and Concurrency Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the Rust/redb scheduler so semantic authority is kernel-owned, slow candidate work runs outside global locks, disjoint claims can both publish, every Ready offer follows fresh analysis, and deterministic leases prevent stranded authority.

**Architecture:** Keep redb as the short atomic publication sequencer and the in-memory graph/scheduler as immutable optimistic snapshots. Add a private semantic-provider boundary, durable monotonic resource clocks, a single readiness planner, and a prepare/build/revalidate publication loop. Default builds expose no semantic-provider injection and return a typed unavailable error until the production TypeScript bridge is built; deterministic providers and builders exist only under `coordination-test-api`.

**Tech Stack:** Rust 1.89, edition 2024, redb 4.1.0, serde/serde_json, sha2, uuid, anyhow, trybuild, existing `examples/medium` ingest-derived fixture.

## Global Constraints

- Clients supply typed `IntentParameters`; they never supply analyzers, reservation keys, scope fingerprints, fences, or resource versions.
- TypeScript remains authoritative for production language semantics.
- Until the TypeScript bridge exists, default builds do not execute semantic coordination mutations.
- Deterministic semantic providers and candidate builders are injectable only through the non-default `coordination-test-api` feature.
- Candidate builders and validation workers are untrusted; their output is data, never authority.
- Global graph generation is publication order and provenance, not an automatic conflict.
- Resource clocks are durable, monotonic, and updated atomically with graph, operation, coordination, event, idempotency, and fencing state.
- No semantic analysis, candidate construction, render, typecheck, or test work may run while the publication or scheduler mutex is held.
- The universal commit lock order is publication mutex, scheduler mutex, then redb write transaction.
- Every Ready offer is created by one centralized planner from a fresh graph and scheduler revision.
- Tests use deterministic logical ticks; no sleeps or wall-clock lease behavior.
- Existing SQLite behavior, the bounded redb spike, and the `examples/medium` fixture remain unchanged.
- This plan does not add the TypeScript bridge, transport, authentication, task assignment, structural merge, multi-host consensus, or live model runs.

## File Structure

- Create `crates/strata-kernel/src/coordination/authority.rs`: private production semantic-provider contract, feature-gated deterministic test adapter, authority plans, prepared candidate requests, envelopes, and canonical candidate digests.
- Create `crates/strata-kernel/src/coordination/resources.rs`: canonical resource/index keys, monotonic dependency snapshots, delta-affected resource derivation, and clock comparison.
- Create `crates/strata-kernel/src/coordination/planner.rs`: the only code allowed to create `ReadyOffer`; pure optimistic readiness planning and transition application.
- Create `crates/strata-kernel/src/coordination/publication.rs`: unlocked prepare/build/revalidate loop and short atomic commit path.
- Keep `crates/strata-kernel/src/coordination/coordinator.rs`: client lifecycle entry points; remove publication and ad hoc Ready construction from it.
- Modify `crates/strata-kernel/src/coordination/model.rs`: durable attempts, leases, dependency clocks, and typed coordination error.
- Modify `crates/strata-kernel/src/coordination/durable.rs`: scheduler revision, resource-clock and publication-attempt tables, expiry/recovery writes.
- Modify `crates/strata-kernel/src/coordination/scheduler.rs`: revision-aware state transitions; make direct Ready construction inaccessible outside the planner.
- Modify `crates/strata-kernel/src/kernel.rs`: provider/clock projections, default and research constructors, recovery initialization.
- Modify `crates/strata-kernel/src/storage.rs`: atomically persist resource clocks and publication-attempt identity with coordinated publication.
- Modify `crates/strata-kernel/src/lib.rs`, `coordination/mod.rs`, and `Cargo.toml`: seal default authority and expose only the feature-gated research surface.
- Modify `crates/strata-kernel/tests/support/coordination.rs`: migrate the existing real-graph analyzer/builders to the feature-only contracts and keep reusable correction fixtures on `examples-medium.snapshot.json`.
- Create focused integration tests: `coordination_authority.rs`, `coordination_resources.rs`, `coordination_planner.rs`, `coordination_leases.rs`, and `coordination_optimistic.rs`; retain existing suites as regressions.

Test snippets below use task-local fixture wrappers such as `claimed_fixture`, `PlannerFixture`, and `AtomicState`. Define each wrapper in the test file that first uses it by composing the existing `MediumCoordinationFixture`, `GraphDerivedAnalyzer`, `begin_with_intents`, and delta builders from `tests/support/coordination.rs`. Every wrapper must load `fixtures/examples-medium.snapshot.json`, own its `TempDir` for the full test, expose only the IDs/claims/builders named in the snippet, and perform no timing or background work except the explicit barrier-controlled builder case.

---

### Task 1: Seal Semantic Authority and Establish the Research Feature

**Files:**
- Create: `crates/strata-kernel/src/coordination/authority.rs`
- Create: `crates/strata-kernel/tests/coordination_authority.rs`
- Create: `crates/strata-kernel/tests/ui/semantic_authority_is_sealed.rs`
- Create after trybuild records it: `crates/strata-kernel/tests/ui/semantic_authority_is_sealed.stderr`
- Modify: `crates/strata-kernel/Cargo.toml:7-10`
- Modify: `crates/strata-kernel/src/coordination/mod.rs:1-27`
- Modify: `crates/strata-kernel/src/lib.rs:7-18`
- Modify: `crates/strata-kernel/src/kernel.rs:44-50,52-144,250-277`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs:138-250,252-396,638-904`
- Modify: `crates/strata-kernel/tests/api_sealing.rs:1-7`
- Modify: provider-dependent coordination integration tests under `crates/strata-kernel/tests/`
- Modify: `crates/strata-kernel/tests/support/coordination.rs`

**Interfaces:**
- Produces: `CoordinationError::SemanticProviderUnavailable`, crate-private `SemanticProvider`, feature-only `TestSemanticProvider`, `Kernel::create_with_test_semantics`, and `Kernel::open_with_test_semantics`.
- Preserves: `Kernel::create` and `Kernel::open` default constructors, but semantic submit/claim/publication fail without side effects.

- [ ] **Step 1: Add failing default-feature authority tests**

```rust
// crates/strata-kernel/tests/coordination_authority.rs
use strata_kernel::{
    BeginChangeSet, ChangeSetState, CoordinationError, GraphSnapshot, IntentParameters, Kernel,
    NodeRecord, SCHEMA_VERSION,
};
use tempfile::tempdir;

fn empty_snapshot() -> GraphSnapshot {
    GraphSnapshot {
        schema_version: SCHEMA_VERSION,
        generation: 0,
        nodes: Vec::<NodeRecord>::new(),
        references: Vec::new(),
    }
}

#[test]
fn default_kernel_rejects_semantic_execution_without_side_effects() {
    let dir = tempdir().unwrap();
    let (kernel, _) = Kernel::create(dir.path().join("kernel.redb"), empty_snapshot()).unwrap();
    kernel.begin_change_set(BeginChangeSet {
        change_set_id: "change:sealed".into(),
        actor: "agent:a".into(),
        reasoning: "prove default authority is sealed".into(),
        submission_idempotency_key: "submit:sealed".into(),
    }).unwrap();
    kernel.add_intent("change:sealed", IntentParameters::RenameSymbol {
        declaration_id: "decl:missing".into(),
        new_name: "Renamed".into(),
    }).unwrap();

    let error = kernel.submit_change_set("change:sealed", 1).unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::SemanticProviderUnavailable),
    );
    assert_eq!(
        kernel.change_set("change:sealed").unwrap().unwrap().state,
        ChangeSetState::Draft,
    );
    assert!(kernel.events_after("audit", 0, 10).unwrap().is_empty());
}
```

```rust
// crates/strata-kernel/tests/ui/semantic_authority_is_sealed.rs
use strata_kernel::{IntentAnalysis, IntentAnalyzer, TestSemanticProvider};

fn main() {}
```

Extend `api_sealing.rs` with:

```rust
#[test]
fn semantic_authority_is_not_exported_by_default() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/semantic_authority_is_sealed.rs");
}
```

- [ ] **Step 2: Run the authority tests and confirm the intended failures**

Run: `cargo test -p strata-kernel --test coordination_authority --test api_sealing`

Expected: compile failures because `CoordinationError` and the sealed default API do not exist yet, plus trybuild output identifying the currently exported analyzer types.

- [ ] **Step 3: Add the sealed provider boundary and typed error**

Add to `coordination/model.rs`:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoordinationError {
    SemanticProviderUnavailable,
    OptimisticRetryExhausted { attempts: u32 },
    CandidateDigestMismatch,
    AttemptDigestMismatch,
    LeaseExpired,
}

impl std::fmt::Display for CoordinationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SemanticProviderUnavailable => write!(formatter, "semantic provider is unavailable"),
            Self::OptimisticRetryExhausted { attempts } => {
                write!(formatter, "optimistic coordination retry exhausted after {attempts} attempts")
            }
            Self::CandidateDigestMismatch => write!(formatter, "candidate digest does not match its delta"),
            Self::AttemptDigestMismatch => write!(formatter, "attempt id was reused with a different candidate digest"),
            Self::LeaseExpired => write!(formatter, "coordination authority lease has expired"),
        }
    }
}

impl std::error::Error for CoordinationError {}
```

Create `authority.rs` with the private provider and the feature adapter:

```rust
use std::sync::Arc;
use anyhow::Result;
use crate::GraphGeneration;
use super::{IntentAnalysis, IntentRecord};

pub(crate) trait SemanticProvider: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
}

#[cfg(feature = "coordination-test-api")]
pub trait TestSemanticProvider: Send + Sync {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis>;
}

#[cfg(feature = "coordination-test-api")]
pub(crate) struct TestSemanticAdapter(pub Arc<dyn TestSemanticProvider>);

#[cfg(feature = "coordination-test-api")]
impl SemanticProvider for TestSemanticAdapter {
    fn analyze(&self, graph: &GraphGeneration, intent: &IntentRecord) -> Result<IntentAnalysis> {
        self.0.analyze(graph, intent)
    }
}
```

Add `semantic_provider: Option<Arc<dyn SemanticProvider>>` to `Kernel`. Default constructors pass `None`; feature-only constructors wrap a `TestSemanticAdapter`. Replace public analyzer parameters with `self.semantic_provider()?`, where:

```rust
pub(crate) fn semantic_provider(&self) -> anyhow::Result<&dyn SemanticProvider> {
    self.semantic_provider
        .as_deref()
        .ok_or_else(|| anyhow::Error::new(CoordinationError::SemanticProviderUnavailable))
}
```

Remove `IntentAnalyzer`, `IntentAnalysis`, `analyze_change_set`, `DeltaAuthority`, `required_delta_authority`, and scope-authority constructors from default `lib.rs` exports. Re-export `TestSemanticProvider`, test analysis records, and research constructors only under `#[cfg(feature = "coordination-test-api")]`.

- [ ] **Step 4: Configure feature inheritance and gate provider-dependent suites**

Use these Cargo features:

```toml
[features]
default = []
coordination-test-api = []
redb-spike-api = ["coordination-test-api"]
```

Add `#![cfg(feature = "coordination-test-api")]` only to integration suites that construct analyzers/builders. Keep model, scheduler, graph, storage, recovery, and default authority-sealing tests runnable without features. Convert test analyzers from `IntentAnalyzer` to `TestSemanticProvider`, and construct kernels with `create_with_test_semantics` or `open_with_test_semantics`.

- [ ] **Step 5: Run both API surfaces**

Run: `cargo test -p strata-kernel --test coordination_authority --test api_sealing`

Expected: PASS; the default kernel returns `SemanticProviderUnavailable`, and trybuild proves analyzer authority is inaccessible.

Run: `cargo test -p strata-kernel --features coordination-test-api`

Expected: all migrated coordination tests compile and pass.

- [ ] **Step 6: Commit the authority boundary**

```bash
git add crates/strata-kernel
git commit -m "fix(kernel): seal semantic coordination authority"
```

---

### Task 2: Add Durable Monotonic Resource Clocks

**Files:**
- Create: `crates/strata-kernel/src/coordination/resources.rs`
- Create: `crates/strata-kernel/tests/coordination_resources.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/coordination/model.rs:115-146,444-491`
- Modify: `crates/strata-kernel/src/coordination/durable.rs:21-56,74-82,1241-1339`
- Modify: `crates/strata-kernel/src/storage.rs:16-46,221-328`
- Modify: `crates/strata-kernel/src/kernel.rs:44-50,52-144,250-277`

**Interfaces:**
- Produces: `DependencyVersion { resource_key: String, clock: u64 }`, `ResourceClockSnapshot`, `dependency_snapshot`, `affected_resource_keys`, and atomic `resource_clock_updates` on `CoordinatedCommit`.
- Consumes: immutable `GraphGeneration` before-state and `GraphDelta`.

- [ ] **Step 1: Write failing clock and restart tests**

```rust
#![cfg(feature = "coordination-test-api")]

#[test]
fn every_structural_and_index_bucket_advances_monotonically() {
    let before = fixture();
    let delta = rename_and_retarget_delta(&before);
    let keys = affected_resource_keys(&before, &delta).unwrap();
    assert!(keys.contains("node:fc98295bca9efc3e"));
    assert!(keys.iter().any(|key| key.starts_with("children:")));
    assert!(keys.iter().any(|key| key.starts_with("edge:")));
    assert!(keys.iter().any(|key| key.starts_with("references-to:")));
    assert!(keys.iter().any(|key| key.starts_with("namespace:")));
    assert!(keys.iter().any(|key| key.starts_with("absence:")));

    let (kernel, path) = kernel_with_test_semantics(before);
    publish_fixture_delta(&kernel, delta);
    let first = kernel.test_resource_clocks(&keys).unwrap();
    assert!(first.values().all(|clock| *clock == 1));
    drop(kernel);

    let (reopened, _) = Kernel::open_with_test_semantics(path, fixture_provider()).unwrap();
    assert_eq!(reopened.test_resource_clocks(&keys).unwrap(), first);
}
```

Add a second test that changes the same node twice and asserts clock `2`, never a payload-derived value or reset to `0`.

- [ ] **Step 2: Run the focused test and verify missing resource APIs**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_resources`

Expected: FAIL because the resource-key and durable clock APIs do not exist.

- [ ] **Step 3: Define canonical resource keys and dependency vectors**

Create `resources.rs` with:

```rust
use std::collections::{BTreeMap, BTreeSet};
use anyhow::{Context, Result};
use crate::{GraphChange, GraphDelta, GraphGeneration, NodeRecord};

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVersion {
    pub resource_key: String,
    pub clock: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ResourceClockSnapshot {
    clocks: BTreeMap<String, u64>,
}

impl ResourceClockSnapshot {
    pub(crate) fn clock(&self, key: &str) -> u64 { self.clocks.get(key).copied().unwrap_or(0) }
    pub(crate) fn dependencies(&self, keys: &BTreeSet<String>) -> Vec<DependencyVersion> {
        keys.iter().map(|key| DependencyVersion {
            resource_key: key.clone(),
            clock: self.clock(key),
        }).collect()
    }
    pub(crate) fn matches(&self, dependencies: &[DependencyVersion]) -> bool {
        dependencies.iter().all(|dependency| self.clock(&dependency.resource_key) == dependency.clock)
    }
    pub(crate) fn apply(&self, updates: &BTreeMap<String, u64>) -> Self {
        let mut next = self.clone();
        next.clocks.extend(updates.clone());
        next
    }
}

pub(crate) fn affected_resource_keys(
    graph: &GraphGeneration,
    delta: &GraphDelta,
) -> Result<BTreeSet<String>> {
    let mut keys = BTreeSet::new();
    for change in &delta.changes {
        match change {
            GraphChange::UpsertNode { node } => {
                keys.insert(format!("node:{}", node.id));
                if let Some(old) = graph.node(&node.id) { add_node_indexes(&mut keys, old)?; }
                add_node_indexes(&mut keys, node)?;
            }
            GraphChange::DeleteNode { node_id } => {
                keys.insert(format!("node:{node_id}"));
                if let Some(old) = graph.node(node_id) { add_node_indexes(&mut keys, old)?; }
            }
            GraphChange::UpsertReference { reference } => {
                keys.insert(format!("edge:{}", reference.from_node_id));
                if let Some(old) = graph.reference_from(&reference.from_node_id) {
                    keys.insert(format!("references-to:{}", old.to_node_id));
                }
                keys.insert(format!("references-to:{}", reference.to_node_id));
            }
            GraphChange::DeleteReference { from_node_id } => {
                keys.insert(format!("edge:{from_node_id}"));
                if let Some(old) = graph.reference_from(from_node_id) {
                    keys.insert(format!("references-to:{}", old.to_node_id));
                }
            }
        }
    }
    Ok(keys)
}

fn add_node_indexes(keys: &mut BTreeSet<String>, node: &NodeRecord) -> Result<()> {
    let parent = node.parent_id.as_deref().unwrap_or("root");
    keys.insert(format!("children:{parent}"));
    let payload: serde_json::Value = serde_json::from_str(&node.payload)
        .with_context(|| format!("node {} payload is not JSON", node.id))?;
    if let Some(name) = payload.get("name").and_then(serde_json::Value::as_str) {
        keys.insert(format!("namespace:{parent}:{name}"));
        keys.insert(format!("absence:{}:{parent}:{name}", node.kind));
    }
    Ok(())
}
```

Add read-only `GraphGeneration::node` and `reference_from` accessors returning borrowed records.

- [ ] **Step 4: Persist clocks and load the in-memory projection**

Add `RESOURCE_CLOCKS: TableDefinition<&str, u64>` and create it in schema initialization. Add durable methods `resource_clocks() -> Result<BTreeMap<String, u64>>` and `next_resource_clock_updates(keys)`, using checked addition. Extend `CoordinatedCommit` with:

```rust
pub resource_clock_updates: BTreeMap<String, u64>,
```

Inside the existing redb write transaction, validate every update is exactly `current + 1`, write it before `commit()`, and include a feature failpoint immediately after clock writes. Load the table into `Kernel.resource_clocks: RwLock<Arc<ResourceClockSnapshot>>` on create/open and replace the projection only after redb commit succeeds.

- [ ] **Step 5: Run focused and regression tests**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_resources`

Expected: PASS for all six resource classes, repeated increments, and reopen.

Run: `cargo test -p strata-kernel --features redb-spike-api --test storage_atomic --test recovery`

Expected: PASS with pre-clock databases opening as an empty clock map.

- [ ] **Step 6: Commit durable resource clocks**

```bash
git add crates/strata-kernel
git commit -m "feat(kernel): add durable resource clocks"
```

---

### Task 3: Centralize Fresh Readiness Behind an Optimistic Planner

**Files:**
- Create: `crates/strata-kernel/src/coordination/planner.rs`
- Create: `crates/strata-kernel/tests/coordination_planner.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/coordination/authority.rs`
- Modify: `crates/strata-kernel/src/coordination/durable.rs:53-82,540-1057,1206-1218`
- Modify: `crates/strata-kernel/src/coordination/scheduler.rs:9-315,414-500`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs:138-250,252-396,403-631,1067-1250`

**Interfaces:**
- Produces: `AuthorityPlan`, `PlannerSnapshot`, `ReadinessPlan`, `TransitionCause`, `Kernel::plan_and_apply_readiness`, and `MAX_OPTIMISTIC_RETRIES = 3`.
- Consumes: a graph snapshot, scheduler clone/revision, durable typed intents, provider, logical tick, and optional blocking event.

- [ ] **Step 1: Add a table-driven failing lifecycle test**

```rust
#![cfg(feature = "coordination-test-api")]

#[test]
fn every_ready_transition_uses_fresh_analysis() {
    for cause in [
        TestCause::Submission,
        TestCause::Reconsideration,
        TestCause::Restart,
    ] {
        let fixture = PlannerFixture::for_cause(cause);
        let before_calls = fixture.provider.calls();
        let offer = fixture.trigger_and_offer();
        assert!(fixture.provider.calls() > before_calls, "{cause:?}");
        assert_eq!(offer.scope_fingerprint, fixture.provider.latest_scope_fingerprint());
        assert_eq!(offer.graph_generation, fixture.kernel.snapshot().generation());
    }
}
```

Also add `ready_offer_cannot_be_constructed_outside_planner` as a trybuild case under the research feature or a crate unit test proving `SchedulerState::mark_ready` is private to `planner.rs`.

- [ ] **Step 2: Run the planner test and confirm stale paths**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_planner`

Expected: FAIL for restart, reconsideration, or another current ad hoc Ready path without a fresh provider call.

- [ ] **Step 3: Add authority plans and scheduler revisions**

Define:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityPlan {
    pub scope: InferredScope,
    pub dependency_keys: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransitionCause {
    Submission,
    Publication,
    Cancellation,
    OfferExpiry,
    ClaimExpiry,
    ClaimRejection,
    Reconsideration,
    Restart,
}

pub(crate) const MAX_OPTIMISTIC_RETRIES: u32 = 3;
```

Extend `CoordinationMetadataState` with `scheduler_revision: u64`. Every durable lifecycle transition that changes a change set, ticket, offer, or claim must assert `expected_metadata.scheduler_revision` and increment `next_metadata.scheduler_revision` exactly once. Add the same revision to `SchedulerState`, restoring it from durable metadata on open.

- [ ] **Step 4: Implement the only Ready planner**

Create these plan records in `planner.rs`:

```rust
pub(crate) struct PlannerSnapshot {
    pub graph: Arc<GraphGeneration>,
    pub scheduler: SchedulerState,
    pub scheduler_revision: u64,
    pub now_tick: u64,
    pub cause: TransitionCause,
    pub blocking_event_sequence: Option<u64>,
}

pub(crate) struct PlannedOffer {
    pub ticket_before: CoordinationTicket,
    pub ticket_after: CoordinationTicket,
    pub change_set_before: ChangeSetRecord,
    pub change_set_after: ChangeSetRecord,
    pub offer: ReadyOffer,
}

pub(crate) struct ReadinessPlan {
    pub expected_graph_generation: u64,
    pub expected_scheduler_revision: u64,
    pub next_scheduler: SchedulerState,
    pub offers: Vec<PlannedOffer>,
    pub requeued: Vec<(ChangeSetRecord, ChangeSetRecord)>,
    pub needs_decision: Vec<(ChangeSetRecord, ChangeSetRecord)>,
}
```

`plan_readiness` clones eligible queued records, calls the provider without locks, persists the fresh scope plus clock dependencies, applies expansion policy, runs FIFO/all-or-ticket selection, and creates offers with `expires_at_tick = now_tick + READY_OFFER_TTL_TICKS`. Move `make_offer` into this file and make `SchedulerState::mark_ready` `pub(super)` with a comment naming `planner.rs` as its sole caller.

`Kernel::plan_and_apply_readiness` follows this bounded loop:

```rust
for _ in 0..MAX_OPTIMISTIC_RETRIES {
    let snapshot = self.capture_planner_snapshot(now_tick, cause, blocking_event_sequence)?;
    let plan = plan_readiness(self.semantic_provider()?, snapshot, &self.store.coordination())?;
    let mut scheduler = self
        .scheduler
        .lock()
        .map_err(|_| anyhow::anyhow!("scheduler lock is poisoned"))?;
    if self.snapshot().generation() != plan.expected_graph_generation
        || scheduler.revision() != plan.expected_scheduler_revision
    {
        continue;
    }
    self.store.coordination().persist_lifecycle(&plan.lifecycle_transition()?)?;
    *scheduler = plan.next_scheduler;
    return Ok(plan.offers.into_iter().map(|planned| planned.offer).collect());
}
Err(anyhow::Error::new(CoordinationError::OptimisticRetryExhausted {
    attempts: MAX_OPTIMISTIC_RETRIES,
}))
```

Do not call the provider or create an offer after acquiring the scheduler mutex.

- [ ] **Step 5: Route submission, reconsideration, and recovery through the planner**

Submission first persists a queued ticket and increments the revision, then calls `plan_and_apply_readiness(Submission)`. Reconsideration updates the durable state to queued, then calls the same function. Recovery reconstructs queued work and active reservations but creates no offer; `Kernel::open_with_test_semantics` invokes a post-recovery `plan_and_apply_readiness(Restart)` after the kernel exists and no lock is held.

- [ ] **Step 6: Run planner and scheduler regressions**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_planner --test coordination_lifecycle --test coordination_scheduler`

Expected: PASS; submission, reconsideration, and restart use a fresh provider call, and scheduler revisions reject stale plans. Cancellation, expiry, claim rejection, and publication join the same planner in later tasks.

- [ ] **Step 7: Commit the centralized planner**

```bash
git add crates/strata-kernel
git commit -m "refactor(kernel): centralize fresh readiness planning"
```

---

### Task 4: Add Deterministic Draft, Offer, and Claim Leases

**Files:**
- Create: `crates/strata-kernel/tests/coordination_leases.rs`
- Modify: `crates/strata-kernel/src/coordination/model.rs:209-223,393-491`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs:85-136,252-631`
- Modify: `crates/strata-kernel/src/coordination/durable.rs:168-380,382-547,805-1057`
- Modify: `crates/strata-kernel/src/coordination/planner.rs`
- Modify: `crates/strata-kernel/src/coordination/scheduler.rs:317-500`
- Modify: `crates/strata-kernel/tests/coordination_recovery.rs`

**Interfaces:**
- Produces: `DRAFT_TTL_TICKS`, `CLAIM_TTL_TICKS`, `ClaimHandle.attempt_id`, `ClaimHandle.expires_at_tick`, and `Kernel::expire_leases(now_tick)`.
- Consumes: centralized readiness planner from Task 3.

- [ ] **Step 1: Write failing deterministic lease tests**

```rust
#![cfg(feature = "coordination-test-api")]

#[test]
fn claim_expiry_fences_late_results_and_freshly_wakes_waiters() {
    let fixture = overlapping_claim_fixture();
    let old_claim = fixture.first_claim.clone();
    let outcomes = fixture.kernel.expire_leases(old_claim.expires_at_tick).unwrap();
    assert!(outcomes.iter().any(|outcome| outcome.change_set_id == old_claim.change_set_id));
    assert_eq!(
        fixture.kernel.change_set(&old_claim.change_set_id).unwrap().unwrap().state,
        ChangeSetState::Queued,
    );
    assert!(fixture.kernel.ready_offer_for_change_set(&fixture.waiter_id).unwrap().is_some());

    let error = fixture.kernel.publish_claimed(
        &old_claim,
        &fixture.builder,
        old_claim.expires_at_tick,
    ).unwrap_err();
    assert_eq!(error.downcast_ref::<CoordinationError>(), Some(&CoordinationError::LeaseExpired));
}
```

Add tests for draft expiry retention/event reason, offer expiry, idempotent repeated expiry, restart before/after expiry, cancellation fencing a delayed result, and service-epoch fencing a delayed result.

Add a table-driven provider-call assertion for `Cancellation`, `OfferExpiry`, `ClaimExpiry`, and `ClaimRejection`. For each cause, record the provider call count, trigger the release, assert the count increased, and assert any resulting offer carries the provider's latest scope fingerprint and the current graph generation.

- [ ] **Step 2: Run lease tests and confirm missing expiry behavior**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_leases`

Expected: FAIL because drafts/claims lack expiry ticks and `expire_leases` does not exist.

- [ ] **Step 3: Add durable lease fields and attempt identity**

Add:

```rust
pub const DRAFT_TTL_TICKS: u64 = 120;
pub const CLAIM_TTL_TICKS: u64 = 60;

// ChangeSetRecord additions
#[serde(default)]
pub created_at_tick: u64,
#[serde(default)]
pub expires_at_tick: Option<u64>,

// ClaimHandle additions
#[serde(default)]
pub attempt_id: String,
#[serde(default)]
pub expires_at_tick: u64,
#[serde(default)]
pub dependency_versions: Vec<DependencyVersion>,
```

`begin_change_set` now accepts the existing typed input plus `now_tick`, stores `expires_at_tick = now_tick + DRAFT_TTL_TICKS`, and checked-adds. Claim creation uses a new UUID attempt ID and `now_tick + CLAIM_TTL_TICKS`. Submission clears draft expiry; terminal states clear active authority by deleting offers/claims rather than erasing audit records. Legacy serialized claims are invalidated during epoch recovery before their defaulted lease fields can grant authority; legacy drafts receive a deterministic expiry during recovery and are covered by a reopen test.

- [ ] **Step 4: Implement one atomic expiry sweep**

`Kernel::expire_leases(now_tick)` must:

1. Snapshot due drafts, offers, and claims plus scheduler revision.
2. Build the release/requeue simulation without locks.
3. Call `plan_readiness` with `OfferExpiry` or `ClaimExpiry` on the simulated scheduler.
4. Acquire the scheduler mutex, reject a changed revision, and persist terminal/requeued records, removed authority, `LeaseExpired` events, and fresh offers in one lifecycle transaction.
5. Retry at most `MAX_OPTIMISTIC_RETRIES`.

Use bounded event payloads:

```json
{"authorityKind":"draft","reason":"draft-expired"}
```

```json
{"authorityKind":"claim","reason":"claim-expired","attemptId":"<durable-attempt-id>"}
```

Cancellation and claim rejection must use the same simulated release plus planner path before applying their atomic transition.

- [ ] **Step 5: Make restart recovery lease-aware**

Recovery advances the service epoch, deletes prior offers/claims, requeues reconstructable change sets, preserves terminal and expired draft audit records, emits one recovery/expiry event per transition, and grants no Ready authority until the post-open planner runs. Reopening twice must not append duplicate expiry events.

- [ ] **Step 6: Run lease, recovery, and event tests**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_leases --test coordination_recovery --test coordination_planner`

Expected: PASS with no sleeps and no late publication after cancellation, expiry, or restart.

- [ ] **Step 7: Commit deterministic leases**

```bash
git add crates/strata-kernel
git commit -m "feat(kernel): add deterministic coordination leases"
```

---

### Task 5: Bind Prepared Candidates to Attempts and Digests

**Files:**
- Modify: `crates/strata-kernel/src/coordination/authority.rs`
- Modify: `crates/strata-kernel/src/coordination/model.rs`
- Modify: `crates/strata-kernel/src/coordination/durable.rs`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs`
- Modify: `crates/strata-kernel/src/storage.rs`
- Modify: `crates/strata-kernel/tests/coordination_publication.rs`
- Modify: test builders in `crates/strata-kernel/tests/coordination_acceptance.rs`

**Interfaces:**
- Produces: feature-only `CandidateBuilder`, `PreparedCandidate`, `CandidateEnvelope`, `PublicationAttemptRecord`, `PublishClaimOutcome`, and `canonical_candidate_digest`.
- Consumes: claimed attempt/dependency fields from Task 4.

- [ ] **Step 1: Add failing candidate-binding tests**

```rust
#[test]
fn same_attempt_same_digest_replays_but_changed_digest_is_rejected() {
    let fixture = claimed_fixture();
    let envelope = CandidateEnvelope::from_delta(fixture.delta.clone()).unwrap();
    let PublishClaimOutcome::Published(first) = fixture.kernel.publish_claimed_envelope(
        &fixture.claim,
        envelope.clone(),
        2,
    ).unwrap() else { panic!("first attempt did not publish") };
    let PublishClaimOutcome::Published(replay) = fixture
        .kernel
        .publish_claimed_envelope(&fixture.claim, envelope, 3)
        .unwrap() else { panic!("duplicate attempt did not replay publication") };
    assert_eq!((replay.generation, replay.digest), (first.generation, first.digest));
    assert!(replay.already_published);

    let changed = CandidateEnvelope::from_delta(fixture.other_delta).unwrap();
    let error = fixture.kernel.publish_claimed_envelope(&fixture.claim, changed, 4).unwrap_err();
    assert_eq!(
        error.downcast_ref::<CoordinationError>(),
        Some(&CoordinationError::AttemptDigestMismatch),
    );
}
```

Add a malicious envelope test that supplies a digest for a different delta and expects `CandidateDigestMismatch` before graph or lifecycle state changes.

- [ ] **Step 2: Run the candidate tests and verify failure**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_publication same_attempt_same_digest`

Expected: FAIL because attempt-bound envelopes and durable attempt records do not exist.

- [ ] **Step 3: Define immutable prepared requests and candidate envelopes**

```rust
#[derive(Clone)]
pub struct PreparedCandidate {
    pub change_set: ChangeSetRecord,
    pub intents: Vec<IntentRecord>,
    pub graph: Arc<GraphGeneration>,
    pub attempt_id: String,
    pub scope_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEnvelope {
    pub delta: GraphDelta,
    pub candidate_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublishClaimOutcome {
    Published(PublicationReport),
    Requeued { ticket: CoordinationTicket, event: CoordinationEvent },
    NeedsDecision { change_set: ChangeSetRecord, event: CoordinationEvent },
}

impl CandidateEnvelope {
    pub fn from_delta(delta: GraphDelta) -> anyhow::Result<Self> {
        let candidate_digest = canonical_candidate_digest(&delta)?;
        Ok(Self { delta, candidate_digest })
    }
    pub(crate) fn validate_digest(&self) -> anyhow::Result<()> {
        if canonical_candidate_digest(&self.delta)? != self.candidate_digest {
            return Err(anyhow::Error::new(CoordinationError::CandidateDigestMismatch));
        }
        Ok(())
    }
}

#[cfg(feature = "coordination-test-api")]
pub trait CandidateBuilder: Send + Sync {
    fn build_candidate(&self, prepared: &PreparedCandidate) -> anyhow::Result<CandidateEnvelope>;
}
```

Canonical digest input is `serde_json::to_vec(delta)` with the existing deterministic `GraphDelta` ordering, hashed with SHA-256 and lowercase hex.

- [ ] **Step 4: Add durable attempt identity**

```rust
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationAttemptRecord {
    pub change_set_id: String,
    pub attempt_id: String,
    pub candidate_digest: String,
    pub generation: u64,
    pub graph_digest: String,
}
```

Store it in `coordination_publication_attempts`, keyed by `attempt_id`, and re-export the record only under `coordination-test-api` for recovery assertions. Duplicate lookup rules are exact: missing means proceed; same change set and candidate digest returns the stored result; any different digest or change set returns `AttemptDigestMismatch`. Retain the existing graph idempotency table for legacy redb spike publication.

- [ ] **Step 5: Migrate builders and run publication regressions**

Update feature test builders to accept `&PreparedCandidate` and return `CandidateEnvelope::from_delta`. Ensure builders receive no redb handle, scheduler state, fencing token, resource-clock mutator, or authority constructor.

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_publication`

Expected: PASS for candidate digest validation and attempt replay.

- [ ] **Step 6: Commit attempt-bound candidates**

```bash
git add crates/strata-kernel
git commit -m "feat(kernel): bind candidates to durable attempts"
```

---

### Task 6: Move Candidate Work Outside Locks and Permit Disjoint Publication

**Files:**
- Create: `crates/strata-kernel/src/coordination/publication.rs`
- Create: `crates/strata-kernel/tests/coordination_optimistic.rs`
- Modify: `crates/strata-kernel/src/coordination/mod.rs`
- Modify: `crates/strata-kernel/src/coordination/coordinator.rs:638-1065` (remove moved implementation)
- Modify: `crates/strata-kernel/src/coordination/authority.rs`
- Modify: `crates/strata-kernel/src/coordination/planner.rs`
- Modify: `crates/strata-kernel/src/coordination/resources.rs`
- Modify: `crates/strata-kernel/src/kernel.rs:44-50`
- Modify: `crates/strata-kernel/src/storage.rs:41-46,221-279`

**Interfaces:**
- Produces: `Kernel::publish_claimed`, `Kernel::publish_claimed_envelope`, and private `PreparedPublication`; consumes `MAX_OPTIMISTIC_RETRIES = 3` and `PublishClaimOutcome` from earlier tasks.
- Consumes: claim attempts/dependencies, candidate envelopes, resource clocks, and readiness plans.

- [ ] **Step 1: Add the two falsifying concurrency tests first**

```rust
#![cfg(feature = "coordination-test-api")]

#[test]
fn two_disjoint_claims_captured_before_publication_both_commit_in_either_order() {
    for order in [[0usize, 1usize], [1usize, 0usize]] {
        let fixture = disjoint_claim_fixture();
        assert_eq!(fixture.claims[0].graph_generation, 0);
        assert_eq!(fixture.claims[1].graph_generation, 0);
        let PublishClaimOutcome::Published(first) = fixture.kernel.publish_claimed(
            &fixture.claims[order[0]], &fixture.builders[order[0]], 2,
        ).unwrap() else { panic!("first disjoint claim did not publish") };
        let PublishClaimOutcome::Published(second) = fixture.kernel.publish_claimed(
            &fixture.claims[order[1]], &fixture.builders[order[1]], 3,
        ).unwrap() else { panic!("second disjoint claim did not publish") };
        assert_eq!((first.generation, second.generation), (1, 2));
        assert_eq!(fixture.kernel.snapshot().generation(), 2);
    }
}

#[test]
fn blocking_builder_does_not_block_disjoint_lifecycle_or_event_replay() {
    let fixture = blocking_builder_fixture();
    let worker = fixture.spawn_blocked_publication();
    fixture.builder.wait_until_entered();
    fixture.kernel.submit_change_set(&fixture.disjoint_change_set_id, 4).unwrap();
    fixture.kernel.cancel_change_set(&fixture.other_change_set_id, 5).unwrap();
    fixture.kernel.expire_leases(6).unwrap();
    assert!(!fixture.kernel.events_after("observer", 0, 100).unwrap().is_empty());
    fixture.builder.release();
    worker.join().unwrap().unwrap();
}
```

Add `catch_unwind` coverage showing a panicking builder leaves its claim durably active until explicit abandonment/expiry while disjoint APIs remain usable.

Add a publication-release case that queues an overlapping successor, records the provider call count, publishes the blocker, and asserts the successor's new offer was created only after a fresh post-publication analysis on the committed graph.

- [ ] **Step 2: Run the tests and reproduce both integrated failures**

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_optimistic`

Expected before the rewrite: the second disjoint publication is rejected as stale, and the blocked builder prevents at least one lifecycle call from completing.

- [ ] **Step 3: Implement unlocked prepare/build**

`capture_prepared_candidate` briefly locks only the scheduler and clones the durable claim, ticket, change set, intents, graph, clock projection, scheduler revision, scope, dependencies, attempt, epoch, and lease. It releases the lock before returning `PreparedCandidate`.

Use this private publication record so all final checks are explicit:

```rust
pub(crate) struct PreparedPublication {
    pub expected_graph_generation: u64,
    pub expected_scheduler_revision: u64,
    pub expected_service_epoch: u64,
    pub claim: ClaimHandle,
    pub envelope: CandidateEnvelope,
    pub dependency_versions: Vec<DependencyVersion>,
    pub next_graph: Arc<GraphGeneration>,
    pub next_scheduler: SchedulerState,
    pub lifecycle: LifecycleTransition,
    pub resource_clock_updates: BTreeMap<String, u64>,
    pub attempt_record: PublicationAttemptRecord,
    pub operation: OperationRecord,
}
```

Run the builder as:

```rust
let envelope = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    builder.build_candidate(&prepared.request)
}))
.map_err(|_| anyhow::anyhow!("candidate builder panicked"))??;
envelope.validate_digest()?;
validate_delta_containment(
    &prepared.request.graph,
    &envelope.delta,
    &prepared.scope,
)?;
```

No mutex guard may be live across this block. Add a debug-only test hook that asserts `try_lock()` succeeds for both mutexes from inside the builder.

- [ ] **Step 4: Implement optimistic reanalysis and rebasing**

For each of three attempts:

1. Capture current graph, scheduler revision, claim, clock projection, and lease without holding the publication mutex.
2. Reject epoch/attempt/lease changes.
3. If any recorded dependency clock changed, atomically release the claim and invoke the planner with `ClaimRejection`; return the resulting `Requeued` or `NeedsDecision` outcome.
4. Run trusted semantic reanalysis and successor readiness planning outside locks.
5. Clone the candidate delta and set `base_generation = current_graph.generation()`.
6. Re-run schema, containment, dependency augmentation, `GraphGeneration::apply`, and digest preparation.
7. Acquire publication mutex then scheduler mutex.
8. Recheck graph generation, scheduler revision, service epoch, exact durable claim, attempt, lease, dependency clocks, candidate digest, scope fingerprint, containment, and attempt idempotency.
9. If graph or scheduler changed, release both locks and retry. If only unrelated graph resources changed, the next iteration rebases and proceeds.
10. Open the redb write transaction only after all checks pass.

Return `CoordinationError::OptimisticRetryExhausted { attempts: 3 }` after the third lost race.

- [ ] **Step 5: Atomically handle dependency invalidation**

The invalidation transition removes the old claim, fences the attempt, sets the change set to `Queued` or `NeedsDecision` according to the fresh `ScopeChange` and expansion policy, updates the ticket, appends `ScopeExpanded` or `IntentNeedsDecision`, and applies fresh successor offers from the centralized planner. It must never return while the durable change set remains `Executing` without an active valid claim.

- [ ] **Step 6: Prove every dependency class invalidates affected work**

Add one table-driven test case for `node`, `edge`, `children`, `references-to`, `namespace`, and `absence` keys. Each case claims work, publishes an overlapping clock change from another ticket, then returns the stale candidate. Assert the stale attempt cannot publish and ends in `Queued` or `NeedsDecision`. Add a control case where an unrelated clock changes and the candidate publishes after rebase.

Run: `cargo test -p strata-kernel --features coordination-test-api --test coordination_optimistic --test coordination_publication --test coordination_acceptance`

Expected: PASS, including simultaneous disjoint claims and unlocked builder progress.

- [ ] **Step 7: Commit optimistic publication**

```bash
git add crates/strata-kernel
git commit -m "fix(kernel): publish disjoint claims optimistically"
```

---

### Task 7: Prove Atomic Clocks, Attempts, Lifecycle, and Crash Recovery

**Files:**
- Modify: `crates/strata-kernel/src/storage.rs:221-328`
- Modify: `crates/strata-kernel/src/coordination/durable.rs:805-1057`
- Modify: `crates/strata-kernel/src/coordination/publication.rs`
- Modify: `crates/strata-kernel/tests/coordination_publication.rs:777-862`
- Modify: `crates/strata-kernel/tests/coordination_recovery.rs`
- Modify: `crates/strata-kernel/tests/crash_recovery.rs`

**Interfaces:**
- Produces: complete-old-or-complete-new coordinated commit across graph, clocks, attempts, operations, tickets, events, fences, and scheduler metadata.
- Consumes: `PreparedPublication` from Task 6.

- [ ] **Step 1: Expand failpoint tests before storage changes**

Extend the coordinated failpoint enum with `AfterResourceClockWrite` and `AfterAttemptWrite`. For every failpoint from fence mutation through before-commit, test:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
struct AtomicState {
    graph_generation: u64,
    graph_digest: String,
    operation_count: u64,
    graph_event_count: u64,
    coordination_event_count: usize,
    change_set_state: ChangeSetState,
    ticket_state: TicketState,
    has_offer: bool,
    has_claim: bool,
    scheduler_revision: u64,
    resource_clocks: BTreeMap<String, u64>,
    attempt: Option<PublicationAttemptRecord>,
    fence_states: BTreeMap<String, (Option<u64>, Option<u64>)>,
    live_generation: u64,
    live_digest: String,
    live_resource_clocks: BTreeMap<String, u64>,
}

drop(kernel);
let (reopened, _) = Kernel::open_with_test_semantics(&path, fixture_provider()).unwrap();
let observed = AtomicState::read(&reopened, &resource_keys, &attempt_id).unwrap();
assert!(observed == complete_old_state || observed == complete_new_state, "{failpoint:?}");
```

Implement `AtomicState::read` with the existing feature-only table-count, fence-state, event replay, snapshot, and new clock/attempt accessors. Construct `complete_old_state` before publication and `complete_new_state` from a no-failpoint control publication using the same fixture.

- [ ] **Step 2: Run failpoint tests and observe partial new fields**

Run: `cargo test -p strata-kernel --features redb-spike-api --test coordination_publication failure_after`

Expected: FAIL until clocks and attempt identity are written inside the same transaction and restored on reopen.

- [ ] **Step 3: Complete the single redb transaction**

Use this order inside `publish_coordinated` while retaining redb atomicity:

1. Check attempt replay/mismatch.
2. Validate current graph generation and expected digest.
3. Validate and consume fences.
4. Validate/increment resource clocks.
5. Write graph delta, operation, graph event, ticket, generation digest, and current generation.
6. Persist coordination lifecycle and scheduler revision.
7. Write the publication attempt record.
8. Execute `BeforeCommit` failpoint.
9. Commit once.

On `AlreadyPublished`, return the original attempt record's generation and graph digest, not the current generation. Update in-memory graph, clock projection, and scheduler only after redb commit. A process crash after commit is recovered entirely from durable state.

- [ ] **Step 4: Add corruption and restart assertions**

Add reopen tests that reject a missing resource clock referenced by a nonzero dependency, a changed attempt digest for the same attempt ID, and a durable scheduler revision older than the latest lifecycle transition. Preserve compatibility with pre-clock databases by treating an entirely absent clock table as all-zero only before the first coordinated clocked publication.

- [ ] **Step 5: Run all Rust correctness suites**

Run: `cargo fmt --all -- --check`

Expected: PASS.

Run: `cargo clippy -p strata-kernel --all-targets -- -D warnings`

Expected: PASS.

Run: `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings`

Expected: PASS.

Run: `cargo test -p strata-kernel`

Expected: PASS for the default sealed surface and non-provider suites.

Run: `cargo test -p strata-kernel --features redb-spike-api`

Expected: PASS for all deterministic coordination, failpoint, replay, fencing, and recovery suites.

- [ ] **Step 6: Commit atomic recovery proof**

```bash
git add crates/strata-kernel
git commit -m "test(kernel): prove atomic optimistic recovery"
```

---

### Task 8: Run the Full Correction Gate and Restore PASS Only After Review

**Files:**
- Verify: `crates/strata-kernel/tests/coordination_acceptance.rs`
- Verify: `crates/strata-kernel/tests/coordination_authority.rs`
- Verify: `crates/strata-kernel/tests/coordination_planner.rs`
- Verify: `crates/strata-kernel/tests/coordination_leases.rs`
- Verify: `crates/strata-kernel/tests/coordination_optimistic.rs`
- Modify only after all gates and whole-branch review pass: `decisions.md`
- Modify only after all gates and whole-branch review pass: `docs/product-roadmap.md`
- Create only after all gates and whole-branch review pass: `docs/spikes/2026-07-14-coordination-scheduler-correction.md`
- Preserve as historical evidence: `docs/spikes/2026-07-14-coordination-scheduler.md`

**Interfaces:**
- Produces: one deterministic acceptance matrix and an evidence-backed decision on whether the Coordination kernel roadmap gate can be restored.
- Consumes: every correction task and existing TypeScript workspace regressions.

- [ ] **Step 1: Audit the acceptance harness against the falsifying scenarios**

Confirm the focused suites and `coordination_acceptance.rs` collectively execute all eight scenarios on the ingest-derived `examples/medium` graph: default authority sealing; two claims taken before either publishes; affected dependency invalidation; lifecycle progress during a blocked builder; fresh analysis on every release path; expiry/restart fencing; same-attempt digest replay and mismatch rejection; and complete-old-or-complete-new failpoint reopen. Each scenario must assert durable and in-memory end state, not merely an error string or provider call count. Move any fixture still using a toy graph to the committed `examples-medium.snapshot.json` fixture before running the gate.

Do not claim production TypeScript semantic coverage; the provider remains a feature-gated deterministic test implementation over the real ingest-derived graph.

- [ ] **Step 2: Run the complete deterministic gate**

Run in order:

```bash
cargo fmt --all -- --check
cargo clippy -p strata-kernel --all-targets -- -D warnings
cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings
cargo test -p strata-kernel
cargo test -p strata-kernel --features redb-spike-api
pnpm --filter @strata/ingest build
pnpm --filter @strata/ingest test
pnpm -r build
pnpm -r test
```

Expected: every Rust, ingest, and build command passes. For `pnpm -r test`, compare any failure to the documented pre-existing `@strata/verify` TS2454 baseline at `extractFunctionCommit.test.ts:228`; any new failure blocks PASS.

- [ ] **Step 3: Request task-scoped and whole-branch reviews**

Use `requesting-code-review` after each implementation task. After the full gate, obtain a fresh whole-branch review specifically asking the reviewer to falsify:

- default semantic authority sealing;
- simultaneous disjoint claim publication;
- absence of builder/provider work under global locks;
- centralized fresh Ready creation;
- lease fencing and non-stranded `Executing` state;
- atomic clock/attempt/lifecycle durability;
- scope boundaries against bridge, transport, and live-model creep.

Resolve every Critical or Important finding and rerun the complete gate. The final review must inspect the integrated diff from `8422f4e` through the correction head, not only the last task.

- [ ] **Step 4: Obtain the required independent architecture review**

Use the `delegating-to-codex` skill with `gpt-5.6-sol`, reasoning `xhigh`, read-only. Supply the approved correction design, falsified prior evidence, implementation diff, acceptance results, and hard boundaries. Verify every pivotal empirical claim it makes against code or tests before accepting it.

- [ ] **Step 5: Record the decision without overstating the proof**

If and only if the deterministic gate and both reviews pass, append a new top decision restoring the bounded scheduler PASS. The entry must say that production TypeScript semantics, the worker bridge, transport/authentication, full two-operation proof, and live comparison remain blocked. Recheck only the **Coordination kernel** roadmap item and create the correction evidence report with exact commands, toolchain versions, test counts, commit SHA, failure exceptions, and the eight acceptance rows.

If a correction invariant fails, keep the roadmap item unchecked, append a decision describing the falsified assumption, and stop before bridge or live-model work.

- [ ] **Step 6: Commit the final evidence state**

```bash
git add decisions.md docs/product-roadmap.md docs/spikes
git commit -m "docs(kernel): record scheduler correction result"
```

Run: `git status --short`

Expected: no output.
