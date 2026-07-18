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
const MAX_RESPONSE_FRAME_BYTES: usize = 256 * 1024;

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
        assert!(status.success());
    }
    worker
}

fn snapshot(directory: &TempDir, large_payload: bool) -> PathBuf {
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
                    .is_some_and(|payload| payload.starts_with("/project/src/"))
        })
        .map(|node| node["id"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>();
    loop {
        let before = retained.len();
        for node in value["nodes"].as_array().unwrap() {
            if node["parentId"]
                .as_str()
                .is_some_and(|parent| retained.contains(parent))
            {
                retained.insert(node["id"].as_str().unwrap().to_owned());
            }
        }
        if retained.len() == before {
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
    for node in value["nodes"].as_array_mut().unwrap() {
        if node["kind"] == "Module" {
            let relative = node["payload"]
                .as_str()
                .unwrap()
                .strip_prefix("/project/")
                .unwrap();
            node["payload"] = json!(corpus.join(relative).to_string_lossy());
        }
    }
    if large_payload {
        value["nodes"].as_array_mut().unwrap().extend(
            large_node_ids().into_iter().enumerate().map(|(index, id)| {
                json!({
                    "id": id,
                    "kind": "Synthetic",
                    "parentId": null,
                    "childIndex": index as i64,
                    "payload": "x".repeat(4_096),
                })
            }),
        );
    }
    let path = directory.path().join("snapshot.json");
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}

fn large_node_ids() -> Vec<String> {
    (0..256)
        .map(|index| format!("large-node-{index:03}"))
        .collect()
}

fn start(directory: &TempDir, token: &str, worker: &Path, large_payload: bool) -> Service {
    let snapshot = snapshot(directory, large_payload);
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
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        panic!("service failed before readiness: {stderr}");
    }
    let ready: Value = serde_json::from_str(&line).unwrap();
    Service {
        child,
        socket: PathBuf::from(ready["socketPath"].as_str().unwrap()),
    }
}

fn message(
    request_id: &str,
    client: &str,
    key: Option<&str>,
    deadline_ms: u64,
    action: Value,
) -> Vec<u8> {
    let mut request = json!({
        "protocolVersion": 1,
        "requestId": request_id,
        "clientId": client,
        "deadlineMs": deadline_ms.to_string(),
        "action": action,
    });
    if let Some(key) = key {
        request["idempotencyKey"] = json!(key);
    }
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    bytes
}

fn send_raw(
    service: &Service,
    request_id: &str,
    client: &str,
    key: Option<&str>,
    deadline_ms: u64,
    action: Value,
) -> Vec<u8> {
    let mut stream = UnixStream::connect(&service.socket).unwrap();
    stream
        .write_all(&message(request_id, client, key, deadline_ms, action))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    response
}

fn send(
    service: &Service,
    request_id: &str,
    client: &str,
    key: Option<&str>,
    deadline_ms: u64,
    action: Value,
) -> Value {
    let bytes = send_raw(service, request_id, client, key, deadline_ms, action);
    assert!(!bytes.is_empty(), "daemon silently dropped the response");
    assert!(bytes.len() <= MAX_RESPONSE_FRAME_BYTES);
    assert_eq!(bytes.last(), Some(&b'\n'));
    serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap()
}

fn begin(service: &Service, client: &str, suffix: &str) -> String {
    send(
        service,
        &format!("begin:{suffix}"),
        client,
        Some(&format!("begin-key:{suffix}")),
        120_000,
        json!({"type":"begin_change_set","reasoning":suffix}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn add_submit(service: &Service, client: &str, suffix: &str, change: &str, id: &str, name: &str) {
    assert_eq!(
        send(
            service,
            &format!("add:{suffix}"),
            client,
            Some(&format!("add-key:{suffix}")),
            120_000,
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":id,"newName":name}}),
        )["ok"],
        true
    );
    assert_eq!(
        send(
            service,
            &format!("submit:{suffix}"),
            client,
            Some(&format!("submit-key:{suffix}")),
            120_000,
            json!({"type":"submit_change_set","changeSetId":change}),
        )["ok"],
        true
    );
}

fn deterministic_change_id(client: &str, key: &str) -> String {
    format!(
        "change:{:x}",
        Sha256::digest(format!("{client}\0{key}").as_bytes())
    )
}

fn assert_no_path_strings(value: &Value, forbidden: &[String]) {
    match value {
        Value::String(text) => {
            for path in forbidden {
                assert!(!text.contains(path), "path leaked in response: {text}");
            }
        }
        Value::Array(values) => {
            for value in values {
                assert_no_path_strings(value, forbidden);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                assert_no_path_strings(value, forbidden);
            }
        }
        _ => {}
    }
}

#[test]
fn inspect_projection_never_returns_module_or_authority_paths() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let service = start(&directory, "hardening-paths", &worker, false);
    let forbidden = [
        repo_root().to_string_lossy().into_owned(),
        directory.path().to_string_lossy().into_owned(),
        directory
            .path()
            .join("kernel.redb")
            .to_string_lossy()
            .into_owned(),
        service.socket.to_string_lossy().into_owned(),
        worker.to_string_lossy().into_owned(),
    ];

    let mut node_id = USER_ID.to_owned();
    loop {
        let response = send(
            &service,
            &format!("inspect:{node_id}"),
            "client:alpha",
            None,
            120_000,
            json!({"type":"inspect_nodes","nodeIds":[node_id]}),
        );
        assert_no_path_strings(&response, &forbidden);
        let node = &response["result"]["nodes"][0];
        if node["kind"] == "Module" {
            assert_eq!(node["payload"], "");
            break;
        }
        node_id = node["relationships"]
            .as_array()
            .unwrap()
            .iter()
            .find(|relationship| relationship["kind"] == "parent")
            .and_then(|relationship| relationship["nodeId"].as_str())
            .expect("declaration ancestry must reach a module")
            .to_owned();
    }
}

#[test]
fn daemon_rejects_request_id_rebinding_live_and_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let mut service = start(&directory, "hardening-request-id-one", &worker, false);
    let first = send(
        &service,
        "request:shared",
        "client:alpha",
        Some("key:first"),
        120_000,
        json!({"type":"begin_change_set","reasoning":"first"}),
    );
    assert_eq!(first["ok"], true);
    let replay = send(
        &service,
        "request:shared",
        "client:alpha",
        Some("key:first"),
        120_000,
        json!({"type":"begin_change_set","reasoning":"first"}),
    );
    assert_eq!(
        replay["result"]["changeSetId"],
        first["result"]["changeSetId"]
    );
    let rebound = send(
        &service,
        "request:shared",
        "client:alpha",
        Some("key:second"),
        120_000,
        json!({"type":"begin_change_set","reasoning":"second"}),
    );
    assert_eq!(rebound["ok"], false, "{rebound}");
    assert_eq!(rebound["error"]["code"], "invalid_request");

    service.child.kill().unwrap();
    service.child.wait().unwrap();
    drop(service);
    let service = start(&directory, "hardening-request-id-two", &worker, false);
    let rebound_after_restart = send(
        &service,
        "request:shared",
        "client:alpha",
        Some("key:third"),
        120_000,
        json!({"type":"begin_change_set","reasoning":"third"}),
    );
    assert_eq!(
        rebound_after_restart["ok"], false,
        "{rebound_after_restart}"
    );
    let original_after_rebind = send(
        &service,
        "request:shared",
        "client:alpha",
        Some("key:first"),
        120_000,
        json!({"type":"begin_change_set","reasoning":"first"}),
    );
    assert_eq!(original_after_rebind["ok"], true, "{original_after_rebind}");
    assert_eq!(
        original_after_rebind["result"]["changeSetId"],
        first["result"]["changeSetId"]
    );
    let absent = deterministic_change_id("client:alpha", "key:third");
    assert_eq!(
        send(
            &service,
            "cancel:absent",
            "client:alpha",
            Some("cancel:absent"),
            120_000,
            json!({"type":"cancel_change_set","changeSetId":absent}),
        )["ok"],
        false
    );
}

#[test]
fn expired_and_lock_wait_deadlines_never_start_a_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let mut service = start(&directory, "hardening-deadline-setup", &worker, false);
    let expired = send(
        &service,
        "deadline:expired",
        "client:alpha",
        Some("deadline:key"),
        1,
        json!({"type":"begin_change_set","reasoning":"must not begin"}),
    );
    assert_eq!(expired["ok"], false, "{expired}");
    assert_eq!(expired["error"]["code"], "deadline_exceeded");
    let absent = deterministic_change_id("client:alpha", "deadline:key");
    assert_eq!(
        send(
            &service,
            "deadline:absent",
            "client:alpha",
            Some("deadline:absent"),
            120_000,
            json!({"type":"cancel_change_set","changeSetId":absent}),
        )["ok"],
        false
    );

    let change = begin(&service, "client:alpha", "deadline-lock");
    add_submit(
        &service,
        "client:alpha",
        "deadline-lock",
        &change,
        USER_ID,
        "Account",
    );
    service.child.kill().unwrap();
    service.child.wait().unwrap();
    drop(service);

    let wrapper = directory.path().join("slow-worker.mjs");
    fs::write(
        &wrapper,
        format!(
            "import {{spawn}} from 'node:child_process'; setTimeout(() => {{ const c=spawn(process.execPath,[{}],{{stdio:'inherit'}}); c.on('exit',x=>process.exit(x??1)); }},1500);",
            serde_json::to_string(worker.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    let service = start(&directory, "hardening-deadline-slow", &wrapper, false);
    let socket = service.socket.clone();
    let change_for_thread = change.clone();
    let advance = thread::spawn(move || {
        let mut stream = UnixStream::connect(socket).unwrap();
        stream
            .write_all(&message(
                "deadline:advance",
                "client:alpha",
                Some("deadline:advance"),
                120_000,
                json!({"type":"advance_change_set","changeSetId":change_for_thread}),
            ))
            .unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
    });
    let audit = directory.path().join("audit.jsonl");
    let wait_until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < wait_until
        && !fs::read_to_string(&audit)
            .unwrap_or_default()
            .contains("claim_retained")
    {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        fs::read_to_string(&audit)
            .unwrap()
            .contains("claim_retained")
    );
    let started = Instant::now();
    let timed_out = send(
        &service,
        "deadline:cancel",
        "client:alpha",
        Some("deadline:cancel"),
        50,
        json!({"type":"cancel_change_set","changeSetId":change}),
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(timed_out["ok"], false, "{timed_out}");
    assert_eq!(timed_out["error"]["code"], "deadline_exceeded");
    drop(service);
    advance.join().unwrap();
}

#[test]
fn oversized_legal_inspect_gets_one_bounded_response_too_large_error() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(&directory, "hardening-response", &bridge_worker(), true);
    let bytes = send_raw(
        &service,
        "response:large",
        "client:alpha",
        None,
        120_000,
        json!({"type":"inspect_nodes","nodeIds":large_node_ids()}),
    );
    assert!(!bytes.is_empty(), "daemon silently dropped the response");
    assert!(bytes.len() <= MAX_RESPONSE_FRAME_BYTES);
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    let response: Value = serde_json::from_slice(&bytes[..bytes.len() - 1]).unwrap();
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "response_too_large");
}

#[test]
fn cancellation_reports_published_and_needs_decision_truthfully() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(&directory, "hardening-cancel", &bridge_worker(), false);
    let published_change = begin(&service, "client:alpha", "published");
    add_submit(
        &service,
        "client:alpha",
        "published",
        &published_change,
        FORMAT_TIMESTAMP_ID,
        "renderTimestamp",
    );
    let published = send(
        &service,
        "advance:published",
        "client:alpha",
        Some("advance:published"),
        120_000,
        json!({"type":"advance_change_set","changeSetId":published_change}),
    );
    assert_eq!(published["result"]["state"], "published", "{published}");
    assert_eq!(
        published["result"]["renamedSymbols"],
        json!([]),
        "{published}"
    );
    let cancel_published = send(
        &service,
        "cancel:published",
        "client:alpha",
        Some("cancel:published"),
        120_000,
        json!({"type":"cancel_change_set","changeSetId":published_change}),
    );
    assert_eq!(
        cancel_published["result"]["state"], "published",
        "{cancel_published}"
    );

    let first = begin(&service, "client:beta", "first-overlap");
    add_submit(
        &service,
        "client:beta",
        "first-overlap",
        &first,
        USER_ID,
        "Account",
    );
    let second = begin(&service, "client:gamma", "second-overlap");
    add_submit(
        &service,
        "client:gamma",
        "second-overlap",
        &second,
        USER_ID,
        "Customer",
    );
    assert_eq!(
        send(
            &service,
            "advance:first-overlap",
            "client:beta",
            Some("advance:first-overlap"),
            120_000,
            json!({"type":"advance_change_set","changeSetId":first}),
        )["result"]["state"],
        "published"
    );
    let needs_decision = send(
        &service,
        "advance:second-overlap",
        "client:gamma",
        Some("advance:second-overlap"),
        120_000,
        json!({"type":"advance_change_set","changeSetId":second}),
    );
    assert_eq!(
        needs_decision["result"]["state"], "needs_decision",
        "{needs_decision}"
    );
    // The fresh-decision context names the symbol renamed since gamma's base
    // analysis, with its previous and current names, so stale intent content
    // can be rewritten mechanically.
    assert_eq!(
        needs_decision["result"]["renamedSymbols"],
        json!([{
            "nodeId": USER_ID,
            "previousName": "User",
            "currentName": "Account",
        }]),
        "{needs_decision}"
    );
    let cancel_needs = send(
        &service,
        "cancel:needs-decision",
        "client:gamma",
        Some("cancel:needs-decision"),
        120_000,
        json!({"type":"cancel_change_set","changeSetId":second}),
    );
    assert_eq!(
        cancel_needs["result"]["state"], "needs_decision",
        "{cancel_needs}"
    );
}
