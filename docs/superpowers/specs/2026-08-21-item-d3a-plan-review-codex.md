# D-3a ownership+health plan — independent methodology review (v1)

**Reviewer:** Codex CLI, `gpt-5.6-sol`, reasoning `xhigh`, read-only, repo-grounded
**Date:** 2026-08-21
**Target:** `docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md` @ v1
**Repo state:** `main` @ `e7e1a3a`
**Prior rounds:** `2026-08-21-item-d3-plan-review-codex.md` and `...-round2.md`
(both on the COMBINED D-3 plan, both DO-NOT-PROCEED)

Archived verbatim. The reviewer confirms the D-3 split is sound and narrows the
problem to two ownership blockers.

The decisive finding answers Q1, which the plan's author flagged as the place
the design was most likely to break: the `(device, inode) + nonce` record adds
NO evidence, because the nonce is stored in the lock file but never tied to or
recovered from the socket itself, and device/inode identifies the current file
rather than an incarnation across deletion and inode reuse. Darwin's `st_gen`,
which exists precisely to distinguish incarnations, is not available to ordinary
users.

---

# DO-NOT-PROCEED

The split is sound, but D-3a v1 still has two ownership blockers: the endpoint record does not prove socket incarnation, and the socket-directory hardening remains TOCTOU-prone.

Corrections, largest first:

1. Redesign the endpoint record and bind/recovery protocol. Q1/Q2.

The claim that `(device, inode) + nonce` proves “our own corpse” is wrong as written. Classification only compares device/inode; the nonce is stored but never tied to or recovered from the socket itself ([plan:555](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:555), [plan:569](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:569)). It therefore adds no evidence.

Device/inode identifies the current file, not an incarnation across deletion and reuse. Apple exposes a generation number specifically to distinguish different files that reused one inode, although Darwin’s traditional `st_gen` is unavailable to ordinary users ([Apple generation-number documentation](https://developer.apple.com/documentation/system/stat/generationnumber), [Darwin `stat64(2)` caveat](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/stat64.2.html)).

Revise the record to include:

- Schema version and endpoint/token hash.
- Canonical state-directory identity. This binds automatic reclamation to the same durable service, but does not solve inode reuse.
- Device/inode plus a socket-incarnation value verifiable from the current socket: for example a nonce attached to the socket inode via xattr, or a validated platform birth-time mechanism. A bind timestamp stored only in the record is not enough.
- A checksum or otherwise fail-closed encoding.

Use a stable `.lock` file only for `flock`, with a separate atomically replaced `.record` sidecar. Replacing the lock file would create a new inode that is not protected by the held flock.

Specify this ordering:

1. Acquire both locks and read the prior record without changing it.
2. Probe health; immediately before unlink, re-read the record and re-stat the path.
3. Unlink only on a full state/socket/incarnation match.
4. Durably remove or tombstone the old record.
5. Bind and chmod the new socket.
6. Obtain its identity and attach the nonce/incarnation marker.
7. Write a temporary record, `sync_data`, rename it over `.record`, then sync the directory.
8. Publish readiness only afterward.

No ordering makes `bind()` and record publication atomic. A crash after bind but before a durable record must leave an unrecorded socket that fails closed and requires operator cleanup. Add failpoints for that window, corrupt/torn records, and a replacement socket with deliberately matching dev/inode data but the wrong incarnation marker. The existing SIGKILL test covers only the post-readiness case ([plan:600](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:600)).

Also make the promised `SocketGuard`/`BoundEndpoint` concrete now; it is listed in the file structure but never implemented by a task ([plan:111](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:111)).

2. Replace path-based directory checks with a held directory fd. Q4.

`create_dir_all → symlink_metadata → set_permissions(path) → symlink_metadata` is not TOCTOU-free ([plan:300](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:300), [plan:311](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:311)). A substitution between the check and pathname-based chmod can redirect the chmod.

Use:

- `mkdir(..., 0700)` for atomic initial permissions, accepting `EEXIST`.
- `open(..., O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`.
- `fstat` for directory type/uid/mode, followed by `fchmod` on that fd.
- `openat` relative to the held fd for lock and record files.
- `fstatat`/`unlinkat` for revalidation and cleanup where possible.

POSIX explicitly identifies `openat` as the mechanism for avoiding pathname substitution races ([POSIX `open`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)). Because Unix socket bind remains pathname-based, reverify that the directory path still names the held directory before bind/unlink; same-uid replacement remains outside the stated threat model.

The planned tests are themselves unsafe: `remove_socket_directory()` and symlink replacement operate on the shared `/tmp/strata-lc` and can destroy sockets belonging to a live daemon or parallel test ([plan:323](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:323), [plan:340](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:340)). Parameterize the helper over a socket root and inject a temporary root for tests. Do not mutate the production global directory.

3. Keep the two reserve slots above 64, but fully specify the algorithm and correct its tests. Q3.

Physical maximum 66 is the right trade. It adds at most two accepted socket fds, two handler threads, and bounded first-frame buffers. The existing 64 was selected as takeover headroom, not demonstrated as a resource cliff ([server.rs:210](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:210)). Carving out two would unnecessarily reduce established capacity to 62.

Required corrections:

- `Admission::admit` must return `Normal` or `ControlCandidate`.
- The one-second limit must cover classification and response flush, not only reading the first frame. Current handlers have a five-second write timeout ([server.rs:488](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:488)).
- “Bounded eventual reachability” is too strong under a peer that continuously reacquires freed slots. What is bounded is each reserve occupant’s tenure; eventual reachability assumes no continuous refill/starvation.
- The silent-candidate test consumes only one of two reserve slots, so health can succeed immediately through the other slot even if the first is never reclaimed ([plan:722](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:722)). Occupy both before testing reclamation.
- Adding the reserve necessarily changes D-2’s test where the seventeenth silent connector is immediately refused ([local_service.rs:2673](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service.rs:2673)). It will now enter the reserve and time out after one second. Update that contract explicitly; the claim that D-2 behavior remains unchanged is false.

4. The split avoids the substantive wire-freeze objection, but the plan’s literal claim is wrong. Q5.

D-3b necessarily adds `stop` and its acknowledgement as new first-frame shapes. Therefore “no frame changes shape between slices” is false ([plan:40](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:40)). The accurate contract is: no D-3a frame is reshaped or reinterpreted; D-3b may add variants.

Freeze the semantics now as well as the fields:

- `draining` identifies the request-admission state.
- `activeRequests` is a canonical decimal count from the request-start boundary through response flush.
- D-3a emits `false`/`"0"`; D-3b only supplies live values.
- `stop`/`stop_accepted` are additive variants.
- `service_draining` uses the existing error envelope.
- `open_session` rejection during drain uses the existing `session_rejected` shape.

The health test should assert the exact key set and `validationManifestDigest`; its claimed “full identity” test currently omits that field ([plan:464](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:464), [plan:491](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:491)).

5. Remove the remaining placeholders and make timeouts executable.

`service_epoch_placeholder()` is an actual placeholder, contradicting the plan’s “none” assertion ([plan:436](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:436), [plan:876](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:876)). The epoch does not exist until `ServiceSession::open` returns. Publish PID metadata after both locks, then update it with the real epoch after open—or publish all diagnostics after open.

Likewise, “bounded connect deadline” is prose, not an implementation method ([plan:814](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:814)). Setting read/write timeouts after `UnixStream::connect` does not bound `connect`. Specify nonblocking connect plus `poll`, and add an exit-code-6 test against a listener that stalls.

6. Task 1’s open flags are correct on Darwin, with narrower guarantees than stated. Q6.

`.create(true)` plus `O_NOFOLLOW | O_CLOEXEC` is valid. Darwin rejects `open` when the target itself is a symlink, and Rust passes `custom_flags` through while already adding `O_CLOEXEC` internally ([Apple `open(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html), [Rust `OpenOptionsExt`](https://doc.rust-lang.org/std/os/unix/fs/trait.OpenOptionsExt.html)).

`O_NOFOLLOW` protects only the final component; it does not secure the parent path. That is why the held directory fd and `openat` correction is required. Also fstat-check uid, owner-only mode, and preferably link count in addition to regular-file type. The `.mode(0o600)` call applies only when creating a new file, not to an existing lock file.
