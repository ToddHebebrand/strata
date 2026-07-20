//! Gate-2 acceptance for the opt-in `--metrics` JSONL sink. Runs in the DEFAULT
//! feature build (ungated): the sink and its records are a production surface,
//! not a test-authority one. The spawn/socket helpers are replicated locally
//! (rather than shared from the other `local_service*` harnesses) so this test
//! stays feature-agnostic and self-contained.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const USER_ID: &str = "fc98295bca9efc3e";

struct Service {
    child: Child,
    socket: PathBuf,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Service {
    /// Graceful SIGTERM stop so the buffered sink flush observed by the test is
    /// the real shutdown path, not a SIGKILL. Records are flushed per-write, so
    /// the file is already complete either way; this just mirrors production.
    fn terminate(mut self) {
        let pid = self.child.id() as i32;
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn bridge_worker() -> PathBuf {
    let worker = repo_root().join("packages/kernel-bridge/dist/worker.js");
    if !worker.exists() {
        let status = Command::new("pnpm")
            .args(["--filter", "@strata-code/kernel-bridge", "build"])
            .current_dir(repo_root())
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .status()
            .unwrap();
        assert!(status.success(), "kernel bridge fixture build failed");
    }
    worker
}

fn snapshot(directory: &TempDir) -> PathBuf {
    let mut value: Value =
        serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap();
    let mut retained = value["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| {
            node["kind"] == "Module"
                && node["payload"]
                    .as_str()
                    .unwrap()
                    .starts_with("/project/src/")
        })
        .map(|node| node["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    loop {
        let before = retained.len();
        for node in value["nodes"].as_array().unwrap() {
            if node["parentId"]
                .as_str()
                .is_some_and(|id| retained.contains(id))
            {
                retained.insert(node["id"].as_str().unwrap().to_owned());
            }
        }
        if before == retained.len() {
            break;
        }
    }
    value["nodes"]
        .as_array_mut()
        .unwrap()
        .retain(|node| retained.contains(node["id"].as_str().unwrap()));
    value["references"]
        .as_array_mut()
        .unwrap()
        .retain(|reference| {
            retained.contains(reference["fromNodeId"].as_str().unwrap())
                && retained.contains(reference["toNodeId"].as_str().unwrap())
        });
    let corpus = repo_root().join("examples/medium");
    for node in value["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|node| node["kind"] == "Module")
    {
        let relative = node["payload"]
            .as_str()
            .unwrap()
            .strip_prefix("/project/")
            .unwrap();
        node["payload"] = json!(corpus.join(relative).to_string_lossy());
    }
    let path = directory.path().join("snapshot.json");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}

fn start(directory: &TempDir, token: &str, worker: &Path, metrics: Option<&Path>) -> Service {
    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"));
    command.args([
        "serve",
        "--db",
        directory.path().join("kernel.redb").to_str().unwrap(),
        "--snapshot",
        snapshot(directory).to_str().unwrap(),
        "--bridge-worker",
        worker.to_str().unwrap(),
        "--source-root",
        repo_root().join("examples/medium/src").to_str().unwrap(),
        "--corpus-root",
        repo_root().join("examples/medium").to_str().unwrap(),
        "--socket-token",
        token,
        "--audit",
        directory.path().join("audit.jsonl").to_str().unwrap(),
    ]);
    if let Some(metrics) = metrics {
        command.args(["--metrics", metrics.to_str().unwrap()]);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.is_empty() {
        let mut error = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut error)
            .unwrap();
        panic!("service failed: {error}");
    }
    let ready: Value = serde_json::from_str(&line).unwrap();
    let socket = PathBuf::from(ready["socketPath"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    Service { child, socket }
}

fn message(request_id: &str, client: &str, key: Option<&str>, action: Value) -> Vec<u8> {
    let mut value = json!({"protocolVersion":1,"requestId":request_id,"clientId":client,"deadlineMs":"120000","action":action});
    if let Some(key) = key {
        value["idempotencyKey"] = json!(key);
    }
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    bytes
}

fn send(service: &Service, request_id: &str, client: &str, key: Option<&str>, action: Value) -> Value {
    let mut stream = UnixStream::connect(&service.socket).unwrap();
    stream
        .write_all(&message(request_id, client, key, action))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    serde_json::from_slice(&response[..response.len() - 1]).unwrap()
}

fn read_records(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn n(value: &Value) -> u64 {
    value.as_u64().unwrap_or_else(|| panic!("expected a JSON number, got {value}"))
}

/// Drive one full rename lifecycle to publication under `--metrics`, then a
/// restart on the same directory, and assert the JSONL sink's per-stage shapes.
#[test]
fn metrics_sink_records_recovery_worker_runs_and_publication() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let cold = directory.path().join("cold.jsonl");

    let service = start(&directory, "metrics-cold", &worker, Some(&cold));

    assert_eq!(
        send(&service, "hello", "client:m", None, json!({"type":"hello"}))["ok"],
        true
    );
    let change = send(
        &service,
        "begin",
        "client:m",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"metrics rename"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add",
            "client:m",
            Some("add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        )["ok"],
        true
    );
    assert_eq!(
        send(
            &service,
            "submit",
            "client:m",
            Some("submit"),
            json!({"type":"submit_change_set","changeSetId":change}),
        )["ok"],
        true
    );
    let advanced = send(
        &service,
        "advance",
        "client:m",
        Some("advance"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    assert_eq!(advanced["result"]["state"], "published", "{advanced}");
    service.terminate();

    let records = read_records(&cold);

    // Exactly one recovery record, on the create path.
    let recovery: Vec<&Value> = records.iter().filter(|r| r["kind"] == "recovery").collect();
    assert_eq!(recovery.len(), 1, "records: {records:#?}");
    let recovery = recovery[0];
    assert_eq!(recovery["recovered"], false, "{recovery}");
    assert!(n(&recovery["openNs"]) > 0, "{recovery}");
    assert!(n(&recovery["seedNs"]) > 0, "{recovery}");
    assert_eq!(n(&recovery["replayNs"]), 0, "{recovery}");
    assert!(n(&recovery["snapshotBytes"]) > 0, "{recovery}");

    // Worker-run records: at least one submitAnalysis and one candidate; all ok.
    let worker_runs: Vec<&Value> = records.iter().filter(|r| r["kind"] == "workerRun").collect();
    assert!(
        worker_runs.iter().any(|r| r["phase"] == "submitAnalysis"),
        "runs: {worker_runs:#?}"
    );
    let candidate = worker_runs
        .iter()
        .find(|r| r["phase"] == "candidate")
        .unwrap_or_else(|| panic!("no candidate worker run: {worker_runs:#?}"));
    for run in &worker_runs {
        assert_eq!(run["outcome"], "ok", "{run}");
        assert!(n(&run["totalRequestBytes"]) > 0, "{run}");
        assert!(n(&run["snapshotBytes"]) > 0, "{run}");
        assert!(n(&run["worker"]["totalNs"]) > 0, "{run}");
        assert!(n(&run["worker"]["hydrateNs"]) > 0, "{run}");
    }
    assert!(n(&candidate["worker"]["validateNs"]) > 0, "{candidate}");

    // Request records: every completed request has wall + rss; exactly one
    // carries a non-null publication (the advance that published).
    let requests: Vec<&Value> = records.iter().filter(|r| r["kind"] == "request").collect();
    assert!(requests.len() >= 4, "requests: {requests:#?}");
    for request in &requests {
        assert!(n(&request["wallNs"]) > 0, "{request}");
        assert!(n(&request["daemonPeakRssBytes"]) > 0, "{request}");
    }
    // Spawn-anchored cross-check: the FINAL request record's monotonic
    // workerStartsTotal must equal the number of workerRun records this daemon
    // emitted (all outcomes). A spawned child that produced no terminal
    // workerRun record would make the counter exceed the record count — the
    // exact "spawn without a terminal record" hole this closes.
    for request in &requests {
        assert!(
            request.get("workerStartsTotal").is_some(),
            "request record missing workerStartsTotal: {request}"
        );
    }
    let final_request = requests.last().unwrap();
    assert_eq!(
        n(&final_request["workerStartsTotal"]),
        worker_runs.len() as u64,
        "final request workerStartsTotal must equal workerRun record count; \
         requests: {requests:#?} worker_runs: {worker_runs:#?}"
    );

    let published: Vec<&Value> = requests
        .iter()
        .filter(|r| !r["publication"].is_null())
        .copied()
        .collect();
    assert_eq!(published.len(), 1, "requests: {requests:#?}");
    let publication = &published[0]["publication"];
    assert!(n(&publication["persistenceNs"]) > 0, "{publication}");
    assert!(n(&publication["preCandidateAnalysisNs"]) > 0, "{publication}");
    assert!(n(&publication["candidateNs"]) > 0, "{publication}");
    assert!(n(&publication["coreGraphRecordValueBytes"]) > 0, "{publication}");

    // Seq strictly increasing across the whole file.
    let seqs: Vec<u64> = records.iter().map(|r| n(&r["seq"])).collect();
    assert!(
        seqs.windows(2).all(|pair| pair[1] > pair[0]),
        "seq not strictly increasing: {seqs:?}"
    );

    // Restart on the same directory: recovery replays the one published op.
    let restart_path = directory.path().join("restart.jsonl");
    let restarted = start(&directory, "metrics-restart", &worker, Some(&restart_path));
    // A trivial read to be sure the restarted daemon is live and its recovery
    // record has been flushed.
    assert_eq!(
        send(&restarted, "hello2", "client:m", None, json!({"type":"hello"}))["ok"],
        true
    );
    restarted.terminate();

    let restart_records = read_records(&restart_path);
    let recovery: Vec<&Value> = restart_records
        .iter()
        .filter(|r| r["kind"] == "recovery")
        .collect();
    assert_eq!(recovery.len(), 1, "records: {restart_records:#?}");
    let recovery = recovery[0];
    assert_eq!(recovery["recovered"], true, "{recovery}");
    assert!(n(&recovery["replayNs"]) > 0, "{recovery}");
    assert_eq!(n(&recovery["seedNs"]), 0, "{recovery}");
    assert_eq!(n(&recovery["replayedOperations"]), 1, "{recovery}");
    assert!(n(&recovery["snapshotBytes"]) > 0, "{recovery}");
}

/// Without `--metrics`, the daemon writes no sink file and behaves identically.
#[test]
fn no_metrics_flag_writes_no_file() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let would_be = directory.path().join("metrics.jsonl");

    let service = start(&directory, "metrics-off", &worker, None);
    assert_eq!(
        send(&service, "hello", "client:m", None, json!({"type":"hello"}))["ok"],
        true
    );
    let change = send(
        &service,
        "begin",
        "client:m",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"no metrics"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add",
            "client:m",
            Some("add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        )["ok"],
        true
    );
    service.terminate();

    assert!(
        !would_be.exists(),
        "no metrics file must be written without --metrics"
    );
}
