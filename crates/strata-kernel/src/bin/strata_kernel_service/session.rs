use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use strata_kernel::{
    BeginChangeSet, CandidateRejected, ChangeSetState as KernelChangeSetState, ClaimOutcome,
    CoordinationError, CoordinationEventKind, GraphSnapshot, IntentParameters, Kernel,
    NodeBridgeConfig, PublicationReport, PublishClaimOutcome, TicketState as KernelTicketState,
};

use super::metrics::{BehavioralDisclosure, MetricsRecord, MetricsSink, peak_rss_bytes};

use super::audit::{
    AuditEvent, FollowUp, PendingRequest, RequestJournal, RequestLedgerEntry, ServiceAudit,
    action_body_hash, client_hash, request_identity,
};
use super::paths::project_module_path;
use super::protocol::{
    CancelledState, ChangeSetState, DeclarationSummary, Diagnostic, FixtureSummary, InspectedNode,
    Intent, LocalServiceProtocolContext, LocalServiceRequest, LocalServiceResponse,
    ModuleDeclarationSummary, ModuleSummary, NodeRelationship, OperationIntentSummary,
    OperationRenameTransition, ReferenceSummary, RenamedSymbol, RequestAction, ResponseResult,
    ServiceEvent, ServiceEventKind, TicketState, ValidationMode, WireU64, parse_request_frame,
};

const MAX_INTENTS: usize = 256;
/// Wire cap on the diagnostics a single rejection may carry. Mirrors the
/// protocol module's own `MAX_DIAGNOSTICS` (64), which every outbound frame
/// is validated against — truncating here keeps a pathologically diagnostic-
/// heavy candidate from failing frame validation instead of reporting its
/// verdict.
const MAX_WIRE_DIAGNOSTICS: usize = 64;
const MAX_RELATIONSHIPS: usize = 256;
const MIN_LOCAL_MUTATION_MS: u64 = 10;
const MIN_BRIDGE_ANALYSIS_MS: u64 = 30_100;
const MIN_BRIDGE_PUBLICATION_MS: u64 = 60_100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ServiceFailpoint {
    None,
    AfterPending,
    AfterEffect,
    AfterPrepared,
    AfterFollowUp,
    AfterCompleted,
}

/// The daemon's active validation configuration, resolved once in `main.rs`
/// from `--validation-manifest` (or its absence) and carried unchanged from
/// then on. Consumed by Task 6 (deadline nesting into the bridge) and Task 9
/// (savepoint/timeout gating), and by Task 7's seed-green startup gate and
/// the identity it publishes.
///
/// Without `--validation-manifest`, this is exactly `tsc_only()`: mode
/// `"tscOnly"`, no digest, no fixtures, the pre-B-2 default timeouts. That
/// no-flag path must never change `NodeBridgeConfig::tsc_only`'s
/// construction — the byte-identical guarantee every pre-existing suite
/// depends on.
// `fixtures` is consumed in `main.rs` when it builds the behavioral bridge
// config, not through this struct's own reader.
#[allow(dead_code)]
pub(super) struct ValidationSettings {
    pub mode: super::protocol::ValidationMode,
    pub manifest_digest: Option<String>,
    /// Registered fixtures; empty in `tscOnly`.
    pub fixtures: Vec<RegisteredFixture>,
    pub tsc_timeout_ms: u64,
    pub vitest_timeout_ms: u64,
}

/// One manifest-registered fixture, carrying the canonical absolute path the
/// loader verified at startup (Task 5 / review Major 9). The reader serves
/// ONLY from this identity — it never joins a client-supplied string onto the
/// corpus root — and re-verifies containment and content digest on every read,
/// so the startup snapshot is a starting point rather than a standing trust.
#[derive(Clone)]
pub(super) struct RegisteredFixture {
    /// Corpus-relative POSIX path, the only form ever put on the wire.
    pub path: String,
    /// sha256 of the registered content; doubles as the fixture's wire id.
    pub sha256: String,
    pub canonical_path: PathBuf,
}

impl ValidationSettings {
    pub(super) fn tsc_only() -> Self {
        Self {
            mode: super::protocol::ValidationMode::TscOnly,
            manifest_digest: None,
            fixtures: Vec::new(),
            tsc_timeout_ms: super::manifest::DEFAULT_TSC_TIMEOUT_MS,
            vitest_timeout_ms: super::manifest::DEFAULT_VITEST_TIMEOUT_MS,
        }
    }

    pub(super) fn from_loaded_manifest(loaded: &super::manifest::LoadedManifest) -> Self {
        Self {
            mode: match loaded.manifest.mode {
                super::manifest::ManifestMode::TscOnly => {
                    super::protocol::ValidationMode::TscOnly
                }
                super::manifest::ManifestMode::Behavioral => {
                    super::protocol::ValidationMode::Behavioral
                }
            },
            manifest_digest: Some(loaded.digest.clone()),
            // `canonical_fixture_paths` is index-aligned with
            // `manifest.fixtures` by construction in the loader.
            fixtures: loaded
                .manifest
                .fixtures
                .iter()
                .zip(loaded.canonical_fixture_paths.iter())
                .map(|(fixture, canonical_path)| RegisteredFixture {
                    path: fixture.path.clone(),
                    sha256: fixture.sha256.clone(),
                    canonical_path: canonical_path.clone(),
                })
                .collect(),
            tsc_timeout_ms: loaded.manifest.tsc_timeout_ms,
            vitest_timeout_ms: loaded.manifest.vitest_timeout_ms,
        }
    }
}

pub(super) struct ServiceConfig {
    pub db_path: PathBuf,
    pub snapshot_path: PathBuf,
    pub bridge_config: NodeBridgeConfig,
    pub audit_path: PathBuf,
    /// Corpus root as passed on argv (`--corpus-root`). Canonicalized once at
    /// `ServiceSession::open` into `canonical_corpus_root`; module path
    /// projection (`paths::project_module_path`) is lexical against that
    /// canonical form.
    pub corpus_root: PathBuf,
    /// Resolved once in `main.rs` from `--validation-manifest` (or its
    /// absence). Stored on `ServiceSession` unchanged and consumed by the
    /// startup gate and the session-identity surfaces.
    pub validation: ValidationSettings,
    pub failpoint: ServiceFailpoint,
    /// When set, per-request/recovery observability records are written to this
    /// JSONL sink. `None` (the default, no `--metrics`) is byte-identical
    /// behavior with no sink and no worker metrics collection.
    pub metrics_path: Option<PathBuf>,
    /// Publication-boundary crash failpoint (redb-spike-api only). When set to
    /// anything other than `None`, the advance path publishes via
    /// `execute_claimed_with_failpoint`; `None` is byte-for-byte the existing
    /// `execute_claimed` path, so a build without this feature is unaffected.
    #[cfg(feature = "redb-spike-api")]
    pub publish_failpoint: strata_kernel::PublishFailpoint,
}

pub(super) struct ServiceSession {
    kernel: Arc<Kernel>,
    journal: Mutex<RequestJournal>,
    audit: Mutex<ServiceAudit>,
    next_tick: AtomicU64,
    change_set_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    delivered_events: Mutex<BTreeMap<String, u64>>,
    protocol: Mutex<LocalServiceProtocolContext>,
    /// Canonicalized once at `open`; consumed by `paths::project_module_path`
    /// in the `list_modules` read handler.
    canonical_corpus_root: PathBuf,
    /// Resolved once at `open` from `config.validation`. Read by the startup
    /// gate (seed-green + `finalize_startup`) and by every surface that
    /// reports session identity: the readiness line, the start audit event,
    /// and the `hello` response.
    validation: ValidationSettings,
    failpoint: ServiceFailpoint,
    /// Present only under `--metrics`. Behind a `Mutex` because connections are
    /// served on independent threads and each may emit records.
    metrics: Option<Mutex<MetricsSink>>,
    /// Startup holding pens (B-2 Task 7). `Some` from construction until
    /// `finalize_startup`, which flushes them in order and then latches them to
    /// `None` so every later append/emit writes straight through.
    ///
    /// Recovery (`resolve_pending_before_bind`) runs INSIDE `open`, before the
    /// seed-green gate — it has to, because the gate must judge the
    /// post-recovery graph. But recovery is observable: it appends
    /// `request_recovered` (and, through `execute_pending`, any advance-path
    /// audit event) and emits the recovery metrics record. Writing those
    /// straight to disk would leave a refusing daemon's fingerprints in an
    /// audit log for a session that never served. Buffering makes "a refusing
    /// daemon leaves nothing behind" true for the whole startup path, and —
    /// because nothing runs between `open` and `finalize_startup` on the
    /// no-manifest path — leaves that path's audit content AND ordering
    /// byte-identical.
    startup_audit: Mutex<Option<Vec<AuditEvent>>>,
    startup_metrics: Mutex<Option<Vec<MetricsRecord>>>,
    #[cfg(feature = "redb-spike-api")]
    publish_failpoint: strata_kernel::PublishFailpoint,
    recovered: bool,
}

impl ServiceSession {
    pub fn open(config: ServiceConfig) -> Result<(Arc<Self>, u64)> {
        // Open the sink before any coordination work so a bad `--metrics` path
        // fails startup loudly rather than silently dropping records.
        let metrics = match config.metrics_path.as_deref() {
            Some(path) => Some(Mutex::new(MetricsSink::open(path)?)),
            None => None,
        };
        let existed = config.db_path.exists();
        // Fail loudly if the corpus root does not resolve to a real directory —
        // module path projection (paths::project_module_path, Task 4) is
        // lexical against this canonical form and must never fall back to the
        // raw (possibly relative, possibly symlinked) argv value.
        let canonical_corpus_root = std::fs::canonicalize(&config.corpus_root)
            .with_context(|| format!("canonicalize --corpus-root {}", config.corpus_root.display()))?;
        // Sanity-check wall around the whole open/create body. The recovery
        // report's own `open_ns` is authoritative; this bracket exists only so a
        // gross discrepancy is observable to a maintainer stepping through.
        let _open_bracket = Instant::now();
        let (kernel, recovery) = if existed {
            Kernel::open_with_node_bridge(&config.db_path, config.bridge_config)?
        } else {
            let snapshot: GraphSnapshot =
                serde_json::from_slice(&std::fs::read(&config.snapshot_path).with_context(
                    || format!("read initial snapshot {}", config.snapshot_path.display()),
                )?)?;
            Kernel::create_with_node_bridge(&config.db_path, snapshot, config.bridge_config)?
        };
        // The outer bracket strictly contains the report's own measurement, so
        // it must never be shorter than `open_ns`.
        debug_assert!(
            _open_bracket.elapsed().as_nanos() >= recovery.open_ns,
            "recovery.open_ns exceeded the outer open bracket"
        );
        let journal_path = private_journal_path(&config.db_path);
        let journal = RequestJournal::open(&journal_path)?;
        let next_tick = journal
            .max_tick()
            .checked_add(1)
            .context("service logical tick overflow")?;
        let session = Arc::new(Self {
            kernel: Arc::new(kernel),
            journal: Mutex::new(journal),
            audit: Mutex::new(ServiceAudit::open(&config.audit_path)?),
            next_tick: AtomicU64::new(next_tick),
            change_set_locks: Mutex::new(BTreeMap::new()),
            delivered_events: Mutex::new(BTreeMap::new()),
            protocol: Mutex::new(LocalServiceProtocolContext::default()),
            canonical_corpus_root,
            validation: config.validation,
            failpoint: config.failpoint,
            metrics,
            startup_audit: Mutex::new(Some(Vec::new())),
            startup_metrics: Mutex::new(Some(Vec::new())),
            #[cfg(feature = "redb-spike-api")]
            publish_failpoint: config.publish_failpoint,
            recovered: existed,
        });
        // One recovery record per daemon start, before the socket is reachable.
        // `existed` is exactly the `recovered` flag surfaced on the wire. Held
        // in the startup buffer until the gate admits the session.
        session.emit_metric(MetricsRecord::recovery(existed, &recovery));
        session.resolve_pending_before_bind()?;
        Ok((session, recovery.service_epoch))
    }

    /// Appends the ONE start event (`service_started` / `service_recovered`)
    /// that says this daemon is going to serve, carrying the session's
    /// validation identity.
    ///
    /// Split out of [`Self::open`] by B-2 Task 7 so the seed-green gate can
    /// run BETWEEN them: a daemon whose corpus is not green must audit
    /// NOTHING — a start event in the log would assert a session that never
    /// existed. Without a manifest there is no baseline to run and
    /// `server::serve` calls this immediately after `open`, so the audit
    /// stream's content and its order relative to hydration and the socket
    /// bind are exactly what they were before this split.
    pub fn finalize_startup(&self) -> Result<()> {
        // Flush the recovery-time side effects the gate was holding, in the
        // order they happened and strictly BEFORE the start event — exactly
        // where they landed before the gate existed.
        if let Some(records) = self.startup_metrics.lock().map_err(lock_error)?.take()
            && let Some(sink) = self.metrics.as_ref()
            && let Ok(mut sink) = sink.lock()
        {
            for record in &records {
                sink.emit(record);
            }
        }
        if let Some(events) = self.startup_audit.lock().map_err(lock_error)?.take() {
            let mut audit = self.audit.lock().map_err(lock_error)?;
            for event in events {
                audit.append(event)?;
            }
        }
        self.append_audit(AuditEvent {
            kind: if self.recovered {
                "service_recovered".into()
            } else {
                "service_started".into()
            },
            tick: None,
            request_hash: None,
            client_hash: None,
            action: None,
            change_set_id: None,
            state: None,
            graph_generation: self.kernel.snapshot().generation().to_string(),
            validation_mode: Some(self.validation.mode.as_label().to_owned()),
            validation_manifest_digest: self.validation.manifest_digest.clone(),
        })
    }

    pub fn recovered(&self) -> bool {
        self.recovered
    }

    /// `"tscOnly"` or `"behavioral"` — the session's validation regime, as
    /// reported on the readiness line, the start audit event, and `hello`.
    pub fn validation_mode(&self) -> ValidationMode {
        self.validation.mode
    }

    /// The sha256 of the operator's validation manifest, or `None` when the
    /// daemon runs the no-manifest default.
    pub fn validation_manifest_digest(&self) -> Option<&str> {
        self.validation.manifest_digest.as_deref()
    }

    /// True when an operator supplied `--validation-manifest`, in EITHER mode.
    /// A `tscOnly` manifest is still an operator statement about how this
    /// corpus must validate, so it gets the same seed-green gate a behavioral
    /// one does — only the no-manifest default skips the baseline.
    pub fn requires_seed_green_baseline(&self) -> bool {
        self.validation.manifest_digest.is_some()
    }

    /// Reads a registered fixture and re-establishes, on THIS read, both
    /// properties the loader established at startup: the canonical path still
    /// resolves inside the canonical corpus root, and the bytes still hash to
    /// the registered id. Startup verification is not carried forward as
    /// standing trust — a fixture edited or re-pointed after the daemon bound
    /// fails the read rather than serving drifted bytes under a pinned digest.
    ///
    /// Errors name the fixture's corpus-relative path and id, never the
    /// absolute path on disk (the B-1 fail-closed projection discipline).
    fn verified_fixture_bytes(&self, fixture: &RegisteredFixture) -> Result<Vec<u8>> {
        let canonical = std::fs::canonicalize(&fixture.canonical_path).with_context(|| {
            format!(
                "registered fixture {} is no longer readable at its verified location",
                fixture.path
            )
        })?;
        if !canonical.starts_with(&self.canonical_corpus_root) {
            bail!(
                "registered fixture {} now resolves outside the corpus root",
                fixture.path
            );
        }
        let content = std::fs::read(&canonical).with_context(|| {
            format!("registered fixture {} could not be read", fixture.path)
        })?;
        let actual = format!("{:x}", Sha256::digest(&content));
        if actual != fixture.sha256 {
            bail!(
                "registered fixture {} no longer matches its manifest digest \
                 (registered {}, found {actual}); the daemon serves manifest-pinned \
                 content only",
                fixture.path,
                fixture.sha256
            );
        }
        Ok(content)
    }

    /// Runs the seed-green baseline against the CURRENT graph (B-2 Task 7).
    /// Called by `server::serve` after `open` and before `finalize_startup`.
    pub fn validate_baseline(&self) -> Result<strata_kernel::BaselineVerdict> {
        self.kernel.validate_baseline()
    }

    /// Eager persistent-mirror hydration (Task 6): run after seed/recovery,
    /// BEFORE the stdout readiness line. `Ok(false)` when the daemon runs
    /// without `--persistent-bridge`. Failures are the caller's to log —
    /// startup must continue (the first mirror request lazily retries).
    pub fn eager_hydrate_persistent_bridge(&self) -> Result<bool> {
        self.kernel.eager_hydrate_persistent_bridge()
    }

    pub fn handle_frame(&self, bytes: &[u8]) -> LocalServiceResponse {
        let started = Instant::now();
        let parsed = self
            .protocol
            .lock()
            .map_err(lock_error)
            .and_then(|mut context| parse_request_frame(bytes, Some(&mut context)));
        match parsed {
            Ok(request) => {
                let binding = self
                    .journal
                    .lock()
                    .map_err(lock_error)
                    .and_then(|mut journal| journal.bind_request(&request));
                match binding {
                    Ok(true) => {
                        if let Ok(mut context) = self.protocol.lock() {
                            context.forget_request(&request.request_id);
                        }
                        self.handle_request(request, started)
                    }
                    Ok(false) => {
                        if let Ok(mut context) = self.protocol.lock() {
                            context.forget_request(&request.request_id);
                        }
                        LocalServiceResponse::error(
                            &request.request_id,
                            "invalid_request",
                            "request ID was already used with a different body",
                            false,
                            Vec::new(),
                        )
                    }
                    Err(_) => LocalServiceResponse::error(
                        &request.request_id,
                        "request_failed",
                        "request could not be recorded",
                        false,
                        Vec::new(),
                    ),
                }
            }
            Err(error) => LocalServiceResponse::error(
                request_id_from_untrusted_frame(bytes),
                "invalid_request",
                bounded_message(&error.to_string()),
                false,
                Vec::new(),
            ),
        }
    }

    fn handle_request(
        &self,
        request: LocalServiceRequest,
        started: Instant,
    ) -> LocalServiceResponse {
        let deadline = started + Duration::from_millis(request.deadline_ms.get());
        if remaining_ms(deadline) < minimum_action_budget_ms(&request.action) {
            return deadline_response(&request.request_id);
        }
        if !request.action.is_mutating() {
            return match self.execute_read(&request.client_id, &request.action) {
                Ok(result) => {
                    let response = LocalServiceResponse::success(&request.request_id, result);
                    let _ = self.audit_request(&request, None, &response, "request_completed");
                    // A read does no coordination work and spawns no worker, so
                    // its publication is always `None` and the drain is empty.
                    self.emit_request_metrics(&request.action, started, None);
                    response
                }
                Err(error) => LocalServiceResponse::error(
                    &request.request_id,
                    "request_failed",
                    bounded_message(&error.to_string()),
                    false,
                    Vec::new(),
                ),
            };
        }

        match self.handle_mutation(&request, started, deadline) {
            Ok(response) => response,
            Err(_error) => LocalServiceResponse::error(
                &request.request_id,
                "request_failed",
                "request could not be completed",
                false,
                Vec::new(),
            ),
        }
    }

    /// Emit one worker-run record per drained kernel metric, then the request
    /// record. Only ever runs when `--metrics` is active. Emission never fails
    /// the request: a poisoned sink lock or serialize error is swallowed.
    ///
    /// The worker-run drain point here is INCIDENTAL, not causal: each record is
    /// self-attributed via its `changeSetId`+`phase`, and draining at the
    /// request boundary must never be read as attributing those runs to this
    /// request. A run produced by an earlier request that had not yet drained is
    /// flushed here unchanged.
    fn emit_request_metrics(
        &self,
        action: &RequestAction,
        started: Instant,
        publication: Option<PublicationReport>,
    ) {
        let Some(sink) = self.metrics.as_ref() else {
            return;
        };
        let Ok(mut sink) = sink.lock() else {
            return;
        };
        // Behavioral-mode advances disclose what validation cost. The runs
        // drained here are the source for the two per-request durations, so
        // they are summarized BEFORE being emitted and consumed.
        let disclose = self.validation.mode == ValidationMode::Behavioral
            && matches!(action, RequestAction::AdvanceChangeSet { .. });
        let mut validation_wall_ms: Option<u64> = None;
        let mut queue_wait_ms: Option<u64> = None;
        for run in self.kernel.take_worker_run_metrics() {
            if disclose {
                // Several runs can land on one advance (an analyze trip plus
                // the candidate trip); the candidate's validate stage is the
                // cost being disclosed, so take the largest rather than the
                // last, and sum the waits that actually queued.
                if let Some(validate_ns) = run.worker.as_ref().and_then(|worker| worker.validate_ns)
                {
                    let ms = validate_ns / 1_000_000;
                    validation_wall_ms = Some(validation_wall_ms.map_or(ms, |seen| seen.max(ms)));
                }
                if let Some(wait_ns) = run.queue_wait_ns {
                    let ms = wait_ns / 1_000_000;
                    queue_wait_ms = Some(queue_wait_ms.map_or(ms, |seen| seen + ms));
                }
            }
            sink.emit(&MetricsRecord::worker_run(run));
        }
        let disclosure = disclose.then(|| BehavioralDisclosure {
            validation_wall_ms,
            queue_wait_ms,
            one_shot_fallbacks_total: self.kernel.one_shot_fallbacks_total(),
            rehydrations_total: self.kernel.rehydrations_total(),
            validation_timeouts_total: self.kernel.validation_timeouts_total(),
        });
        sink.emit(&MetricsRecord::request(
            action.name(),
            started.elapsed().as_nanos(),
            peak_rss_bytes(),
            self.kernel.worker_starts_total(),
            publication,
            disclosure,
        ));
    }

    fn handle_mutation(
        &self,
        request: &LocalServiceRequest,
        started: Instant,
        deadline: Instant,
    ) -> Result<LocalServiceResponse> {
        let key = request
            .idempotency_key
            .as_deref()
            .context("mutating request is missing idempotency key")?;
        let identity = request_identity(&request.client_id, key);
        let body_hash = action_body_hash(&request.client_id, &request.action)?;
        {
            let journal = self.journal.lock().map_err(lock_error)?;
            if let Some(entry) = journal.entry(&identity) {
                match entry {
                    RequestLedgerEntry::Completed {
                        body_hash: previous,
                        response,
                    } if previous == &body_hash => {
                        let replay = response.with_request_id(&request.request_id);
                        drop(journal);
                        self.audit_request(request, None, &replay, "request_replayed")?;
                        return Ok(replay);
                    }
                    RequestLedgerEntry::Completed { .. } => {
                        return Ok(LocalServiceResponse::error(
                            &request.request_id,
                            "idempotency_conflict",
                            "idempotency key was already used with a different action",
                            false,
                            Vec::new(),
                        ));
                    }
                    RequestLedgerEntry::Pending(pending) => {
                        if pending.body_hash != body_hash {
                            return Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "idempotency_conflict",
                                "idempotency key was already used with a different action",
                                false,
                                Vec::new(),
                            ));
                        }
                    }
                    RequestLedgerEntry::EffectResult { .. } => {
                        return Ok(LocalServiceResponse::error(
                            &request.request_id,
                            "request_in_progress",
                            "idempotent request is completing",
                            true,
                            Vec::new(),
                        ));
                    }
                }
            }
        }

        let lock = self.change_set_lock(request.action.change_set_id().unwrap_or(&identity))?;
        let Some(_guard) =
            lock_before_deadline(&lock, deadline, minimum_action_budget_ms(&request.action))?
        else {
            return Ok(deadline_response(&request.request_id));
        };
        {
            let journal = self.journal.lock().map_err(lock_error)?;
            if let Some(entry) = journal.entry(&identity) {
                return match entry {
                    RequestLedgerEntry::Completed {
                        body_hash: previous,
                        response,
                    } if previous == &body_hash => {
                        let replay = response.with_request_id(&request.request_id);
                        drop(journal);
                        self.audit_request(request, None, &replay, "request_replayed")?;
                        Ok(replay)
                    }
                    RequestLedgerEntry::Completed { .. } => Ok(LocalServiceResponse::error(
                        &request.request_id,
                        "idempotency_conflict",
                        "idempotency key was already used with a different action",
                        false,
                        Vec::new(),
                    )),
                    RequestLedgerEntry::Pending(pending) => {
                        if pending.body_hash != body_hash {
                            Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "idempotency_conflict",
                                "idempotency key was already used with a different action",
                                false,
                                Vec::new(),
                            ))
                        } else {
                            Ok(LocalServiceResponse::error(
                                &request.request_id,
                                "request_in_progress",
                                "idempotent request is still in progress",
                                true,
                                Vec::new(),
                            ))
                        }
                    }
                    RequestLedgerEntry::EffectResult { .. } => Ok(LocalServiceResponse::error(
                        &request.request_id,
                        "request_in_progress",
                        "idempotent request is completing",
                        true,
                        Vec::new(),
                    )),
                };
            }
        }
        self.authorize_actor(&request.client_id, &request.action)?;
        self.authorize_event_ack(&request.client_id, &request.action)?;
        if remaining_ms(deadline) < minimum_action_budget_ms(&request.action) {
            return Ok(deadline_response(&request.request_id));
        }

        let tick = self.next_tick.fetch_add(1, Ordering::SeqCst);
        if tick == u64::MAX {
            bail!("service logical tick overflow");
        }
        let baseline_intents = match &request.action {
            RequestAction::AddIntent { change_set_id, .. } => self
                .kernel
                .intents_for_change_set_bounded(change_set_id, MAX_INTENTS)?,
            _ => Vec::new(),
        };
        let pending = PendingRequest {
            identity: identity.clone(),
            client_id: request.client_id.clone(),
            idempotency_key: key.to_owned(),
            body_hash: body_hash.clone(),
            tick,
            action: request.action.clone(),
            baseline_intents,
        };
        self.journal
            .lock()
            .map_err(lock_error)?
            .append_pending(pending.clone())?;
        self.trip_failpoint(ServiceFailpoint::AfterPending);
        let effect = self
            .execute_pending(&pending, &request.request_id)
            .unwrap_or_else(|_error| {
                ExecutedEffect::response(LocalServiceResponse::error(
                    &request.request_id,
                    "request_failed",
                    "request could not be completed",
                    false,
                    Vec::new(),
                ))
            });
        self.trip_failpoint(ServiceFailpoint::AfterEffect);
        self.journal
            .lock()
            .map_err(lock_error)?
            .append_effect_result(
                identity.clone(),
                body_hash.clone(),
                effect.response.clone(),
                effect.follow_up.clone(),
            )?;
        self.trip_failpoint(ServiceFailpoint::AfterPrepared);
        self.apply_follow_up(effect.follow_up.as_ref())?;
        self.trip_failpoint(ServiceFailpoint::AfterFollowUp);
        let response = effect.response;
        let publication = effect.publication;
        self.journal.lock().map_err(lock_error)?.append_completed(
            identity,
            body_hash,
            response.clone(),
        )?;
        self.trip_failpoint(ServiceFailpoint::AfterCompleted);
        self.audit_request(request, Some(tick), &response, "request_completed")?;
        // Emission at the single success boundary of a mutation. Idempotent
        // replays and rejections short-circuit above this point and are
        // unmeasured by design: they perform no coordination work.
        self.emit_request_metrics(&request.action, started, publication);
        Ok(response)
    }

    fn resolve_pending_before_bind(&self) -> Result<()> {
        let unresolved = self
            .journal
            .lock()
            .map_err(lock_error)?
            .entries()
            .iter()
            .filter_map(|(identity, entry)| match entry {
                RequestLedgerEntry::Pending(request) => {
                    Some((identity.clone(), entry.clone(), Some(request.clone())))
                }
                RequestLedgerEntry::EffectResult { .. } => {
                    Some((identity.clone(), entry.clone(), None))
                }
                RequestLedgerEntry::Completed { .. } => None,
            })
            .collect::<Vec<_>>();
        for (identity, entry, pending) in unresolved {
            if let RequestLedgerEntry::EffectResult {
                body_hash,
                response,
                follow_up,
            } = entry
            {
                self.apply_follow_up(follow_up.as_ref())?;
                self.journal
                    .lock()
                    .map_err(lock_error)?
                    .append_completed(identity, body_hash, response)?;
                continue;
            }
            let request = pending.context("pending recovery entry is missing its request")?;
            let lock = self.change_set_lock(
                request
                    .action
                    .change_set_id()
                    .unwrap_or(request.identity.as_str()),
            )?;
            let _guard = lock.lock().map_err(lock_error)?;
            self.authorize_actor(&request.client_id, &request.action)?;
            let effect = if self.add_intent_was_committed(&request)? {
                let change_set_id = request
                    .action
                    .change_set_id()
                    .context("reconciled add intent has no change set")?;
                ExecutedEffect::response(LocalServiceResponse::success(
                    "recovered",
                    self.change_set_result(change_set_id, None, Vec::new())?,
                ))
            } else {
                self.execute_pending(&request, "recovered")
                    .unwrap_or_else(|_error| {
                        ExecutedEffect::response(LocalServiceResponse::error(
                            "recovered",
                            "request_failed",
                            "request could not be completed",
                            false,
                            Vec::new(),
                        ))
                    })
            };
            self.journal
                .lock()
                .map_err(lock_error)?
                .append_effect_result(
                    request.identity.clone(),
                    request.body_hash.clone(),
                    effect.response.clone(),
                    effect.follow_up.clone(),
                )?;
            self.apply_follow_up(effect.follow_up.as_ref())?;
            self.journal.lock().map_err(lock_error)?.append_completed(
                request.identity.clone(),
                request.body_hash.clone(),
                effect.response,
            )?;
            self.append_audit(AuditEvent {
                kind: "request_recovered".into(),
                tick: Some(request.tick.to_string()),
                request_hash: None,
                client_hash: Some(client_hash(&request.client_id)),
                action: Some(request.action.name().into()),
                change_set_id: request.action.change_set_id().map(str::to_owned),
                state: None,
                graph_generation: self.kernel.snapshot().generation().to_string(),
                validation_mode: None,
                validation_manifest_digest: None,
            })?;
        }
        Ok(())
    }

    fn add_intent_was_committed(&self, pending: &PendingRequest) -> Result<bool> {
        let (change_set_id, expected) = match &pending.action {
            RequestAction::AddIntent {
                change_set_id,
                intent,
            } => (change_set_id, wire_intent(intent)),
            _ => return Ok(false),
        };
        let current = self
            .kernel
            .intents_for_change_set_bounded(change_set_id, MAX_INTENTS)?;
        let baseline_ids = pending
            .baseline_intents
            .iter()
            .map(|intent| intent.intent_id.as_str())
            .collect::<BTreeSet<_>>();
        if !pending.baseline_intents.iter().all(|baseline| {
            current
                .iter()
                .any(|intent| intent.intent_id == baseline.intent_id && intent == baseline)
        }) {
            bail!("pending add-intent baseline no longer matches durable state");
        }
        let added = current
            .iter()
            .filter(|intent| !baseline_ids.contains(intent.intent_id.as_str()))
            .collect::<Vec<_>>();
        match added.as_slice() {
            [] => Ok(false),
            [intent] if intent.parameters == expected => Ok(true),
            _ => bail!("pending add-intent reconciliation is ambiguous"),
        }
    }

    fn execute_pending(
        &self,
        pending: &PendingRequest,
        request_id: &str,
    ) -> Result<ExecutedEffect> {
        let result = match &pending.action {
            RequestAction::BeginChangeSet { reasoning } => {
                let change_set_id =
                    deterministic_change_set_id(&pending.client_id, &pending.idempotency_key);
                self.kernel.begin_change_set(
                    BeginChangeSet {
                        change_set_id: change_set_id.clone(),
                        actor: pending.client_id.clone(),
                        reasoning: reasoning.clone(),
                        submission_idempotency_key: pending.identity.clone(),
                    },
                    pending.tick,
                )?;
                self.change_set_result(&change_set_id, None, Vec::new())?
            }
            RequestAction::AddIntent {
                change_set_id,
                intent,
            } => {
                self.kernel.add_intent(change_set_id, wire_intent(intent))?;
                self.change_set_result(change_set_id, None, Vec::new())?
            }
            RequestAction::SubmitChangeSet { change_set_id } => {
                self.kernel.submit_change_set(change_set_id, pending.tick)?;
                self.change_set_result(change_set_id, None, Vec::new())?
            }
            RequestAction::AdvanceChangeSet { change_set_id } => {
                return self.advance(change_set_id, pending.tick, request_id);
            }
            RequestAction::AckEvents { through_sequence } => {
                self.kernel
                    .ack_events(&pending.client_id, through_sequence.get())?;
                ResponseResult::EventsAcked {
                    through_sequence: *through_sequence,
                }
            }
            RequestAction::CancelChangeSet { change_set_id } => {
                let outcome = self.kernel.cancel_change_set(change_set_id, pending.tick)?;
                if outcome.change_set.state == KernelChangeSetState::Cancelled {
                    ResponseResult::Cancelled {
                        change_set_id: change_set_id.clone(),
                        state: CancelledState::Cancelled,
                    }
                } else {
                    self.change_set_result(change_set_id, None, Vec::new())?
                }
            }
            RequestAction::Hello { .. }
            | RequestAction::InspectNodes { .. }
            | RequestAction::FindDeclarations { .. }
            | RequestAction::ListModules { .. }
            | RequestAction::ListModuleDeclarations { .. }
            | RequestAction::GetReferences { .. }
            | RequestAction::ReadEvents { .. }
            | RequestAction::ReadOperation { .. }
            | RequestAction::ListValidationFixtures { .. }
            | RequestAction::ReadValidationFixture { .. } => {
                bail!("read-only action cannot be in the mutation journal")
            }
        };
        Ok(ExecutedEffect::response(LocalServiceResponse::success(
            request_id, result,
        )))
    }

    fn advance(&self, change_set_id: &str, tick: u64, request_id: &str) -> Result<ExecutedEffect> {
        let mut change_set = self
            .kernel
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        if change_set.state == KernelChangeSetState::Queued {
            // A ticket requeued at claim time (dynamic scope expansion) has no
            // later transition to re-plan it once its sibling already
            // published, so an advance on queued work runs a reconsideration
            // pass. Work that still overlaps an active claim or offer stays
            // queued, and such a pass is observationally idempotent: it only
            // ages the blocked ticket and the planner suppresses those age-only
            // diffs, so repeated polling neither advances the scheduler revision
            // nor starves an older claim validating under whole-scheduler
            // equality (see coordination/planner.rs).
            self.kernel.reconsider_tickets(tick)?;
            change_set = self
                .kernel
                .change_set(change_set_id)?
                .with_context(|| format!("change set {change_set_id} disappeared"))?;
        }
        if change_set.state != KernelChangeSetState::Ready {
            return Ok(ExecutedEffect::response(LocalServiceResponse::success(
                request_id,
                self.change_set_result(change_set_id, None, Vec::new())?,
            )));
        }
        let offer = self
            .kernel
            .ready_offer_for_change_set(change_set_id)?
            .context("ready change set is missing its server offer")?;
        match self
            .kernel
            .claim_ready(&offer.offer_id, &offer.claim_token, tick)?
        {
            ClaimOutcome::Claimed(claim) => {
                self.append_audit(AuditEvent {
                    kind: "claim_retained".into(),
                    tick: Some(tick.to_string()),
                    request_hash: Some(client_hash(request_id)),
                    client_hash: None,
                    action: Some("advance_change_set".into()),
                    change_set_id: Some(change_set_id.into()),
                    state: Some("claimed".into()),
                    graph_generation: self.kernel.snapshot().generation().to_string(),
                    validation_mode: None,
                    validation_manifest_digest: None,
                })?;
                // Publication is the sole durable-graph mutation of an advance.
                // With a redb-spike-api publish failpoint armed, route it through
                // the crash-injecting variant (which aborts at the configured
                // durable boundary); otherwise this is exactly `execute_claimed`.
                #[cfg(feature = "redb-spike-api")]
                let publish_outcome =
                    if self.publish_failpoint != strata_kernel::PublishFailpoint::None {
                        self.kernel.execute_claimed_with_failpoint(
                            &claim,
                            tick,
                            self.publish_failpoint,
                        )
                    } else {
                        self.kernel.execute_claimed(&claim, tick)
                    };
                #[cfg(not(feature = "redb-spike-api"))]
                let publish_outcome = self.kernel.execute_claimed(&claim, tick);
                match publish_outcome {
                    Ok(PublishClaimOutcome::Published(report)) => {
                        let response = LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(
                                change_set_id,
                                Some(report.digest.clone()),
                                Vec::new(),
                            )?,
                        );
                        // The report rides the effect to the emission point; no
                        // response bytes change (digest is the only wire field).
                        Ok(ExecutedEffect::response(response).with_publication(report))
                    }
                    Ok(PublishClaimOutcome::Requeued { .. })
                    | Ok(PublishClaimOutcome::NeedsDecision { .. }) => {
                        Ok(ExecutedEffect::response(LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(change_set_id, None, Vec::new())?,
                        )))
                    }
                    Err(error)
                        if matches!(
                            error.downcast_ref::<CoordinationError>(),
                            Some(CoordinationError::OptimisticRetryExhausted { .. })
                        ) =>
                    {
                        // Optimistic scheduler contention is not a candidate/tsc
                        // validation failure. The claim is intact and the change set
                        // is still executing; the older validating client was merely
                        // out-raced on the whole-scheduler-equality check. Report the
                        // current non-terminal (`claimed`) state and do NOT report a
                        // `validation_failed` verdict, requeue, or cancel the claim
                        // (which is exactly what let younger overlapping work win).
                        // This response does NOT itself complete the operation: the
                        // change set stays claimed, so a subsequent advance early-returns
                        // the same non-terminal state (its state is no longer `Ready`).
                        // Completion happens later via claim-lease expiry re-offering the
                        // work, then a further advance re-claiming and republishing.
                        // This arm's taxonomy — exhaustion => non-terminal state, an
                        // uncancelled/intact claim, and no verdict on the wire — is not
                        // deterministically forceable through a spawned daemon (advance
                        // publishes via `execute_claimed`, which needs the real
                        // node-bridge executor, and forcing exhaustion needs the
                        // `before_final_check` publication hook the daemon does not
                        // expose). It is covered at the coordinator layer, which shares
                        // `publish_claimed_inner` with `execute_claimed`, by
                        // `optimistic_retry_exhaustion_from_disjoint_churn_keeps_claim_non_terminal`
                        // in tests/coordination_optimistic.rs.
                        Ok(ExecutedEffect::response(LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(change_set_id, None, Vec::new())?,
                        )))
                    }
                    // SEMANTIC: the worker evaluated the candidate and the
                    // candidate itself is wrong (tsc red, behavioral red, or an
                    // intent that could not apply). That is a verdict, so it is
                    // a SUCCESS response carrying `validation_failed` and the
                    // worker's own diagnostics — never the pre-B-2 fabricated
                    // `candidate_validation_failed` placeholder, which told an
                    // agent nothing it could act on.
                    Err(error) if error.downcast_ref::<CandidateRejected>().is_some() => {
                        let rejected = error
                            .downcast_ref::<CandidateRejected>()
                            .expect("the guard just matched a CandidateRejected");
                        self.append_audit(AuditEvent {
                            kind: "validation_failed".into(),
                            tick: Some(tick.to_string()),
                            request_hash: Some(client_hash(request_id)),
                            client_hash: None,
                            action: Some("advance_change_set".into()),
                            change_set_id: Some(change_set_id.into()),
                            state: Some("validation_failed".into()),
                            graph_generation: self.kernel.snapshot().generation().to_string(),
                            validation_mode: None,
                            validation_manifest_digest: None,
                        })?;
                        let response = LocalServiceResponse::success(
                            request_id,
                            self.change_set_result(
                                change_set_id,
                                None,
                                self.rejection_diagnostics(rejected),
                            )?
                            .with_state(ChangeSetState::ValidationFailed),
                        );
                        Ok(ExecutedEffect {
                            response,
                            follow_up: Some(FollowUp::CancelChangeSet {
                                change_set_id: change_set_id.to_owned(),
                                tick,
                            }),
                            publication: None,
                        })
                    }
                    // OPERATIONAL (the fail-closed default: every unknown or
                    // future failure lands here). The worker never reached a
                    // verdict — timeout, crash, transport, invariant — so the
                    // candidate is NOT known-bad and the change set must not be
                    // cancelled or labelled `validation_failed`. Release the
                    // claim and requeue as one atomic lifecycle transition
                    // FIRST, so `retryable: true` is honest: a later advance
                    // genuinely re-drives this change set rather than waiting
                    // out a claim lease. If the requeue itself fails, the `?`
                    // falls through to the generic `request_failed` surface —
                    // no response may claim a requeue that did not happen.
                    Err(_error) => {
                        self.kernel.release_claim_for_retry(change_set_id, tick)?;
                        // Audit the state the requeue actually landed on rather
                        // than a hard-coded label: the readiness pass inside the
                        // same transition usually re-offers immediately (`ready`),
                        // but a contended scope leaves it `queued`.
                        let requeued_state = self
                            .kernel
                            .change_set(change_set_id)?
                            .map(|record| {
                                format!("{:?}", kernel_state(&record.state)).to_lowercase()
                            });
                        self.append_audit(AuditEvent {
                            kind: "candidate_execution_failed".into(),
                            tick: Some(tick.to_string()),
                            request_hash: Some(client_hash(request_id)),
                            client_hash: None,
                            action: Some("advance_change_set".into()),
                            change_set_id: Some(change_set_id.into()),
                            state: requeued_state,
                            graph_generation: self.kernel.snapshot().generation().to_string(),
                            validation_mode: None,
                            validation_manifest_digest: None,
                        })?;
                        Ok(ExecutedEffect::response(LocalServiceResponse::error(
                            request_id,
                            "candidate_execution_failed",
                            "candidate execution failed before a validation verdict; the change set has been requeued",
                            true,
                            Vec::new(),
                        )))
                    }
                }
            }
            ClaimOutcome::Requeued { .. } | ClaimOutcome::NeedsDecision { .. } => {
                Ok(ExecutedEffect::response(LocalServiceResponse::success(
                    request_id,
                    self.change_set_result(change_set_id, None, Vec::new())?,
                )))
            }
        }
    }

    fn execute_read(&self, client_id: &str, action: &RequestAction) -> Result<ResponseResult> {
        match action {
            RequestAction::Hello { .. } => Ok(ResponseResult::Ready {
                validation_mode: self.validation.mode,
                validation_manifest_digest: self.validation.manifest_digest.clone(),
            }),
            RequestAction::InspectNodes { node_ids } => self.inspect_nodes(node_ids),
            RequestAction::FindDeclarations {
                name,
                kind,
                module_id,
                after_node_id,
            } => {
                let (generation, matches, has_more) = self.kernel.find_declarations(
                    name,
                    kind.as_deref(),
                    module_id.as_deref(),
                    after_node_id.as_deref(),
                )?;
                Ok(ResponseResult::Declarations {
                    graph_generation: WireU64::new(generation),
                    declarations: matches
                        .into_iter()
                        .map(|declaration| DeclarationSummary {
                            node_id: declaration.node_id,
                            kind: declaration.kind,
                            name: declaration.name,
                            module_id: declaration.module_id,
                        })
                        .collect(),
                    has_more,
                })
            }
            RequestAction::ListModules { after_module_id, limit } => {
                let (generation, entries, has_more) = self
                    .kernel
                    .list_modules(after_module_id.as_deref(), *limit as usize)?;
                let modules = entries
                    .into_iter()
                    .map(|entry| {
                        let path = project_module_path(&self.canonical_corpus_root, &entry.payload)
                            .with_context(|| {
                                format!("module {} has a non-projectable path payload", entry.module_id)
                            })?;
                        Ok(ModuleSummary {
                            module_id: entry.module_id,
                            path,
                            declaration_count: entry.declaration_count,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(ResponseResult::Modules {
                    graph_generation: WireU64::new(generation),
                    modules,
                    has_more,
                })
            }
            RequestAction::ListModuleDeclarations { module_id, after_node_id, limit } => {
                let (generation, entries, has_more) = self.kernel.list_module_declarations(
                    module_id,
                    after_node_id.as_deref(),
                    *limit as usize,
                )?;
                Ok(ResponseResult::ModuleDeclarations {
                    graph_generation: WireU64::new(generation),
                    declarations: entries
                        .into_iter()
                        .map(|entry| ModuleDeclarationSummary {
                            node_id: entry.node_id,
                            name: entry.name,
                            kind: entry.kind,
                            exported: entry.exported,
                        })
                        .collect(),
                    has_more,
                })
            }
            RequestAction::GetReferences { node_id, after_reference_key, limit } => {
                let (generation, references, has_more) = self.kernel.incoming_references(
                    node_id,
                    after_reference_key.as_deref(),
                    *limit as usize,
                )?;
                Ok(ResponseResult::References {
                    graph_generation: WireU64::new(generation),
                    references: references
                        .into_iter()
                        .map(|reference| ReferenceSummary {
                            from_node_id: reference.from_node_id,
                            kind: reference.kind,
                            module_id: reference.module_id,
                        })
                        .collect(),
                    has_more,
                })
            }
            RequestAction::ReadEvents {
                after_sequence,
                limit,
            } => {
                let events =
                    self.kernel
                        .events_after(client_id, after_sequence.get(), *limit as usize)?;
                if let Some(last) = events.last() {
                    self.delivered_events
                        .lock()
                        .map_err(lock_error)?
                        .entry(client_id.to_owned())
                        .and_modify(|sequence| *sequence = (*sequence).max(last.sequence))
                        .or_insert(last.sequence);
                }
                Ok(ResponseResult::Events {
                    events: events
                        .into_iter()
                        .map(|event| self.safe_event(event))
                        .collect::<Result<Vec<_>>>()?,
                })
            }
            RequestAction::ReadOperation { operation_id } => {
                let Some((generation, record)) = self.kernel.operation_by_id(operation_id)? else {
                    bail!("operation {operation_id} does not exist");
                };
                let digest = self.kernel.generation_digest(generation)?;
                Ok(ResponseResult::Operation {
                    graph_generation: WireU64::new(generation),
                    operation_id: record.operation_id,
                    change_set_id: record.change_set_id,
                    actor: record.actor,
                    kind: record.kind,
                    reasoning: record.reasoning,
                    affected_node_ids: record.affected_node_ids,
                    renames: record
                        .renames
                        .into_iter()
                        .map(|rename| OperationRenameTransition {
                            node_id: rename.node_id,
                            from_name: rename.from_name,
                            to_name: rename.to_name,
                        })
                        .collect(),
                    intents: record
                        .intents
                        .into_iter()
                        .map(|intent| OperationIntentSummary {
                            kind: intent.kind,
                            parameters_json: intent.parameters_json,
                        })
                        .collect(),
                    publication_digest: digest,
                })
            }
            RequestAction::ListValidationFixtures {} => {
                let mut fixtures = Vec::with_capacity(self.validation.fixtures.len());
                for fixture in &self.validation.fixtures {
                    let bytes = self.verified_fixture_bytes(fixture)?.len() as u64;
                    fixtures.push(FixtureSummary {
                        fixture_id: fixture.sha256.clone(),
                        path: fixture.path.clone(),
                        bytes: WireU64::new(bytes),
                    });
                }
                Ok(ResponseResult::ValidationFixtures {
                    validation_mode: self.validation.mode,
                    validation_manifest_digest: self.validation.manifest_digest.clone(),
                    fixtures,
                })
            }
            RequestAction::ReadValidationFixture {
                fixture_id,
                offset,
                length,
            } => {
                if self.validation.fixtures.is_empty() {
                    bail!(
                        "this daemon has no registered validation fixtures; \
                         list_validation_fixtures returns the readable set"
                    );
                }
                let fixture = self
                    .validation
                    .fixtures
                    .iter()
                    .find(|fixture| fixture.sha256 == *fixture_id)
                    .with_context(|| {
                        format!("fixture {fixture_id} is not registered by this daemon's manifest")
                    })?;
                let content = self.verified_fixture_bytes(fixture)?;
                // A read at or past EOF is the terminal empty chunk rather than
                // an error, so a client can page to the end without having to
                // know the size up front.
                let start = usize::try_from(offset.get()).unwrap_or(usize::MAX).min(content.len());
                let end = start.saturating_add(*length as usize).min(content.len());
                Ok(ResponseResult::ValidationFixtureChunk {
                    fixture_id: fixture.sha256.clone(),
                    offset: *offset,
                    content_base64: base64_encode(&content[start..end]),
                    eof: end >= content.len(),
                })
            }
            _ => bail!("mutating action cannot use the read path"),
        }
    }

    fn inspect_nodes(&self, node_ids: &[String]) -> Result<ResponseResult> {
        let graph = self.kernel.snapshot();
        let mut nodes = Vec::with_capacity(node_ids.len());
        let unique_ids = node_ids.iter().collect::<BTreeSet<_>>();
        for node_id in unique_ids {
            let node = graph
                .node(node_id)
                .with_context(|| format!("node {node_id} does not exist"))?;
            let mut relationships = Vec::new();
            if let Some(parent) = &node.parent_id {
                relationships.push(NodeRelationship {
                    kind: "parent".into(),
                    node_id: parent.clone(),
                });
            }
            for child in graph.children_bounded(node_id, MAX_RELATIONSHIPS)? {
                relationships.push(NodeRelationship {
                    kind: "child".into(),
                    node_id: child.id.clone(),
                });
            }
            if let Some(reference) = graph.reference_from(node_id) {
                relationships.push(NodeRelationship {
                    kind: format!("outgoing:{}", reference.kind),
                    node_id: reference.to_node_id.clone(),
                });
            }
            for reference in graph.references_to(node_id) {
                if relationships.len() >= MAX_RELATIONSHIPS {
                    bail!("node {node_id} immediate relationships exceed bound");
                }
                relationships.push(NodeRelationship {
                    kind: format!("incoming:{}", reference.kind),
                    node_id: reference.from_node_id.clone(),
                });
            }
            if relationships.len() > MAX_RELATIONSHIPS {
                bail!("node {node_id} immediate relationships exceed bound");
            }
            nodes.push(InspectedNode {
                node_id: node.id.clone(),
                kind: node.kind.clone(),
                payload: if node.kind == "Module" {
                    String::new()
                } else {
                    node.payload.clone()
                },
                relationships,
            });
        }
        Ok(ResponseResult::Nodes {
            graph_generation: WireU64::new(graph.generation()),
            nodes,
        })
    }

    fn safe_event(&self, event: strata_kernel::CoordinationEvent) -> Result<ServiceEvent> {
        let operation = if event.kind == CoordinationEventKind::IntentCommitted {
            self.kernel.operation(event.graph_generation)?
        } else {
            None
        };
        let digest = if event.kind == CoordinationEventKind::IntentCommitted
            && self.kernel.snapshot().generation() == event.graph_generation
        {
            Some(self.kernel.snapshot().digest().to_owned())
        } else {
            None
        };
        Ok(ServiceEvent {
            sequence: WireU64::new(event.sequence),
            change_set_id: event.change_set_id,
            kind: service_event_kind(&event.kind),
            state: event_state(&event.kind),
            operation_id: operation.as_ref().map(|record| record.operation_id.clone()),
            affected_node_ids: bounded_affected_ids(
                operation
                    .map(|record| record.affected_node_ids)
                    .unwrap_or_default(),
            ),
            diagnostics: Vec::new(),
            publication_digest: digest,
        })
    }

    /// Projects a worker rejection onto the client wire.
    ///
    /// The code is namespaced `"{rejection code}:{worker diagnostic code}"`
    /// so a client can tell a tsc error apart from a behavioral failure apart
    /// from a refused intent without parsing prose. Raw payload paths never
    /// reach the wire: each `module_path` is projected corpus-relative, and a
    /// projection failure degrades the path to absent rather than dropping
    /// the diagnostic — a display-path problem must not hide the finding.
    fn rejection_diagnostics(&self, rejected: &CandidateRejected) -> Vec<Diagnostic> {
        let diagnostics = rejected
            .diagnostics
            .iter()
            .take(MAX_WIRE_DIAGNOSTICS)
            .map(|diagnostic| Diagnostic {
                code: format!("{}:{}", rejected.code, diagnostic.code),
                message: bounded_message(&diagnostic.message),
                node_id: diagnostic.node_id.clone(),
                module_path: diagnostic.module_path.as_deref().and_then(|payload| {
                    project_module_path(&self.canonical_corpus_root, payload).ok()
                }),
            })
            .collect::<Vec<_>>();
        if diagnostics.is_empty() {
            // A rejection with no worker diagnostics is possible (a
            // `mutationFailed`-class refusal, or a behavioral failure whose
            // output did not survive normalization). `validation_failed` must
            // never be diagnostic-free, so the rejection itself becomes one.
            return vec![Diagnostic {
                code: rejected.code.clone(),
                message: bounded_message(&rejected.message),
                node_id: None,
                module_path: None,
            }];
        }
        diagnostics
    }

    fn change_set_result(
        &self,
        change_set_id: &str,
        publication_digest: Option<String>,
        diagnostics: Vec<Diagnostic>,
    ) -> Result<ResponseResult> {
        let change_set = self
            .kernel
            .change_set(change_set_id)?
            .with_context(|| format!("change set {change_set_id} does not exist"))?;
        let ticket = self.kernel.ticket_for_change_set(change_set_id)?;
        let operation = change_set
            .committed_generation
            .map(|generation| self.kernel.operation(generation))
            .transpose()?
            .flatten();
        let publication_digest = match publication_digest {
            Some(digest) => Some(digest),
            None => change_set
                .committed_generation
                .map(|generation| self.kernel.generation_digest(generation))
                .transpose()?,
        };
        // A fresh decision must be recordable from this response alone: name
        // the symbols renamed since the change set's base analysis so stale
        // intent content can be rewritten to current names.
        let renamed_symbols = if change_set.state == KernelChangeSetState::NeedsDecision {
            self.kernel
                .renamed_symbols_since(change_set.base_generation)?
                .into_iter()
                .map(|rename| RenamedSymbol {
                    node_id: rename.node_id,
                    previous_name: rename.from_name,
                    current_name: rename.to_name,
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(ResponseResult::ChangeSet {
            change_set_id: change_set.change_set_id,
            state: kernel_state(&change_set.state),
            ticket_state: ticket.as_ref().map(|ticket| kernel_ticket(&ticket.state)),
            graph_generation: WireU64::new(self.kernel.snapshot().generation()),
            operation_id: operation.as_ref().map(|record| record.operation_id.clone()),
            affected_node_ids: bounded_affected_ids(
                operation
                    .map(|record| record.affected_node_ids)
                    .unwrap_or_default(),
            ),
            diagnostics,
            publication_digest,
            renamed_symbols,
        })
    }

    fn authorize_actor(&self, client_id: &str, action: &RequestAction) -> Result<()> {
        if let Some(change_set_id) = action.change_set_id() {
            let change_set = self
                .kernel
                .change_set(change_set_id)?
                .with_context(|| format!("change set {change_set_id} does not exist"))?;
            if change_set.actor != client_id {
                bail!("change set belongs to a different client");
            }
        }
        Ok(())
    }

    fn authorize_event_ack(&self, client_id: &str, action: &RequestAction) -> Result<()> {
        if let RequestAction::AckEvents { through_sequence } = action {
            let delivered = self
                .delivered_events
                .lock()
                .map_err(lock_error)?
                .get(client_id)
                .copied()
                .unwrap_or(0);
            if through_sequence.get() > delivered {
                bail!("cannot acknowledge an event sequence not delivered to this client");
            }
        }
        Ok(())
    }

    fn change_set_lock(&self, id: &str) -> Result<Arc<Mutex<()>>> {
        Ok(self
            .change_set_locks
            .lock()
            .map_err(lock_error)?
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn audit_request(
        &self,
        request: &LocalServiceRequest,
        tick: Option<u64>,
        response: &LocalServiceResponse,
        kind: &str,
    ) -> Result<()> {
        self.append_audit(AuditEvent {
            kind: kind.into(),
            tick: tick.map(|value| value.to_string()),
            request_hash: Some(client_hash(&request.request_id)),
            client_hash: Some(client_hash(&request.client_id)),
            action: Some(request.action.name().into()),
            change_set_id: response_change_set_id(response)
                .or_else(|| request.action.change_set_id().map(str::to_owned)),
            state: response_state(response),
            graph_generation: self.kernel.snapshot().generation().to_string(),
            validation_mode: None,
            validation_manifest_digest: None,
        })
    }

    fn append_audit(&self, event: AuditEvent) -> Result<()> {
        if let Some(buffer) = self.startup_audit.lock().map_err(lock_error)?.as_mut() {
            buffer.push(event);
            return Ok(());
        }
        self.audit.lock().map_err(lock_error)?.append(event)
    }

    /// Single emit path for every observability record, so the startup buffer
    /// catches recovery-time records without each call site knowing about it.
    /// Best-effort throughout: observability must never fail a request.
    fn emit_metric(&self, record: MetricsRecord) {
        let Some(sink) = self.metrics.as_ref() else {
            return;
        };
        if let Ok(mut guard) = self.startup_metrics.lock()
            && let Some(buffer) = guard.as_mut()
        {
            buffer.push(record);
            return;
        }
        if let Ok(mut sink) = sink.lock() {
            sink.emit(&record);
        }
    }

    fn apply_follow_up(&self, follow_up: Option<&FollowUp>) -> Result<()> {
        match follow_up {
            Some(FollowUp::CancelChangeSet {
                change_set_id,
                tick,
            }) => {
                self.kernel.cancel_change_set(change_set_id, *tick)?;
            }
            None => {}
        }
        Ok(())
    }

    fn trip_failpoint(&self, stage: ServiceFailpoint) {
        #[cfg(feature = "coordination-test-api")]
        if self.failpoint == stage {
            std::process::abort();
        }
        #[cfg(not(feature = "coordination-test-api"))]
        let _ = (self.failpoint, stage);
    }
}

fn service_event_kind(kind: &CoordinationEventKind) -> ServiceEventKind {
    match kind {
        CoordinationEventKind::IntentQueued => ServiceEventKind::IntentQueued,
        CoordinationEventKind::IntentReady => ServiceEventKind::IntentReady,
        CoordinationEventKind::IntentNeedsDecision => ServiceEventKind::IntentNeedsDecision,
        CoordinationEventKind::IntentCommitted => ServiceEventKind::IntentCommitted,
        CoordinationEventKind::IntentCancelled => ServiceEventKind::IntentCancelled,
        CoordinationEventKind::IntentFailed => ServiceEventKind::IntentFailed,
        CoordinationEventKind::LeaseExpired => ServiceEventKind::LeaseExpired,
        CoordinationEventKind::ScopeExpanded => ServiceEventKind::ScopeExpanded,
    }
}

struct ExecutedEffect {
    response: LocalServiceResponse,
    follow_up: Option<FollowUp>,
    /// The publication report, present only on the advance that actually
    /// published. It travels with the effect to the emission point so a
    /// concurrent request can never cross-attribute another's publication —
    /// there is deliberately no shared/global `last_publication` slot.
    publication: Option<PublicationReport>,
}

impl ExecutedEffect {
    fn response(response: LocalServiceResponse) -> Self {
        Self {
            response,
            follow_up: None,
            publication: None,
        }
    }

    fn with_publication(mut self, report: PublicationReport) -> Self {
        self.publication = Some(report);
        self
    }
}

trait ResponseResultStateOverride {
    fn with_state(self, state: ChangeSetState) -> Self;
}

impl ResponseResultStateOverride for ResponseResult {
    fn with_state(self, state: ChangeSetState) -> Self {
        match self {
            Self::ChangeSet {
                change_set_id,
                ticket_state,
                graph_generation,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
                renamed_symbols,
                ..
            } => Self::ChangeSet {
                change_set_id,
                state,
                ticket_state,
                graph_generation,
                operation_id,
                affected_node_ids,
                diagnostics,
                publication_digest,
                renamed_symbols,
            },
            other => other,
        }
    }
}

fn wire_intent(intent: &Intent) -> IntentParameters {
    match intent {
        Intent::RenameSymbol {
            declaration_id,
            new_name,
        } => IntentParameters::RenameSymbol {
            declaration_id: declaration_id.clone(),
            new_name: new_name.clone(),
        },
        Intent::AddParameter {
            function_id,
            name,
            type_text,
            position,
            value,
        } => IntentParameters::AddParameter {
            function_id: function_id.clone(),
            name: name.clone(),
            type_text: type_text.clone(),
            position: *position,
            default_value: Some(value.clone()),
        },
    }
}

fn deterministic_change_set_id(client_id: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{client_id}\0{key}").as_bytes());
    format!("change:{digest:x}")
}

fn kernel_state(state: &KernelChangeSetState) -> ChangeSetState {
    match state {
        KernelChangeSetState::Draft => ChangeSetState::Draft,
        KernelChangeSetState::Queued => ChangeSetState::Queued,
        KernelChangeSetState::Ready => ChangeSetState::Ready,
        KernelChangeSetState::Executing => ChangeSetState::Claimed,
        KernelChangeSetState::Committed => ChangeSetState::Published,
        KernelChangeSetState::NeedsDecision => ChangeSetState::NeedsDecision,
        KernelChangeSetState::Cancelled => ChangeSetState::Cancelled,
        KernelChangeSetState::Failed => ChangeSetState::Failed,
    }
}

fn kernel_ticket(state: &KernelTicketState) -> TicketState {
    match state {
        KernelTicketState::Queued => TicketState::Queued,
        KernelTicketState::Ready => TicketState::Ready,
        KernelTicketState::Claimed => TicketState::Claimed,
        KernelTicketState::Completed => TicketState::Completed,
        KernelTicketState::NeedsDecision => TicketState::NeedsDecision,
        KernelTicketState::Cancelled => TicketState::Cancelled,
        KernelTicketState::Failed => TicketState::Failed,
    }
}

fn event_state(kind: &CoordinationEventKind) -> ChangeSetState {
    match kind {
        CoordinationEventKind::IntentQueued | CoordinationEventKind::ScopeExpanded => {
            ChangeSetState::Queued
        }
        CoordinationEventKind::IntentReady => ChangeSetState::Ready,
        CoordinationEventKind::IntentNeedsDecision => ChangeSetState::NeedsDecision,
        CoordinationEventKind::IntentCommitted => ChangeSetState::Published,
        CoordinationEventKind::IntentCancelled => ChangeSetState::Cancelled,
        CoordinationEventKind::IntentFailed => ChangeSetState::Failed,
        CoordinationEventKind::LeaseExpired => ChangeSetState::Queued,
    }
}

fn response_change_set_id(response: &LocalServiceResponse) -> Option<String> {
    match response {
        LocalServiceResponse::Success(success) => match &success.result {
            ResponseResult::ChangeSet { change_set_id, .. }
            | ResponseResult::Cancelled { change_set_id, .. } => Some(change_set_id.clone()),
            _ => None,
        },
        LocalServiceResponse::Error(_) => None,
    }
}

fn response_state(response: &LocalServiceResponse) -> Option<String> {
    match response {
        LocalServiceResponse::Success(success) => match &success.result {
            ResponseResult::ChangeSet { state, .. } => Some(format!("{state:?}").to_lowercase()),
            ResponseResult::Cancelled { .. } => Some("cancelled".into()),
            _ => None,
        },
        LocalServiceResponse::Error(_) => Some("error".into()),
    }
}

fn private_journal_path(db_path: &Path) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(".service-journal.jsonl");
    PathBuf::from(path)
}

fn bounded_message(message: &str) -> String {
    const LIMIT: usize = 16_384;
    if message.len() <= LIMIT {
        return message.to_owned();
    }
    let mut end = LIMIT;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_owned()
}

fn request_id_from_untrusted_frame(bytes: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(bytes.strip_suffix(b"\n").unwrap_or(bytes))
        .ok()
        .and_then(|value| value.get("requestId")?.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .unwrap_or_else(|| "invalid".into())
}

fn minimum_action_budget_ms(action: &RequestAction) -> u64 {
    match action {
        RequestAction::SubmitChangeSet { .. } => MIN_BRIDGE_ANALYSIS_MS,
        RequestAction::AdvanceChangeSet { .. } => MIN_BRIDGE_PUBLICATION_MS,
        action if action.is_mutating() => MIN_LOCAL_MUTATION_MS,
        _ => 1,
    }
}

fn remaining_ms(deadline: Instant) -> u64 {
    deadline
        .checked_duration_since(Instant::now())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn lock_before_deadline<'a>(
    lock: &'a Mutex<()>,
    deadline: Instant,
    required_ms: u64,
) -> Result<Option<MutexGuard<'a, ()>>> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(Some(guard)),
            Err(TryLockError::Poisoned(error)) => return Err(lock_error(error)),
            Err(TryLockError::WouldBlock) => {
                if remaining_ms(deadline) < required_ms {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

fn deadline_response(request_id: &str) -> LocalServiceResponse {
    LocalServiceResponse::error(
        request_id,
        "deadline_exceeded",
        "request deadline is insufficient for the requested action",
        false,
        Vec::new(),
    )
}

fn bounded_affected_ids(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_RELATIONSHIPS)
        .collect()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> anyhow::Error {
    anyhow::anyhow!("service state lock is poisoned")
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard padded base64 (RFC 4648). Hand-rolled because the kernel crate
/// carries no base64 dependency and this is the only place that needs one —
/// fixture bytes are arbitrary binary as far as the wire is concerned, so they
/// cannot ride a JSON string unencoded.
fn base64_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        encoded.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        encoded.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        encoded.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_encode_matches_rfc4648_vectors() {
        // RFC 4648 §10, which exercises every padding residue.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encode_covers_every_alphabet_symbol_including_62_and_63() {
        // 0xfb 0xff round-trips through the two symbols an unpadded-alphabet
        // implementation would get wrong ('+' and '/').
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
        let all_bytes: Vec<u8> = (0u8..=255).collect();
        let encoded = base64_encode(&all_bytes);
        assert_eq!(encoded.len(), 344);
        assert!(encoded.contains('+') && encoded.contains('/'));
    }
}
