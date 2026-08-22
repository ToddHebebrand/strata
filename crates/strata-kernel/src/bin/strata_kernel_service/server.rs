use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::protocol::{
    LocalServiceResponse, MAX_HANDSHAKE_FRAME_BYTES, MAX_REQUEST_FRAME_BYTES, PROTOCOL_VERSION,
    FirstFrame, HealthReply, OpenSession, OpenSessionTag, SessionReply, SessionRole, WireU64,
    parse_first_frame, serialize_health_reply, serialize_response_frame,
    serialize_session_reply,
};
use super::lifecycle::{self, CanonicalStateDir, EndpointClaim, OwnerLock, SocketRoot};
use super::ownership::{Binding, OwnershipRegistry};
use super::session::{ServiceConfig, ServiceSession, SessionBinding};

const SOCKET_DIRECTORY: &str = "/tmp/strata-lc";
const MAX_SOCKET_PATH_BYTES: usize = 96;

/// Maximum bounded diagnostic lines a refusing daemon prints to stderr. The
/// operator needs enough of the failing tsc/vitest output to act on; the cap
/// keeps a pathological run from flooding a startup log.
const MAX_REFUSAL_DIAGNOSTIC_LINES: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Readiness {
    protocol_version: u8,
    socket_path: String,
    service_epoch: String,
    recovered: bool,
    /// Session validation identity (B-2 Task 7). The readiness line is a
    /// SERVICE-INTERNAL stdout handshake, not the client wire, so these are
    /// additive here: the digest key is omitted entirely without a manifest,
    /// where the client-facing `hello` instead carries an explicit `null`.
    validation_mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_manifest_digest: Option<String>,
}

pub(super) fn serve(config: ServiceConfig, socket_token: &str) -> Result<()> {
    serve_in_root(config, socket_token, SocketRoot::production()?)
}

pub(super) fn serve_in_root(
    config: ServiceConfig,
    socket_token: &str,
    root: SocketRoot,
) -> Result<()> {
    validate_token(socket_token)?;
    let token_hash = token_hash(socket_token);

    // OWNERSHIP FIRST, and the ordering is the whole point. `open` below
    // recovers and constructs durable state, so a daemon that owns neither the
    // state directory nor the endpoint must be excluded BEFORE any of that
    // work -- not when it eventually tries to bind. The loser's guarantee is
    // "no canonical-state mutation"; argument parsing and manifest reading are
    // read-only preflight and legitimately already happened.
    //
    // Fixed order, state then endpoint. LOCK_NB is what actually makes
    // deadlock impossible, but the order is the property that survives if
    // these ever become blocking.
    let canonical = CanonicalStateDir::resolve(&config.db_path)?;
    let owner = OwnerLock::acquire(&canonical)
        .map_err(|refusal| refusal.into_error("this state directory"))?;
    let _endpoint = EndpointClaim::acquire(&root, &token_hash)
        .map_err(|refusal| refusal.into_error("this socket endpoint"))?;

    // Recovery is intentionally complete before the authority becomes reachable.
    let (session, service_epoch) = ServiceSession::open(config)?;
    // Only now are BOTH locks held AND the epoch real. Publishing earlier would
    // leave misleading owner metadata behind for a daemon that won the state
    // lock and then lost the endpoint claim.
    owner.publish_diagnostics(std::process::id(), service_epoch)?;
    // Seed-green gate (B-2 Task 7). Runs for ANY operator manifest — a
    // `tscOnly` manifest gets a tsc-only baseline, a behavioral one gets tsc +
    // fixtures — and strictly BEFORE both the start audit event and the socket
    // bind. A daemon that cannot prove its own corpus green must leave no
    // trace of a session it never served, so a refusal happens here, before
    // `finalize_startup` writes anything.
    //
    // Fail-closed in BOTH directions: a red verdict and an operational failure
    // to reach a verdict both refuse. Without a manifest there is no baseline
    // at all and this whole block is skipped, leaving the pre-B-2 startup
    // sequence (open → finalize → hydrate → bind → readiness) untouched.
    if session.requires_seed_green_baseline() {
        refuse_unless_seed_green(&session)?;
    }
    session.finalize_startup()?;
    // Eager persistent-mirror hydration (Task 6): after seed/recovery,
    // strictly BEFORE the readiness line below, so a ready daemon already
    // holds an attested mirror and the first analyze trip is snapshot-free.
    // A hydration failure must NOT kill the service: log and continue — the
    // first mirror-routed request lazily retries the sync (documented
    // startup contract; the gate-3 child times only submit+advance, so this
    // cost is out-of-window for both arms and disclosed in the exit
    // artifact's service-start wall).
    if let Err(error) = session.eager_hydrate_persistent_bridge() {
        eprintln!(
            "persistent bridge eager hydration failed; continuing with lazy retry on \
             first use: {error:#}"
        );
    }
    // Record BEFORE bind. This ordering is what makes every crash point exactly
    // recoverable: a crash after the record leaves a record naming the exact
    // socket, and a crash before it leaves no new socket at all. Binding first
    // would leave an UNRECORDED orphan on every crash in that window, which is
    // debris that grows without limit and needs a directory sweep to clean up.
    let root = std::sync::Arc::new(root);
    lifecycle::reclaim_recorded_predecessor(&root, &token_hash)?;
    let mut nonce = lifecycle::fresh_nonce();
    // Never unlink a colliding candidate merely because its name matches --
    // regenerate instead.
    while root.child_is_socket(&SocketRoot::socket_name(&token_hash, &nonce)) {
        nonce = lifecycle::fresh_nonce();
    }
    let socket_name = SocketRoot::socket_name(&token_hash, &nonce);
    lifecycle::EndpointRecord::publish(&root, &token_hash, &socket_name)?;
    let (bound, listener) = lifecycle::BoundEndpoint::bind(&root, &token_hash, &nonce)?;
    let socket_path = bound.path().to_owned();
    validate_socket_path_in(&socket_path, root.path())?;
    let ready = Readiness {
        protocol_version: PROTOCOL_VERSION,
        socket_path: socket_path.to_string_lossy().into_owned(),
        service_epoch: service_epoch.to_string(),
        recovered: session.recovered(),
        validation_mode: session.validation_mode().as_label(),
        validation_manifest_digest: session
            .validation_manifest_digest()
            .map(str::to_owned),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &ready)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);

    let admission = Arc::new(Admission::default());
    let ownership = Arc::new(OwnershipRegistry::default());
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                // Capacity FIRST. An over-cap connection is refused without
                // ever costing a handler thread.
                let Some((permit, pool)) = admission.admit() else {
                    refuse_over_cap(stream);
                    continue;
                };
                let session = Arc::clone(&session);
                let ownership = Arc::clone(&ownership);
                thread::spawn(move || {
                    let _ = handle_connection(
                        stream,
                        &session,
                        service_epoch,
                        permit,
                        pool,
                        ownership,
                    );
                });
            }
            Err(error) => return Err(error).context("accept local service connection"),
        }
    }
    Ok(())
}

/// Runs the seed-green baseline and turns anything but a green verdict into a
/// startup failure. `Err` here reaches `main`, which prints the chain and
/// exits 2 — the daemon's existing pre-readiness failure surface, so a caller
/// waiting on the stdout readiness line sees EOF rather than a bound socket.
fn refuse_unless_seed_green(session: &ServiceSession) -> Result<()> {
    let verdict = session
        .validate_baseline()
        .context("seed-green baseline could not be established; refusing to serve")?;
    if verdict.green {
        return Ok(());
    }
    let mut message = String::from(
        "seed-green baseline is not green; refusing to serve this corpus. \
         Validation output (truncated):",
    );
    for diagnostic in verdict
        .diagnostics
        .iter()
        .take(MAX_REFUSAL_DIAGNOSTIC_LINES)
    {
        message.push_str("\n  ");
        message.push_str(&diagnostic.message);
    }
    if verdict.diagnostics.len() > MAX_REFUSAL_DIAGNOSTIC_LINES {
        message.push_str(&format!(
            "\n  ... {} further diagnostic line(s) suppressed",
            verdict.diagnostics.len() - MAX_REFUSAL_DIAGNOSTIC_LINES
        ));
    }
    bail!(message)
}

/// Validates a socket path against the root it is supposed to live in.
///
/// The root is a PARAMETER rather than the hard-coded production constant, so
/// that a test-injected root flows through the same validation production uses
/// instead of bypassing it.
pub(super) fn validate_socket_path_in(path: &Path, root: &Path) -> Result<()> {
    let encoded = path
        .to_str()
        .context("local service socket path must be valid UTF-8")?;
    let parent = path
        .parent()
        .context("local service socket path has no parent")?;
    if parent != root {
        bail!(
            "local service socket must be directly under {}",
            root.display()
        );
    }
    if encoded.len() > MAX_SOCKET_PATH_BYTES {
        bail!("local service socket path exceeds 96 UTF-8 bytes");
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("local service socket has no UTF-8 basename")?;
    let stem = name
        .strip_suffix(".sock")
        .context("local service socket must end in .sock")?;
    // D-3a: `<sha256-token-hash>.<incarnation-nonce>`. The nonce is what makes
    // a leftover socket impossible to confuse with a live one, so the shape is
    // enforced rather than merely tolerated.
    let (hash, nonce) = stem
        .split_once('.')
        .context("local service socket basename must carry an incarnation nonce")?;
    let hex = |value: &str| {
        value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if hash.len() != 64 || !hex(hash) {
        bail!("local service socket basename must begin with a SHA-256 token hash");
    }
    if nonce.is_empty() || nonce.len() > lifecycle::MAX_NONCE_HEX || !hex(nonce) {
        bail!("local service socket incarnation nonce must be 1..=11 lowercase hex characters");
    }
    Ok(())
}

pub(super) fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn validate_token(token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 512 {
        bail!("socket token must contain between 1 and 512 UTF-8 bytes");
    }
    Ok(())
}


/// Total connections the daemon will hold open at once.
///
/// Ten actors imply twenty normal lanes. The cap is not twenty: takeover
/// requires a replacement lane to CONNECT while the lane it replaces still
/// holds its permit, so a cap sized to the steady state would deadlock exactly
/// the recovery path it was meant to protect.
const MAX_ADMITTED_CONNECTIONS: usize = 64;
/// Of those, how many may simultaneously be un-handshaken. A peer that
/// connects and says nothing is the cheapest possible attack, so it gets the
/// tightest budget -- exhausting this cannot touch established sessions.
const MAX_UNHANDSHAKEN_CONNECTIONS: usize = 16;
/// How long the ACCEPT LOOP will spend writing a refusal to an over-cap peer.
/// Deliberately short: this write is inline, because spawning a thread to
/// deliver a refusal would reintroduce the unbounded-thread problem the cap
/// exists to solve. A peer that will not read its own refusal costs the
/// listener this much and no more.
const BUSY_REFUSAL_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
/// Slots reserved ABOVE the session cap for control probes (`health` today,
/// `stop` in D-3b).
///
/// Above rather than carved out of the 64: that number was chosen as takeover
/// headroom, not demonstrated as a resource cliff, and carving would drop
/// established capacity to 62 for no reason. The cost is two accepted fds, two
/// handler threads, and bounded first-frame buffers.
///
/// The true ceiling is therefore 66 admitted/handler-owned connections, PLUS at
/// most one transient connection already accepted and held for the inline
/// refusal below. "Physical maximum 66" would be wrong.
const CONTROL_RESERVE_SLOTS: usize = 2;
/// One ABSOLUTE deadline for a reserve occupant, covering read, classification,
/// AND response flush. It replaces the 5s write timeout for these connections
/// rather than sitting beside it -- a second, longer timer would dominate the
/// flush and make the 1s promise meaningless.
///
/// What this bounds is each occupant's TENURE. It is not a guarantee of
/// eventual reachability: a peer that continuously reacquires freed slots can
/// still starve control. Same-UID hostility is outside the threat model.
const CONTROL_CANDIDATE_DEADLINE: Duration = Duration::from_secs(1);

/// Bounded connection admission.
///
/// Before D-2 every accepted connection spawned a detached thread with no cap,
/// and a valid request could occupy one for the protocol's full 300-second
/// ceiling because the socket timeout does not bound request execution. That
/// made connection and request storms a live resource-exhaustion path on the
/// running daemon, not a theoretical one.
#[derive(Default)]
struct Admission {
    counts: Mutex<AdmissionCounts>,
}

#[derive(Default)]
struct AdmissionCounts {
    admitted: usize,
    unhandshaken: usize,
    control: usize,
}

impl Admission {
    /// Takes a permit, or `None` when either cap is reached. Called BEFORE the
    /// handler thread is spawned, so an over-cap connection never costs a
    /// thread at all.
    fn admit(self: &Arc<Self>) -> Option<(AdmissionPermit, AdmissionPool)> {
        // Recover from poisoning rather than propagating it. A poisoned
        // admission mutex would otherwise refuse EVERY future connection for
        // the daemon's remaining lifetime -- a permanent outage caused by one
        // panic in a critical section that only does arithmetic.
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let normal_available = counts.admitted < MAX_ADMITTED_CONNECTIONS
            && counts.unhandshaken < MAX_UNHANDSHAKEN_CONNECTIONS;
        let pool = if normal_available {
            AdmissionPool::Normal
        } else if counts.control < CONTROL_RESERVE_SLOTS {
            // The session pools are full. The reserve exists so that health --
            // and, in D-3b, stop -- do not go blind exactly when they are most
            // needed.
            AdmissionPool::ControlCandidate
        } else {
            return None;
        };
        counts.admitted += 1;
        match pool {
            AdmissionPool::Normal => counts.unhandshaken += 1,
            AdmissionPool::ControlCandidate => counts.control += 1,
        }
        Some((
            AdmissionPermit {
                admission: Arc::clone(self),
                pool,
                handshaken: false,
            },
            pool,
        ))
    }
}

/// Which budget a permit came out of.
///
/// A connection's KIND is not knowable at admission -- the permit is taken
/// before the first frame is read -- so `ControlCandidate` means "admitted into
/// the reserve", not "known to be a control probe". A candidate that turns out
/// to be an `open_session` is refused rather than promoted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdmissionPool {
    Normal,
    ControlCandidate,
}

/// RAII: the permit is released when the handler thread unwinds or returns,
/// including on panic. Nothing in the handler has to remember to give it back.
struct AdmissionPermit {
    admission: Arc<Admission>,
    pool: AdmissionPool,
    handshaken: bool,
}

impl AdmissionPermit {
    /// Moves this connection out of the un-handshaken budget and into the
    /// established one. Called once, the moment the handshake succeeds.
    fn handshaken(&mut self) {
        if self.handshaken {
            return;
        }
        self.handshaken = true;
        if self.pool != AdmissionPool::Normal {
            return;
        }
        let mut counts = self
            .admission
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counts.unhandshaken = counts.unhandshaken.saturating_sub(1);
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        // Must not silently skip on poisoning: a permit that is never given
        // back is a permanently lost slot out of 64.
        let mut counts = self
            .admission
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counts.admitted = counts.admitted.saturating_sub(1);
        match self.pool {
            AdmissionPool::Normal if !self.handshaken => {
                counts.unhandshaken = counts.unhandshaken.saturating_sub(1);
            }
            AdmissionPool::ControlCandidate => {
                counts.control = counts.control.saturating_sub(1);
            }
            AdmissionPool::Normal => {}
        }
    }
}

/// Absolute wall-clock a connection gets to complete its handshake, measured
/// from accept. Absolute rather than per-read: a peer that trickles one byte
/// per second must not be able to hold a handler open indefinitely.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);
/// Absolute wall-clock a PARTIAL request frame may remain incomplete, measured
/// from its first byte rather than reset by each byte, for the same reason.
const PARTIAL_FRAME_DEADLINE: Duration = Duration::from_secs(5);
/// How long an established, fully-drained session may sit idle before the
/// daemon reclaims its handler. Clients reconnect lazily, so this is invisible
/// to a caller that simply pauses.
const ESTABLISHED_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Socket read timeout. This is only a POLL granularity — it wakes the reader
/// so it can re-check whichever absolute deadline is in force. It is never
/// itself the timeout a peer observes.
const READ_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Incremental line-delimited frame reader.
///
/// Splits at the FIRST `\n` and retains the remainder as the next frame's
/// prefix, so a peer that writes two frames into one chunk does not lose the
/// second. The scan resumes from the last examined offset instead of
/// rescanning the whole buffer, which keeps a large partial frame from costing
/// O(n^2) as it arrives.
///
/// Deliberately does NOT relax `decode_frame`'s interior-newline check: this
/// layer splits BEFORE calling the shared frame validator, so that validator
/// is untouched and still refuses a frame with an embedded newline.
struct FrameReader {
    buffer: Vec<u8>,
    scanned: usize,
}

impl FrameReader {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            scanned: 0,
        }
    }

    /// True when bytes of a partial frame are already buffered — the caller
    /// uses this to decide whether the idle deadline or the (much shorter)
    /// partial-frame deadline applies.
    fn partial(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// Pops one complete frame if the buffer holds a delimiter, else `None`.
    fn take_frame(&mut self, max_bytes: usize) -> Result<Option<Vec<u8>>> {
        if let Some(offset) = self.buffer[self.scanned..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = self.scanned + offset + 1;
            if end > max_bytes {
                bail!("frame exceeds {max_bytes} byte bound");
            }
            let frame: Vec<u8> = self.buffer.drain(..end).collect();
            self.scanned = 0;
            return Ok(Some(frame));
        }
        self.scanned = self.buffer.len();
        if self.buffer.len() > max_bytes {
            bail!("frame exceeds {max_bytes} byte bound");
        }
        Ok(None)
    }

    /// Reads until one whole frame is available. `Ok(None)` is a CLEAN end of
    /// stream — the peer closed between frames, which is a normal session
    /// close, not an error. EOF with a partial frame buffered is an error.
    ///
    /// `deadline` is recomputed by the caller-supplied closure on every wake so
    /// that the applicable bound can change the moment the first byte of a
    /// frame arrives.
    fn read_frame(
        &mut self,
        stream: &mut UnixStream,
        max_bytes: usize,
        mut deadline: impl FnMut(&Self) -> Instant,
    ) -> Result<Option<Vec<u8>>> {
        let mut chunk = [0_u8; 4096];
        loop {
            if let Some(frame) = self.take_frame(max_bytes)? {
                return Ok(Some(frame));
            }
            if Instant::now() >= deadline(self) {
                bail!("frame deadline exceeded");
            }
            match stream.read(&mut chunk) {
                Ok(0) => {
                    if self.partial() {
                        bail!("connection ended mid-frame");
                    }
                    return Ok(None);
                }
                Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
                // The poll interval elapsing is not a failure; it is the
                // reader waking to re-check the absolute deadline above.
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error).context("read local service frame"),
            }
        }
    }
}

/// Serves ONE connection: handshake first, then request/response until the
/// peer closes or a deadline fires.
///
/// Strictly one outstanding request per connection — request, response,
/// request. The retry contract depends on there being at most one ambiguous
/// request per lane, so pipelining is deliberately not supported; a peer that
/// writes two request frames back-to-back has its second frame served only
/// after the first response is written.
/// Tells an over-cap peer WHY, in a frame it can parse, then closes.
///
/// A silent close would be indistinguishable from a crashed daemon, and a
/// client that cannot tell those apart cannot choose between backing off and
/// giving up. `server_busy` is marked retryable so it backs off with jitter.
fn refuse_over_cap(mut stream: UnixStream) {
    let _ = stream.set_write_timeout(Some(BUSY_REFUSAL_WRITE_TIMEOUT));
    let reply = SessionReply::rejected(
        "server_busy",
        "daemon is at its connection admission cap; retry with backoff",
        true,
    );
    if let Ok(frame) = serialize_session_reply(&reply) {
        let _ = stream.write_all(&frame);
        let _ = stream.flush();
    }
}

/// Writes a handshake refusal and ends the connection. Always `Ok`: refusing a
/// peer is a normal outcome of serving one, not a failure of the daemon.
fn refuse_handshake(
    stream: &mut UnixStream,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    let reply = SessionReply::rejected(code, message, retryable);
    if let Ok(frame) = serialize_session_reply(&reply) {
        let _ = stream.write_all(&frame);
        let _ = stream.flush();
    }
    Ok(())
}

/// Releases a lane binding when the handler leaves, by any route including a
/// panic. Removal is token-checked, so a fenced handler unwinding late cannot
/// unregister the connection that replaced it.
struct LaneGuard {
    ownership: Arc<OwnershipRegistry>,
    actor: String,
    role: SessionRole,
    token: u64,
}

impl Drop for LaneGuard {
    fn drop(&mut self) {
        self.ownership.release(&self.actor, self.role, self.token);
    }
}

fn handle_connection(
    mut stream: UnixStream,
    session: &ServiceSession,
    service_epoch: u64,
    mut permit: AdmissionPermit,
    pool: AdmissionPool,
    ownership: Arc<OwnershipRegistry>,
) -> Result<()> {
    let accepted = Instant::now();
    let control = pool == AdmissionPool::ControlCandidate;
    stream.set_read_timeout(Some(READ_POLL_INTERVAL))?;
    // A reserve occupant gets ONE absolute deadline covering read,
    // classification, and flush. Setting the usual 5s write timeout here would
    // dominate the flush and make the 1s bound meaningless.
    stream.set_write_timeout(Some(if control {
        CONTROL_CANDIDATE_DEADLINE
    } else {
        Duration::from_secs(5)
    }))?;
    let mut reader = FrameReader::new();

    // The two failure modes are kept apart because they mean different things
    // to a client: "you spoke a protocol I do not serve" is terminal, while
    // "you did not finish speaking in time" is a transport problem worth
    // retrying. Collapsing them into one code would tell a slow-but-correct
    // client to give up.
    let first_frame_deadline = if control {
        accepted + CONTROL_CANDIDATE_DEADLINE
    } else {
        accepted + HANDSHAKE_DEADLINE
    };
    let handshake = match reader.read_frame(&mut stream, MAX_HANDSHAKE_FRAME_BYTES, |_| {
        first_frame_deadline
    }) {
        // The peer closed before saying anything. Nothing to reject.
        Ok(None) => return Ok(()),
        Ok(Some(frame)) => match parse_first_frame(&frame) {
            Ok(FirstFrame::Health { .. }) => {
                // Answered and closed immediately: no session binding, no entry
                // in the ownership registry, and the admission permit is held
                // only for the probe. Critically, this never touches the
                // journalled request path, so polling health generates no
                // durable writes.
                let reply = HealthReply::HealthOk {
                    protocol_version: PROTOCOL_VERSION,
                    service_epoch: WireU64::new(service_epoch),
                    recovered: session.recovered(),
                    validation_mode: session.validation_mode(),
                    validation_manifest_digest: session
                        .validation_manifest_digest()
                        .map(str::to_owned),
                    // Constants in D-3a with their FINAL semantics; D-3b makes
                    // them vary without changing the shape.
                    draining: false,
                    active_requests: WireU64::new(0),
                };
                if let Ok(frame) = serialize_health_reply(&reply) {
                    let _ = stream.write_all(&frame);
                    let _ = stream.flush();
                }
                return Ok(());
            }
            Ok(FirstFrame::OpenSession { .. }) if control => {
                // Admitted into the CONTROL reserve, but asking for a session.
                // Refuse rather than promote -- promoting would let a session
                // launder its way past a full cap through the very slots that
                // exist to keep shutdown and monitoring reachable.
                return refuse_handshake(
                    &mut stream,
                    "server_busy",
                    "daemon is at its session admission cap; retry with backoff",
                    true,
                );
            }
            Ok(FirstFrame::OpenSession {
                protocol_version: _,
                actor,
                role,
                client_instance,
                connection_generation,
            }) => OpenSession {
                protocol_version: PROTOCOL_VERSION,
                frame_type: OpenSessionTag::OpenSession,
                actor,
                role,
                client_instance,
                connection_generation,
            },
            Err(error) => {
                // Fail-fast, both directions: a v1 client's first frame is a
                // request, which fails to parse as a handshake and lands here.
                // The rejection is WRITTEN and then the connection closed, so
                // the peer learns why instead of waiting on EOF.
                return refuse_handshake(
                    &mut stream,
                    "unsupported_protocol_version",
                    &bounded_handshake_message(&error.to_string()),
                    false,
                );
            }
        },
        Err(_) => {
            return refuse_handshake(
                &mut stream,
                "handshake_timeout",
                "no complete open_session frame arrived within the handshake deadline",
                true,
            );
        }
    };

    // Ownership is decided BEFORE the acceptance is written, so a refused
    // handshake never sees a `session_opened` it then has to walk back.
    let Binding { token, fenced } = match ownership.bind(
        &handshake.actor,
        handshake.role,
        &handshake.client_instance,
        handshake.connection_generation.get(),
        &stream,
    ) {
        Ok(binding) => binding,
        Err(refusal) => {
            return refuse_handshake(
                &mut stream,
                refusal.code(),
                refusal.message(),
                refusal.retryable(),
            );
        }
    };
    // Fencing happens OUTSIDE the registry lock: a shutdown syscall under the
    // lock would stall every other handshake on the daemon.
    if let Some(displaced) = fenced {
        let _ = displaced.shutdown(std::net::Shutdown::Both);
    }
    // The guard releases this lane on EVERY exit path, and only if this
    // handler still owns it -- see `OwnershipRegistry::release`.
    let _lane = LaneGuard {
        ownership: Arc::clone(&ownership),
        actor: handshake.actor.clone(),
        role: handshake.role,
        token,
    };

    let reply = SessionReply::SessionOpened {
        protocol_version: PROTOCOL_VERSION,
        service_epoch: WireU64::new(service_epoch),
        validation_mode: session.validation_mode(),
        validation_manifest_digest: session.validation_manifest_digest().map(str::to_owned),
        actor: handshake.actor.clone(),
        role: handshake.role,
    };
    stream.write_all(&serialize_session_reply(&reply)?)?;
    stream.flush()?;
    // Established. Release the un-handshaken budget so a burst of silent
    // connectors cannot starve clients that are actually working.
    permit.handshaken();
    // Every request on this connection is now checked against what the
    // handshake bound, before it can reach the journal.
    let binding = SessionBinding {
        actor: handshake.actor,
        role: handshake.role,
    };

    loop {
        let idle_since = Instant::now();
        let frame = reader.read_frame(&mut stream, MAX_REQUEST_FRAME_BYTES, |reader| {
            if reader.partial() {
                // The clock started at the frame's FIRST byte and is not reset
                // by later bytes, so a slow trickle still dies at the bound.
                idle_since + PARTIAL_FRAME_DEADLINE
            } else {
                idle_since + ESTABLISHED_IDLE_TIMEOUT
            }
        });
        let request = match frame {
            Ok(Some(frame)) => frame,
            // Clean close between frames, or a deadline: either way the
            // session is over and there is nothing meaningful to answer.
            Ok(None) | Err(_) => return Ok(()),
        };
        let response = session.handle_frame(&request, &binding);
        let frame = bounded_response_frame(&response)?;
        // A peer may disconnect after the durable effect and before receiving
        // the response; that is the retry contract's problem, not ours.
        if stream.write_all(&frame).is_err() || stream.flush().is_err() {
            return Ok(());
        }
    }
}

/// Keeps a rejection reason inside the handshake frame bound. The reason is
/// diagnostic text derived from a parse failure, so it is truncated rather
/// than trusted to be short.
fn bounded_handshake_message(message: &str) -> String {
    const MAX: usize = 512;
    if message.len() <= MAX {
        return message.to_owned();
    }
    let mut end = MAX;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &message[..end])
}

fn bounded_response_frame(response: &LocalServiceResponse) -> Result<Vec<u8>> {
    let response_request_id = response.request_id().to_owned();
    serialize_response_frame(response).or_else(|_| {
        serialize_response_frame(&LocalServiceResponse::error(
            response_request_id,
            "response_too_large",
            "response exceeds the local protocol frame bound",
            false,
            Vec::new(),
        ))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::protocol::{
        ChangeSetState, MAX_RESPONSE_FRAME_BYTES, ResponseResult, ServiceEvent, ServiceEventKind,
        WireU64,
    };

    #[test]
    fn event_aggregate_uses_the_shared_bounded_fallback() {
        let events = (0..9)
            .map(|event| ServiceEvent {
                sequence: WireU64::new(event + 1),
                change_set_id: format!("change:{event}"),
                kind: ServiceEventKind::IntentCommitted,
                state: ChangeSetState::Published,
                operation_id: None,
                affected_node_ids: (0..64)
                    .map(|node| {
                        let prefix = format!("affected-{event:03}-{node:03}-");
                        format!("{prefix}{}", "x".repeat(512 - prefix.len()))
                    })
                    .collect(),
                diagnostics: Vec::new(),
                publication_digest: None,
            })
            .collect();
        let response =
            LocalServiceResponse::success("events:oversized", ResponseResult::Events { events });
        assert!(serde_json::to_vec(&response).unwrap().len() > MAX_RESPONSE_FRAME_BYTES);

        let frame = bounded_response_frame(&response).unwrap();

        assert!(frame.len() <= MAX_RESPONSE_FRAME_BYTES);
        assert_eq!(frame.last(), Some(&b'\n'));
        let parsed: Value = serde_json::from_slice(&frame[..frame.len() - 1]).unwrap();
        assert_eq!(parsed["ok"], false, "{parsed}");
        assert_eq!(parsed["requestId"], "events:oversized");
        assert_eq!(parsed["error"]["code"], "response_too_large");
    }
}

/// Production-rooted validation, for the `validate-socket` subcommand.
pub(super) fn validate_socket_path(path: &Path) -> Result<()> {
    validate_socket_path_in(path, Path::new(lifecycle::SOCKET_DIRECTORY))
}
