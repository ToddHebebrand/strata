//! The validation manifest: an operator-authored, digested description of
//! how a daemon session validates candidates (B-2 behavioral gate).
//!
//! Without `--validation-manifest` a session runs `tscOnly` exactly as
//! before B-2 (see `session::ValidationSettings`'s no-flag construction in
//! `main.rs` — a byte-identical guarantee). With the flag, this module
//! reads, strictly parses, and validates the manifest file, then verifies
//! every declared fixture actually exists under the corpus root (review
//! Major 9: CANONICALIZED and contained, checked BEFORE any fixture content
//! is read) and matches its declared sha256. Nothing here wires the result
//! into an actual validation run yet — Task 6 threads the timeouts into the
//! bridge, Task 7 wires seed-green, Task 10 wires the fixture reader.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::protocol::{MAX_DEADLINE_MS, validate_module_path};

/// Fixed overhead the daemon adds on top of a candidate's own tsc+vitest
/// budget before it reaches the wire's `MAX_DEADLINE_MS` (Task 6 spends
/// this on process-group teardown and result plumbing).
pub(super) const CANDIDATE_OVERHEAD_MS: u64 = 30_000;
/// Allowance for the request to sit behind other work before a worker even
/// starts running the candidate.
pub(super) const QUEUE_ALLOWANCE_MS: u64 = 30_000;
/// `tscOnly` (no `--validation-manifest`) default tsc timeout — unchanged
/// from the pre-B-2 hardcoded worker budget.
pub(super) const DEFAULT_TSC_TIMEOUT_MS: u64 = 60_000;
/// `tscOnly` default vitest timeout. Unused while `tscOnly` carries no
/// fixtures, but kept alongside the tsc default so `ValidationSettings`'s
/// no-flag construction has one authoritative source for both.
pub(super) const DEFAULT_VITEST_TIMEOUT_MS: u64 = 90_000;

const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 180_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ManifestMode {
    TscOnly,
    Behavioral,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManifestFixture {
    /// Corpus-relative POSIX path (`validate_module_path` rules), whose
    /// first segment must be `test` or `tests` and whose file name must
    /// contain `.test.` or `.spec.` — a behavioral fixture is always a test
    /// file, never arbitrary corpus content.
    pub(super) path: String,
    /// 64 lowercase hex sha256 of the fixture file's bytes, checked against
    /// the canonicalized, containment-verified file on disk.
    pub(super) sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ValidationManifest {
    /// Must be `1`; any other value is a load-time error (forward
    /// compatibility gate, not silently ignored).
    pub(super) schema_version: u32,
    pub(super) mode: ManifestMode,
    pub(super) strict_src_only_tsc_scope: bool,
    /// Bounds: `1_000..=180_000`.
    pub(super) tsc_timeout_ms: u64,
    /// Bounds: `1_000..=180_000`.
    pub(super) vitest_timeout_ms: u64,
    /// Unique, normalized paths. `behavioral` requires at least one;
    /// `tscOnly` requires exactly zero.
    pub(super) fixtures: Vec<ManifestFixture>,
}

/// The outcome of a successful `load_validation_manifest`: the parsed
/// manifest, its digest, and (review Major 9) the canonicalized, contained
/// path backing each fixture — the verified identity that a later reader
/// must serve from (index-aligned with `manifest.fixtures`), re-verifying
/// containment on every read rather than trusting this snapshot forever.
// `manifest` and `canonical_fixture_paths` are not yet read outside tests —
// Task 6 consumes the timeouts inside `manifest`, Task 10 the canonical
// paths. Both are load-bearing return values of a `pub(super)` function, not
// dead code; the lint just can't see the future caller yet.
#[allow(dead_code)]
#[derive(Debug)]
pub(super) struct LoadedManifest {
    pub(super) manifest: ValidationManifest,
    /// sha256 hex of `serde_json::to_vec(&manifest)` — deterministic
    /// because serde's derived `Serialize` walks fields in struct-definition
    /// order, not lexically or via a `HashMap`.
    pub(super) digest: String,
    /// Canonical absolute path per fixture, same order/index as
    /// `manifest.fixtures`.
    pub(super) canonical_fixture_paths: Vec<PathBuf>,
}

/// Reads, strictly parses, and validates a validation manifest against a
/// corpus root.
///
/// Order matters (review Major 9): every lexical/structural check (schema
/// version, mode invariants, timeout bounds, nesting bound, fixture path
/// shape, sha256 format, duplicate paths) runs first and touches no
/// filesystem state beyond the manifest file itself. Only once every lexical
/// check passes does this canonicalize the corpus root and each fixture path
/// and enforce containment — BEFORE any fixture content is read. A fixture
/// that resolves (via a symlink or otherwise) outside the canonical corpus
/// root fails startup without ever being opened for hashing.
pub(super) fn load_validation_manifest(path: &Path, corpus_root: &Path) -> Result<LoadedManifest> {
    let bytes = fs::read(path)
        .with_context(|| format!("read validation manifest {}", path.display()))?;
    let manifest: ValidationManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse validation manifest {}", path.display()))?;

    ensure!(
        manifest.schema_version == 1,
        "validation manifest schemaVersion must be 1, got {}",
        manifest.schema_version
    );

    match manifest.mode {
        ManifestMode::Behavioral => ensure!(
            !manifest.fixtures.is_empty(),
            "behavioral validation manifest requires at least one fixture"
        ),
        ManifestMode::TscOnly => ensure!(
            manifest.fixtures.is_empty(),
            "tscOnly validation manifest must not carry behavioral fixtures"
        ),
    }

    for (label, value) in [
        ("tscTimeoutMs", manifest.tsc_timeout_ms),
        ("vitestTimeoutMs", manifest.vitest_timeout_ms),
    ] {
        ensure!(
            (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&value),
            "validation manifest {label} must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} ms, got {value}"
        );
    }

    let nested_ms = manifest
        .tsc_timeout_ms
        .checked_add(manifest.vitest_timeout_ms)
        .and_then(|value| value.checked_add(CANDIDATE_OVERHEAD_MS))
        .and_then(|value| value.checked_add(QUEUE_ALLOWANCE_MS))
        .context("validation manifest timeout nesting overflowed u64")?;
    ensure!(
        nested_ms <= MAX_DEADLINE_MS,
        "validation manifest tscTimeoutMs + vitestTimeoutMs + {CANDIDATE_OVERHEAD_MS}ms overhead + \
         {QUEUE_ALLOWANCE_MS}ms queue allowance = {nested_ms}ms exceeds the {MAX_DEADLINE_MS}ms wire deadline bound"
    );

    let mut seen_paths = BTreeSet::new();
    for fixture in &manifest.fixtures {
        validate_fixture_path(&fixture.path)?;
        validate_sha256(&fixture.sha256)?;
        ensure!(
            seen_paths.insert(fixture.path.clone()),
            "duplicate fixture path {}",
            fixture.path
        );
    }

    // Review Major 9 (v2): canonicalize the corpus root and every fixture
    // path and enforce containment BEFORE any fixture content is read. This
    // must run after every lexical check above (so a malformed manifest
    // fails on its own shape, cheaply, before touching the filesystem) and
    // before the sha256 verification loop below (so a symlinked fixture
    // that escapes the root is never opened for hashing).
    let canonical_root = fs::canonicalize(corpus_root).with_context(|| {
        format!(
            "canonicalize validation corpus root {}",
            corpus_root.display()
        )
    })?;
    let mut canonical_fixture_paths = Vec::with_capacity(manifest.fixtures.len());
    for fixture in &manifest.fixtures {
        let candidate = corpus_root.join(&fixture.path);
        let canonical = fs::canonicalize(&candidate).with_context(|| {
            format!(
                "fixture {} does not exist under corpus root {}",
                fixture.path,
                corpus_root.display()
            )
        })?;
        ensure!(
            canonical.starts_with(&canonical_root),
            "fixture {} escapes the canonical corpus root {}",
            fixture.path,
            canonical_root.display()
        );
        canonical_fixture_paths.push(canonical);
    }

    for (fixture, canonical_path) in manifest.fixtures.iter().zip(canonical_fixture_paths.iter()) {
        let contents = fs::read(canonical_path)
            .with_context(|| format!("read fixture {} for sha256 verification", fixture.path))?;
        let actual = format!("{:x}", Sha256::digest(&contents));
        ensure!(
            actual == fixture.sha256,
            "fixture {} sha256 mismatch: manifest declares {}, file hashes to {actual}",
            fixture.path,
            fixture.sha256
        );
    }

    // Computed from the manifest AS PARSED — the digest is the file's
    // canonical content identity, not a function of the filesystem it was
    // verified against. Derived `Serialize` walks fields in struct-
    // definition order, so this is deterministic across loads.
    let digest_bytes =
        serde_json::to_vec(&manifest).context("serialize validation manifest for digest")?;
    let digest = format!("{:x}", Sha256::digest(&digest_bytes));

    Ok(LoadedManifest {
        manifest,
        digest,
        canonical_fixture_paths,
    })
}

/// `path` rules: `validate_module_path` (corpus-relative POSIX, no
/// absolute/`..`/empty segments) PLUS a behavioral-fixture-specific shape —
/// first segment `test` or `tests`, and a file name containing `.test.` or
/// `.spec.` — so a fixture is always recognizably a test file, never
/// arbitrary corpus content smuggled in under a plausible-looking path.
fn validate_fixture_path(path: &str) -> Result<()> {
    validate_module_path(path)?;
    let first_segment = path.split('/').next().unwrap_or_default();
    ensure!(
        first_segment == "test" || first_segment == "tests",
        "fixture path must start with test/ or tests/: {path}"
    );
    let file_name = path.rsplit('/').next().unwrap_or(path);
    ensure!(
        file_name.contains(".test.") || file_name.contains(".spec."),
        "fixture path must be a .test. or .spec. file: {path}"
    );
    Ok(())
}

fn validate_sha256(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture sha256 must be 64 lowercase hexadecimal characters, got {value:?}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    const FIXTURE_CONTENTS: &[u8] = b"export const ok = true;\n";
    const FIXTURE_RELATIVE_PATH: &str = "tests/sample.test.ts";

    fn fixture_sha256() -> String {
        format!("{:x}", Sha256::digest(FIXTURE_CONTENTS))
    }

    /// A tempdir corpus with one real fixture file at
    /// `tests/sample.test.ts`, whose sha256 is `fixture_sha256()`.
    fn corpus_with_fixture() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let tests_dir = dir.path().join("tests");
        fs::create_dir_all(&tests_dir).unwrap();
        fs::write(tests_dir.join("sample.test.ts"), FIXTURE_CONTENTS).unwrap();
        dir
    }

    fn behavioral_manifest_json(
        tsc_timeout_ms: u64,
        vitest_timeout_ms: u64,
        strict_src_only_tsc_scope: bool,
        fixture_path: &str,
        fixture_sha256: &str,
    ) -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "mode": "behavioral",
            "strictSrcOnlyTscScope": strict_src_only_tsc_scope,
            "tscTimeoutMs": tsc_timeout_ms,
            "vitestTimeoutMs": vitest_timeout_ms,
            "fixtures": [
                { "path": fixture_path, "sha256": fixture_sha256 }
            ],
        })
    }

    fn write_manifest(dir: &TempDir, value: &serde_json::Value) -> PathBuf {
        let path = dir.path().join("validation-manifest.json");
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }

    #[test]
    fn valid_behavioral_manifest_round_trips_with_a_stable_digest() {
        let dir = corpus_with_fixture();
        let value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        let path = write_manifest(&dir, &value);

        let first =
            load_validation_manifest(&path, dir.path()).expect("valid manifest must load");
        let second =
            load_validation_manifest(&path, dir.path()).expect("valid manifest must load again");
        assert_eq!(
            first.digest, second.digest,
            "identical bytes must digest identically"
        );
        assert_eq!(first.digest.len(), 64);
        assert!(first.digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(first.canonical_fixture_paths.len(), 1);
        assert!(first.canonical_fixture_paths[0].is_absolute());

        let mut mutated = value.clone();
        mutated["strictSrcOnlyTscScope"] = json!(false);
        let mutated_path = write_manifest(&dir, &mutated);
        let third = load_validation_manifest(&mutated_path, dir.path())
            .expect("mutated manifest must load");
        assert_ne!(
            first.digest, third.digest,
            "a field mutation must change the digest"
        );
    }

    #[test]
    fn zero_fixture_behavioral_manifest_is_rejected() {
        let dir = corpus_with_fixture();
        let value = json!({
            "schemaVersion": 1,
            "mode": "behavioral",
            "strictSrcOnlyTscScope": true,
            "tscTimeoutMs": 60_000,
            "vitestTimeoutMs": 90_000,
            "fixtures": [],
        });
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("fixture"),
            "{error:#}"
        );
    }

    #[test]
    fn fixture_carrying_tsc_only_manifest_is_rejected() {
        let dir = corpus_with_fixture();
        let mut value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        value["mode"] = json!("tscOnly");
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("fixture"),
            "{error:#}"
        );
    }

    #[test]
    fn duplicate_fixture_path_is_rejected() {
        let dir = corpus_with_fixture();
        let mut value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        value["fixtures"] = json!([
            { "path": FIXTURE_RELATIVE_PATH, "sha256": fixture_sha256() },
            { "path": FIXTURE_RELATIVE_PATH, "sha256": fixture_sha256() },
        ]);
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("duplicate"),
            "{error:#}"
        );
    }

    #[test]
    fn wrong_sha256_is_rejected() {
        let dir = corpus_with_fixture();
        let wrong = "0".repeat(64);
        let value =
            behavioral_manifest_json(60_000, 90_000, true, FIXTURE_RELATIVE_PATH, &wrong);
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        assert!(
            error.to_string().to_lowercase().contains("sha256"),
            "{error:#}"
        );
    }

    #[test]
    fn missing_fixture_file_is_rejected() {
        let dir = corpus_with_fixture();
        let value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            "tests/does-not-exist.test.ts",
            &fixture_sha256(),
        );
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        let message = error.to_string().to_lowercase();
        assert!(message.contains("exist"), "{error:#}");
    }

    #[test]
    fn absolute_and_dot_dot_fixture_paths_are_rejected() {
        let dir = corpus_with_fixture();
        for bad_path in [
            "/etc/passwd",
            "tests/../secret.test.ts",
            "../tests/sample.test.ts",
        ] {
            let value =
                behavioral_manifest_json(60_000, 90_000, true, bad_path, &fixture_sha256());
            let path = write_manifest(&dir, &value);
            assert!(
                load_validation_manifest(&path, dir.path()).is_err(),
                "{bad_path:?} must be rejected"
            );
        }
    }

    #[test]
    fn fixture_path_must_be_under_test_dir_and_a_test_or_spec_file() {
        let dir = corpus_with_fixture();
        fs::write(
            dir.path().join("tests").join("not-a-test-file.ts"),
            FIXTURE_CONTENTS,
        )
        .unwrap();
        let src_dir = dir.path().join("src");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("sample.test.ts"), FIXTURE_CONTENTS).unwrap();
        for bad_path in ["tests/not-a-test-file.ts", "src/sample.test.ts"] {
            let value =
                behavioral_manifest_json(60_000, 90_000, true, bad_path, &fixture_sha256());
            let path = write_manifest(&dir, &value);
            assert!(
                load_validation_manifest(&path, dir.path()).is_err(),
                "{bad_path:?} must be rejected"
            );
        }
    }

    #[test]
    fn timeout_of_zero_and_of_200_000_are_rejected() {
        let dir = corpus_with_fixture();
        for bad_timeout in [0u64, 200_000] {
            let value = behavioral_manifest_json(
                bad_timeout,
                90_000,
                true,
                FIXTURE_RELATIVE_PATH,
                &fixture_sha256(),
            );
            let path = write_manifest(&dir, &value);
            assert!(
                load_validation_manifest(&path, dir.path()).is_err(),
                "tsc timeout {bad_timeout} must be rejected"
            );

            let value = behavioral_manifest_json(
                60_000,
                bad_timeout,
                true,
                FIXTURE_RELATIVE_PATH,
                &fixture_sha256(),
            );
            let path = write_manifest(&dir, &value);
            assert!(
                load_validation_manifest(&path, dir.path()).is_err(),
                "vitest timeout {bad_timeout} must be rejected"
            );
        }
    }

    #[test]
    fn nesting_bound_violation_is_rejected() {
        let dir = corpus_with_fixture();
        // 150_000 + 150_000 + CANDIDATE_OVERHEAD_MS + QUEUE_ALLOWANCE_MS
        // = 360_000 > 300_000.
        let value = behavioral_manifest_json(
            150_000,
            150_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        let message = error.to_string().to_lowercase();
        assert!(
            message.contains("deadline") || message.contains("300"),
            "{error:#}"
        );
    }

    #[test]
    fn unknown_json_field_is_rejected() {
        let dir = corpus_with_fixture();
        let mut value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        value["unexpectedField"] = json!(true);
        let path = write_manifest(&dir, &value);
        assert!(load_validation_manifest(&path, dir.path()).is_err());
    }

    #[test]
    fn wrong_schema_version_is_rejected() {
        let dir = corpus_with_fixture();
        let mut value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            FIXTURE_RELATIVE_PATH,
            &fixture_sha256(),
        );
        value["schemaVersion"] = json!(2);
        let path = write_manifest(&dir, &value);
        assert!(load_validation_manifest(&path, dir.path()).is_err());
    }

    /// Review Major 9 (v2): a fixture path that lexically stays inside the
    /// corpus but is a symlink resolving OUTSIDE the canonical corpus root
    /// must fail startup — and must never be hashed. macOS/unix-only
    /// (`std::os::unix::fs::symlink`), matching this repo's platform.
    #[test]
    fn symlinked_fixture_escaping_the_corpus_root_is_rejected() {
        let dir = corpus_with_fixture();
        let outside = tempfile::tempdir().unwrap();
        let secret_path = outside.path().join("secret.test.ts");
        fs::write(&secret_path, b"outside content").unwrap();
        let escape_link = dir.path().join("tests").join("escape.test.ts");
        symlink(&secret_path, &escape_link).unwrap();
        // A sha256 that matches the OUTSIDE file's real content: if
        // containment were checked after hashing (or not at all), this
        // manifest would load successfully and quietly bless the escape.
        let matching_sha256 = format!("{:x}", Sha256::digest(b"outside content"));
        let value = behavioral_manifest_json(
            60_000,
            90_000,
            true,
            "tests/escape.test.ts",
            &matching_sha256,
        );
        let path = write_manifest(&dir, &value);
        let error = load_validation_manifest(&path, dir.path()).unwrap_err();
        let message = error.to_string().to_lowercase();
        assert!(
            message.contains("escap") || message.contains("corpus root"),
            "{error:#}"
        );
    }
}
