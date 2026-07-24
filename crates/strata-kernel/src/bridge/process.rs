use super::observer::{self, WorkerRunMetrics};
use super::protocol::{
    BridgeRequest, BridgeResponse, ValidationProfile, parse_bridge_response,
    serialize_bridge_request,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::{Arc, atomic::AtomicUsize};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

/// Byte bounds shared by the one-shot transport below and the persistent
/// multi-frame transport (`persistent.rs`). The asymmetry is deliberate and
/// review-pinned (bridge-persistence plan v2, Global Constraints): requests
/// are bounded at 32 MiB and responses at 16 MiB — the request bound is
/// never applied to response frames.
pub(crate) const MAX_REQUEST_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_RESPONSE_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Default stderr capture bound for spawned bridge workers (both transports).
pub(crate) const DEFAULT_MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct NodeBridgeConfig {
    pub(crate) executable: PathBuf,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) deadline: Duration,
    pub(crate) max_request_bytes: usize,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_stderr_bytes: usize,
    pub(crate) max_diagnostics_bytes: usize,
    pub(crate) validation_profile: ValidationProfile,
    /// When true, `run()` appends `--emit-metrics` to the spawned worker's
    /// argv and buffers one terminal [`WorkerRunMetrics`] record per spawned
    /// child. Default false: nothing is buffered and the argv is unchanged
    /// (spawn counting still happens — it is only an atomic increment).
    pub(crate) collect_metrics: bool,
    /// Task-5 scaffold flag (`--persistent-bridge`, default false): when set,
    /// the kernel additionally spawns ONE persistent worker for the session
    /// and routes bridge requests through it, with this one-shot transport as
    /// the per-request fallback. This config only CARRIES the operator's
    /// choice from the service flag to the kernel wiring; nothing in the
    /// one-shot client reads it.
    pub(crate) persistent_scaffold: bool,
}

impl NodeBridgeConfig {
    pub fn tsc_only(
        executable: impl Into<PathBuf>,
        arguments: Vec<OsString>,
        deadline: Duration,
        source_root: impl Into<PathBuf>,
        corpus_root: impl Into<PathBuf>,
        strict_src_only_tsc_scope: bool,
    ) -> Self {
        let source_root = source_root.into();
        let corpus_root = corpus_root.into();
        Self {
            executable: executable.into(),
            arguments,
            deadline,
            max_request_bytes: MAX_REQUEST_FRAME_BYTES,
            max_response_bytes: MAX_RESPONSE_FRAME_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            max_diagnostics_bytes: 64 * 1024,
            validation_profile: ValidationProfile::tsc_only(
                source_root.to_string_lossy(),
                corpus_root.to_string_lossy(),
                strict_src_only_tsc_scope,
            ),
            collect_metrics: false,
            persistent_scaffold: false,
        }
    }

    /// Opts this config into per-run metrics collection. When enabled, spawned
    /// workers are asked to self-report metrics (`--emit-metrics`) and each
    /// spawned child produces one terminal [`WorkerRunMetrics`] record.
    pub fn with_metrics_collection(mut self, collect: bool) -> Self {
        self.collect_metrics = collect;
        self
    }

    /// Opts the kernel into the Task-5 persistent-bridge scaffold (service
    /// flag `--persistent-bridge`). Default off; the one-shot transport is
    /// byte-identical either way and remains the per-request fallback.
    pub fn with_persistent_bridge(mut self, persistent: bool) -> Self {
        self.persistent_scaffold = persistent;
        self
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_with_limits(
        mut self,
        max_request_bytes: usize,
        max_response_bytes: usize,
        max_stderr_bytes: usize,
    ) -> Self {
        self.max_request_bytes = max_request_bytes;
        self.max_response_bytes = max_response_bytes;
        self.max_stderr_bytes = max_stderr_bytes;
        self
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_with_executable(mut self, executable: impl Into<PathBuf>) -> Self {
        self.executable = executable.into();
        self
    }

    #[doc(hidden)]
    #[cfg(feature = "coordination-test-api")]
    pub fn test_with_deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }
}

#[derive(Debug)]
pub(crate) struct NodeBridgeClient {
    config: NodeBridgeConfig,
    /// Spawn-anchored count of successfully spawned worker children. Distinct
    /// from the test-only pre-spawn `run_count`: this increments once per
    /// `Command::spawn` that succeeds, regardless of `collect_metrics`.
    worker_starts: AtomicU64,
    /// Buffer of terminal per-run records, drained by `take_worker_run_metrics`.
    /// Only appended to when `config.collect_metrics` is true.
    run_metrics: Mutex<Vec<WorkerRunMetrics>>,
    #[cfg(test)]
    run_count: Arc<AtomicUsize>,
}

impl NodeBridgeClient {
    pub(crate) fn new(config: NodeBridgeConfig) -> Self {
        Self {
            config,
            worker_starts: AtomicU64::new(0),
            run_metrics: Mutex::new(Vec::new()),
            #[cfg(test)]
            run_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(crate) fn collects_metrics(&self) -> bool {
        self.config.collect_metrics
    }

    /// Drains the buffered run records. Poisoned lock is treated as empty —
    /// observability never surfaces an error to callers.
    pub(crate) fn take_worker_run_metrics(&self) -> Vec<WorkerRunMetrics> {
        match self.run_metrics.lock() {
            Ok(mut buffer) => std::mem::take(&mut *buffer),
            Err(_) => Vec::new(),
        }
    }

    /// Total worker children successfully spawned over this client's lifetime.
    pub(crate) fn worker_starts_total(&self) -> u64 {
        self.worker_starts.load(Ordering::SeqCst)
    }

    /// Appends one externally produced run record to the shared buffer. Used
    /// by the persistent scaffold router (`scaffold.rs`) so persistent-path
    /// trips surface through the SAME drain (`take_worker_run_metrics`) and
    /// sink as one-shot runs. Best-effort like the in-run recording: a
    /// poisoned buffer lock is skipped, never surfaced.
    pub(crate) fn record_run_metrics(&self, record: WorkerRunMetrics) {
        if let Ok(mut buffer) = self.run_metrics.lock() {
            buffer.push(record);
        }
    }

    pub(crate) fn run(&self, request: &BridgeRequest) -> Result<BridgeResponse> {
        #[cfg(test)]
        self.run_count.fetch_add(1, Ordering::SeqCst);
        // Consume any request-build context set for THIS invocation by the
        // provider/executor, so a value never survives into a later run on this
        // thread even if this run fails before it is recorded.
        let request_build = observer::take_request_build();

        let serialize_start = Instant::now();
        let request_bytes = serialize_bridge_request(request)?;
        let request_serialize_ns = elapsed_ns(serialize_start);
        ensure!(
            request_bytes.len() <= self.config.max_request_bytes,
            "bridge request exceeds configured byte limit"
        );
        let total_request_bytes = request_bytes.len() as u64;
        // Validation policy is service-startup-owned configuration. Candidate request
        // construction consumes it in the executor task; intent input never does.
        let _startup_validation_profile = &self.config.validation_profile;
        let deadline = Instant::now()
            .checked_add(self.config.deadline)
            .ok_or_else(|| anyhow!("Node bridge deadline is too large"))?;

        let mut command = Command::new(&self.config.executable);
        command
            .args(&self.config.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if self.config.collect_metrics {
            // Ask the worker to self-report metrics; appended after the
            // configured arguments so it never displaces a positional arg.
            command.arg("--emit-metrics");
        }
        let wall_start = Instant::now();
        let child = command.spawn().with_context(|| {
            format!(
                "spawn Node bridge executable {}",
                self.config.executable.display()
            )
        })?;
        // Spawn-anchored: exactly one worker start per successfully spawned
        // child, whether or not metrics are being collected.
        self.worker_starts.fetch_add(1, Ordering::SeqCst);

        let spawned = self.run_spawned(child, request, request_bytes, deadline);

        if self.config.collect_metrics {
            let record = WorkerRunMetrics {
                request_kind: request.observed_kind().to_owned(),
                change_set_id: request.change_set_id().to_owned(),
                phase: observer::current_phase(),
                outcome: spawned.outcome,
                bridge_wall_ns: elapsed_ns(wall_start),
                snapshot_bytes: request_build.map_or(0, |build| build.snapshot_bytes),
                total_request_bytes,
                snapshot_build_ns: request_build.map_or(0, |build| build.snapshot_build_ns),
                request_serialize_ns,
                response_bytes: spawned.response_bytes,
                worker: spawned
                    .result
                    .as_ref()
                    .ok()
                    .and_then(|response| response.metrics_ref().cloned()),
            };
            // Best-effort: a poisoned buffer lock is skipped, never surfaced as
            // an error — observability must not change coordination semantics.
            if let Ok(mut buffer) = self.run_metrics.lock() {
                buffer.push(record);
            }
        }

        spawned.result
    }

    /// Runs the already-spawned `child` to completion and classifies its
    /// post-spawn exit path. This is the sole owner of the run's error
    /// handling: the classification order and every error value it produces are
    /// identical to the pre-observability single-exit `run()`, so recording is
    /// a pure observation over an unchanged control flow.
    fn run_spawned(
        &self,
        mut child: Child,
        request: &BridgeRequest,
        request_bytes: Vec<u8>,
        deadline: Instant,
    ) -> SpawnedOutcome {
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                return SpawnedOutcome::lifecycle(anyhow!("Node bridge stdout pipe was not created"));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                return SpawnedOutcome::lifecycle(anyhow!("Node bridge stderr pipe was not created"));
            }
        };
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                return SpawnedOutcome::lifecycle(anyhow!("Node bridge stdin pipe was not created"));
            }
        };

        // Both readers start before any potentially blocking stdin write or wait.
        let stdout_reader = spawn_bounded_reader(stdout, self.config.max_response_bytes);
        let stderr_reader = spawn_bounded_reader(stderr, self.config.max_stderr_bytes);
        let mut stdin_writer = Some(spawn_request_writer(stdin, request_bytes));
        let mut write_result = None;
        let mut timed_out = false;
        let mut lifecycle_error = None;
        let mut status = None;

        match wait_for_writer_or_child(&mut child, stdin_writer.as_ref().unwrap(), deadline) {
            Ok(InitialEvent::ChildExited(exit_status)) => status = Some(exit_status),
            Ok(InitialEvent::WriterFinished) => {
                let result = join_writer(stdin_writer.take().unwrap());
                if result.is_err() {
                    write_result = Some(result);
                    match child
                        .try_wait()
                        .context("poll Node bridge child after write failure")
                    {
                        Ok(Some(exit_status)) => status = Some(exit_status),
                        Ok(None) => {
                            // An immediately exiting child can close stdin just before its
                            // nonzero status becomes observable. Give that status a short,
                            // deadline-bounded grace period; otherwise clean up the still-live
                            // child and preserve the primary write error.
                            let grace = Duration::from_millis(50)
                                .min(deadline.saturating_duration_since(Instant::now()));
                            match child.wait_timeout(grace) {
                                Ok(Some(exit_status)) => status = Some(exit_status),
                                Ok(None) => {
                                    if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                        lifecycle_error = Some(cleanup_error);
                                    }
                                }
                                Err(error) => {
                                    lifecycle_error =
                                        Some(anyhow!(error).context("wait after write failure"));
                                    if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                        lifecycle_error = Some(with_cleanup_error(
                                            lifecycle_error.take().unwrap(),
                                            cleanup_error,
                                        ));
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            lifecycle_error = Some(error);
                            if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(with_cleanup_error(
                                    lifecycle_error.take().unwrap(),
                                    cleanup_error,
                                ));
                            }
                        }
                    }
                } else {
                    write_result = Some(Ok(()));
                    match child.wait_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(Some(exit_status)) => status = Some(exit_status),
                        Ok(None) => {
                            timed_out = true;
                            if let Err(error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(error);
                            }
                        }
                        Err(error) => {
                            lifecycle_error =
                                Some(anyhow!(error).context("wait for Node bridge child"));
                            if let Err(cleanup_error) = kill_and_reap(&mut child) {
                                lifecycle_error = Some(with_cleanup_error(
                                    lifecycle_error.take().unwrap(),
                                    cleanup_error,
                                ));
                            }
                        }
                    }
                }
            }
            Ok(InitialEvent::DeadlineReached) => {
                timed_out = true;
                if let Err(error) = kill_and_reap(&mut child) {
                    lifecycle_error = Some(error);
                }
            }
            Err(error) => {
                lifecycle_error = Some(error);
                if let Err(cleanup_error) = kill_and_reap(&mut child) {
                    lifecycle_error = Some(with_cleanup_error(
                        lifecycle_error.take().unwrap(),
                        cleanup_error,
                    ));
                }
            }
        }

        if write_result.is_none() {
            write_result = Some(join_writer(stdin_writer.take().unwrap()));
        }

        let (stdout_result, stderr_result) = join_reader_pair(stdout_reader, stderr_reader);

        // Classification order mirrors the original single-exit `run()` exactly:
        // the first failing check wins, and each error value is unchanged.
        if let Err(error) = resolve_lifecycle_result(timed_out, lifecycle_error) {
            let outcome = if timed_out { "timedOut" } else { "lifecycleError" };
            return SpawnedOutcome {
                result: Err(error),
                outcome,
                response_bytes: 0,
            };
        }
        let stdout_capture = match stdout_result {
            Ok(capture) => capture,
            Err(error) => return SpawnedOutcome::lifecycle(error),
        };
        let stderr_capture = match stderr_result {
            Ok(capture) => capture,
            Err(error) => return SpawnedOutcome::lifecycle(error),
        };
        let response_bytes = stdout_capture.bytes.len() as u64;

        if stderr_capture.over_limit {
            return SpawnedOutcome {
                result: Err(anyhow!("Node bridge stderr exceeded configured byte limit")),
                outcome: "stderrOverLimit",
                response_bytes,
            };
        }
        if stdout_capture.over_limit {
            return SpawnedOutcome {
                result: Err(anyhow!(
                    "Node bridge stdout response exceeded configured byte limit"
                )),
                outcome: "responseOverLimit",
                response_bytes,
            };
        }

        if let Some(status) = &status
            && !status.success()
        {
            let stderr = String::from_utf8_lossy(&stderr_capture.bytes);
            return SpawnedOutcome {
                result: Err(anyhow!(
                    "Node bridge exited with nonzero status {status}: {}",
                    stderr.trim()
                )),
                outcome: "nonzeroExit",
                response_bytes,
            };
        }
        if let Err(error) = write_result.expect("writer result is always collected") {
            return SpawnedOutcome {
                result: Err(error),
                outcome: "writeFailed",
                response_bytes,
            };
        }
        if status.is_none() {
            return SpawnedOutcome {
                result: Err(anyhow!("Node bridge child status was not collected")),
                outcome: "lifecycleError",
                response_bytes,
            };
        }

        match parse_bridge_response(
            &stdout_capture.bytes,
            request,
            self.config.max_diagnostics_bytes,
        ) {
            Ok(response) => SpawnedOutcome {
                result: Ok(response),
                outcome: "ok",
                response_bytes,
            },
            Err(error) => SpawnedOutcome {
                result: Err(error),
                outcome: "parseFailed",
                response_bytes,
            },
        }
    }

    pub(crate) fn validation_profile(&self) -> ValidationProfile {
        self.config.validation_profile.clone()
    }

    #[cfg(test)]
    pub(crate) fn run_count(&self) -> usize {
        self.run_count.load(Ordering::SeqCst)
    }
}

/// Result of running an already-spawned child to completion, plus the
/// observability classification of its exit path.
struct SpawnedOutcome {
    result: Result<BridgeResponse>,
    outcome: &'static str,
    response_bytes: u64,
}

impl SpawnedOutcome {
    /// A post-spawn lifecycle failure observed before any response bytes could
    /// be attributed (pipe setup, reader join, or missing child status).
    fn lifecycle(error: anyhow::Error) -> Self {
        Self {
            result: Err(error),
            outcome: "lifecycleError",
            response_bytes: 0,
        }
    }
}

/// Saturating nanosecond elapsed helper: `Instant::elapsed` is `u128`; a run
/// exceeding `u64::MAX` ns (~584 years) clamps rather than truncating.
/// Shared with the persistent scaffold router so both transports measure
/// their run-record durations identically.
pub(crate) fn elapsed_ns(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

enum InitialEvent {
    ChildExited(ExitStatus),
    WriterFinished,
    DeadlineReached,
}

fn wait_for_writer_or_child(
    child: &mut Child,
    writer: &JoinHandle<Result<()>>,
    deadline: Instant,
) -> Result<InitialEvent> {
    const POLL_INTERVAL: Duration = Duration::from_millis(2);

    loop {
        if let Some(status) = child.try_wait().context("poll Node bridge child status")? {
            return Ok(InitialEvent::ChildExited(status));
        }
        if writer.is_finished() {
            return Ok(InitialEvent::WriterFinished);
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(InitialEvent::DeadlineReached);
        }
        thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

fn spawn_request_writer(mut stdin: ChildStdin, request: Vec<u8>) -> JoinHandle<Result<()>> {
    thread::spawn(move || {
        stdin
            .write_all(&request)
            .context("write Node bridge request")?;
        stdin.flush().context("flush Node bridge request")?;
        drop(stdin);
        Ok(())
    })
}

fn join_writer(handle: JoinHandle<Result<()>>) -> Result<()> {
    handle
        .join()
        .map_err(|_| anyhow!("Node bridge stdin writer panicked"))?
}

fn kill_and_reap(child: &mut Child) -> Result<ExitStatus> {
    let kill_result = child.kill();
    let reap_result = child.wait();
    match (kill_result, reap_result) {
        (_, Ok(status)) => Ok(status),
        (Ok(()), Err(error)) => Err(anyhow!(error).context("reap Node bridge child")),
        (Err(kill_error), Err(reap_error)) => Err(anyhow!(
            "kill Node bridge child failed: {kill_error}; reap also failed: {reap_error}"
        )),
    }
}

fn with_cleanup_error(primary: anyhow::Error, cleanup: anyhow::Error) -> anyhow::Error {
    anyhow!("{primary:#}; child cleanup also failed: {cleanup:#}")
}

fn resolve_lifecycle_result(timed_out: bool, lifecycle_error: Option<anyhow::Error>) -> Result<()> {
    match (timed_out, lifecycle_error) {
        (true, Some(error)) => Err(anyhow!(
            "Node bridge deadline exceeded; child cleanup failed: {error:#}"
        )),
        (true, None) => bail!("Node bridge deadline exceeded; child was killed and reaped"),
        (false, Some(error)) => Err(error),
        (false, None) => Ok(()),
    }
}

struct BoundedCapture {
    bytes: Vec<u8>,
    over_limit: bool,
}

fn spawn_bounded_reader<R>(reader: R, limit: usize) -> JoinHandle<std::io::Result<BoundedCapture>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || read_bounded_and_drain(reader, limit))
}

fn read_bounded_and_drain<R: Read>(mut reader: R, limit: usize) -> std::io::Result<BoundedCapture> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut over_limit = false;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        if retained < read {
            over_limit = true;
        }
        // Continue draining even after the cap so a child cannot block forever
        // or receive SIGPIPE merely because its output is being rejected.
    }
    Ok(BoundedCapture { bytes, over_limit })
}

fn join_reader(
    handle: JoinHandle<std::io::Result<BoundedCapture>>,
    stream: &str,
) -> Result<BoundedCapture> {
    handle
        .join()
        .map_err(|_| anyhow!("Node bridge {stream} reader panicked"))?
        .with_context(|| format!("read Node bridge {stream}"))
}

fn join_reader_pair(
    stdout_reader: JoinHandle<std::io::Result<BoundedCapture>>,
    stderr_reader: JoinHandle<std::io::Result<BoundedCapture>>,
) -> (Result<BoundedCapture>, Result<BoundedCapture>) {
    let stdout_result = join_reader(stdout_reader, "stdout");
    let stderr_result = join_reader(stderr_reader, "stderr");
    (stdout_result, stderr_result)
}

#[cfg(test)]
mod tests {
    use super::{BoundedCapture, join_reader_pair, resolve_lifecycle_result};
    use anyhow::anyhow;
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn reader_pair_join_waits_for_stderr_after_stdout_fails() {
        let stderr_finished = Arc::new(AtomicBool::new(false));
        let stdout_reader =
            thread::spawn(|| Err::<BoundedCapture, _>(io::Error::other("stdout read failed")));
        let stderr_finished_in_thread = Arc::clone(&stderr_finished);
        let stderr_reader = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            stderr_finished_in_thread.store(true, Ordering::SeqCst);
            Ok(BoundedCapture {
                bytes: Vec::new(),
                over_limit: false,
            })
        });

        let (stdout_result, stderr_result) = join_reader_pair(stdout_reader, stderr_reader);

        assert!(stdout_result.is_err());
        assert!(stderr_result.is_ok());
        assert!(stderr_finished.load(Ordering::SeqCst));
    }

    #[test]
    fn timeout_cleanup_failure_is_not_hidden_by_successful_cleanup_text() {
        let error = resolve_lifecycle_result(true, Some(anyhow!("synthetic kill failure")))
            .unwrap_err()
            .to_string();

        assert!(error.contains("deadline"), "{error}");
        assert!(error.contains("cleanup"), "{error}");
        assert!(error.contains("synthetic kill failure"), "{error}");
        assert!(!error.contains("was killed and reaped"), "{error}");
    }

    mod run_records {
        // `super`-relative paths so this module also compiles when
        // `bridge_protocol.rs` path-includes `process.rs` into a synthetic
        // crate root (where `crate::bridge` does not exist). `super::super` is
        // the `process` module; `super::super::super` is `bridge` in the real
        // crate and the test-binary root in the synthetic one.
        use super::super::super::observer;
        use super::super::super::protocol::{
            AnalyzeIntentRequest, BridgeBinding, BridgeKind, BridgeRequest, Hash64,
            IntentParameters, IntentRecord, PROTOCOL_VERSION, ValidationProfile, WireNode,
            WireSnapshot, WireU64,
        };
        use super::super::{NodeBridgeClient, NodeBridgeConfig};
        use crate::SCHEMA_VERSION;
        use std::ffi::OsString;
        use std::fs;
        use std::path::PathBuf;
        use std::time::Duration;
        use tempfile::tempdir;

        const STUB_TOTAL_NS: u64 = 4242;

        /// A minimal but fully valid analyze request; `run()` serializes and
        /// binds it, so every field must survive `serialize_bridge_request`.
        fn minimal_analyze_request() -> BridgeRequest {
            BridgeRequest::AnalyzeIntent(AnalyzeIntentRequest {
                protocol_version: PROTOCOL_VERSION,
                request_id: "analyze:7:0:i1".into(),
                kind: BridgeKind::AnalyzeIntent,
                binding: BridgeBinding {
                    service_epoch: WireU64::new(7),
                    graph_generation: WireU64::new(0),
                    graph_digest: Hash64::parse("a".repeat(64)).unwrap(),
                },
                snapshot: WireSnapshot {
                    schema_version: SCHEMA_VERSION,
                    generation: WireU64::new(0),
                    nodes: vec![WireNode {
                        id: "m".into(),
                        kind: "Module".into(),
                        parent_id: None,
                        child_index: None,
                        payload: "src/x.ts".into(),
                    }],
                    references: vec![],
                },
                intent: IntentRecord {
                    schema_version: SCHEMA_VERSION,
                    intent_id: "i1".into(),
                    change_set_id: "cs-observed".into(),
                    base_generation: WireU64::new(0),
                    parameters: IntentParameters::RenameSymbol {
                        declaration_id: "m".into(),
                        new_name: "X".into(),
                    },
                },
            })
        }

        /// A bound analyze-success response (with a metrics block) for the
        /// request from `minimal_analyze_request`, as raw JSON the stub echoes.
        fn bound_success_response(request: &BridgeRequest) -> Vec<u8> {
            let BridgeRequest::AnalyzeIntent(inner) = request else {
                panic!("expected analyze request");
            };
            let value = serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": inner.request_id,
                "kind": "analyzeIntent",
                "binding": {
                    "serviceEpoch": inner.binding.service_epoch.get().to_string(),
                    "graphGeneration": inner.binding.graph_generation.get().to_string(),
                    "graphDigest": inner.binding.graph_digest.as_str(),
                },
                "ok": true,
                "result": {
                    "facts": {
                        "type": "renameSymbol",
                        "declarationId": "m",
                        "declarationNameIdentifierId": "m-name",
                        "references": [],
                        "writableStatementIds": [],
                        "validationDependencyNodeIds": [],
                        "validationDependencyReferenceFromNodeIds": [],
                    }
                },
                "metrics": {
                    "hydrateNs": null,
                    "analyzeNs": null,
                    "mutateNs": null,
                    "validateNs": null,
                    "exportNs": null,
                    "totalNs": STUB_TOTAL_NS,
                    "peakRssBytes": 4096,
                },
            });
            serde_json::to_vec(&value).unwrap()
        }

        fn stub_config(arguments: Vec<OsString>, collect_metrics: bool) -> NodeBridgeConfig {
            NodeBridgeConfig {
                executable: PathBuf::from("/bin/sh"),
                arguments,
                deadline: Duration::from_secs(10),
                max_request_bytes: 32 * 1024 * 1024,
                max_response_bytes: 16 * 1024 * 1024,
                max_stderr_bytes: 64 * 1024,
                max_diagnostics_bytes: 64 * 1024,
                validation_profile: ValidationProfile::tsc_only("/project/src", "/project", true),
                collect_metrics,
                persistent_scaffold: false,
            }
        }

        fn sh_args(script: &str, positional: &str) -> Vec<OsString> {
            vec![
                OsString::from("-c"),
                OsString::from(script),
                OsString::from(positional),
            ]
        }

        #[test]
        fn spawn_records_one_ok_run_with_worker_metrics() {
            let request = minimal_analyze_request();
            let dir = tempdir().unwrap();
            let response_path = dir.path().join("response.json");
            fs::write(&response_path, bound_success_response(&request)).unwrap();

            // Drain stdin fully, then echo the bound response ($0), then exit 0.
            let client = NodeBridgeClient::new(stub_config(
                sh_args(
                    "cat >/dev/null; cat \"$0\"",
                    response_path.to_str().unwrap(),
                ),
                true,
            ));

            client.run(&request).expect("stub emits a bound response");
            assert_eq!(client.worker_starts_total(), 1);

            let records = client.take_worker_run_metrics();
            assert_eq!(records.len(), 1);
            let record = &records[0];
            assert_eq!(record.outcome, "ok");
            assert_eq!(record.phase, "unattributed");
            assert_eq!(record.request_kind, "analyzeIntent");
            assert_eq!(record.change_set_id, "cs-observed");
            assert!(record.total_request_bytes > 0);
            assert!(record.bridge_wall_ns > 0);
            assert!(record.request_serialize_ns > 0);
            assert!(record.response_bytes > 0);
            assert_eq!(record.worker.as_ref().unwrap().total_ns, STUB_TOTAL_NS);

            // Draining is terminal: a second take yields nothing.
            assert!(client.take_worker_run_metrics().is_empty());
        }

        #[test]
        fn timed_out_run_records_timeout_outcome_and_accumulates_starts() {
            let request = minimal_analyze_request();
            // Drain stdin then sleep well past the short deadline.
            let mut config = stub_config(sh_args("cat >/dev/null; sleep 5", "sh"), true);
            config.deadline = Duration::from_millis(250);
            let client = NodeBridgeClient::new(config);

            assert!(client.run(&request).is_err());
            assert_eq!(client.worker_starts_total(), 1);
            let records = client.take_worker_run_metrics();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].outcome, "timedOut");
            assert!(records[0].worker.is_none());

            // A second spawn on the same client advances the spawn-anchored counter.
            assert!(client.run(&request).is_err());
            assert_eq!(client.worker_starts_total(), 2);
        }

        #[test]
        fn collect_flag_gates_buffering_and_the_emit_metrics_argument() {
            let request = minimal_analyze_request();
            let dir = tempdir().unwrap();

            // The stub records its post-$0 argv so we can assert the flag's presence.
            let off_argv = dir.path().join("argv-off.txt");
            let off_script = format!(
                "cat >/dev/null; printf '%s\\n' \"$@\" > \"{}\"",
                off_argv.to_str().unwrap()
            );
            let off_client = NodeBridgeClient::new(stub_config(sh_args(&off_script, "sh"), false));
            assert!(off_client.run(&request).is_err()); // empty stdout → not a response
            assert_eq!(off_client.worker_starts_total(), 1);
            assert!(off_client.take_worker_run_metrics().is_empty());
            assert!(
                !fs::read_to_string(&off_argv).unwrap().contains("--emit-metrics"),
                "default config must not append --emit-metrics"
            );

            let on_argv = dir.path().join("argv-on.txt");
            let on_script = format!(
                "cat >/dev/null; printf '%s\\n' \"$@\" > \"{}\"",
                on_argv.to_str().unwrap()
            );
            let on_client = NodeBridgeClient::new(stub_config(sh_args(&on_script, "sh"), true));
            let _ = on_client.run(&request);
            assert_eq!(on_client.worker_starts_total(), 1);
            assert!(
                fs::read_to_string(&on_argv).unwrap().contains("--emit-metrics"),
                "collecting config must append --emit-metrics"
            );
            // Collecting records even a non-ok outcome.
            assert_eq!(on_client.take_worker_run_metrics().len(), 1);
        }

        #[test]
        fn enter_phase_attributes_records_then_restores_to_unattributed() {
            let request = minimal_analyze_request();
            let dir = tempdir().unwrap();
            let response_path = dir.path().join("response.json");
            fs::write(&response_path, bound_success_response(&request)).unwrap();
            let client = NodeBridgeClient::new(stub_config(
                sh_args(
                    "cat >/dev/null; cat \"$0\"",
                    response_path.to_str().unwrap(),
                ),
                true,
            ));

            {
                let _guard = observer::enter_phase("candidate");
                assert_eq!(observer::current_phase(), "candidate");
                client.run(&request).unwrap();
            }
            let inside = client.take_worker_run_metrics();
            assert_eq!(inside.len(), 1);
            assert_eq!(inside[0].phase, "candidate");

            // The guard has dropped: the next run is unattributed again.
            assert_eq!(observer::current_phase(), "unattributed");
            client.run(&request).unwrap();
            let outside = client.take_worker_run_metrics();
            assert_eq!(outside.len(), 1);
            assert_eq!(outside[0].phase, "unattributed");
        }
    }
}
