# D-3 lifecycle plan — independent methodology review (v2)

**Reviewer:** Codex CLI, `gpt-5.6-sol`, reasoning `xhigh`, read-only, repo-grounded
**Date:** 2026-08-21
**Target:** `docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md` @ v2
**Repo state:** `main` @ `139ea52`
**Prior round:** `2026-08-21-item-d3-plan-review-codex.md` (v1, DO-NOT-PROCEED)

Archived verbatim. The reviewer confirms v2 fixed the v1 architectural defects
(second ownership lock, startup ordering) and names two NEW blockers, plus
several concrete defects verified against the code.

The single most valuable finding answers the question this plan's author flagged
as least confident: `ECONNREFUSED` is NOT proof of staleness on Darwin, because
`sonewconn()` fails under listen-queue exhaustion and a live listener can
transiently present as refused. The v2 design would have unlinked a healthy
endpoint.

---

DO-NOT-PROCEED

v2 fixes several major v1 defects, especially the second ownership lock and startup ordering. But two architectural blockers remain: `ECONNREFUSED` is not proof of staleness on Darwin, and the proposed drain loop cannot keep control requests reachable during grace.

Corrections, ordered by impact:

1. Replace errno-based stale detection with positive ownership evidence.

Your `ECONNREFUSED == DefinitelyStale` claim is wrong. The plan would unlink on that basis at [lifecycle-plan.md:557](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:557) and [lifecycle-plan.md:629](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:629).

On Darwin, `connect()` can return `ECONNREFUSED` when `sonewconn()` cannot allocate/queue another connection; `sonewconn()` returns null when the listen queue is full and on resource-allocation failures. Therefore a live listener can transiently look “refused.” See Apple’s [`unp_connect`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c#L1337-L1339) and [`sonewconn_internal`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_socket2.c#L338-L347).

Classify `ECONNREFUSED` as `OccupiedButUnverified`. Safe automatic reclamation needs positive evidence, for example:

- After successfully binding, record the socket’s device/inode and a claim nonce in the endpoint lock file.
- On restart, acquire the unchanged endpoint lock, read the previous record without overwriting it, and unlink only if the existing path is a socket whose device/inode matches that record.
- A pre-D-3 socket or mismatched/missing record must fail closed and require explicit cleanup.
- Clean shutdown should unlink through an inode-checking socket guard while the endpoint claim remains held.

The endpoint lock does close the original probe/unlink/bind race between cooperating D-3 daemons. It does not prove that a legacy or non-cooperating process using the pathname is dead.

2. Secure and create the socket directory before acquiring the endpoint claim.

The plan acquires the endpoint lock before binding at [lifecycle-plan.md:404](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:404), but today `/tmp/strata-lc` is created and protected only inside `bind_private_socket` at [server.rs:197](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:197). On a fresh host, the proposed lock-file open therefore fails with `ENOENT`.

Factor out an `ensure_private_socket_directory()` that runs before `EndpointClaim::acquire` and verifies:

- The path is an actual directory, not a symlink.
- It is owned by the effective user.
- Its permissions are appropriately private.
- The lock file is opened with `O_NOFOLLOW | O_CLOEXEC`, then `fstat`-checked as a regular file.

The lock file is not world-visible once the existing `0700` directory is correctly established. The real problem is that its parent is a predictable name in world-writable `/tmp`, allowing pre-creation or symlink substitution before that setup.

Also extend the advisory-lock risk statement at [lifecycle-plan.md:1247](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:1247) to cover replacement of the endpoint directory or lock inode, not only the state lock.

3. Redesign the draining accept loop.

The prose says connections remain accepted during grace at [lifecycle-plan.md:808](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:808), but the implementation sketch immediately breaks out of the accept loop when draining at [lifecycle-plan.md:900](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:900). It then waits on the condvar outside the accept loop. Consequently, new health and stop connections are not accepted during grace.

The drain state machine must keep polling and accepting control candidates until either:

- `active_requests == 0` and any stop acknowledgement has been flushed, or
- the grace deadline expires.

The final `ActiveRequest` drop must wake the poll loop—through the self-pipe or another pollable wakeup—not only signal a condvar that the accept loop is not waiting on.

Additional required corrections:

- Count the stop response through successful write/flush. Otherwise an idle daemon may exit before returning `stop accepted`.
- Add an inode-checked clean-shutdown socket unlink. The test expecting “endpoint absent” at [lifecycle-plan.md:975](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:975) cannot pass reliably otherwise.
- The test at [lifecycle-plan.md:830](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:830) has no active request when it signals, so prompt idle exit can race its health probe. Hold a deterministic active request if the test needs to observe `draining: true`.
- `starts_with(audit_before)` at line 851 does not prove no record was appended; every append preserves the prefix. Assert exact journal/audit length or parse the records.
- `pipe2` is not portable to the Darwin target named by this repository. The plan lists it at [lifecycle-plan.md:27](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:27). Use `pipe()` plus checked `fcntl` setup before installing the handler, or a portable abstraction.

4. Extend `ActiveRequest` through response flush and release protocol state on drain refusal.

The chosen start seam is correct: after identity/lane validation and before `bind_request`. The latter is the first durable action, as documented at [session.rs:433](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:433).

However, two corrections are required:

- Parsing reserves a request ID in the bounded protocol context before that seam. The new early return at [lifecycle-plan.md:765](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:765) must call `forget_request`, just as identity refusal currently does at [session.rs:453](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:453).
- If the guard lives only inside `handle_frame`, it drops before response serialization and flush at [server.rs:598](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:598). The main thread could then see zero active requests and terminate while a successful response remains unwritten. Return a response wrapper carrying the guard, or otherwise keep it alive through write/flush.

5. Specify the reserved-control admission algorithm numerically.

Yes, Q5 is a must-close gap. Existing admission obtains a permit before reading the first frame and applies 64 total / 16 un-handshaken limits at [server.rs:210](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:210) and [server.rs:246](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:246).

Define:

- The exact number of normal established, normal un-handshaken, and control-candidate slots.
- Whether the physical maximum becomes greater than 64 or normal capacity is reduced.
- The shorter classification timeout, if any, for overflow/control candidates.
- What happens when an overflow candidate sends `open_session`.
- The bounded-retry guarantee when silent peers occupy the reserve.

A workable cooperative design is 64 established session slots plus two short-deadline control-candidate slots. Because the frame has not yet been read, a same-user hostile peer can still occupy those slots; the plan must describe this as bounded eventual reachability rather than an absolute guarantee.

6. Make the forced-exit test concrete before execution.

`std::process::exit(3)` is acceptable here. It preserves the lock descriptors until process termination and deliberately exercises redb’s crash-recovery contract. Rust confirms that `exit` does not run Rust destructors ([Rust documentation](https://doc.rust-lang.org/std/process/fn.exit.html)); redb documents automatic crash detection and recovery ([redb documentation](https://docs.rs/redb/latest/redb/struct.Database.html)).

`mem::forget` at [lifecycle-plan.md:919](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:919) is redundant because `process::exit` never unwinds. Calling `exit(3)` directly with guards still in scope is clearer. `libc::_exit(3)` is an optional stricter variant if avoiding C `atexit` hooks matters.

The placeholder at [lifecycle-plan.md:884](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:884) must be concrete before execution. It is the only gate combining forced termination, redb recovery, and exact replay. It should specify a deterministic post-boundary failpoint and assert:

- The process exits with code 3 by deadline.
- Restart successfully recovers the database.
- The identical request ID/idempotency key/frame is replayed.
- Exactly one canonical effect, operation-log result, and audit result exist.
- No detached worker from the old process can complete afterward.

7. Tighten the remaining client, CLI, and measurement gates.

- The TypeScript test at [lifecycle-plan.md:1059](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:1059) does not prove the lane was dropped. The fake already exposes connection and handshake counts at [client.test.ts:48](/Users/toddhebebrand/Strata/packages/coordination-client/tests/client.test.ts:48); assert that a subsequent call creates a new connection/generation while the original call was attempted exactly once.
- `start --help` at [lifecycle-plan.md:995](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:995) will still fail if `start` is only added to dispatch, because `serve` currently rejects an odd bare option at [main.rs:261](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:261). Add subcommand help handling or test a real start.
- Define a command-specific exit-code matrix, especially `health` while draining, repeated `stop`, absent endpoint, and `--wait-ms` timeout. Current `main` converts every error to exit 2 at [main.rs:19](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:19).
- The measurement section is improved but still not fully reproducible. At [lifecycle-plan.md:1183](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3-lifecycle-plan.md:1183), “same request mix, same iteration count, same corpus” does not name any of them. Specify those values, the warmup, histogram bounds, artifact format, and how one instrumentation patch is applied identically to both historical refs. Move baseline capture operationally before Task 6. Report no-op overhead separately rather than subtracting one percentile distribution from another.

Direct answers:

- Q1: The second lock closes the original race. An endpoint-lock failure releases the state lock by RAII before `ServiceSession::open`, so it does not corrupt canonical state. It can leave a created directory/lock file and misleading owner metadata; publish diagnostics only after both locks are held. Fixed ordering is sound, but nonblocking `LOCK_NB`—not the order—is what makes deadlock impossible today.
- Q2: No. `ECONNREFUSED` is not a sound stale proof on Darwin.
- Q3: Yes, forced `process::exit(3)` is correct; `mem::forget` is unnecessary.
- Q4: The start seam is correct, but protocol-context cleanup and guard lifetime through response flush are missing.
- Q5: Yes. Reservation size and transitions must be specified before execution.
- Q6: Yes. The placeholder covers the highest-risk recovery path and must become executable before implementation begins.
