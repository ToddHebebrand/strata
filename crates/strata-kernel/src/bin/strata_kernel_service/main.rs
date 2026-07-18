mod audit;
mod protocol;
mod server;
mod session;

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strata_kernel::NodeBridgeConfig;

use session::{ServiceConfig, ServiceFailpoint};

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
    match command.to_str() {
        Some("serve") => serve(&remaining),
        Some("validate-socket") => validate_socket(&remaining),
        Some("export-snapshot") => export_snapshot(&remaining),
        _ => bail!("unknown command; run with --help"),
    }
}

fn serve(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    #[cfg(feature = "coordination-test-api")]
    let allowed = [
        "--db",
        "--snapshot",
        "--bridge-worker",
        "--source-root",
        "--corpus-root",
        "--audit",
        "--socket-token",
        "--test-failpoint",
    ];
    #[cfg(not(feature = "coordination-test-api"))]
    let allowed = [
        "--db",
        "--snapshot",
        "--bridge-worker",
        "--source-root",
        "--corpus-root",
        "--audit",
        "--socket-token",
    ];
    reject_unknown(&values, &allowed)?;
    let db_path = required_path(&values, "--db")?;
    let snapshot_path = required_path(&values, "--snapshot")?;
    let worker = required_path(&values, "--bridge-worker")?;
    let source_root = required_path(&values, "--source-root")?;
    let corpus_root = required_path(&values, "--corpus-root")?;
    let audit_path = required_path(&values, "--audit")?;
    let token = required_text(&values, "--socket-token")?;
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
    let bridge_config = NodeBridgeConfig::tsc_only(
        "node",
        vec![worker.into_os_string()],
        Duration::from_secs(30),
        source_root,
        corpus_root,
        true,
    );
    server::serve(
        ServiceConfig {
            db_path,
            snapshot_path,
            bridge_config,
            audit_path,
            failpoint,
        },
        &token,
    )
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

fn print_help() {
    println!(
        "strata-kernel-service\n\nCommands:\n  serve --db PATH --snapshot PATH --bridge-worker PATH --source-root PATH --corpus-root PATH --socket-token TOKEN --audit PATH\n  validate-socket --socket PATH\n  export-snapshot --db PATH --out PATH [--state-out PATH]"
    );
}
