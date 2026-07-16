mod audit;
mod protocol;
mod server;
mod session;

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strata_kernel::NodeBridgeConfig;

use session::ServiceConfig;

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
        _ => bail!("unknown command; run with --help"),
    }
}

fn serve(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    let db_path = required_path(&values, "--db")?;
    let snapshot_path = required_path(&values, "--snapshot")?;
    let worker = required_path(&values, "--bridge-worker")?;
    let source_root = required_path(&values, "--source-root")?;
    let corpus_root = required_path(&values, "--corpus-root")?;
    let audit_path = required_path(&values, "--audit")?;
    let token = required_text(&values, "--socket-token")?;
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
        },
        &token,
    )
}

fn validate_socket(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    let path = required_path(&values, "--socket")?;
    server::validate_socket_path(&path)
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
        "strata-kernel-service\n\nCommands:\n  serve --db PATH --snapshot PATH --bridge-worker PATH --source-root PATH --corpus-root PATH --socket-token TOKEN --audit PATH\n  validate-socket --socket PATH"
    );
}
