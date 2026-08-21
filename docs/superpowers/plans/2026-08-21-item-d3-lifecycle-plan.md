# Item D-3 — Daemon lifecycle: ownership, health, drain (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review. The v1 methodology review returned
**DO-NOT-PROCEED** (archived:
`docs/superpowers/specs/2026-08-21-item-d3-plan-review-codex.md`) because the
ownership and drain architectures were both wrong, not merely under-tested.
Every correction is folded in. **The review directs that v2 be reviewed again
before execution, because these corrections materially change architecture
rather than test coverage.** Do not begin Task 1 until that second review
returns.

**Goal:** make the daemon safe to call long-lived — exactly one daemon serves a
given endpoint AND a given state directory, its health can be polled without
generating durable writes, and it can be stopped without lying about what it
cancelled.

**Architecture:** ownership is **two** lifetime-held advisory locks acquired in
one fixed order — state directory, then endpoint — both before any recovery or
durable construction. Health rides D-2's handshake, which is already proven to
append nothing durable. Drain is a controller over an explicit **active-request
count** with an RAII guard, woken by a self-pipe, refusing new work at a
serialized start boundary and waiting only for requests that actually crossed
it.

**Tech Stack:** Rust (`strata-kernel` service binary), `libc` (already a
dependency — `flock`, `pipe2`, `poll`), the D-2 session protocol, TypeScript
`@strata-code/coordination-client`.

**Spec:** `docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-3.

**Baseline:** `main` ≥ `0e07f60` (the D-2 merge).

## What v1 got wrong

1. **The state lock does not serialize the socket namespace, so endpoint
   ownership still raced.** Verified: `socket_path(token)` is
   `SHA256(--socket-token)` under `/tmp/strata-lc/` (`server.rs:184-187`) with
   **no relationship whatsoever to `--db`** (`main.rs:92`). Two daemons with
   different state directories and the same token collide on one socket while
   each contentedly holds its own state lock. The concrete failure: A and B both
   probe an old socket as dead, A unlinks and binds, B then unlinks A's freshly
   bound socket. v1's central claim — that the state lock removes the
   probe/unlink/bind race — was simply false. **This is the correction that
   overturned my own reasoning; I had argued it explicitly and it does not
   survive contact with `socket_path`.**
2. **Stale-socket resolution was placed after recovery.** v1 put it inside
   `bind_private_socket`, which is called at `server.rs:82` — after
   `ServiceSession::open` (`:52`), the seed-green gate, `finalize_startup`, and
   hydration. The spec requires endpoint claim/verify *before* that work
   (`spec:158`). v1 stated the ordering rule correctly in prose and then
   violated it in the task.
3. **Tasks 3 and 4 are NOT entangled.** I claimed they were and documented the
   entanglement as unavoidable. The dependency is one-way: health can be built
   and tested against the existing listener, and stale detection then consumes
   it. Task 4 simply comes first. Inventing a false symmetry was worse than
   missing the ordering.
4. **The drain design had no machinery to wait for anything.** Handler threads
   are detached with their handles discarded (`server.rs:112`), and `Admission`
   counts *connections*, not active requests, with no wait facility
   (`server.rs:235-240`). "Give running requests a bounded grace" was
   unimplementable as written. The self-pipe sketch also had one fd where a pipe
   needs two.
5. **Task 6 contradicted the plan's own header.** The header called
   `service_draining` a typed NON-replayed outcome; Task 6 then put it in
   `BACKOFF_CODES` and retried internally. Those are different contracts.
6. **Task 8 was a placeholder**, which the repo's planning standard treats as a
   plan failure — and it directed editing an existing `decisions.md` entry, but
   that file is append-only (`decisions.md:3`).

*Accuracy note on one review claim:* the review said the backoff path cannot
reconnect because "the only public lane close marks it permanently closed"
(`client.ts:208`). The retry path does not call `close()`; it relies on
`#drop()`, which nulls the socket and *does* permit a reconnect. The review's
conclusion is still right for a different reason: during a real restart gap the
reconnect raises `ENOENT`/`ECONNREFUSED` → `connect_failed`, which is not in
`BACKOFF_CODES`, so the chain dies exactly when it is needed. Recorded because
the mechanism matters to whoever implements Task 6.

## Global constraints

- **No agent-visible semantic change to existing actions.** Drain adds one
  terminal outcome; nothing else changes.
- **Every existing suite must pass**, including `pnpm kernel:full-key-free:test`.
- **PID data is metadata, never authority.** The held locks and the in-band
  control exchange are the only authorities.
- **Health must not touch the journalled request path.**
- **Shutdown must never report a change set as cancelled unless the canonical
  lifecycle actually cancelled it** (`spec:166`).
- **The loser's guarantee is "no canonical-state mutation", not "no observable
  work".** Argument parsing and manifest reading (`main.rs:98`) are read-only
  preflight and legitimately happen before any lock.
- `decisions.md` is **append-only**. Never edit an existing entry.
- Bounded everything; strict JSON, `deny_unknown_fields` / `.strict()` stay.
- No packaging (cut until after item E), no item-C work, no keyed runs.
- `packages/live-compare/src/tasks.ts` is never staged.
- All test invocations need `PATH=/opt/homebrew/bin:$PATH`. A bare `cargo test`
  fails with a NODE_MODULE_VERSION mismatch.
- **Run the full chain in the MAIN checkout after merging, not only in the
  worktree.** D-1 merged a new workspace package and main's `node_modules` never
  picked it up, so main could not build `live-compare` for three weeks and no
  worktree-run gate could have shown it.

## Verified facts (checked against `0e07f60`; the review confirmed none were wrong)

- No file lock and **no signal handling** exist anywhere in the crate. `stop`
  today is `child.kill("SIGTERM")` (`service.ts:118`) against a process with no
  handler, so drain is built from zero including the signal path.
- Subcommands are `serve`, `validate-socket`, `export-snapshot` (`main.rs:38-44`).
- Startup order (`server.rs:46-101`): `ServiceSession::open` (:52) → seed-green
  (:65) → `finalize_startup` (:67) → hydrate (:76) → `bind_private_socket` (:82)
  → readiness line → admission (:99) → accept loop (:101).
- The accept loop blocks in `listener.incoming()` (`server.rs:101`).
- `bind_private_socket` unlinks any pre-existing socket unconditionally.
- `service.ts:112` parses readiness as `{ socketPath: string }`, discarding
  `serviceEpoch`, `recovered`, `validationMode`, `validationManifestDigest`.
- Handler threads are detached, handles discarded (`server.rs:112`).
- `Admission` counts connections only (`server.rs:235-240`).
- Rust's Unix `OpenOptions` sets `O_CLOEXEC`, so the lock fd should not survive
  `exec` into the Node workers spawned at `bridge/persistent.rs:899` and
  `bridge/process.rs:350`. **Task 1 gates this rather than trusting it.**

## File structure

- **Create** `.../strata_kernel_service/lifecycle.rs` — `CanonicalStateDir`,
  `OwnerLock`, `EndpointClaim`, and `EndpointStatus` classification.
- **Create** `.../strata_kernel_service/drain.rs` — `DrainController`,
  `ActiveRequest` RAII guard, self-pipe, signal installation.
- **Modify** `server.rs` — startup gains both locks and endpoint resolution
  before `ServiceSession::open`; accept loop becomes interruptible; control
  frames get reserved capacity.
- **Modify** `protocol.rs` — `health` and `stop` first-frame variants,
  `service_draining` error code.
- **Modify** `session.rs` — the request-start boundary and active-request guard.
- **Modify** `main.rs` — `start` alias, `health` and `stop` subcommands.
- **Modify** `packages/coordination-client/src/client.ts` — `service_draining`
  as a terminal typed error.
- **Modify** `packages/live-compare/src/service.ts` — strict runtime validation
  of the readiness line.
- **Test** `crates/strata-kernel/tests/lifecycle.rs`.

---

### Task 1: Locks — state and endpoint, in one fixed order

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs:1-7`
- Test: unit tests **inside `lifecycle.rs`** (`#[cfg(test)] mod tests`), plus
  process-level gates in `crates/strata-kernel/tests/lifecycle.rs`

> **Why the unit tests live in the module:** `OwnerLock` is private to the
> binary crate. An integration test under `tests/` cannot import it — that is
> why `local_service.rs` uses `#[path]` includes. Unit-test the primitives
> in-module; test *behavior* from `tests/` only through `CARGO_BIN_EXE`.

**Interfaces:**
- Produces: `CanonicalStateDir(PathBuf)` — a newtype with
  `CanonicalStateDir::resolve(db_path: &Path) -> Result<Self>` that canonicalizes
  symlinks and `..`. **`OwnerLock::acquire` takes this type, not a `&Path`**, so
  passing an unresolved path is a compile error rather than a silent bypass (v1
  defined a canonicalization helper and then never called it).
- Produces: `OwnerLock::acquire(dir: &CanonicalStateDir) -> Result<OwnerLock, LockRefusal>`
- Produces: `EndpointClaim::acquire(socket: &Path) -> Result<EndpointClaim, LockRefusal>`
- Produces: `enum LockRefusal { HeldByAnother, Unavailable(io::Error) }`

Two locks, because they protect two different namespaces and neither implies the
other:

| Lock | File | Protects |
|---|---|---|
| `OwnerLock` | `<canonical-state-dir>/.strata-owner` | the redb/journal/audit state |
| `EndpointClaim` | `/tmp/strata-lc/<sha256>.sock.lock` | the socket path |

**Acquire state first, then endpoint, always.** A fixed global order is what
prevents two daemons deadlocking by taking them in opposite orders.

`flock(LOCK_EX|LOCK_NB)`, not `O_EXCL`: the kernel releases an advisory lock when
the holder dies, so a crash leaves no stale sentinel to reason about. The
precise lifetime rule to document in the module: **an `flock` belongs to the open
file description and is released only when all duplicated descriptors close**;
children inherit it across `fork`, and it survives `exec` unless `O_CLOEXEC` is
set. Rust sets `O_CLOEXEC`, which Step 4 gates rather than assumes.

Match `io::ErrorKind::WouldBlock` rather than one raw errno spelling.

Do **not** truncate or rewrite the lock file before winning it — write the
diagnostic PID/epoch through the held fd afterward, `0o600`, no symlink
following.

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
        assert!(matches!(
            OwnerLock::acquire(&canonical),
            Err(LockRefusal::HeldByAnother)
        ));
        drop(first);
        // No stale-sentinel story: the kernel released it.
        assert!(OwnerLock::acquire(&canonical).is_ok());
    }

    #[test]
    fn two_spellings_of_one_state_dir_resolve_to_one_identity() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("state");
        std::fs::create_dir_all(&nested).unwrap();
        let direct = CanonicalStateDir::resolve(&nested.join("kernel.redb")).unwrap();
        let indirect = CanonicalStateDir::resolve(
            &nested.join("..").join("state").join("kernel.redb"),
        )
        .unwrap();
        assert_eq!(direct, indirect);
    }

    #[test]
    fn the_endpoint_lock_is_independent_of_the_state_lock() {
        // The v1 defect in one assertion: same endpoint, different state dirs.
        let socket = std::path::Path::new("/tmp/strata-lc/test-endpoint.sock");
        let first = EndpointClaim::acquire(socket).expect("first claim wins");
        assert!(matches!(
            EndpointClaim::acquire(socket),
            Err(LockRefusal::HeldByAnother)
        ));
        drop(first);
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service lifecycle`
Expected: FAIL — the types do not exist.

- [ ] **Step 3: Implement `lifecycle.rs`**

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CanonicalStateDir(PathBuf);

impl CanonicalStateDir {
    /// Resolves symlinks and `..` so two spellings of one directory cannot
    /// each win a lock. Canonicalizes the PARENT, because the db file itself
    /// may not exist yet on a first run.
    pub(super) fn resolve(db_path: &Path) -> Result<Self> {
        let parent = db_path.parent().context("state path has no parent")?;
        std::fs::create_dir_all(parent).context("create state directory")?;
        Ok(Self(parent.canonicalize().context("canonicalize state directory")?))
    }
}

pub(super) enum LockRefusal {
    HeldByAnother,
    Unavailable(std::io::Error),
}

fn take_flock(path: &Path) -> Result<std::fs::File, LockRefusal> {
    // OpenOptions sets O_CLOEXEC, which is what keeps this fd out of the Node
    // bridge workers. Step 4 gates that rather than trusting it.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(LockRefusal::Unavailable)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        return match error.kind() {
            std::io::ErrorKind::WouldBlock => Err(LockRefusal::HeldByAnother),
            _ => Err(LockRefusal::Unavailable(error)),
        };
    }
    Ok(file)
}

pub(super) struct OwnerLock { file: std::fs::File }
pub(super) struct EndpointClaim { file: std::fs::File }

impl OwnerLock {
    pub(super) fn acquire(dir: &CanonicalStateDir) -> Result<Self, LockRefusal> {
        take_flock(&dir.0.join(".strata-owner")).map(|file| Self { file })
    }
}

impl EndpointClaim {
    pub(super) fn acquire(socket: &Path) -> Result<Self, LockRefusal> {
        let mut lock = socket.as_os_str().to_os_string();
        lock.push(".lock");
        take_flock(Path::new(&lock)).map(|file| Self { file })
    }
}
```

- [ ] **Step 4: Gate the fd-inheritance property at process level**

Add to `crates/strata-kernel/tests/lifecycle.rs`:

```rust
/// The lock must not outlive the daemon by riding into a bridge worker.
/// Rust sets O_CLOEXEC, but "should" is not a gate -- if this regressed, a
/// SIGKILLed daemon would leave its state directory permanently unownable
/// for as long as any child survived.
#[test]
fn a_sigkilled_daemon_releases_ownership_despite_live_bridge_workers() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon_with_persistent_bridge(&directory, "d3-cloexec");
    // Force at least one worker to exist and stay alive.
    warm_the_bridge(&service);
    kill_hard(&service);

    // Bounded, not instant: the kernel reclaims when the last fd closes.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut reclaimed = false;
    while Instant::now() < deadline && !reclaimed {
        reclaimed = start_daemon_expecting_success(&directory, "d3-cloexec").is_ok();
        if !reclaimed { thread::sleep(Duration::from_millis(250)); }
    }
    assert!(reclaimed, "a bridge worker retained the owner lock past daemon death");
}
```

- [ ] **Step 5: Run everything and commit**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/main.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): state and endpoint locks, acquired in one fixed order"
```

### Task 2: Acquire both locks before recovery, and prove the loser mutates nothing

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs:46-52`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

The gate is not "the loser exits" but "the loser mutates no canonical state".
Phrase it that way: read-only preflight (`main.rs:98`) legitimately runs first.

The race gate must be **simultaneous**. v1 started the second daemon after the
first was ready, which tests exclusion, not racing — the spec asks for a race.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn two_daemons_started_simultaneously_yield_exactly_one_server() {
    let directory = TempDir::new().unwrap();
    // Spawn both before either can be ready, so the outcome is decided by the
    // locks rather than by start order.
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let dir = directory.path().to_owned();
            thread::spawn(move || {
                barrier.wait();
                spawn_daemon_raw(&dir, "d3-simultaneous", index)
            })
        })
        .collect();
    let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let served = outcomes.iter().filter(|o| o.became_ready).count();
    assert_eq!(served, 1, "exactly one daemon may serve: {outcomes:?}");
    let refused = outcomes.iter().find(|o| !o.became_ready).unwrap();
    assert_eq!(refused.exit_code, Some(2));
}

#[test]
fn a_losing_daemon_mutates_no_canonical_state() {
    let directory = TempDir::new().unwrap();
    let first = start_daemon(&directory, "d3-race");
    let audit_before = read_audit(&directory);
    let journal_before = journal_len(directory.path());

    let second = start_daemon_expecting_failure(&directory, "d3-race");
    assert_eq!(second.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&second.stderr).contains("already owns"));

    assert_eq!(read_audit(&directory), audit_before, "loser wrote to the audit log");
    assert_eq!(journal_len(directory.path()), journal_before, "loser wrote to the journal");
    drop(first);
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle daemons`
Expected: FAIL — both daemons serve.

- [ ] **Step 3: Insert both acquisitions ahead of `ServiceSession::open`**

```rust
// server.rs, after validate_socket_path and BEFORE ServiceSession::open.
// Ordering is load-bearing: open() recovers and constructs durable state, so a
// daemon that owns neither the state dir nor the endpoint must be excluded
// before any of it. Fixed order -- state, then endpoint -- so two daemons
// cannot deadlock by taking them oppositely.
let canonical = CanonicalStateDir::resolve(&config.db_path)?;
let _owner = match OwnerLock::acquire(&canonical) {
    Ok(lock) => lock,
    Err(LockRefusal::HeldByAnother) => {
        bail!("another daemon already owns this state directory; refusing to serve")
    }
    Err(LockRefusal::Unavailable(e)) => return Err(e).context("acquire owner lock"),
};
let _endpoint = match EndpointClaim::acquire(&socket_path) {
    Ok(claim) => claim,
    Err(LockRefusal::HeldByAnother) => {
        bail!("another daemon already owns this socket endpoint; refusing to serve")
    }
    Err(LockRefusal::Unavailable(e)) => return Err(e).context("acquire endpoint claim"),
};
```

- [ ] **Step 4: Run and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): exclude a losing daemon before recovery, on both locks"
```

### Task 3: `health` on the handshake, appending nothing durable

> **Reordered ahead of stale detection.** v1 claimed these two were entangled;
> they are not. The dependency runs one way — health can be built and tested
> against the existing listener, and stale detection then consumes it.

**Files:**
- Modify: `.../strata_kernel_service/protocol.rs`
- Modify: `.../strata_kernel_service/server.rs` (`handle_connection`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health is a **first-frame variant**, never an action. D-2 proved the handshake
does not reach `bind_request`; health inherits that and keeps the same
assertion, because a health probe on the request path would make monitoring
generate durable fsync traffic forever.

Wire — request:

```json
{"protocolVersion":2,"type":"health"}
```

reply:

```json
{"protocolVersion":2,"type":"health_ok","serviceEpoch":"1","recovered":false,
 "validationMode":"tscOnly","validationManifestDigest":null,"draining":false,
 "activeRequests":"0"}
```

`draining` and `activeRequests` are what make health useful during Task 5, and
are why health carries state rather than being a bare pong.

Extend `OpenSession` into a `FirstFrame` enum. **Keep `open_session`'s wire bytes
byte-identical** — the D-2 golden corpus asserts them. This is an addition, not
a reshape.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn health_reports_identity_and_appends_nothing_durable() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-health");
    let journal = journal_len(directory.path());
    let audit = read_audit(&directory);
    assert!(journal > 0, "precondition: startup journalled something");

    for _ in 0..25 {
        let reply = health_probe(&service.socket_path);
        assert_eq!(reply["type"], "health_ok", "{reply}");
        assert_eq!(reply["serviceEpoch"], service.epoch.to_string());
        assert_eq!(reply["draining"], false, "{reply}");
        assert_eq!(reply["activeRequests"], "0", "{reply}");
    }

    assert_eq!(journal_len(directory.path()), journal, "health wrote to the journal");
    assert_eq!(read_audit(&directory), audit, "health wrote to the audit log");
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle health`
Expected: FAIL — the handshake parser rejects `"type":"health"`.

- [ ] **Step 3: Implement the variant**

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
    Stop { protocol_version: u8 },
}
```

A health connection is answered and closed immediately: no session binding, no
ownership-registry entry, and it holds its admission permit only for the probe.

- [ ] **Step 4: Run, and confirm the D-2 corpus is untouched**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service protocol_`
Expected: PASS. If a golden case fails, the handshake was reshaped rather than
extended — fix the shape, do not edit the fixture.

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): health rides the handshake and stays off the journal"
```

### Task 4: Endpoint classification — fail closed on anything ambiguous

**Files:**
- Modify: `.../strata_kernel_service/lifecycle.rs`
- Modify: `.../strata_kernel_service/server.rs` (resolution moves BEFORE `ServiceSession::open`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

`bind_private_safe` today unlinks unconditionally. v1 replaced that with a
boolean "does it answer health". A boolean is not enough: it collapses "a
foreign program is listening here", "it timed out", and "this path is a regular
file" into "dead", and each of those would then be **deleted**.

```rust
pub(super) enum EndpointStatus {
    /// Answered a valid health handshake. A live daemon owns this.
    Healthy,
    /// A Unix socket that refused connection with ECONNREFUSED -- nothing is
    /// listening. The ONLY status that may be unlinked.
    DefinitelyStale,
    /// Nothing at this path.
    Absent,
    /// Connected but did not speak our protocol, timed out, replied
    /// malformed, or is not a socket at all. Ambiguous -- fail closed.
    OccupiedButUnverified,
}
```

Only `DefinitelyStale` may be removed. `Healthy` and `OccupiedButUnverified`
both refuse to serve. A regular file or symlink at the socket path is
`OccupiedButUnverified` and is never unlinked.

**This resolution runs before `ServiceSession::open`**, satisfying `spec:158`,
and it runs while holding the endpoint claim — which is what closes the
probe/unlink/bind window that v1 left open.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_live_endpoint_is_never_unlinked_even_by_a_lock_holder() {
    let directory = TempDir::new().unwrap();
    let live = start_daemon(&directory, "d3-live");
    // A contender with a DIFFERENT state dir, same token -- exactly the v1
    // defect. It holds no endpoint claim, and must not remove a live socket.
    let other = TempDir::new().unwrap();
    let contender = start_daemon_expecting_failure(&other, "d3-live");
    assert_eq!(contender.status.code(), Some(2));
    assert!(live.socket_path.exists(), "a live endpoint was unlinked");
    assert!(socket_status(&live.socket_path) == EndpointStatusWire::Healthy);
}

#[test]
fn a_definitely_stale_socket_is_reclaimed_and_a_regular_file_is_not() {
    let directory = TempDir::new().unwrap();
    let crashed = start_daemon(&directory, "d3-stale");
    let socket = crashed.socket_path.clone();
    kill_hard(&crashed);
    wait_until(|| socket_status(&socket) == EndpointStatusWire::DefinitelyStale,
               Duration::from_secs(10));
    assert!(socket.exists(), "precondition: a crash leaves the socket file");
    let restarted = start_daemon(&directory, "d3-stale");
    assert!(socket_status(&restarted.socket_path) == EndpointStatusWire::Healthy);
    drop(restarted);

    // A regular file squatting on the path is ambiguous, never deleted.
    let squatted = TempDir::new().unwrap();
    let path = socket_path_for_token("d3-squat");
    std::fs::write(&path, b"not a socket").unwrap();
    let refused = start_daemon_expecting_failure(&squatted, "d3-squat");
    assert_eq!(refused.status.code(), Some(2));
    assert_eq!(std::fs::read(&path).unwrap(), b"not a socket",
               "a non-socket at the endpoint path was destroyed");
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle endpoint`

- [ ] **Step 3: Implement classification and move resolution before `open`**

```rust
// server.rs, immediately after EndpointClaim::acquire and BEFORE
// ServiceSession::open.
match lifecycle::classify_endpoint(&socket_path) {
    EndpointStatus::Absent => {}
    EndpointStatus::DefinitelyStale => {
        // We hold the endpoint claim, so no one can bind between this unlink
        // and ours. That is the window v1 left open.
        fs::remove_file(&socket_path).context("remove stale socket")?;
    }
    EndpointStatus::Healthy => {
        bail!("a healthy daemon is already serving this endpoint; refusing to serve")
    }
    EndpointStatus::OccupiedButUnverified => {
        bail!("the socket path is occupied by something this daemon cannot identify; \
               refusing to serve rather than deleting it")
    }
}
```

`bind_private_socket` loses its unconditional unlink entirely.

- [ ] **Step 4: Run and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): classify the endpoint and unlink only what is provably dead"
```

### Task 5: The request-start boundary and the active-request guard

**Files:**
- Create: `.../strata_kernel_service/drain.rs`
- Modify: `.../strata_kernel_service/session.rs` (`handle_frame`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Drain cannot wait for anything until there is something countable to wait for.
This task builds only that, with no signal handling yet, so it is independently
testable.

**The boundary sits between identity/lane validation and journal binding** —
the same seam D-2 established for refusing spoofed requests before they cost an
fsync. A request that has not crossed it has done nothing durable and may be
refused freely; one that has crossed it must be waited for.

The transition-to-draining and the increment must be **serialized under one
mutex**, or a request can pass the "not draining" check and increment after the
controller has already decided to stop waiting.

```rust
pub(super) struct DrainController {
    inner: Mutex<DrainInner>,
    idle: Condvar,
}

struct DrainInner {
    draining: bool,
    active: usize,
}

impl DrainController {
    /// Returns None when draining -- the caller refuses the request with
    /// `service_draining` BEFORE any journal or effect work.
    pub(super) fn begin_request(self: &Arc<Self>) -> Option<ActiveRequest> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.draining {
            return None;
        }
        inner.active += 1;
        Some(ActiveRequest { controller: Arc::clone(self) })
    }

    /// Flips to draining and returns how many requests were already past the
    /// boundary. Serialized against begin_request by the same mutex.
    pub(super) fn start_draining(&self) -> usize {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.draining = true;
        inner.active
    }

    /// Waits for active requests to reach zero, or the deadline. Returns the
    /// count still running, so the caller can report an honest forced exit.
    pub(super) fn wait_for_idle(&self, grace: Duration) -> usize { /* condvar wait_timeout */ }
}

/// RAII. Decrements and notifies on EVERY exit path, panics included.
pub(super) struct ActiveRequest { controller: Arc<DrainController> }

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        let mut inner = self.controller.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.active = inner.active.saturating_sub(1);
        if inner.active == 0 {
            self.controller.idle.notify_all();
        }
    }
}
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_request_past_the_boundary_is_counted_and_one_refused_is_not() {
    let controller = Arc::new(DrainController::default());
    let guard = controller.begin_request().expect("not draining yet");
    assert_eq!(controller.active(), 1);

    let still_running = controller.start_draining();
    assert_eq!(still_running, 1, "the in-flight request must be visible to drain");
    assert!(controller.begin_request().is_none(), "draining must refuse new work");

    drop(guard);
    assert_eq!(controller.wait_for_idle(Duration::from_secs(1)), 0);
}

#[test]
fn wait_for_idle_returns_the_stragglers_rather_than_hanging() {
    let controller = Arc::new(DrainController::default());
    let _stuck = controller.begin_request().unwrap();
    controller.start_draining();
    let started = Instant::now();
    assert_eq!(controller.wait_for_idle(Duration::from_millis(300)), 1);
    assert!(started.elapsed() < Duration::from_secs(2));
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service drain`

- [ ] **Step 3: Implement `drain.rs` and wire the boundary into `handle_frame`**

In `session.rs`, after `SessionBinding::refuse` and **before** `bind_request`:

```rust
let Some(_active) = self.drain.begin_request() else {
    // Refused before the journal, so nothing durable happened and the client
    // may safely reissue the same identity after reconnecting.
    return LocalServiceResponse::error(
        &request.request_id,
        "service_draining",
        "daemon is draining; reconnect and reissue",
        true,
        Vec::new(),
    );
};
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/drain.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/session.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): an active-request boundary drain can actually wait on"
```

### Task 6: Signal, self-pipe, interruptible accept, and the forced-exit rule

**Files:**
- Modify: `.../strata_kernel_service/drain.rs`
- Modify: `.../strata_kernel_service/server.rs:99-119`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

The self-pipe needs **both ends**: a nonblocking, `CLOEXEC` write end for the
handler, and a read end the accept loop polls alongside the listener. The
handler does exactly one thing — `write(2)` one byte — and must **save and
restore `errno`**, tolerate `EAGAIN`, and touch nothing but lock-free atomics.
Repeated signals are idempotent.

Accept-loop shape: set the listener non-blocking, `poll()` on
`[listener_fd, drain_read_fd]`.

**"Stop accepting" is refined**, resolving a contradiction in v1: physical
connections keep being accepted during grace so that health and `stop` stay
reachable. What is refused is `open_session` and any request frame. Health
answers with `draining: true`.

**Reserve capacity for control frames**, or 64 established sessions make
shutdown unreachable — carve a small control reservation out of the admission
cap rather than letting session traffic consume all of it.

**The forced-exit rule, which is a real correctness hazard:** `_owner` and
`_endpoint` are locals in `serve`. Returning from `serve` drops them — releasing
ownership — while detached handler threads may still be running. At the grace
deadline the process must terminate **while the lock fds are still held**
(`std::process::exit` after an honest log, or `mem::forget` the guards). Never
release ownership and then let old handlers keep executing: that is precisely
the window in which a replacement daemon starts and two processes write the same
state.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn drain_refuses_new_work_leaves_a_draft_exactly_draft_and_records_nothing() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-drain");
    let mut lane = open_work_session(&service.socket_path, "client:drain");
    let change = begin_change_set(&mut lane, "draft that must survive drain");
    let audit_before = read_audit(&directory);

    signal_drain(&service);
    wait_until(|| health_probe(&service.socket_path)["draining"] == true,
               Duration::from_secs(5));

    let refused = exchange(&mut lane, &hello_request("request:during-drain"));
    assert_eq!(refused["error"]["code"], "service_draining", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");

    wait_for_exit(&service, Duration::from_secs(45));

    // Exactly draft -- not merely "not cancelled".
    let restarted = start_daemon(&directory, "d3-drain");
    assert_eq!(read_change_set(&restarted, &change)["state"], "draft");
    // And the refusal itself created no record.
    assert!(read_audit(&directory).starts_with(&audit_before),
            "a draining refusal appended to the audit log");
}

#[test]
fn a_request_that_crossed_the_boundary_finishes_inside_the_grace() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon_with_slow_worker(&directory, "d3-grace");
    let mut lane = open_work_session(&service.socket_path, "client:grace");
    let change = begin_change_set(&mut lane, "in flight across drain");
    send_without_reading(&mut lane, &advance_request("request:in-flight", &change));
    // Deterministic barrier: only signal once health reports it counted.
    wait_until(|| health_probe(&service.socket_path)["activeRequests"] == "1",
               Duration::from_secs(10));

    signal_drain(&service);
    let response = read_frame_as_json(&mut lane);
    assert_eq!(response["requestId"], "request:in-flight", "{response}");
    assert_ne!(response["error"]["code"], "service_draining",
               "a request already past the boundary must not be refused: {response}");
}

#[test]
fn a_daemon_with_nothing_active_exits_promptly() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-fast-exit");
    let started = Instant::now();
    signal_drain(&service);
    wait_for_exit(&service, Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(10),
            "an idle daemon waited out the whole grace period");
}

#[test]
fn an_over_grace_mutation_disconnects_and_replays_exactly_once() {
    // The straggler is severed at the deadline; the client replays the same
    // identity after restart and the effect happens exactly once.
    // ... (drives a worker slower than the configured grace)
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement, including the `--drain-grace-ms` flag**

v1 promised a configurable grace and never parsed one. Add it to `serve`'s
`parse_named` set with a default of 30_000 and thread it to `wait_for_idle`.

```rust
// server.rs accept loop, replacing `for incoming in listener.incoming()`.
listener.set_nonblocking(true)?;
loop {
    if drain.is_draining() { break; }
    match listener.accept() {
        Ok((stream, _)) => { /* admission + spawn, unchanged */ }
        Err(e) if e.kind() == ErrorKind::WouldBlock => {
            // Blocks on BOTH the listener and the drain pipe, so a signal
            // wakes the loop immediately rather than after a poll interval.
            poll_listener_or_drain(&listener, &drain)?;
        }
        Err(e) => return Err(e).context("accept local service connection"),
    }
}
let stragglers = drain.wait_for_idle(grace);
if stragglers > 0 {
    eprintln!("forced exit with {stragglers} request(s) still running");
    // Terminate while the lock fds are STILL HELD. Returning from serve would
    // drop them and let a replacement daemon start while these handlers run.
    std::mem::forget(_owner);
    std::mem::forget(_endpoint);
    std::process::exit(3);
}
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/drain.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): interruptible accept, bounded grace, ownership held to exit"
```

### Task 7: `start`, `stop`, and `health` subcommands

**Files:**
- Modify: `.../strata_kernel_service/main.rs`
- Modify: `.../strata_kernel_service/protocol.rs` (`stop` first-frame variant, Task 3)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

v1 listed `stop` in its file structure and then never added a task for it. This
task adds it.

`stop` is an **in-band control frame**, not a signal sent to a PID: the daemon
asks *itself* to drain. That keeps PID data non-authoritative and sidesteps
PID-reuse entirely.

`start` is added as an **alias** for `serve`; `serve` stays for compatibility
and both dispatch routes are tested. Renaming would break every harness call
site for no benefit.

Surface:

```
strata-kernel-service health --socket <path>
strata-kernel-service stop   --socket <path> [--wait-ms <n>]
```

Exit codes, defined rather than incidental:

| Code | Meaning |
|---|---|
| 0 | healthy / drain accepted |
| 3 | endpoint absent |
| 4 | endpoint present but unreachable or not our protocol |
| 5 | already draining |
| 6 | timed out waiting |

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn stop_drains_through_the_control_frame_and_health_reports_it() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-stop");
    assert_eq!(run_cli(&["health", "--socket", &service.socket_path]).code(), Some(0));
    assert_eq!(run_cli(&["stop", "--socket", &service.socket_path]).code(), Some(0));
    wait_for_exit(&service, Duration::from_secs(45));
    assert_eq!(run_cli(&["health", "--socket", &service.socket_path]).code(), Some(3),
               "a stopped daemon's endpoint must read as absent");
}

#[test]
fn health_and_stop_stay_reachable_at_the_admission_cap() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-reserved");
    let _saturating = saturate_admission(&service); // 32 actors x 2 lanes
    // Control capacity is reserved, so shutdown never becomes unreachable.
    assert_eq!(run_cli(&["health", "--socket", &service.socket_path]).code(), Some(0));
    assert_eq!(run_cli(&["stop", "--socket", &service.socket_path]).code(), Some(0));
}

#[test]
fn start_is_an_alias_and_serve_still_works() {
    assert!(run_cli(&["start", "--help"]).success());
    assert!(run_cli(&["serve", "--help"]).success());
}
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement dispatch and the control client**

```rust
match command.to_str() {
    // `start` is an alias, not a rename: every existing harness calls `serve`.
    Some("serve") | Some("start") => serve(&remaining),
    Some("stop") => stop(&remaining),
    Some("health") => health(&remaining),
    Some("validate-socket") => validate_socket(&remaining),
    Some("export-snapshot") => export_snapshot(&remaining),
    _ => bail!("unknown command; run with --help"),
}
```

Both `stop` and `health` connect with bounded connect/read/write deadlines and
strict reply parsing; a malformed or foreign reply is exit 4, never a hang.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/main.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): start alias, plus health and stop as in-band control"
```

### Task 8: `service_draining` is terminal for the caller

**Files:**
- Modify: `packages/coordination-client/src/client.ts`
- Test: `packages/coordination-client/tests/client.test.ts`

**v1's Task 6 is rejected.** It put `service_draining` in `BACKOFF_CODES` while
the plan header called it non-replayed — two different contracts in one
document. Beyond the contradiction, the mechanism does not work: during a real
restart gap the reconnect raises `ENOENT`/`ECONNREFUSED` → `connect_failed`,
which is not in `BACKOFF_CODES`, so the retry chain breaks precisely when it
matters. v1's test hid this by having the fake call `socket.end()` instead of
going away.

The contract: **drop the lane deterministically and surface a typed retryable
error.** The caller decides whether to reissue after the daemon returns. This
matches D-2's deliberate choice to leave later-generation rereads to the caller
— an automatic same-identity redrive would silently carry a read across a
service epoch.

Automatic redrive is not wrong in principle (the daemon proves the request never
crossed the effect boundary), but it needs its own state machine with restart
downtime, reconnect, and epoch-change tests — not a one-line set membership.
That is out of scope here.

- [ ] **Step 1: Write the failing test**

```ts
it("surfaces service_draining as terminal and drops the lane", async () => {
  const service = await unixServer((socket, request) => {
    socket.write(errorFrame(request.requestId, "service_draining", true));
  });
  const client = createCoordinationClient({
    socketPath: service.socketPath,
    clientId: "client:draining"
  });

  await expect(client.beginChangeSet("during a drain", 2_000)).rejects.toMatchObject({
    code: "service_draining",
    retryable: true
  });
  // Exactly one attempt: the transport does not decide to reissue.
  expect(service.requests).toHaveLength(1);
  // The lane is dropped, so a later call opens a fresh connection rather than
  // reusing one bound to a daemon that is going away.
  await expect(client.hello(500)).rejects.toBeInstanceOf(CoordinationClientError);
  client.close();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @strata-code/coordination-client test client.test`

- [ ] **Step 3: Implement — drop the lane, surface the error**

Do **not** add the code to `BACKOFF_CODES`. Add an explicit arm that resets the
lane before rethrowing, and document why it is not a backoff code.

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add packages/coordination-client/src/client.ts \
        packages/coordination-client/tests/client.test.ts
git commit -m "feat(d3): service_draining is terminal for the caller, not a silent redrive"
```

### Task 9: The harness stops discarding readiness identity — with real validation

**Files:**
- Modify: `packages/live-compare/src/service.ts:112-124`
- Test: `packages/live-compare/tests/service.test.ts`

`service.ts:112` casts the readiness line with `as { socketPath: string }`.
Widening that cast to more fields would just be a bigger unchecked assertion, so
**parse it with a zod schema** and fail loudly on a malformed line.

**Scope discipline:** this task only stops discarding the epoch. It does **not**
implement epoch-change reread/deduplication — that remains an open D-2 risk, and
describing this task as addressing it would overstate what ships.

- [ ] **Step 1: Write the failing test**

```ts
it("validates and retains the readiness identity the daemon publishes", async () => {
  const service = await startKernelService({ /* existing fixture options */ });
  expect(service.serviceEpoch).toMatch(/^[0-9]+$/);
  expect(typeof service.recovered).toBe("boolean");
  expect(["tscOnly", "behavioral"]).toContain(service.validationMode);
  expect(
    service.validationManifestDigest === null ||
      /^[0-9a-f]{64}$/.test(service.validationManifestDigest)
  ).toBe(true);
  await service.stop();
});

it("rejects a malformed readiness line instead of proceeding", async () => {
  await expect(startKernelServiceWithReadiness('{"socketPath":"/tmp/x.sock"}')).rejects.toThrow(
    /readiness/i
  );
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Parse with a schema**

```ts
const readinessSchema = z
  .object({
    protocolVersion: z.literal(2),
    socketPath: z.string().min(1),
    serviceEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
    recovered: z.boolean(),
    validationMode: z.enum(["tscOnly", "behavioral"]),
    // The readiness line OMITS this key without a manifest, where the
    // client-facing `hello` carries an explicit null. Normalize to null.
    validationManifestDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()
  })
  .strict();
const ready = readinessSchema.parse(JSON.parse(line));
```

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Commit**

```bash
git add packages/live-compare/src/service.ts packages/live-compare/tests/service.test.ts
git commit -m "feat(d3): validate the readiness line instead of casting it"
```

### Task 10: The owed measurement — baseline FIRST

**Files:**
- Create: `crates/strata-kernel/tests/lock_hold_time.rs` (`#[ignore]` by default)
- Modify: `Cargo.toml` (feature `lock-instrumentation`)
- Modify: `decisions.md` (**new dated entry**, never an edit)

D-2 closed recording that the honest before/after is **lock hold time, not
disk**. v1 deferred this to a described-but-unwritten harness, which the review
correctly called a plan failure.

**Sequencing correction:** the baseline must be captured **before** Task 6
rewires the accept loop. If the claim is "before/after D-2", the honest
comparison is pre-D-2 `db15b38` versus post-D-2 `0e07f60`; a post-D-3 run alone
does not pay that debt. Then rerun the unchanged harness after D-3 as a
regression check.

Specify exactly:
- Cargo feature `lock-instrumentation` gates all timing code; default build is
  untouched.
- Instrumented mutexes, named with file and line: the protocol context, the
  request journal, and the audit log in `session.rs`, plus `Admission` and the
  ownership registry in `server.rs`.
- Timing is RAII: **acquisition wait** measured before the guard, **hold
  duration** from acquisition to guard drop. Report them separately — a short
  hold with a long wait means something entirely different from the reverse.
- Report count, total, mean, max, and p50/p95/p99 from a bounded histogram.
- Identical fixed workload at N=1 and N=10: same request mix, same iteration
  count, same corpus.
- Calibrate instrumentation overhead with a no-op run and subtract it.

- [ ] **Step 1: Capture the pre-D-2 baseline at `db15b38`**

```bash
git worktree add .claude/worktrees/lock-baseline db15b38
# apply the instrumentation patch, run the fixed workload at N=1 and N=10
```

- [ ] **Step 2: Capture the post-D-2 baseline at `0e07f60`**

- [ ] **Step 3: Run the same harness after Task 6 as a regression check**

- [ ] **Step 4: Append a NEW dated `decisions.md` entry**

Reference the D-2 entry and resolve its debt with the actual figures. State
plainly whether the global locks are a problem at ten clients. **If they are, log
the decision — do not fix it inside D-3.**

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/tests/lock_hold_time.rs crates/strata-kernel/Cargo.toml decisions.md
git commit -m "measure(d3): lock hold time across D-2, the debt that slice recorded"
```

### Task 11: Gates, chain, close

- [ ] Simultaneous two-daemon race → exactly one serves; loser mutates no
      canonical state (Task 2).
- [ ] Live endpoint never unlinked by a contender; definitely-stale reclaimed;
      non-socket never destroyed (Task 4).
- [ ] Drain: `draining: true`, typed refusal, draft stays exactly `draft`, no
      audit record from a refusal, in-flight request answered, idle daemon exits
      promptly, over-grace straggler severed and replayed exactly once (Task 6).
- [ ] Control reachable at the admission cap (Task 7).
- [ ] `SIGKILL` with live bridge workers → ownership reclaimed (Task 1).
- [ ] Full chain detached with `PATH=/opt/homebrew/bin:$PATH`. **Do not run
      `cargo` concurrently** — it rewrites the daemon binary the tests spawn.
- [ ] **Run the chain in the MAIN checkout after merging**, not only in the
      worktree.
- [ ] `decisions.md` close (new entry); `docs/product-roadmap.md` D-3 closed.

---

## Risks carried into D-3

- **The three D-2 leaks remain open and become more load-bearing**, because D-3
  is what declares the daemon long-lived: unbounded `request_bindings`,
  insert-only `change_set_locks`, and in-memory-only delivered ceilings. A
  retention/checkpoint story is required before "long-lived" is honest. None are
  D-3 deliverables; all three need a logged decision.
- **`flock` is advisory and NFS-hostile.** Correct for a local state directory,
  which is the only supported deployment. Document that deleting or replacing
  the state directory or lock inode while serving violates the cooperative
  contract.
- **The 30s grace is a guess until the drain gate runs.** If a real advance
  exceeds it, prefer raising it over severing, and log the decision.

## Self-review (v2)

All review corrections mapped: endpoint lock + fixed order → Task 1; ordering
before `open` → Task 2; four-way endpoint classification failing closed → Task
4; Task 3/4 reordered (health first, entanglement claim withdrawn) → Tasks 3–4;
drain controller with RAII active-request guard, serialized boundary, condvar,
two-ended self-pipe, errno-preserving handler, reserved control capacity, and
the forced-exit-while-holding-locks rule → Tasks 5–6; `stop` designed and
implemented in-band, `start` as alias, exit codes → Task 7; `service_draining`
made terminal rather than a `BACKOFF_CODES` member → Task 8; strict readiness
validation and scope discipline → Task 9; measurement made concrete with a
pre-D-2 baseline and an append-only entry → Task 10; test gaps (in-module unit
tests, simultaneous race, live-endpoint contender, grace flag actually parsed)
→ Tasks 1, 2, 4, 6.

**Placeholder scan:** one remains, deliberately —
`an_over_grace_mutation_disconnects_and_replays_exactly_once` (Task 6) has its
body elided because its shape depends on the slow-worker fixture chosen in Step
3. Flagged rather than hidden; the second reviewer should decide whether it must
be concrete before execution.

**Type consistency:** `CanonicalStateDir` → `OwnerLock::acquire` (Task 1) is
used in Task 2; `EndpointStatus` (Task 4) is consumed only in `server.rs`;
`DrainController::begin_request` / `start_draining` / `wait_for_idle` and
`ActiveRequest` (Task 5) are the only drain APIs Task 6 touches;
`service_draining` is spelled identically in Rust (Task 5) and TypeScript
(Task 8); `FirstFrame::Stop` is introduced in Task 3 and consumed in Task 7.

**Open question for the second reviewer:** Task 6 forces exit with
`std::process::exit(3)` while leaking the lock guards deliberately. That is
correct for ownership safety but means a forced exit never runs destructors —
including any redb cleanup. I believe that is fine because crash recovery is
already the contract for abrupt termination, but it deserves a second opinion.
