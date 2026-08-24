# Item D-3b — Drain, Stop, and Lock-Hold Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository explicitly does not use subagent-driven development by default.

**Status:** v2, corrected after independent methodology review. Review record:
`docs/superpowers/specs/2026-08-24-item-d3b-plan-review-codex.md`. Governing design:
`docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-3. D-3a close:
`decisions.md` 2026-08-21. Prior rejected combined-plan reviews:
`docs/superpowers/specs/2026-08-21-item-d3-plan-review-codex.md` and
`docs/superpowers/specs/2026-08-21-item-d3-plan-review-codex-round2.md`.
Baseline: `main` at `9a15096`.

**Goal:** Add bounded graceful drain and in-band `stop`, make the frozen D-3a
health fields truthful, surface drain to typed clients without silent replay,
and pay D-2's recorded lock-hold-time measurement debt.

**Architecture:** One `DrainController` owns the request-start boundary, active
request count, pending stop acknowledgements, grace deadline, and a portable
wake pipe. A request becomes active after identity/lane validation and before
journal binding; its RAII guard lives through response serialization and
write/flush. `stop` and SIGTERM/SIGINT transition the same controller. The
accept loop remains live during grace for bounded health/stop control frames,
but refuses new sessions and unstarted requests. If grace expires, the process
exits while both ownership locks remain held.

**Tech Stack:** Rust 1.89, Unix domain sockets, `libc` (`pipe`, `fcntl`,
`poll`, `sigaction`), redb recovery, TypeScript/Zod, Vitest, pnpm.

## Global Constraints

- Preserve stable node IDs, graph authority, validation, operation-log history,
  and SQLite support; D-3b changes process lifecycle only.
- `stop` is a handshake control frame, never a PID signal from the CLI.
- A drain refusal occurs before `RequestJournal::bind_request`, forgets the
  transient protocol-context request ID, and appends no journal/audit record.
- An active request is counted until its response has been serialized and the
  socket write/flush attempt has completed.
- Drain waits for active request handlers, not durable change sets. Drafts and
  queued tickets retain their exact canonical states.
- Shutdown never reports cancellation unless a normal canonical cancellation
  transition occurred.
- During grace, physical connections remain accepted so control remains
  reachable; `open_session` is refused with typed retryable
  `service_draining`.
- Keep D-3a admission constants: 64 normal connections, 16 normal
  unhandshaken, and two additional one-second control-candidate slots. An
  overflow candidate sending `open_session` remains `server_busy` before drain
  and becomes `service_draining` during drain.
- Same-UID malicious starvation is outside the threat model. The two reserve
  slots give bounded occupant tenure, not an absolute eventual-service proof.
- Default drain grace is exactly 30,000 ms; `--drain-grace-ms` accepts a
  canonical integer in `1..=300000`.
- Forced grace expiry uses `std::process::exit(3)` directly while owner and
  endpoint guards remain in scope. Do not return from `serve_in_root` first.
- `service_draining` is terminal for one `CoordinationClient.request()` call:
  drop the lane, preserve `retryable: true`, and let the caller decide when to
  issue a new top-level request.
- Default builds contain no lock timing overhead. Measurement code is gated by
  the `lock-instrumentation` Cargo feature and activated only with
  `--lock-samples <path>`.
- `decisions.md` is append-only. Do not change pre-registered RSS thresholds.
- Run cargo commands serially; concurrent cargo invocations rewrite the daemon
  binary used by process tests.
- Before execution in a new worktree: `pnpm install && pnpm -r build`.
- After merge: repeat build, workspace tests, lifecycle tests, and the full
  key-free chain in the main checkout.

---

## File Structure

- Create `crates/strata-kernel/src/bin/strata_kernel_service/drain.rs` — drain
  state machine, active/stop RAII guards, portable wake pipe, and signal bridge.
- Modify `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs` —
  `stop` first frame and typed stop reply.
- Modify `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` —
  request-start seam and a response wrapper carrying
  the active guard through the server flush.
- Modify `crates/strata-kernel/src/bin/strata_kernel_service/server.rs` —
  dynamic health, stop handling, draining handshake
  refusal, poll-based accept loop, and graceful/forced exit.
- Modify `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` —
  `--drain-grace-ms`, `stop`, exit-code matrix.
- Modify `crates/strata-kernel/tests/lifecycle.rs` — deterministic lifecycle
  integration gates.
- Modify `packages/coordination-client/src/client.ts` and its test — terminal
  drain error plus lane reset.
- Modify `packages/live-compare/src/service.ts` and its test — strict readiness
  identity and graceful stop-first cleanup.
- Create `crates/strata-kernel/src/bin/strata_kernel_service/lock_metrics.rs` —
  feature-gated named mutex timing into a bounded mmap sample file.
- Create `packages/live-compare/src/lock-hold-workload.ts` and test — fixed
  N=1/N=10 read workload, explicit protocol-v1/v2 wire adapters, and artifact
  summarizer.
- Create `docs/spikes/d3b-lock-hold-time.json` and `.md` — historical and D-3b
  results with provenance.
- Modify `decisions.md`, `docs/product-roadmap.md`, and root scripts only when
  the gates close.

---

### Task 1: Pure drain state machine and portable wakeup

**Files:**
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/drain.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`

**Interfaces:**
- Produces: `DrainController::new(grace)`, `begin_request`, `begin_stop`, `health`,
  `start_from_signal`, `deadline`, `ready_to_exit`, `remaining_active`, and
  `wait_fd`; `ActiveRequest` and `StopAcknowledgement` RAII guards.
- `DrainHealth { draining: bool, active_requests: usize }` excludes pending
  stop acknowledgements from the public active-request count.

- [ ] **Step 1: Add in-module failing unit tests before production code**

The tests must catch these mutations: a request increment after drain starts;
an active guard decrement omitted on drop; a stop acknowledgement not counted
through flush; repeated stop extending the original grace deadline; and the
last guard failing to wake the poll fd.

```rust
#[test]
fn transition_and_request_start_are_one_atomic_decision() {
    let drain = Arc::new(DrainController::new(Duration::from_secs(30)).unwrap());
    let request = drain.begin_request().expect("running accepts work");
    let stop = drain.begin_stop().expect("first stop is accepted");
    assert!(drain.begin_request().is_none());
    assert_eq!(drain.health(), DrainHealth { draining: true, active_requests: 1 });
    assert!(!drain.ready_to_exit(), "request and stop reply are outstanding");
    drop(stop);
    assert!(!drain.ready_to_exit(), "request remains outstanding");
    drop(request);
    assert!(drain.ready_to_exit());
}

#[test]
fn repeated_stop_keeps_the_first_deadline_and_gets_a_flush_guard() {
    let drain = DrainController::new(Duration::from_millis(400)).unwrap();
    let first = drain.begin_stop().unwrap();
    let deadline = drain.deadline().unwrap();
    let repeated = drain.begin_stop().unwrap_err();
    assert_eq!(repeated.deadline(), deadline);
    assert!(repeated.acknowledgement().is_some());
    drop(first);
}
```

- [ ] **Step 2: Run RED**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service drain::tests`

Expected: compile failure because `drain` and its types do not exist.

- [ ] **Step 3: Implement the minimal controller**

Use one poison-recovering `Mutex<DrainInner>` for the transition and counts:

```rust
struct DrainInner {
    draining_since: Option<Instant>,
    deadline: Option<Instant>,
    active_requests: usize,
    pending_stop_acks: usize,
}

pub(super) struct DrainController {
    inner: Mutex<DrainInner>,
    wake: WakePipe,
    grace: Duration,
}
```

`WakePipe::new` uses `pipe()`, then checks `F_GETFL/F_SETFL(O_NONBLOCK)` and
`F_GETFD/F_SETFD(FD_CLOEXEC)` on both ends before either fd is exposed. Every
error closes both fds. `notify()` performs a one-byte `libc::write`, accepts
`EAGAIN`, and preserves the caller's errno. `drain_notifications()` reads until
`EAGAIN`. No Darwin `pipe2` call is permitted.

`begin_stop` atomically sets the first deadline and increments
`pending_stop_acks`; repeated calls keep the first deadline but return an
`AlreadyDraining` value that still owns a stop-ack guard. Drops decrement the
relevant count and notify the pipe when exit may now be possible.

- [ ] **Step 4: Run GREEN and format**

Run: `PATH=/opt/homebrew/bin:$PATH cargo fmt --all -- --check`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --bin strata-kernel-service drain::tests`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/{drain.rs,main.rs}
git commit -m "feat(d3b): add the drain state machine and wake pipe"
```

### Task 2: Request-start boundary held through response flush

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**Interfaces:**
- `ServiceSession::handle_frame` returns `HandledFrame` rather than a bare
  `LocalServiceResponse`.
- `HandledFrame::finish()` returns the response and an optional
  `ActiveRequest`; the server retains the wrapper until after write/flush.

- [ ] **Step 1: Write failing real-service tests**

Add tests proving: health reports one only after a request crosses the seam; a
drain refusal has code `service_draining`, `retryable: true`, and exact unchanged
journal/audit byte lengths; the same request ID is accepted after restart
because refusal called `forget_request`; and an in-flight request's active count
does not reach zero before its response flush attempt.

Use the existing session helpers plus a `coordination-test-api` response-write
barrier. The feature-gated CLI option names one barrier directory. Immediately
before a regular response write the daemon creates `entered`; it waits for the
test to create `release`, then writes and flushes before dropping the guard.
While `entered` exists and `release` does not, a separate health connection
must report `activeRequests == "1"`. After release and a received response it
must report zero. A peer that merely stops reading is not an acceptable oracle:
a small Unix-socket response can still fit in the kernel buffer.

```rust
assert_eq!(journal_len(&directory), journal_before);
assert_eq!(audit_len(&directory), audit_before);
assert_eq!(refused["error"]["code"], "service_draining");
assert_eq!(refused["error"]["retryable"], true);
```

- [ ] **Step 2: Run RED**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle drain_`

Expected: tests fail because health is constant and requests have no guard.

- [ ] **Step 3: Wire the seam**

Add `drain: Arc<DrainController>` to `ServiceSession`, initialized in `open`,
and a clone accessor for the server. In `handle_frame`, keep the existing order:

1. parse and reserve the request ID;
2. validate connection identity and lane;
3. call `begin_request`;
4. on refusal, lock protocol context, `forget_request`, and return an unguarded
   typed response;
5. bind the request journal and execute as today.

`HandledFrame` owns the guard. `handle_connection` serializes the response,
writes, flushes, then drops `HandledFrame` on every success/error path. A
serialization error also drops the guard before the handler returns.

- [ ] **Step 4: Run GREEN plus local-service regression**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle drain_`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/{session.rs,server.rs} \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3b): count requests from admission through response flush"
```

### Task 3: Stop wire contract, dynamic health, and CLI matrix

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**Interfaces:**
- Add `FirstFrame::Stop { protocol_version: u8 }`.
- Add strict `StopReply::{StopAccepted, AlreadyDraining}` with
  `protocolVersion`, `serviceEpoch`, `draining: true`, and
  `activeRequests: WireU64`.
- CLI: `stop (--socket PATH | --token TOKEN [--socket-root ROOT])
  [--wait-ms 0..=300000]`.

- [ ] **Step 1: Write failing protocol and CLI tests**

Cover exact key sets, unknown-field rejection, protocol-version rejection,
first acknowledge-only stop exit 0, repeated acknowledge-only stop exit 5,
absent exit 3, foreign/malformed exit 4, and health-draining exit 5. Use
`--wait-ms 0` throughout this task. Through a feature-gated control-response
write barrier, assert the daemon remains alive while the stop acknowledgement
is blocked immediately before write and exits only after release plus the
write/flush attempt. Wait timeout and waited-success semantics belong to Task 4,
after the accept loop can actually terminate.

- [ ] **Step 2: Run RED**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle stop_`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle health_reports_draining`

- [ ] **Step 3: Implement control handling**

Parse stop through `parse_first_frame`. In `handle_connection`, stop calls
`begin_stop` before constructing its reply. The returned acknowledgement guard
must remain alive through successful write/flush attempt. Health reads
`DrainController::health()` and preserves D-3a's already-frozen reply shape.

When draining, `OpenSession` is refused before ownership binding with
`service_draining`; a control-reserve `OpenSession` uses the same drain error
rather than `server_busy`. Before drain, D-3a behavior stays unchanged.

Implement command-specific exit by mapping a `StopOutcome` value, not by
returning errors to `main`'s blanket exit 2. `--wait-ms 0` means acknowledge
only. Parse positive wait values now, but Task 4 owns their terminal semantics.
Update `print_help` and its exact-output tests with `stop` and
`--drain-grace-ms`.

- [ ] **Step 4: Run GREEN and protocol regressions**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle stop_`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle health_reports_draining`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test local_service protocol_`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/{protocol.rs,server.rs,main.rs} \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3b): stop in band and make health report drain state"
```

### Task 4: Interruptible accept loop, signals, grace, and forced recovery

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/drain.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
  under `coordination-test-api` only
- Test: `crates/strata-kernel/tests/lifecycle.rs`

**Interfaces:**
- `ServiceConfig` gains the validated `drain_grace: Duration`; `ServiceSession::open`
  creates the one controller from it, and `serve_in_root` clones that controller.
- SIGTERM/SIGINT handler writes only to the preinstalled wake fd. The accept
  thread drains the fd and performs `start_from_signal()` in normal Rust code.
- Test-only `--test-block-after-pending-ms` sleeps after the durable Pending
  record and before effect execution; default builds reject the option.
- A process-global `SignalRegistration` serializes handler ownership and
  publishes the wake fd through an `AtomicI32`; default builds have no test
  barrier options.

- [ ] **Step 1: Write the failing lifecycle gates**

Add deterministic tests for:

1. SIGTERM, SIGINT, and in-band stop use the same drain path. Signal tests run
   in daemon subprocesses, not parallel handler-owning threads in one process.
2. During a held active request, health and repeated stop stay reachable at 64
   normal lanes plus both reserve candidates.
3. An idle daemon exits promptly and its `BoundEndpoint` removes exactly its
   own socket.
4. A draft remains exactly `draft`; a queued ticket remains exactly `queued`.
5. An in-grace mutation returns its normal response.
6. Over-grace: start explicitly with `--persistent-bridge`,
   `--drain-grace-ms 200`, and `--test-block-after-pending-ms 2000`; wait for
   `activeRequests == "1"`, send stop, assert process exit 3; restart; replay
   the byte-identical frame with the same request ID/idempotency key; assert one
   canonical operation, one effect result, and one terminal audit result.
   Before stop, discover the child whose command contains
   `worker.js --persistent` from the daemon PID and assert that exact PID no
   longer exists after parent exit.
7. Positive waits: endpoint disappearance by the caller's deadline exits 0
   whether this call first accepted drain or observed `already_draining`;
   deadline expiry exits 6. Thus waited completion takes precedence over the
   repeated-stop acknowledgement code 5. Assert both idle success and a held
   request timeout.
8. A second signal does not move the first deadline, and signal install/drop
   restores prior handlers without allowing a stale or reused fd write.

The forced test must compare literal operation IDs/counts from `read_operation`
and parsed audit event types; no prefix-only assertion is sufficient.

- [ ] **Step 2: Run RED**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test lifecycle drain_`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test lifecycle forced_`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test lifecycle signal_`

- [ ] **Step 3: Implement poll loop and forced-exit rule**

Set the listener nonblocking. Poll listener fd plus drain wake fd. Before drain,
accept normal/control candidates as D-3a does. During drain, keep accepting; the
handshake path admits health/stop and refuses `open_session`. After each wake,
drain pipe bytes and re-check state.

Exit normally only when `ready_to_exit()` is true. On grace expiry with active
requests or pending stop acknowledgements, log the exact counts and call
`std::process::exit(3)` while `OwnerLock`, `EndpointClaim`, `BoundEndpoint`, and
the session are still in `serve_in_root` scope. Do not `mem::forget`; `exit`
does not unwind.

`SignalRegistration` owns a process-global mutex guard for its entire lifetime
and saves the prior SIGTERM/SIGINT actions. During install and drop, block both
signals in the current thread with `pthread_sigmask`. Install publishes the
fully configured nonblocking wake fd through `AtomicI32` only as part of the
guarded transition. Drop restores both prior actions, clears the atomic, then
unblocks; only afterward may the wake pipe close. The async handler performs
only an atomic load and `libc::write`. Arrange local declaration/drop order so
registration is destroyed before `DrainController`. Repeated signals are
idempotent and never extend the deadline.

Implement positive `stop --wait-ms N` here. After either `stop_accepted` or
`already_draining`, poll strict health and endpoint identity until the service
disappears or the deadline expires. Disappearance by the deadline exits 0;
timeout exits 6. A zero wait retains Task 3's 0/5 acknowledgement result.

- [ ] **Step 4: Run GREEN, crash recovery, and ownership regression**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test lifecycle`

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test local_service_recovery`

- [ ] **Step 5: Commit**

```bash
git add crates/strata-kernel/src/bin/strata_kernel_service/{drain.rs,server.rs,main.rs,session.rs} \
        crates/strata-kernel/tests/lifecycle.rs
git commit -m "feat(d3b): drain on stop or signal with bounded crash-safe grace"
```

### Task 5: Typed client drops a draining lane without replay

**Files:**
- Modify: `packages/coordination-client/src/client.ts`
- Test: `packages/coordination-client/tests/client.test.ts`

**Interfaces:**
- Add `LaneConnection.reset(failure)` that tears down transport state without
  permanently closing the lane object.
- `service_draining` remains absent from `BACKOFF_CODES`.

- [ ] **Step 1: Write the failing test**

Use the existing fake's connection, handshake, and request counters. First
connection returns `service_draining`. Assert the call rejects once with code
and retryable flag, request count is exactly one, then a later caller-issued
request opens connection generation 2 and succeeds. Also enqueue a second call
on the same serialized lane before the first response arrives: it must not
inherit the first call's transport failure or be silently replayed; after the
first resets the lane, the queued-but-unsent call opens generation 2 and
succeeds exactly once.

Name the mutation caught: adding `service_draining` to `BACKOFF_CODES`, or
failing to reset the lane, must fail this test.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @strata-code/coordination-client test client.test`

- [ ] **Step 3: Implement the explicit branch**

After parsing a non-ok response and before generic error handling:

```ts
if (response.error.code === "service_draining") {
  lane.reset(new TransportFailure("disconnect", "daemon is draining"));
  throw new CoordinationClientError(
    response.error.code,
    redact(response.error.message, [this.#socketPath, this.#clientId]),
    response.error.retryable
  );
}
```

Do not auto-reconnect in the same top-level request.

- [ ] **Step 4: Run GREEN and full client tests**

Run: `pnpm --filter @strata-code/coordination-client test`

- [ ] **Step 5: Commit**

```bash
git add packages/coordination-client/src/client.ts packages/coordination-client/tests/client.test.ts
git commit -m "feat(d3b): surface drain and reset the typed client lane"
```

### Task 6: Harness retains readiness identity and stops gracefully first

**Files:**
- Modify: `packages/live-compare/src/service.ts`
- Test: `packages/live-compare/tests/service.test.ts`

**Interfaces:**
- `RunningKernelService` adds `serviceEpoch`, `recovered`, `validationMode`,
  and nullable `validationManifestDigest`.
- `stop()` invokes the daemon's in-band stop with a bounded wait; SIGTERM is a
  fallback only when stop cannot be acknowledged.

- [ ] **Step 1: Write failing tests**

Assert strict readiness parsing retains all identity fields, rejects a missing
required key and unknown key, normalizes absent manifest digest to `null`, and
uses in-band stop on the normal cleanup path. A fallback test kills the socket
before cleanup and proves SIGTERM still reaps the child.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @strata-code/live-compare test service.test`

- [ ] **Step 3: Implement with Zod**

Add `zod` only if not already a direct dependency. Parse the readiness JSON
with a strict schema: protocolVersion literal 2; nonempty socketPath; canonical
u64 serviceEpoch; boolean recovered; validationMode enum; optional 64-lowercase
hex digest. Do not widen an `as` cast.

Spawn the exact resolved `binary` used to launch the owned daemon with
`stop --socket <ready.socketPath> --wait-ms 30000`; never resolve a second
`strata-kernel-service` through `PATH`.
on exit 0 or 5, wait for the owned
child. On CLI launch failure/exit 3/4/6, send SIGTERM and wait. Preserve the
existing `preserveDirectory` behavior.

- [ ] **Step 4: Run GREEN and all live-compare tests except operator gates**

Run: `pnpm --filter @strata-code/live-compare test service.test`

Run: `pnpm --filter @strata-code/live-compare test`

- [ ] **Step 5: Commit**

```bash
git add packages/live-compare/{package.json,src/service.ts,tests/service.test.ts} pnpm-lock.yaml
git commit -m "feat(d3b): retain readiness identity and stop services in band"
```

### Task 7: Pay the D-2 lock-hold-time debt with one bounded sampler

**Files:**
- Modify: `crates/strata-kernel/Cargo.toml`
- Create: `crates/strata-kernel/src/bin/strata_kernel_service/lock_metrics.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs`
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs`
- Create: `packages/live-compare/src/lock-hold-workload.ts`
- Create: `packages/live-compare/tests/lockHoldWorkload.test.ts`
- Create after runs: `docs/spikes/d3b-lock-hold-time.{json,md}`

**Interfaces:**
- Feature `lock-instrumentation` gates `TimedMutex<T>`.
- Only the three locks named in the D-2 debt are measured across historical
  refs: `session.protocol`, `session.journal`, and `session.audit`.
- `--lock-samples PATH` is accepted only with the feature and creates a fixed
  mmap file containing a header plus at most 65,536 fixed-size samples
  `(lock_id, wait_ns, hold_ns)`; overflow increments a dropped counter.

- [ ] **Step 1: Write failing sampler and workload tests**

Sampler tests assert wait and hold are separate, guard drop records once,
capacity is bounded, overflow is counted, and the default feature-off binary
rejects `--lock-samples`. Workload test uses a stub artifact with literal
samples and verifies count/total/mean/max/p50/p95/p99 calculations.

- [ ] **Step 2: Run RED**

Run: `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features lock-instrumentation --bin strata-kernel-service lock_metrics`

Run: `pnpm --filter @strata-code/live-compare test lockHoldWorkload.test`

- [ ] **Step 3: Implement the shared instrumentation**

Under the feature, alias the three selected mutex fields to `TimedMutex`; with
the feature off, alias them to `std::sync::Mutex`. `TimedGuard` records wait from
before acquisition to guard creation and hold from guard creation to drop. The
mmap slot index uses an atomic fetch-add; each thread owns its selected slot, so
recording adds no measurement mutex or per-sample syscall. The OS persists the
mapped file on process exit, including forced exit.

Report no-op wrapper overhead separately from lock samples; do not subtract one
percentile distribution from another.

- [ ] **Step 4: Define and test the fixed semantic workload and adapters**

The runner is external to historical package code and selects a ref-native raw
wire adapter: protocol v1 opens one socket per request with no session
handshake; protocol v2 performs `open_session` and uses its persistent lane.
Both adapters execute the same semantic action list and validate strict reply
shapes. Unit-test each adapter against a stub server before any measurement.

For each arm, use `examples/medium`, tsc-only validation, persistent bridge off,
and observation work only. Warm up 10 cycles per actor, then record 50 cycles.
Each cycle issues, in this order: `hello`, `list_modules(limit=64)`,
`find_declarations("User", kind="interface")`, and
`read_events(afterEventId="0", limit=64)`. Run N=1 and N=10 actors; N=10 starts
all actors behind one barrier. The same actor IDs, request mix, iteration count,
Node/Rust versions, CPU/OS, source SHA, dirty state, and sampler-patch SHA go in
the JSON artifact.

- [ ] **Step 5: Capture historical and D-3b runs**

Create detached worktrees for `db15b38` (protocol v1, pre-D-2) and `0e07f60`
(protocol v2, post-D-2). Before collecting data, dry-run both historical
binaries with the appropriate adapter. Then apply the same instrumentation
commit to both with `git cherry-pick -n`; if it does not apply byte-for-byte,
stop and revise the sampler rather than hand-port different probes. Use one
unchanged external workload runner and one unchanged sampler definition for all
arms. Run three repetitions of N=1 and N=10 per ref, then the same three at
D-3b head.

Do not claim a universal performance result. Resolve only the recorded question:
whether p95/p99 hold or wait time for these three global locks becomes a
material ten-client bottleneck in this fixed workload. If any 65,536-sample file
overflows, the run is invalid and must not be summarized.

- [ ] **Step 6: Write artifacts and a new decision entry**

The Markdown reports raw per-run tables and the conservative maximum p95/p99;
the JSON retains every histogram, count, total, mean, max, dropped count, and
provenance field. Append a dated decision resolving the debt. If locks are a
problem, log a follow-up; do not optimize them in D-3b.

- [ ] **Step 7: Commit**

```bash
git add crates/strata-kernel/Cargo.toml \
        crates/strata-kernel/src/bin/strata_kernel_service/{lock_metrics.rs,main.rs,session.rs} \
        packages/live-compare/src/lock-hold-workload.ts \
        packages/live-compare/tests/lockHoldWorkload.test.ts \
        docs/spikes/d3b-lock-hold-time.json docs/spikes/d3b-lock-hold-time.md decisions.md
git commit -m "measure(d3b): resolve the D-2 global-lock debt"
```

### Task 8: Full gates and close D-3b

**Files:**
- Modify: `decisions.md`
- Modify: `docs/product-roadmap.md`
- Modify: root `package.json` only if a dedicated lifecycle script is needed

- [ ] **Step 1: Run focused verification serially**

```bash
PATH=/opt/homebrew/bin:$PATH cargo fmt --all -- --check
PATH=/opt/homebrew/bin:$PATH cargo clippy -p strata-kernel --all-targets -- -D warnings
PATH=/opt/homebrew/bin:$PATH cargo clippy -p strata-kernel --all-targets --features coordination-test-api -- -D warnings
PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --test lifecycle
PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features coordination-test-api --test lifecycle
pnpm --filter @strata-code/coordination-client test
pnpm --filter @strata-code/live-compare test
```

- [ ] **Step 2: Run workspace and canonical key-free gates**

```bash
pnpm -r build
pnpm -r test
pnpm kernel:full-key-free:test
```

The documented RSS test is run only when the five-minute load average is below
8.0. If the load condition is not met, record the environment and do not change
the pre-registered predicate.

- [ ] **Step 3: Mutation-check the lifecycle tests**

Before closing, verify tests would fail for: decrement before flush; omission of
`forget_request`; repeated stop extending grace; accept loop breaking at drain
start; normal return on forced timeout; lane reuse after `service_draining`; and
draft-to-cancelled misreporting.

- [ ] **Step 4: Append close documentation**

Add a newest-first D-3b decision with exact gates, forced-recovery result,
measurement result, and carried risks: unbounded `request_bindings`, insert-only
`change_set_locks`, and in-memory delivered ceilings. Mark only D-3b complete in
the roadmap; D is complete only if all D-1/D-2/D-3a/D-3b bullets are closed.

- [ ] **Step 5: Commit**

```bash
git add decisions.md docs/product-roadmap.md package.json
git commit -m "docs(d3b): close drain and stop with measured lifecycle gates"
```

## Self-review (v2)

- **Spec coverage:** drain state and request boundary (Tasks 1-2); stop, dynamic
  health, control reservation, and CLI (Task 3); signals, accepting control
  during grace, clean/forced exit, and crash recovery (Task 4); typed client
  behavior (Task 5); readiness identity (Task 6); owed measurement (Task 7);
  deterministic/full gates and documentation (Task 8).
- **Prior-review corrections:** no `ECONNREFUSED` staleness logic; D-3a's
  per-incarnation endpoint remains unchanged. Control remains accepted during
  grace. Last active drop wakes poll. Stop reply is counted through flush.
  Drain refusal forgets protocol context. Active guard survives response flush.
  Reserve numbers and overflow behavior are exact. Forced recovery has a
  concrete post-Pending barrier and exact replay assertions. CLI exit codes and
  measurement workload/provenance are explicit.
- **Scope:** no retention, lock-map eviction, epoch reread/dedup, packaging,
  task orchestration, or item-E scenario work.
- **Placeholder scan:** no TODO/TBD or elided test bodies. Test helpers referenced
  above are existing lifecycle/session helpers or are explicitly introduced in
  their owning task.
- **Type consistency:** one controller instance is created by `ServiceSession`
  and cloned by the server; `HandledFrame` is the sole carrier of
  `ActiveRequest`; `StopAcknowledgement` is the sole stop-flush carrier;
  `service_draining` spelling and retryability match Rust and TypeScript.
- **Independent-review corrections:** waited exit moved behind the interruptible
  accept loop; response and stop-ack lifetime tests use deterministic
  pre-write barriers; signal ownership is process-global and fd-safe; the
  forced worker test explicitly enables the bridge; waited repeated-stop
  precedence is fixed; harness cleanup uses its exact binary; queued lane reset
  is covered; historical measurement uses tested v1/v2 wire adapters.

## Review Gate

Completed before v2: one read-only, repo-grounded Codex CLI review at
`gpt-5.5`, reasoning `xhigh`, covered lifecycle races, signal safety, stop-ack
flush ordering, forced-exit recovery, typed-client queueing, and historical
measurement compatibility. Its review record is archived at
`docs/superpowers/specs/2026-08-24-item-d3b-plan-review-codex.md`. Pivotal source
claims were checked against the blocking `listener.incoming()` loop, bridge
defaults, live-compare binary resolution, and historical protocol versions.
