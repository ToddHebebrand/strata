use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::protocol::{
    LocalServiceResponse, MAX_HANDSHAKE_FRAME_BYTES, MAX_REQUEST_FRAME_BYTES, PROTOCOL_VERSION,
    SessionReply, WireU64, parse_open_session_frame, serialize_response_frame,
    serialize_session_reply,
};
use super::session::{ServiceConfig, ServiceSession};

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
    validate_token(socket_token)?;
    let socket_path = socket_path(socket_token);
    validate_socket_path(&socket_path)?;

    // Recovery is intentionally complete before the authority becomes reachable.
    let (session, service_epoch) = ServiceSession::open(config)?;
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
    let listener = bind_private_socket(&socket_path)?;
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

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let session = Arc::clone(&session);
                thread::spawn(move || {
                    let _ = handle_connection(stream, &session, service_epoch);
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

pub(super) fn validate_socket_path(path: &Path) -> Result<()> {
    let encoded = path
        .to_str()
        .context("local service socket path must be valid UTF-8")?;
    let parent = path
        .parent()
        .context("local service socket path has no parent")?;
    if parent != Path::new(SOCKET_DIRECTORY) {
        bail!("local service socket must be directly under /tmp/strata-lc/");
    }
    if encoded.len() > MAX_SOCKET_PATH_BYTES {
        bail!("local service socket path exceeds 96 UTF-8 bytes");
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("local service socket has no UTF-8 basename")?;
    let hash = name
        .strip_suffix(".sock")
        .context("local service socket must end in .sock")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("local service socket basename must be a SHA-256 token hash");
    }
    Ok(())
}

fn socket_path(token: &str) -> PathBuf {
    let digest = Sha256::digest(token.as_bytes());
    Path::new(SOCKET_DIRECTORY).join(format!("{digest:x}.sock"))
}

fn validate_token(token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 512 {
        bail!("socket token must contain between 1 and 512 UTF-8 bytes");
    }
    Ok(())
}

fn bind_private_socket(path: &Path) -> Result<UnixListener> {
    fs::create_dir_all(SOCKET_DIRECTORY).context("create local service socket directory")?;
    fs::set_permissions(SOCKET_DIRECTORY, fs::Permissions::from_mode(0o700))
        .context("protect local service socket directory")?;
    if path.exists() {
        fs::remove_file(path).context("remove stale local service socket")?;
    }
    let listener = UnixListener::bind(path).context("bind local service Unix socket")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("protect local service Unix socket")?;
    Ok(listener)
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
fn handle_connection(
    mut stream: UnixStream,
    session: &ServiceSession,
    service_epoch: u64,
) -> Result<()> {
    stream.set_read_timeout(Some(READ_POLL_INTERVAL))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = FrameReader::new();

    let accepted = Instant::now();
    let opened = reader
        .read_frame(&mut stream, MAX_HANDSHAKE_FRAME_BYTES, |_| {
            accepted + HANDSHAKE_DEADLINE
        })
        .and_then(|frame| match frame {
            // The peer closed before saying anything. Nothing to reject.
            None => Ok(None),
            Some(frame) => parse_open_session_frame(&frame).map(Some),
        });
    let handshake = match opened {
        Ok(Some(handshake)) => handshake,
        Ok(None) => return Ok(()),
        Err(error) => {
            // Fail-fast, both directions: a v1 client's first frame is a
            // request, which fails to parse as a handshake and lands here. The
            // rejection is WRITTEN and then the connection closed, so the peer
            // learns why instead of waiting on EOF.
            let reply = SessionReply::rejected(
                "unsupported_protocol_version",
                &bounded_handshake_message(&error.to_string()),
                false,
            );
            if let Ok(frame) = serialize_session_reply(&reply) {
                let _ = stream.write_all(&frame);
                let _ = stream.flush();
            }
            return Ok(());
        }
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
        let response = session.handle_frame(&request);
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
