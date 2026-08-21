# D-3 lifecycle plan — independent methodology review (v1)

**Reviewer:** Codex CLI, `gpt-5.6-sol`, reasoning `xhigh`, read-only, repo-grounded
**Date:** 2026-08-21
**Target:** `docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md` @ v1
**Repo state:** `main` @ `0e07f60`

Archived verbatim. The reviewer explicitly confirmed that none of the verified
facts supplied in the brief were wrong against `0e07f60`; every correction below
is about the plan's design, not its premises.

---

## Verdict: DO-NOT-PROCEED

The core choices—`flock`, handshake health, and self-pipe wakeup—are viable, but the plan cannot safely be executed as written. Endpoint ownership still races, graceful drain lacks the machinery required to wait for active handlers, `stop` has no implementation, and Task 6 contradicts the declared client contract.

None of your supplied verified facts is wrong against `0e07f60`.

## Corrections, largest first

1. Redesign endpoint ownership and startup ordering.

The state-directory lock does not serialize the socket namespace. Socket paths derive from the arbitrary `--socket-token` ([main.rs:92](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:92), [server.rs:185](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:185)), so daemons using different state directories can hold different owner locks while racing over the same socket.

That invalidates the plan’s claim that the state lock removes the probe/unlink/bind race ([plan:308](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:308)). A concrete failure is:

- A and B own different state directories but use the same token.
- Both probe an old socket as dead.
- A unlinks and binds.
- B then unlinks A’s newly bound socket.

Add a second, lifetime-held endpoint claim lock under `/tmp/strata-lc`, keyed by socket hash, or derive the endpoint from canonical state identity. The separate endpoint lock is the smaller compatible change. Acquire locks in one fixed order: state, then endpoint.

Replace Boolean `socket_answers_health` with a bounded classification:

- `Healthy`
- `OccupiedButInvalidOrUnresponsive`
- `DefinitelyStale`
- `Absent`

Only a definitively stale Unix socket may be removed. A connected foreign responder, timeout, malformed reply, `server_busy`, regular file, or symlink must fail closed—not be called dead.

Also move endpoint claim/probe/stale unlink before `ServiceSession::open`, as the spec requires ([spec:158](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-08-20-item-d-design.md:158)). Task 3 currently changes `bind_private_socket`, but that function remains called after open, recovery, seed-green, finalization, and hydration ([server.rs:52](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:52), [server.rs:82](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:82)). That is a direct spec violation and contradicts the plan’s file-structure claim at [plan:89](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:89).

Tasks 3 and 4 are not mutually entangled. The dependency is one-way: health can be implemented and tested against the existing listener; stale detection then consumes it. Reorder Task 4 before Task 3. Merging is optional, not necessary.

2. Fully specify the drain controller before implementation.

The non-cancellation policy is correct: refusing unstarted work, allowing running work a grace period, then terminating without recording cancellation honors the prohibition in [spec:166](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-08-20-item-d-design.md:166).

The implementation methodology does not yet support that policy:

- Threads are detached and their handles discarded ([server.rs:112](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:112)).
- `Admission` counts connections, not active requests, and has no wait/notification facility ([server.rs:235](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:235)).
- `drain_established_lanes` is undefined.
- The proposed “self-pipe” has only one `OwnedFd`, although a pipe needs read and write ends ([plan:574](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:574)).
- There is no signal installation, global signal-safe write-fd routing, repeated-signal behavior, active-request guard, condition variable, or grace-deadline exit path.
- “Stop accepting” conflicts with “new connections get `server_draining`” and with health remaining observable ([plan:501](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:501)).

Define an atomic request-start boundary between identity/lane validation and journal binding, using an RAII active-request guard. Transition to draining and admission of a new request must be serialized so a request cannot slip through the check/increment race.

During grace, continue accepting physical connections for control/health, but:

- Serve health with `draining: true`.
- Refuse `open_session`.
- Refuse request frames already arriving on established lanes before journal/effect work.
- Wait only for active request guards, not all idle connections.
- Exit immediately when active count reaches zero, or forcibly at the deadline.

The self-pipe plus `poll` is the right no-runtime mechanism. `write(2)` is async-signal-safe, but the handler should preserve `errno`, use a nonblocking/CLOEXEC write end, and tolerate `EAGAIN`. POSIX also limits handlers to lock-free atomics or `sig_atomic_t`-style state. [POSIX signal actions](https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html)

There is also a lock-release race at forced grace expiry: `_owner` is a local variable ([plan:272](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:272)). Returning from `server::serve` drops it before process termination while detached handlers may still be executing. At the forced deadline, terminate the process while the owner fd is still held, or retain/leak the guard until kernel process teardown. Do not release ownership and then let old handlers continue briefly.

Strengthen drain gates:

- Use a deterministic barrier proving a request crossed the start boundary before signaling.
- Assert an open draft remains exactly `draft`, not merely “not cancelled.”
- Test an over-grace mutation disconnect followed by exact replay and recovery.
- Test zero-active fast exit; the current health-after-signal test can race immediate shutdown.
- Test several active/idle lanes and bounded total exit time.
- Test that a draining refusal creates no effect or cancellation record.

3. Design and implement `stop`; it is currently absent.

The plan lists a `stop` subcommand but no task adds it, no wire frame triggers drain, and Task 5 does not modify `main.rs`. The current command dispatch has only the three supplied commands ([main.rs:38](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:38)).

Use an in-band first-frame control variant such as `stop`, acknowledged off the journal, which asks the daemon itself to enter drain. This avoids PID-reuse races and keeps PID metadata non-authoritative. Define:

- Exact arguments: preferably `stop --socket <path>` and `health --socket <path>`.
- Strict frame/reply schemas.
- Connect/read/write deadlines.
- Exit codes for absent, unhealthy, draining, and timeout.
- Behavior when the endpoint exists but cannot be contacted.
- Capacity reserved for health/stop so 64 established sessions cannot make shutdown unreachable.

If state-directory discovery is desired later, lock metadata may provide a socket/epoch hint, but the control exchange—not the PID—is authority.

For `start`, add it as an alias to `serve`; no breaking rename is necessary. Keep `serve` for compatibility and test both dispatch routes.

4. Keep `flock`, but fix its wiring and claims.

`flock(LOCK_EX|LOCK_NB)` is the correct primitive for the supported local, cooperative deployment. It avoids the stale-sentinel problem of `O_EXCL`.

The lifetime claim needs precision: `flock` belongs to an open file description and is released only after all duplicated descriptors are closed. Forked children inherit it; absent close-on-exec, it survives exec. [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html), [Apple `flock(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)

The good news is that Rust’s Unix `OpenOptions` currently adds `O_CLOEXEC`, so the Node children spawned at [persistent.rs:899](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/persistent.rs:899) and [process.rs:350](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:350) should not retain the lock after exec. [Rust standard-library source](https://doc.rust-lang.org/src/std/sys/fs/unix.rs.html#1360)

Still add process-level gates:

- Start with persistent and one-shot workers.
- Kill the daemon with SIGKILL.
- Confirm a replacement immediately or boundedly acquires ownership while old workers are checked for survival.
- Confirm a fork/exec child does not retain the owner fd.

The lock file belongs in the canonical state directory. That is the right authority boundary. Document that deleting/replacing the state directory or lock inode while serving violates the cooperative deployment contract.

The plan does not actually use its canonicalization helper: it defines `canonical_state_identity` at [plan:115](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:115), then passes the raw `db_path.parent()` to `OwnerLock::acquire` at [plan:268](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:268). Make bypass impossible with a `CanonicalStateDir` newtype or have `OwnerLock::acquire(db_path)` canonicalize internally. Test two real daemon processes using symlink/`..` spellings, not just equality of helper outputs.

Do not truncate or rewrite metadata before winning the lock. Write diagnostic PID/epoch through the held fd afterward, with owner-only permissions and no symlink following. Match `io::ErrorKind::WouldBlock`, not only one raw errno spelling.

Acquiring immediately before `ServiceSession::open` is early enough for canonical durable safety. Earlier work is read-only preflight—argument parsing and optional manifest reading at [main.rs:98](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:98). Phrase the guarantee as “no canonical-state mutation by a loser,” not literally “no observable work.”

5. Do not implement Task 6 as written.

The plan says `service_draining` is surfaced as a typed, non-replayed terminal outcome ([plan:95](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:95)), then Task 6 consumes it and retries internally ([plan:633](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:633)). Those are different contracts.

Same-identity redrive is idempotently sound if the daemon proves the request never crossed the effect-start boundary. It does not inherently violate D-2. But placing the code in `BACKOFF_CODES` is insufficient:

- That path simply retries the same `LaneConnection` ([client.ts:462](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:462)).
- The only public lane close marks it permanently closed ([client.ts:208](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:208)).
- The test hides this by having the fake server call `socket.end()`.
- A real restart gap produces `ENOENT`/`ECONNREFUSED`, which the proposed retry path does not continue through.
- Reads would silently cross a service epoch even though D-2 deliberately leaves later-generation rereads to the caller.

The cleaner contract, matching the plan header and spec, is:

- Reset/drop the lane deterministically.
- Surface `CoordinationClientError("service_draining", ..., true)`.
- Let the caller decide whether to issue a new request after restart.

If automatic same-identity redrive is retained instead, make it a separate state machine—not generic `BACKOFF_CODES`—and explicitly test restart downtime, reconnect, identical bytes, deadline exhaustion, and read behavior across epoch changes.

6. Make Task 8 concrete and take the baseline before D-3.

The current Task 8 is explicitly a placeholder ([plan:794](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:794)); under the repository’s planning standard, that is a plan failure.

Capture a baseline at `0e07f60` before Task 5. If the claim remains “before/after D-2,” the honest comparison is pre-D-2 `db15b385` versus post-D-2 `0e07f60`; a post-D-3 N=1/N=10 run alone does not pay that debt. Then rerun the unchanged harness after D-3 as a regression check.

Specify:

- The Cargo feature enabling binary instrumentation.
- Every instrumented mutex and source file.
- RAII timing beginning after acquisition and ending on guard drop.
- Separate acquisition wait and hold duration.
- Counts, total, mean, maximum, and preferably a bounded histogram/percentiles.
- Identical fixed N=1/N=10 workload and request mix.
- Instrumentation-overhead calibration.

Do not edit the existing D-2 decision entry as Task 8 directs at [plan:810](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:810); `decisions.md` is append-only ([decisions.md:3](/Users/toddhebebrand/Strata/decisions.md:3)). Add a new dated entry referencing and resolving the debt.

7. Close the remaining test/plan gaps.

- Task 1’s integration test calls binary-private `OwnerLock` without explaining how it is imported. Put unit tests in `lifecycle.rs`, explicitly path-include it, or test only through `CARGO_BIN_EXE`.
- Task 2 starts the second daemon after the first is ready; that is exclusion, not the spec’s simultaneous race gate.
- Task 3’s test never has a lock-holding contender attempt to remove a live endpoint ([plan:315](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:315)).
- The configurable grace-period flag promised at [plan:506](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:506) is not parsed or threaded anywhere.
- Readiness should be runtime-validated strictly, not widened through another unchecked TypeScript assertion at [service.ts:112](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:112).
- Preserve the three D-2 risks exactly as carried. The plan’s risk section does this correctly; Task 7 must not be described as implementing epoch-change reread/deduplication—it only stops discarding the epoch.

The next version should be reviewed again before execution; these corrections materially change the ownership and drain architecture, not merely test coverage.
