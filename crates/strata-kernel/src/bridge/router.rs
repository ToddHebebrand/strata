//! Persistent-bridge routing (`--persistent-bridge`, default OFF).
//!
//! **Both bridge request kinds ride the synced-mirror path** (Task 6 for
//! analyze, Task 7 for candidates):
//!
//! - **`analyzeIntent` → [`PersistentBridgeRouter::analyze_via_mirror`]**:
//!   the worker holds one long-lived `:memory:` mirror kept exact by
//!   attested, published-only delta sync (Task 6). Analyze frames carry NO
//!   snapshot — only the graph identity — which removes the per-trip
//!   snapshot build + serialize + hydrate cost the step-0 spike measured.
//! - **`buildValidateCandidate` → [`PersistentBridgeRouter::candidate_via_mirror`]**:
//!   candidate execution mutates the worker's database, so the mirror serve
//!   runs under the worker's savepoint-rollback bracket asserted by the full
//!   logical fingerprint (Task 7): pre-fingerprint → `SAVEPOINT` → the
//!   UNCHANGED candidate pipeline → `ROLLBACK TO; RELEASE` → post-
//!   fingerprint. A divergence poisons the worker (`mirrorPoisoned`), which
//!   the host converts into kill + lazy respawn + full rehydrate. The Task-5
//!   full-snapshot scaffold (`request_unattested`) was retired with this
//!   migration — non-mirror candidates are served by the one-shot spawn.
//!
//! **Routing predicate (review B2, structural):** a request may touch the
//! synced mirror ONLY if its graph identity — `(generation,
//! GraphGeneration::digest)` — equals the daemon's current PUBLISHED
//! identity, checked against [`SyncShared`]. Speculative graphs (readiness
//! planning against an unpublished `next` during publication) can never
//! match and are served one-shot with their own in-band snapshot. The check
//! is an identity comparison, never a caller-supplied flag.
//!
//! Fallback contract: ANY persistent-path TRANSPORT error — poison,
//! deadline, refusal, spawn failure, response-binding failure — falls back
//! transparently to the untouched one-shot spawn for that request. A
//! SEMANTIC candidate failure (the worker validated and refused the change)
//! is NOT a transport error: it is surfaced to the coordinator exactly as
//! the one-shot path surfaces it, with no re-run. Transport failures are
//! logged on the daemon's stderr (the existing operational-error
//! convention) and, under metrics, recorded as non-`ok` run records.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};

use super::observer::{self, WorkerRunMetrics};
use super::persistent::{
    GraphIdentity, PersistentWorkerConfig, PersistentWorkerHost, SyncPlanner,
};
use super::process::{NodeBridgeClient, NodeBridgeConfig, elapsed_ns};
use super::protocol::{
    BridgeBinding, CandidateBinding, ChangeSet, Hash64, MirrorCandidateResponse,
    PROTOCOL_VERSION, SemanticFacts, ValidationProfile, WireGraphDelta, WireU64,
    parse_mirror_analyze_facts, parse_mirror_candidate_delta,
};
use super::provider::wire_intent;
use super::sync_state::SyncShared;
use crate::GraphGeneration;
use crate::coordination::{IntentRecord, PreparedCandidate};

/// The Task-6 planner behind the host's [`SyncPlanner`] seam: delta batches
/// and full-hydrate snapshots come from the kernel's published sync state.
struct PublishedSyncPlanner {
    sync: Arc<SyncShared>,
    max_request_bytes: usize,
}

impl SyncPlanner for PublishedSyncPlanner {
    fn plan_sync(
        &self,
        attested: Option<&GraphIdentity>,
        target: &GraphIdentity,
    ) -> Result<Value> {
        self.sync
            .plan_sync_frame(attested, target, self.max_request_bytes)
    }
}

/// Routes bridge requests through one session-lifetime persistent worker,
/// preserving the one-shot path's request construction, response validation,
/// and per-run observability record shape. See the module docs for the
/// analyze/candidate route split.
pub(crate) struct PersistentBridgeRouter {
    host: PersistentWorkerHost,
    sync: Arc<SyncShared>,
    /// Per-request deadline — the same value the one-shot transport uses, so
    /// a hung worker is bounded identically on both transports.
    deadline: Duration,
    max_request_bytes: usize,
    max_diagnostics_bytes: usize,
    collect_metrics: bool,
    /// Latched when an in-process service-epoch mismatch is detected (bug
    /// only: the epoch is fixed per kernel lifetime and the router is spawned
    /// with it — see `epoch_guard`). Once set, the persistent path is
    /// permanently disabled for this router and every request serves
    /// one-shot. Across daemon restarts (where the epoch REALLY changes) the
    /// old kernel's drop kills this router's worker and the new kernel
    /// spawns a fresh router under the new epoch, which eager-rehydrates.
    disabled: AtomicBool,
}

impl PersistentBridgeRouter {
    /// Spawns the session's ONE persistent worker EAGERLY (documented choice:
    /// eager hydration lands at startup anyway; a spawn failure fails daemon
    /// startup loudly instead of surfacing per-request). After a poison the
    /// host lazily respawns on the next request — counted in `spawns_total`.
    ///
    /// The worker argv is the one-shot worker path plus `--persistent`, and
    /// `--emit-metrics` is appended exactly when the one-shot transport would
    /// append it (metrics sink active), so per-trip worker self-metrics stay
    /// comparable across transports.
    pub(crate) fn spawn(
        config: &NodeBridgeConfig,
        service_epoch: u64,
        sync: Arc<SyncShared>,
    ) -> Result<Self> {
        let mut arguments = config.arguments.clone();
        arguments.push("--persistent".into());
        if config.collect_metrics {
            arguments.push("--emit-metrics".into());
        }
        let host = PersistentWorkerHost::spawn(PersistentWorkerConfig::new(
            config.executable.clone(),
            arguments,
            config.deadline,
            service_epoch,
        ))?;
        Ok(Self {
            host,
            sync,
            deadline: config.deadline,
            max_request_bytes: config.max_request_bytes,
            max_diagnostics_bytes: config.max_diagnostics_bytes,
            collect_metrics: config.collect_metrics,
            disabled: AtomicBool::new(false),
        })
    }

    /// Total worker children the underlying host has spawned this session.
    pub(crate) fn spawns_total(&self) -> u64 {
        self.host.spawns_total()
    }

    fn planner(&self) -> PublishedSyncPlanner {
        PublishedSyncPlanner {
            sync: Arc::clone(&self.sync),
            max_request_bytes: self.max_request_bytes,
        }
    }

    /// Compare-and-kill on service-epoch mismatch (gate h). The host records
    /// the epoch it was spawned under; a caller-observed epoch that differs
    /// can only mean a wiring bug, so the worker is killed (its mirror may
    /// belong to another epoch's history) and the persistent path disabled.
    /// Returns `true` when the epoch is consistent.
    fn epoch_guard(&self, current_epoch: u64) -> bool {
        if self.disabled.load(Ordering::SeqCst) {
            return false;
        }
        if self.host.epoch() == current_epoch {
            return true;
        }
        self.disabled.store(true, Ordering::SeqCst);
        let _ = self.host.shutdown();
        eprintln!(
            "persistent bridge router epoch {} does not match the service epoch \
             {current_epoch}; worker killed, persistent path disabled (one-shot only)",
            self.host.epoch()
        );
        false
    }

    /// Eager hydration (service start, before the readiness line): brings the
    /// worker's mirror to the current published identity via the sync-only
    /// host entry. A failure here must not kill the service — the caller
    /// logs and continues; the first `request_at` lazily retries the sync.
    pub(crate) fn eager_hydrate(&self) -> Result<()> {
        let target = self.sync.current_sync_identity();
        self.host
            .hydrate_at(&target, self.deadline, &self.planner())
            .context("eager persistent-mirror hydration")
    }

    /// The synced-mirror analyze route (Task 6). Returns:
    /// - `Ok(Some(facts))` — served from the attested mirror;
    /// - `Ok(None)` — NOT routed: the request's graph identity is not the
    ///   published identity (speculative `next`, or any non-published graph;
    ///   review B2) or the router is epoch-disabled. The caller serves
    ///   one-shot with an in-band snapshot, byte-identical to before.
    /// - `Err(_)` — routed but failed (sync refusal, poison, deadline,
    ///   binding mismatch). The caller logs and falls back one-shot.
    pub(crate) fn analyze_via_mirror(
        &self,
        client: &NodeBridgeClient,
        graph: &GraphGeneration,
        intent: &IntentRecord,
        service_epoch: u64,
    ) -> Result<Option<SemanticFacts>> {
        if !self.epoch_guard(service_epoch) {
            return Ok(None);
        }
        // Structural routing predicate (B2): published identity or bust.
        let Some(target) = self
            .sync
            .published_sync_identity(graph.generation(), graph.digest())
        else {
            return Ok(None);
        };

        let serialize_start = Instant::now();
        let binding = BridgeBinding {
            service_epoch: WireU64::new(service_epoch),
            graph_generation: WireU64::new(graph.generation()),
            graph_digest: Hash64::parse(graph.digest())?,
        };
        // Same request minus the snapshot, plus the sync identity the worker
        // must hold attested. NO snapshot is built or serialized here — that
        // absence is the measured point of this route.
        let frame = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "analyzeIntentMirror",
            "binding": serde_json::to_value(&binding).context("encode mirror binding")?,
            "identity": {
                "generation": target.generation.to_string(),
                "digest": target.digest.clone(),
            },
            "intent": serde_json::to_value(&wire_intent(intent, graph.generation()))
                .context("encode mirror intent")?,
        });
        // Request size before the host stamps its requestId (a ~20-byte
        // field); recorded for observability, never used for bounding — the
        // host enforces the true bound on the exact stamped bytes.
        let total_request_bytes = if self.collect_metrics {
            serde_json::to_vec(&frame)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0)
        } else {
            0
        };
        let request_serialize_ns = elapsed_ns(serialize_start);

        let wall_start = Instant::now();
        let exchanged =
            self.host
                .request_at_with_size(&target, frame, self.deadline, &self.planner());
        let bridge_wall_ns = elapsed_ns(wall_start);

        let (outcome, response_bytes, result) = match exchanged {
            Ok((value, response_bytes)) => {
                let metrics = value
                    .get("metrics")
                    .and_then(|metrics| serde_json::from_value(metrics.clone()).ok());
                match parse_mirror_analyze_facts(value, &binding) {
                    Ok(facts) => ("ok", response_bytes, Ok((facts, metrics))),
                    Err(error) => ("parseFailed", response_bytes, Err(error)),
                }
            }
            Err(error) => ("persistentError", 0, Err(error)),
        };

        if self.collect_metrics {
            client.record_run_metrics(WorkerRunMetrics {
                request_kind: "analyzeIntent".to_owned(),
                change_set_id: intent.change_set_id.clone(),
                phase: observer::current_phase(),
                outcome,
                bridge_wall_ns,
                // The measured claim of this route: no snapshot was built.
                snapshot_bytes: 0,
                total_request_bytes,
                snapshot_build_ns: 0,
                request_serialize_ns,
                response_bytes,
                worker: result.as_ref().ok().and_then(|(_, metrics)| metrics.clone()),
            });
        }

        result.map(|(facts, _metrics)| Some(facts))
    }

    /// The synced-mirror candidate route (Task 7). Returns:
    /// - `Ok(MirrorCandidate::Delta(_))` — validated on the attested mirror
    ///   under savepoint isolation;
    /// - `Ok(MirrorCandidate::Failed(_))` — the candidate itself failed
    ///   validation/mutation on the mirror. This is a SEMANTIC outcome: the
    ///   caller surfaces it exactly like the one-shot path's failure and
    ///   must NOT re-run the candidate one-shot;
    /// - `Ok(MirrorCandidate::NotRouted)` — the request's graph identity is
    ///   not the published identity (speculative, review B2) or the router
    ///   is epoch-disabled; the caller serves one-shot with an in-band
    ///   snapshot, byte-identical to before;
    /// - `Err(_)` — routed but the TRANSPORT failed (sync refusal, poison —
    ///   including a worker-reported `mirrorPoisoned` isolation divergence —
    ///   deadline, binding mismatch). The caller logs and falls back
    ///   one-shot.
    pub(crate) fn candidate_via_mirror(
        &self,
        client: &NodeBridgeClient,
        prepared: &PreparedCandidate,
        validation_profile: &ValidationProfile,
        service_epoch: u64,
    ) -> Result<MirrorCandidate> {
        if !self.epoch_guard(service_epoch) {
            return Ok(MirrorCandidate::NotRouted);
        }
        // Structural routing predicate (B2): published identity or bust.
        let Some(target) = self
            .sync
            .published_sync_identity(prepared.graph.generation(), prepared.graph.digest())
        else {
            return Ok(MirrorCandidate::NotRouted);
        };

        let serialize_start = Instant::now();
        let binding = BridgeBinding {
            service_epoch: WireU64::new(service_epoch),
            graph_generation: WireU64::new(prepared.graph.generation()),
            graph_digest: Hash64::parse(prepared.graph.digest())?,
        };
        let expected_binding = CandidateBinding {
            service_epoch: WireU64::new(service_epoch),
            graph_generation: WireU64::new(prepared.graph.generation()),
            graph_digest: Hash64::parse(prepared.graph.digest())?,
            attempt_id: prepared.attempt_id.clone(),
            scope_fingerprint: Hash64::parse(&prepared.scope_fingerprint)?,
        };
        let change_set = ChangeSet {
            change_set_id: prepared.change_set.change_set_id.clone(),
            actor: prepared.change_set.actor.clone(),
            reasoning: prepared.change_set.reasoning.clone(),
            ordered_intents: prepared
                .intents
                .iter()
                .map(|intent| wire_intent(intent, prepared.graph.generation()))
                .collect(),
        };
        // Same request minus the snapshot, plus the sync identity the worker
        // must hold attested. NO snapshot is built or serialized here — that
        // absence is the measured point of this route (the worker's mirror
        // IS the published generation, by attestation).
        let frame = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "buildValidateCandidateMirror",
            "binding": serde_json::to_value(&binding).context("encode mirror binding")?,
            "identity": {
                "generation": target.generation.to_string(),
                "digest": target.digest.clone(),
            },
            "attemptId": prepared.attempt_id.clone(),
            "scopeFingerprint": prepared.scope_fingerprint.clone(),
            "changeSet": serde_json::to_value(&change_set).context("encode mirror change set")?,
            "validationProfile": serde_json::to_value(validation_profile)
                .context("encode mirror validation profile")?,
        });
        let total_request_bytes = if self.collect_metrics {
            serde_json::to_vec(&frame)
                .map(|bytes| bytes.len() as u64)
                .unwrap_or(0)
        } else {
            0
        };
        let request_serialize_ns = elapsed_ns(serialize_start);

        let wall_start = Instant::now();
        let exchanged =
            self.host
                .request_at_with_size(&target, frame, self.deadline, &self.planner());
        let bridge_wall_ns = elapsed_ns(wall_start);

        let (outcome, response_bytes, result) = match exchanged {
            Ok((value, response_bytes)) => {
                let metrics = value
                    .get("metrics")
                    .and_then(|metrics| serde_json::from_value(metrics.clone()).ok());
                match parse_mirror_candidate_delta(
                    value,
                    &expected_binding,
                    self.max_diagnostics_bytes,
                ) {
                    // A parsed CandidateError is a semantic outcome, recorded
                    // "ok" exactly as the one-shot transport records it (its
                    // parse succeeds there too; the failure surfaces after).
                    Ok(parsed) => ("ok", response_bytes, Ok((parsed, metrics))),
                    Err(error) => ("parseFailed", response_bytes, Err(error)),
                }
            }
            Err(error) => ("persistentError", 0, Err(error)),
        };

        if self.collect_metrics {
            client.record_run_metrics(WorkerRunMetrics {
                request_kind: "buildValidateCandidate".to_owned(),
                change_set_id: prepared.change_set.change_set_id.clone(),
                phase: observer::current_phase(),
                outcome,
                bridge_wall_ns,
                // The measured claim of this route: no snapshot was built.
                snapshot_bytes: 0,
                total_request_bytes,
                snapshot_build_ns: 0,
                request_serialize_ns,
                response_bytes,
                worker: result.as_ref().ok().and_then(|(_, metrics)| metrics.clone()),
            });
        }

        result.map(|(parsed, _metrics)| match parsed {
            MirrorCandidateResponse::Delta(delta) => MirrorCandidate::Delta(delta),
            MirrorCandidateResponse::Failed {
                stage,
                code,
                message,
            } => MirrorCandidate::Failed(anyhow!(
                // EXACT one-shot failure surface (into_candidate_result), so
                // a failing candidate reports identically on both routes.
                "Node bridge candidate failed at {stage:?}/{code}: {message}"
            )),
        })
    }

    #[cfg(test)]
    pub(crate) fn test_disabled(&self) -> bool {
        self.disabled.load(Ordering::SeqCst)
    }
}

/// Semantic routing outcome of [`PersistentBridgeRouter::candidate_via_mirror`].
pub(crate) enum MirrorCandidate {
    /// Not eligible for the mirror (speculative identity / epoch-disabled):
    /// serve one-shot with an in-band snapshot.
    NotRouted,
    /// Mirror-validated candidate delta.
    Delta(WireGraphDelta),
    /// The candidate itself failed on the mirror — a terminal semantic
    /// outcome, surfaced with the one-shot path's exact error shape.
    Failed(anyhow::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::IntentParameters;
    use crate::{GraphSnapshot, NodeRecord, SCHEMA_VERSION};
    use std::ffi::OsString;
    use std::path::Path;

    fn fake_worker_config() -> NodeBridgeConfig {
        let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-worker.js");
        NodeBridgeConfig::tsc_only(
            "node",
            vec![worker.into_os_string(), OsString::from("--mode=echo")],
            Duration::from_secs(10),
            "/corpus/src",
            "/corpus",
            true,
        )
    }

    fn tiny_graph() -> Arc<GraphGeneration> {
        Arc::new(
            GraphGeneration::from_snapshot(GraphSnapshot {
                schema_version: SCHEMA_VERSION,
                generation: 0,
                nodes: vec![NodeRecord {
                    id: "m".into(),
                    kind: "Module".into(),
                    parent_id: None,
                    child_index: None,
                    payload: "src/m.ts".into(),
                }],
                references: vec![],
            })
            .unwrap(),
        )
    }

    fn rename_intent(intent_id: &str, base_generation: u64) -> IntentRecord {
        IntentRecord::new(
            SCHEMA_VERSION,
            intent_id,
            "change:router",
            base_generation,
            IntentParameters::RenameSymbol {
                declaration_id: "m".into(),
                new_name: "X".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn epoch_mismatch_kills_the_worker_and_disables_the_persistent_path() {
        // Gate (h), in-process half: the epoch is fixed per kernel lifetime,
        // so a mismatch is a wiring bug — the router must kill the worker
        // and latch itself off (every request serves one-shot). The
        // cross-restart half (real epoch change on recovery → old worker
        // dies with the old kernel, new router eager-rehydrates) is covered
        // by the live-compare persistent-bridge restart test.
        let graph = tiny_graph();
        let sync = Arc::new(SyncShared::seed(graph.clone()));
        let router =
            PersistentBridgeRouter::spawn(&fake_worker_config(), 7, Arc::clone(&sync)).unwrap();
        let client = NodeBridgeClient::new(fake_worker_config());
        let intent = rename_intent("intent:epoch", 0);

        assert!(!router.test_disabled());
        let routed = router
            .analyze_via_mirror(&client, &graph, &intent, 8)
            .unwrap();
        assert!(routed.is_none(), "mismatched epoch must not touch the mirror");
        assert!(router.test_disabled());

        // Latched: even the correct epoch stays one-shot afterwards.
        let routed = router
            .analyze_via_mirror(&client, &graph, &intent, 7)
            .unwrap();
        assert!(routed.is_none());
    }

    fn prepared_candidate(
        graph: &Arc<GraphGeneration>,
        intent: IntentRecord,
    ) -> crate::coordination::PreparedCandidate {
        use crate::coordination::{ChangeSetRecord, ChangeSetState};
        let mut change_set = ChangeSetRecord::new(
            SCHEMA_VERSION,
            intent.change_set_id.clone(),
            "agent:router",
            "route a candidate through the mirror predicate",
            graph.generation(),
            "submit:router",
            std::slice::from_ref(&intent),
        )
        .unwrap();
        change_set.state = ChangeSetState::Executing;
        crate::coordination::PreparedCandidate {
            change_set,
            intents: vec![intent],
            graph: graph.clone(),
            attempt_id: "attempt:router".into(),
            scope_fingerprint: "c".repeat(64),
        }
    }

    #[test]
    fn candidate_speculative_identity_is_never_routed_to_the_mirror() {
        // Task 7, review B2 at the candidate route: a graph whose identity is
        // not the published one must return NotRouted — served one-shot with
        // its own snapshot — without any worker interaction.
        let published = tiny_graph();
        let sync = Arc::new(SyncShared::seed(published.clone()));
        let router =
            PersistentBridgeRouter::spawn(&fake_worker_config(), 7, Arc::clone(&sync)).unwrap();
        let client = NodeBridgeClient::new(fake_worker_config());

        let speculative = Arc::new(
            published
                .apply(&crate::GraphDelta {
                    schema_version: SCHEMA_VERSION,
                    base_generation: 0,
                    changes: vec![crate::GraphChange::UpsertNode {
                        node: NodeRecord {
                            id: "m".into(),
                            kind: "Module".into(),
                            parent_id: None,
                            child_index: None,
                            payload: "src/next.ts".into(),
                        },
                    }],
                })
                .unwrap(),
        );
        let prepared = prepared_candidate(&speculative, rename_intent("intent:cand-spec", 1));
        let profile =
            super::super::protocol::ValidationProfile::tsc_only("/corpus/src", "/corpus", true);
        let routed = router
            .candidate_via_mirror(&client, &prepared, &profile, 7)
            .unwrap();
        assert!(
            matches!(routed, MirrorCandidate::NotRouted),
            "speculative graph must serve one-shot"
        );
        assert!(!router.test_disabled());

        // Epoch mismatch: latched off, candidates included.
        let published_prepared =
            prepared_candidate(&published, rename_intent("intent:cand-epoch", 0));
        let routed = router
            .candidate_via_mirror(&client, &published_prepared, &profile, 8)
            .unwrap();
        assert!(matches!(routed, MirrorCandidate::NotRouted));
        assert!(router.test_disabled());
    }

    #[test]
    fn non_published_identity_is_never_routed_to_the_mirror() {
        // Review B2 at the router level: a graph whose identity is not the
        // published one (a speculative next) must return None — served
        // one-shot with its own snapshot — without any worker interaction.
        let published = tiny_graph();
        let sync = Arc::new(SyncShared::seed(published.clone()));
        let router =
            PersistentBridgeRouter::spawn(&fake_worker_config(), 7, Arc::clone(&sync)).unwrap();
        let client = NodeBridgeClient::new(fake_worker_config());
        let intent = rename_intent("intent:speculative", 1);

        let speculative = Arc::new(
            published
                .apply(&crate::GraphDelta {
                    schema_version: SCHEMA_VERSION,
                    base_generation: 0,
                    changes: vec![crate::GraphChange::UpsertNode {
                        node: NodeRecord {
                            id: "m".into(),
                            kind: "Module".into(),
                            parent_id: None,
                            child_index: None,
                            payload: "src/next.ts".into(),
                        },
                    }],
                })
                .unwrap(),
        );
        let routed = router
            .analyze_via_mirror(&client, &speculative, &intent, 7)
            .unwrap();
        assert!(routed.is_none(), "speculative graph must serve one-shot");
        assert!(!router.test_disabled());
    }
}
