mod audit;
mod drain;
mod lifecycle;
#[cfg(feature = "lock-instrumentation")]
mod lock_metrics;
mod manifest;
mod metrics;
mod ownership;
mod paths;
mod protocol;
mod server;
mod session;

use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strata_kernel::NodeBridgeConfig;

use session::{ServiceConfig, ServiceFailpoint, ValidationSettings};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(2);
    }
}

fn run() -> Result<()> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let Some(command) = arguments.next() else {
        print_help();
        return Ok(());
    };
    if command == "--help" || command == "-h" {
        print_help();
        return Ok(());
    }
    let remaining = arguments.collect::<Vec<_>>();
    // Subcommand help must be handled BEFORE option parsing: `parse_named`
    // bails on an odd argument count, so a bare `--help` after a subcommand
    // would otherwise fail with a confusing pair-parse error.
    if remaining.iter().any(|argument| argument == "--help" || argument == "-h") {
        print_help();
        return Ok(());
    }
    match command.to_str() {
        // `start` is an ALIAS, not a rename: every existing harness invokes
        // `serve`, and renaming would break them all for no benefit.
        Some("serve") | Some("start") => serve(&remaining),
        Some("health") => health(&remaining),
        Some("stop") => stop(&remaining),
        Some("validate-socket") => validate_socket(&remaining),
        Some("export-snapshot") => export_snapshot(&remaining),
        _ => bail!("unknown command; run with --help"),
    }
}

fn serve(arguments: &[OsString]) -> Result<()> {
    // `--persistent-bridge` is the one bare (valueless) serve flag: extract it
    // before the strict `--name value` pair parse. Default OFF; when present
    // the daemon owns one persistent bridge worker for the session — eagerly
    // hydrated at startup and kept exact by published-only attested delta
    // sync (Task 6) — and one-shot spawning becomes the per-request fallback.
    let mut arguments = arguments.to_vec();
    let argument_count = arguments.len();
    arguments.retain(|argument| argument != "--persistent-bridge");
    let persistent_bridge = arguments.len() != argument_count;
    let values = parse_named(&arguments)?;
    // Built as a Vec so the two test-only flags are appended per cfg. Both the
    // journal-stage failpoint (`--test-failpoint`, coordination-test-api) and
    // the publication-boundary failpoint (`--test-publish-failpoint`,
    // redb-spike-api) are additive test surfaces; because redb-spike-api
    // implies coordination-test-api, a redb-spike-api build accepts both, a
    // coordination-test-api build accepts only the first, and a default build
    // accepts neither (so `reject_unknown` fails closed on either flag).
    #[allow(unused_mut)]
    let mut allowed = vec![
        "--db",
        "--snapshot",
        "--bridge-worker",
        "--source-root",
        "--corpus-root",
        "--audit",
        "--socket-token",
        // Opt-in observability sink. Unconditional (a production surface, not a
        // test-authority flag): a build without it rejects `--metrics`.
        "--metrics",
        // Opt-in behavioral validation manifest (B-2). Absent: the session
        // runs exactly as before B-2 (tscOnly, no fixtures, default
        // timeouts) — the byte-identical no-flag guarantee.
        "--validation-manifest",
        // D-3a: the directory holding endpoint locks, records, and sockets.
        // Absent means the production `/tmp/strata-lc`. This exists so tests
        // never operate on the shared directory — it holds live daemons'
        // sockets, and a test that removed or replaced it could destroy them.
        "--socket-root",
        "--drain-grace-ms",
    ];
    #[cfg(feature = "coordination-test-api")]
    {
        allowed.push("--test-failpoint");
        allowed.push("--test-response-write-barrier");
        allowed.push("--test-stop-write-barrier");
        allowed.push("--test-block-after-pending-ms");
    }
    #[cfg(feature = "redb-spike-api")]
    allowed.push("--test-publish-failpoint");
    #[cfg(feature = "lock-instrumentation")]
    allowed.push("--lock-samples");
    reject_unknown(&values, &allowed)?;
    let db_path = required_path(&values, "--db")?;
    let snapshot_path = required_path(&values, "--snapshot")?;
    let worker = required_path(&values, "--bridge-worker")?;
    let source_root = required_path(&values, "--source-root")?;
    let corpus_root = required_path(&values, "--corpus-root")?;
    let audit_path = required_path(&values, "--audit")?;
    let token = required_text(&values, "--socket-token")?;
    let socket_root = match optional_path(&values, "--socket-root") {
        Some(path) => lifecycle::SocketRoot::open(&path)?,
        None => lifecycle::SocketRoot::production()?,
    };
    let metrics_path = optional_path(&values, "--metrics");
    let drain_grace_ms =
        optional_canonical_u64(&values, "--drain-grace-ms", drain::DEFAULT_DRAIN_GRACE_MS)?;
    if !(1..=300_000).contains(&drain_grace_ms) {
        bail!("--drain-grace-ms must be in 1..=300000");
    }
    #[cfg(feature = "lock-instrumentation")]
    let lock_sampler = optional_path(&values, "--lock-samples")
        .map(|path| lock_metrics::LockSampler::create(&path))
        .transpose()?;
    #[cfg(feature = "coordination-test-api")]
    let block_after_pending = match values.get("--test-block-after-pending-ms") {
        Some(_) => {
            let value = optional_canonical_u64(&values, "--test-block-after-pending-ms", 0)?;
            anyhow::ensure!(value <= 300_000, "--test-block-after-pending-ms is too large");
            Some(Duration::from_millis(value))
        }
        None => None,
    };
    // Resolved BEFORE corpus_root moves into NodeBridgeConfig::tsc_only
    // below. Produces both the ValidationSettings the session publishes as
    // its identity AND (further down) the bridge profile the worker actually
    // validates under — one manifest, one decision, two consumers.
    let loaded_manifest = match optional_path(&values, "--validation-manifest") {
        Some(manifest_path) => Some(
            manifest::load_validation_manifest(&manifest_path, &corpus_root).with_context(
                || format!("load validation manifest {}", manifest_path.display()),
            )?,
        ),
        None => None,
    };
    let validation = match &loaded_manifest {
        Some(loaded) => ValidationSettings::from_loaded_manifest(loaded),
        None => ValidationSettings::tsc_only(),
    };
    #[cfg(feature = "coordination-test-api")]
    let failpoint = match values.get("--test-failpoint") {
        None => ServiceFailpoint::None,
        Some(value) => match value.to_str() {
            Some("after_pending") => ServiceFailpoint::AfterPending,
            Some("after_effect") => ServiceFailpoint::AfterEffect,
            Some("after_prepared") => ServiceFailpoint::AfterPrepared,
            Some("after_follow_up") => ServiceFailpoint::AfterFollowUp,
            Some("after_completed") => ServiceFailpoint::AfterCompleted,
            _ => bail!(
                "invalid test failpoint; expected after_pending, after_effect, after_prepared, after_follow_up, or after_completed"
            ),
        },
    };
    #[cfg(not(feature = "coordination-test-api"))]
    let failpoint = ServiceFailpoint::None;
    // The publication-boundary crash failpoint. `None` (the default and the
    // only value in a non-redb-spike-api build) threads through as
    // `execute_claimed`, i.e. zero behavior change.
    #[cfg(feature = "redb-spike-api")]
    let publish_failpoint = match values.get("--test-publish-failpoint") {
        None => strata_kernel::PublishFailpoint::None,
        Some(value) => {
            let name = value
                .to_str()
                .context("--test-publish-failpoint must be valid UTF-8")?;
            strata_kernel::PublishFailpoint::from_boundary_name(name).with_context(|| {
                format!(
                    "invalid publish failpoint {name}; expected beforeRedbTransaction, insideRedbTransaction, afterRedbCommitBeforeMemoryPublish, or afterMemoryPublish"
                )
            })?
        }
    };
    // Cloned before it moves into NodeBridgeConfig::tsc_only below; the
    // canonical form (resolved at ServiceSession::open) backs module path
    // projection (paths::project_module_path, Task 4).
    let service_corpus_root = corpus_root.clone();
    let mut bridge_config = NodeBridgeConfig::tsc_only(
        "node",
        vec![worker.into_os_string()],
        Duration::from_secs(30),
        source_root,
        corpus_root,
        true,
    );
    // The operator manifest's regime and budgets reach the WORKER here (B-2
    // Task 7). Without a manifest this block does not run at all, so the
    // profile keeps its historic five keys and the candidate deadline stays
    // the transport deadline — the byte-identical no-flag wire.
    if let Some(loaded) = &loaded_manifest {
        bridge_config = match loaded.manifest.mode {
            manifest::ManifestMode::TscOnly => bridge_config.with_tsc_only_timeouts(
                loaded.manifest.tsc_timeout_ms,
                loaded.manifest.vitest_timeout_ms,
            ),
            manifest::ManifestMode::Behavioral => bridge_config.with_behavioral_validation(
                loaded
                    .manifest
                    .fixtures
                    .iter()
                    .map(|fixture| fixture.path.clone())
                    .collect(),
                loaded.manifest.tsc_timeout_ms,
                loaded.manifest.vitest_timeout_ms,
            ),
        }
        .context("apply the validation manifest to the Node bridge configuration")?;
    }
    // Only ask workers to self-report metrics when the sink is active, so a run
    // without `--metrics` never appends `--emit-metrics` to worker argv.
    if metrics_path.is_some() {
        bridge_config = bridge_config.with_metrics_collection(true);
    }
    if persistent_bridge {
        bridge_config = bridge_config.with_persistent_bridge(true);
    }
    server::serve_in_root(
        ServiceConfig {
            db_path,
            snapshot_path,
            bridge_config,
            audit_path,
            corpus_root: service_corpus_root,
            validation,
            failpoint,
            metrics_path,
            drain_grace: Duration::from_millis(drain_grace_ms),
            #[cfg(feature = "lock-instrumentation")]
            lock_sampler,
            #[cfg(feature = "coordination-test-api")]
            response_write_barrier: optional_path(&values, "--test-response-write-barrier"),
            #[cfg(feature = "coordination-test-api")]
            stop_write_barrier: optional_path(&values, "--test-stop-write-barrier"),
            #[cfg(feature = "coordination-test-api")]
            block_after_pending,
            #[cfg(feature = "redb-spike-api")]
            publish_failpoint,
        },
        &token,
        socket_root,
    )
}

/// `health --socket <path>` or `health --token <token>`.
///
/// Exits with a per-command code rather than the blanket 2 that `main` gives
/// every error, because an operator scripting against this needs to tell
/// "nothing is there" apart from "something is there and will not talk".
///
/// | Code | Meaning |
/// |---|---|
/// | 0 | healthy |
/// | 3 | endpoint absent |
/// | 4 | present but unreachable, or not our protocol |
/// | 5 | healthy and draining (defined now, reachable in D-3b) |
/// | 6 | timed out |
fn health(arguments: &[OsString]) -> Result<()> {
    const PROBE_DEADLINE: Duration = Duration::from_secs(5);

    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--socket", "--token", "--socket-root"])?;

    let socket = match optional_path(&values, "--socket") {
        Some(path) => path,
        None => {
            // With per-incarnation names the path is no longer derivable from
            // the token, so resolve it through the stable record.
            let token = required_text(&values, "--token").context(
                "health needs either --socket <path> or --token <token>",
            )?;
            let root = match optional_path(&values, "--socket-root") {
                Some(path) => lifecycle::SocketRoot::open(&path)?,
                None => lifecycle::SocketRoot::production()?,
            };
            match lifecycle::resolve_socket_for_token(&root, &server::token_hash(&token)) {
                Some(path) => path,
                None => {
                    eprintln!("no endpoint is recorded for that token");
                    std::process::exit(3);
                }
            }
        }
    };

    let outcome = lifecycle::probe_health(&socket, PROBE_DEADLINE);
    match &outcome {
        lifecycle::HealthOutcome::Healthy => println!("healthy"),
        lifecycle::HealthOutcome::Draining => println!("draining"),
        lifecycle::HealthOutcome::Absent => eprintln!("endpoint absent"),
        lifecycle::HealthOutcome::Unreachable(why) => eprintln!("endpoint unreachable: {why}"),
        lifecycle::HealthOutcome::TimedOut => eprintln!("health probe timed out"),
    }
    std::process::exit(outcome.exit_code());
}

fn stop(arguments: &[OsString]) -> Result<()> {
    const PROBE_DEADLINE: Duration = Duration::from_secs(5);

    let command_started = std::time::Instant::now();
    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--socket", "--token", "--socket-root", "--wait-ms"])?;
    let wait_ms = optional_canonical_u64(&values, "--wait-ms", 0)?;
    if wait_ms > 300_000 {
        bail!("--wait-ms must be in 0..=300000");
    }
    let has_socket = values.contains_key("--socket");
    let has_token = values.contains_key("--token");
    if has_socket == has_token {
        bail!("stop needs exactly one of --socket <path> or --token <token>");
    }
    let socket = if has_socket {
        required_path(&values, "--socket")?
    } else {
        let token = required_text(&values, "--token")?;
        let root = match optional_path(&values, "--socket-root") {
            Some(path) => lifecycle::SocketRoot::open(&path)?,
            None => lifecycle::SocketRoot::production()?,
        };
        match lifecycle::resolve_socket_for_token(&root, &server::token_hash(&token)) {
            Some(path) => path,
            None => {
                eprintln!("no endpoint is recorded for that token");
                std::process::exit(3);
            }
        }
    };

    match std::fs::symlink_metadata(&socket) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("endpoint absent");
            std::process::exit(3);
        }
        Err(error) => {
            eprintln!("endpoint unreachable: {error}");
            std::process::exit(4);
        }
        Ok(metadata) if !metadata.file_type().is_socket() => {
            eprintln!("endpoint unreachable: path is not a socket");
            std::process::exit(4);
        }
        Ok(_) => {}
    }

    let mut stream = match lifecycle::connect_deadlined(&socket, PROBE_DEADLINE) {
        Ok(stream) => stream,
        Err(error) => {
            let message = format!("{error:#}");
            eprintln!("endpoint unreachable: {message}");
            std::process::exit(if message.contains("timed out") { 6 } else { 4 });
        }
    };
    let request = protocol::serialize_first_frame(&protocol::FirstFrame::Stop {
        protocol_version: protocol::PROTOCOL_VERSION,
    })?;
    if let Err(error) = stream.write_all(&request) {
        eprintln!("stop request failed: {error}");
        std::process::exit(4);
    }
    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => {
                eprintln!("endpoint closed without a stop reply");
                std::process::exit(4);
            }
            Ok(_) => {
                response.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
                if response.len() > protocol::MAX_HANDSHAKE_FRAME_BYTES {
                    eprintln!("stop reply exceeded its bound");
                    std::process::exit(4);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                eprintln!("stop request timed out");
                std::process::exit(6);
            }
            Err(error) => {
                eprintln!("stop request failed: {error}");
                std::process::exit(4);
            }
        }
    }
    let acknowledgement_code = match protocol::parse_stop_reply_frame(&response) {
        Ok(protocol::StopReply::StopAccepted { .. }) => {
            println!("stop accepted");
            0
        }
        Ok(protocol::StopReply::AlreadyDraining { .. }) => {
            println!("already draining");
            5
        }
        Err(error) => {
            eprintln!("invalid stop reply: {error:#}");
            std::process::exit(4);
        }
    };
    if wait_ms == 0 {
        std::process::exit(acknowledgement_code);
    }
    let deadline = command_started + Duration::from_millis(wait_ms);
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let probe_deadline = remaining.min(Duration::from_millis(100));
        match lifecycle::probe_health(&socket, probe_deadline) {
            lifecycle::HealthOutcome::Absent | lifecycle::HealthOutcome::Unreachable(_) => {
                std::process::exit(0);
            }
            lifecycle::HealthOutcome::Healthy
            | lifecycle::HealthOutcome::Draining
            | lifecycle::HealthOutcome::TimedOut => {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    eprintln!("stop wait timed out");
    std::process::exit(6);
}

fn validate_socket(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--socket"])?;
    let path = required_path(&values, "--socket")?;
    server::validate_socket_path(&path)
}

/// Offline oracle for the parity/crash harness: opens the redb store through
/// the normal digest-verified recovery path (`Kernel::open`, no node bridge,
/// no validation) and writes the canonical graph snapshot. Under
/// `redb-spike-api`, `--state-out` additionally writes the atomic-state
/// projection (`Kernel::test_atomic_state_projection`) — the same capture the
/// row-8 crash acceptance test uses — as the crash oracle.
fn export_snapshot(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--db", "--out", "--state-out"])?;
    let db_path = required_path(&values, "--db")?;
    let out_path = required_path(&values, "--out")?;
    anyhow::ensure!(
        db_path.exists(),
        "database {} does not exist",
        db_path.display()
    );
    let (kernel, _report) = strata_kernel::Kernel::open(&db_path)?;
    let graph = kernel.snapshot();
    std::fs::write(&out_path, serde_json::to_vec_pretty(&graph.snapshot())?)?;
    #[cfg(feature = "redb-spike-api")]
    if let Some(state_out) = values.get("--state-out") {
        std::fs::write(
            std::path::PathBuf::from(state_out),
            serde_json::to_vec_pretty(&kernel.test_atomic_state_projection()?)?,
        )?;
    }
    #[cfg(not(feature = "redb-spike-api"))]
    anyhow::ensure!(
        !values.contains_key("--state-out"),
        "--state-out requires a redb-spike-api build"
    );
    println!(
        "{}",
        serde_json::json!({
            "generation": graph.generation().to_string(),
            "digest": graph.digest(),
        })
    );
    Ok(())
}

fn reject_unknown(
    values: &std::collections::BTreeMap<String, OsString>,
    allowed: &[&str],
) -> Result<()> {
    if let Some(name) = values.keys().find(|name| !allowed.contains(&name.as_str())) {
        bail!("unknown option {name}");
    }
    Ok(())
}

fn parse_named(arguments: &[OsString]) -> Result<std::collections::BTreeMap<String, OsString>> {
    if !arguments.len().is_multiple_of(2) {
        bail!("command options must be --name value pairs");
    }
    let mut result = std::collections::BTreeMap::new();
    for pair in arguments.chunks_exact(2) {
        let name = pair[0]
            .to_str()
            .context("option names must be valid UTF-8")?;
        if !name.starts_with("--") || result.insert(name.to_owned(), pair[1].clone()).is_some() {
            bail!("invalid or duplicate option {name}");
        }
    }
    Ok(result)
}

fn required_path(
    values: &std::collections::BTreeMap<String, OsString>,
    name: &str,
) -> Result<PathBuf> {
    values
        .get(name)
        .cloned()
        .map(PathBuf::from)
        .with_context(|| format!("missing required option {name}"))
}

fn optional_path(
    values: &std::collections::BTreeMap<String, OsString>,
    name: &str,
) -> Option<PathBuf> {
    values.get(name).cloned().map(PathBuf::from)
}

fn required_text(
    values: &std::collections::BTreeMap<String, OsString>,
    name: &str,
) -> Result<String> {
    values
        .get(name)
        .context(format!("missing required option {name}"))?
        .clone()
        .into_string()
        .map_err(|_| anyhow::anyhow!("{name} must be valid UTF-8"))
}

fn optional_canonical_u64(
    values: &std::collections::BTreeMap<String, OsString>,
    name: &str,
    default: u64,
) -> Result<u64> {
    let Some(raw) = values.get(name) else {
        return Ok(default);
    };
    let text = raw.to_str().with_context(|| format!("{name} must be valid UTF-8"))?;
    let value = text
        .parse::<u64>()
        .with_context(|| format!("{name} must be a canonical unsigned integer"))?;
    if value.to_string() != text {
        bail!("{name} must be a canonical unsigned integer");
    }
    Ok(value)
}

fn print_help() {
    // The test-authority flags (`--test-failpoint`, `--test-publish-failpoint`)
    // are intentionally sealed OUT of --help under every feature build — see
    // `local_service_sealing::default_build_service_has_no_test_authority_surface`.
    // They are parsed in `serve` but never advertised.
    println!(
        "strata-kernel-service\n\nCommands:\n  serve --db PATH --snapshot PATH --bridge-worker PATH --source-root PATH --corpus-root PATH --socket-token TOKEN --audit PATH [--metrics PATH] [--persistent-bridge] [--validation-manifest PATH] [--drain-grace-ms 1..=300000]\n  health (--socket PATH | --token TOKEN [--socket-root ROOT])\n  stop (--socket PATH | --token TOKEN [--socket-root ROOT]) [--wait-ms 0..=300000]\n  validate-socket --socket PATH\n  export-snapshot --db PATH --out PATH [--state-out PATH]"
    );
}
