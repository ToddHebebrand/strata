use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use strata_kernel::{
    EventRecord, FenceClaim, GraphChange, GraphDelta, GraphSnapshot, Kernel, OperationRecord,
    Publication, PublishFailpoint, SCHEMA_VERSION, TicketRecord,
};

#[derive(Deserialize, Serialize)]
struct IdentifierPayload {
    text: String,
    offset: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        bail!("missing command");
    };

    match command {
        "seed" => seed(&args[1..]),
        "inspect" => inspect(&args[1..]),
        "make-rename-publication" => make_rename_publication(&args[1..]),
        "publish" => publish(&args[1..]),
        "measure" => measure(&args[1..]),
        other => bail!("unknown command {other}"),
    }
}

fn seed(args: &[String]) -> Result<()> {
    require_only(args, &["--db", "--snapshot"])?;
    let database = required(args, "--db")?;
    let snapshot_path = required(args, "--snapshot")?;
    let snapshot: GraphSnapshot = read_json(snapshot_path, "snapshot")?;
    let node_count = snapshot.nodes.len();
    let reference_count = snapshot.references.len();
    let seed_started = Instant::now();
    let (_, report) = Kernel::create(database, snapshot)?;
    let seed_ns = seed_started.elapsed().as_nanos();
    let redb_file_bytes = fs::metadata(database)
        .with_context(|| format!("stat redb database {database}"))?
        .len();
    print_json(json!({
        "command": "seed",
        "generation": report.generation,
        "digest": report.digest,
        "serviceEpoch": report.service_epoch,
        "seedNs": seed_ns,
        "nodeCount": node_count,
        "referenceCount": reference_count,
        "redbFileBytes": redb_file_bytes,
    }))
}

fn inspect(args: &[String]) -> Result<()> {
    require_only(args, &["--db"])?;
    let database = required(args, "--db")?;
    let (_, report) = Kernel::open(database)?;
    print_json(json!({
        "command": "inspect",
        "generation": report.generation,
        "digest": report.digest,
        "serviceEpoch": report.service_epoch,
        "snapshotGeneration": report.snapshot_generation,
        "replayedOperations": report.replayed_operations,
    }))
}

fn make_rename_publication(args: &[String]) -> Result<()> {
    require_only(args, &["--snapshot", "--out"])?;
    let snapshot_path = required(args, "--snapshot")?;
    let output_path = required(args, "--out")?;
    let snapshot: GraphSnapshot = read_json(snapshot_path, "snapshot")?;
    let next_generation = snapshot
        .generation
        .checked_add(1)
        .context("graph generation overflow")?;
    let mut affected_node_ids = Vec::new();
    let mut changes = Vec::new();

    for node in &snapshot.nodes {
        if node.kind != "Identifier" {
            continue;
        }
        let Ok(mut payload) = serde_json::from_str::<IdentifierPayload>(&node.payload) else {
            continue;
        };
        if payload.text != "User" {
            continue;
        }
        payload.text = "Account".into();
        let mut changed = node.clone();
        changed.payload = serde_json::to_string(&payload).context("encode identifier payload")?;
        affected_node_ids.push(changed.id.clone());
        changes.push(GraphChange::UpsertNode { node: changed });
    }

    if affected_node_ids.is_empty() {
        bail!("snapshot contains no Identifier payload whose text is User");
    }

    let resource_tokens = BTreeMap::from([("symbol:User".to_string(), 0)]);
    let operation_id = "operation:redb-spike:user-to-account";
    let publication = Publication {
        schema_version: SCHEMA_VERSION,
        idempotency_key: "publication:redb-spike:user-to-account".into(),
        delta: GraphDelta {
            schema_version: SCHEMA_VERSION,
            base_generation: snapshot.generation,
            changes,
        },
        operation: OperationRecord {
            operation_id: operation_id.into(),
            change_set_id: "change-set:redb-spike:user-to-account".into(),
            actor: "redb-spike".into(),
            kind: "RenameSymbol".into(),
            reasoning: "real-corpus atomic publication proof".into(),
            affected_node_ids: affected_node_ids.clone(),
            renames: Vec::new(),
        },
        ticket: TicketRecord {
            ticket_id: "ticket:redb-spike:user-to-account".into(),
            state: "committed".into(),
            scope_fingerprint: "symbol:User".into(),
        },
        event: EventRecord {
            event_id: "event:redb-spike:user-to-account".into(),
            sequence: next_generation,
            kind: "IntentCommitted".into(),
            graph_generation: next_generation,
            payload_json: serde_json::to_string(&json!({ "operationId": operation_id }))?,
        },
        fence: FenceClaim {
            service_epoch: 0,
            resource_tokens,
        },
    };

    let encoded = serde_json::to_vec_pretty(&publication).context("encode publication")?;
    fs::write(output_path, encoded)
        .with_context(|| format!("write publication to {output_path}"))?;
    print_json(json!({
        "command": "make-rename-publication",
        "out": output_path,
        "affectedNodeCount": affected_node_ids.len(),
    }))
}

fn publish(args: &[String]) -> Result<()> {
    require_only(args, &["--db", "--publication", "--failpoint"])?;
    let database = required(args, "--db")?;
    let publication_path = required(args, "--publication")?;
    let mut publication: Publication = read_json(publication_path, "publication")?;
    let failpoint = optional(args, "--failpoint")
        .map(parse_failpoint)
        .transpose()?
        .unwrap_or(PublishFailpoint::None);
    let (kernel, _) = Kernel::open(database)?;
    replace_with_authoritative_fence(&kernel, &mut publication)?;
    let report = kernel.publish_with_failpoint(publication, failpoint)?;
    print_json(json!({
        "command": "publish",
        "generation": report.generation,
        "digest": report.digest,
        "persistenceNs": report.persistence_ns,
        "memoryPublishNs": report.memory_publish_ns,
        "alreadyPublished": report.already_published,
    }))
}

fn measure(args: &[String]) -> Result<()> {
    require_only(args, &["--db", "--publication", "--iterations"])?;
    let database = required(args, "--db")?;
    let publication_path = required(args, "--publication")?;
    let iterations: u64 = required(args, "--iterations")?
        .parse()
        .context("iterations must be an unsigned integer")?;
    if iterations == 0 {
        bail!("iterations must be greater than zero");
    }

    let template: Publication = read_json(publication_path, "publication")?;
    let resources: Vec<String> = template.fence.resource_tokens.keys().cloned().collect();
    let recovery_started = Instant::now();
    let (kernel, recovery_report) = Kernel::open(database)?;
    let recovery_ns = recovery_started.elapsed().as_nanos();
    let initial_snapshot = kernel.snapshot().snapshot();
    let started = Instant::now();
    let mut last = None;
    let mut publication_persistence_ns = Vec::with_capacity(iterations as usize);
    let mut memory_publish_ns = Vec::with_capacity(iterations as usize);
    for _ in 0..iterations {
        let mut publication = template.clone();
        let base_generation = kernel.snapshot().generation();
        let next_generation = base_generation
            .checked_add(1)
            .context("graph generation overflow")?;
        let identity_suffix = format!("measure:g{next_generation}");
        publication.delta.base_generation = base_generation;
        publication.idempotency_key = format!("{}:{identity_suffix}", template.idempotency_key);
        publication.operation.operation_id =
            format!("{}:{identity_suffix}", template.operation.operation_id);
        publication.operation.change_set_id =
            format!("{}:{identity_suffix}", template.operation.change_set_id);
        publication.ticket.ticket_id = format!("{}:{identity_suffix}", template.ticket.ticket_id);
        publication.event.event_id = format!("{}:{identity_suffix}", template.event.event_id);
        publication.event.sequence = next_generation;
        publication.event.graph_generation = next_generation;
        publication.event.payload_json = serde_json::to_string(&json!({
            "operationId": publication.operation.operation_id,
        }))?;
        publication.fence = kernel.issue_fence(&resources)?;
        let report = kernel.publish(publication)?;
        publication_persistence_ns.push(report.persistence_ns);
        memory_publish_ns.push(report.memory_publish_ns);
        last = Some(report);
    }
    let total_ns = started.elapsed().as_nanos();
    let report = last.context("measure completed without a publication")?;
    let current_snapshot = kernel.snapshot().snapshot();
    let redb_file_bytes = fs::metadata(database)
        .with_context(|| format!("stat redb database {database}"))?
        .len();
    print_json(json!({
        "command": "measure",
        "iterations": iterations,
        "generation": report.generation,
        "digest": report.digest,
        "recoveryNs": recovery_ns,
        "replayedOperations": recovery_report.replayed_operations,
        "initialNodeCount": initial_snapshot.nodes.len(),
        "initialReferenceCount": initial_snapshot.references.len(),
        "currentNodeCount": current_snapshot.nodes.len(),
        "currentReferenceCount": current_snapshot.references.len(),
        "publicationPersistenceNs": nearest_rank_distribution(publication_persistence_ns),
        "memoryPublishNs": nearest_rank_distribution(memory_publish_ns),
        "redbFileBytes": redb_file_bytes,
        "totalNs": total_ns,
        "averageNs": total_ns / u128::from(iterations),
    }))
}

fn nearest_rank_distribution(mut samples: Vec<u128>) -> serde_json::Value {
    samples.sort_unstable();
    let nearest_rank = |percent: usize| {
        let rank = (percent * samples.len()).div_ceil(100);
        samples[rank.saturating_sub(1)]
    };
    json!({
        "p50": nearest_rank(50),
        "p95": nearest_rank(95),
        "max": samples[samples.len() - 1],
    })
}

fn replace_with_authoritative_fence(kernel: &Kernel, publication: &mut Publication) -> Result<()> {
    let resources: Vec<String> = publication.fence.resource_tokens.keys().cloned().collect();
    publication.fence = kernel.issue_fence(&resources)?;
    Ok(())
}

fn parse_failpoint(value: &str) -> Result<PublishFailpoint> {
    PublishFailpoint::from_boundary_name(value)
        .with_context(|| format!("unknown publish failpoint {value}"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &str, label: &str) -> Result<T> {
    let bytes = fs::read(Path::new(path)).with_context(|| format!("read {label} from {path}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("decode {label} from {path}"))
}

fn required<'a>(args: &'a [String], flag: &str) -> Result<&'a str> {
    optional(args, flag).with_context(|| format!("missing required option {flag}"))
}

fn optional<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.chunks_exact(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
}

fn require_only(args: &[String], allowed: &[&str]) -> Result<()> {
    if args.len() % 2 != 0 {
        bail!("every option must have a value");
    }
    for pair in args.chunks_exact(2) {
        if !allowed.contains(&pair[0].as_str()) {
            bail!("unknown option {}", pair[0]);
        }
    }
    Ok(())
}

fn print_json(value: serde_json::Value) -> Result<()> {
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::nearest_rank_distribution;

    #[test]
    fn nearest_rank_distribution_uses_every_sample() {
        let distribution = nearest_rank_distribution(vec![
            20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10,
        ]);

        assert_eq!(distribution["p50"].as_u64(), Some(10));
        assert_eq!(distribution["p95"].as_u64(), Some(19));
        assert_eq!(distribution["max"].as_u64(), Some(20));
    }
}
