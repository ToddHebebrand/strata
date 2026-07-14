use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use strata_kernel::Kernel;
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
