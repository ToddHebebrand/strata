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
    let (_, report) = Kernel::create(database, snapshot)?;
    print_json(json!({
        "command": "seed",
        "generation": report.generation,
        "digest": report.digest,
        "serviceEpoch": report.service_epoch,
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
        "affectedNodes": affected_node_ids.len(),
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
    let (kernel, _) = Kernel::open(database)?;
    let started = Instant::now();
    let mut last = None;
    for iteration in 0..iterations {
        let mut publication = template.clone();
        let base_generation = kernel.snapshot().generation();
        let next_generation = base_generation
            .checked_add(1)
            .context("graph generation overflow")?;
        publication.delta.base_generation = base_generation;
        publication.idempotency_key = format!("{}:measure:{iteration}", template.idempotency_key);
        publication.operation.operation_id =
            format!("{}:measure:{iteration}", template.operation.operation_id);
        publication.operation.change_set_id =
            format!("{}:measure:{iteration}", template.operation.change_set_id);
        publication.ticket.ticket_id = format!("{}:measure:{iteration}", template.ticket.ticket_id);
        publication.event.event_id = format!("{}:measure:{iteration}", template.event.event_id);
        publication.event.sequence = next_generation;
        publication.event.graph_generation = next_generation;
        publication.event.payload_json = serde_json::to_string(&json!({
            "operationId": publication.operation.operation_id,
        }))?;
        publication.fence = kernel.issue_fence(&resources)?;
        last = Some(kernel.publish(publication)?);
    }
    let total_ns = started.elapsed().as_nanos();
    let report = last.context("measure completed without a publication")?;
    print_json(json!({
        "command": "measure",
        "iterations": iterations,
        "generation": report.generation,
        "digest": report.digest,
        "totalNs": total_ns,
        "averageNs": total_ns / u128::from(iterations),
    }))
}

fn replace_with_authoritative_fence(kernel: &Kernel, publication: &mut Publication) -> Result<()> {
    let resources: Vec<String> = publication.fence.resource_tokens.keys().cloned().collect();
    publication.fence = kernel.issue_fence(&resources)?;
    Ok(())
}

fn parse_failpoint(value: &str) -> Result<PublishFailpoint> {
    match value {
        "beforeRedbTransaction" => Ok(PublishFailpoint::BeforeRedbTransaction),
        "insideRedbTransaction" => Ok(PublishFailpoint::InsideRedbTransaction),
        "afterRedbCommitBeforeMemoryPublish" => {
            Ok(PublishFailpoint::AfterRedbCommitBeforeMemoryPublish)
        }
        "afterMemoryPublish" => Ok(PublishFailpoint::AfterMemoryPublish),
        other => bail!("unknown publish failpoint {other}"),
    }
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
