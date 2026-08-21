# Item D-3a — Ownership and health (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v1 — NOT YET REVIEWED. Send for independent methodology review
before executing.

**Goal:** exactly one daemon owns a given state directory AND a given socket
endpoint, staleness is decided by positive evidence rather than by an errno, and
health can be polled without generating a single durable write.

**Architecture:** two lifetime-held advisory locks acquired in one fixed order —
state directory, then endpoint — both before any recovery or durable
construction. The endpoint lock file carries a device/inode + nonce record
written at bind time, and that record is the ONLY thing that authorizes
unlinking a socket. Health is a first-frame handshake variant, inheriting D-2's
proven no-durable-write property.

**Tech Stack:** Rust (`strata-kernel` service binary), `libc` (already a
dependency — `flock`, `fstat`), the D-2 session protocol.

**Spec:** `docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-3
(ownership, startup sequence, and health; drain and `stop` are D-3b).

**Split rationale:** `decisions.md` 2026-08-21 "D-3 splits into D-3a and D-3b".

**Reviews folded in:** `docs/superpowers/specs/2026-08-21-item-d3-plan-review-codex.md`
(round 1) and `...-round2.md` (round 2). Both returned DO-NOT-PROCEED on the
combined plan. Every ownership/health correction from both rounds is
incorporated below; the drain/stop corrections carry forward to D-3b.

**Baseline:** `main` ≥ `983c67c`.

## The contract with D-3b — read this before touching `protocol.rs`

D-2's review rejected a slice split that would have let one wire version mean
two different things. That objection applies here in exactly one place:
`health_ok` gains meaning in D-3b.

**D-3a therefore defines the COMPLETE `health_ok` shape**, including `draining`
and `activeRequests`. In D-3a they are constants (`false`, `"0"`). D-3b makes
them vary. **No frame changes shape between the slices.** Do not omit these
fields on the grounds that nothing sets them yet — omitting them is the exact
defect the split had to answer for.

## Global constraints

- **No agent-visible semantic change to existing actions.**
- **Every existing suite must pass**, including `pnpm kernel:full-key-free:test`.
- **PID data is metadata, never authority.** The held locks and the recorded
  device/inode+nonce are the only authorities.
- **Health must not touch the journalled request path.**
- **Anything ambiguous fails closed.** Never unlink on an inference.
- **The loser's guarantee is "no canonical-state mutation", not "no observable
  work".** Argument parsing and manifest reading (`main.rs:98`) are read-only
  preflight and legitimately precede any lock.
- `decisions.md` is **append-only**. Never edit an existing entry.
- Bounded everything; strict JSON, `deny_unknown_fields` stays.
- No drain, no `stop`, no lock-hold measurement — those are D-3b.
- All test invocations need `PATH=/opt/homebrew/bin:$PATH`. A bare `cargo test`
  fails with a NODE_MODULE_VERSION mismatch.
- **Run the full chain in the MAIN checkout after merging**, not only in the
  worktree — main's `node_modules` silently drifted three weeks behind D-1
  precisely because every gate ran in a worktree.

## Verified facts (checked against `983c67c`; both reviewers confirmed the earlier set)

- No file lock and no signal handling exist anywhere in the crate.
- Subcommands are `serve`, `validate-socket`, `export-snapshot` (`main.rs:38-44`).
- `parse_named` requires `--name value` pairs and bails on an odd count
  (`main.rs:261-263`), so a bare `--help` after a subcommand fails today.
- `main` converts every error to exit code 2 (`main.rs:19-24`).
- Startup order (`server.rs:46-101`): `ServiceSession::open` (:52) → seed-green
  (:65) → `finalize_startup` (:67) → hydrate (:76) → `bind_private_socket` (:82)
  → readiness line → admission (:99) → accept loop (:101).
- **`/tmp/strata-lc` is created and chmod-0700'd only inside
  `bind_private_socket` (`server.rs:197-199`)**, which runs at `:82`. Anything
  needing that directory earlier must create it itself.
- `bind_private_socket` unlinks any pre-existing socket unconditionally.
- Admission takes a permit before reading the first frame, with 64 total / 16
  un-handshaken caps (`server.rs:210`, `:246`).
- Rust's Unix `OpenOptions` sets `O_CLOEXEC`, so a lock fd should not survive
  `exec` into the Node workers spawned at `bridge/persistent.rs:899` and
  `bridge/process.rs:350`. Task 1 gates this rather than trusting it.

## What the reviews changed, and why it matters

1. **`ECONNREFUSED` is not proof of staleness on Darwin.** `sonewconn()` fails
   under listen-queue exhaustion, so a LIVE listener can transiently present as
   refused. The rejected design would have unlinked a healthy endpoint — worse
   than the boolean it replaced. Staleness now requires a device/inode + nonce
   record. **This was the question flagged as least-confident when the plan went
   out; flagging it is what surfaced it.**
2. **The socket directory must be created and hardened before the endpoint lock
   is taken**, or the lock open fails `ENOENT` on a fresh host. Its parent is a
   predictable name in world-writable `/tmp`, so pre-creation and symlink
   substitution are real attacks.
3. **Diagnostics are published only after BOTH locks are held**, so a daemon
   that wins the state lock and loses the endpoint lock leaves no misleading
   owner metadata.
4. **`LOCK_NB`, not the acquisition order, is what makes deadlock impossible.**
   The fixed order is still specified — it is the property that survives if the
   locks ever become blocking — but the plan no longer misattributes the
   guarantee.
5. **Test assertions must be exact.** `starts_with(audit_before)` cannot prove
   nothing was appended, because every append preserves the prefix. Assert exact
   lengths or parse records.

## File structure

- **Create** `.../strata_kernel_service/lifecycle.rs` — `CanonicalStateDir`,
  `OwnerLock`, `EndpointClaim`, `EndpointRecord`, `EndpointStatus`,
  `ensure_private_socket_directory`, `SocketGuard`.
- **Modify** `server.rs` — startup gains directory hardening, both locks, and
  endpoint resolution, all before `ServiceSession::open`; `bind_private_socket`
  loses its unconditional unlink and instead records the bound inode; admission
  gains a control reservation.
- **Modify** `protocol.rs` — `FirstFrame` enum with `open_session` and `health`.
- **Modify** `main.rs` — `start` alias, `health` subcommand, per-command exit
  codes, subcommand `--help` handling.
- **Test** `crates/strata-kernel/tests/lifecycle.rs`.

---

### Task 1: Canonical identity, both locks, and the fd-inheritance gate

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs:1-7`
- Test: unit tests **inside `lifecycle.rs`**; process gates in `tests/lifecycle.rs`

> **Why unit tests live in the module:** `OwnerLock` is private to the binary
> crate and cannot be imported from `tests/`. That is why `local_service.rs`
> uses `#[path]` includes. Unit-test primitives in-module; from `tests/`, drive
> behavior only through `CARGO_BIN_EXE`.

**Interfaces:**
- `CanonicalStateDir::resolve(db_path: &Path) -> Result<CanonicalStateDir>`
- `OwnerLock::acquire(dir: &CanonicalStateDir) -> Result<OwnerLock, LockRefusal>`
- `EndpointClaim::acquire(socket: &Path) -> Result<EndpointClaim, LockRefusal>`
- `enum LockRefusal { HeldByAnother, Unavailable(io::Error) }`

Two locks, two namespaces, neither implying the other:

| Lock | File | Protects |
|---|---|---|
| `OwnerLock` | `<canonical-state-dir>/.strata-owner` | redb / journal / audit |
| `EndpointClaim` | `/tmp/strata-lc/<sha256>.sock.lock` | the socket path |

Both are needed because `socket_path` is `SHA256(--socket-token)`
(`server.rs:184-187`) with **no relationship to `--db`** (`main.rs:92`), so two
daemons with different state directories and one token collide on one endpoint.

`OwnerLock::acquire` takes `CanonicalStateDir`, not `&Path`, so passing an
unresolved path is a compile error rather than a silent bypass.

`flock(LOCK_EX|LOCK_NB)` over `O_EXCL`: the kernel releases an advisory lock when
the holder dies, so a crash leaves no stale sentinel. Document precisely: an
`flock` belongs to the **open file description**, is released only when all
duplicated descriptors close, is inherited across `fork`, and survives `exec`
unless `O_CLOEXEC` is set. **`LOCK_NB` is what makes deadlock impossible**; the
fixed order matters only if these ever become blocking.

- [ ] **Step 1: Write the failing unit tests (in `lifecycle.rs`)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_holder_is_refused_and_a_dead_holder_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = CanonicalStateDir::resolve(&dir.path().join("kernel.redb")).unwrap();
        let first = OwnerLock::acquire(&canonical).expect("first holder wins");
        assert!(matches!(OwnerLock::acquire(&canonical), Err(LockRefusal::HeldByAnother)));
        drop(first);
        assert!(OwnerLock::acquire(&canonical).is_ok(), "no stale sentinel to clean up");
    }

    #[test]
    fn two_spellings_of_one_state_dir_resolve_to_one_identity() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("state");
        std::fs::create_dir_all(&nested).unwrap();
        let direct = CanonicalStateDir::resolve(&nested.join("kernel.redb")).unwrap();
        let indirect =
            CanonicalStateDir::resolve(&nested.join("..").join("state").join("kernel.redb"))
                .unwrap();
        assert_eq!(direct, indirect);
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service lifecycle`
Expected: FAIL — the types do not exist.

- [ ] **Step 3: Implement**

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CanonicalStateDir(PathBuf);

impl CanonicalStateDir {
    /// Canonicalizes the PARENT, because the db file may not exist on a first
    /// run. Resolving symlinks and `..` is what stops two spellings of one
    /// directory from each winning a lock.
    pub(super) fn resolve(db_path: &Path) -> Result<Self> {
        let parent = db_path.parent().context("state path has no parent")?;
        std::fs::create_dir_all(parent).context("create state directory")?;
        Ok(Self(parent.canonicalize().context("canonicalize state directory")?))
    }
}

pub(super) enum LockRefusal { HeldByAnother, Unavailable(std::io::Error) }

/// Opens with O_NOFOLLOW|O_CLOEXEC and confirms a regular file before locking.
/// O_CLOEXEC is what keeps this fd out of the Node bridge workers; the
/// fstat check refuses a symlink or device substituted at the path.
fn take_flock(path: &Path) -> Result<std::fs::File, LockRefusal> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .create(true).read(true).write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(LockRefusal::Unavailable)?;
    let meta = file.metadata().map_err(LockRefusal::Unavailable)?;
    if !meta.is_file() {
        return Err(LockRefusal::Unavailable(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "lock path is not a regular file",
        )));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        return match error.kind() {
            std::io::ErrorKind::WouldBlock => Err(LockRefusal::HeldByAnother),
            _ => Err(LockRefusal::Unavailable(error)),
        };
    }
    Ok(file)
}
```

Do **not** truncate or rewrite the lock file before winning it.

- [ ] **Step 4: Gate fd inheritance at process level**

```rust
/// Rust sets O_CLOEXEC, but "should" is not a gate. If this regressed, a
/// SIGKILLed daemon would leave its state directory permanently unownable for
/// as long as any bridge worker survived.
#[test]
fn a_sigkilled_daemon_releases_ownership_despite_live_bridge_workers() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon_with_persistent_bridge(&directory, "d3a-cloexec");
    warm_the_bridge(&service);
    kill_hard(&service);

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut reclaimed = false;
    while Instant::now() < deadline && !reclaimed {
        reclaimed = start_daemon_expecting_success(&directory, "d3a-cloexec").is_ok();
        if !reclaimed { thread::sleep(Duration::from_millis(250)); }
    }
    assert!(reclaimed, "a bridge worker retained the owner lock past daemon death");
}
```

- [ ] **Step 5: Run and commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/main.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3a): canonical state identity and both ownership locks"
```

### Task 2: Harden the socket directory before the endpoint lock exists

**Files:**
- Modify: `.../lifecycle.rs`
- Modify: `.../server.rs` (factor the directory setup out of `bind_private_socket`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Verified: `/tmp/strata-lc` is created and chmod-0700'd only inside
`bind_private_socket` (`server.rs:197-199`), which runs at `:82` — long after
the endpoint lock needs it. **Opening the lock file first would fail `ENOENT` on
a fresh host**, so this must be factored out and hoisted.

The directory's parent is a predictable name in world-writable `/tmp`, which
makes pre-creation and symlink substitution real. Verify rather than assume:

```rust
/// Creates and verifies the private socket directory. Runs BEFORE the endpoint
/// claim, because the lock file lives inside it.
pub(super) fn ensure_private_socket_directory() -> Result<()> {
    std::fs::create_dir_all(SOCKET_DIRECTORY).context("create socket directory")?;
    // symlink_metadata, NOT metadata: metadata follows a symlink and would
    // happily validate the target of an attacker-planted link.
    let meta = std::fs::symlink_metadata(SOCKET_DIRECTORY).context("stat socket directory")?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        bail!("socket directory is not a real directory; refusing to serve");
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        bail!("socket directory is not owned by this user; refusing to serve");
    }
    std::fs::set_permissions(SOCKET_DIRECTORY, std::fs::Permissions::from_mode(0o700))
        .context("protect socket directory")?;
    let after = std::fs::symlink_metadata(SOCKET_DIRECTORY)?;
    if after.mode() & 0o077 != 0 {
        bail!("socket directory is group- or world-accessible; refusing to serve");
    }
    Ok(())
}
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_symlinked_socket_directory_is_refused() {
    // A planted symlink where the private directory should be must not be
    // silently followed and chmod'd.
    let elsewhere = TempDir::new().unwrap();
    replace_socket_directory_with_symlink_to(elsewhere.path());
    let refused = start_daemon_expecting_failure(&TempDir::new().unwrap(), "d3a-symlink");
    assert_eq!(refused.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("not a real directory"));
    restore_socket_directory();
}

#[test]
fn a_daemon_starts_on_a_host_with_no_socket_directory_at_all() {
    // The ENOENT regression: the endpoint lock lives inside a directory that
    // did not exist until bind time.
    remove_socket_directory();
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-fresh-host");
    assert!(service.socket_path.exists());
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement, and call it before `EndpointClaim::acquire`**

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): create and verify the socket directory before claiming it"
```

### Task 3: Both locks before recovery, diagnostics only after both

**Files:**
- Modify: `.../server.rs:46-52`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

The gate is "the loser mutates no canonical state", not "the loser does nothing"
— read-only preflight legitimately runs first.

The race gate must be **simultaneous**. Starting the second daemon after the
first is ready tests exclusion, not racing.

Publish PID/epoch diagnostics into the lock files **only after both locks are
held**, so a daemon that wins the state lock and loses the endpoint lock leaves
no misleading owner metadata behind.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn two_daemons_started_simultaneously_yield_exactly_one_server() {
    let directory = TempDir::new().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2).map(|index| {
        let barrier = Arc::clone(&barrier);
        let dir = directory.path().to_owned();
        thread::spawn(move || { barrier.wait(); spawn_daemon_raw(&dir, "d3a-simultaneous", index) })
    }).collect();
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|o| o.became_ready).count(), 1,
               "exactly one daemon may serve: {outcomes:?}");
    assert_eq!(outcomes.iter().find(|o| !o.became_ready).unwrap().exit_code, Some(2));
}

#[test]
fn a_losing_daemon_mutates_no_canonical_state_and_leaves_no_owner_metadata() {
    let directory = TempDir::new().unwrap();
    let first = start_daemon(&directory, "d3a-race");
    let audit_before = read_audit(&directory);
    let journal_before = journal_len(directory.path());

    let second = start_daemon_expecting_failure(&directory, "d3a-race");
    assert_eq!(second.status.code(), Some(2));

    // EXACT, not starts_with: every append preserves the prefix, so a prefix
    // check cannot prove nothing was appended.
    assert_eq!(read_audit(&directory).len(), audit_before.len());
    assert_eq!(journal_len(directory.path()), journal_before);
    assert_eq!(owner_metadata_pid(&directory), first.pid,
               "the loser overwrote the winner's owner metadata");
    drop(first);
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Insert both acquisitions before `ServiceSession::open`**

```rust
// server.rs, after validate_socket_path and BEFORE ServiceSession::open.
// open() recovers and constructs durable state, so a daemon owning neither the
// state dir nor the endpoint must be excluded before any of it.
lifecycle::ensure_private_socket_directory()?;
let canonical = CanonicalStateDir::resolve(&config.db_path)?;
let owner = match OwnerLock::acquire(&canonical) {
    Ok(lock) => lock,
    Err(LockRefusal::HeldByAnother) =>
        bail!("another daemon already owns this state directory; refusing to serve"),
    Err(LockRefusal::Unavailable(e)) => return Err(e).context("acquire owner lock"),
};
let endpoint = match EndpointClaim::acquire(&socket_path) {
    Ok(claim) => claim,
    Err(LockRefusal::HeldByAnother) =>
        bail!("another daemon already owns this socket endpoint; refusing to serve"),
    Err(LockRefusal::Unavailable(e)) => return Err(e).context("acquire endpoint claim"),
};
// Only now, with BOTH held, is it safe to say who the owner is.
owner.publish_diagnostics(std::process::id(), service_epoch_placeholder())?;
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): exclude a losing daemon before recovery, on both locks"
```

### Task 4: Health — the complete wire shape, appending nothing durable

**Files:**
- Modify: `.../protocol.rs`
- Modify: `.../server.rs` (`handle_connection`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health is a **first-frame variant**, never an action, so it inherits D-2's
proven property: the handshake never reaches `bind_request`. A health probe on
the request path would make monitoring generate durable fsync traffic forever.

Request:

```json
{"protocolVersion":2,"type":"health"}
```

Reply — **the complete shape, defined now**:

```json
{"protocolVersion":2,"type":"health_ok","serviceEpoch":"1","recovered":false,
 "validationMode":"tscOnly","validationManifestDigest":null,
 "draining":false,"activeRequests":"0"}
```

`draining` and `activeRequests` are **constants in D-3a**. D-3b makes them vary.
Do not omit them — see "The contract with D-3b" above.

Extend `OpenSession` into a `FirstFrame` enum. **`open_session`'s wire bytes stay
byte-identical**; the D-2 golden corpus asserts them.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn health_reports_the_full_identity_and_appends_nothing_durable() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-health");
    let journal = journal_len(directory.path());
    let audit = read_audit(&directory);
    assert!(journal > 0, "precondition: startup journalled something");

    for _ in 0..25 {
        let reply = health_probe(&service.socket_path);
        assert_eq!(reply["type"], "health_ok", "{reply}");
        assert_eq!(reply["serviceEpoch"], service.epoch.to_string());
        assert_eq!(reply["recovered"], false, "{reply}");
        assert_eq!(reply["validationMode"], service.readiness["validationMode"]);
        // Present and constant in D-3a; D-3b makes them vary.
        assert_eq!(reply["draining"], false, "{reply}");
        assert_eq!(reply["activeRequests"], "0", "{reply}");
    }

    assert_eq!(journal_len(directory.path()), journal, "health wrote to the journal");
    assert_eq!(read_audit(&directory).len(), audit.len(), "health wrote to the audit log");
}
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case",
        rename_all_fields = "camelCase", deny_unknown_fields)]
pub(super) enum FirstFrame {
    OpenSession {
        protocol_version: u8,
        actor: String,
        role: SessionRole,
        client_instance: String,
        connection_generation: WireU64,
    },
    Health { protocol_version: u8 },
}
```

A health connection is answered and closed immediately: no session binding, no
ownership-registry entry, permit held only for the probe.

- [ ] **Step 4: Run, and confirm the D-2 corpus is untouched**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service protocol_`
If a golden case fails, the handshake was reshaped rather than extended — fix
the shape, do not edit the fixture.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): health rides the handshake with its full shape defined"
```

### Task 5: Staleness by positive evidence, never by errno

**Files:**
- Modify: `.../lifecycle.rs`
- Modify: `.../server.rs` (`bind_private_socket` records; resolution moves before `open`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**The correction that most changed this plan.** An earlier draft classified
`ECONNREFUSED` as definitely-stale. That is wrong on Darwin: `sonewconn()` fails
under listen-queue exhaustion, so a **live** listener can transiently present as
refused, and the design would have unlinked a healthy endpoint.

Staleness requires **positive evidence that the socket we are about to remove is
the one we ourselves created**:

1. After binding successfully, record the socket's `(device, inode)` and a fresh
   claim nonce into the endpoint lock file (which we hold).
2. On restart, holding the unchanged endpoint claim, read the previous record
   **without overwriting it**, and unlink only if the path is a socket whose
   `(device, inode)` matches that record.
3. A pre-D-3a socket, or a missing or mismatched record, **fails closed** and
   requires explicit operator cleanup.

```rust
pub(super) enum EndpointStatus {
    /// Answered a valid health handshake. A live daemon owns this.
    Healthy,
    /// Nothing at this path.
    Absent,
    /// A socket whose (device, inode) matches the record WE wrote, and which
    /// does not answer health. The only status that may be unlinked.
    StaleAndOurs,
    /// Anything else: a foreign listener, a timeout, ECONNREFUSED (which is
    /// NOT proof of death on Darwin), a mismatched or absent record, a regular
    /// file, a symlink. Ambiguous -- refuse to serve, never delete.
    OccupiedButUnverified,
}
```

The endpoint lock closes the probe/unlink/bind race **between cooperating D-3a
daemons**. It does not prove a legacy or non-cooperating process using the same
pathname is dead — hence the record.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_live_endpoint_is_never_unlinked_by_a_contender() {
    let directory = TempDir::new().unwrap();
    let live = start_daemon(&directory, "d3a-live");
    // Different state dir, same token -- the collision the endpoint lock exists
    // for.
    let other = TempDir::new().unwrap();
    let contender = start_daemon_expecting_failure(&other, "d3a-live");
    assert_eq!(contender.status.code(), Some(2));
    assert!(live.socket_path.exists(), "a live endpoint was unlinked");
    assert_eq!(health_probe(&live.socket_path)["type"], "health_ok");
}

#[test]
fn a_socket_matching_our_record_is_reclaimed() {
    let directory = TempDir::new().unwrap();
    let crashed = start_daemon(&directory, "d3a-stale");
    let socket = crashed.socket_path.clone();
    kill_hard(&crashed);
    assert!(socket.exists(), "precondition: a crash leaves the socket file");
    let restarted = start_daemon(&directory, "d3a-stale");
    assert_eq!(health_probe(&restarted.socket_path)["type"], "health_ok");
}

#[test]
fn a_socket_with_no_matching_record_fails_closed() {
    // Simulates a pre-D-3a socket, or one created by something else entirely.
    let directory = TempDir::new().unwrap();
    let path = socket_path_for_token("d3a-unowned");
    create_orphan_unix_socket(&path); // bound, then listener dropped
    erase_endpoint_record(&path);
    let refused = start_daemon_expecting_failure(&directory, "d3a-unowned");
    assert_eq!(refused.status.code(), Some(2));
    assert!(path.exists(), "an unrecorded socket was deleted on inference");
}

#[test]
fn a_regular_file_at_the_endpoint_is_never_destroyed() {
    let directory = TempDir::new().unwrap();
    let path = socket_path_for_token("d3a-squat");
    std::fs::write(&path, b"not a socket").unwrap();
    let refused = start_daemon_expecting_failure(&directory, "d3a-squat");
    assert_eq!(refused.status.code(), Some(2));
    assert_eq!(std::fs::read(&path).unwrap(), b"not a socket");
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement classification and hoist it before `open`**

```rust
// server.rs, after EndpointClaim::acquire and BEFORE ServiceSession::open.
match lifecycle::classify_endpoint(&socket_path, &endpoint)? {
    EndpointStatus::Absent => {}
    EndpointStatus::StaleAndOurs => {
        // We hold the endpoint claim and the inode matches the record we
        // wrote, so this is provably our own corpse.
        fs::remove_file(&socket_path).context("remove our stale socket")?;
    }
    EndpointStatus::Healthy =>
        bail!("a healthy daemon is already serving this endpoint; refusing to serve"),
    EndpointStatus::OccupiedButUnverified =>
        bail!("the socket path is occupied by something this daemon did not create; \
               refusing to serve. Remove it manually if you are certain it is dead."),
}
```

`bind_private_socket` loses its unconditional unlink and instead writes the
`(device, inode)` + nonce record after a successful bind.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): unlink only a socket we can prove we created"
```

### Task 6: Admission reservation, specified numerically

**Files:**
- Modify: `.../server.rs` (`Admission`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health must stay reachable when session traffic saturates admission, or
monitoring goes blind exactly when it is most needed — and in D-3b the same
reservation is what keeps `stop` reachable.

Existing behavior: a permit is taken **before the first frame is read**
(`server.rs:210`), with 64 total / 16 un-handshaken (`server.rs:246`). Because
the frame is not yet read, the daemon cannot know whether a connection is a
session or a control probe at admission time.

The numbers, stated rather than implied:

| Pool | Slots | Deadline |
|---|---|---|
| Established sessions | 64 (unchanged) | 15 min idle (D-2) |
| Un-handshaken normal | 16 (unchanged) | 5s handshake (D-2) |
| Control candidates | **2**, additional | **1s** first-frame deadline |

The physical maximum becomes 66. Normal capacity is **not** reduced — reducing
it would change D-2's tested behavior for no reason.

A control candidate that sends `open_session` instead of `health` is **refused
with `server_busy` and closed**, not promoted: the reserve exists for control and
promoting would let a session launder its way past a full cap.

**Honest limit, stated in the plan rather than discovered later:** because the
frame is not read at admission, a same-user hostile peer can occupy the reserve
by connecting and staying silent. The 1s deadline makes this **bounded eventual
reachability**, not an absolute guarantee. Say so; do not claim more.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn health_stays_reachable_when_sessions_saturate_admission() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-reserve");
    let _saturating = saturate_admission(&service); // 32 actors x 2 lanes = 64
    assert_eq!(health_probe(&service.socket_path)["type"], "health_ok",
               "health went blind exactly when it was needed");
}

#[test]
fn a_control_candidate_that_opens_a_session_is_refused_not_promoted() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-no-laundering");
    let _saturating = saturate_admission(&service);
    let reply = try_open_session_raw(&service.socket_path, "client:sneaky");
    assert_eq!(reply["error"]["code"], "server_busy", "{reply}");
}

#[test]
fn a_silent_control_candidate_is_reclaimed_within_its_shorter_deadline() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-reserve-timeout");
    let _saturating = saturate_admission(&service);
    let silent = connect_and_say_nothing(&service.socket_path);
    let started = Instant::now();
    wait_until(|| health_probe_succeeds(&service.socket_path), Duration::from_secs(6));
    assert!(started.elapsed() < Duration::from_secs(6),
            "the control reserve was not reclaimed on its shorter deadline");
    drop(silent);
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement the third pool**

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): reserve two short-deadline control slots above the session cap"
```

### Task 7: `start` alias and the `health` CLI with real exit codes

**Files:**
- Modify: `.../main.rs`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Verified obstacles:
- `parse_named` bails on an odd argument count (`main.rs:261-263`), so
  `start --help` fails today unless subcommand help is handled first.
- `main` maps **every** error to exit 2 (`main.rs:19-24`), so per-command codes
  need explicit handling rather than falling through.

`start` is an **alias** for `serve`, not a rename: renaming breaks every harness
call site for no benefit.

Exit codes for `health --socket <path>`:

| Code | Meaning |
|---|---|
| 0 | healthy |
| 3 | endpoint absent |
| 4 | present but unreachable, or not our protocol |
| 5 | healthy and draining (D-3b will make this reachable; defined now so the matrix is stable) |
| 6 | timed out |

Code 5 is defined here and unreachable until D-3b, for the same reason
`health_ok` carries `draining` now: the contract should not change between
slices.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn health_cli_exit_codes_are_per_command_not_a_blanket_two() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-cli");
    assert_eq!(run_cli(&["health", "--socket", &service.socket_path]).code(), Some(0));
    drop(service);
    assert_eq!(run_cli(&["health", "--socket", "/tmp/strata-lc/absent.sock"]).code(), Some(3));
    let squat = make_regular_file();
    assert_eq!(run_cli(&["health", "--socket", &squat]).code(), Some(4));
}

#[test]
fn start_is_an_alias_and_both_dispatch_routes_accept_help() {
    // parse_named bails on an odd argument count, so subcommand help must be
    // handled before option parsing.
    assert!(run_cli(&["start", "--help"]).success());
    assert!(run_cli(&["serve", "--help"]).success());
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement dispatch, help handling, and typed exit codes**

```rust
match command.to_str() {
    // Alias, not a rename: every existing harness calls `serve`.
    Some("serve") | Some("start") => serve(&remaining),
    Some("health") => health(&remaining),
    Some("validate-socket") => validate_socket(&remaining),
    Some("export-snapshot") => export_snapshot(&remaining),
    _ => bail!("unknown command; run with --help"),
}
```

`health` connects with bounded connect/read/write deadlines and parses the reply
strictly; a malformed or foreign reply is exit 4, never a hang.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): start alias plus a health CLI with a real exit-code matrix"
```

### Task 8: Gates, chain, close

- [ ] Simultaneous two-daemon race → exactly one serves; loser mutates no
      canonical state and leaves no owner metadata (Task 3).
- [ ] Fresh host with no `/tmp/strata-lc` → daemon starts (Task 2).
- [ ] Symlinked socket directory → refused, not followed (Task 2).
- [ ] Live endpoint never unlinked by a contender; our own stale socket
      reclaimed; unrecorded socket and regular file both fail closed (Task 5).
- [ ] `SIGKILL` with live bridge workers → ownership reclaimed (Task 1).
- [ ] Health reachable at the session cap; control candidate cannot launder a
      session; silent candidate reclaimed on its shorter deadline (Task 6).
- [ ] Health appends nothing durable across 25 probes (Task 4).
- [ ] Full chain detached with `PATH=/opt/homebrew/bin:$PATH`. **Do not run
      `cargo` concurrently** — it rewrites the daemon binary the tests spawn.
- [ ] **Run the chain in the MAIN checkout after merging**, not only the worktree.
- [ ] `decisions.md` close (new append-only entry); roadmap updated.

---

## Risks carried into D-3a

- **The three D-2 leaks remain open** and become more load-bearing as the daemon
  moves toward long-lived: unbounded `request_bindings`, insert-only
  `change_set_locks`, in-memory-only delivered ceilings. Not D-3a deliverables;
  each needs a logged decision before "long-lived" is honest.
- **`flock` is advisory and NFS-hostile.** Correct for a local state directory,
  the only supported deployment. Document that replacing the state directory,
  the endpoint directory, or either lock inode while serving violates the
  cooperative contract.
- **The control reserve is bounded eventual reachability, not a guarantee.** A
  same-user hostile peer can occupy it; the 1s deadline bounds how long.
- **`StaleAndOurs` requires a record that pre-D-3a sockets do not have.** The
  first upgrade onto a host with a live orphan socket will fail closed and need
  manual cleanup. That is the intended trade: a refusal an operator can fix
  beats deleting something that was alive.

## Self-review (v1)

**Spec coverage:** owner lock + ordering → Tasks 1, 3; startup sequence
(canonicalize → lock → claim/verify → stale unlink) → Tasks 1-3, 5; health off
the journal → Task 4; `start`/`health` → Task 7. Drain, `stop`, readiness-identity
retention, and the lock-hold measurement are explicitly D-3b.

**Both prior reviews' ownership/health corrections mapped:** endpoint lock and
fixed order → Task 1; directory hardening before the claim → Task 2; diagnostics
only after both locks → Task 3; `ECONNREFUSED` rejected in favor of device/inode
+ nonce → Task 5; numeric control reservation with the honest limit stated →
Task 6; exact-length audit assertions → Task 3; in-module unit tests →
Task 1; simultaneous race → Task 3; `start --help` and per-command exit codes →
Task 7.

**Placeholder scan:** none. Every test body is concrete. Helper functions used by
the tests (`start_daemon`, `kill_hard`, `saturate_admission`,
`create_orphan_unix_socket`, `erase_endpoint_record`) must be written as part of
Task 1's harness; that is stated here so it is not discovered mid-execution.

**Type consistency:** `CanonicalStateDir` → `OwnerLock::acquire` (Task 1) used in
Task 3; `EndpointClaim` (Task 1) consumed by `classify_endpoint` (Task 5);
`EndpointStatus` consumed only in `server.rs`; `FirstFrame::Health` (Task 4)
consumed by the CLI (Task 7); `health_ok`'s `draining`/`activeRequests` are
introduced in Task 4 and made to vary in D-3b.

**Open question for the reviewer:** Task 6 puts the control reserve **above** the
64-session cap (physical max 66) rather than carving it out. That keeps D-2's
tested behavior intact but raises the daemon's true connection ceiling. Is that
the right trade, or should the reserve come out of the existing 64?
