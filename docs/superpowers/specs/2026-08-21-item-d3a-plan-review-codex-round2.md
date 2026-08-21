# D-3a ownership+health plan — independent methodology review (round 2)

**Reviewer:** Codex CLI, `gpt-5.6-sol`, reasoning `xhigh`, read-only, repo-grounded
**Date:** 2026-08-21
**Target:** `docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md` @ v2
**Repo state:** `main` @ `5a9bde0`
**Prior round:** `2026-08-21-item-d3a-plan-review-codex.md` (v1, DO-NOT-PROCEED)

Archived verbatim. **First non-blocking verdict in this chain.** The reviewer
confirms the headline move — "Per-incarnation naming removes the stale/live
decision; it does not merely relocate it" — and corrects the plan's framing:
the reclamation invariant is a property of the cooperative same-UID deployment
contract, not intrinsic evidence carried by the socket.

The most valuable correction is one the author did not ask about: publishing the
record BEFORE binding makes every crash exactly recoverable and reduces
reclamation from an unboundable directory sweep to a single O(1) `unlinkat`.

---

# PROCEED-WITH-CORRECTIONS

The headline move is correct. Per-incarnation naming removes the stale/live decision; it does not merely relocate it. A previous socket pathname is never reused, provided nonce collisions cause regeneration rather than unlinking.

The sweep justification is sound only as a namespace invariant under the stated cooperative, same-UID threat model—not as intrinsic “positive evidence” carried by the socket. I would avoid that stronger wording.

Corrections, largest first:

1. Replace the wildcard sweep with exact-record reclamation.

The plan inconsistently says the flocked `.lock` stores the socket name, then atomically renames a separate `.record`, then says `health --token` reads the `.lock` record ([plan:46](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:46), [plan:612](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:612), [plan:753](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:753)). These must be separate files: atomically replacing the flocked lock would replace the protected inode.

Use:

- `<hash>.lock`: authority only; never renamed or rewritten.
- `<hash>.record`: versioned, fail-closed record containing the exact current basename.

Then order startup as:

1. Acquire both locks and read the previous record.
2. Reclaim only the exact recorded predecessor via `fstatat`/`unlinkat`, after validating token hash, basename and socket type.
3. Choose a new nonce and durably publish the new record.
4. Bind that recorded path, chmod it, then publish readiness.

That ordering makes every successfully bound D-3a socket exactly recoverable:

| Crash point | Result |
|---|---|
| Before record publication | No new socket exists |
| After record, before bind | Record names an absent endpoint |
| After bind, before readiness | Record names the exact orphan |
| After readiness | Record names the crashed daemon’s exact orphan |

The current bind-before-record order is ownership-safe, but every crash in that window creates an unrecorded orphan ([plan:621](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:621)). Repeated failures can therefore grow debris without limit. “Bound the sweep” at [plan:548](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:548) is not executable: bounding deletions does not bound a `read_dir` traversal through thousands of entries. Exact-record reclamation is O(1) and removes the sweep entirely.

Also specify a fixed nonce width—at most 11 hex characters under the existing 96-byte production limit—and retry with a fresh nonce on collision. Never unlink a colliding candidate merely because its name matches.

2. Tighten the socket-root trust rule. The sequence is not absolutely TOCTOU-free.

The held fd closes the important races for lock and record children, but `bind()` remains pathname-based. Therefore the plan is safe within the declared threat model, not “TOCTOU-free” in an absolute sense. That limitation is already acknowledged at [plan:320](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:320) and matches the governing boundary at [item-d-design.md:45](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-08-20-item-d-design.md:45).

Two corrections are required:

- “`openat` … for every lock and socket file” is false; `bind()` cannot use `openat` ([plan:318](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:318)). Say lock/record files, then reverify the root’s device/inode immediately before pathname bind and pathname chmod.
- Do not silently repair an existing group/world-accessible root. If `mkdir` returned `EEXIST`, require correct UID and no group/other access before `fchmod`. Otherwise another UID could have planted matching names before hardening, invalidating the sweep’s namespace premise.

Task ordering also needs repair: Task 1 requires `SocketRoot` in its public interface and tests ([plan:153](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:153), [plan:203](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:203)), but Task 2 does not implement it until [plan:360](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:360). Implement `SocketRoot` before `EndpointClaim`, or combine those tasks.

3. State the D-2 coexistence boundary.

The claim that only an endpoint-lock holder serves this token is true only for D-3a-and-newer binaries. The current D-2 binary takes no new lock and binds the old `<hash>.sock` path ([server.rs:185](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:185), [server.rs:197](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:197)). A live D-2 daemon and D-3a daemon using the same token but different databases could therefore serve simultaneously on different paths.

Either:

- Declare “stop all pre-D-3 daemons before upgrade” as an explicit deployment precondition; or
- Check the legacy `<hash>.sock` before opening canonical state: a valid protocol-v2 `open_session` reply is positive live evidence and must refuse startup; an ambiguous leftover fails closed and requires operator cleanup.

This is not v1 compatibility mode; D-2 already speaks protocol version 2.

4. The reserve contract is substantially right, but two claims/tests are wrong.

One second is reasonable for an in-memory health classification and tiny local response, provided one absolute `accepted_at + 1s` deadline governs both read and flush. A control candidate must replace the current five-second write timeout at [server.rs:481](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:481), not merely add another timer.

Corrections:

- “Physical maximum 66” is false. There can be 66 admitted connections plus one already-accepted over-cap connection held during the 250ms inline refusal at [server.rs:101](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:101) and [server.rs:436](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:436). Say “66 admitted/handler-owned connections, plus at most one transient inline-refusal connection.”
- The proposed `<6s` assertion does not distinguish the promised one-second reserve deadline from the existing five-second handshake deadline ([plan:699](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:699)). Use an upper bound comfortably above scheduler noise but below five seconds, and assert both silent reserve peers are closed before health succeeds.

The bounded-tenure wording is now correct.

5. The basename audit missed test surfaces, though no production consumer was missed.

I found no TypeScript or bridge code recomputing the production basename; the launcher consumes readiness directly at [service.ts:112](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:112). However, the claim that only the validator and subcommand assume the old form is literally wrong:

- [local_service_sealing.rs:37](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service_sealing.rs:37) hard-codes the old valid basename.
- [local_service.rs:959](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service.rs:959) builds an old-shape overlong validator input.

They may continue passing because of validation order, which makes them less discriminating. Update them to the incarnation form.

Finally, the injected socket root must flow through internal path validation and `health --token`; otherwise the temp-root lifecycle tests conflict with the production-only parent check and the token-health test at [plan:767](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:767). Use a deliberately short temporary root under `/tmp` so the new basename still fits the 96-byte limit.

The planned “clean shutdown” process test also assumes a graceful exit mechanism that D-3a intentionally does not add ([plan:584](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d3a-ownership-health-plan.md:584)). Test `BoundEndpoint::drop` in-process now; leave the process-level graceful-shutdown gate for D-3b.

Review basis: the current checkout is `5a9bde0`—the v2 plan commit—not `e7e1a3a`; the implementation beneath it remains D-2.
