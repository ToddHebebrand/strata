# Item D-3 — Daemon lifecycle: ownership, health, drain (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v1 — NOT YET REVIEWED. Send for independent methodology review
(Codex CLI, `gpt-5.5` or strongest available, reasoning `xhigh`, read-only,
repo-grounded) before executing, per `CLAUDE.md`. D-1 and D-2 both returned
PROCEED-WITH-CORRECTIONS, and in D-2 the review refuted a claim I had verified
myself.

**Goal:** make the daemon safe to call long-lived — exactly one daemon owns a
state directory, its health can be polled without generating durable writes, and
it can be stopped without lying about what it cancelled.

**Architecture:** ownership becomes a lifetime-held advisory file lock on the
canonical state directory, acquired before any recovery or durable construction.
Health rides D-2's handshake, which is already proven to append nothing durable.
Drain is a shutdown state machine over D-2's admission registry: stop accepting,
refuse unstarted requests with a typed retryable code, let running handlers
finish inside a bounded grace, then exit and let existing crash recovery
reconcile.

**Tech Stack:** Rust (`strata-kernel` service binary), `libc` (already a
dependency — `flock`, `kill`), the D-2 session protocol, TypeScript
`@strata-code/coordination-client` for the client-visible drain code.

**Spec:** `docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-3.

**Baseline:** `main` ≥ `0e07f60` (the D-2 merge). Anchors below were re-pinned
against that commit; D-2's v1 plan shipped stale anchors and the review caught
them, so treat any anchor that does not match what you see as a signal to
re-read rather than to guess.

## Global constraints

- **No agent-visible semantic change to existing actions.** Same actions, same
  results, same validation. Drain adds one new terminal outcome, nothing else.
- **Every existing suite must pass**, including the full key-free chain
  (`pnpm kernel:full-key-free:test`). That is the acceptance bar.
- **PID data is metadata, never authority.** Stale-file and PID-reuse races make
  a PID file a hint; the held lock is the truth.
- **Health must not touch the journalled request path.** D-2 proved a handshake
  appends nothing durable; health inherits that property and must keep a test
  asserting it.
- **Shutdown must never report a change set as cancelled unless the canonical
  lifecycle actually cancelled it.** This is the spec's one emphasized
  prohibition.
- Bounded everything; strict JSON, `deny_unknown_fields` / `.strict()` stay.
- No item-C work, no packaging (cut until after item E), no keyed runs.
- `packages/live-compare/src/tasks.ts` is never staged.
- All test invocations need Homebrew Node on PATH
  (`PATH=/opt/homebrew/bin:$PATH`); the native `better-sqlite3` build is ABI-
  matched to it. A bare `cargo test` fails with a NODE_MODULE_VERSION mismatch.

## What is actually there today — verified, not assumed

Checked against `main` @ `0e07f60` before writing this plan:

- **No file lock of any kind.** `grep -rn "flock\|LOCK_EX\|lockfile\|O_EXCL"
  crates/strata-kernel/src` returns nothing.
- **No signal handling of any kind.** The only `signal` match in the crate is an
  unrelated comment in `bridge/persistent.rs`. The daemon has no SIGTERM
  handler.
- **`stop` today is an abrupt kill.** `packages/live-compare/src/service.ts:118`
  does `child.kill("SIGTERM")` and waits for exit. With no handler, the process
  dies wherever it is and crash recovery reconciles. **There is nothing to build
  drain on top of — it is being built from zero, signal handling included.**
- **Three subcommands exist** (`main.rs:38-44`): `serve`, `validate-socket`,
  `export-snapshot`. No `start`, `stop`, or `health`.
- **Startup order (`server.rs:46-101`), unchanged by D-2:** `ServiceSession::open`
  (`:52`) → seed-green gate (`:65`) → `finalize_startup` (`:67`) → eager hydrate
  (`:76`) → `bind_private_socket` (`:82`) → readiness line → admission registry
  (`:99`) → accept loop (`:101`). Recovery and durable construction really do
  happen before bind, so the spec's ordering argument holds.
- **The accept loop blocks in `listener.incoming()` (`server.rs:101`)** with no
  shutdown path. Unblocking it is a real design problem, addressed in Task 5.
- **The harness discards readiness identity.** `service.ts:112` parses the line
  as `{ socketPath: string }` and the returned object keeps only `socketPath`,
  `directory`, `auditPath` — `serviceEpoch`, `recovered`, `validationMode`, and
  `validationManifestDigest` are dropped on the floor, exactly as the spec says.

## File structure

- **Create** `crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs` —
  the owner lock, state-directory identity canonicalization, and the stale-
  socket decision. One responsibility: who is allowed to serve this state dir.
- **Create** `crates/strata-kernel/src/bin/strata_kernel_service/drain.rs` — the
  shutdown state machine and its shared `DrainState` handle.
- **Modify** `server.rs` — startup sequence gains the lock acquisition and
  stale-socket resolution before `ServiceSession::open`; the accept loop becomes
  interruptible; `handle_connection` consults `DrainState`.
- **Modify** `protocol.rs` — `health` handshake variant and the `service_draining`
  error code.
- **Modify** `main.rs` — `health` and `stop` subcommands, module registration.
- **Modify** `packages/coordination-client/src/client.ts` — surface
  `service_draining` as a typed, retryable, NON-replayed outcome.
- **Modify** `packages/live-compare/src/service.ts` — stop discarding readiness
  identity.
- **Test** `crates/strata-kernel/tests/lifecycle.rs` — new suite for the race,
  stale socket, health, and drain gates.

---

### Task 1: The owner lock — exclusion before any durable work

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs:1-7` (module list)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**Interfaces:**
- Produces: `OwnerLock::acquire(state_dir: &Path) -> Result<OwnerLock, LockRefusal>`,
  where `OwnerLock` holds the fd for the process lifetime and releases on drop;
  `LockRefusal::HeldByAnother` and `LockRefusal::Unavailable(io::Error)`.
- Produces: `canonical_state_identity(db_path: &Path) -> Result<PathBuf>` —
  resolves symlinks and `..` so two spellings of one directory cannot both win.

Use `flock(fd, LOCK_EX | LOCK_NB)` on a `<state-dir>/.strata-owner` file, held
open for the process lifetime. **Not** `O_EXCL` creation: an `O_EXCL` file
survives a crash and needs a stale-file story, whereas an advisory lock is
released by the kernel when the holder dies, crash included. That difference is
the whole reason PID data is metadata here.

The lock is written with the PID and service epoch as **diagnostic content
only** — an operator reading the file learns who to look at; nothing in the code
may branch on it.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_second_daemon_cannot_take_the_owner_lock() {
    let directory = TempDir::new().unwrap();
    let first = OwnerLock::acquire(directory.path()).expect("first daemon owns the dir");
    let second = OwnerLock::acquire(directory.path());
    assert!(
        matches!(second, Err(LockRefusal::HeldByAnother)),
        "a second holder must be refused while the first lives"
    );
    drop(first);
    // The kernel releases an advisory lock when its holder dies, so a crashed
    // owner leaves nothing to clean up.
    assert!(OwnerLock::acquire(directory.path()).is_ok());
}

#[test]
fn two_spellings_of_one_state_dir_are_one_identity() {
    let directory = TempDir::new().unwrap();
    let nested = directory.path().join("state");
    std::fs::create_dir_all(&nested).unwrap();
    let direct = canonical_state_identity(&nested.join("kernel.redb")).unwrap();
    let indirect =
        canonical_state_identity(&nested.join("..").join("state").join("kernel.redb")).unwrap();
    assert_eq!(direct, indirect);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle owner_lock`
Expected: FAIL — `OwnerLock` does not exist.

- [ ] **Step 3: Implement `lifecycle.rs`**

```rust
pub(super) struct OwnerLock {
    // Held for the process lifetime. Dropping closes the fd, which releases
    // the advisory lock; the kernel does the same if the process dies.
    file: std::fs::File,
}

pub(super) enum LockRefusal {
    HeldByAnother,
    Unavailable(std::io::Error),
}

impl OwnerLock {
    pub(super) fn acquire(state_dir: &Path) -> Result<Self, LockRefusal> {
        let path = state_dir.join(".strata-owner");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(LockRefusal::Unavailable)?;
        let taken = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if taken != 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(code) if code == libc::EWOULDBLOCK => Err(LockRefusal::HeldByAnother),
                _ => Err(LockRefusal::Unavailable(error)),
            };
        }
        Ok(Self { file })
    }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/main.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): owner lock keyed to the canonical state directory"
```

### Task 2: Acquire the lock BEFORE recovery, and prove the ordering

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs:46-52`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

The ordering is the deliverable, not the lock. Today `ServiceSession::open`
(`server.rs:52`) recovers and constructs durable state before anything else, so
a losing second daemon that were excluded at bind time would already have run
recovery against a directory it does not own.

The gate is therefore not "the second daemon exits" but "the second daemon
leaves no trace" — same shape as B-2's seed-red gate, which asserts a refusing
daemon audits nothing.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_losing_second_daemon_runs_no_recovery_and_leaves_no_trace() {
    let directory = TempDir::new().unwrap();
    let first = start_daemon(&directory, "d3-race-a");
    let audit_before = std::fs::read_to_string(directory.path().join("audit.jsonl")).unwrap();

    let second = start_daemon_expecting_failure(&directory, "d3-race-b");
    assert!(second.status.code() == Some(2), "losing daemon must exit 2");
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("already owns"),
        "the refusal must name the reason: {}",
        String::from_utf8_lossy(&second.stderr)
    );

    // The whole point of ordering: no recovery, no start event, nothing.
    let audit_after = std::fs::read_to_string(directory.path().join("audit.jsonl")).unwrap();
    assert_eq!(
        audit_before, audit_after,
        "a refused daemon must not touch the audit log"
    );
    drop(first);
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle losing_second_daemon`
Expected: FAIL — both daemons start; the second appends recovery events.

- [ ] **Step 3: Insert acquisition ahead of `ServiceSession::open`**

```rust
// server.rs, immediately after validate_socket_path and BEFORE
// ServiceSession::open. Ordering is load-bearing: recovery and durable
// construction happen inside open(), so a daemon that does not own this state
// directory must be excluded before any of that work, not when it later tries
// to bind.
let state_dir = config
    .db_path
    .parent()
    .context("state path has no parent directory")?;
let _owner = match OwnerLock::acquire(state_dir) {
    Ok(lock) => lock,
    Err(LockRefusal::HeldByAnother) => {
        bail!("another daemon already owns this state directory; refusing to serve")
    }
    Err(LockRefusal::Unavailable(error)) => {
        return Err(error).context("acquire state directory owner lock")
    }
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): exclude a losing daemon before recovery, not at bind"
```

### Task 3: Stale-socket resolution, gated on holding the lock

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs` (`bind_private_socket`)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

`bind_private_socket` currently unlinks any existing socket unconditionally
(`server.rs`, `if path.exists() { fs::remove_file(path) }`). That is a live
footgun the moment two daemons can be pointed at one endpoint: the second one
silently steals the endpoint from a healthy first.

The rule: **unlink only while holding the owner lock, and only after the socket
fails to answer a health handshake.** Holding the lock is what removes the
check/unlink/bind race — without it, "probe then unlink" has a window.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_live_socket_is_never_unlinked_and_a_dead_one_is() {
    let directory = TempDir::new().unwrap();
    let live = start_daemon(&directory, "d3-stale-live");
    let socket = live.socket_path.clone();
    // A daemon holding the lock still must not remove a socket that answers.
    assert!(socket_answers_health(&socket), "precondition: the socket is live");

    // Kill without cleanup, exactly as a crash would.
    drop(live);
    wait_until(|| !socket_answers_health(&socket), Duration::from_secs(10));
    assert!(socket.exists(), "precondition: a crash leaves the socket file behind");

    let restarted = start_daemon(&directory, "d3-stale-live");
    assert!(socket_answers_health(&restarted.socket_path));
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle stale`
Expected: FAIL — `socket_answers_health` does not exist yet (Task 4 supplies the
health handshake; write Task 4 first if you are executing strictly in order,
or accept this task as blocked-on-4 and reorder).

> **Sequencing note for the executor:** Tasks 3 and 4 are mutually entangled —
> stale detection needs the health handshake, and health needs somewhere to be
> served. Implement Task 4's handshake variant first, then return here. This is
> called out rather than hidden because D-2 hit the same shape with the
> handshake and the read loop, and pretending they were separable would have
> left both suites red between commits.

- [ ] **Step 3: Implement the guarded unlink**

```rust
// Replaces the unconditional remove_file in bind_private_socket.
if path.exists() {
    if lifecycle::socket_answers_health(path) {
        bail!(
            "an existing daemon is already serving this endpoint; refusing to serve"
        );
    }
    // We hold the owner lock, and the endpoint did not answer. Safe to reclaim.
    fs::remove_file(path).context("remove stale local service socket")?;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/lifecycle.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): reclaim a socket only when it is provably dead"
```

### Task 4: `health` on the handshake, appending nothing durable

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs` (`handle_connection`)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` (`health` subcommand)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Health is a **handshake variant**, not an action. D-2 established that the
handshake never reaches `bind_request`, and proved it with a test asserting the
audit log is byte-identical across ten opened sessions. Health inherits that and
must carry the same assertion — a health probe on the request path would make
monitoring generate durable fsync traffic forever.

Wire:

```json
{"protocolVersion":2,"type":"health"}
```

replied to with:

```json
{"protocolVersion":2,"type":"health_ok","serviceEpoch":"1","recovered":false,
 "validationMode":"tscOnly","validationManifestDigest":null,"draining":false}
```

`draining` is what makes health useful during Task 5's shutdown, and is why
health carries state rather than being a bare pong.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn health_reports_identity_and_appends_nothing_durable() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-health");
    let journal = journal_len(directory.path());
    let audit = std::fs::read_to_string(directory.path().join("audit.jsonl")).unwrap();
    assert!(journal > 0 || audit.len() > 0, "precondition: startup wrote something");

    for _ in 0..25 {
        let reply = health_probe(&service.socket_path);
        assert_eq!(reply["type"], "health_ok", "{reply}");
        assert_eq!(reply["serviceEpoch"], service.epoch.to_string());
        assert_eq!(reply["draining"], false, "{reply}");
    }

    assert_eq!(journal_len(directory.path()), journal, "health wrote to the journal");
    assert_eq!(
        std::fs::read_to_string(directory.path().join("audit.jsonl")).unwrap(),
        audit,
        "health wrote to the audit log"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle health`
Expected: FAIL — the handshake parser rejects `"type":"health"`.

- [ ] **Step 3: Implement the variant**

Turn the existing single-struct `OpenSession` parse into a two-variant
first-frame enum. **Keep `open_session`'s wire bytes identical** — the D-2
golden corpus asserts them, and this must be an addition, not a reshape.

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

A health connection is answered and closed immediately; it never takes a
session binding, never enters the ownership registry, and holds its admission
permit only for the duration of the probe.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Expected: PASS

Then confirm the D-2 corpus is untouched:
Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service protocol_`
Expected: PASS — if a golden case now fails, the handshake was reshaped rather
than extended. Fix the shape, do not edit the fixture.

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/main.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): health rides the handshake and stays off the journal"
```

### Task 5: Drain — an interruptible accept loop and a typed refusal

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/drain.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs:99-119`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` (`handle_frame` entry)
- Test: `crates/strata-kernel/tests/lifecycle.rs`

Two verified problems make this the hardest task:

1. **There is no signal handler at all**, so SIGTERM currently kills the process
   outright. The handler must be async-signal-safe: set an atomic flag and write
   one byte to a self-pipe. Nothing else. No allocation, no locking, no logging.
2. **`listener.incoming()` blocks (`server.rs:101`)** with no way out. Set the
   listener non-blocking and poll it alongside the self-pipe read end, so the
   accept loop wakes on either a connection or the drain signal.

Drain sequence:
1. Flip `DrainState` to draining. Health immediately reports `draining: true`.
2. Stop accepting: new connections get `server_draining` and a close.
3. Unstarted requests on established lanes get a typed retryable
   `service_draining` error.
4. Running handlers get a bounded grace period (default 30s, flag-configurable).
5. Exit. **Nothing cancels anything.** Drafts and queued tickets stay durable and
   existing crash recovery reconciles them on restart.

Step 5 is where the spec's one prohibition lives. A change set must never be
reported cancelled unless the canonical lifecycle actually cancelled it, so
drain deliberately does *no* change-set work — the temptation to "tidy up" open
drafts on the way out is exactly the bug being forbidden.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn drain_refuses_new_work_without_cancelling_anything() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon(&directory, "d3-drain");
    let mut lane = open_work_session(&service.socket_path, "client:drain");
    let change = begin_change_set(&mut lane, "open draft that must survive drain");

    signal_drain(&service);
    wait_until(|| health_probe(&service.socket_path)["draining"] == true,
               Duration::from_secs(5));

    // An unstarted request on an established lane is refused, and TYPED.
    let refused = exchange(&mut lane, &hello_request("request:during-drain"));
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "service_draining", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");

    wait_for_exit(&service, Duration::from_secs(45));

    // The draft is still a draft. Drain cancelled nothing.
    let restarted = start_daemon(&directory, "d3-drain");
    let operation = read_change_set(&restarted, &change);
    assert_ne!(
        operation["state"], "cancelled",
        "drain reported a change set as cancelled that the lifecycle never cancelled: {operation}"
    );
}

#[test]
fn a_running_request_finishes_inside_the_grace_period() {
    let directory = TempDir::new().unwrap();
    let service = start_daemon_with_slow_worker(&directory, "d3-grace");
    let mut lane = open_work_session(&service.socket_path, "client:grace");
    let change = begin_change_set(&mut lane, "in flight across drain");
    send_without_reading(&mut lane, &advance_request("request:in-flight", &change));

    signal_drain(&service);

    // The in-flight request gets a real answer, not a severed connection.
    let response = read_frame_as_json(&mut lane);
    assert_eq!(response["requestId"], "request:in-flight", "{response}");
    assert_ne!(
        response["error"]["code"], "service_draining",
        "a request already running must not be refused mid-flight: {response}"
    );
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle drain`
Expected: FAIL — SIGTERM kills the daemon outright, so the health probe never
observes `draining` and the connection is severed.

- [ ] **Step 3: Implement `drain.rs` and rewire the accept loop**

```rust
// drain.rs
pub(super) struct DrainState {
    draining: AtomicBool,
    // Written by the signal handler. Async-signal-safe: one byte, no locks.
    wake: OwnedFd,
}

impl DrainState {
    pub(super) fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }
}

// server.rs accept loop, replacing `for incoming in listener.incoming()`.
listener.set_nonblocking(true)?;
loop {
    if drain.is_draining() {
        break;
    }
    match listener.accept() {
        Ok((stream, _)) => { /* admission + spawn, unchanged from D-2 */ }
        Err(error) if error.kind() == ErrorKind::WouldBlock => {
            // Block on BOTH the listener and the drain pipe, so a drain signal
            // wakes the loop immediately rather than after a poll interval.
            wait_for_connection_or_drain(&listener, &drain)?;
        }
        Err(error) => return Err(error).context("accept local service connection"),
    }
}
drain_established_lanes(&drain, GRACE_PERIOD);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/drain.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/server.rs \
        crates/strata-kernel/src/bin/strata_kernel_service/session.rs \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3): drain refuses new work and cancels nothing"
```

### Task 6: `service_draining` is a redrive, not a transport replay

**Files:**
- Modify: `packages/coordination-client/src/client.ts` (the `BACKOFF_CODES` set and its comment)
- Test: `packages/coordination-client/tests/client.test.ts`

D-2 drew a line the retry contract depends on: transport replay resends
byte-identical frames for a request that may already have run, while an
operational failure is surfaced so the caller composes a NEW request with a new
idempotency key.

`service_draining` is neither, quite, and getting it wrong in either direction
is bad. It is guaranteed **unstarted** — that is why the daemon refuses rather
than severing — so it is safe to retry. But the daemon it was sent to is going
away, so retrying against the same connection is pointless; the client must
reconnect first. Treat it as a reconnect-then-retry with the SAME identity,
bounded by the original deadline.

- [ ] **Step 1: Write the failing test**

```ts
it("reconnects and retries the same identity on service_draining", async () => {
  let drainingUntil = 2;
  const service = await unixServer((socket, request, connection) => {
    if (connection <= drainingUntil) {
      socket.write(errorFrame(request.requestId, "service_draining", true));
      socket.end();
      return;
    }
    socket.write(success(request.requestId, CHANGE_SET));
  });
  const client = createCoordinationClient({
    socketPath: service.socketPath,
    clientId: "client:draining"
  });

  await expect(client.beginChangeSet("survive a drain", 5_000)).resolves.toMatchObject({
    changeSetId: "change:retry"
  });
  // Same identity across the reconnects -- this is one request following a
  // daemon through a restart, not three different requests.
  expect(new Set(service.requests.map((r) => r.requestId)).size).toBe(1);
  expect(new Set(service.requests.map((r) => r.idempotencyKey)).size).toBe(1);
  expect(service.connections()).toBeGreaterThan(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @strata-code/coordination-client test client.test`
Expected: FAIL — `service_draining` is surfaced to the caller as an error.

- [ ] **Step 3: Add the code to the backoff set with its reasoning**

```ts
/**
 * ... existing comment ...
 *
 * `service_draining` joins this set for a reason specific to it: the daemon
 * refuses rather than severing precisely so the request is KNOWN unstarted, so
 * retrying the same identity cannot double-apply. What makes it different from
 * the other two is that the daemon is going away, so the retry has to land on
 * a new connection -- the lane is dropped before backing off.
 */
const BACKOFF_CODES = new Set(["request_in_progress", "server_busy", "service_draining"]);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @strata-code/coordination-client test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coordination-client/src/client.ts \
        packages/coordination-client/tests/client.test.ts
git commit -m "feat(d3): service_draining reconnects and retries the same identity"
```

### Task 7: Stop discarding readiness identity

**Files:**
- Modify: `packages/live-compare/src/service.ts:112-124`
- Test: `packages/live-compare/tests/service.test.ts`

Verified: `service.ts:112` parses the readiness line as `{ socketPath: string }`
and returns only `socketPath`, `directory`, `auditPath`. The daemon has emitted
`serviceEpoch`, `recovered`, `validationMode`, and `validationManifestDigest`
since B-2, and every one of them is dropped.

This matters beyond tidiness: D-2 recorded that the delivered-event ceiling is
in-memory only, so a client must **reread and deduplicate on a service-epoch
change**. A harness that discards the epoch cannot implement that rule.

- [ ] **Step 1: Write the failing test**

```ts
it("retains the readiness identity the daemon publishes", async () => {
  const service = await startKernelService({ /* existing fixture options */ });
  expect(service.serviceEpoch).toMatch(/^[0-9]+$/);
  expect(typeof service.recovered).toBe("boolean");
  expect(["tscOnly", "behavioral"]).toContain(service.validationMode);
  expect(service.validationManifestDigest === null ||
         /^[0-9a-f]{64}$/.test(service.validationManifestDigest)).toBe(true);
  await service.stop();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @strata-code/live-compare test service`
Expected: FAIL — the properties are `undefined`.

- [ ] **Step 3: Widen the parse and the returned shape**

```ts
const ready = JSON.parse(line) as {
  socketPath: string;
  serviceEpoch: string;
  recovered: boolean;
  validationMode: "tscOnly" | "behavioral";
  validationManifestDigest?: string | null;
};
return {
  child,
  socketPath: ready.socketPath,
  serviceEpoch: ready.serviceEpoch,
  recovered: ready.recovered,
  validationMode: ready.validationMode,
  // The readiness line omits the key entirely without a manifest, where the
  // client-facing `hello` instead carries an explicit null. Normalize here so
  // callers see one shape.
  validationManifestDigest: ready.validationManifestDigest ?? null,
  directory,
  auditPath,
  async stop(stopOptions?: { preserveDirectory?: boolean }) { /* unchanged */ }
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @strata-code/live-compare test service`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/live-compare/src/service.ts packages/live-compare/tests/service.test.ts
git commit -m "feat(d3): the harness keeps the readiness identity it was discarding"
```

### Task 8: The owed measurement — lock hold time

**Files:**
- Create: `crates/strata-kernel/tests/lock_hold_time.rs` (ignored by default)
- Modify: `decisions.md`

D-2 closed carrying an explicit debt: the fsync figure was measured (~0.036 ms
per fsynced append, ~0.07 ms per read across two `sync_data()` calls), which
showed ten pollers do **not** meaningfully serialize on disk — and concluded
that the honest before/after this work owes is **lock hold time, not disk**. The
protocol, journal, and audit mutexes are each taken globally per request and
merely happen to contain an fsync.

This task pays that debt. It is deliberately a measurement, not an optimization:
publish the number, then decide whether anything needs doing.

Do **not** skip this because the daemon "feels fine." An unmeasured global lock
is exactly the thing that looks fine at N=2 and falls over at N=10, and D-3 is
the slice that declares the daemon long-lived.

- [ ] **Step 1: Write the measurement harness**

```rust
// Instrument by wrapping each global mutex acquisition with an Instant and
// accumulating into an AtomicU64 nanosecond counter behind a cfg flag, then
// report per-lock totals and maxima after a fixed workload of N concurrent
// clients. Report, do not assert a threshold -- a threshold invented before
// the first number is a guess dressed as a gate.
```

- [ ] **Step 2: Run it at N=1 and N=10**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lock_hold_time -- --ignored --nocapture`

- [ ] **Step 3: Record the numbers in `decisions.md`**

Append to the D-2 entry's "Revisit when" a dated resolution with the actual
figures, and state plainly whether the global locks are or are not a problem at
ten clients. If they are, log a decision — do not fix it inside D-3.

- [ ] **Step 4: Commit**

```bash
git add crates/strata-kernel/tests/lock_hold_time.rs decisions.md
git commit -m "measure(d3): lock hold time under concurrency, the debt D-2 recorded"
```

### Task 9: Gates, chain, close

- [ ] Two daemons race for one state dir and exactly one serves — with the loser
      leaving no audit trace (Task 2).
- [ ] Stale socket recovered; live socket never stolen (Task 3).
- [ ] Drain semantics observable: `draining: true` on health, typed
      `service_draining` refusal, in-flight request answered, nothing cancelled
      (Task 5).
- [ ] Crash/restart: kill -9 mid-request, restart, assert the owner lock is free
      and recovery reconciles.
- [ ] Full chain detached (this environment kills harness background tasks; run
      via a detached Node `spawn` and a persistent Monitor watch) with
      `PATH=/opt/homebrew/bin:$PATH`. **Do not run `cargo` concurrently with the
      chain** — it rewrites the daemon binary the tests spawn and produces
      failures that are not real.
- [ ] `decisions.md` close; `docs/product-roadmap.md` D-3 marked closed.

---

## Risks carried into D-3

- **The three D-2 leaks are still open and are now more load-bearing**, because
  D-3 is what declares the daemon long-lived: unbounded `request_bindings`
  (insert-only, rebuilt by a full journal scan at startup), `change_set_locks`
  insert-only with no eviction, and in-memory-only delivered ceilings. A
  retention/checkpoint story is required before "long-lived" is honest. None of
  these are D-3 deliverables; all three need a decision logged.
- **`flock` is advisory and NFS-hostile.** Fine for a local state directory,
  which is the only supported deployment, but it is not a network-filesystem
  answer and must not be described as one.
- **The grace period is a guess until the drain gate runs.** 30s is chosen to
  exceed the observed worst-case advance; if a real advance exceeds it, prefer
  raising it over severing, and log the decision.

## Self-review (v1)

**Spec coverage:** owner lock + ordering → Tasks 1-2; startup sequence
(canonicalize → lock → claim/verify → stale unlink → open) → Tasks 1-3;
`start`/`stop`/`health` → Tasks 4-5 (`start` is the existing `serve`; the plan
does not rename it, which is a divergence a reviewer should rule on); health off
the journal → Task 4; drain semantics and the never-report-cancelled prohibition
→ Task 5; readiness identity retention → Task 7; the four spec gates → Task 9.

**Known gaps a reviewer should rule on:**
1. The spec says `start`/`stop`/`health`; this plan adds `health` and `stop` but
   leaves `serve` unrenamed. Renaming is a breaking change to every harness call
   site. I chose compatibility; that may be wrong.
2. `stop` as a *subcommand* needs a way to find the running daemon — the socket
   plus the health handshake, or the PID from the lock file (which the global
   constraints say is metadata, never authority). This plan leans on the socket;
   the reviewer should check that a `stop` which cannot find the socket degrades
   sensibly.
3. Tasks 3 and 4 are entangled and the plan says so rather than pretending
   otherwise. A reviewer may prefer them merged into one task.

**Placeholder scan:** the Task 8 measurement harness is described rather than
written out, because the instrumentation shape depends on which mutexes survive
Task 5's rewiring. That is a real placeholder and I am flagging it rather than
hiding it — a reviewer should decide whether Task 8 needs to be written concretely
before execution or is acceptable as a measurement brief.

**Type consistency:** `OwnerLock` / `LockRefusal` (Task 1) are used in Task 2;
`socket_answers_health` (Task 3) is supplied by Task 4's handshake variant, which
is the entanglement noted above; `DrainState::is_draining` (Task 5) is the only
drain API other tasks touch; `service_draining` is spelled identically in Rust
(Task 5) and TypeScript (Task 6).
