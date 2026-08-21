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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const USER_ID: &str = "fc98295bca9efc3e";
const FORMAT_TIMESTAMP_ID: &str = "9a25d67ed4b74807";
/// The `greet` function declaration in the localized `examples/medium`
/// snapshot every test in this file shares.
const GREET_FUNCTION_ID: &str = "603b2ae524ee3c70";

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

fn rejected_value(name: &str) -> Value {
    fixture("rejected")
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

/// B-2 Task 7 sweep discipline: every REJECTED `ready` fixture gained the two
/// new required identity fields, so each one must still fail for ITS OWN
/// original defect — not merely because the new fields were missing. Removing
/// (or correcting) the stated defect must make the frame parse.
#[test]
fn rejected_ready_fixtures_still_fail_for_their_own_defect() {
    fn assert_repair_parses(name: &str, repair: impl FnOnce(&mut Value)) {
        let mut value = rejected_value(name);
        assert!(
            parse_response_frame(&frame(&value)).is_err(),
            "{name} must be rejected as written"
        );
        repair(&mut value);
        parse_response_frame(&frame(&value))
            .unwrap_or_else(|error| panic!("{name} must parse once repaired: {error:#}"));
    }

    // Pre-existing negative cases: the defect is an extra authority field.
    assert_repair_parses("unknown-response-field", |value| {
        value.as_object_mut().unwrap().remove("serviceEpoch");
    });
    assert_repair_parses("attempt-authority", |value| {
        value["result"].as_object_mut().unwrap().remove("attemptId");
    });
    assert_repair_parses("raw-delta-response", |value| {
        value["result"].as_object_mut().unwrap().remove("delta");
    });

    // New cases: the identity fields are required, and typed.
    assert_repair_parses("ready-response-missing-validation-mode", |value| {
        value["result"]["validationMode"] = json!("behavioral");
    });
    assert_repair_parses(
        "ready-response-missing-validation-manifest-digest",
        |value| {
            value["result"]["validationManifestDigest"] = Value::Null;
        },
    );
    assert_repair_parses("ready-response-unknown-validation-mode", |value| {
        value["result"]["validationMode"] = json!("behavioral");
    });
    assert_repair_parses(
        "ready-response-malformed-validation-manifest-digest",
        |value| {
            value["result"]["validationManifestDigest"] = json!("a".repeat(64));
        },
    );
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
    /// The parsed stdout readiness line. Retained so the B-2 Task 7 gate can
    /// assert the session-identity fields it now carries.
    readiness: Value,
}

impl Drop for RunningService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    // Canonicalized (not just `.join("../..")`): module payloads built from
    // this value (`localized_source_snapshot`) must match daemon-side
    // `canonical_corpus_root` byte-for-byte, since `project_module_path` is a
    // purely lexical prefix match against the canonicalized `--corpus-root`.
    // An uncanonicalized `../..` literal in the payload string is not a
    // realistic ingest payload and was never exercised before `list_modules`.
    std::fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap()
}

fn localized_source_snapshot(directory: &TempDir) -> PathBuf {
    let corpus_root = repo_root().join("examples/medium");
    let snapshot = localized_snapshot_value(&corpus_root);
    let path = directory.path().join("snapshot.json");
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    path
}

/// The shared `examples/medium` snapshot with every retained module payload
/// rewritten under `corpus_root`. Parameterized so the seed-green tests can
/// point a daemon at a PRIVATE copy of the corpus (they write fixtures into
/// it) while the pre-existing tests keep using the repo's own.
fn localized_snapshot_value(corpus_root: &Path) -> Value {
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
    snapshot
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
    start_service_with_snapshot(directory, token, worker, snapshot)
}

/// One escaping-payload variant snapshot: same corpus-localization as
/// `localized_source_snapshot`, except the FIRST module node encountered is
/// rewritten to an absolute path OUTSIDE `examples/medium` (the tempdir
/// itself) instead of being projected under the corpus root. Returns the
/// snapshot path, the escaping module's ID, and its raw (off-corpus) payload
/// so the caller can assert an error message names the ID but never the
/// payload.
fn localized_source_snapshot_with_escape(directory: &TempDir) -> (PathBuf, String, String) {
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
    let outside_payload = directory
        .path()
        .join("outside.ts")
        .to_string_lossy()
        .into_owned();
    let mut escaped_module_id = None;
    for module in snapshot["nodes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|node| node["kind"] == "Module")
    {
        if escaped_module_id.is_none() {
            escaped_module_id = Some(module["id"].as_str().unwrap().to_owned());
            module["payload"] = json!(outside_payload);
            continue;
        }
        let relative = module["payload"]
            .as_str()
            .unwrap()
            .strip_prefix("/project/")
            .unwrap();
        module["payload"] = json!(corpus_root.join(relative).to_string_lossy());
    }
    let path = directory.path().join("snapshot.json");
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    (path, escaped_module_id.unwrap(), outside_payload)
}

fn start_service_with_snapshot(
    directory: &TempDir,
    token: &str,
    worker: PathBuf,
    snapshot: PathBuf,
) -> RunningService {
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
        readiness: ready,
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

/// Same begin/add/submit/advance shape as `mutate_rename`, for the one
/// intent class that can be driven to a REAL `tsc` rejection from the wire:
/// an `add_parameter` whose declared type does not exist anywhere in the
/// corpus, so the worker's mutate stage succeeds and its validate stage
/// fails with genuine compiler diagnostics.
fn mutate_add_parameter(
    service: &RunningService,
    client: &str,
    suffix: &str,
    change_set_id: &str,
    function_id: &str,
    type_text: &str,
) -> Value {
    for (step, action) in [
        (
            "add",
            json!({"type":"add_intent","changeSetId":change_set_id,"intent":{"type":"add_parameter","functionId":function_id,"name":"audit","typeText":type_text,"position":1,"value":"undefined as never"}}),
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
fn find_declarations_returns_named_interface_and_rejects_unknown_kind() {
    // The `User` interface (renamed to `Account` in the mutation test above) and
    // the `greet` function (with a JSDoc `@param {User} user` block ahead of its
    // declaration name in source) both live in the localized examples/medium
    // fixture snapshot every test in this file shares.
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "find-declarations-token");

    // 1) exact name + kind match returns exactly one declaration.
    let found = request(
        &service,
        "request:find:user",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"User","kind":"interface"}),
    );
    assert_eq!(found["ok"], true, "{found}");
    let declarations = found["result"]["declarations"].as_array().unwrap();
    assert_eq!(declarations.len(), 1, "{found}");
    assert_eq!(declarations[0]["nodeId"], USER_ID);
    assert_eq!(declarations[0]["kind"], "interface");
    assert_eq!(declarations[0]["name"], "User");
    assert!(declarations[0]["moduleId"].is_string());
    assert!(found["result"]["graphGeneration"].is_string());

    // 2) unmatched name returns an empty (still-ok) result.
    let missing = request(
        &service,
        "request:find:missing",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"NoSuchSymbol"}),
    );
    assert_eq!(missing["ok"], true, "{missing}");
    assert_eq!(
        missing["result"]["declarations"].as_array().unwrap().len(),
        0
    );

    // 3) an unknown kind is a protocol error, not a partial/empty result.
    let bad_kind = request(
        &service,
        "request:find:bad-kind",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"User","kind":"enum"}),
    );
    assert_eq!(bad_kind["ok"], false, "{bad_kind}");

    // 4) JSDoc regression: `greet`'s declaration payload carries a leading
    // `/** ... @param {User} user */` block whose `param`/`User`/`user`
    // identifiers are children of the FunctionDeclaration node at lower
    // source offsets than the real declaration name `greet`. Discovery must
    // resolve the canonical declaration name (token-derived, comment-aware),
    // not the lowest-offset Identifier child.
    let greet = request(
        &service,
        "request:find:greet",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"greet","kind":"function"}),
    );
    assert_eq!(greet["ok"], true, "{greet}");
    let greet_matches = greet["result"]["declarations"].as_array().unwrap();
    assert_eq!(greet_matches.len(), 1, "{greet}");
    assert_eq!(greet_matches[0]["nodeId"], GREET_FUNCTION_ID);
    assert_eq!(greet_matches[0]["name"], "greet");

    // The JSDoc `@param` tag name must never surface as a discoverable
    // declaration name for the function it annotates.
    let jsdoc_trap = request(
        &service,
        "request:find:param",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"param","kind":"function"}),
    );
    assert_eq!(jsdoc_trap["ok"], true, "{jsdoc_trap}");
    assert_eq!(
        jsdoc_trap["result"]["declarations"]
            .as_array()
            .unwrap()
            .len(),
        0,
        "{jsdoc_trap}"
    );
}

#[test]
fn read_operation_returns_canonical_audit_record_and_rejects_unknown_id() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "read-operation-token");

    let change_set_id = begin(&service, "client:alpha", "read-op");
    let published = mutate_rename(
        &service,
        "client:alpha",
        "read-op",
        &change_set_id,
        USER_ID,
        "Account",
    );
    assert_eq!(published["result"]["state"], "published", "{published}");
    let operation_id = published["result"]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();

    let read = request(
        &service,
        "request:read-op:read",
        "client:alpha",
        None,
        json!({"type":"read_operation","operationId":operation_id}),
    );
    assert_eq!(read["ok"], true, "{read}");
    let result = &read["result"];
    assert_eq!(result["type"], "operation");
    assert!(result["graphGeneration"].is_string(), "{read}");
    assert_eq!(result["operationId"], operation_id);
    assert_eq!(result["changeSetId"], change_set_id);
    assert_eq!(result["actor"], "client:alpha");
    assert_eq!(result["kind"], "RenameSymbol");
    assert_eq!(result["reasoning"], "reason:read-op");
    let affected = result["affectedNodeIds"].as_array().unwrap();
    assert!(affected.len() > 1, "{read}");
    assert_eq!(
        result["renames"],
        json!([{"nodeId": USER_ID, "fromName": "User", "toName": "Account"}])
    );
    let intents = result["intents"].as_array().unwrap();
    assert_eq!(intents.len(), 1, "{read}");
    assert_eq!(intents[0]["kind"], "RenameSymbol");
    let parameters: Value =
        serde_json::from_str(intents[0]["parametersJson"].as_str().unwrap()).unwrap();
    assert_eq!(
        parameters,
        json!({"type":"renameSymbol","declarationId":USER_ID,"newName":"Account"})
    );
    let digest = result["publicationDigest"].as_str().unwrap();
    assert_eq!(digest.len(), 64, "{read}");
    assert!(
        digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{read}"
    );
    assert_no_authority_fields(&read);

    let unknown = request(
        &service,
        "request:read-op:unknown",
        "client:alpha",
        None,
        json!({"type":"read_operation","operationId":"operation:does-not-exist"}),
    );
    assert_eq!(unknown["ok"], false, "{unknown}");
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

/// The single-flag pin for `--validation-manifest` (B-2 Task 5): the shared
/// `parse_named` pair-parser in main.rs rejects ANY repeated `--name value`
/// flag (not just this one) as soon as it sees the duplicate key, before
/// `serve`'s own required-option checks run — so this fails fast even
/// without `--db`/`--snapshot`/etc. supplied.
#[test]
fn serve_rejects_duplicate_validation_manifest_flag_before_required_options() {
    let output = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args([
            "serve",
            "--validation-manifest",
            "a",
            "--validation-manifest",
            "b",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("invalid or duplicate option"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn discovery_list_modules_projects_absolute_payloads_and_pages_deterministically() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "discovery-list-modules-token");

    // Walk the whole module list one item at a time, following afterModuleId,
    // and track every graphGeneration seen along the way.
    let mut walked: Vec<Value> = Vec::new();
    let mut after: Option<String> = None;
    let mut generations = BTreeSet::new();
    loop {
        let mut action = json!({"type":"list_modules","limit":1});
        if let Some(after_id) = &after {
            action["afterModuleId"] = json!(after_id);
        }
        let response = request(
            &service,
            &format!("request:list-modules:walk:{}", walked.len()),
            "client:alpha",
            None,
            action,
        );
        assert_eq!(response["ok"], true, "{response}");
        let result = &response["result"];
        generations.insert(result["graphGeneration"].as_str().unwrap().to_owned());
        let modules = result["modules"].as_array().unwrap();
        assert_eq!(modules.len(), 1, "{response}");
        let module = modules[0].clone();
        after = Some(module["moduleId"].as_str().unwrap().to_owned());
        let has_more = result["hasMore"].as_bool().unwrap();
        walked.push(module);
        if !has_more {
            break;
        }
    }
    assert!(!walked.is_empty());
    assert_eq!(
        generations.len(),
        1,
        "every page of the walk must report the same graphGeneration: {generations:?}"
    );

    for module in &walked {
        let path = module["path"].as_str().unwrap();
        assert!(path.starts_with("src/"), "path must be corpus-relative: {path}");
        assert!(!path.starts_with('/'), "path must not be absolute: {path}");
        assert!(!path.contains(".."), "path must not contain ..: {path}");
        assert!(!path.contains('\\'), "path must not contain a backslash: {path}");
    }

    let single_page = request(
        &service,
        "request:list-modules:single-page",
        "client:alpha",
        None,
        json!({"type":"list_modules","limit":64}),
    );
    assert_eq!(single_page["ok"], true, "{single_page}");
    assert_eq!(single_page["result"]["hasMore"], false, "{single_page}");
    assert_eq!(
        single_page["result"]["modules"],
        Value::Array(walked.clone()),
        "one limit:64 page must equal the paged walk"
    );

    let user_module = walked
        .iter()
        .find(|module| module["path"] == "src/types/user.ts")
        .expect("src/types/user.ts must be present in the walk");
    assert!(
        user_module["declarationCount"].as_u64().unwrap() >= 1,
        "{user_module}"
    );
}

#[test]
fn discovery_list_module_declarations_matches_registered_target() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "discovery-list-declarations-token");

    let modules = request(
        &service,
        "request:list-modules",
        "client:alpha",
        None,
        json!({"type":"list_modules","limit":64}),
    );
    assert_eq!(modules["ok"], true, "{modules}");
    let user_module_id = modules["result"]["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|module| module["path"] == "src/types/user.ts")
        .expect("src/types/user.ts must be present")["moduleId"]
        .as_str()
        .unwrap()
        .to_owned();

    let declarations = request(
        &service,
        "request:list-module-declarations",
        "client:alpha",
        None,
        json!({"type":"list_module_declarations","moduleId":user_module_id,"limit":64}),
    );
    assert_eq!(declarations["ok"], true, "{declarations}");
    let entries = declarations["result"]["declarations"].as_array().unwrap();
    let user_entry = entries
        .iter()
        .find(|entry| entry["nodeId"] == USER_ID)
        .unwrap_or_else(|| panic!("USER_ID missing from declarations: {entries:?}"));
    assert_eq!(user_entry["name"], "User");
    assert_eq!(user_entry["kind"], "InterfaceDeclaration");
    assert_eq!(user_entry["exported"], true);
}

#[test]
fn discovery_scoped_find_declarations_resolves_without_global_lookup() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "discovery-scoped-find-token");

    let modules_response = request(
        &service,
        "request:list-modules",
        "client:alpha",
        None,
        json!({"type":"list_modules","limit":64}),
    );
    assert_eq!(modules_response["ok"], true, "{modules_response}");
    let modules = modules_response["result"]["modules"].as_array().unwrap();
    let user_module_id = modules
        .iter()
        .find(|module| module["path"] == "src/types/user.ts")
        .expect("src/types/user.ts must be present")["moduleId"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_module_id = modules
        .iter()
        .find(|module| module["moduleId"].as_str().unwrap() != user_module_id)
        .expect("a second module must exist for the negative control")["moduleId"]
        .as_str()
        .unwrap()
        .to_owned();

    let scoped = request(
        &service,
        "request:find:scoped",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"User","moduleId":user_module_id}),
    );
    assert_eq!(scoped["ok"], true, "{scoped}");
    let matches = scoped["result"]["declarations"].as_array().unwrap();
    assert_eq!(matches.len(), 1, "{scoped}");
    assert_eq!(matches[0]["nodeId"], USER_ID);
    assert_eq!(scoped["result"]["hasMore"], false, "{scoped}");

    let wrong_module = request(
        &service,
        "request:find:wrong-module",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"User","moduleId":other_module_id}),
    );
    assert_eq!(wrong_module["ok"], true, "{wrong_module}");
    assert_eq!(
        wrong_module["result"]["declarations"]
            .as_array()
            .unwrap()
            .len(),
        0,
        "{wrong_module}"
    );
}

#[test]
fn discovery_get_references_pages_and_attributes_modules() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "discovery-get-references-token");

    let mut walked: Vec<Value> = Vec::new();
    let mut after: Option<String> = None;
    let mut generations = BTreeSet::new();
    loop {
        let mut action = json!({"type":"get_references","nodeId":USER_ID,"limit":1});
        if let Some(after_key) = &after {
            action["afterReferenceKey"] = json!(after_key);
        }
        let response = request(
            &service,
            &format!("request:get-references:walk:{}", walked.len()),
            "client:alpha",
            None,
            action,
        );
        assert_eq!(response["ok"], true, "{response}");
        let result = &response["result"];
        generations.insert(result["graphGeneration"].as_str().unwrap().to_owned());
        let references = result["references"].as_array().unwrap();
        assert_eq!(references.len(), 1, "{response}");
        let reference = references[0].clone();
        after = Some(reference["fromNodeId"].as_str().unwrap().to_owned());
        let has_more = result["hasMore"].as_bool().unwrap();
        walked.push(reference);
        if !has_more {
            break;
        }
    }
    assert!(
        !walked.is_empty(),
        "USER_ID must have at least one incoming (subtree) reference"
    );
    assert_eq!(
        generations.len(),
        1,
        "every page of the walk must report the same graphGeneration: {generations:?}"
    );

    let single_page = request(
        &service,
        "request:get-references:single-page",
        "client:alpha",
        None,
        json!({"type":"get_references","nodeId":USER_ID,"limit":256}),
    );
    assert_eq!(single_page["ok"], true, "{single_page}");
    assert_eq!(single_page["result"]["hasMore"], false, "{single_page}");
    assert_eq!(
        single_page["result"]["references"],
        Value::Array(walked.clone()),
        "one limit:256 page must equal the paged walk"
    );

    let modules_response = request(
        &service,
        "request:list-modules:for-references",
        "client:alpha",
        None,
        json!({"type":"list_modules","limit":64}),
    );
    assert_eq!(modules_response["ok"], true, "{modules_response}");
    let module_ids = modules_response["result"]["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["moduleId"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    for reference in &walked {
        let module_id = reference["moduleId"].as_str().unwrap();
        assert!(
            module_ids.contains(module_id),
            "{module_id} referenced but missing from the list_modules walk"
        );
    }

    let unknown = request(
        &service,
        "request:get-references:unknown",
        "client:alpha",
        None,
        json!({"type":"get_references","nodeId":"node:does-not-exist","limit":256}),
    );
    assert_eq!(unknown["ok"], false, "{unknown}");
    assert_eq!(unknown["error"]["code"], "request_failed", "{unknown}");
}

#[test]
fn discovery_list_modules_fails_closed_on_escaping_module_payload() {
    let directory = tempfile::tempdir().unwrap();
    let (snapshot, escaped_module_id, escaped_payload) =
        localized_source_snapshot_with_escape(&directory);
    let worker = bridge_worker();
    let service =
        start_service_with_snapshot(&directory, "discovery-escape-token", worker, snapshot);

    let failed = request(
        &service,
        "request:list-modules:escape",
        "client:alpha",
        None,
        json!({"type":"list_modules","limit":64}),
    );
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["error"]["code"], "request_failed", "{failed}");
    let message = failed["error"]["message"].as_str().unwrap();
    assert!(
        message.contains(&escaped_module_id),
        "error message must name the offending module ID: {message}"
    );
    assert!(
        !message.contains(&escaped_payload),
        "error message must NOT leak the raw payload: {message}"
    );

    // Fail-closed is per-request, not per-daemon: hello and find_declarations
    // still work on the exact same running service.
    let hello = request(
        &service,
        "request:hello:escape",
        "client:alpha",
        None,
        json!({"type":"hello"}),
    );
    assert_eq!(hello["ok"], true, "{hello}");

    let found = request(
        &service,
        "request:find:escape",
        "client:alpha",
        None,
        json!({"type":"find_declarations","name":"User","kind":"interface"}),
    );
    assert_eq!(found["ok"], true, "{found}");
    assert_eq!(
        found["result"]["declarations"].as_array().unwrap().len(),
        1,
        "{found}"
    );
}

#[test]
fn discovery_read_actions_reject_idempotency_keys() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "discovery-idempotency-token");

    let rejected = rejected_value("list-modules-request-idempotency-key");
    let response = request(
        &service,
        rejected["requestId"].as_str().unwrap(),
        rejected["clientId"].as_str().unwrap(),
        rejected["idempotencyKey"].as_str(),
        rejected["action"].clone(),
    );
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "invalid_request", "{response}");
}

/// SEMANTIC arm of the candidate failure taxonomy (item-B2 Task 4). The
/// worker evaluated the candidate and `tsc` rejected it — a verdict, not a
/// transport failure — so the advance is a SUCCESS response carrying the
/// state `validation_failed` and the REAL compiler diagnostics. Before B-2
/// the service collapsed every candidate error into one fabricated
/// `candidate_validation_failed` diagnostic, which told an agent nothing it
/// could act on.
#[test]
fn taxonomy_semantic_rejection_carries_real_tsc_diagnostics() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "taxonomy-semantic-tsc-token");
    let change = begin(&service, "client:taxonomy", "taxonomy-semantic");
    let response = mutate_add_parameter(
        &service,
        "client:taxonomy",
        "taxonomy-semantic",
        &change,
        GREET_FUNCTION_ID,
        "NoSuchType",
    );

    assert_eq!(
        response["ok"], true,
        "a semantic rejection is a verdict, not a failed request: {response}"
    );
    assert_eq!(
        response["result"]["state"], "validation_failed",
        "{response}"
    );
    let diagnostics = response["result"]["diagnostics"].as_array().unwrap();
    assert!(
        !diagnostics.is_empty(),
        "validation_failed must never be diagnostic-free: {response}"
    );
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic["code"]
                .as_str()
                .is_some_and(|code| code.starts_with("typescriptFailed:"))
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("NoSuchType"))
        }),
        "expected real tsc text naming the missing type: {response}"
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic["modulePath"].is_string()),
        "the projected corpus-relative modulePath must reach the wire: {response}"
    );
    for diagnostic in diagnostics {
        assert_ne!(
            diagnostic["code"], "candidate_validation_failed",
            "the fabricated diagnostic is retired: {response}"
        );
        if let Some(path) = diagnostic["modulePath"].as_str() {
            assert!(
                path.starts_with("src/"),
                "modulePath must be corpus-relative, never a raw payload: {response}"
            );
        }
    }
    assert_no_authority_fields(&response);
}

/// The rejection half of the split keeps the pre-B-2 operational contract
/// intact: audit kind `validation_failed`, and the cancel follow-up still
/// releases the change set (so the claim it held cannot block later work).
#[test]
fn taxonomy_rejection_still_cancels_and_audits() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "taxonomy-rejection-cancel-token");
    let change = begin(&service, "client:taxonomy", "taxonomy-cancel");
    let response = mutate_add_parameter(
        &service,
        "client:taxonomy",
        "taxonomy-cancel",
        &change,
        GREET_FUNCTION_ID,
        "NoSuchType",
    );
    assert_eq!(
        response["result"]["state"], "validation_failed",
        "{response}"
    );

    let events = request(
        &service,
        "request:taxonomy-cancel:events",
        "client:taxonomy",
        None,
        json!({"type":"read_events","afterSequence":"0","limit":256}),
    );
    assert!(
        events["result"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| {
                event["kind"] == "intent_cancelled" && event["changeSetId"] == json!(change)
            }),
        "the cancel follow-up must still run for a rejection: {events}"
    );

    let audit = fs::read_to_string(directory.path().join("service-audit.jsonl")).unwrap();
    assert!(
        audit.lines().any(|line| {
            let entry: Value = serde_json::from_str(line).unwrap();
            entry["event"]["kind"] == "validation_failed"
                && entry["event"]["changeSetId"] == json!(change)
        }),
        "a rejection audits as validation_failed"
    );
    assert!(
        !audit.contains("candidate_execution_failed"),
        "a semantic rejection must not be audited as an operational failure"
    );
}

/// Guard: the `Vec<Diagnostic>` refactor of `change_set_result` must not
/// leak a diagnostic onto the clean path. A rename that validates green
/// still publishes with an empty diagnostics array.
#[test]
fn taxonomy_diagnostics_survive_needs_decision_free_path() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_service(&directory, "taxonomy-clean-rename-token");
    let change = begin(&service, "client:taxonomy", "taxonomy-clean");
    let response = mutate_rename(
        &service,
        "client:taxonomy",
        "taxonomy-clean",
        &change,
        USER_ID,
        "Account",
    );
    assert_eq!(response["result"]["state"], "published", "{response}");
    assert_eq!(
        response["result"]["diagnostics"].as_array().unwrap().len(),
        0,
        "{response}"
    );
}

// ---------------------------------------------------------------------------
// B-2 Task 7: the seed-green startup gate and the manifest identity it
// publishes on the readiness line, the start audit event, and `hello`.
// ---------------------------------------------------------------------------

/// A green baseline fixture: pins `greet`'s CURRENT behavior, so it passes
/// against the seed corpus exactly as published.
const GREEN_FIXTURE: &str = concat!(
    "import { expect, it } from \"vitest\";\n",
    "import { greet } from \"../src/users/greet.ts\";\n",
    "it(\"pins the seed corpus behavior\", () => {\n",
    "  expect(greet({ id: \"1\", email: \"seed@example.test\" })).toBe(\"hello seed@example.test\");\n",
    "});\n"
);

/// A red baseline fixture: asserts a property the seed corpus does NOT have.
const RED_FIXTURE: &str = concat!(
    "import { expect, it } from \"vitest\";\n",
    "import { greet } from \"../src/users/greet.ts\";\n",
    "it(\"asserts a property the seed corpus does not have\", () => {\n",
    "  expect(greet({ id: \"1\", email: \"seed@example.test\" })).toBe(\"SEED_BASELINE_IS_RED\");\n",
    "});\n"
);

/// A private, canonicalized copy of `examples/medium` the seed-green tests
/// write their fixtures into. Canonicalized because the daemon canonicalizes
/// `--corpus-root`, and module payloads are matched lexically against it.
///
/// `node_modules` is never copied — matching the TS `baselineMedium` helper.
/// A stale vitest cache (`node_modules/.vite`) left in the shared corpus by an
/// unrelated local run breaks the spawned baseline in the copy, which would
/// make these tests fail for reasons that have nothing to do with the gate.
fn private_medium_corpus(directory: &TempDir) -> PathBuf {
    let source = repo_root().join("examples/medium");
    let root = directory.path().join("corpus");
    fs::create_dir_all(&root).unwrap();
    for entry in fs::read_dir(&source).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "node_modules" {
            continue;
        }
        let status = Command::new("cp")
            .arg("-R")
            .arg(entry.path())
            .arg(root.join(entry.file_name()))
            .status()
            .unwrap();
        assert!(status.success(), "corpus copy failed for {:?}", entry.path());
    }
    fs::canonicalize(&root).unwrap()
}

/// Writes `contents` to `tests/<name>` under the corpus and returns the
/// manifest fixture entry (corpus-relative path + its real sha256).
fn write_corpus_fixture(corpus_root: &Path, name: &str, contents: &str) -> Value {
    let path = corpus_root.join("tests").join(name);
    fs::write(&path, contents).unwrap();
    json!({
        "path": format!("tests/{name}"),
        "sha256": format!("{:x}", Sha256::digest(contents.as_bytes())),
    })
}

fn write_validation_manifest(directory: &TempDir, mode: &str, fixtures: Vec<Value>) -> PathBuf {
    let path = directory.path().join("validation-manifest.json");
    fs::write(
        &path,
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "mode": mode,
            "strictSrcOnlyTscScope": true,
            "tscTimeoutMs": 120_000,
            "vitestTimeoutMs": 120_000,
            "fixtures": fixtures,
        }))
        .unwrap(),
    )
    .unwrap();
    path
}

/// Localized snapshot for a private corpus, optionally carrying one synthetic
/// module whose rendered text does NOT type-check — the corpus-level type
/// error a `tscOnly` baseline has to catch.
fn private_corpus_snapshot(
    directory: &TempDir,
    corpus_root: &Path,
    with_type_error: bool,
) -> PathBuf {
    let mut snapshot = localized_snapshot_value(corpus_root);
    if with_type_error {
        let module_id = "zzz-broken-module";
        let statement_id = "zzz-broken-statement";
        let nodes = snapshot["nodes"].as_array_mut().unwrap();
        nodes.push(json!({
            "id": module_id,
            "kind": "Module",
            "parentId": null,
            "childIndex": null,
            "payload": corpus_root.join("src/zzz-broken.ts").to_string_lossy(),
        }));
        nodes.push(json!({
            "id": statement_id,
            "kind": "FirstStatement",
            "parentId": module_id,
            "childIndex": 0,
            "payload": "export const broken: number = \"not a number\";",
        }));
        nodes.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    }
    let path = directory.path().join("private-snapshot.json");
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    path
}

/// Spawns the daemon against a private corpus, optionally under an operator
/// validation manifest. Returns the child with stdout/stderr piped; the caller
/// decides whether it expects a readiness line or a refusal.
fn spawn_gated_service(
    directory: &TempDir,
    token: &str,
    corpus_root: &Path,
    snapshot: &Path,
    audit: &Path,
    manifest: Option<&Path>,
) -> Child {
    let worker = bridge_worker();
    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"));
    command.args([
        "serve",
        "--db",
        directory.path().join("kernel.redb").to_str().unwrap(),
        "--snapshot",
        snapshot.to_str().unwrap(),
        "--bridge-worker",
        worker.to_str().unwrap(),
        "--source-root",
        corpus_root.join("src").to_str().unwrap(),
        "--corpus-root",
        corpus_root.to_str().unwrap(),
        "--socket-token",
        token,
        "--audit",
        audit.to_str().unwrap(),
    ]);
    if let Some(manifest) = manifest {
        command.args(["--validation-manifest", manifest.to_str().unwrap()]);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

/// Reads the readiness line, or — when the daemon refused before binding —
/// returns its exit status plus captured stderr.
fn await_readiness(mut child: Child) -> Result<RunningService, (i32, String)> {
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.trim().is_empty() {
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        let status = child.wait().unwrap();
        return Err((status.code().unwrap_or(-1), stderr));
    }
    let ready: Value = serde_json::from_str(&line).unwrap();
    let socket_path = PathBuf::from(ready["socketPath"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(socket_path.exists(), "service socket was not created");
    Ok(RunningService {
        child,
        socket_path,
        epoch: ready["serviceEpoch"].as_str().unwrap().parse().unwrap(),
        readiness: ready,
    })
}

/// The single start event a served session appends.
fn start_audit_event(audit: &Path) -> Value {
    let contents = fs::read_to_string(audit).unwrap_or_default();
    let line = contents
        .lines()
        .find(|line| line.contains("service_started") || line.contains("service_recovered"))
        .unwrap_or_else(|| panic!("no start event in audit log:\n{contents}"));
    serde_json::from_str::<Value>(line).unwrap()["event"].clone()
}

fn hello(service: &RunningService, request_id: &str) -> Value {
    let response = request(
        service,
        request_id,
        "client:seed-green",
        None,
        json!({"type":"hello"}),
    );
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

/// A behavioral manifest whose fixture PASSES against the seed corpus: the
/// daemon serves, and the same manifest digest appears on all three identity
/// surfaces (readiness line, start audit event, `hello`).
#[test]
fn seed_green_daemon_serves_and_reports_digest() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "seed-green-serves-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("green daemon refused to serve ({code}): {stderr}"));

    let digest = service.readiness["validationManifestDigest"]
        .as_str()
        .unwrap_or_else(|| panic!("readiness carries no digest: {}", service.readiness))
        .to_owned();
    assert_eq!(service.readiness["validationMode"], "behavioral");
    assert_eq!(digest.len(), 64, "{digest}");
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));

    let ready = hello(&service, "request:hello:seed-green");
    assert_eq!(ready["type"], "ready", "{ready}");
    assert_eq!(ready["validationMode"], "behavioral", "{ready}");
    assert_eq!(ready["validationManifestDigest"], json!(digest), "{ready}");

    let event = start_audit_event(&audit);
    assert_eq!(event["kind"], "service_started", "{event}");
    assert_eq!(event["validationMode"], "behavioral", "{event}");
    assert_eq!(event["validationManifestDigest"], json!(digest), "{event}");
}

/// The same corpus with a fixture that asserts a FALSE property: the daemon
/// exits non-zero before any readiness line, prints bounded diagnostics, and
/// — critically — audits NOTHING. A start event would assert a session that
/// never served.
///
/// This is also the first REAL-WIRE proof that the seven-key behavioral
/// validation profile reaches the worker (carried over from Task 6, where only
/// its serialization was asserted). The refusal is only reachable if the
/// fixture list crossed the wire and vitest actually ran it — a profile that
/// arrived as `tscOnly`, or behavioral-without-fixtures, would type-check the
/// corpus, come back green, and this daemon would serve.
#[test]
fn seed_red_daemon_refuses_to_serve() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", RED_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let (code, stderr) = await_readiness(spawn_gated_service(
        &directory,
        "seed-red-refuses-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .err()
    .unwrap_or_else(|| panic!("a red baseline must refuse to serve"));

    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("seed-green baseline is not green"), "{stderr}");
    assert!(stderr.contains("baseline-pin.test.ts"), "{stderr}");
    assert!(stderr.contains("SEED_BASELINE_IS_RED"), "{stderr}");
    let printed = stderr
        .lines()
        .filter(|line| line.starts_with("  "))
        .count();
    assert!(printed <= 9, "diagnostics must stay bounded: {stderr}");

    // Absence, not just a nonzero exit: no audit EVENT of any kind.
    let audited = fs::read_to_string(&audit).unwrap_or_default();
    assert!(
        audited.trim().is_empty(),
        "a refusing daemon must audit nothing, got:\n{audited}"
    );
}

/// The no-manifest default: no baseline runs, the readiness line OMITS the
/// digest key entirely, and `hello` reports an explicit `null`.
#[test]
fn tsc_only_daemon_reports_null_digest() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "tsc-only-null-digest-token",
        &corpus,
        &snapshot,
        &audit,
        None,
    ))
    .unwrap_or_else(|(code, stderr)| panic!("the default daemon must serve ({code}): {stderr}"));

    assert_eq!(service.readiness["validationMode"], "tscOnly");
    assert!(
        service.readiness.get("validationManifestDigest").is_none(),
        "the no-manifest readiness line must omit the digest key: {}",
        service.readiness
    );

    let ready = hello(&service, "request:hello:tsc-only");
    assert_eq!(ready["validationMode"], "tscOnly", "{ready}");
    assert_eq!(
        ready["validationManifestDigest"],
        Value::Null,
        "the wire digest is nullable, never absent: {ready}"
    );

    let event = start_audit_event(&audit);
    assert_eq!(event["validationMode"], "tscOnly", "{event}");
    assert!(
        event.get("validationManifestDigest").is_none(),
        "{event}"
    );
}

/// Review Major 8: the gate is not behavioral-only. A `tscOnly` MANIFEST is
/// still an operator statement about validation, so it gets a tsc-only
/// baseline (no fixtures) — and a corpus that does not type-check refuses to
/// serve just as a red behavioral one does.
#[test]
fn seed_tsc_only_manifest_daemon_gets_tsc_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let manifest = write_validation_manifest(&directory, "tscOnly", Vec::new());
    let snapshot = private_corpus_snapshot(&directory, &corpus, true);
    let audit = directory.path().join("audit.jsonl");

    let (code, stderr) = await_readiness(spawn_gated_service(
        &directory,
        "seed-tsc-only-manifest-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .err()
    .unwrap_or_else(|| panic!("a tscOnly manifest must still gate on a red baseline"));

    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("seed-green baseline is not green"), "{stderr}");
    assert!(stderr.contains("zzz-broken.ts"), "{stderr}");
    assert!(
        fs::read_to_string(&audit).unwrap_or_default().trim().is_empty(),
        "a refusing daemon must audit nothing"
    );
}

/// Fail-closed in the OPERATIONAL direction too: when the baseline cannot be
/// established at all (here, an unspawnable bridge worker), the daemon refuses
/// rather than serving a corpus it never verified. Without a manifest the same
/// broken worker is a lazy, per-request failure — the gate is what turns it
/// into a startup refusal.
#[test]
fn seed_green_baseline_operational_failure_is_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");
    let missing_worker = directory.path().join("no-such-worker.js");

    let mut command = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"));
    command
        .args([
            "serve",
            "--db",
            directory.path().join("kernel.redb").to_str().unwrap(),
            "--snapshot",
            snapshot.to_str().unwrap(),
            "--bridge-worker",
            missing_worker.to_str().unwrap(),
            "--source-root",
            corpus.join("src").to_str().unwrap(),
            "--corpus-root",
            corpus.to_str().unwrap(),
            "--socket-token",
            "seed-green-operational-token",
            "--audit",
            audit.to_str().unwrap(),
            "--validation-manifest",
            manifest.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (code, stderr) = await_readiness(command.spawn().unwrap())
        .err()
        .unwrap_or_else(|| panic!("an unestablishable baseline must refuse to serve"));

    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("seed-green baseline could not be established"),
        "{stderr}"
    );
    assert!(
        fs::read_to_string(&audit).unwrap_or_default().trim().is_empty(),
        "a refusing daemon must audit nothing"
    );
}

/// Crash-then-restart helper for the recovery-buffering gates: spawns a daemon
/// with a journal failpoint armed, sends one mutating request, and asserts the
/// daemon died at the boundary leaving an unresolved journal entry behind.
#[cfg(feature = "coordination-test-api")]
fn crash_pending_request(
    directory: &TempDir,
    corpus: &Path,
    snapshot: &Path,
    audit: &Path,
    token: &str,
) {
    let worker = bridge_worker();
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
            corpus.join("src").to_str().unwrap(),
            "--corpus-root",
            corpus.to_str().unwrap(),
            "--socket-token",
            token,
            "--audit",
            audit.to_str().unwrap(),
            "--test-failpoint",
            "after_pending",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(!line.trim().is_empty(), "failpoint daemon never became ready");
    let ready: Value = serde_json::from_str(&line).unwrap();
    let socket = PathBuf::from(ready["socketPath"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = UnixStream::connect(&socket).unwrap();
    stream
        .write_all(&frame(&json!({
            "protocolVersion": 1,
            "requestId": "recovery:begin",
            "clientId": "client:recovery",
            "deadlineMs": "120000",
            "idempotencyKey": "recovery:begin",
            "action": {"type":"begin_change_set","reasoning":"crash before the gate"},
        })))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    assert!(response.is_empty(), "crash boundary returned a response");
    assert!(
        !child.wait().unwrap().success(),
        "failpoint did not terminate the daemon"
    );
}

/// Review finding 1. Recovery runs INSIDE `open`, before the gate — it must,
/// because the gate has to judge the post-recovery graph. Its audit events are
/// therefore buffered: a RECOVERING daemon that then fails the gate must leave
/// the audit log exactly as it found it, `request_recovered` included.
#[cfg(feature = "coordination-test-api")]
#[test]
fn seed_red_recovering_daemon_audits_nothing_including_recovery_events() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");
    crash_pending_request(
        &directory,
        &corpus,
        &snapshot,
        &audit,
        "seed-red-recovery-crash",
    );
    let before = fs::read_to_string(&audit).unwrap();
    assert!(
        before.contains("service_started"),
        "the crashed run should have audited its own start: {before}"
    );
    assert!(
        !before.contains("request_recovered"),
        "nothing has recovered yet: {before}"
    );

    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", RED_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let (code, stderr) = await_readiness(spawn_gated_service(
        &directory,
        "seed-red-recovery-refuses",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .err()
    .unwrap_or_else(|| panic!("a red recovering daemon must refuse to serve"));

    assert_eq!(code, 2, "{stderr}");
    let after = fs::read_to_string(&audit).unwrap();
    assert_eq!(
        after, before,
        "a refusing daemon must append NOTHING — recovery events included"
    );
}

/// The other half of the same fix: buffering must not change what a HEALTHY
/// recovering daemon writes. The recovery events still land, still before the
/// start event, in the order they always did.
#[cfg(feature = "coordination-test-api")]
#[test]
fn healthy_recovering_daemon_keeps_its_recovery_then_start_audit_order() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");
    crash_pending_request(
        &directory,
        &corpus,
        &snapshot,
        &audit,
        "seed-green-recovery-crash",
    );
    let before_lines = fs::read_to_string(&audit).unwrap().lines().count();

    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let service = await_readiness(spawn_gated_service(
        &directory,
        "seed-green-recovery-serves",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("green recovering daemon refused ({code}): {stderr}"));
    assert_eq!(service.readiness["recovered"], true, "{}", service.readiness);

    let contents = fs::read_to_string(&audit).unwrap();
    let kinds: Vec<&str> = contents
        .lines()
        .skip(before_lines)
        .map(|line| {
            if line.contains("request_recovered") {
                "request_recovered"
            } else if line.contains("service_recovered") {
                "service_recovered"
            } else {
                "other"
            }
        })
        .collect();
    assert!(
        kinds.contains(&"request_recovered"),
        "the pending request must still be audited as recovered: {contents}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"service_recovered"),
        "the start event must remain LAST, after every recovery event: {contents}"
    );
    assert!(
        !kinds.contains(&"other"),
        "buffering must not introduce or reorder events: {contents}"
    );
}

// ---------------------------------------------------------------------------
// B-2 Task 10 — registered-fixture reader.
//
// The reader's whole claim is "manifest-pinned content only". These tests
// exercise that claim from the outside: what a behavioral daemon lists, that a
// chunked walk reassembles the exact registered bytes, that a tsc-only daemon
// offers nothing to read, and that content edited AFTER startup fails the read
// rather than being served under its registered digest.

/// Unwraps a response to whichever of `result`/`error` it carried, so a test
/// can assert on either without re-deriving the envelope shape.
fn fixture_reader_payload(response: Value) -> Value {
    if response["ok"] == json!(true) {
        response["result"].clone()
    } else {
        response["error"].clone()
    }
}

fn read_fixture_chunk(
    service: &RunningService,
    request_id: &str,
    fixture_id: &str,
    offset: u64,
    length: u32,
) -> Value {
    fixture_reader_payload(request(
        service,
        request_id,
        "client:fixture-reader",
        None,
        json!({
            "type": "read_validation_fixture",
            "fixtureId": fixture_id,
            "offset": offset.to_string(),
            "length": length,
        }),
    ))
}

fn list_fixtures(service: &RunningService, request_id: &str) -> Value {
    fixture_reader_payload(request(
        service,
        request_id,
        "client:fixture-reader",
        None,
        json!({ "type": "list_validation_fixtures" }),
    ))
}

/// Minimal standard-base64 decoder, independent of the daemon's encoder so the
/// test does not confirm an encoder bug by reusing it.
fn decode_base64(value: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    for byte in value.bytes().filter(|byte| *byte != b'=') {
        let index = ALPHABET
            .iter()
            .position(|candidate| *candidate == byte)
            .unwrap_or_else(|| panic!("{value} is not base64")) as u32;
        accumulator = (accumulator << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    out
}

#[test]
fn fixture_reader_lists_and_reassembles_the_registered_fixture() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let registered_sha = fixture["sha256"].as_str().unwrap().to_owned();
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "fixture-reader-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("green daemon refused to serve ({code}): {stderr}"));

    let listing = list_fixtures(&service, "request:list-fixtures");
    assert_eq!(listing["type"], "validation_fixtures", "{listing}");
    assert_eq!(listing["validationMode"], "behavioral", "{listing}");
    assert_eq!(
        listing["validationManifestDigest"], service.readiness["validationManifestDigest"],
        "the listing must be pinned to the daemon's own manifest: {listing}"
    );
    let fixtures = listing["fixtures"].as_array().unwrap();
    assert_eq!(fixtures.len(), 1, "{listing}");
    assert_eq!(fixtures[0]["fixtureId"], json!(registered_sha), "{listing}");
    assert_eq!(fixtures[0]["path"], "tests/baseline-pin.test.ts", "{listing}");
    assert_eq!(
        fixtures[0]["bytes"],
        json!(GREEN_FIXTURE.len().to_string()),
        "{listing}"
    );

    // A chunked walk at a length that does not divide the file must reassemble
    // the registered bytes exactly, and terminate on `eof` rather than on a
    // guess about the size.
    let mut assembled: Vec<u8> = Vec::new();
    let mut offset = 0u64;
    for step in 0..64 {
        let chunk = read_fixture_chunk(
            &service,
            &format!("request:chunk:{step}"),
            &registered_sha,
            offset,
            7,
        );
        assert_eq!(chunk["type"], "validation_fixture_chunk", "{chunk}");
        assert_eq!(chunk["fixtureId"], json!(registered_sha), "{chunk}");
        assert_eq!(chunk["offset"], json!(offset.to_string()), "{chunk}");
        let bytes = decode_base64(chunk["contentBase64"].as_str().unwrap());
        assembled.extend_from_slice(&bytes);
        offset += bytes.len() as u64;
        if chunk["eof"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(
        String::from_utf8(assembled).unwrap(),
        GREEN_FIXTURE,
        "the chunked walk must reassemble the registered fixture byte for byte"
    );

    // A read at EOF is the terminal empty chunk, not an error.
    let past_eof = read_fixture_chunk(
        &service,
        "request:chunk:past-eof",
        &registered_sha,
        GREEN_FIXTURE.len() as u64 + 4_096,
        64,
    );
    assert_eq!(past_eof["contentBase64"], "", "{past_eof}");
    assert_eq!(past_eof["eof"], json!(true), "{past_eof}");
}

/// A tsc-only daemon registers no fixtures: the listing states its emptiness
/// (and its mode) rather than failing, and there is nothing to read.
#[test]
fn fixture_reader_offers_nothing_under_tsc_only() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let manifest = write_validation_manifest(&directory, "tscOnly", Vec::new());
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "fixture-reader-tsc-only-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("tsc-only daemon refused to serve ({code}): {stderr}"));

    let listing = list_fixtures(&service, "request:list-fixtures:tsc-only");
    assert_eq!(listing["type"], "validation_fixtures", "{listing}");
    assert_eq!(listing["validationMode"], "tscOnly", "{listing}");
    assert_eq!(listing["fixtures"], json!([]), "{listing}");

    let response = read_fixture_chunk(
        &service,
        "request:chunk:tsc-only",
        &"a".repeat(64),
        0,
        64,
    );
    assert_eq!(response["code"], "request_failed", "{response}");
    assert_eq!(response["retryable"], json!(false), "{response}");
}

/// The digest pin: a fixture edited after the daemon bound is refused, and the
/// refusal names the fixture's corpus-relative path rather than its absolute
/// location on disk (the B-1 fail-closed projection discipline).
#[test]
fn fixture_reader_refuses_content_that_drifted_after_startup() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let registered_sha = fixture["sha256"].as_str().unwrap().to_owned();
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "fixture-reader-drift-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("green daemon refused to serve ({code}): {stderr}"));

    // Readable before the edit.
    let before = read_fixture_chunk(&service, "request:chunk:before", &registered_sha, 0, 64);
    assert_eq!(before["type"], "validation_fixture_chunk", "{before}");

    fs::write(
        corpus.join("tests/baseline-pin.test.ts"),
        format!("{GREEN_FIXTURE}// edited after the daemon bound\n"),
    )
    .unwrap();

    let after = read_fixture_chunk(&service, "request:chunk:after", &registered_sha, 0, 64);
    assert_eq!(after["code"], "request_failed", "{after}");
    let message = after["message"].as_str().unwrap();
    assert!(
        message.contains("tests/baseline-pin.test.ts"),
        "the refusal must name the fixture: {message}"
    );
    assert!(
        !message.contains(corpus.to_str().unwrap()),
        "the refusal must not leak the absolute corpus path: {message}"
    );

    // The listing is served from the same verified identity, so it fails too —
    // a drifted fixture is not silently listed at its stale size.
    let listing = list_fixtures(&service, "request:list-fixtures:drift");
    assert_eq!(listing["code"], "request_failed", "{listing}");
}

/// An unregistered id is refused even when it is a well-formed digest.
#[test]
fn fixture_reader_refuses_an_unregistered_fixture_id() {
    let directory = tempfile::tempdir().unwrap();
    let corpus = private_medium_corpus(&directory);
    let fixture = write_corpus_fixture(&corpus, "baseline-pin.test.ts", GREEN_FIXTURE);
    let manifest = write_validation_manifest(&directory, "behavioral", vec![fixture]);
    let snapshot = private_corpus_snapshot(&directory, &corpus, false);
    let audit = directory.path().join("audit.jsonl");

    let service = await_readiness(spawn_gated_service(
        &directory,
        "fixture-reader-unknown-token",
        &corpus,
        &snapshot,
        &audit,
        Some(&manifest),
    ))
    .unwrap_or_else(|(code, stderr)| panic!("green daemon refused to serve ({code}): {stderr}"));

    let response = read_fixture_chunk(
        &service,
        "request:chunk:unknown",
        &"c".repeat(64),
        0,
        64,
    );
    assert_eq!(response["code"], "request_failed", "{response}");

    // A malformed id never reaches the lookup at all: the wire validator
    // refuses it as a malformed request, which is a different (earlier) verdict
    // than "well-formed but not registered" above.
    let malformed = read_fixture_chunk(&service, "request:chunk:malformed", "not-a-digest", 0, 64);
    assert_eq!(malformed["code"], "invalid_request", "{malformed}");
}
