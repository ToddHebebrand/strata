//! Persistent-worker bridge host (bridge-persistence slice, Task 3).
//!
//! One long-lived Node child per host, spoken to over a bounded
//! length-prefixed multi-frame protocol on stdin/stdout (u32 little-endian
//! byte length, then that many bytes of JSON; every frame carries a
//! `requestId`). This transport exists to eliminate the measured
//! spawn-per-request cost of the one-shot path (`process.rs`), which stays
//! untouched as the fallback / cold-start / speculative-analysis transport.
//!
//! Review-mandated invariants (independent review B3; plan v2 Global
//! Constraints — do not weaken without a decisions.md entry):
//!
//! - **`request_at` is the ONLY public semantic entry point.** Attestation
//!   validation, sync planning + attest/refusal verification, and the
//!   semantic request/response exchange all happen inside ONE mutex-held
//!   critical section, so a second caller's sync can never interleave
//!   between another caller's sync and its semantic frame (the G/G+1 race
//!   gate below). There is no public `sync()` or `last_attestation()`;
//!   attestation state is host-internal.
//! - **Queue wait counts against the caller's deadline.** The clock starts
//!   before the state mutex is acquired; a caller whose deadline lapses
//!   while queued gets a deadline error WITHOUT the worker being touched
//!   (explicitly NOT a poison condition).
//! - **Single-flight, strictly.** Exactly one outstanding frame at a time.
//!   Any response with a mismatched `requestId`, or any frame arriving when
//!   nothing is outstanding, poisons the host: kill + reap, attestation
//!   cleared, error to the caller. The next call lazily respawns — and does
//!   NOT re-attest: attestation stays cleared until a sync succeeds against
//!   the fresh child.
//! - **Poison conditions** (each → kill + reap + error + lazy respawn with
//!   cleared attestation): oversized response frame, malformed frame JSON,
//!   deadline exceeded mid-exchange, stderr accumulation beyond the bound,
//!   child exit mid-request, unsolicited/mismatched response. A sync
//!   REFUSAL is not poison: the worker is healthy, the mirror simply did
//!   not advance (Task 6 wires the one-shot fallback).
//! - **Frame bounds stay asymmetric exactly as the one-shot path**
//!   ([`process::MAX_REQUEST_FRAME_BYTES`] / [`MAX_RESPONSE_FRAME_BYTES`]).
//!   An oversized REQUEST is refused host-side before anything is written —
//!   the worker is not poisoned.
//! - **The shutdown contract is stdin EOF** (the plan's "clean EOF", chosen
//!   over a shutdown frame as the simpler contract): `shutdown()` closes
//!   the worker's stdin, waits a bounded time for a voluntary exit, kills
//!   on timeout, and always reaps.
//! - The host records the **service epoch** it was spawned with and exposes
//!   [`PersistentWorkerHost::epoch`] so the coordinator can compare-and-kill
//!   on epoch change (wired in Task 6).
//!
//! Sync MECHANICS (delta selection/hydration) are Task 6's; here the host
//! owns only the attestation state and the verification of the worker's
//! attest/refusal response. The caller supplies a [`SyncPlanner`] seam that
//! yields the sync frame to send whenever the recorded attestation is stale.
//!
//! Threading matches the daemon's model (thread-per-connection std threads,
//! `server.rs`): plain `std::sync::Mutex` + per-worker I/O threads, no async
//! runtime.

use super::process::{
    DEFAULT_MAX_STDERR_BYTES, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

/// A published graph identity: the pair the worker attests after applying a
/// sync. Generation crosses the wire as the canonical decimal string (the
/// existing `WireU64` convention); in-process it is a plain `u64`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphIdentity {
    pub generation: u64,
    pub digest: String,
}

/// Seam between the host's attestation bookkeeping and Task 6's delta-sync
/// mechanics: when the recorded attestation is stale for a request, the host
/// asks the planner for the sync frame to send (a JSON object; the host adds
/// the `requestId`), then verifies the worker's attest/refusal response
/// itself. Unit gates script the worker side; Task 6 provides the real
/// planner (delta batch or full snapshot).
pub trait SyncPlanner {
    fn plan_sync(&self, attested: Option<&GraphIdentity>, target: &GraphIdentity)
    -> Result<Value>;
}

impl<F> SyncPlanner for F
where
    F: Fn(Option<&GraphIdentity>, &GraphIdentity) -> Result<Value>,
{
    fn plan_sync(
        &self,
        attested: Option<&GraphIdentity>,
        target: &GraphIdentity,
    ) -> Result<Value> {
        self(attested, target)
    }
}

#[derive(Clone, Debug)]
pub struct PersistentWorkerConfig {
    /// Executable to spawn (normally `node`); `arguments` carry the worker
    /// entry path plus `--persistent`. Corpus/source roots are NOT argv:
    /// exactly like the one-shot path, they travel inside request payloads
    /// (`ValidationProfile`), so the transport stays root-agnostic.
    pub(crate) executable: PathBuf,
    pub(crate) arguments: Vec<OsString>,
    /// Default per-request deadline; also the bounded wait `shutdown()` gives
    /// the worker to exit voluntarily after stdin EOF.
    pub(crate) deadline: Duration,
    pub(crate) max_request_bytes: usize,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_stderr_bytes: usize,
    /// Service epoch the host was spawned under (compare-and-kill, Task 6).
    pub(crate) service_epoch: u64,
}

impl PersistentWorkerConfig {
    pub fn new(
        executable: impl Into<PathBuf>,
        arguments: Vec<OsString>,
        deadline: Duration,
        service_epoch: u64,
    ) -> Self {
        Self {
            executable: executable.into(),
            arguments,
            deadline,
            max_request_bytes: MAX_REQUEST_FRAME_BYTES,
            max_response_bytes: MAX_RESPONSE_FRAME_BYTES,
            max_stderr_bytes: DEFAULT_MAX_STDERR_BYTES,
            service_epoch,
        }
    }

    #[cfg(test)]
    fn test_with_limits(
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
}

/// Host for one persistent worker child. Spawns the child eagerly in
/// [`Self::spawn`] and reuses it across requests; after a poison the next
/// `request_at` lazily respawns. Send + Sync: all mutable state lives behind
/// one mutex, which IS the single-flight/atomicity mechanism (B3).
pub struct PersistentWorkerHost {
    config: PersistentWorkerConfig,
    state: Mutex<HostState>,
}

struct HostState {
    worker: Option<Worker>,
    /// Cleared on every poison/respawn/shutdown; set ONLY by a verified
    /// attest response. `None` means the next request must sync.
    last_attestation: Option<GraphIdentity>,
    next_request_id: u64,
}

impl PersistentWorkerHost {
    pub fn spawn(config: PersistentWorkerConfig) -> Result<Self> {
        let worker = spawn_worker(&config)?;
        Ok(Self {
            config,
            state: Mutex::new(HostState {
                worker: Some(worker),
                last_attestation: None,
                next_request_id: 0,
            }),
        })
    }

    /// The service epoch this host was spawned under. Task 6's coordinator
    /// compares this against the current epoch and kills stale hosts.
    pub fn epoch(&self) -> u64 {
        self.config.service_epoch
    }

    /// THE semantic entry point (review B3): attestation check, sync (if
    /// stale), and the semantic exchange, all inside one critical section.
    /// `deadline` starts counting BEFORE the mutex is acquired.
    pub fn request_at(
        &self,
        identity: &GraphIdentity,
        frame: Value,
        deadline: Duration,
        planner: &dyn SyncPlanner,
    ) -> Result<Value> {
        let started = Instant::now();
        let mut state = lock_state(&self.state);
        let deadline_at = started
            .checked_add(deadline)
            .ok_or_else(|| anyhow!("persistent bridge request deadline is too large"))?;
        if Instant::now() >= deadline_at {
            // The worker was never touched; explicitly not a poison.
            bail!(
                "persistent bridge request deadline elapsed while queued for the worker \
                 (worker untouched)"
            );
        }

        // Bound the semantic frame BEFORE any worker interaction: an
        // oversized request is refused host-side, never written, never poison.
        let (semantic_id, semantic_frame) =
            encode_frame(&self.config, &mut state.next_request_id, frame)?;

        self.ensure_healthy_worker(&mut state)?;

        if state.last_attestation.as_ref() != Some(identity) {
            self.sync_locked(&mut state, identity, planner, deadline_at)?;
        }

        self.exchange_locked(&mut state, &semantic_id, semantic_frame, deadline_at)
    }

    /// Clean shutdown: close stdin (EOF is the contract — the worker loop
    /// exits 0 on it), wait `config.deadline` for a voluntary exit, kill on
    /// timeout, always reap. Returns the exit status, or `None` if no worker
    /// was running.
    pub fn shutdown(&self) -> Result<Option<ExitStatus>> {
        let mut state = lock_state(&self.state);
        state.last_attestation = None;
        let Some(mut worker) = state.worker.take() else {
            return Ok(None);
        };
        drop(state); // the child may take a while to exit; don't hold the lock

        // Dropping the writer channel makes the writer thread drop stdin —
        // that close is the clean EOF the worker is contracted to exit 0 on.
        worker.writer_tx.take();
        if let Some(handle) = worker.writer_thread.take() {
            let _ = handle.join();
        }
        let status = match worker.child.wait_timeout(self.config.deadline) {
            Ok(Some(status)) => status,
            Ok(None) => {
                let _ = worker.child.kill();
                worker
                    .child
                    .wait()
                    .context("reap persistent bridge worker after shutdown-timeout kill")?
            }
            Err(error) => {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
                return Err(anyhow!(error).context("wait for persistent bridge worker shutdown"));
            }
        };
        drop(worker); // joins reader/stderr threads (they see EOF after exit)
        Ok(Some(status))
    }

    /// Entry health check, run before any exchange. Three outcomes:
    /// - pending FRAME while nothing is outstanding → single-flight
    ///   violation → poison (error to this caller; the NEXT call respawns);
    /// - worker dead / reader gone (crashed between requests, or a prior
    ///   poison left no worker) → quiet lazy respawn with attestation
    ///   cleared;
    /// - otherwise healthy.
    fn ensure_healthy_worker(&self, state: &mut HostState) -> Result<()> {
        enum Entry {
            Healthy,
            Dead,
            Unsolicited,
        }
        let entry = match state.worker.as_ref() {
            None => Entry::Dead,
            Some(worker) => match worker.reader_rx.try_recv() {
                Ok(ReaderEvent::Frame(_)) | Ok(ReaderEvent::Oversize(_)) => Entry::Unsolicited,
                Ok(ReaderEvent::Eof) | Ok(ReaderEvent::IoError(_)) => Entry::Dead,
                Err(TryRecvError::Empty) => Entry::Healthy,
                Err(TryRecvError::Disconnected) => Entry::Dead,
            },
        };
        match entry {
            Entry::Healthy => Ok(()),
            Entry::Unsolicited => Err(self.poison(
                state,
                "frame received while no request was outstanding (single-flight violation)",
            )),
            Entry::Dead => {
                // Lazy respawn. Attestation stays cleared until a sync
                // succeeds against the fresh child (respawn ≠ re-attest).
                state.worker = None;
                state.last_attestation = None;
                state.worker = Some(spawn_worker(&self.config)?);
                Ok(())
            }
        }
    }

    /// Runs the sync exchange for `target` and verifies the worker's answer:
    /// a matching attest updates the recorded attestation; a refusal is an
    /// error WITHOUT poison (worker healthy, mirror not advanced); anything
    /// else is a protocol violation and poisons.
    fn sync_locked(
        &self,
        state: &mut HostState,
        target: &GraphIdentity,
        planner: &dyn SyncPlanner,
        deadline_at: Instant,
    ) -> Result<()> {
        let payload = planner
            .plan_sync(state.last_attestation.as_ref(), target)
            .context("sync planner failed to produce a sync frame")?;
        let (sync_id, sync_frame) = encode_frame(&self.config, &mut state.next_request_id, payload)?;
        let response = self.exchange_locked(state, &sync_id, sync_frame, deadline_at)?;

        match response.get("kind").and_then(Value::as_str) {
            Some("attest") => match parse_wire_identity(response.get("identity")) {
                Some(attested) if attested == *target => {
                    state.last_attestation = Some(target.clone());
                    Ok(())
                }
                Some(_) => Err(self.poison(
                    state,
                    "worker attested an identity different from the sync target",
                )),
                None => Err(self.poison(state, "attest response carries no parseable identity")),
            },
            Some("refuse") => {
                let reason = response
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unspecified")
                    .to_owned();
                bail!(
                    "persistent bridge worker refused sync ({reason}); \
                     the request must be served one-shot"
                )
            }
            _ => Err(self.poison(state, "sync response kind was neither attest nor refuse")),
        }
    }

    /// One single-flight exchange: write the frame, await the one correlated
    /// response. Every abnormal outcome poisons.
    fn exchange_locked(
        &self,
        state: &mut HostState,
        request_id: &str,
        framed: Vec<u8>,
        deadline_at: Instant,
    ) -> Result<Value> {
        let sent = state
            .worker
            .as_ref()
            .and_then(|worker| worker.writer_tx.as_ref())
            .map(|writer| writer.send(framed).is_ok())
            .unwrap_or(false);
        if !sent {
            return Err(self.poison(state, "worker stdin writer is unavailable"));
        }

        let outcome = {
            let worker = state
                .worker
                .as_ref()
                .expect("worker present while a request is outstanding");
            await_event(worker, deadline_at)
        };
        let bytes = match outcome {
            AwaitOutcome::Frame(bytes) => bytes,
            AwaitOutcome::StderrOverflow => {
                return Err(self.poison(state, "worker stderr exceeded the configured byte bound"));
            }
            AwaitOutcome::DeadlineExceeded => {
                return Err(self.poison(
                    state,
                    "request deadline exceeded while awaiting the worker response",
                ));
            }
            AwaitOutcome::Oversize(length) => {
                return Err(self.poison(
                    state,
                    &format!(
                        "worker response frame of {length} bytes exceeds the {}-byte response bound",
                        self.config.max_response_bytes
                    ),
                ));
            }
            AwaitOutcome::ChildEof => {
                return Err(self.poison(
                    state,
                    "worker closed stdout mid-request (crash or premature exit)",
                ));
            }
            AwaitOutcome::Io(error) => {
                return Err(self.poison(state, &format!("worker stdout read failed: {error}")));
            }
            AwaitOutcome::ReaderGone => {
                return Err(self.poison(state, "worker stdout reader terminated"));
            }
        };

        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                return Err(self.poison(state, &format!("malformed response frame JSON: {error}")));
            }
        };
        let response_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match response_id {
            Some(id) if id == request_id => Ok(value),
            Some(other) => Err(self.poison(
                state,
                &format!(
                    "response requestId {other:?} does not match the outstanding request \
                     {request_id:?}"
                ),
            )),
            None => Err(self.poison(state, "response frame carries no requestId")),
        }
    }

    /// Poison: kill + reap the child (via the worker's drop), clear the
    /// attestation, and hand the caller an error carrying the bounded stderr
    /// tail. The next `request_at` lazily respawns.
    fn poison(&self, state: &mut HostState, reason: &str) -> anyhow::Error {
        state.last_attestation = None;
        let stderr_tail = state
            .worker
            .take()
            .map(|worker| {
                let tail = worker.stderr_tail_lossy();
                drop(worker); // kill + reap + join
                tail
            })
            .unwrap_or_default();
        if stderr_tail.is_empty() {
            anyhow!("persistent bridge worker poisoned: {reason}")
        } else {
            anyhow!("persistent bridge worker poisoned: {reason}; worker stderr (bounded): {stderr_tail}")
        }
    }

    #[cfg(test)]
    fn worker_pid_for_test(&self) -> Option<u32> {
        lock_state(&self.state).worker.as_ref().map(|worker| worker.pid)
    }

    #[cfg(test)]
    fn last_attestation_for_test(&self) -> Option<GraphIdentity> {
        lock_state(&self.state).last_attestation.clone()
    }
}

impl Drop for PersistentWorkerHost {
    /// Hosts dropped without a clean `shutdown()` still never leak a child:
    /// the worker's own drop kills + reaps.
    fn drop(&mut self) {
        lock_state(&self.state).worker.take();
    }
}

/// A mutex poisoned by a panicking holder still guards structurally valid
/// state (every transition below completes before returning); recover it
/// rather than wedging every future caller.
fn lock_state(state: &Mutex<HostState>) -> MutexGuard<'_, HostState> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Stamps a fresh host-unique `requestId` into the payload, serializes it,
/// and enforces the REQUEST bound before anything can be written.
fn encode_frame(
    config: &PersistentWorkerConfig,
    next_request_id: &mut u64,
    mut payload: Value,
) -> Result<(String, Vec<u8>)> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| anyhow!("bridge frame payload must be a JSON object"))?;
    let request_id = format!("p{}", *next_request_id);
    *next_request_id += 1;
    object.insert("requestId".to_owned(), Value::String(request_id.clone()));
    let body = serde_json::to_vec(&payload).context("serialize bridge frame")?;
    ensure!(
        body.len() <= config.max_request_bytes,
        "bridge request frame of {} bytes exceeds the {}-byte request bound; \
         refused host-side before writing (worker untouched)",
        body.len(),
        config.max_request_bytes
    );
    let length = u32::try_from(body.len())
        .map_err(|_| anyhow!("bridge frame length does not fit the u32 prefix"))?;
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&length.to_le_bytes());
    framed.extend_from_slice(&body);
    Ok((request_id, framed))
}

/// Strict wire-identity parse: generation must be the canonical decimal
/// string (the `WireU64` convention — no signs, no leading zeros).
fn parse_wire_identity(value: Option<&Value>) -> Option<GraphIdentity> {
    let object = value?.as_object()?;
    let generation_text = object.get("generation")?.as_str()?;
    let generation = generation_text.parse::<u64>().ok()?;
    if generation.to_string() != generation_text {
        return None;
    }
    let digest = object.get("digest")?.as_str()?.to_owned();
    Some(GraphIdentity { generation, digest })
}

/// One live child plus its three I/O threads. Dropping a `Worker` is the
/// hard-kill path (poison, respawn, host drop): kill + reap + join, so no
/// path can leak a zombie. The clean path (`shutdown`) waits for a voluntary
/// exit first and only then drops.
struct Worker {
    child: Child,
    pid: u32,
    writer_tx: Option<Sender<Vec<u8>>>,
    writer_thread: Option<JoinHandle<()>>,
    reader_rx: Receiver<ReaderEvent>,
    reader_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    stderr_over: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

impl Worker {
    fn stderr_tail_lossy(&self) -> String {
        match self.stderr_tail.lock() {
            Ok(bytes) => String::from_utf8_lossy(&bytes).trim().to_owned(),
            Err(_) => String::new(),
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.writer_tx.take(); // lets the writer thread exit and drop stdin
        let _ = self.child.kill(); // no-op error if already exited — ignored
        let _ = self.child.wait(); // reap (or return the cached status)
        for handle in [
            self.writer_thread.take(),
            self.reader_thread.take(),
            self.stderr_thread.take(),
        ]
        .into_iter()
        .flatten()
        {
            let _ = handle.join();
        }
    }
}

enum ReaderEvent {
    Frame(Vec<u8>),
    /// Length prefix beyond the response bound; the reader stops immediately
    /// (the frame is never buffered).
    Oversize(usize),
    Eof,
    IoError(String),
}

enum AwaitOutcome {
    Frame(Vec<u8>),
    StderrOverflow,
    DeadlineExceeded,
    Oversize(usize),
    ChildEof,
    Io(String),
    ReaderGone,
}

/// Awaits the single outstanding response, polling so that a stderr overflow
/// or the deadline is noticed promptly even while the worker stays silent.
fn await_event(worker: &Worker, deadline_at: Instant) -> AwaitOutcome {
    const POLL: Duration = Duration::from_millis(10);
    loop {
        if worker.stderr_over.load(Ordering::SeqCst) {
            return AwaitOutcome::StderrOverflow;
        }
        let remaining = deadline_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return AwaitOutcome::DeadlineExceeded;
        }
        match worker.reader_rx.recv_timeout(remaining.min(POLL)) {
            Ok(ReaderEvent::Frame(bytes)) => {
                // Overflow wins over a simultaneously arriving frame.
                return if worker.stderr_over.load(Ordering::SeqCst) {
                    AwaitOutcome::StderrOverflow
                } else {
                    AwaitOutcome::Frame(bytes)
                };
            }
            Ok(ReaderEvent::Oversize(length)) => return AwaitOutcome::Oversize(length),
            Ok(ReaderEvent::Eof) => return AwaitOutcome::ChildEof,
            Ok(ReaderEvent::IoError(error)) => return AwaitOutcome::Io(error),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return AwaitOutcome::ReaderGone,
        }
    }
}

fn spawn_worker(config: &PersistentWorkerConfig) -> Result<Worker> {
    let mut command = Command::new(&config.executable);
    command
        .args(&config.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().with_context(|| {
        format!(
            "spawn persistent Node bridge worker {}",
            config.executable.display()
        )
    })?;
    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take())
    {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("persistent bridge worker pipes were not created");
        }
    };
    let pid = child.id();

    let (writer_tx, writer_rx) = channel::<Vec<u8>>();
    let writer_thread = thread::spawn(move || writer_loop(stdin, writer_rx));

    let (reader_tx, reader_rx) = channel::<ReaderEvent>();
    let response_limit = config.max_response_bytes;
    let reader_thread = thread::spawn(move || reader_loop(stdout, response_limit, reader_tx));

    let stderr_over = Arc::new(AtomicBool::new(false));
    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    let stderr_limit = config.max_stderr_bytes;
    let over_flag = Arc::clone(&stderr_over);
    let tail_buffer = Arc::clone(&stderr_tail);
    let stderr_thread =
        thread::spawn(move || stderr_loop(stderr, stderr_limit, over_flag, tail_buffer));

    Ok(Worker {
        child,
        pid,
        writer_tx: Some(writer_tx),
        writer_thread: Some(writer_thread),
        reader_rx,
        reader_thread: Some(reader_thread),
        stderr_thread: Some(stderr_thread),
        stderr_over,
        stderr_tail,
    })
}

fn writer_loop(mut stdin: ChildStdin, requests: Receiver<Vec<u8>>) {
    while let Ok(frame) = requests.recv() {
        if stdin.write_all(&frame).and_then(|()| stdin.flush()).is_err() {
            // Broken pipe: the reader observes the child's EOF/exit and the
            // host classifies the failure there; nothing to report here.
            return;
        }
    }
    // Channel closed (shutdown/poison): dropping stdin here is the clean EOF.
}

fn reader_loop(mut stdout: ChildStdout, limit: usize, events: Sender<ReaderEvent>) {
    loop {
        let mut prefix = [0_u8; 4];
        match read_full(&mut stdout, &mut prefix) {
            ReadOutcome::Full => {}
            ReadOutcome::Eof => {
                let _ = events.send(ReaderEvent::Eof);
                return;
            }
            ReadOutcome::Truncated => {
                let _ = events.send(ReaderEvent::IoError(
                    "stream ended inside a frame length prefix".to_owned(),
                ));
                return;
            }
            ReadOutcome::Failed(error) => {
                let _ = events.send(ReaderEvent::IoError(error.to_string()));
                return;
            }
        }
        let length = u32::from_le_bytes(prefix) as usize;
        if length > limit {
            // Poison signal; never buffer the oversized body.
            let _ = events.send(ReaderEvent::Oversize(length));
            return;
        }
        let mut body = vec![0_u8; length];
        match read_full(&mut stdout, &mut body) {
            ReadOutcome::Full => {
                if events.send(ReaderEvent::Frame(body)).is_err() {
                    return; // host side gone
                }
            }
            ReadOutcome::Eof | ReadOutcome::Truncated => {
                let _ = events.send(ReaderEvent::IoError(
                    "stream ended inside a frame body".to_owned(),
                ));
                return;
            }
            ReadOutcome::Failed(error) => {
                let _ = events.send(ReaderEvent::IoError(error.to_string()));
                return;
            }
        }
    }
}

enum ReadOutcome {
    Full,
    /// EOF on a clean frame boundary (no bytes of this read consumed).
    Eof,
    /// EOF mid-item: some bytes arrived, then the stream ended.
    Truncated,
    Failed(std::io::Error),
}

fn read_full<R: Read>(reader: &mut R, buffer: &mut [u8]) -> ReadOutcome {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => {
                return if filled == 0 {
                    ReadOutcome::Eof
                } else {
                    ReadOutcome::Truncated
                };
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return ReadOutcome::Failed(error),
        }
    }
    ReadOutcome::Full
}

/// Accumulates stderr up to `limit` (the bounded tail used in poison errors)
/// and raises `over` the moment the bound is exceeded — but keeps draining
/// so the child can never block on a full stderr pipe (same discipline as
/// the one-shot path's bounded reader).
fn stderr_loop(
    mut stderr: ChildStderr,
    limit: usize,
    over: Arc<AtomicBool>,
    tail: Arc<Mutex<Vec<u8>>>,
) {
    let mut captured = 0_usize;
    let mut buffer = [0_u8; 8192];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                let retained = limit.saturating_sub(captured).min(read);
                if retained > 0
                    && let Ok(mut bytes) = tail.lock()
                {
                    bytes.extend_from_slice(&buffer[..retained]);
                }
                captured = captured.saturating_add(read);
                if captured > limit {
                    over.store(true, Ordering::SeqCst);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GraphIdentity, PersistentWorkerConfig, PersistentWorkerHost, SyncPlanner};
    use crate::bridge::process::{DEFAULT_MAX_STDERR_BYTES, MAX_RESPONSE_FRAME_BYTES};
    use anyhow::Result;
    use serde_json::{Value, json};
    use std::ffi::OsString;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    const TEST_EPOCH: u64 = 7;
    const GENEROUS: Duration = Duration::from_secs(10);

    fn fake_worker_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-worker.js")
    }

    fn fake_worker_config(mode_arguments: &[String]) -> PersistentWorkerConfig {
        let mut arguments = vec![
            fake_worker_path().into_os_string(),
            OsString::from("--persistent"),
        ];
        arguments.extend(mode_arguments.iter().map(OsString::from));
        PersistentWorkerConfig::new("node", arguments, GENEROUS, TEST_EPOCH)
    }

    fn identity(generation: u64, digest: &str) -> GraphIdentity {
        GraphIdentity {
            generation,
            digest: digest.to_owned(),
        }
    }

    /// Planner used by every gate: emits a well-formed sync frame carrying a
    /// `tag` (so the fake worker's log can attribute frames to a caller) and
    /// counts invocations (so tests can assert the attested fast path skips
    /// the sync exchange entirely).
    struct CountingPlanner {
        tag: &'static str,
        calls: AtomicUsize,
    }

    impl CountingPlanner {
        fn new(tag: &'static str) -> Self {
            Self {
                tag,
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl SyncPlanner for CountingPlanner {
        fn plan_sync(
            &self,
            _attested: Option<&GraphIdentity>,
            target: &GraphIdentity,
        ) -> Result<Value> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "kind": "sync",
                "tag": self.tag,
                "target": {
                    "generation": target.generation.to_string(),
                    "digest": target.digest.clone(),
                },
            }))
        }
    }

    #[test]
    fn sync_then_dispatch_with_attested_fast_path_and_epoch() {
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=echo".into()])).unwrap();
        assert_eq!(host.epoch(), TEST_EPOCH);
        let planner = CountingPlanner::new("A");
        let id = identity(1, "digest-a");

        let first = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        assert_eq!(first.get("echo").and_then(Value::as_str), Some("A"));
        assert_eq!(host.last_attestation_for_test(), Some(id.clone()));

        let second = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        assert_eq!(second.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(planner.calls(), 1, "attested identity must skip sync");
        host.shutdown().unwrap();
    }

    #[test]
    fn oversized_request_is_refused_host_side_without_poisoning() {
        // Gate (a), request half: a request beyond the request bound is
        // refused BEFORE anything is written — the worker is untouched.
        let config = fake_worker_config(&["--mode=echo".into()]).test_with_limits(
            512,
            MAX_RESPONSE_FRAME_BYTES,
            DEFAULT_MAX_STDERR_BYTES,
        );
        let host = PersistentWorkerHost::spawn(config).unwrap();
        let pid = host.worker_pid_for_test().unwrap();
        let planner = CountingPlanner::new("A");
        let id = identity(1, "digest-a");

        let error = host
            .request_at(&id, json!({"tag": "x".repeat(2048)}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("request bound"), "{error}");
        assert!(!error.contains("poisoned"), "{error}");
        assert_eq!(host.worker_pid_for_test(), Some(pid), "worker untouched");

        host.request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        assert_eq!(host.worker_pid_for_test(), Some(pid));
    }

    #[test]
    fn oversized_response_frame_poisons() {
        // Gate (a), response half: a frame whose length prefix exceeds the
        // response bound poisons the host.
        let config = fake_worker_config(&[
            "--mode=oversize-response".into(),
            "--oversize-len=4096".into(),
        ])
        .test_with_limits(32 * 1024 * 1024, 1024, DEFAULT_MAX_STDERR_BYTES);
        let host = PersistentWorkerHost::spawn(config).unwrap();
        let planner = CountingPlanner::new("A");

        let error = host
            .request_at(&identity(1, "digest-a"), json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("response bound"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
        assert_eq!(host.last_attestation_for_test(), None);
    }

    #[test]
    fn unsolicited_frame_poisons_and_next_call_respawns_with_new_pid() {
        // Gate (b): a frame arriving while nothing is outstanding is a
        // single-flight violation; the detecting call errors, the one after
        // it lazily respawns.
        let host = PersistentWorkerHost::spawn(fake_worker_config(&[
            "--mode=extra-frame".into(),
        ]))
        .unwrap();
        let planner = CountingPlanner::new("A");
        let id = identity(1, "digest-a");

        host.request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        let first_pid = host.worker_pid_for_test().unwrap();
        thread::sleep(Duration::from_millis(300)); // let the extra frame land

        let error = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("single-flight"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
        assert_eq!(host.last_attestation_for_test(), None);

        host.request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        let respawned_pid = host.worker_pid_for_test().unwrap();
        assert_ne!(respawned_pid, first_pid, "poison must force a fresh child");
    }

    #[test]
    fn request_id_mismatch_poisons() {
        // Gate (c).
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=wrong-id".into()])).unwrap();
        let planner = CountingPlanner::new("A");

        let error = host
            .request_at(&identity(1, "digest-a"), json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("does not match"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
        assert_eq!(host.last_attestation_for_test(), None);
    }

    #[test]
    fn deadline_exceeded_mid_request_poisons() {
        // Gate (d), main case: a sleepy worker forces the caller's deadline.
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=silent".into()])).unwrap();
        let planner = CountingPlanner::new("A");

        let error = host
            .request_at(
                &identity(1, "digest-a"),
                json!({"tag": "A"}),
                Duration::from_millis(300),
                &planner,
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("deadline"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
    }

    #[test]
    fn queued_caller_deadline_expires_without_poisoning_worker() {
        // Gate (d), queue-wait case: queue wait counts against the deadline,
        // and a caller that never reached the worker must NOT poison it.
        let host = Arc::new(
            PersistentWorkerHost::spawn(fake_worker_config(&[
                "--mode=slow".into(),
                "--delay-ms=600".into(),
            ]))
            .unwrap(),
        );
        let pid = host.worker_pid_for_test().unwrap();
        let id = identity(1, "digest-a");

        let busy_host = Arc::clone(&host);
        let busy_id = id.clone();
        let busy = thread::spawn(move || {
            let planner = CountingPlanner::new("A");
            busy_host.request_at(&busy_id, json!({"tag": "A"}), GENEROUS, &planner)
        });
        thread::sleep(Duration::from_millis(150)); // busy caller holds the worker

        let planner = CountingPlanner::new("B");
        let error = host
            .request_at(&id, json!({"tag": "B"}), Duration::from_millis(200), &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("queued"), "{error}");
        assert!(!error.contains("poisoned"), "{error}");
        assert_eq!(planner.calls(), 0, "queued caller never reached the worker");

        busy.join().unwrap().unwrap(); // the slow first caller completed fine
        assert_eq!(host.worker_pid_for_test(), Some(pid), "no respawn happened");
        host.request_at(&id, json!({"tag": "B"}), GENEROUS, &planner)
            .unwrap();
        assert_eq!(host.worker_pid_for_test(), Some(pid));
    }

    #[test]
    fn stderr_overflow_poisons() {
        // Gate (e).
        let config = fake_worker_config(&[
            "--mode=stderr-flood".into(),
            "--stderr-bytes=8192".into(),
        ])
        .test_with_limits(32 * 1024 * 1024, MAX_RESPONSE_FRAME_BYTES, 1024);
        let host = PersistentWorkerHost::spawn(config).unwrap();
        let planner = CountingPlanner::new("A");

        let error = host
            .request_at(&identity(1, "digest-a"), json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("stderr"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
    }

    #[test]
    fn crash_mid_request_errors_and_next_call_lazily_respawns() {
        // Gate (f).
        let dir = tempdir().unwrap();
        let marker = dir.path().join("crashed-once");
        let host = PersistentWorkerHost::spawn(fake_worker_config(&[
            "--mode=crash-once".into(),
            format!("--marker={}", marker.display()),
        ]))
        .unwrap();
        let first_pid = host.worker_pid_for_test().unwrap();
        let planner = CountingPlanner::new("A");
        let id = identity(1, "digest-a");

        let error = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);

        let response = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();
        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        let respawned_pid = host.worker_pid_for_test().unwrap();
        assert_ne!(respawned_pid, first_pid);
        assert_eq!(
            planner.calls(),
            2,
            "respawn does not re-attest: the second call must sync again"
        );
    }

    #[test]
    fn clean_shutdown_reaps_worker_with_exit_zero() {
        // Gate (g): stdin EOF is the shutdown contract; the fake exits 0 on
        // EOF and the host reaps it (no zombie).
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=echo".into()])).unwrap();
        let planner = CountingPlanner::new("A");
        host.request_at(&identity(1, "digest-a"), json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap();

        let status = host.shutdown().unwrap().expect("a worker was running");
        assert!(status.success(), "fake worker exits 0 on stdin EOF: {status}");
        assert_eq!(host.worker_pid_for_test(), None);
        assert!(host.shutdown().unwrap().is_none(), "idempotent shutdown");
    }

    #[test]
    fn malformed_response_frame_poisons() {
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=malformed".into()])).unwrap();
        let planner = CountingPlanner::new("A");

        let error = host
            .request_at(&identity(1, "digest-a"), json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("poisoned"), "{error}");
        assert!(error.contains("malformed"), "{error}");
        assert_eq!(host.worker_pid_for_test(), None);
    }

    #[test]
    fn sync_refusal_is_an_error_without_poison() {
        // A refusal is a healthy-worker outcome: mirror not advanced, worker
        // alive, attestation unchanged (Task 6 wires the one-shot fallback).
        let host =
            PersistentWorkerHost::spawn(fake_worker_config(&["--mode=refuse".into()])).unwrap();
        let planner = CountingPlanner::new("A");
        let id = identity(1, "digest-a");

        let error = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("refused sync"), "{error}");
        assert!(!error.contains("poisoned"), "{error}");
        assert!(host.worker_pid_for_test().is_some(), "worker stays alive");
        assert_eq!(host.last_attestation_for_test(), None);

        let error = host
            .request_at(&id, json!({"tag": "A"}), GENEROUS, &planner)
            .unwrap_err()
            .to_string();
        assert!(error.contains("refused sync"), "{error}");
        assert_eq!(planner.calls(), 2, "still stale: sync attempted again");
    }

    #[test]
    fn g_and_g_plus_one_sync_dispatch_pairs_never_interleave() {
        // Gate (h): two threads with different graph identities; the fake
        // logs frame receipt order. Every sync frame must be IMMEDIATELY
        // followed by its own thread's semantic frame — thread B's sync must
        // never land between thread A's sync and A's semantic dispatch.
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("frames.log");
        let host = Arc::new(
            PersistentWorkerHost::spawn(fake_worker_config(&[
                "--mode=echo".into(),
                format!("--log={}", log_path.display()),
            ]))
            .unwrap(),
        );

        let mut handles = Vec::new();
        for (tag, id) in [
            ("A", identity(1, "digest-g")),
            ("B", identity(2, "digest-g-plus-1")),
        ] {
            let host = Arc::clone(&host);
            handles.push(thread::spawn(move || {
                let planner = CountingPlanner::new(tag);
                for _ in 0..5 {
                    host.request_at(&id, json!({"tag": tag}), GENEROUS, &planner)
                        .unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let content = fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(
            lines.iter().filter(|line| !line.starts_with("sync:")).count(),
            10,
            "every call dispatched exactly one semantic frame; log:\n{content}"
        );
        assert!(
            lines.contains(&"sync:A") && lines.contains(&"sync:B"),
            "alternating identities must force syncs from both threads; log:\n{content}"
        );
        for (index, line) in lines.iter().enumerate() {
            if let Some(tag) = line.strip_prefix("sync:") {
                let next = lines.get(index + 1).unwrap_or_else(|| {
                    panic!("sync:{tag} at the end of the log without its semantic frame:\n{content}")
                });
                assert_eq!(
                    *next,
                    format!("semantic:{tag}"),
                    "sync:{tag} at line {index} must be immediately followed by its own \
                     semantic frame (atomic request_at); log:\n{content}"
                );
            }
        }
    }
}
