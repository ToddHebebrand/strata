//! Daemon-side published-sync state for the persistent bridge mirror
//! (bridge-persistence slice, Task 6).
//!
//! Owns two things, behind one mutex (mirroring the kernel's lock discipline —
//! coarse `Mutex`/`RwLock` around whole-state transitions, no lock-free
//! cleverness):
//!
//! - the **current PUBLISHED graph identity**: generation, the kernel's
//!   canonical graph digest (`GraphGeneration::digest`, used for the
//!   structural routing predicate — review B2: a request may touch the mirror
//!   ONLY if its graph identity equals this published identity), and the
//!   canonical sync digest (`sync_digest.rs`, the wire attestation identity),
//!   plus an `Arc` of the published generation itself so full-hydrate frames
//!   never re-read storage;
//! - the **`DeltaLog`**: one entry per published generation step, appended
//!   ONLY from the publication path after `PublishOutcome::Published` AND the
//!   in-memory publication swap (`publication.rs`), never coalesced or
//!   reordered. Speculative graphs (readiness planning against an unpublished
//!   `next`) never enter this log — that is the load-bearing half of the B2
//!   invariant, gated by the speculative-publication failpoint test.
//!
//! Sync reads extract an **owned** contiguous batch under the lock: once a
//! batch is captured for an in-flight sync, later appends/evictions cannot
//! mutate it (append-during-sync truncation gate).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use super::persistent::GraphIdentity;
use super::protocol::{WireGraphDelta, WireSnapshot};
use crate::sync_digest::canonical_sync_digest_refs;
use crate::{GraphDelta, GraphGeneration};

/// Pre-registered `DeltaLog` entry cap (plan v2, Shared vocabulary): at most
/// 4096 retained published deltas, front-evicted. Do not tune without a
/// decisions.md entry — the value is part of the recorded slice contract.
pub(crate) const DELTA_LOG_MAX_ENTRIES: usize = 4096;

/// Pre-registered `DeltaLog` serialized-size cap (plan v2, Shared
/// vocabulary): at most 16 MiB of serialized delta JSON retained, whichever
/// of the two caps trips first, front-evicted. Same contract note as above.
pub(crate) const DELTA_LOG_MAX_SERIALIZED_BYTES: usize = 16 * 1024 * 1024;

/// Safety margin subtracted from the request frame bound when deciding
/// whether a delta batch fits ONE sync request frame: the frame also carries
/// base/target identities, the requestId, and JSON structure around the
/// deltas. A batch that does not fit falls back to full hydration.
const SYNC_FRAME_OVERHEAD_MARGIN: usize = 1024 * 1024;

/// One published generation step: the exact delta the daemon applied at
/// publication (`CanonicalDelta` — serialized once, canonically, in the wire
/// `KernelGraphDeltaV1` shape both languages share) and the canonical sync
/// digest of the graph AFTER applying it.
#[derive(Clone, Debug)]
pub(crate) struct DeltaLogEntry {
    pub(crate) generation: u64,
    /// Serialized wire-shape delta JSON. `Arc<str>` so captured batches are
    /// owned (cheaply) and immune to log eviction.
    pub(crate) delta_json: Arc<str>,
    /// Canonical sync digest of the post-apply graph — the target the worker
    /// must attest after applying this entry.
    pub(crate) digest_after: String,
}

/// Bounded, contiguous, forward-only log of published deltas. Invariant:
/// entry generations are strictly consecutive (`front.generation ..= back`),
/// enforced by the single append site resetting on any discontinuity.
#[derive(Debug, Default)]
pub(crate) struct DeltaLog {
    entries: VecDeque<DeltaLogEntry>,
    total_serialized_bytes: usize,
}

impl DeltaLog {
    fn clear(&mut self) {
        self.entries.clear();
        self.total_serialized_bytes = 0;
    }

    fn append(&mut self, entry: DeltaLogEntry) {
        if let Some(back) = self.entries.back()
            && entry.generation != back.generation + 1
        {
            // Discontinuity can only mean a bug upstream; a gapped log could
            // silently serve an unsound batch, so drop history instead.
            self.clear();
        }
        self.total_serialized_bytes = self
            .total_serialized_bytes
            .saturating_add(entry.delta_json.len());
        self.entries.push_back(entry);
        while self.entries.len() > DELTA_LOG_MAX_ENTRIES
            || self.total_serialized_bytes > DELTA_LOG_MAX_SERIALIZED_BYTES
        {
            let Some(evicted) = self.entries.pop_front() else {
                self.total_serialized_bytes = 0;
                break;
            };
            self.total_serialized_bytes = self
                .total_serialized_bytes
                .saturating_sub(evicted.delta_json.len());
        }
    }

    /// The owned contiguous batch covering `base_generation`(exclusive) to
    /// `target_generation`(inclusive), or `None` when the retained floor is
    /// above `base_generation + 1` (or the head below the target). Cloned
    /// entries share the `Arc<str>` payloads, so the batch stays valid across
    /// any later append/eviction.
    fn batch(&self, base_generation: u64, target_generation: u64) -> Option<Vec<DeltaLogEntry>> {
        if base_generation >= target_generation {
            return None;
        }
        let first_needed = base_generation.checked_add(1)?;
        let front = self.entries.front()?.generation;
        let back = self.entries.back()?.generation;
        if front > first_needed || back < target_generation {
            return None;
        }
        let skip = usize::try_from(first_needed - front).ok()?;
        let take = usize::try_from(target_generation - base_generation).ok()?;
        let batch: Vec<DeltaLogEntry> =
            self.entries.iter().skip(skip).take(take).cloned().collect();
        debug_assert_eq!(batch.first().map(|entry| entry.generation), Some(first_needed));
        debug_assert_eq!(
            batch.last().map(|entry| entry.generation),
            Some(target_generation)
        );
        Some(batch)
    }

    fn generations(&self) -> Vec<u64> {
        self.entries.iter().map(|entry| entry.generation).collect()
    }
}

/// The current published identity plus the published generation itself.
struct PublishedState {
    generation: u64,
    /// `GraphGeneration::digest` — the daemon-internal identity used by the
    /// structural routing predicate (cheap: already computed per generation).
    graph_digest: String,
    /// Canonical sync digest — the wire attestation identity.
    sync_digest: String,
    graph: Arc<GraphGeneration>,
}

struct SyncSharedState {
    published: PublishedState,
    log: DeltaLog,
}

/// Shared between the [`crate::Kernel`] (single writer, from the publication
/// path under the publish lock) and the persistent bridge router (readers).
pub(crate) struct SyncShared {
    state: Mutex<SyncSharedState>,
}

fn lock_state(state: &Mutex<SyncSharedState>) -> MutexGuard<'_, SyncSharedState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn published_state_of(graph: Arc<GraphGeneration>) -> PublishedState {
    PublishedState {
        generation: graph.generation(),
        graph_digest: graph.digest().to_owned(),
        sync_digest: canonical_sync_digest_refs(
            graph.generation(),
            graph.nodes(),
            graph.references(),
        ),
        graph,
    }
}

impl SyncShared {
    /// Seeds the published identity from the seed/recovery-time graph, so the
    /// log's base identity is known before any delta is appended (the plan's
    /// "record the digest for generation 0 at seed/recovery time").
    pub(crate) fn seed(graph: Arc<GraphGeneration>) -> Self {
        Self {
            state: Mutex::new(SyncSharedState {
                published: published_state_of(graph),
                log: DeltaLog::default(),
            }),
        }
    }

    /// Records one published generation step. Called from the publication
    /// path ONLY after `PublishOutcome::Published` and the in-memory swap,
    /// with `next` the newly live graph and `delta` the exact delta that was
    /// durably committed and applied.
    ///
    /// Infallible by contract: the publication is already durable and live,
    /// so a failure here (delta serialization) must not fail the publication.
    /// On any internal failure or continuity break the log is dropped and the
    /// identity reseeded from `next` — future syncs full-hydrate, which is
    /// always sound.
    pub(crate) fn record_published(&self, next: &Arc<GraphGeneration>, delta: &GraphDelta) {
        let digest_after = canonical_sync_digest_refs(
            next.generation(),
            next.nodes(),
            next.references(),
        );
        let serialized = WireGraphDelta::from_graph_delta(delta)
            .and_then(|wire| serde_json::to_string(&wire).context("serialize published delta"));
        let mut state = lock_state(&self.state);
        let contiguous = delta.base_generation == state.published.generation
            && next.generation() == state.published.generation + 1;
        match serialized {
            Ok(delta_json) if contiguous => {
                state.log.append(DeltaLogEntry {
                    generation: next.generation(),
                    delta_json: Arc::from(delta_json.as_str()),
                    digest_after: digest_after.clone(),
                });
            }
            _ => {
                // Serialization failure or continuity break: hydrate-only
                // until the log rebuilds from subsequent publications.
                state.log.clear();
            }
        }
        state.published = PublishedState {
            generation: next.generation(),
            graph_digest: next.digest().to_owned(),
            sync_digest: digest_after,
            graph: next.clone(),
        };
    }

    /// The structural routing predicate (review B2): does `(generation,
    /// graph_digest)` name the current PUBLISHED generation? Returns the wire
    /// sync identity to attest against when it does. Speculative graphs
    /// (readiness planning against an unpublished `next`) can never match —
    /// their generation/digest pair is not the published one.
    pub(crate) fn published_sync_identity(
        &self,
        generation: u64,
        graph_digest: &str,
    ) -> Option<GraphIdentity> {
        let state = lock_state(&self.state);
        (state.published.generation == generation && state.published.graph_digest == graph_digest)
            .then(|| GraphIdentity {
                generation: state.published.generation,
                digest: state.published.sync_digest.clone(),
            })
    }

    /// The current published wire identity (for eager hydration).
    pub(crate) fn current_sync_identity(&self) -> GraphIdentity {
        let state = lock_state(&self.state);
        GraphIdentity {
            generation: state.published.generation,
            digest: state.published.sync_digest.clone(),
        }
    }

    /// Plans the sync frame for a stale worker (the host's [`super::persistent::SyncPlanner`]
    /// seam). Outcomes:
    /// - attested and contiguously covered by the log, batch fits one request
    ///   frame → `kind:"sync"` frame with the exact delta batch;
    /// - no attestation, below the retention floor, same-generation digest
    ///   divergence, or an oversized batch → `kind:"hydrate"` full-snapshot
    ///   frame to the exact target (only while the target IS still the
    ///   published identity — a raced target fails and the request is served
    ///   one-shot);
    /// - worker attestation AHEAD of the target (bug-only) → error WITHOUT
    ///   any frame: forward-only, the mirror must not be rolled back; the
    ///   caller serves that request one-shot.
    pub(crate) fn plan_sync_frame(
        &self,
        attested: Option<&GraphIdentity>,
        target: &GraphIdentity,
        max_request_bytes: usize,
    ) -> Result<Value> {
        let state = lock_state(&self.state);
        if let Some(attested) = attested {
            if attested.generation > target.generation {
                bail!(
                    "worker attestation (generation {}) is ahead of the requested identity \
                     (generation {}); forward-only sync refuses to roll the mirror back — \
                     serve this request one-shot",
                    attested.generation,
                    target.generation
                );
            }
            if attested.generation < target.generation
                && let Some(batch) = state.log.batch(attested.generation, target.generation)
            {
                let batch_bytes: usize =
                    batch.iter().map(|entry| entry.delta_json.len()).sum();
                if batch_bytes.saturating_add(SYNC_FRAME_OVERHEAD_MARGIN) <= max_request_bytes {
                    debug_assert_eq!(
                        batch.last().map(|entry| entry.digest_after.as_str()),
                        Some(target.digest.as_str()),
                        "delta-log target digest must match the requested identity"
                    );
                    let deltas = batch
                        .iter()
                        .map(|entry| {
                            serde_json::from_str::<Value>(&entry.delta_json)
                                .context("re-parse logged delta JSON")
                        })
                        .collect::<Result<Vec<_>>>()?;
                    return Ok(json!({
                        "kind": "sync",
                        "base": identity_value(attested),
                        "target": identity_value(target),
                        "deltas": deltas,
                    }));
                }
            }
        }

        // Full hydration to the exact target — only sound while the target is
        // still the published identity (the snapshot below IS that graph).
        if state.published.generation != target.generation
            || state.published.sync_digest != target.digest
        {
            bail!(
                "sync target generation {} is no longer the published identity \
                 (published generation {}); serve this request one-shot",
                target.generation,
                state.published.generation
            );
        }
        let snapshot = WireSnapshot::from_graph_snapshot(&state.published.graph.snapshot())?;
        let snapshot_value =
            serde_json::to_value(&snapshot).context("encode hydrate snapshot frame")?;
        Ok(json!({
            "kind": "hydrate",
            "target": identity_value(target),
            "snapshot": snapshot_value,
        }))
    }

    /// Test observability: `(published generation, published sync digest,
    /// retained log generations)`.
    #[cfg(feature = "coordination-test-api")]
    pub(crate) fn test_state(&self) -> (u64, String, Vec<u64>) {
        let state = lock_state(&self.state);
        (
            state.published.generation,
            state.published.sync_digest.clone(),
            state.log.generations(),
        )
    }
}

fn identity_value(identity: &GraphIdentity) -> Value {
    json!({
        "generation": identity.generation.to_string(),
        "digest": identity.digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GraphChange, GraphSnapshot, NodeRecord, SCHEMA_VERSION};

    fn node(id: &str, payload: &str) -> NodeRecord {
        NodeRecord {
            id: id.into(),
            kind: "Module".into(),
            parent_id: None,
            child_index: None,
            payload: payload.into(),
        }
    }

    fn graph(generation: u64, payload: &str) -> Arc<GraphGeneration> {
        Arc::new(
            GraphGeneration::from_snapshot(GraphSnapshot {
                schema_version: SCHEMA_VERSION,
                generation,
                nodes: vec![node("m", payload)],
                references: vec![],
            })
            .unwrap(),
        )
    }

    fn upsert_delta(base_generation: u64, payload: &str) -> GraphDelta {
        GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation,
            changes: vec![GraphChange::UpsertNode {
                node: node("m", payload),
            }],
        }
    }

    fn entry(generation: u64, bytes: usize) -> DeltaLogEntry {
        DeltaLogEntry {
            generation,
            delta_json: Arc::from("x".repeat(bytes).as_str()),
            digest_after: format!("digest-{generation}"),
        }
    }

    fn shared_at_generation(head: u64) -> (SyncShared, Vec<Arc<GraphGeneration>>) {
        let base = graph(0, "src/m.ts#0");
        let shared = SyncShared::seed(base.clone());
        let mut graphs = vec![base];
        for step in 0..head {
            let payload = format!("src/m.ts#{}", step + 1);
            let delta = upsert_delta(step, &payload);
            let next = Arc::new(graphs.last().unwrap().apply(&delta).unwrap());
            shared.record_published(&next, &delta);
            graphs.push(next);
        }
        (shared, graphs)
    }

    fn identity_of(graph: &GraphGeneration) -> GraphIdentity {
        GraphIdentity {
            generation: graph.generation(),
            digest: canonical_sync_digest_refs(
                graph.generation(),
                graph.nodes(),
                graph.references(),
            ),
        }
    }

    const GENEROUS_REQUEST_BYTES: usize = 32 * 1024 * 1024;

    #[test]
    fn entry_cap_evicts_from_the_front() {
        let mut log = DeltaLog::default();
        for generation in 1..=(DELTA_LOG_MAX_ENTRIES as u64 + 8) {
            log.append(entry(generation, 4));
        }
        let generations = log.generations();
        assert_eq!(generations.len(), DELTA_LOG_MAX_ENTRIES);
        assert_eq!(generations.first(), Some(&9));
        assert_eq!(generations.last(), Some(&(DELTA_LOG_MAX_ENTRIES as u64 + 8)));
    }

    #[test]
    fn byte_cap_evicts_from_the_front_whichever_cap_first() {
        let mut log = DeltaLog::default();
        let entry_bytes = DELTA_LOG_MAX_SERIALIZED_BYTES / 4;
        for generation in 1..=6 {
            log.append(entry(generation, entry_bytes));
        }
        // 6 entries of a quarter-cap each: only 4 fit under the byte cap.
        assert_eq!(log.generations(), vec![3, 4, 5, 6]);
        assert!(log.total_serialized_bytes <= DELTA_LOG_MAX_SERIALIZED_BYTES);
    }

    #[test]
    fn discontinuous_append_resets_history() {
        let mut log = DeltaLog::default();
        log.append(entry(1, 4));
        log.append(entry(2, 4));
        log.append(entry(7, 4)); // gap: bug upstream — never serve across it
        assert_eq!(log.generations(), vec![7]);
    }

    #[test]
    fn batch_requires_contiguous_coverage() {
        let mut log = DeltaLog::default();
        for generation in 5..=9 {
            log.append(entry(generation, 4));
        }
        let batch = log.batch(5, 8).unwrap();
        assert_eq!(
            batch.iter().map(|entry| entry.generation).collect::<Vec<_>>(),
            vec![6, 7, 8]
        );
        assert!(log.batch(3, 8).is_none(), "below the retention floor");
        assert!(log.batch(5, 11).is_none(), "beyond the head");
        assert!(log.batch(8, 8).is_none(), "empty range");
    }

    #[test]
    fn captured_batch_survives_append_driven_truncation() {
        // Gate (j): a batch captured for an in-flight sync stays intact even
        // when later appends evict the very entries it was built from.
        let mut log = DeltaLog::default();
        for generation in 1..=4 {
            log.append(entry(generation, 4));
        }
        let batch = log.batch(1, 4).unwrap();
        let expected: Vec<(u64, String)> = batch
            .iter()
            .map(|entry| (entry.generation, entry.digest_after.clone()))
            .collect();

        // Evict everything the batch referenced via the byte cap.
        for generation in 5..=10 {
            log.append(entry(generation, DELTA_LOG_MAX_SERIALIZED_BYTES / 3));
        }
        assert!(log.batch(1, 4).is_none(), "originals must be evicted");
        let after: Vec<(u64, String)> = batch
            .iter()
            .map(|entry| (entry.generation, entry.digest_after.clone()))
            .collect();
        assert_eq!(after, expected);
        assert!(batch.iter().all(|entry| entry.delta_json.len() == 4));
    }

    #[test]
    fn record_published_appends_only_contiguous_steps() {
        let (shared, graphs) = shared_at_generation(3);
        {
            let state = lock_state(&shared.state);
            assert_eq!(state.log.generations(), vec![1, 2, 3]);
            assert_eq!(state.published.generation, 3);
            assert_eq!(state.published.graph_digest, graphs[3].digest());
        }

        // A non-contiguous record (bug seam) reseeds instead of corrupting.
        let stray_delta = upsert_delta(7, "src/m.ts#stray");
        let stray_graph = graph(8, "src/m.ts#stray");
        shared.record_published(&stray_graph, &stray_delta);
        let state = lock_state(&shared.state);
        assert!(state.log.generations().is_empty());
        assert_eq!(state.published.generation, 8);
    }

    #[test]
    fn plan_yields_exact_contiguous_sync_frame() {
        // Gate (a), host half: worker attested G=1, published G=3 → the frame
        // carries deltas 2 and 3 and targets exactly the published identity.
        let (shared, graphs) = shared_at_generation(3);
        let attested = identity_of(&graphs[1]);
        let target = identity_of(&graphs[3]);
        let frame = shared
            .plan_sync_frame(Some(&attested), &target, GENEROUS_REQUEST_BYTES)
            .unwrap();
        assert_eq!(frame["kind"], "sync");
        assert_eq!(frame["base"]["generation"], "1");
        assert_eq!(frame["base"]["digest"], Value::String(attested.digest.clone()));
        assert_eq!(frame["target"]["generation"], "3");
        assert_eq!(frame["target"]["digest"], Value::String(target.digest.clone()));
        let deltas = frame["deltas"].as_array().unwrap();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0]["baseGeneration"], "1");
        assert_eq!(deltas[1]["baseGeneration"], "2");
        assert_eq!(deltas[0]["schemaVersion"], 1);
        assert_eq!(deltas[0]["changes"][0]["type"], "upsertNode");
    }

    #[test]
    fn no_attestation_or_below_floor_plans_full_hydrate() {
        // Gate (f), host half.
        let (shared, graphs) = shared_at_generation(2);
        let target = identity_of(&graphs[2]);

        let cold = shared
            .plan_sync_frame(None, &target, GENEROUS_REQUEST_BYTES)
            .unwrap();
        assert_eq!(cold["kind"], "hydrate");
        assert_eq!(cold["target"]["generation"], "2");
        assert_eq!(cold["snapshot"]["generation"], "2");
        assert_eq!(cold["snapshot"]["nodes"].as_array().unwrap().len(), 1);

        // Push the retention floor above generation 1 via the entry cap.
        {
            let mut state = lock_state(&shared.state);
            for generation in 3..=(DELTA_LOG_MAX_ENTRIES as u64 + 10) {
                state.log.append(entry(generation, 1));
            }
            state.published.generation = DELTA_LOG_MAX_ENTRIES as u64 + 10;
            state.published.sync_digest = "head-digest".into();
        }
        let head_target = GraphIdentity {
            generation: DELTA_LOG_MAX_ENTRIES as u64 + 10,
            digest: "head-digest".into(),
        };
        let below_floor = GraphIdentity {
            generation: 1,
            digest: "old".into(),
        };
        let frame = shared
            .plan_sync_frame(Some(&below_floor), &head_target, GENEROUS_REQUEST_BYTES)
            .unwrap();
        assert_eq!(frame["kind"], "hydrate", "below the floor must full-hydrate");
    }

    #[test]
    fn oversized_batch_plans_full_hydrate() {
        // Gate (g), host half: contiguous coverage exists but the batch would
        // not fit one request frame → hydrate.
        let (shared, graphs) = shared_at_generation(2);
        let attested = identity_of(&graphs[0]);
        let target = identity_of(&graphs[2]);
        let tiny_request_bound = SYNC_FRAME_OVERHEAD_MARGIN + 8;
        let frame = shared
            .plan_sync_frame(Some(&attested), &target, tiny_request_bound)
            .unwrap();
        assert_eq!(frame["kind"], "hydrate");
        assert_eq!(frame["target"]["generation"], "2");
    }

    #[test]
    fn ahead_attestation_is_refused_without_any_frame() {
        // Gate (e), host half: forward-only — never roll the mirror back.
        let (shared, graphs) = shared_at_generation(2);
        let ahead = GraphIdentity {
            generation: 9,
            digest: "future".into(),
        };
        let target = identity_of(&graphs[2]);
        let error = shared
            .plan_sync_frame(Some(&ahead), &target, GENEROUS_REQUEST_BYTES)
            .unwrap_err()
            .to_string();
        assert!(error.contains("ahead"), "{error}");
        assert!(error.contains("one-shot"), "{error}");
    }

    #[test]
    fn raced_target_no_longer_published_is_refused() {
        let (shared, graphs) = shared_at_generation(3);
        let stale_target = identity_of(&graphs[2]);
        let error = shared
            .plan_sync_frame(None, &stale_target, GENEROUS_REQUEST_BYTES)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no longer the published identity"), "{error}");
    }

    #[test]
    fn routing_predicate_is_structural_identity_comparison() {
        // Review B2: routing compares (generation, graph digest) against the
        // PUBLISHED identity — a speculative next graph (right generation
        // count, unpublished content) can never match.
        let (shared, graphs) = shared_at_generation(1);
        let published = &graphs[1];
        let sync_identity = shared
            .published_sync_identity(published.generation(), published.digest())
            .expect("published graph must route to the mirror");
        assert_eq!(sync_identity, identity_of(published));

        let speculative_delta = upsert_delta(1, "src/m.ts#speculative");
        let speculative = published.apply(&speculative_delta).unwrap();
        assert!(
            shared
                .published_sync_identity(speculative.generation(), speculative.digest())
                .is_none(),
            "speculative next graph must NOT route to the mirror"
        );
        assert!(
            shared
                .published_sync_identity(published.generation(), speculative.digest())
                .is_none(),
            "same generation with different content must NOT route"
        );
    }
}
