//! D-3a: ownership and health, driven through the real daemon binary.
//!
//! Every test injects its OWN socket root. The production `/tmp/strata-lc`
//! holds live daemons' sockets, and an earlier draft of this suite would have
//! removed and symlinked it — capable of destroying a running daemon's endpoint
//! or a parallel test's.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A socket root short enough to leave room for the incarnation basename.
///
/// The budget is tight and worth stating: the basename is
/// `<64 hex>.<11 hex>.sock` = 81 bytes, and the limit is 96, so the root plus
/// its separator gets 15. Production's `/tmp/strata-lc` is 14 -- meaning the
/// real path lands at EXACTLY 96 bytes and the 11-hex nonce bound is precisely
/// what makes it fit. Test roots therefore have to be shorter than a default
/// `tempdir` name.
struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, Ordering::Relaxed);
        // The daemon CREATES this directory, exactly as production does, so
        // mkdir's atomic 0700 applies. Handing it a pre-existing directory
        // with default permissions is refused -- correctly.
        let path = PathBuf::from(format!("/tmp/d{:x}{unique:x}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn bridge_worker() -> PathBuf {
    let worker = repo_root().join("packages/kernel-bridge/dist/worker.js");
    if !worker.exists() {
        let status = Command::new("pnpm")
            .args(["--filter", "@strata-code/kernel-bridge", "build"])
            .current_dir(repo_root())
            .status()
            .unwrap();
        assert!(status.success(), "kernel bridge fixture build failed");
    }
    worker
}

struct Daemon {
    child: Child,
    socket_path: PathBuf,
    epoch: u64,
    readiness: Value,
    pid: u32,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Refusal {
    code: Option<i32>,
    stderr: String,
}

fn snapshot(directory: &Path) -> PathBuf {
    let value: Value =
        serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap();
    let path = directory.join("snapshot.json");
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}

fn daemon_command(state: &Path, token: &str, root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"));
    command.args([
        "serve",
        "--db",
        state.join("kernel.redb").to_str().unwrap(),
        "--snapshot",
        snapshot(state).to_str().unwrap(),
        "--bridge-worker",
        bridge_worker().to_str().unwrap(),
        "--source-root",
        repo_root().join("examples/medium/src").to_str().unwrap(),
        "--corpus-root",
        repo_root().join("examples/medium").to_str().unwrap(),
        "--socket-token",
        token,
        "--audit",
        state.join("audit.jsonl").to_str().unwrap(),
        "--socket-root",
        root.to_str().unwrap(),
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

fn start_daemon(state: &TempDir, token: &str, root: &Path) -> Daemon {
    match try_start_daemon(state, token, root) {
        Ok(daemon) => daemon,
        Err(refusal) => panic!("daemon refused to start: {}", refusal.stderr),
    }
}

fn try_start_daemon(state: &TempDir, token: &str, root: &Path) -> Result<Daemon, Refusal> {
    let mut child = daemon_command(state.path(), token, root).spawn().unwrap();
    let pid = child.id();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.trim().is_empty() {
        let mut stderr = String::new();
        child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
        let code = child.wait().unwrap().code();
        return Err(Refusal { code, stderr });
    }
    let readiness: Value = serde_json::from_str(&line).unwrap();
    let socket_path = PathBuf::from(readiness["socketPath"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    Ok(Daemon {
        child,
        epoch: readiness["serviceEpoch"].as_str().unwrap().parse().unwrap(),
        readiness,
        socket_path,
        pid,
    })
}

fn start_daemon_expecting_failure(state: &TempDir, token: &str, root: &Path) -> Refusal {
    match try_start_daemon(state, token, root) {
        Ok(_) => panic!("daemon started when it should have refused"),
        Err(refusal) => refusal,
    }
}

fn kill_hard(daemon: &mut Daemon) {
    let _ = daemon.child.kill();
    let _ = daemon.child.wait();
}

fn read_frame(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return if buffer.is_empty() { None } else { Some(buffer) },
            Ok(_) => {
                buffer.push(byte[0]);
                if byte[0] == b'\n' {
                    return Some(buffer);
                }
            }
            Err(_) => return if buffer.is_empty() { None } else { Some(buffer) },
        }
    }
}

fn health_probe(socket: &Path) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut frame = serde_json::to_vec(&json!({"protocolVersion": 2, "type": "health"})).unwrap();
    frame.push(b'\n');
    stream.write_all(&frame).unwrap();
    let reply = read_frame(&mut stream).expect("no health reply");
    serde_json::from_slice(&reply[..reply.len() - 1]).unwrap()
}

fn open_observation_session(socket: &Path, actor: &str) -> UnixStream {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut frame = serde_json::to_vec(&json!({
        "protocolVersion": 2,
        "type": "open_session",
        "actor": actor,
        "role": "observation",
        "clientInstance": "lifecycle-test",
        "connectionGeneration": "1",
    }))
    .unwrap();
    frame.push(b'\n');
    stream.write_all(&frame).unwrap();
    let reply = read_frame(&mut stream).expect("no open_session reply");
    let reply: Value = serde_json::from_slice(&reply[..reply.len() - 1]).unwrap();
    assert_eq!(reply["type"], "session_opened", "{reply}");
    stream
}

fn exchange(stream: &mut UnixStream, value: &Value) -> Value {
    let mut frame = serde_json::to_vec(value).unwrap();
    frame.push(b'\n');
    stream.write_all(&frame).unwrap();
    let reply = read_frame(stream).expect("no request reply");
    serde_json::from_slice(&reply[..reply.len() - 1]).unwrap()
}

fn audit_len(state: &TempDir) -> u64 {
    std::fs::metadata(state.path().join("audit.jsonl"))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn journal_len(state: &TempDir) -> u64 {
    std::fs::metadata(state.path().join("kernel.redb.service-journal.jsonl"))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn owner_metadata_pid(state: &TempDir) -> Option<u64> {
    let raw = std::fs::read_to_string(state.path().join(".strata-owner")).ok()?;
    serde_json::from_str::<Value>(raw.trim())
        .ok()?
        .get("pid")?
        .as_u64()
}

// ---------------------------------------------------------------------------
// Task 4 — health
// ---------------------------------------------------------------------------

/// Health reports the session's identity and appends NOTHING durable.
///
/// The second half is the load-bearing one. D-2 proved the handshake never
/// reaches `bind_request`; health inherits that. If health ran on the
/// journalled request path, ordinary monitoring would generate durable fsync
/// traffic forever.
#[test]
fn health_reports_the_exact_identity_key_set_and_appends_nothing_durable() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3a-health", &root);

    let journal = journal_len(&state);
    let audit = audit_len(&state);
    // Non-vacuity anchor: the audit log really is written at startup, so the
    // "did not grow" assertions below are measuring an absence of growth rather
    // than an absence of a file. The journal is deliberately still ZERO here --
    // it is created by the first journalled request, and health must never be
    // one, so it staying at zero is itself the claim.
    assert!(audit > 0, "precondition: startup wrote a start event");
    assert_eq!(journal, 0, "precondition: nothing has journalled a request yet");

    for _ in 0..25 {
        let reply = health_probe(&service.socket_path);
        let mut keys: Vec<&str> = reply.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "activeRequests",
                "draining",
                "protocolVersion",
                "recovered",
                "serviceEpoch",
                "type",
                "validationManifestDigest",
                "validationMode",
            ],
            "health_ok must carry its complete shape: {reply}"
        );
        assert_eq!(reply["type"], "health_ok", "{reply}");
        assert_eq!(reply["serviceEpoch"], service.epoch.to_string(), "{reply}");
        assert_eq!(reply["recovered"], false, "{reply}");
        assert_eq!(
            reply["validationMode"], service.readiness["validationMode"],
            "{reply}"
        );
        assert_eq!(reply["validationManifestDigest"], Value::Null, "{reply}");
        // Constants in D-3a, with the semantics D-3b will supply live values
        // for. Present now so no frame gains fields between the slices.
        assert_eq!(reply["draining"], false, "{reply}");
        assert_eq!(reply["activeRequests"], "0", "{reply}");
    }

    assert_eq!(journal_len(&state), journal, "health wrote to the journal");
    assert_eq!(audit_len(&state), audit, "health wrote to the audit log");
}

// ---------------------------------------------------------------------------
// Task 3 — exclusion before recovery
// ---------------------------------------------------------------------------

/// A SIMULTANEOUS race, not sequential exclusion. Starting the second daemon
/// after the first is ready proves only that a running daemon blocks a new one;
/// the spec asks that a race resolve to exactly one server.
#[test]
fn two_daemons_started_simultaneously_yield_exactly_one_server() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    // Pre-build the bridge worker so neither racer pays for it inside the race.
    bridge_worker();
    snapshot(state.path());

    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let state_path = state.path().to_owned();
            let root_path = root.clone();
            thread::spawn(move || {
                barrier.wait();
                let mut child = daemon_command(&state_path, "d3a-simultaneous", &root_path)
                    .spawn()
                    .unwrap();
                let mut line = String::new();
                BufReader::new(child.stdout.take().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let ready = !line.trim().is_empty();
                if ready {
                    let _ = child.kill();
                }
                let code = child.wait().unwrap().code();
                (ready, code)
            })
        })
        .collect();

    let outcomes: Vec<(bool, Option<i32>)> =
        handles.into_iter().map(|handle| handle.join().unwrap()).collect();
    let served = outcomes.iter().filter(|(ready, _)| *ready).count();
    assert_eq!(served, 1, "exactly one daemon may serve: {outcomes:?}");
    let refused = outcomes.iter().find(|(ready, _)| !*ready).unwrap();
    assert_eq!(refused.1, Some(2), "the loser must exit 2: {outcomes:?}");
}

/// The loser's guarantee is "no canonical-state mutation", not "no observable
/// work" — argument parsing and manifest reading are read-only preflight and
/// legitimately already happened.
#[test]
fn a_losing_daemon_mutates_no_canonical_state_and_writes_no_diagnostics() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let first = start_daemon(&state, "d3a-race", &root);
    let audit = audit_len(&state);
    let journal = journal_len(&state);
    let winner_pid = u64::from(first.pid);
    assert_eq!(owner_metadata_pid(&state), Some(winner_pid));

    let refusal = start_daemon_expecting_failure(&state, "d3a-race", &root);
    assert_eq!(refusal.code, Some(2), "{}", refusal.stderr);
    assert!(
        refusal.stderr.contains("already owns"),
        "the refusal must name its reason: {}",
        refusal.stderr
    );

    // EXACT lengths. `starts_with` cannot prove nothing was appended, because
    // every append preserves the prefix.
    assert_eq!(audit_len(&state), audit, "the loser wrote to the audit log");
    assert_eq!(journal_len(&state), journal, "the loser wrote to the journal");
    assert_eq!(
        owner_metadata_pid(&state),
        Some(winner_pid),
        "the loser overwrote the winner's owner metadata"
    );
}

// ---------------------------------------------------------------------------
// Task 5 — per-incarnation paths and exact-record reclamation
// ---------------------------------------------------------------------------

/// The heart of D-3a: a crash orphan is a DIFFERENT path from the restart, so
/// there was never a live-or-stale decision to make.
#[test]
fn a_crash_orphan_is_a_different_path_and_is_reclaimed_by_exact_record() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let mut crashed = start_daemon(&state, "d3a-orphan", &root);
    let orphan = crashed.socket_path.clone();
    kill_hard(&mut crashed);
    assert!(orphan.exists(), "precondition: a crash leaves the socket behind");

    let restarted = start_daemon(&state, "d3a-orphan", &root);
    assert_ne!(
        restarted.socket_path, orphan,
        "a restart must never reuse a socket name"
    );
    assert_eq!(health_probe(&restarted.socket_path)["type"], "health_ok");
    assert!(!orphan.exists(), "the recorded predecessor was not reclaimed");
}

/// Exact-record reclamation touches nothing it cannot name. A wildcard sweep
/// over `<hash>.*.sock` would have deleted this.
#[test]
fn an_unrecorded_socket_matching_our_token_is_left_alone() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let hash = token_hash("d3a-unrecorded");
    // Create the root with the permissions the daemon insists on, so a
    // socket can be planted before it starts.
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let planted = &root.join(format!("{hash}.beef1234.sock"));
    let _listener = std::os::unix::net::UnixListener::bind(&planted).unwrap();

    let service = start_daemon(&state, "d3a-unrecorded", &root);
    assert_ne!(service.socket_path, planted.as_path());
    assert!(
        planted.exists(),
        "reclamation deleted a socket it had no record of creating"
    );
}

/// Another token's socket is never in scope, recorded or not.
#[test]
fn reclamation_never_touches_another_token() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    // Create the root with the permissions the daemon insists on, so a
    // socket can be planted before it starts.
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let foreign = &root.join(format!("{}.deadbeef.sock", "b".repeat(64)));
    let _listener = std::os::unix::net::UnixListener::bind(&foreign).unwrap();

    let _service = start_daemon(&state, "d3a-other", &root);
    assert!(foreign.exists(), "reclamation deleted another token's socket");
}

#[test]
fn validate_socket_accepts_the_incarnation_shape_and_still_rejects_junk() {
    let hash = "a".repeat(64);
    let good = format!("/tmp/strata-lc/{hash}.0123abcd.sock");
    let run = |socket: &str| {
        Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
            .args(["validate-socket", "--socket", socket])
            .output()
            .unwrap()
            .status
            .success()
    };
    assert!(run(&good), "the incarnation shape must be accepted");
    for bad in [
        // The OLD shape: no incarnation nonce at all.
        format!("/tmp/strata-lc/{hash}.sock"),
        "/tmp/strata-lc/short.sock".to_owned(),
        "/tmp/strata-lc/../escape.sock".to_owned(),
        format!("/elsewhere/{hash}.0123abcd.sock"),
        format!("/tmp/strata-lc/{hash}.0123abcd.notsock"),
        // Nonce past the 11-hex bound, which would risk the 96-byte limit.
        format!("/tmp/strata-lc/{hash}.{}.sock", "0".repeat(12)),
        format!("/tmp/strata-lc/{hash}.NOTHEX01.sock"),
    ] {
        assert!(!run(&bad), "{bad} should have been rejected");
    }
}

// ---------------------------------------------------------------------------
// Task 6 — the control reserve
// ---------------------------------------------------------------------------

/// Opens `count` sessions, returning the live streams so they keep their
/// admission permits. 32 actors x 2 lanes saturates the 64-session cap.
fn saturate_admission(socket: &Path) -> Vec<UnixStream> {
    let mut held = Vec::new();
    for index in 0..32 {
        for role in ["work", "observation"] {
            let mut stream = UnixStream::connect(socket).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut frame = serde_json::to_vec(&json!({
                "protocolVersion": 2,
                "type": "open_session",
                "actor": format!("client:sat:{index}"),
                "role": role,
                "clientInstance": format!("instance:sat:{index}"),
                "connectionGeneration": "1",
            }))
            .unwrap();
            frame.push(b'\n');
            stream.write_all(&frame).unwrap();
            let reply = read_frame(&mut stream).expect("no handshake reply while saturating");
            let reply: Value = serde_json::from_slice(&reply[..reply.len() - 1]).unwrap();
            assert_eq!(reply["type"], "session_opened", "{reply}");
            held.push(stream);
        }
    }
    held
}

/// Health must stay reachable when sessions saturate admission, or monitoring
/// goes blind exactly when it is most needed.
#[test]
fn health_stays_reachable_when_sessions_saturate_admission() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3a-reserve", &root);

    let _saturating = saturate_admission(&service.socket_path);
    assert_eq!(
        health_probe(&service.socket_path)["type"],
        "health_ok",
        "health went blind exactly when it was needed"
    );
}

/// A reserve occupant that asks for a session is refused, never promoted --
/// promoting would let a session launder past a full cap through the slots that
/// exist to keep control reachable.
#[test]
fn a_control_candidate_that_opens_a_session_is_refused_not_promoted() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3a-launder", &root);
    let _saturating = saturate_admission(&service.socket_path);

    let mut stream = UnixStream::connect(&service.socket_path).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut frame = serde_json::to_vec(&json!({
        "protocolVersion": 2,
        "type": "open_session",
        "actor": "client:sneaky",
        "role": "work",
        "clientInstance": "instance:sneaky",
        "connectionGeneration": "1",
    }))
    .unwrap();
    frame.push(b'\n');
    stream.write_all(&frame).unwrap();
    let reply = read_frame(&mut stream).expect("no refusal for a laundering candidate");
    let reply: Value = serde_json::from_slice(&reply[..reply.len() - 1]).unwrap();
    assert_eq!(reply["type"], "session_rejected", "{reply}");
    assert_eq!(reply["error"]["code"], "server_busy", "{reply}");
}

/// BOTH reserve slots are reclaimed on their own shorter deadline.
///
/// Occupying only one would let health succeed through the other even if
/// reclamation never happened, and the bound has to sit BELOW the 5s handshake
/// deadline or it cannot tell the promised 1s reserve timer from that one.
#[test]
fn both_reserve_slots_are_reclaimed_on_their_own_shorter_deadline() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3a-tenure", &root);
    let _saturating = saturate_admission(&service.socket_path);

    let silent: Vec<UnixStream> = (0..2)
        .map(|_| UnixStream::connect(&service.socket_path).unwrap())
        .collect();

    let started = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut reachable = false;
    while Instant::now() < deadline && !reachable {
        if let Ok(mut probe) = UnixStream::connect(&service.socket_path) {
            probe.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut frame =
                serde_json::to_vec(&json!({"protocolVersion": 2, "type": "health"})).unwrap();
            frame.push(b'\n');
            if probe.write_all(&frame).is_ok()
                && let Some(reply) = read_frame(&mut probe)
            {
                let reply: Value = serde_json::from_slice(&reply[..reply.len() - 1]).unwrap();
                reachable = reply["type"] == "health_ok";
            }
        }
        if !reachable {
            thread::sleep(Duration::from_millis(100));
        }
    }
    assert!(
        reachable,
        "the control reserve was not reclaimed on its own deadline"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "reclamation took {:?}; that is the 5s handshake timer, not the 1s reserve one",
        started.elapsed()
    );
    drop(silent);
}

// ---------------------------------------------------------------------------
// Task 7 — start alias and the health CLI
// ---------------------------------------------------------------------------

fn run_cli(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args(args)
        .output()
        .unwrap()
}

/// Per-command exit codes, not the blanket 2 that `main` gives every error.
///
/// An operator scripting against this has to tell "nothing is there" apart from
/// "something is there and will not talk to me".
#[test]
fn health_cli_exit_codes_are_per_command() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3a-cli", &root);

    assert_eq!(
        run_cli(&["health", "--socket", service.socket_path.to_str().unwrap()])
            .status
            .code(),
        Some(0),
        "a live endpoint must report healthy"
    );

    // With per-incarnation names the path is not derivable from the token, so
    // this is the operator's route in.
    assert_eq!(
        run_cli(&[
            "health",
            "--token",
            "d3a-cli",
            "--socket-root",
            root.to_str().unwrap()
        ])
        .status
        .code(),
        Some(0),
        "token resolution must find the recorded endpoint"
    );

    let absent = root.join(format!("{}.0123abcd.sock", token_hash("nobody")));
    assert_eq!(
        run_cli(&["health", "--socket", absent.to_str().unwrap()])
            .status
            .code(),
        Some(3),
        "an absent endpoint is code 3"
    );

    let squat = root.join("not-a-socket");
    std::fs::write(&squat, b"regular file").unwrap();
    assert_eq!(
        run_cli(&["health", "--socket", squat.to_str().unwrap()])
            .status
            .code(),
        Some(4),
        "a non-socket at the path is code 4, not a crash"
    );
}

/// A listener that accepts and then says nothing.
///
/// Setting read/write timeouts AFTER `UnixStream::connect` would not bound the
/// connect itself, which is why the probe uses a non-blocking connect plus
/// `poll`. This is the case that distinguishes the two.
#[test]
fn health_times_out_rather_than_hanging_on_a_stalled_listener() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join(format!("{}.0123abcd.sock", "c".repeat(64)));
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let _stalled = thread::spawn(move || {
        // Accept, then hold the connection open without ever replying.
        while let Ok((stream, _)) = listener.accept() {
            thread::sleep(Duration::from_secs(30));
            drop(stream);
        }
    });

    let started = Instant::now();
    let code = run_cli(&["health", "--socket", path.to_str().unwrap()])
        .status
        .code();
    assert_eq!(code, Some(6), "a stalled listener must time out, not hang");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "the probe took {:?}, which is not bounded",
        started.elapsed()
    );
}

#[test]
fn stop_acknowledgement_is_in_band_and_repeated_stop_is_distinct() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let service = start_daemon(&state, "d3b-stop", &root);
    let audit_before = audit_len(&state);
    let journal_before = journal_len(&state);

    let first = run_cli(&[
        "stop",
        "--socket",
        service.socket_path.to_str().unwrap(),
        "--wait-ms",
        "0",
    ]);
    assert_eq!(first.status.code(), Some(0), "{}", String::from_utf8_lossy(&first.stderr));
    assert_eq!(String::from_utf8_lossy(&first.stdout).trim(), "stop accepted");
    assert_eq!(health_probe(&service.socket_path)["draining"], true);
    assert_eq!(
        run_cli(&["health", "--socket", service.socket_path.to_str().unwrap()])
            .status
            .code(),
        Some(5)
    );

    let repeated = run_cli(&[
        "stop",
        "--socket",
        service.socket_path.to_str().unwrap(),
        "--wait-ms",
        "0",
    ]);
    assert_eq!(repeated.status.code(), Some(5));
    assert_eq!(String::from_utf8_lossy(&repeated.stdout).trim(), "already draining");
    assert_eq!(audit_len(&state), audit_before);
    assert_eq!(journal_len(&state), journal_before);
}

#[test]
fn stop_cli_reports_absent_and_non_socket_endpoints() {
    let dir = TestRoot::new();
    let absent = dir.path().join("absent.sock");
    assert_eq!(
        run_cli(&["stop", "--socket", absent.to_str().unwrap(), "--wait-ms", "0"])
            .status
            .code(),
        Some(3)
    );
    std::fs::create_dir_all(dir.path()).unwrap();
    let squat = dir.path().join("not-a-socket");
    std::fs::write(&squat, b"regular file").unwrap();
    assert_eq!(
        run_cli(&["stop", "--socket", squat.to_str().unwrap(), "--wait-ms", "0"])
            .status
            .code(),
        Some(4)
    );
}

#[test]
fn draining_request_is_forgotten_and_leaves_no_durable_trace() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();
    let mut service = start_daemon(&state, "d3b-forget", &root);
    let mut lane = open_observation_session(&service.socket_path, "client:drain");
    assert_eq!(
        run_cli(&[
            "stop",
            "--socket",
            service.socket_path.to_str().unwrap(),
            "--wait-ms",
            "0",
        ])
        .status
        .code(),
        Some(0)
    );
    let audit_before = audit_len(&state);
    let journal_before = journal_len(&state);
    let mut new_lane = UnixStream::connect(&service.socket_path).unwrap();
    let mut open = serde_json::to_vec(&json!({
        "protocolVersion": 2,
        "type": "open_session",
        "actor": "client:new",
        "role": "observation",
        "clientInstance": "lifecycle-test-new",
        "connectionGeneration": "1",
    }))
    .unwrap();
    open.push(b'\n');
    new_lane.write_all(&open).unwrap();
    let rejection = read_frame(&mut new_lane).expect("no draining session rejection");
    let rejection: Value = serde_json::from_slice(&rejection[..rejection.len() - 1]).unwrap();
    assert_eq!(rejection["error"]["code"], "service_draining", "{rejection}");
    assert_eq!(rejection["error"]["retryable"], true, "{rejection}");
    let request = json!({
        "protocolVersion": 2,
        "requestId": "request:drain-retry",
        "clientId": "client:drain",
        "deadlineMs": "120000",
        "action": {"type":"hello"},
    });
    let refused = exchange(&mut lane, &request);
    assert_eq!(refused["error"]["code"], "service_draining", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");
    assert_eq!(audit_len(&state), audit_before);
    assert_eq!(journal_len(&state), journal_before);

    kill_hard(&mut service);
    let restarted = start_daemon(&state, "d3b-forget", &root);
    let mut restarted_lane = open_observation_session(&restarted.socket_path, "client:drain");
    let accepted = exchange(&mut restarted_lane, &request);
    assert_eq!(accepted["ok"], true, "{accepted}");
}

/// `start` is an alias for `serve`, and BOTH dispatch routes accept help.
///
/// `parse_named` bails on an odd argument count, so subcommand help has to be
/// handled before option parsing or a bare `--help` fails with a confusing
/// pair-parse error.
#[test]
fn start_is_an_alias_and_both_dispatch_routes_accept_help() {
    assert!(run_cli(&["start", "--help"]).status.success());
    assert!(run_cli(&["serve", "--help"]).status.success());
    // And `start` really reaches serve's option parsing rather than falling
    // through to "unknown command".
    let missing = run_cli(&["start", "--db", "/tmp/nowhere.redb"]);
    let stderr = String::from_utf8_lossy(&missing.stderr);
    assert!(
        !stderr.contains("unknown command"),
        "`start` did not dispatch to serve: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Task 8 — the D-2 coexistence boundary
// ---------------------------------------------------------------------------

/// A pre-D-3a daemon takes NO endpoint lock and binds the old `<hash>.sock`, so
/// the endpoint claim cannot see it. Without this check, a D-2 and a D-3a daemon
/// sharing a token but pointed at different databases would serve
/// simultaneously, each believing it was alone.
#[test]
fn a_live_legacy_endpoint_blocks_startup() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();

    // Stand up something that answers `health` on the OLD path shape, exactly
    // as a running pre-D-3a daemon's endpoint would be found.
    let legacy = root.join(format!("{}.sock", token_hash("d3a-legacy")));
    let listener = std::os::unix::net::UnixListener::bind(&legacy).unwrap();
    let _serving = thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut byte = [0_u8; 1];
            let mut request = Vec::new();
            while let Ok(1) = stream.read(&mut byte) {
                request.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            let mut reply = serde_json::to_vec(&json!({
                "protocolVersion": 2,
                "type": "health_ok",
                "serviceEpoch": "1",
                "recovered": false,
                "validationMode": "tscOnly",
                "validationManifestDigest": null,
                "draining": false,
                "activeRequests": "0",
            }))
            .unwrap();
            reply.push(b'\n');
            let _ = stream.write_all(&reply);
        }
    });

    let state = TempDir::new().unwrap();
    let refusal = start_daemon_expecting_failure(&state, "d3a-legacy", &root);
    assert_eq!(refusal.code, Some(2), "{}", refusal.stderr);
    assert!(
        refusal.stderr.contains("already serving this token"),
        "the refusal must name the reason: {}",
        refusal.stderr
    );
    assert!(legacy.exists(), "a live legacy endpoint was removed");
}

/// An ambiguous legacy leftover fails closed and is NOT deleted. Refusing is
/// recoverable by an operator; deleting something that was alive is not.
#[test]
fn an_ambiguous_legacy_leftover_fails_closed_without_deleting_it() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();

    let legacy = root.join(format!("{}.sock", token_hash("d3a-legacy-dead")));
    let listener = std::os::unix::net::UnixListener::bind(&legacy).unwrap();
    drop(listener); // bound, then abandoned -- the shape a crash leaves.

    let state = TempDir::new().unwrap();
    let refusal = start_daemon_expecting_failure(&state, "d3a-legacy-dead", &root);
    assert_eq!(refusal.code, Some(2), "{}", refusal.stderr);
    assert!(
        refusal.stderr.contains("could not be identified"),
        "the refusal must say why it is ambiguous: {}",
        refusal.stderr
    );
    assert!(
        legacy.exists(),
        "an ambiguous legacy leftover was deleted on inference"
    );
}

// ---------------------------------------------------------------------------
// Task 1 gate — the lock must not ride into a bridge worker
// ---------------------------------------------------------------------------

/// Rust's `OpenOptions` sets `O_CLOEXEC`, but "should" is not a gate.
///
/// An `flock` belongs to the open file description and is released only when
/// ALL duplicated descriptors close. If the lock fd ever survived `exec` into a
/// Node bridge worker, a SIGKILLed daemon would leave its state directory
/// unownable for as long as any worker outlived it — a daemon that cannot be
/// restarted after a crash, which is the opposite of what this slice is for.
#[test]
fn a_sigkilled_daemon_releases_ownership_despite_live_bridge_workers() {
    let dir = TestRoot::new();
    let root = dir.path().to_owned();
    let state = TempDir::new().unwrap();

    // `--persistent-bridge` eagerly hydrates a worker at startup, so a real
    // child process exists before the kill.
    let mut child = {
        let mut command = daemon_command(state.path(), "d3a-cloexec", &root);
        command.arg("--persistent-bridge");
        command.spawn().unwrap()
    };
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(!line.trim().is_empty(), "the bridge daemon never became ready");

    let _ = child.kill();
    let _ = child.wait();

    // Bounded rather than instant: the kernel reclaims when the last descriptor
    // closes, and a worker may take a moment to notice its parent is gone.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut reclaimed = false;
    while Instant::now() < deadline && !reclaimed {
        match try_start_daemon(&state, "d3a-cloexec", &root) {
            Ok(replacement) => {
                reclaimed = true;
                drop(replacement);
            }
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
    assert!(
        reclaimed,
        "a bridge worker retained the owner lock past the daemon's death"
    );
}
