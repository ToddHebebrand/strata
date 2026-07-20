pub use strata_kernel::{
    GraphChange, GraphDelta, GraphGeneration, GraphSnapshot, NodeRecord, ReferenceRecord,
    SCHEMA_VERSION,
};

// Path-include the two Task 6 seams directly so later private bridge consumers do not
// become part of this standalone protocol/process harness's synthetic crate root.
#[path = "../src/bridge/observer.rs"]
#[allow(dead_code)]
mod observer;
#[path = "../src/bridge/process.rs"]
#[allow(dead_code)]
mod process;
#[path = "../src/bridge/protocol.rs"]
#[allow(dead_code)]
mod protocol;

use process::{NodeBridgeClient, NodeBridgeConfig};
use protocol::{
    BridgeRequest, BridgeResponse, ValidationProfile, WireU64, WorkerSelfMetrics,
    parse_bridge_request, parse_bridge_response, serialize_bridge_request,
    serialize_bridge_response,
};
use serde_json::{Value, json};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tempfile::tempdir;
use wait_timeout::ChildExt;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const BLOCKED_STDIN_PID_PATH: &str = "STRATA_BLOCKED_STDIN_PID_PATH";

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel-bridge/tests/fixtures/protocol-v1")
        .join(name)
}

fn process_fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/bridge")
        .join(name)
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    fs::read(fixture_path(name)).unwrap()
}

fn fixture_value(name: &str) -> Value {
    serde_json::from_slice(&fixture_bytes(name)).unwrap()
}

fn parse_request_fixture(name: &str) -> BridgeRequest {
    parse_bridge_request(&fixture_bytes(name)).unwrap()
}

fn parse_response_fixture(response_name: &str, request_name: &str) -> BridgeResponse {
    let request = parse_request_fixture(request_name);
    parse_bridge_response(
        &fixture_bytes(response_name),
        &request,
        MAX_DIAGNOSTIC_BYTES,
    )
    .unwrap()
}

fn assert_request_value_rejected(value: Value) {
    let encoded = serde_json::to_vec(&value).unwrap();
    assert!(
        parse_bridge_request(&encoded).is_err(),
        "accepted invalid request: {value}"
    );
}

fn assert_response_value_rejected(value: Value, request_name: &str) {
    let encoded = serde_json::to_vec(&value).unwrap();
    let request = parse_request_fixture(request_name);
    assert!(
        parse_bridge_response(&encoded, &request, MAX_DIAGNOSTIC_BYTES).is_err(),
        "accepted invalid response: {value}"
    );
}

fn default_config(script: &str) -> NodeBridgeConfig {
    NodeBridgeConfig {
        executable: PathBuf::from("node"),
        arguments: vec![OsString::from(process_fixture_path(script))],
        deadline: Duration::from_secs(5),
        max_request_bytes: MAX_REQUEST_BYTES,
        max_response_bytes: MAX_RESPONSE_BYTES,
        max_stderr_bytes: MAX_STDERR_BYTES,
        max_diagnostics_bytes: MAX_DIAGNOSTIC_BYTES,
        validation_profile: ValidationProfile::tsc_only("/project/src", "/project", true),
        collect_metrics: false,
    }
}

#[test]
fn wire_u64_round_trips_the_full_unsigned_range_as_canonical_decimal_strings() {
    let value: WireU64 = serde_json::from_str("\"18446744073709551615\"").unwrap();

    assert_eq!(value.get(), u64::MAX);
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        "\"18446744073709551615\""
    );
}

#[test]
fn wire_u64_rejects_numbers_and_noncanonical_decimal_strings() {
    for invalid in [
        "0",
        "1",
        "-1",
        "\"\"",
        "\"00\"",
        "\"01\"",
        "\"+1\"",
        "\" 1\"",
        "\"18446744073709551616\"",
    ] {
        assert!(
            serde_json::from_str::<WireU64>(invalid).is_err(),
            "accepted invalid WireU64 {invalid}"
        );
    }
}

#[test]
fn shared_protocol_v1_golden_messages_round_trip_without_schema_drift() {
    for request_name in ["analyze-request.json", "candidate-request.json"] {
        let request = parse_request_fixture(request_name);
        let encoded = serialize_bridge_request(&request).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded).unwrap(),
            fixture_value(request_name)
        );
    }

    for (response_name, request_name) in [
        ("analyze-response.json", "analyze-request.json"),
        ("analyze-response-add-parameter.json", "analyze-request.json"),
        ("candidate-response.json", "candidate-request.json"),
        ("error-response.json", "analyze-request.json"),
    ] {
        let response = parse_response_fixture(response_name, request_name);
        let encoded = serialize_bridge_response(&response).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded).unwrap(),
            fixture_value(response_name)
        );
    }
}

#[test]
fn request_schema_rejects_unknown_fields_versions_kinds_and_intent_variants() {
    let mut cases = Vec::new();

    let mut root = fixture_value("analyze-request.json");
    root["unexpected"] = json!(true);
    cases.push(root);

    let mut binding = fixture_value("analyze-request.json");
    binding["binding"]["unexpected"] = json!(true);
    cases.push(binding);

    let mut node = fixture_value("analyze-request.json");
    node["snapshot"]["nodes"][0]["unexpected"] = json!(true);
    cases.push(node);

    let mut parameters = fixture_value("analyze-request.json");
    parameters["intent"]["parameters"]["unexpected"] = json!(true);
    cases.push(parameters);

    let mut version = fixture_value("analyze-request.json");
    version["protocolVersion"] = json!(2);
    cases.push(version);

    let mut kind = fixture_value("analyze-request.json");
    kind["kind"] = json!("unknownKind");
    cases.push(kind);

    let mut intent = fixture_value("analyze-request.json");
    intent["intent"]["parameters"]["type"] = json!("deleteNode");
    cases.push(intent);

    for case in cases {
        assert_request_value_rejected(case);
    }
}

#[test]
fn request_schema_rejects_numeric_generations_and_generation_mismatches() {
    for path in [
        &["binding", "serviceEpoch"][..],
        &["binding", "graphGeneration"][..],
        &["snapshot", "generation"][..],
        &["intent", "baseGeneration"][..],
    ] {
        let mut value = fixture_value("analyze-request.json");
        value
            .pointer_mut(&format!("/{}", path.join("/")))
            .unwrap()
            .clone_from(&json!(0));
        assert_request_value_rejected(value);
    }

    let mut snapshot_mismatch = fixture_value("analyze-request.json");
    snapshot_mismatch["snapshot"]["generation"] = json!("1");
    assert_request_value_rejected(snapshot_mismatch);

    let mut intent_mismatch = fixture_value("analyze-request.json");
    intent_mismatch["intent"]["baseGeneration"] = json!("1");
    assert_request_value_rejected(intent_mismatch);
}

#[test]
fn snapshot_validation_rejects_noncanonical_duplicate_dangling_and_unsafe_records() {
    let mut cases = Vec::new();

    let mut unsorted = fixture_value("analyze-request.json");
    unsorted["snapshot"]["nodes"]
        .as_array_mut()
        .unwrap()
        .reverse();
    cases.push(unsorted);

    let mut duplicate_node = fixture_value("analyze-request.json");
    duplicate_node["snapshot"]["nodes"][1]["id"] = json!("decl:greet");
    cases.push(duplicate_node);

    let mut dangling_parent = fixture_value("analyze-request.json");
    dangling_parent["snapshot"]["nodes"][0]["parentId"] = json!("missing:parent");
    cases.push(dangling_parent);

    let mut unsafe_child_index = fixture_value("analyze-request.json");
    unsafe_child_index["snapshot"]["nodes"][0]["childIndex"] = json!(9_007_199_254_740_992_u64);
    cases.push(unsafe_child_index);

    let mut negative_child_index = fixture_value("analyze-request.json");
    negative_child_index["snapshot"]["nodes"][0]["childIndex"] = json!(-1);
    cases.push(negative_child_index);

    let mut duplicate_reference = fixture_value("analyze-request.json");
    duplicate_reference["snapshot"]["references"] = json!([
        {"fromNodeId":"decl:greet","toNodeId":"module:main","kind":"symbol"},
        {"fromNodeId":"decl:greet","toNodeId":"module:main","kind":"symbol"}
    ]);
    cases.push(duplicate_reference);

    let mut dangling_reference = fixture_value("analyze-request.json");
    dangling_reference["snapshot"]["references"] = json!([
        {"fromNodeId":"decl:greet","toNodeId":"missing:target","kind":"symbol"}
    ]);
    cases.push(dangling_reference);

    for case in cases {
        assert_request_value_rejected(case);
    }
}

#[test]
fn schema_rejects_empty_identifiers_and_invalid_digest_or_fingerprint_shapes() {
    let mut request_cases = Vec::new();
    for pointer in [
        "/requestId",
        "/binding/graphDigest",
        "/snapshot/nodes/0/id",
        "/snapshot/nodes/0/kind",
        "/intent/intentId",
        "/intent/changeSetId",
        "/intent/parameters/declarationId",
    ] {
        let mut value = fixture_value("analyze-request.json");
        value.pointer_mut(pointer).unwrap().clone_from(&json!(""));
        request_cases.push(value);
    }
    for bad_digest in ["a", &"A".repeat(64), &"g".repeat(64)] {
        let mut value = fixture_value("analyze-request.json");
        value["binding"]["graphDigest"] = json!(bad_digest);
        request_cases.push(value);
    }
    for case in request_cases {
        assert_request_value_rejected(case);
    }

    for bad_fingerprint in ["", "a", &"A".repeat(64), &"g".repeat(64)] {
        let mut value = fixture_value("candidate-request.json");
        value["scopeFingerprint"] = json!(bad_fingerprint);
        assert_request_value_rejected(value);
    }
}

#[test]
fn response_schema_rejects_unknown_fields_variants_and_oversized_diagnostics() {
    let mut unknown = fixture_value("analyze-response.json");
    unknown["result"]["facts"]["unexpected"] = json!(true);
    assert_response_value_rejected(unknown, "analyze-request.json");

    let mut variant = fixture_value("analyze-response.json");
    variant["result"]["facts"]["type"] = json!("unknownFacts");
    assert_response_value_rejected(variant, "analyze-request.json");

    let mut non_array_content = fixture_value("analyze-response-add-parameter.json");
    non_array_content["result"]["facts"]["contentDependencyDeclarationIds"] =
        json!("decl:helper");
    assert_response_value_rejected(non_array_content, "analyze-request.json");

    let mut unsorted_content = fixture_value("analyze-response-add-parameter.json");
    unsorted_content["result"]["facts"]["contentDependencyDeclarationIds"] =
        json!(["decl:z", "decl:a"]);
    assert_response_value_rejected(unsorted_content, "analyze-request.json");

    let mut error = fixture_value("error-response.json");
    error["error"]["diagnostics"][0]["message"] = json!("x".repeat(1024));
    let encoded = serde_json::to_vec(&error).unwrap();
    let request = parse_request_fixture("analyze-request.json");
    assert!(parse_bridge_response(&encoded, &request, 128).is_err());
}

#[test]
fn response_accepts_optional_worker_self_metrics_and_rejects_unknown_metrics_fields() {
    let baseline = parse_response_fixture("analyze-response.json", "analyze-request.json");
    assert!(baseline.metrics_ref().is_none());

    let mut with_metrics = fixture_value("analyze-response.json");
    with_metrics["metrics"] = json!({
        "totalNs": 5,
        "peakRssBytes": 2048,
        "hydrateNs": 3
    });
    let encoded = serde_json::to_vec(&with_metrics).unwrap();
    let request = parse_request_fixture("analyze-request.json");
    let response = parse_bridge_response(&encoded, &request, MAX_DIAGNOSTIC_BYTES).unwrap();
    assert_eq!(
        response.metrics_ref(),
        Some(&WorkerSelfMetrics {
            hydrate_ns: Some(3),
            analyze_ns: None,
            mutate_ns: None,
            validate_ns: None,
            export_ns: None,
            total_ns: 5,
            peak_rss_bytes: 2048,
        })
    );

    let mut with_bogus_metrics = fixture_value("analyze-response.json");
    with_bogus_metrics["metrics"] = json!({
        "totalNs": 5,
        "peakRssBytes": 2048,
        "bogus": 1
    });
    assert_response_value_rejected(with_bogus_metrics, "analyze-request.json");
}

#[test]
fn response_bindings_are_checked_before_success_payloads_are_exposed() {
    for (pointer, replacement) in [
        ("/requestId", json!("other-request")),
        ("/binding/serviceEpoch", json!("2")),
        ("/binding/graphGeneration", json!("1")),
        ("/binding/graphDigest", json!("f".repeat(64))),
    ] {
        let mut value = fixture_value("analyze-response.json");
        value.pointer_mut(pointer).unwrap().clone_from(&replacement);
        assert_response_value_rejected(value, "analyze-request.json");
    }

    for (pointer, replacement) in [
        ("/binding/attemptId", json!("other-attempt")),
        ("/binding/scopeFingerprint", json!("f".repeat(64))),
        ("/result/delta/baseGeneration", json!("1")),
    ] {
        let mut value = fixture_value("candidate-response.json");
        value.pointer_mut(pointer).unwrap().clone_from(&replacement);
        assert_response_value_rejected(value, "candidate-request.json");
    }
}

#[test]
fn process_runner_accepts_one_bound_response() {
    let request = parse_request_fixture("analyze-request.json");
    let response = NodeBridgeClient::new(default_config("success.mjs"))
        .run(&request)
        .unwrap();

    assert!(matches!(response, BridgeResponse::AnalyzeError(_)));
}

#[test]
fn process_runner_rejects_spawn_failure_nonzero_exit_and_truncated_json() {
    let request = parse_request_fixture("analyze-request.json");

    let mut spawn_config = default_config("success.mjs");
    spawn_config.executable = PathBuf::from("definitely-not-a-real-strata-node-executable");
    let spawn_error = NodeBridgeClient::new(spawn_config)
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(spawn_error.contains("spawn"), "{spawn_error}");

    let nonzero_error = NodeBridgeClient::new(default_config("nonzero.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(
        nonzero_error.contains("status") && nonzero_error.contains("boom"),
        "{nonzero_error}"
    );

    let truncated_error = NodeBridgeClient::new(default_config("truncated.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(
        truncated_error.contains("JSON") || truncated_error.contains("response"),
        "{truncated_error}"
    );
}

#[test]
fn process_runner_kills_and_reaps_a_timed_out_child() {
    let request = parse_request_fixture("analyze-request.json");
    let directory = tempdir().unwrap();
    let pid_path = directory.path().join("child.pid");
    let mut config = default_config("timeout.mjs");
    config.arguments.push(pid_path.as_os_str().to_owned());
    config.deadline = Duration::from_secs(1);

    let error = NodeBridgeClient::new(config)
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("deadline") || error.contains("timeout"),
        "{error}"
    );

    let pid = fs::read_to_string(pid_path).unwrap();
    let output = Command::new("kill")
        .args(["-0", pid.trim()])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "timed-out child {pid} still exists or is unreaped"
    );
}

#[test]
fn process_runner_rejects_extra_frames_and_bounded_stream_overflow() {
    let request = parse_request_fixture("analyze-request.json");

    let extra = NodeBridgeClient::new(default_config("extra-frame.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(
        extra.contains("frame") || extra.contains("trailing"),
        "{extra}"
    );

    let stdout = NodeBridgeClient::new(default_config("oversized-stdout.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(
        stdout.contains("stdout") || stdout.contains("response"),
        "{stdout}"
    );

    let stderr = NodeBridgeClient::new(default_config("oversized-stderr.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(stderr.contains("stderr"), "{stderr}");
}

#[test]
fn process_runner_rejects_an_oversized_request_before_execution() {
    let request = parse_request_fixture("analyze-request.json");
    let mut config = default_config("success.mjs");
    config.max_request_bytes = 1;

    let error = NodeBridgeClient::new(config)
        .run(&request)
        .unwrap_err()
        .to_string();
    assert!(error.contains("request"), "{error}");
}

#[test]
fn process_runner_rejects_an_unrepresentable_deadline_before_spawning() {
    let request = parse_request_fixture("analyze-request.json");
    let directory = tempdir().unwrap();
    let marker_path = directory.path().join("spawned.marker");
    let mut config = default_config("mark-started.mjs");
    config.arguments.push(marker_path.as_os_str().to_owned());
    config.deadline = Duration::MAX;

    let error = NodeBridgeClient::new(config)
        .run(&request)
        .unwrap_err()
        .to_string();

    assert!(error.contains("deadline"), "{error}");
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !marker_path.exists(),
        "bridge child was spawned before deadline validation"
    );
}

#[test]
fn process_runner_drains_stdout_before_the_child_reads_a_large_stdin_request() {
    let mut value = fixture_value("analyze-request.json");
    value["snapshot"]["nodes"][0]["payload"] = json!("x".repeat(1024 * 1024));
    let request = parse_bridge_request(&serde_json::to_vec(&value).unwrap()).unwrap();
    let mut config = default_config("stdout-before-stdin.mjs");
    config.deadline = Duration::from_secs(10);

    let response = NodeBridgeClient::new(config).run(&request).unwrap();
    assert!(matches!(response, BridgeResponse::AnalyzeError(_)));
}

#[test]
fn process_runner_deadline_includes_a_blocked_stdin_write() {
    if let Some(pid_path) = env::var_os(BLOCKED_STDIN_PID_PATH) {
        let mut value = fixture_value("analyze-request.json");
        value["snapshot"]["nodes"][0]["payload"] = json!("x".repeat(2 * 1024 * 1024));
        let request = parse_bridge_request(&serde_json::to_vec(&value).unwrap()).unwrap();
        let mut config = default_config("never-read-stdin.mjs");
        config.arguments.push(pid_path.clone());
        config.deadline = Duration::from_secs(1);

        let error = NodeBridgeClient::new(config)
            .run(&request)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("deadline") || error.contains("timeout"),
            "{error}"
        );

        let pid = fs::read_to_string(pid_path).unwrap();
        let output = Command::new("kill")
            .args(["-0", pid.trim()])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "timed-out child {pid} still exists or is unreaped"
        );
        return;
    }

    let directory = tempdir().unwrap();
    let pid_path = directory.path().join("blocked-child.pid");
    let test_executable = env::current_exe().unwrap();
    let mut helper = Command::new(test_executable)
        .args([
            "--exact",
            "process_runner_deadline_includes_a_blocked_stdin_write",
            "--nocapture",
        ])
        .env(BLOCKED_STDIN_PID_PATH, &pid_path)
        .spawn()
        .unwrap();

    match helper.wait_timeout(Duration::from_secs(5)).unwrap() {
        Some(status) => assert!(status.success(), "blocked-stdin helper failed: {status}"),
        None => {
            helper.kill().unwrap();
            helper.wait().unwrap();
            if let Ok(pid) = fs::read_to_string(&pid_path) {
                let _ = Command::new("kill").args(["-KILL", pid.trim()]).status();
            }
            panic!("bridge runner exceeded the test harness deadline while writing stdin");
        }
    }
}

#[test]
fn process_runner_reports_nonzero_exit_when_child_closes_an_active_writer() {
    let mut value = fixture_value("analyze-request.json");
    value["snapshot"]["nodes"][0]["payload"] = json!("x".repeat(2 * 1024 * 1024));
    let request = parse_bridge_request(&serde_json::to_vec(&value).unwrap()).unwrap();

    let error = NodeBridgeClient::new(default_config("early-nonzero.mjs"))
        .run(&request)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("status") && error.contains("early-nonzero"),
        "{error}"
    );
}

#[test]
fn process_runner_cleans_up_after_an_early_stdin_write_error() {
    let mut value = fixture_value("analyze-request.json");
    value["snapshot"]["nodes"][0]["payload"] = json!("x".repeat(2 * 1024 * 1024));
    let request = parse_bridge_request(&serde_json::to_vec(&value).unwrap()).unwrap();
    let directory = tempdir().unwrap();
    let pid_path = directory.path().join("closed-stdin-child.pid");
    let mut config = default_config("close-stdin.mjs");
    config.arguments.push(pid_path.as_os_str().to_owned());

    let started = Instant::now();
    let error = NodeBridgeClient::new(config)
        .run(&request)
        .unwrap_err()
        .to_string();

    assert!(error.contains("write Node bridge request"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "early write error waited for the process deadline"
    );
    let pid = fs::read_to_string(pid_path).unwrap();
    let output = Command::new("kill")
        .args(["-0", pid.trim()])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "write-failed child {pid} still exists or is unreaped"
    );
}

#[test]
fn process_runner_wait_uses_only_the_remaining_absolute_deadline() {
    let mut value = fixture_value("analyze-request.json");
    value["snapshot"]["nodes"][0]["payload"] = json!("x".repeat(2 * 1024 * 1024));
    let request = parse_bridge_request(&serde_json::to_vec(&value).unwrap()).unwrap();
    let mut config = default_config("delayed-read-then-hang.mjs");
    config.deadline = Duration::from_millis(1_200);

    let started = Instant::now();
    let error = NodeBridgeClient::new(config)
        .run(&request)
        .unwrap_err()
        .to_string();
    let elapsed = started.elapsed();

    assert!(error.contains("deadline"), "{error}");
    assert!(
        elapsed < Duration::from_millis(1_700),
        "child wait restarted the deadline after stdin completed: {elapsed:?}"
    );
}
