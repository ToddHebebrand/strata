use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use strata_kernel::{DurableStore, GraphSnapshot, Kernel};
use tempfile::tempdir;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_redb-spike")
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/examples-medium.snapshot.json")
}

fn run(args: &[&str]) -> Output {
    Command::new(binary()).args(args).output().unwrap()
}

fn run_json(args: &[&str]) -> Value {
    let output = run(args);
    assert!(
        output.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn process_crashes_recover_only_durably_committed_generations() {
    let cases = [
        ("beforeRedbTransaction", 0_u64),
        ("insideRedbTransaction", 0_u64),
        ("afterRedbCommitBeforeMemoryPublish", 1_u64),
        ("afterMemoryPublish", 1_u64),
    ];

    for (failpoint, expected_generation) in cases {
        let directory = tempdir().unwrap();
        let database = directory.path().join("kernel.redb");
        let publication = directory.path().join("rename-publication.json");
        let database_arg = database.to_str().unwrap();
        let fixture = fixture();
        let fixture_arg = fixture.to_str().unwrap();
        let publication_arg = publication.to_str().unwrap();

        run_json(&["seed", "--db", database_arg, "--snapshot", fixture_arg]);
        run_json(&[
            "make-rename-publication",
            "--snapshot",
            fixture_arg,
            "--out",
            publication_arg,
        ]);

        let crashed = run(&[
            "publish",
            "--db",
            database_arg,
            "--publication",
            publication_arg,
            "--failpoint",
            failpoint,
        ]);
        assert!(
            !crashed.status.success(),
            "failpoint {failpoint} unexpectedly exited successfully"
        );

        let inspected = run_json(&["inspect", "--db", database_arg]);
        let (independently_replayed, report) = Kernel::open(&database).unwrap();
        assert_eq!(report.generation, expected_generation, "{failpoint}");
        assert_eq!(
            inspected["generation"].as_u64(),
            Some(expected_generation),
            "{failpoint}"
        );
        assert_eq!(
            inspected["digest"].as_str(),
            Some(independently_replayed.snapshot().digest()),
            "{failpoint}"
        );
    }
}

#[test]
fn measure_events_reference_their_same_iteration_operations() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("kernel.redb");
    let publication = directory.path().join("rename-publication.json");
    let database_arg = database.to_str().unwrap();
    let fixture = fixture();
    let fixture_arg = fixture.to_str().unwrap();
    let publication_arg = publication.to_str().unwrap();

    run_json(&["seed", "--db", database_arg, "--snapshot", fixture_arg]);
    run_json(&[
        "make-rename-publication",
        "--snapshot",
        fixture_arg,
        "--out",
        publication_arg,
    ]);
    run_json(&[
        "measure",
        "--db",
        database_arg,
        "--publication",
        publication_arg,
        "--iterations",
        "2",
    ]);

    let store = DurableStore::open(&database).unwrap();
    for generation in 1..=2 {
        let operation = store.operation(generation).unwrap().unwrap();
        let event = store.event(generation).unwrap().unwrap();
        let payload: Value = serde_json::from_str(&event.payload_json).unwrap();
        assert_eq!(
            payload["operationId"].as_str(),
            Some(operation.operation_id.as_str()),
            "generation {generation} event must link to its operation"
        );
    }
}

fn assert_ordered_distribution(value: &Value, field: &str) {
    let distribution = &value[field];
    let p50 = distribution["p50"].as_u64().unwrap();
    let p95 = distribution["p95"].as_u64().unwrap();
    let max = distribution["max"].as_u64().unwrap();
    assert!(p50 <= p95, "{field} p50 must not exceed p95");
    assert!(p95 <= max, "{field} p95 must not exceed max");
}

#[test]
fn seed_and_measure_emit_complete_evidence_metrics() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("kernel.redb");
    let publication = directory.path().join("rename-publication.json");
    let database_arg = database.to_str().unwrap();
    let fixture = fixture();
    let fixture_arg = fixture.to_str().unwrap();
    let publication_arg = publication.to_str().unwrap();
    let fixture_snapshot: GraphSnapshot =
        serde_json::from_slice(&fs::read(&fixture).unwrap()).unwrap();

    let seeded = run_json(&["seed", "--db", database_arg, "--snapshot", fixture_arg]);
    assert!(seeded["seedNs"].as_u64().unwrap() > 0);
    assert_eq!(
        seeded["nodeCount"].as_u64(),
        Some(fixture_snapshot.nodes.len() as u64)
    );
    assert_eq!(
        seeded["referenceCount"].as_u64(),
        Some(fixture_snapshot.references.len() as u64)
    );
    assert!(seeded["redbFileBytes"].as_u64().unwrap() > 0);

    run_json(&[
        "make-rename-publication",
        "--snapshot",
        fixture_arg,
        "--out",
        publication_arg,
    ]);
    let measured = run_json(&[
        "measure",
        "--db",
        database_arg,
        "--publication",
        publication_arg,
        "--iterations",
        "2",
    ]);

    assert!(measured["recoveryNs"].as_u64().unwrap() > 0);
    assert_eq!(measured["replayedOperations"].as_u64(), Some(0));
    assert_eq!(measured["initialNodeCount"], measured["currentNodeCount"]);
    assert_eq!(
        measured["initialReferenceCount"],
        measured["currentReferenceCount"]
    );
    assert_eq!(measured["initialNodeCount"], seeded["nodeCount"]);
    assert_eq!(measured["initialReferenceCount"], seeded["referenceCount"]);
    assert!(measured["redbFileBytes"].as_u64().unwrap() > 0);
    assert_ordered_distribution(&measured, "publicationPersistenceNs");
    assert_ordered_distribution(&measured, "memoryPublishNs");
    assert_eq!(measured["generation"].as_u64(), Some(2));
    assert_eq!(measured["iterations"].as_u64(), Some(2));
    assert_eq!(measured["digest"].as_str().unwrap().len(), 64);
}

#[test]
fn consecutive_measure_runs_publish_distinct_generations_and_records() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("kernel.redb");
    let publication = directory.path().join("rename-publication.json");
    let database_arg = database.to_str().unwrap();
    let fixture = fixture();
    let fixture_arg = fixture.to_str().unwrap();
    let publication_arg = publication.to_str().unwrap();

    run_json(&["seed", "--db", database_arg, "--snapshot", fixture_arg]);
    run_json(&[
        "make-rename-publication",
        "--snapshot",
        fixture_arg,
        "--out",
        publication_arg,
    ]);
    let first = run_json(&[
        "measure",
        "--db",
        database_arg,
        "--publication",
        publication_arg,
        "--iterations",
        "2",
    ]);
    let second = run_json(&[
        "measure",
        "--db",
        database_arg,
        "--publication",
        publication_arg,
        "--iterations",
        "2",
    ]);

    assert_eq!(first["generation"].as_u64(), Some(2));
    assert_eq!(second["generation"].as_u64(), Some(4));
    for result in [&first, &second] {
        assert!(result["publicationPersistenceNs"]["p50"].as_u64().unwrap() > 0);
        assert!(result["memoryPublishNs"]["p50"].as_u64().unwrap() > 0);
    }

    let store = DurableStore::open(&database).unwrap();
    let mut operation_ids = BTreeSet::new();
    let mut event_ids = BTreeSet::new();
    for generation in 1..=4 {
        let operation = store.operation(generation).unwrap().unwrap();
        let event = store.event(generation).unwrap().unwrap();
        let payload: Value = serde_json::from_str(&event.payload_json).unwrap();
        assert_eq!(
            payload["operationId"].as_str(),
            Some(operation.operation_id.as_str())
        );
        operation_ids.insert(operation.operation_id);
        event_ids.insert(event.event_id);
    }
    assert_eq!(operation_ids.len(), 4);
    assert_eq!(event_ids.len(), 4);
}
