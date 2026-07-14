use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use strata_kernel::{DurableStore, GraphSnapshot, Kernel, Publication};
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
        let expected_publication: Publication =
            serde_json::from_slice(&fs::read(&publication).unwrap()).unwrap();

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
        let recovered_digest = independently_replayed.snapshot().digest().to_owned();
        assert_eq!(report.generation, expected_generation, "{failpoint}");
        assert_eq!(
            inspected["generation"].as_u64(),
            Some(expected_generation),
            "{failpoint}"
        );
        assert_eq!(
            inspected["digest"].as_str(),
            Some(recovered_digest.as_str()),
            "{failpoint}"
        );
        drop(independently_replayed);

        let store = DurableStore::open(&database).unwrap();
        let operation = store.operation(1).unwrap();
        let delta = store.delta(1).unwrap();
        let event = store.event(1).unwrap();
        let ticket = store
            .ticket(&expected_publication.ticket.ticket_id)
            .unwrap();
        let idempotency_generation = store
            .idempotency_generation(&expected_publication.idempotency_key)
            .unwrap();
        let was_published = store
            .was_published(&expected_publication.idempotency_key)
            .unwrap();
        let generation_one_digest = store.generation_digest(1);
        let (current_fence, consumed_fence) = store.fence_state("symbol:User").unwrap();

        if expected_generation == 0 {
            assert!(operation.is_none(), "{failpoint}");
            assert!(delta.is_none(), "{failpoint}");
            assert!(event.is_none(), "{failpoint}");
            assert!(ticket.is_none(), "{failpoint}");
            assert!(idempotency_generation.is_none(), "{failpoint}");
            assert!(!was_published, "{failpoint}");
            assert!(generation_one_digest.is_err(), "{failpoint}");
            assert!(current_fence.is_some_and(|token| token > 0), "{failpoint}");
            assert_eq!(consumed_fence, None, "{failpoint}");
        } else {
            assert_eq!(
                operation,
                Some(expected_publication.operation.clone()),
                "{failpoint}"
            );
            assert_eq!(
                delta,
                Some(expected_publication.delta.clone()),
                "{failpoint}"
            );
            assert_eq!(
                event,
                Some(expected_publication.event.clone()),
                "{failpoint}"
            );
            assert_eq!(
                ticket,
                Some(expected_publication.ticket.clone()),
                "{failpoint}"
            );
            assert_eq!(idempotency_generation, Some(1), "{failpoint}");
            assert!(was_published, "{failpoint}");
            assert_eq!(
                generation_one_digest.unwrap(),
                recovered_digest,
                "{failpoint}"
            );
            assert!(current_fence.is_some_and(|token| token > 0), "{failpoint}");
            assert!(consumed_fence.is_some_and(|token| token > 0), "{failpoint}");
            assert_eq!(consumed_fence, current_fence, "{failpoint}");
        }
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
    let publication_summary = run_json(&[
        "make-rename-publication",
        "--snapshot",
        fixture_arg,
        "--out",
        publication_arg,
    ]);
    let publication_json: Value = serde_json::from_slice(&fs::read(&publication).unwrap()).unwrap();
    assert_eq!(
        publication_summary["affectedNodeCount"].as_u64(),
        Some(
            publication_json["operation"]["affectedNodeIds"]
                .as_array()
                .unwrap()
                .len() as u64
        )
    );
    assert!(publication_summary.get("affectedNodes").is_none());
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
