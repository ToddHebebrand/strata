use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn default_build_service_has_no_test_authority_surface() {
    let output = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    for forbidden in [
        "failpoint",
        "fixture",
        "publish-raw",
        "claim-token",
        "fence",
        "test-hook",
    ] {
        assert!(
            !help.contains(forbidden),
            "default service help exposed {forbidden}: {help}"
        );
    }

    let rejected = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args([
            "validate-socket",
            "--socket",
            "/tmp/strata-lc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
            "--test-failpoint",
            "after_pending",
        ])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(
        String::from_utf8_lossy(&rejected.stderr).contains("unknown option"),
        "{}",
        String::from_utf8_lossy(&rejected.stderr)
    );
}

#[test]
fn actor_containment_malformed_and_bridge_failures_publish_nothing() {
    let directory = tempdir().unwrap();
    let snapshot = directory.path().join("snapshot.json");
    fs::write(
        &snapshot,
        include_bytes!("fixtures/examples-medium.snapshot.json"),
    )
    .unwrap();
    let failing_worker = directory.path().join("failing-worker.mjs");
    fs::write(&failing_worker, "process.stdin.resume(); process.stdin.on('end',()=>{process.stderr.write('bridge failed');process.exit(1);});").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_strata-kernel-service"))
        .args([
            "serve",
            "--db",
            directory.path().join("kernel.redb").to_str().unwrap(),
            "--snapshot",
            snapshot.to_str().unwrap(),
            "--bridge-worker",
            failing_worker.to_str().unwrap(),
            "--source-root",
            repo_root().join("examples/medium/src").to_str().unwrap(),
            "--corpus-root",
            repo_root().join("examples/medium").to_str().unwrap(),
            "--socket-token",
            "containment",
            "--audit",
            directory.path().join("audit.jsonl").to_str().unwrap(),
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
        let mut error = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut error)
            .unwrap();
        panic!("{error}");
    }
    let ready: Value = serde_json::from_str(&line).unwrap();
    let socket = PathBuf::from(ready["socketPath"].as_str().unwrap());
    let send = |request: Value| -> Value {
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        let mut stream = UnixStream::connect(&socket).unwrap();
        stream.write_all(&bytes).unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        serde_json::from_slice(&response[..response.len() - 1]).unwrap()
    };
    let base = |request_id: &str, client: &str, key: Option<&str>, action: Value| {
        let mut request = json!({"protocolVersion":1,"requestId":request_id,"clientId":client,"deadlineMs":"120000","action":action});
        if let Some(key) = key {
            request["idempotencyKey"] = json!(key);
        }
        request
    };
    let begin = send(base(
        "begin",
        "client:alpha",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"containment"}),
    ));
    let change = begin["result"]["changeSetId"].as_str().unwrap();
    for (id, action) in [
        (
            "cross-add",
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":"fabricated","newName":"Nope"}}),
        ),
        (
            "cross-cancel",
            json!({"type":"cancel_change_set","changeSetId":change}),
        ),
    ] {
        let response = send(base(id, "client:beta", Some(id), action));
        assert_eq!(response["ok"], false, "{response}");
    }
    assert_eq!(
        send(base(
            "fabricated-add",
            "client:alpha",
            Some("fabricated-add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":"fabricated","newName":"Nope"}})
        ))["ok"],
        true
    );
    let bridge_failure = send(base(
        "submit",
        "client:alpha",
        Some("submit"),
        json!({"type":"submit_change_set","changeSetId":change}),
    ));
    assert_eq!(bridge_failure["ok"], false);
    assert_eq!(
        send(base(
            "inspect",
            "client:alpha",
            None,
            json!({"type":"inspect_nodes","nodeIds":["fc98295bca9efc3e"]})
        ))["result"]["graphGeneration"],
        "0"
    );
    let events = send(base(
        "events",
        "client:alpha",
        None,
        json!({"type":"read_events","afterSequence":"0","limit":256}),
    ));
    assert!(
        events["result"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["state"] != "published")
    );

    let malformed = base(
        "malformed",
        "client:alpha",
        Some("malformed"),
        json!({"type":"add_intent","changeSetId":change,"intent":{"type":"add_parameter","functionId":"603b2ae524ee3c70","name":"x","typeText":"string","position":0,"value":"x","scope":["forbidden"]}}),
    );
    assert_eq!(send(malformed)["ok"], false);
    let cancelled = send(base(
        "cancel",
        "client:alpha",
        Some("cancel"),
        json!({"type":"cancel_change_set","changeSetId":change}),
    ));
    assert_eq!(cancelled["result"]["state"], "cancelled");
    let stale = send(base(
        "stale",
        "client:alpha",
        Some("stale"),
        json!({"type":"advance_change_set","changeSetId":change}),
    ));
    assert_eq!(stale["result"]["state"], "cancelled");
    child.kill().unwrap();
    let _ = child.wait();
}
