use std::path::Path;

use anyhow::{Result, bail};

use super::protocol::MAX_MODULE_PATH_BYTES;

/// Derives the corpus-relative POSIX display path for one Module payload.
///
/// Fail-closed contract (item-B spec, review Major): payloads may be
/// corpus-relative POSIX paths (the seeded form) or physical ABSOLUTE paths
/// (recorded harness precedent). Anything else — escape outside the
/// canonical corpus root, `.`/`..`/empty segments, backslashes, an empty
/// projection, an over-long projection — is an error, and NO error path may
/// embed the raw payload. Projection is lexical over raw `/`-separated
/// segments: the payload is never touched on the filesystem, so results are
/// deterministic for nodes whose rendered file does not currently exist,
/// and an absolute payload that only matches the corpus root through a
/// symlink alias fails closed by design.
pub(super) fn project_module_path(
    canonical_corpus_root: &Path,
    payload: &str,
) -> Result<String> {
    if payload.is_empty() {
        bail!("module payload is empty");
    }
    if payload.contains('\\') {
        bail!("module payload contains a backslash");
    }
    let relative = if let Some(stripped) = payload.strip_prefix('/') {
        // A corpus root of `/` (filesystem root) is unsupported by this
        // prefix chain by design: `std::fs::canonicalize` never returns a
        // trailing slash for a non-root path, so the `strip_prefix('/')`
        // boundary check below assumes `root != "/"` to distinguish "is the
        // root" from "is a proper descendant."
        let root = canonical_corpus_root
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("corpus root is not valid UTF-8"))?;
        let root_relative = format!("/{stripped}");
        let Some(remainder) = root_relative.strip_prefix(root) else {
            bail!("module payload escapes the corpus root");
        };
        let Some(remainder) = remainder.strip_prefix('/') else {
            // Either the payload IS the root, or the prefix match ended
            // mid-segment (e.g. root `/corpus` vs payload `/corpusX/f.ts`).
            bail!("module payload escapes the corpus root");
        };
        remainder.to_owned()
    } else {
        payload.to_owned()
    };
    if relative.is_empty() {
        bail!("module payload projects to an empty path");
    }
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        bail!("module payload contains an invalid path segment");
    }
    if relative.len() > MAX_MODULE_PATH_BYTES {
        bail!("module path projection exceeds {MAX_MODULE_PATH_BYTES} UTF-8 bytes");
    }
    Ok(relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        // Canonicalize a real directory so prefix logic sees resolved paths,
        // matching what ServiceSession::open produces.
        std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    #[test]
    fn relative_payload_projects_verbatim_as_posix() {
        assert_eq!(project_module_path(&root(), "src/types/user.ts").unwrap(), "src/types/user.ts");
    }

    #[test]
    fn absolute_payload_under_root_projects_corpus_relative() {
        let payload = root().join("src/index.ts");
        assert_eq!(project_module_path(&root(), payload.to_str().unwrap()).unwrap(), "src/index.ts");
    }

    #[test]
    fn absolute_payload_outside_root_fails_closed_without_leaking_payload() {
        let error = project_module_path(&root(), "/definitely/outside/evil.ts").unwrap_err();
        let message = format!("{error:#}");
        assert!(!message.contains("evil.ts"), "error must not leak the payload: {message}");
    }

    #[test]
    fn dot_dot_dot_and_doubled_separator_components_fail_closed() {
        for payload in ["../escape.ts", "src/../escape.ts", "./src/x.ts", "src/./x.ts", "src//x.ts"] {
            assert!(project_module_path(&root(), payload).is_err(), "{payload:?} must fail");
        }
    }

    #[test]
    fn empty_and_backslash_payloads_fail_closed() {
        for payload in ["", "src\\win.ts"] {
            assert!(project_module_path(&root(), payload).is_err(), "{payload:?} must fail");
        }
    }

    #[test]
    fn root_itself_fails_closed() {
        assert!(project_module_path(&root(), root().to_str().unwrap()).is_err());
    }

    #[test]
    fn sibling_directory_sharing_a_name_prefix_fails_closed() {
        let root = root();
        let sibling = format!("{}-sibling/src/x.ts", root.to_str().unwrap());
        assert!(project_module_path(&root, &sibling).is_err());
    }

    #[test]
    fn over_long_projection_fails_closed() {
        let payload = format!("src/{}.ts", "a".repeat(600));
        assert!(project_module_path(&root(), &payload).is_err());
    }
}
