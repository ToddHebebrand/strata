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

#[cfg(feature = "coordination-test-api")]
use strata_kernel::{
    BeginChangeSet, ClaimOutcome, IntentParameters, Kernel, NodeBridgeConfig, PublishClaimOutcome,
    SubmissionOutcome,
};

const USER_ID: &str = "fc98295bca9efc3e";
#[cfg(feature = "coordination-test-api")]
const FORMAT_TIMESTAMP_ID: &str = "9a25d67ed4b74807";

struct Service {
    child: Child,
    socket: PathBuf,
    epoch: u64,
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
            .args(["--filter", "@strata/kernel-bridge", "build"])
            .current_dir(repo_root())
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .status()
            .unwrap();
        assert!(status.success(), "kernel bridge fixture build failed");
    }
    worker
}

#[cfg(feature = "coordination-test-api")]
fn node_bridge_config(worker: &Path) -> NodeBridgeConfig {
    NodeBridgeConfig::tsc_only(
        "node",
        vec![worker.to_owned().into_os_string()],
        Duration::from_secs(30),
        repo_root().join("examples/medium/src"),
        repo_root().join("examples/medium"),
        true,
    )
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

fn start(directory: &TempDir, token: &str, worker: &Path) -> Service {
    start_with_failpoint(directory, token, worker, None)
}

fn start_with_failpoint(
    directory: &TempDir,
    token: &str,
    worker: &Path,
    failpoint: Option<&str>,
) -> Service {
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
    if let Some(failpoint) = failpoint {
        command.args(["--test-failpoint", failpoint]);
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
    Service {
        child,
        socket,
        epoch: ready["serviceEpoch"].as_str().unwrap().parse().unwrap(),
    }
}

#[cfg(feature = "coordination-test-api")]
fn crash_after_send(
    service: &mut Service,
    request_id: &str,
    client: &str,
    key: &str,
    action: Value,
) {
    let mut stream = UnixStream::connect(&service.socket).unwrap();
    stream
        .write_all(&message(request_id, client, Some(key), action))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    assert!(response.is_empty(), "crash boundary returned a response");
    let status = service.child.wait().unwrap();
    assert!(!status.success(), "failpoint did not terminate the daemon");
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

fn send(
    service: &Service,
    request_id: &str,
    client: &str,
    key: Option<&str>,
    action: Value,
) -> Value {
    let mut stream = UnixStream::connect(&service.socket).unwrap();
    stream
        .write_all(&message(request_id, client, key, action))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    serde_json::from_slice(&response[..response.len() - 1]).unwrap()
}

fn disconnect_after_send(
    service: &Service,
    request_id: &str,
    client: &str,
    key: &str,
    action: Value,
) {
    let mut stream = UnixStream::connect(&service.socket).unwrap();
    stream
        .write_all(&message(request_id, client, Some(key), action))
        .unwrap();
    stream.shutdown(std::net::Shutdown::Both).unwrap();
    thread::sleep(Duration::from_millis(100));
}

#[test]
fn disconnect_retries_and_restart_preserve_exactly_once_effects_and_events() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let mut service = start(&directory, "recovery-one", &worker);

    let begin_action = json!({"type":"begin_change_set","reasoning":"recovery rename"});
    disconnect_after_send(
        &service,
        "begin:lost",
        "client:alpha",
        "begin:key",
        begin_action.clone(),
    );
    let begin = send(
        &service,
        "begin:retry",
        "client:alpha",
        Some("begin:key"),
        begin_action,
    );
    let change = begin["result"]["changeSetId"].as_str().unwrap().to_owned();

    let boundaries = [
        (
            "add",
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        ),
        (
            "submit",
            json!({"type":"submit_change_set","changeSetId":change}),
        ),
        (
            "advance",
            json!({"type":"advance_change_set","changeSetId":change}),
        ),
    ];
    for (name, action) in boundaries {
        disconnect_after_send(
            &service,
            &format!("{name}:lost"),
            "client:alpha",
            &format!("{name}:key"),
            action.clone(),
        );
        let retry = send(
            &service,
            &format!("{name}:retry"),
            "client:alpha",
            Some(&format!("{name}:key")),
            action,
        );
        assert_eq!(retry["ok"], true, "{name}: {retry}");
    }
    let events = send(
        &service,
        "events:before",
        "client:alpha",
        None,
        json!({"type":"read_events","afterSequence":"0","limit":256}),
    );
    let last = events["result"]["events"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["sequence"]
        .as_str()
        .unwrap()
        .to_owned();
    disconnect_after_send(
        &service,
        "ack:lost",
        "client:alpha",
        "ack:key",
        json!({"type":"ack_events","throughSequence":last}),
    );
    let ack = send(
        &service,
        "ack:retry",
        "client:alpha",
        Some("ack:key"),
        json!({"type":"ack_events","throughSequence":last}),
    );
    assert_eq!(ack["ok"], true);

    let first_epoch = service.epoch;
    service.child.kill().unwrap();
    service.child.wait().unwrap();
    drop(service);
    let service = start(&directory, "recovery-two", &worker);
    assert!(service.epoch > first_epoch);
    let inspect = send(
        &service,
        "inspect:after",
        "client:alpha",
        None,
        json!({"type":"inspect_nodes","nodeIds":[USER_ID]}),
    );
    assert_eq!(inspect["result"]["graphGeneration"], "1");
    assert!(
        inspect["result"]["nodes"][0]["payload"]
            .as_str()
            .unwrap()
            .contains("interface Account")
    );
    let after_ack = send(
        &service,
        "events:after",
        "client:alpha",
        None,
        json!({"type":"read_events","afterSequence":last,"limit":256}),
    );
    assert_eq!(after_ack["result"]["events"].as_array().unwrap().len(), 0);

    let cancel_change = send(
        &service,
        "cancel-begin",
        "client:alpha",
        Some("cancel-begin:key"),
        json!({"type":"begin_change_set","reasoning":"cancel"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    disconnect_after_send(
        &service,
        "cancel:lost",
        "client:alpha",
        "cancel:key",
        json!({"type":"cancel_change_set","changeSetId":cancel_change}),
    );
    let cancelled = send(
        &service,
        "cancel:retry",
        "client:alpha",
        Some("cancel:key"),
        json!({"type":"cancel_change_set","changeSetId":cancel_change}),
    );
    assert_eq!(cancelled["result"]["state"], "cancelled");
}

#[test]
fn restart_fences_a_claim_lost_during_bridge_execution_and_publishes_once() {
    let directory = tempfile::tempdir().unwrap();
    let real_worker = bridge_worker();
    let service = start(&directory, "claim-setup", &real_worker);
    let change = send(
        &service,
        "begin",
        "client:alpha",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"claim crash"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add",
            "client:alpha",
            Some("add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}})
        )["ok"],
        true
    );
    assert_eq!(
        send(
            &service,
            "submit",
            "client:alpha",
            Some("submit"),
            json!({"type":"submit_change_set","changeSetId":change})
        )["ok"],
        true
    );
    let epoch_one = service.epoch;
    drop(service);

    let wrapper = directory.path().join("slow-worker.mjs");
    fs::write(&wrapper, format!("import {{spawn}} from 'node:child_process'; setTimeout(() => {{ const c=spawn(process.execPath,[{}],{{stdio:'inherit'}}); c.on('exit',x=>process.exit(x??1)); }},1500);", serde_json::to_string(real_worker.to_str().unwrap()).unwrap())).unwrap();
    let mut slow = start(&directory, "claim-slow", &wrapper);
    let socket = slow.socket.clone();
    let change_for_thread = change.clone();
    let advance = thread::spawn(move || {
        let mut stream = UnixStream::connect(socket).unwrap();
        stream
            .write_all(&message(
                "advance:lost",
                "client:alpha",
                Some("advance:key"),
                json!({"type":"advance_change_set","changeSetId":change_for_thread}),
            ))
            .unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        response
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let audit_path = directory.path().join("audit.jsonl");
    while Instant::now() < deadline {
        if fs::read_to_string(&audit_path)
            .unwrap_or_default()
            .contains("claim_retained")
        {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let audit = fs::read_to_string(&audit_path).unwrap();
    if advance.is_finished() {
        let response = advance.join().unwrap();
        panic!(
            "advance returned before claim audit: {}\naudit:\n{audit}",
            String::from_utf8_lossy(&response)
        );
    }
    let journal = fs::read_to_string(directory.path().join("kernel.redb.service-journal.jsonl"))
        .unwrap_or_default();
    assert!(
        audit.contains("claim_retained"),
        "audit:\n{audit}\njournal:\n{journal}"
    );
    slow.child.kill().unwrap();
    slow.child.wait().unwrap();
    let _ = advance.join().unwrap();
    let epoch_two = slow.epoch;
    drop(slow);

    let recovered = start(&directory, "claim-recovered", &real_worker);
    assert!(epoch_two > epoch_one && recovered.epoch > epoch_two);
    let published = send(
        &recovered,
        "advance:retry",
        "client:alpha",
        Some("advance:key"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    assert_eq!(published["result"]["state"], "published", "{published}");
    let events = send(
        &recovered,
        "events",
        "client:alpha",
        None,
        json!({"type":"read_events","afterSequence":"0","limit":256}),
    );
    let committed = events["result"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["state"] == "published")
        .count();
    assert_eq!(committed, 1);
    assert_eq!(
        send(
            &recovered,
            "inspect",
            "client:alpha",
            None,
            json!({"type":"inspect_nodes","nodeIds":[USER_ID]})
        )["result"]["graphGeneration"],
        "1"
    );
}

#[test]
fn journal_accepts_only_a_torn_final_record_and_rejects_complete_corruption() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let service = start(&directory, "journal-integrity", &worker);
    assert_eq!(
        send(
            &service,
            "begin",
            "client:integrity",
            Some("begin"),
            json!({"type":"begin_change_set","reasoning":"journal integrity"}),
        )["ok"],
        true
    );
    drop(service);
    let journal_path = directory.path().join("kernel.redb.service-journal.jsonl");
    let clean = fs::read(&journal_path).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .unwrap()
        .write_all(b"{\"torn\"")
        .unwrap();
    let recovered = start(&directory, "journal-torn", &worker);
    drop(recovered);
    assert_eq!(fs::read(&journal_path).unwrap(), clean);

    let mut corrupt = String::from_utf8(clean).unwrap();
    let hash_start = corrupt.find("\"entryHash\":\"").unwrap() + "\"entryHash\":\"".len();
    let replacement = if &corrupt[hash_start..hash_start + 1] == "f" {
        "e"
    } else {
        "f"
    };
    corrupt.replace_range(hash_start..hash_start + 1, replacement);
    fs::write(&journal_path, corrupt).unwrap();
    let rejected = std::panic::catch_unwind(|| start(&directory, "journal-corrupt", &worker));
    assert!(rejected.is_err(), "complete hash corruption reached bind");
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn ambiguous_pending_add_intent_fails_closed_before_socket_bind() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let service = start(&directory, "ambiguous-setup", &worker);
    let change = send(
        &service,
        "begin",
        "client:ambiguous",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"ambiguous recovery"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(service);

    let mut crashed =
        start_with_failpoint(&directory, "ambiguous-crash", &worker, Some("after_effect"));
    crash_after_send(
        &mut crashed,
        "add:crash",
        "client:ambiguous",
        "add",
        json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
    );
    drop(crashed);

    let bridge_config = NodeBridgeConfig::tsc_only(
        "node",
        vec![worker.clone().into_os_string()],
        Duration::from_secs(30),
        repo_root().join("examples/medium/src"),
        repo_root().join("examples/medium"),
        true,
    );
    let (kernel, _) =
        Kernel::open_with_node_bridge(directory.path().join("kernel.redb"), bridge_config).unwrap();
    kernel
        .add_intent(
            &change,
            IntentParameters::RenameSymbol {
                declaration_id: USER_ID.into(),
                new_name: "Customer".into(),
            },
        )
        .unwrap();
    drop(kernel);

    let rejected = std::panic::catch_unwind(|| start(&directory, "ambiguous-recovered", &worker));
    assert!(
        rejected.is_err(),
        "ambiguous pending add reached socket bind"
    );
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn journal_crash_boundaries_replay_one_exact_begin_effect() {
    let worker = bridge_worker();
    for stage in [
        "after_pending",
        "after_effect",
        "after_prepared",
        "after_completed",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let action = json!({"type":"begin_change_set","reasoning":format!("crash at {stage}")});
        let mut crashed = start_with_failpoint(
            &directory,
            &format!("journal-{stage}"),
            &worker,
            Some(stage),
        );
        crash_after_send(
            &mut crashed,
            "begin:crash",
            "client:journal",
            "begin:key",
            action.clone(),
        );
        drop(crashed);

        let recovered = start(&directory, &format!("journal-{stage}-recovered"), &worker);
        let first = send(
            &recovered,
            "begin:retry",
            "client:journal",
            Some("begin:key"),
            action.clone(),
        );
        let second = send(
            &recovered,
            "begin:replay",
            "client:journal",
            Some("begin:key"),
            action,
        );
        assert_eq!(first["ok"], true, "{stage}: {first}");
        assert_eq!(first["result"], second["result"], "{stage}");
        assert_eq!(first["result"]["state"], "draft", "{stage}: {first}");
    }
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn published_effect_recovery_preserves_the_publication_digest() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let service = start(&directory, "digest-setup", &worker);
    let change = send(
        &service,
        "begin",
        "client:digest",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"digest recovery"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add",
            "client:digest",
            Some("add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        )["ok"],
        true
    );
    assert_eq!(
        send(
            &service,
            "submit",
            "client:digest",
            Some("submit"),
            json!({"type":"submit_change_set","changeSetId":change}),
        )["ok"],
        true
    );
    drop(service);

    let mut crashed =
        start_with_failpoint(&directory, "digest-crash", &worker, Some("after_effect"));
    crash_after_send(
        &mut crashed,
        "advance:crash",
        "client:digest",
        "advance",
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    drop(crashed);

    let recovered = start(&directory, "digest-recovered", &worker);
    let response = send(
        &recovered,
        "advance:retry",
        "client:digest",
        Some("advance"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    assert_eq!(response["result"]["state"], "published", "{response}");
    let digest = response["result"]["publicationDigest"].as_str().unwrap();
    assert_eq!(digest.len(), 64, "{response}");
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn published_effect_recovery_preserves_its_historical_digest_after_another_publication() {
    let directory = tempfile::tempdir().unwrap();
    let worker = bridge_worker();
    let service = start(&directory, "historical-digest-setup", &worker);
    let change = send(
        &service,
        "begin:a",
        "client:a",
        Some("begin:a"),
        json!({"type":"begin_change_set","reasoning":"historical digest A"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add:a",
            "client:a",
            Some("add:a"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        )["ok"],
        true
    );
    assert_eq!(
        send(
            &service,
            "submit:a",
            "client:a",
            Some("submit:a"),
            json!({"type":"submit_change_set","changeSetId":change}),
        )["ok"],
        true
    );
    drop(service);

    let mut crashed = start_with_failpoint(
        &directory,
        "historical-digest-crash",
        &worker,
        Some("after_effect"),
    );
    crash_after_send(
        &mut crashed,
        "advance:a",
        "client:a",
        "advance:a",
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    drop(crashed);

    let (kernel, _) = Kernel::open_with_node_bridge(
        directory.path().join("kernel.redb"),
        node_bridge_config(&worker),
    )
    .unwrap();
    assert_eq!(kernel.snapshot().generation(), 1);
    let historical_digest = kernel.snapshot().digest().to_owned();
    kernel
        .begin_change_set(
            BeginChangeSet {
                change_set_id: "change:b".into(),
                actor: "client:b".into(),
                reasoning: "advance canonical generation before A recovery".into(),
                submission_idempotency_key: "submission:b".into(),
            },
            100,
        )
        .unwrap();
    kernel
        .add_intent(
            "change:b",
            IntentParameters::RenameSymbol {
                declaration_id: FORMAT_TIMESTAMP_ID.into(),
                new_name: "renderTimestamp".into(),
            },
        )
        .unwrap();
    let SubmissionOutcome::Ready { offer, .. } = kernel.submit_change_set("change:b", 101).unwrap()
    else {
        panic!("B must be ready")
    };
    let ClaimOutcome::Claimed(claim) = kernel
        .claim_ready(&offer.offer_id, &offer.claim_token, 102)
        .unwrap()
    else {
        panic!("B must be claimed")
    };
    let PublishClaimOutcome::Published(report) = kernel.execute_claimed(&claim, 103).unwrap()
    else {
        panic!("B must publish")
    };
    assert_eq!(report.generation, 2);
    assert_ne!(report.digest, historical_digest);
    drop(kernel);

    let recovered = start(&directory, "historical-digest-recovered", &worker);
    let response = send(
        &recovered,
        "advance:a:retry",
        "client:a",
        Some("advance:a"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    assert_eq!(response["result"]["state"], "published", "{response}");
    assert_eq!(
        response["result"]["publicationDigest"], historical_digest,
        "{response}"
    );
    assert_eq!(response["result"]["graphGeneration"], "2");
}

#[cfg(feature = "coordination-test-api")]
fn assert_validation_failure_recovery(stage: &str) {
    let directory = tempfile::tempdir().unwrap();
    let real_worker = bridge_worker();
    let wrapper = directory.path().join("validation-fails.mjs");
    fs::write(
        &wrapper,
        format!(
            "import {{spawnSync}} from 'node:child_process';let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{{const r=JSON.parse(b);if(r.kind==='buildValidateCandidate'){{process.stderr.write('candidate rejected exactly');process.exit(1)}}const x=spawnSync(process.execPath,[{}],{{input:b,encoding:'utf8'}});process.stdout.write(x.stdout??'');process.stderr.write(x.stderr??'');process.exit(x.status??1)}});",
            serde_json::to_string(real_worker.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    let service = start(&directory, "validation-setup", &wrapper);
    let change = send(
        &service,
        "begin",
        "client:validation",
        Some("begin"),
        json!({"type":"begin_change_set","reasoning":"validation recovery"}),
    )["result"]["changeSetId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        send(
            &service,
            "add",
            "client:validation",
            Some("add"),
            json!({"type":"add_intent","changeSetId":change,"intent":{"type":"rename_symbol","declarationId":USER_ID,"newName":"Account"}}),
        )["ok"],
        true
    );
    assert_eq!(
        send(
            &service,
            "submit",
            "client:validation",
            Some("submit"),
            json!({"type":"submit_change_set","changeSetId":change}),
        )["ok"],
        true
    );
    drop(service);

    let mut crashed = start_with_failpoint(
        &directory,
        &format!("validation-{stage}-crash"),
        &wrapper,
        Some(stage),
    );
    crash_after_send(
        &mut crashed,
        "advance:crash",
        "client:validation",
        "advance",
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    drop(crashed);

    let recovered = start(&directory, "validation-recovered", &wrapper);
    let first = send(
        &recovered,
        "advance:retry",
        "client:validation",
        Some("advance"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    let second = send(
        &recovered,
        "advance:replay",
        "client:validation",
        Some("advance"),
        json!({"type":"advance_change_set","changeSetId":change}),
    );
    assert_eq!(first["result"], second["result"]);
    assert_eq!(first["result"]["state"], "validation_failed", "{first}");
    assert_eq!(
        first["result"]["diagnostics"][0]["code"],
        "candidate_validation_failed"
    );
    assert_eq!(
        first["result"]["diagnostics"][0]["message"],
        "candidate validation failed"
    );
}

#[cfg(feature = "coordination-test-api")]
#[test]
fn validation_failure_recovery_preserves_the_exact_diagnostic() {
    assert_validation_failure_recovery("after_effect");
    assert_validation_failure_recovery("after_prepared");
    assert_validation_failure_recovery("after_follow_up");
}
