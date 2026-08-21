# Item D-3a — Ownership and health (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review. The v1 review returned **DO-NOT-PROCEED**
(archived: `docs/superpowers/specs/2026-08-21-item-d3a-plan-review-codex.md`)
with two ownership blockers. **The first is answered by removing the problem
rather than solving it** — see below. Send v2 for review before executing.

**Goal:** exactly one daemon owns a given state directory and a given endpoint
token, a leftover socket can never be mistaken for a live one, and health can be
polled without a single durable write.

**Architecture:** two lifetime-held advisory locks (state directory, then
endpoint token) acquired before any recovery. **The socket path is
per-incarnation**: the stable, flock-protected `.lock` file is the fixed
identity, and each daemon binds a freshly named socket beside it. Health is a
first-frame handshake variant inheriting D-2's proven no-durable-write property.

**Tech Stack:** Rust (`strata-kernel` service binary), `libc` (already a
dependency — `flock`, `openat`, `fchmod`, `fstatat`), the D-2 session protocol.

**Spec:** `docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-3
(ownership, startup, health; drain and `stop` are D-3b).

**Split rationale:** `decisions.md` 2026-08-21 "D-3 splits into D-3a and D-3b".

**Baseline:** `main` ≥ `c79d1b7`.

## The blocker, and why v2 deletes the problem instead of solving it

v1 claimed a `(device, inode) + nonce` record proved a leftover socket was "our
own corpse". The review showed it proved nothing: the nonce lived in the lock
file and was never tied to or recoverable from the socket, so classification
compared only device/inode — which identifies the *current file*, not an
incarnation across deletion and inode reuse. Darwin's `st_gen` exists precisely
to distinguish incarnations and is unavailable to ordinary users.

Chasing that led to increasingly exotic evidence (xattr nonces on socket inodes,
unverified on Darwin). **The spec assumed staleness was decidable; it is not,
cheaply, on this platform.**

**So D-3a stops deciding it.** The socket path becomes per-incarnation:

```
/tmp/strata-lc/<sha256(token)>.lock              stable, flock'd, records the current socket
/tmp/strata-lc/<sha256(token)>.<nonce>.sock      fresh every incarnation
```

A leftover socket from a crash is simply **not the current path**, so it can
never be confused with a live one — there is nothing to decide. Orphans are
harmless and reclaimed opportunistically.

And reclamation now has real positive evidence, which v1 lacked: **only a daemon
holding this token's endpoint lock ever creates a file named
`<sha256(token)>.*.sock`, and we hold that lock.** The name encodes ownership;
the lock proves exclusivity. That is a stronger claim than dev/inode ever
supported, and it needs no platform-specific incarnation mechanism.

**Verified before choosing this:** `socket_path(token)` is derived in exactly one
place (`server.rs:48`), and every TypeScript consumer reads `socketPath` from the
readiness line rather than recomputing it (`gate1.ts`, `gate2.ts`, `agent.ts`,
`liveAdapter.ts`, `gate3/*`, `service.ts`). The only surfaces that assume the old
shape are `validate_socket_path` (`server.rs:155`, requires a 64-hex basename)
and the `validate-socket` subcommand over it (`main.rs:203-208`). Both are
updated in Task 5.

## The contract with D-3b — read before touching `protocol.rs`

D-2's review rejected a split that let one wire version mean two things. v1
answered it with a claim the reviewer showed was **literally false**: "no frame
changes shape between slices" cannot hold, because D-3b must add a `stop` first
frame.

**The accurate contract, which v2 uses:** *no D-3a frame is reshaped or
reinterpreted; D-3b may add new variants.*

Frozen now, in D-3a, so D-3b changes no meaning:
- `health_ok` carries `draining` and `activeRequests` with their **final
  semantics** — `draining` is the request-admission state; `activeRequests` is a
  canonical decimal count of requests from the request-start boundary through
  response flush. D-3a emits `false` and `"0"`; D-3b supplies live values.
- `stop` / `stop_accepted` will be **additive** first-frame variants.
- `service_draining` will use the existing error envelope.
- `open_session` rejection during drain will use the existing `session_rejected`
  shape.
- The `health` CLI exit-code matrix defines code 5 (draining) now, unreachable
  until D-3b.

## Global constraints

- **No agent-visible semantic change to existing actions.**
- **Every existing suite must pass**, including `pnpm kernel:full-key-free:test`.
- **PID data is metadata, never authority.**
- **Health must not touch the journalled request path.**
- **Anything ambiguous fails closed.** Never unlink on an inference.
- **The loser's guarantee is "no canonical-state mutation", not "no observable
  work".**
- **Tests must never mutate the shared production `/tmp/strata-lc`.** v1's tests
  would have removed and symlinked it, capable of destroying a live daemon's
  socket or a parallel test's. The socket root is parameterized (Task 2).
- `decisions.md` is **append-only**.
- No drain, no `stop`, no lock-hold measurement — D-3b.
- All test invocations need `PATH=/opt/homebrew/bin:$PATH`.
- **Run the full chain in the MAIN checkout after merging**, not only the worktree.

## Verified facts (against `c79d1b7`)

- No file lock, no signal handling anywhere in the crate.
- `parse_named` bails on an odd argument count (`main.rs:261-263`), so a bare
  `--help` after a subcommand fails unless handled first.
- `main` maps every error to exit 2 (`main.rs:19-24`).
- Startup: `ServiceSession::open` (`server.rs:52`) → seed-green (:65) →
  `finalize_startup` (:67) → hydrate (:76) → `bind_private_socket` (:82) →
  readiness → admission (:99) → accept (:101).
- `/tmp/strata-lc` is created and chmod-0700'd only inside `bind_private_socket`
  (`server.rs:197-199`).
- Admission takes a permit **before** reading the first frame, 64/16 caps
  (`server.rs:210`, `:246`); handler write timeout is 5s (`server.rs:489`).
- `over_cap_connections_are_refused_with_server_busy`
  (`local_service.rs:2668-2680`) fills 16 silent connections and expects the
  17th to be refused **immediately**. **The control reserve changes this**; Task 6
  updates that contract explicitly. v1's claim that D-2 behavior was unchanged
  was false.
- Rust's `OpenOptions` sets `O_CLOEXEC`; `.mode(0o600)` applies **only on
  create**, not to an existing file; `O_NOFOLLOW` protects only the final path
  component.

## File structure

- **Create** `.../lifecycle.rs` — `CanonicalStateDir`, `OwnerLock`,
  `EndpointClaim`, `SocketRoot`, `BoundEndpoint`, orphan sweep.
- **Modify** `server.rs` — directory hardening via a held fd, both locks,
  per-incarnation bind, orphan sweep, control reserve.
- **Modify** `protocol.rs` — `FirstFrame` with `open_session` and `health`.
- **Modify** `main.rs` — `start` alias, `health` CLI, per-command exit codes.
- **Test** `crates/strata-kernel/tests/lifecycle.rs`.

---

### Task 1: Canonical identity, both locks, and the fd-inheritance gate

**Files:**
- Create: `.../lifecycle.rs`
- Modify: `.../main.rs:1-7`
- Test: unit tests **inside `lifecycle.rs`**; process gates in `tests/lifecycle.rs`

> `OwnerLock` is private to the binary crate and cannot be imported from
> `tests/` — that is why `local_service.rs` uses `#[path]` includes. Unit-test
> primitives in-module; from `tests/`, drive behavior only through
> `CARGO_BIN_EXE`.

**Interfaces:**
- `CanonicalStateDir::resolve(db_path: &Path) -> Result<CanonicalStateDir>`
- `OwnerLock::acquire(dir: &CanonicalStateDir) -> Result<OwnerLock, LockRefusal>`
- `EndpointClaim::acquire(root: &SocketRoot, token_hash: &str) -> Result<EndpointClaim, LockRefusal>`
- `enum LockRefusal { HeldByAnother, Unavailable(io::Error) }`

Two locks because `socket_path` derives from `--socket-token` (`main.rs:92`) with
no relationship to `--db`, so two daemons with different state dirs and one token
collide on one endpoint.

`flock(LOCK_EX|LOCK_NB)`. Document precisely: an `flock` belongs to the **open
file description**, is released only when all duplicated descriptors close, is
inherited across `fork`, and survives `exec` unless `O_CLOEXEC` is set.
**`LOCK_NB` is what makes deadlock impossible** — not the acquisition order,
which matters only if these ever become blocking.

Open the lock file `O_NOFOLLOW | O_CLOEXEC`, then **`fstat`-check** regular-file
type, uid, owner-only mode, and link count. `O_NOFOLLOW` guards only the final
component; the parent is secured by Task 2's held directory fd. `.mode(0o600)`
applies only on create, so an existing file's mode must be checked, not assumed.

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

    #[test]
    fn a_lock_file_with_loose_permissions_is_refused() {
        // .mode(0o600) applies only on CREATE, so an existing file's mode must
        // be checked rather than assumed.
        let dir = tempfile::tempdir().unwrap();
        let root = SocketRoot::for_tests(dir.path());
        let path = root.lock_path("a".repeat(64).as_str());
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(matches!(
            EndpointClaim::acquire(&root, &"a".repeat(64)),
            Err(LockRefusal::Unavailable(_))
        ));
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service lifecycle`

- [ ] **Step 3: Implement**

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CanonicalStateDir(PathBuf);

impl CanonicalStateDir {
    /// Canonicalizes the PARENT, because the db file may not exist on a first
    /// run. Resolving symlinks and `..` stops two spellings of one directory
    /// from each winning a lock.
    pub(super) fn resolve(db_path: &Path) -> Result<Self> {
        let parent = db_path.parent().context("state path has no parent")?;
        std::fs::create_dir_all(parent).context("create state directory")?;
        Ok(Self(parent.canonicalize().context("canonicalize state directory")?))
    }
}

pub(super) enum LockRefusal { HeldByAnother, Unavailable(std::io::Error) }

/// Locks a file opened relative to an already-verified directory fd.
/// O_CLOEXEC keeps this out of the Node bridge workers; the fstat checks
/// refuse anything that is not a private regular file.
fn take_flock(dir_fd: BorrowedFd<'_>, name: &str) -> Result<std::fs::File, LockRefusal> {
    let file = openat_private(dir_fd, name).map_err(LockRefusal::Unavailable)?;
    let meta = file.metadata().map_err(LockRefusal::Unavailable)?;
    let bad = !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1;
    if bad {
        return Err(LockRefusal::Unavailable(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "lock file is not a private, single-linked regular file",
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

Do **not** truncate or rewrite a lock file before winning it.

- [ ] **Step 4: Gate fd inheritance at process level**

```rust
/// Rust sets O_CLOEXEC, but "should" is not a gate. If it regressed, a
/// SIGKILLed daemon would leave its state directory unownable for as long as
/// any bridge worker survived.
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
git commit -am "feat(d3a): canonical state identity and both ownership locks"
```

### Task 2: A held directory fd, and a socket root tests can substitute

**Files:**
- Modify: `.../lifecycle.rs`
- Modify: `.../server.rs` (factor directory setup out of `bind_private_socket`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Two v1 defects, both from the review:

**TOCTOU.** `create_dir_all → symlink_metadata → set_permissions(path) →
symlink_metadata` is not race-free: a substitution between the check and the
**pathname-based** chmod redirects the chmod. Use a held fd:

1. `mkdir(root, 0700)`, accepting `EEXIST` — atomic initial permissions.
2. `open(root, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`.
3. `fstat` the **fd** for directory type, uid, and mode.
4. `fchmod` the **fd**, never the path.
5. `openat` relative to the held fd for every lock and socket file.

POSIX names `openat` as the mechanism for avoiding pathname substitution races.
Unix `bind()` remains pathname-based, so re-verify the path still names the held
directory immediately before bind. Same-uid replacement stays outside the threat
model — say so rather than implying it is covered.

**Test safety.** v1's `remove_socket_directory()` and symlink substitution
operated on the shared production `/tmp/strata-lc` and could have destroyed a
live daemon's socket or a parallel test's. `SocketRoot` is parameterized, with a
`--socket-root` flag for tests; production defaults to `/tmp/strata-lc`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_symlinked_socket_root_is_refused_and_never_chmodded() {
    let root = TempDir::new().unwrap();       // an isolated root, never /tmp/strata-lc
    let target = TempDir::new().unwrap();
    let link = root.path().join("strata-lc");
    std::os::unix::fs::symlink(target.path(), &link).unwrap();
    let refused = start_daemon_with_socket_root(&TempDir::new().unwrap(), "d3a-symlink", &link);
    assert_eq!(refused.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("not a real directory"));
    // The chmod must not have been redirected through the link.
    let mode = std::fs::metadata(target.path()).unwrap().permissions().mode();
    assert_ne!(mode & 0o777, 0o700, "chmod followed the symlink to the target");
}

#[test]
fn a_daemon_starts_on_a_host_with_no_socket_root_at_all() {
    // The ENOENT regression: the endpoint lock lives inside a directory that
    // did not exist until bind time.
    let root = TempDir::new().unwrap();
    let missing = root.path().join("never-created");
    let service = start_daemon_with_socket_root(&TempDir::new().unwrap(), "d3a-fresh", &missing);
    assert!(service.socket_path.exists());
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement `SocketRoot` with a held fd, called before `EndpointClaim::acquire`**

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): hold a verified directory fd, and let tests substitute the root"
```

### Task 3: Both locks before recovery; diagnostics only when they are real

**Files:**
- Modify: `.../server.rs:46-52`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

The gate is "the loser mutates no canonical state" — read-only preflight
legitimately runs first. The race must be **simultaneous**; starting the second
daemon after the first is ready tests exclusion, not racing.

**No placeholder this time.** v1 called `service_epoch_placeholder()` while
asserting the plan had none. The epoch does not exist until
`ServiceSession::open` returns, so diagnostics are published **after open**, in
one write, with the real PID and epoch. Nothing is written between the locks and
open.

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
fn a_losing_daemon_mutates_no_canonical_state_and_writes_no_diagnostics() {
    let directory = TempDir::new().unwrap();
    let first = start_daemon(&directory, "d3a-race");
    let audit_before = read_audit(&directory);
    let journal_before = journal_len(directory.path());

    let second = start_daemon_expecting_failure(&directory, "d3a-race");
    assert_eq!(second.status.code(), Some(2));

    // EXACT lengths: every append preserves the prefix, so starts_with cannot
    // prove nothing was appended.
    assert_eq!(read_audit(&directory).len(), audit_before.len());
    assert_eq!(journal_len(directory.path()), journal_before);
    assert_eq!(owner_metadata_pid(&directory), Some(first.pid),
               "the loser overwrote the winner's owner metadata");
    drop(first);
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Insert both acquisitions before `ServiceSession::open`; publish diagnostics after**

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): exclude a losing daemon before recovery, on both locks"
```

### Task 4: Health — the complete shape and the exact key set

**Files:**
- Modify: `.../protocol.rs`, `.../server.rs`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health is a **first-frame variant**, never an action, inheriting D-2's proof that
the handshake never reaches `bind_request`. A health probe on the request path
would make monitoring generate durable fsync traffic forever.

Reply — complete shape, final semantics, constants in D-3a:

```json
{"protocolVersion":2,"type":"health_ok","serviceEpoch":"1","recovered":false,
 "validationMode":"tscOnly","validationManifestDigest":null,
 "draining":false,"activeRequests":"0"}
```

`open_session`'s wire bytes stay byte-identical; the D-2 golden corpus asserts
them.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn health_reports_the_exact_identity_key_set_and_appends_nothing_durable() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-health");
    let journal = journal_len(directory.path());
    let audit = read_audit(&directory);
    assert!(journal > 0, "precondition: startup journalled something");

    for _ in 0..25 {
        let reply = health_probe(&service.socket_path);
        // EXACT key set -- v1 claimed a "full identity" test and omitted
        // validationManifestDigest.
        let keys: BTreeSet<&str> = reply.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, BTreeSet::from([
            "protocolVersion", "type", "serviceEpoch", "recovered",
            "validationMode", "validationManifestDigest", "draining", "activeRequests",
        ]), "{reply}");
        assert_eq!(reply["type"], "health_ok", "{reply}");
        assert_eq!(reply["serviceEpoch"], service.epoch.to_string());
        assert_eq!(reply["recovered"], false, "{reply}");
        assert_eq!(reply["validationMode"], service.readiness["validationMode"]);
        assert_eq!(reply["validationManifestDigest"], Value::Null, "{reply}");
        assert_eq!(reply["draining"], false, "{reply}");
        assert_eq!(reply["activeRequests"], "0", "{reply}");
    }

    assert_eq!(journal_len(directory.path()), journal, "health wrote to the journal");
    assert_eq!(read_audit(&directory).len(), audit.len(), "health wrote to the audit log");
}
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement `FirstFrame`**

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

- [ ] **Step 4: Run, and confirm the D-2 corpus is untouched**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service protocol_`
If a golden case fails, the handshake was reshaped rather than extended.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): health rides the handshake with its full shape frozen"
```

### Task 5: Per-incarnation socket paths — nothing left to decide

**Files:**
- Modify: `.../lifecycle.rs` (`BoundEndpoint`, orphan sweep)
- Modify: `.../server.rs` (`socket_path`, `validate_socket_path`, `bind_private_socket`)
- Modify: `.../main.rs` (`validate-socket` accepts the new shape)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**This task replaces v1's staleness classification entirely.** See "The blocker"
above for why.

```
<sha256(token)>.lock              stable, flock'd, holds the current socket name
<sha256(token)>.<nonce>.sock      fresh per incarnation
```

`validate_socket_path` (`server.rs:155`) currently requires a 64-hex basename +
`.sock`. It must accept `<64-hex>.<nonce>.sock`, where nonce is bounded lowercase
hex, and keep rejecting everything else — the parent-directory and length checks
stay exactly as they are.

`BoundEndpoint` is a concrete RAII type (v1 listed a `SocketGuard` in its file
structure and never implemented it): it owns the bound listener's path and, on
clean drop, unlinks that path **only** after re-verifying it still names a socket
in the held root.

**Orphan sweep, with the positive evidence v1 lacked.** While holding the
endpoint claim, unlink any `<sha256(token)>.*.sock` that is not the current path.
The evidence is the name plus the lock: **only a daemon holding this token's
claim ever creates that name**, and we hold it. Bound the sweep and never touch
anything outside the pattern.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_crash_leaves_an_orphan_that_cannot_be_confused_with_the_live_socket() {
    let directory = TempDir::new().unwrap();
    let crashed = start_daemon(&directory, "d3a-orphan");
    let orphan = crashed.socket_path.clone();
    kill_hard(&crashed);
    assert!(orphan.exists(), "precondition: a crash leaves the socket behind");

    let restarted = start_daemon(&directory, "d3a-orphan");
    // A DIFFERENT path -- there was never a decision to make.
    assert_ne!(restarted.socket_path, orphan);
    assert_eq!(health_probe(&restarted.socket_path)["type"], "health_ok");
    // ...and the orphan is swept, because only this token's lock holder could
    // have created that name.
    assert!(!orphan.exists(), "the orphan was not reclaimed");
}

#[test]
fn the_sweep_never_touches_a_name_outside_our_token() {
    let root = TempDir::new().unwrap();
    let foreign = root.path().join(format!("{}.{}.sock", "b".repeat(64), "deadbeef"));
    create_orphan_unix_socket(&foreign);
    let service = start_daemon_with_socket_root(&TempDir::new().unwrap(), "d3a-sweep", root.path());
    assert!(foreign.exists(), "the sweep deleted another token's socket");
    drop(service);
}

#[test]
fn a_clean_shutdown_unlinks_its_own_socket() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-clean");
    let path = service.socket_path.clone();
    stop_cleanly(&service);
    assert!(!path.exists(), "a clean exit left its socket behind");
}

#[test]
fn validate_socket_accepts_the_incarnation_shape_and_still_rejects_junk() {
    let good = format!("/tmp/strata-lc/{}.{}.sock", "a".repeat(64), "0123abcd");
    assert!(run_cli(&["validate-socket", "--socket", &good]).success());
    for bad in [
        "/tmp/strata-lc/short.sock",
        "/tmp/strata-lc/../escape.sock",
        &format!("/elsewhere/{}.{}.sock", "a".repeat(64), "0123abcd"),
        &format!("/tmp/strata-lc/{}.{}.notsock", "a".repeat(64), "0123abcd"),
    ] {
        assert!(!run_cli(&["validate-socket", "--socket", bad]).success(), "{bad}");
    }
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

Ordering that matters, since bind and record publication cannot be atomic:

1. Hold both locks; read the current record without modifying it.
2. Bind the new per-incarnation path and chmod it.
3. Write the record to a temp file, `sync_data`, rename over `.record`, sync the
   directory.
4. Sweep orphans matching our token that are not the current path.
5. Publish readiness.

A crash between (2) and (3) leaves an unrecorded socket — which is **harmless
here**, because the next incarnation binds a different name and the sweep
removes anything matching our token. That is the payoff for deleting the
staleness problem: the crash window that v1 had to fail closed on is now
uninteresting.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): per-incarnation socket paths remove the staleness decision"
```

### Task 6: The control reserve, and the D-2 contract it changes

**Files:**
- Modify: `.../server.rs` (`Admission`)
- Modify: `crates/strata-kernel/tests/local_service.rs:2668` (the D-2 contract)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health must stay reachable when sessions saturate admission, or monitoring goes
blind exactly when it is needed — and in D-3b the same reserve keeps `stop`
reachable.

| Pool | Slots | Deadline |
|---|---|---|
| Established sessions | 64 (unchanged) | 15 min idle (D-2) |
| Un-handshaken normal | 16 (unchanged) | 5s handshake (D-2) |
| Control candidates | **2**, additional | **1s covering classification AND response flush** |

Physical maximum 66. The reserve sits **above** the cap rather than carving out
of it: the existing 64 was chosen as takeover headroom, not demonstrated as a
resource cliff, and carving would drop established capacity to 62 for no reason.
The cost is two accepted fds, two handler threads, and bounded first-frame
buffers.

`Admission::admit` returns `Normal` or `ControlCandidate`. The 1s bound must
cover the response write too — handlers currently carry a 5s write timeout
(`server.rs:489`), which would otherwise dominate.

A control candidate that sends `open_session` is **refused with `server_busy`
and closed**, never promoted; promoting would let a session launder past a full
cap.

**The honest limit, corrected from v1.** v1 called this "bounded eventual
reachability". That is too strong: a peer that continuously reacquires freed
slots can starve control indefinitely. **What is bounded is each occupant's
tenure**, not eventual reachability. State that.

**This changes a D-2 contract, which v1 wrongly claimed it did not.**
`over_cap_connections_are_refused_with_server_busy` (`local_service.rs:2668`)
expects the 17th silent connector to be refused **immediately**; it will now
enter the reserve and be refused after the 1s deadline. Update that test
deliberately, with a comment naming D-3a as the reason.

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
fn both_reserve_slots_are_reclaimed_on_the_shorter_deadline() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-reserve-timeout");
    let _saturating = saturate_admission(&service);
    // BOTH slots -- v1 occupied one and health could succeed through the other
    // even if reclamation never happened.
    let silent = vec![
        connect_and_say_nothing(&service.socket_path),
        connect_and_say_nothing(&service.socket_path),
    ];
    let started = Instant::now();
    wait_until(|| health_probe_succeeds(&service.socket_path), Duration::from_secs(6));
    assert!(started.elapsed() < Duration::from_secs(6),
            "the control reserve was not reclaimed on its shorter deadline");
    drop(silent);
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement the third pool and update the D-2 test**

- [ ] **Step 4: Run BOTH suites**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): two short-deadline control slots, and the D-2 contract they change"
```

### Task 7: `start` alias and a `health` CLI with real deadlines

**Files:**
- Modify: `.../main.rs`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Verified obstacles: `parse_named` bails on an odd argument count
(`main.rs:261-263`), so `start --help` fails unless subcommand help is handled
first; and `main` maps every error to exit 2 (`main.rs:19-24`), so per-command
codes need explicit handling.

`start` is an **alias** for `serve`, not a rename.

| Code | Meaning |
|---|---|
| 0 | healthy |
| 3 | endpoint absent |
| 4 | present but unreachable, or not our protocol |
| 5 | healthy and draining (defined now, reachable in D-3b) |
| 6 | timed out |

**`--socket` and `--token`.** With per-incarnation paths, an operator who knows
only the token cannot compute the path, so `health --token <t>` resolves through
the stable `.lock` record. `--socket` stays for direct use.

**Bounded connect is an implementation, not prose.** v1 said "bounded connect
deadline"; setting read/write timeouts after `UnixStream::connect` does not bound
`connect`. Use a nonblocking connect plus `poll`, and test exit code 6 against a
listener that accepts and then stalls.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn health_cli_exit_codes_are_per_command_not_a_blanket_two() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3a-cli");
    assert_eq!(run_cli(&["health", "--socket", &service.socket_path]).code(), Some(0));
    assert_eq!(run_cli(&["health", "--token", "d3a-cli"]).code(), Some(0));
    drop(service);
    assert_eq!(run_cli(&["health", "--token", "d3a-cli"]).code(), Some(3));
    let squat = make_regular_file();
    assert_eq!(run_cli(&["health", "--socket", &squat]).code(), Some(4));
}

#[test]
fn health_times_out_rather_than_hanging_on_a_stalled_listener() {
    // Accepts the connection and then never speaks. A read timeout set after
    // connect would not have bounded connect itself; this bounds the whole
    // exchange.
    let stalled = spawn_accepting_but_silent_listener();
    let started = Instant::now();
    assert_eq!(run_cli(&["health", "--socket", &stalled.path]).code(), Some(6));
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn start_is_an_alias_and_both_dispatch_routes_accept_help() {
    assert!(run_cli(&["start", "--help"]).success());
    assert!(run_cli(&["serve", "--help"]).success());
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(d3a): start alias, health CLI with token resolution and real deadlines"
```

### Task 8: Gates, chain, close

- [ ] Simultaneous two-daemon race → exactly one serves; loser mutates no
      canonical state and writes no diagnostics (Task 3).
- [ ] Fresh host with no socket root → daemon starts (Task 2).
- [ ] Symlinked socket root → refused, and the chmod did not follow it (Task 2).
- [ ] Crash orphan is a different path from the restart, is swept, and another
      token's socket is never touched (Task 5).
- [ ] Clean shutdown unlinks its own socket (Task 5).
- [ ] `SIGKILL` with live bridge workers → ownership reclaimed (Task 1).
- [ ] Health reachable at the session cap; no session laundering; both reserve
      slots reclaimed on the shorter deadline (Task 6).
- [ ] Health appends nothing durable across 25 probes, exact key set (Task 4).
- [ ] `health` exits 6 against a stalled listener rather than hanging (Task 7).
- [ ] Full chain detached, `PATH=/opt/homebrew/bin:$PATH`. **Do not run `cargo`
      concurrently** — it rewrites the daemon binary the tests spawn.
- [ ] **Run the chain in the MAIN checkout after merging.**
- [ ] `decisions.md` close (new append-only entry); roadmap updated.

---

## Risks carried into D-3a

- **The three D-2 leaks remain open** and grow more load-bearing as the daemon
  moves toward long-lived: unbounded `request_bindings`, insert-only
  `change_set_locks`, in-memory-only delivered ceilings. Each needs a logged
  decision before "long-lived" is honest.
- **`flock` is advisory and NFS-hostile.** Correct for a local state directory,
  the only supported deployment. Replacing the state directory, the socket root,
  or either lock inode while serving violates the cooperative contract.
- **The control reserve bounds each occupant's tenure, not eventual
  reachability.** A peer that continuously reacquires freed slots can starve
  control. Same-uid hostility is outside the threat model; say so plainly.
- **Per-incarnation paths mean the socket name is no longer derivable from the
  token alone.** Anything that computed it must read the `.lock` record instead.
  Verified today: nothing does — every TS consumer reads `socketPath` from
  readiness, and the only shape-dependent surfaces are `validate_socket_path` and
  the `validate-socket` subcommand, both updated in Task 5. A future embedder
  that guesses the path will break, which is why `health --token` exists.

## Self-review (v2)

**Review corrections mapped:** staleness evidence → Task 5 deletes the decision
rather than strengthening the evidence; `SocketGuard` made concrete as
`BoundEndpoint` → Task 5; TOCTOU via held directory fd → Task 2; tests no longer
touch production `/tmp/strata-lc` → Task 2's `SocketRoot`; reserve algorithm,
1s-covering-flush, both-slots test, and the D-2 contract change → Task 6;
"bounded eventual reachability" corrected to bounded tenure → Task 6 and Risks;
wire contract restated accurately → "The contract with D-3b"; `health_ok` exact
key set including `validationManifestDigest` → Task 4;
`service_epoch_placeholder` removed → Task 3; bounded connect implemented rather
than described → Task 7; open-flag guarantees narrowed (mode-on-create-only,
link count, `O_NOFOLLOW` final-component-only) → Task 1.

**Placeholder scan:** none. Test helpers used across tasks
(`start_daemon_with_socket_root`, `kill_hard`, `saturate_admission`,
`connect_and_say_nothing`, `spawn_accepting_but_silent_listener`,
`create_orphan_unix_socket`, `stop_cleanly`) are written in Task 1's harness —
stated here so it is not discovered mid-execution.

**Type consistency:** `CanonicalStateDir` → `OwnerLock::acquire` (Task 1) used in
Task 3; `SocketRoot` (Task 2) is taken by `EndpointClaim::acquire` (Task 1) and
`BoundEndpoint` (Task 5); `FirstFrame::Health` (Task 4) consumed by the CLI
(Task 7); `health_ok`'s `draining`/`activeRequests` introduced in Task 4 with
final semantics, made to vary in D-3b.

**Open question for the reviewer:** Task 5's sweep unlinks any
`<our-token-hash>.*.sock` that is not the current path, justified by "only a
holder of this token's claim creates that name". That is sound against
cooperating daemons. Against a same-uid process that deliberately creates such a
name it is not — but same-uid hostility is already outside the threat model for
the directory. Is it consistent to rely on that exclusion here too, or does the
sweep deserve a stricter rule than the directory hardening does?
