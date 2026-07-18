#[path = "../src/bin/strata_kernel_service/protocol.rs"]
mod protocol;

use protocol::{
    LocalServiceProtocolContext, MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES,
    parse_request_frame, parse_response_frame, serialize_request_frame, serialize_response_frame,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const USER_ID: &str = "fc98295bca9efc3e";
const FORMAT_TIMESTAMP_ID: &str = "9a25d67ed4b74807";

const RAW_REJECTED_FIXTURES: [&str; 4] = [
    "duplicate-key",
    "position-exponent",
    "position-negative-zero",
    "lone-surrogate",
];

#[derive(Deserialize)]
struct FixtureFile {
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    direction: String,
    value: Value,
}

fn fixture(name: &str) -> FixtureFile {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/live-compare/tests/fixtures/protocol-v1")
        .join(format!("{name}.json"));
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn frame(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}

fn accepted_value(name: &str) -> Value {
    fixture("accepted")
        .cases
        .into_iter()
        .find(|entry| entry.name == name)
        .unwrap()
        .value
}

fn raw_rejected_frame(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/live-compare/tests/fixtures/protocol-v1/raw-rejected")
        .join(format!("{name}.json"));
    fs::read(path).unwrap()
}

fn raw_accepted_frame(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/live-compare/tests/fixtures/protocol-v1/raw-accepted")
        .join(format!("{name}.json"));
    fs::read(path).unwrap()
}

#[test]
fn protocol_shared_golden_messages_round_trip_as_one_lf_frame() {
    for case in fixture("accepted").cases {
        let encoded = if case.direction == "request" {
            let parsed = parse_request_frame(&frame(&case.value), None).unwrap();
            serialize_request_frame(&parsed).unwrap()
        } else {
            let parsed = parse_response_frame(&frame(&case.value)).unwrap();
            serialize_response_frame(&parsed).unwrap()
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded[..encoded.len() - 1]).unwrap(),
            case.value,
            "{}",
            case.name
        );
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);
    }
}

#[test]
fn protocol_shared_invalid_messages_are_rejected() {
    for case in fixture("rejected").cases {
        let result = if case.direction == "request" {
            parse_request_frame(&frame(&case.value), None).map(|_| ())
        } else {
            parse_response_frame(&frame(&case.value)).map(|_| ())
        };
        assert!(
            result.is_err(),
            "fixture unexpectedly accepted: {}",
            case.name
        );
    }
}

#[test]
fn protocol_shared_raw_json_representations_are_rejected() {
    for name in RAW_REJECTED_FIXTURES {
        assert!(
            parse_request_frame(&raw_rejected_frame(name), None).is_err(),
            "raw fixture unexpectedly accepted: {name}"
        );
    }
}

#[test]
fn protocol_shared_reordered_whitespace_raw_json_is_accepted() {
    parse_request_frame(&raw_accepted_frame("reordered-whitespace"), None).unwrap();
}

#[test]
fn protocol_shared_paired_surrogate_raw_json_is_accepted() {
    parse_request_frame(&raw_accepted_frame("surrogate-pair"), None).unwrap();
}

#[test]
fn protocol_rejects_missing_empty_extra_and_multiple_frames() {
    assert!(parse_request_frame(b"{}", None).is_err());
    assert!(parse_request_frame(b"\n", None).is_err());
    assert!(parse_request_frame(b"{}\n ", None).is_err());
    assert!(parse_request_frame(b"{}\n{}\n", None).is_err());
}

#[test]
fn protocol_rejects_invalid_utf8_and_json() {
    assert!(parse_request_frame(&[0xff, b'\n'], None).is_err());
    assert!(parse_request_frame(b"{]\n", None).is_err());
}

#[test]
fn protocol_rejects_frames_over_both_bounds_before_schema_parsing() {
    let request_error = parse_request_frame(&vec![0; MAX_REQUEST_FRAME_BYTES + 1], None)
        .unwrap_err()
        .to_string();
    assert!(request_error.contains("frame exceeds"));
    let response_error = parse_response_frame(&vec![0; MAX_RESPONSE_FRAME_BYTES + 1])
        .unwrap_err()
        .to_string();
    assert!(response_error.contains("frame exceeds"));
}

#[test]
fn protocol_rejects_duplicate_request_ids_with_different_bodies() {
    let original = accepted_value("inspect-nodes-request");
    let mut changed = original.clone();
    changed["action"]["nodeIds"] = json!(["node:other"]);
    let mut context = LocalServiceProtocolContext::default();
    parse_request_frame(&frame(&original), Some(&mut context)).unwrap();
    let error = parse_request_frame(&frame(&changed), Some(&mut context))
        .unwrap_err()
        .to_string();
    assert!(error.contains("request ID was already used with a different body"));
    parse_request_frame(&frame(&original), Some(&mut context)).unwrap();
}

#[test]
fn protocol_rejects_cross_client_change_set_access() {
    let mut submit = accepted_value("submit-change-set-request");
    submit["clientId"] = json!("client:beta");
    let mut context = LocalServiceProtocolContext::default();
    context
        .record_change_set_owner("change:1", "client:alpha")
        .unwrap();
    let error = parse_request_frame(&frame(&submit), Some(&mut context))
        .unwrap_err()
        .to_string();
    assert!(error.contains("change set belongs to a different client"));
}

#[test]
fn protocol_bounds_duplicate_and_ownership_context() {
    let mut context = LocalServiceProtocolContext::with_capacities(1, 1).unwrap();
    context
        .record_change_set_owner("change:1", "client:alpha")
        .unwrap();
    assert!(
        context
            .record_change_set_owner("change:2", "client:alpha")
            .unwrap_err()
            .to_string()
            .contains("context capacity")
    );

    parse_request_frame(&frame(&accepted_value("hello-request")), Some(&mut context)).unwrap();
    assert!(
        parse_request_frame(
            &frame(&accepted_value("inspect-nodes-request")),
            Some(&mut context),
        )
        .unwrap_err()
        .to_string()
        .contains("context capacity")
    );
}

struct RunningService {
    child: Child,
    socket_path: PathBuf,
    epoch: u64,
}

impl Drop for RunningService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn localized_source_snapshot(directory: &TempDir) -> PathBuf {
    let mut snapshot: Value =
        serde_json::from_str(include_str!("fixtures/examples-medium.snapshot.json")).unwrap();
    let nodes = snapshot["nodes"].as_array().unwrap();
    let mut retained = nodes
        .iter()
        .filter(|node| {
            node["kind"] == "Module"
                && node["payload"]
                    .as_str()
                    .is_some_and(|payload| payload.starts_with("/project/src/"))
        })
        .map(|node| node["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    loop {
        let before = retained.len();
        for node in nodes {
            if node["parentId"]
                .as_str()
                .is_some_and(|parent| retained.contains(parent))
            {
                retained.insert(node["id"].as_str().unwrap().to_owned());
            }
        }
        if before == retained.len() {
            break;
        }
    }
    snapshot["nodes"]
        .as_array_mut()
        .unwrap()
        .retain(|node| retained.contains(node["id"].as_str().unwrap()));
    snapshot["references"]
        .as_array_mut()
        .unwrap()
        .retain(|reference| {
            retained.contains(reference["fromNodeId"].as_str().unwrap())
                && retained.contains(reference["toNodeId"].as_str().unwrap())
        });
    let corpus_root = repo_root().join("examples/medium");
    for module in snapshot["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|node| node["kind"] == "Module")
    {
        let relative = module["payload"]
            .as_str()
            .unwrap()
            .strip_prefix("/project/")
            .unwrap();
        module["payload"] = json!(corpus_root.join(relative).to_string_lossy());
    }
    let path = directory.path().join("snapshot.json");
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    path
}

fn start_service(directory: &TempDir, token: &str) -> RunningService {
    let worker = bridge_worker();
    start_service_with_worker(directory, token, worker)
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

fn start_service_with_worker(directory: &TempDir, token: &str, worker: PathBuf) -> RunningService {
    let snapshot = localized_source_snapshot(directory);
    let audit = directory.path().join("service-audit.jsonl");
    let mut child = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args([
            "serve",
            "--db",
            directory.path().join("kernel.redb").to_str().unwrap(),
            "--snapshot",
            snapshot.to_str().unwrap(),
            "--bridge-worker",
            worker.to_str().unwrap(),
            "--source-root",
            repo_root().join("examples/medium/src").to_str().unwrap(),
            "--corpus-root",
            repo_root().join("examples/medium").to_str().unwrap(),
            "--socket-token",
            token,
            "--audit",
            audit.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.is_empty() {
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        panic!("service exited before readiness: {stderr}");
    }
    let ready: Value = serde_json::from_str(&line).unwrap();
    let socket_path = PathBuf::from(ready["socketPath"].as_str().unwrap());
    assert!(socket_path.starts_with("/tmp/strata-lc/"));
    assert!(socket_path.as_os_str().as_encoded_bytes().len() <= 96);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(socket_path.exists(), "service socket was not created");
    RunningService {
        child,
        socket_path,
        epoch: ready["serviceEpoch"].as_str().unwrap().parse().unwrap(),
    }
}

fn request(
    service: &RunningService,
    request_id: &str,
    client_id: &str,
    idempotency_key: Option<&str>,
    action: Value,
) -> Value {
    let mut value = json!({
        "protocolVersion": 1,
        "requestId": request_id,
        "clientId": client_id,
        "deadlineMs": "120000",
        "action": action,
    });
    if let Some(key) = idempotency_key {
        value["idempotencyKey"] = json!(key);
    }
    let mut stream = UnixStream::connect(&service.socket_path).unwrap();
    stream.write_all(&frame(&value)).unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
}

fn begin(service: &RunningService, client: &str, suffix: &str) -> String {
    let response = request(
        service,
        &format!("request:{suffix}:begin"),
        client,
        Some(&format!("idem:{suffix}:begin")),
        json!({"type":"begin_change_set","reasoning":format!("reason:{suffix}")}),
    );
    assert_eq!(response["ok"], true, "{response}");
    response["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn mutate_rename(
    service: &RunningService,
    client: &str,
    suffix: &str,
    change_set_id: &str,
    declaration_id: &str,
    new_name: &str,
) -> Value {
    for (step, action) in [
        (
            "add",
            json!({"type":"add_intent","changeSetId":change_set_id,"intent":{"type":"rename_symbol","declarationId":declaration_id,"newName":new_name}}),
        ),
        (
            "submit",
            json!({"type":"submit_change_set","changeSetId":change_set_id}),
        ),
    ] {
        let response = request(
            service,
            &format!("request:{suffix}:{step}"),
            client,
            Some(&format!("idem:{suffix}:{step}")),
            action,
        );
        assert_eq!(response["ok"], true, "{response}");
    }
    request(
        service,
        &format!("request:{suffix}:advance"),
        client,
        Some(&format!("idem:{suffix}:advance")),
        json!({"type":"advance_change_set","changeSetId":change_set_id}),
    )
}

fn assert_no_authority_fields(value: &Value) {
    const FORBIDDEN: &[&str] = &[
        "scope",
        "reservationKeys",
        "dependencyVersions",
        "serviceEpoch",
        "attemptId",
        "claimId",
        "claimToken",
        "fence",
        "candidateDelta",
        "candidateDigest",
        "redbPath",
        "bridgeWorker",
    ];
    match value {
        Value::Object(object) => {
            for (key, nested) in object {
                assert!(
                    !FORBIDDEN.contains(&key.as_str()),
                    "forbidden {key}: {value}"
                );
                assert_no_authority_fields(nested);
            }
        }
        Value::Array(values) => values.iter().for_each(assert_no_authority_fields),
        _ => {}
    }
}

#[test]
fn daemon_hosts_two_actor_bound_clients_and_one_safe_canonical_graph() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "deep-worktree-independent-token");
    assert_eq!(service.epoch, 1);

    let alpha_change = begin(&service, "client:alpha", "alpha");
    let duplicate = request(
        &service,
        "request:alpha:begin:retry",
        "client:alpha",
        Some("idem:alpha:begin"),
        json!({"type":"begin_change_set","reasoning":"reason:alpha"}),
    );
    assert_eq!(duplicate["result"]["changeSetId"], alpha_change);
    let alpha = mutate_rename(
        &service,
        "client:alpha",
        "alpha",
        &alpha_change,
        USER_ID,
        "Account",
    );
    assert_eq!(alpha["result"]["state"], "published", "{alpha}");

    let beta_change = begin(&service, "client:beta", "beta");
    let beta = mutate_rename(
        &service,
        "client:beta",
        "beta",
        &beta_change,
        FORMAT_TIMESTAMP_ID,
        "renderTimestamp",
    );
    assert_eq!(beta["result"]["state"], "published", "{beta}");

    let inspected = request(
        &service,
        "request:inspect:final",
        "client:alpha",
        None,
        json!({"type":"inspect_nodes","nodeIds":[USER_ID,FORMAT_TIMESTAMP_ID]}),
    );
    let payloads = inspected["result"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["payload"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(
        payloads
            .iter()
            .any(|payload| payload.contains("interface Account"))
    );
    assert!(
        payloads
            .iter()
            .any(|payload| payload.contains("function renderTimestamp"))
    );
    assert_eq!(inspected["result"]["graphGeneration"], "2");

    let alpha_events = request(
        &service,
        "request:alpha:events",
        "client:alpha",
        None,
        json!({"type":"read_events","afterSequence":"0","limit":256}),
    );
    let through = alpha_events["result"]["events"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["sequence"]
        .as_str()
        .unwrap()
        .to_owned();
    let unauthorized_ack = request(
        &service,
        "request:gamma:ack",
        "client:gamma",
        Some("idem:gamma:ack"),
        json!({"type":"ack_events","throughSequence":through}),
    );
    assert_eq!(unauthorized_ack["ok"], false);
    let acknowledged = request(
        &service,
        "request:alpha:ack",
        "client:alpha",
        Some("idem:alpha:ack"),
        json!({"type":"ack_events","throughSequence":through}),
    );
    assert_eq!(acknowledged["ok"], true);

    for response in [alpha, beta, inspected, alpha_events, acknowledged] {
        assert_no_authority_fields(&response);
    }

    let audit_path = directory.path().join("service-audit.jsonl");
    let audit = fs::read_to_string(audit_path).unwrap();
    assert!(!audit.contains("deep-worktree-independent-token"));
    assert!(!audit.contains("idem:alpha"));
    assert!(!audit.contains(directory.path().to_str().unwrap()));
    let mut previous = "0".repeat(64);
    let mut ticks = Vec::new();
    for line in audit.lines() {
        let entry: Value = serde_json::from_str(line).unwrap();
        assert_eq!(entry["previousHash"], previous);
        let mut hasher = Sha256::new();
        hasher.update(previous.as_bytes());
        hasher.update(serde_json::to_vec(&entry["event"]).unwrap());
        let expected = format!("{:x}", hasher.finalize());
        assert_eq!(entry["entryHash"], expected);
        previous = expected;
        if entry["event"]["kind"] == "request_completed"
            && let Some(tick) = entry["event"]["tick"].as_str()
        {
            ticks.push(tick.parse::<u64>().unwrap());
        }
    }
    assert!(ticks.windows(2).all(|window| window[0] < window[1]));
}

#[test]
fn daemon_rejects_unsafe_or_overlong_socket_paths_before_bind() {
    let overlong = format!("/tmp/strata-lc/{}.sock", "a".repeat(100));
    let output = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args(["validate-socket", "--socket", &overlong])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("96 UTF-8 bytes"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!PathBuf::from(overlong).exists());

    let repository_path = repo_root().join("service.sock");
    let output = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args([
            "validate-socket",
            "--socket",
            repository_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("/tmp/strata-lc/"));
}
