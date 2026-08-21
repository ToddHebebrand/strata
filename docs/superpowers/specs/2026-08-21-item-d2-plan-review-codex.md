# Item D-2 plan v1 — methodology review (Codex gpt-5.6-sol, xhigh, read-only)

**Provenance.** Run 2026-08-21 against `main` at 7aa0601, read-only, ~274k
tokens. Plan reviewed: `docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md` (v1).

**Verdict: PROCEED-WITH-CORRECTIONS.** All corrections folded into plan v2.

**Verification (house rule: pivotal claims checked before acceptance).** The
most consequential finding OVERTURNS a claim plan v1 had verified by
enumeration, so it was checked carefully and CONFIRMED:

- **One client is shared across all MCP tool handlers.**
  `createCoordinationToolServer(client)` (`agent.ts:186`) passes a single client
  into `createCoordinationTools` (`tools.ts:190`), and 15 handler closures use
  it. v1 had enumerated only the explicit `Promise.all` sites and concluded no
  caller issues concurrent requests on one client; that was true of harness code
  and false of the live agent path. The client must serialize internally.
  *Not verifiable:* the installed SDK is minified, so its dispatch ordering
  could not be confirmed from source — which is itself the argument for
  defensive FIFO queueing rather than trusting it.
- **Unbounded thread admission is a live issue, not latent.** Confirmed:
  `server.rs:94-101` spawns a detached thread per accept with no cap, and
  `MAX_DEADLINE_MS = 300_000` (`protocol.rs:16`) bounds request execution, not
  the socket timeout — so a valid-request storm can hold threads for five
  minutes each.
- **No client cleanup exists.** Confirmed: `agent.ts` contains no `close()` and
  no `finally`.

Also accepted: the reviewer's correction that v1's client line anchors were
stale after the D-1 extraction (`requestOnce` is 90–163, not 100–173).

---


The plan is well grounded, and its server/client analysis is substantially correct. It does not need re-grounding, but the takeover contract, split boundary, lane ownership, and client serialization must be corrected before implementation.

## Direct answers

1. **Do not split D-2 at transport versus identity. Keep one mergeable D-2 contract.**

A transport-only D-2a creates an intermediate “protocol v2” whose first frame and authority model change again in D-2b. That either freezes two incompatible meanings of v2 or temporarily exposes the identity-bypass route that the governing spec explicitly prohibits ([plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:19), [spec](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-08-20-item-d-design.md:104)).

Use internal commits/tasks, but merge only once the final session contract is complete:

- The first frame is the final `open_session` handshake.
- It carries `protocolVersion`, actor, role, client instance, and connection generation.
- The handshake is the sole negotiation point.
- Request frames may retain `protocolVersion: 2` as a consistency check, but it is not a second negotiation mechanism.
- A non-handshake/v1 first frame receives a narrow fail-fast rejection and closure. That rejection path never executes a request and is not a v1 compatibility mode.

Test both directions: v1 client → v2 server, and v2 client → v1 server. Both must fail promptly without waiting for EOF indefinitely.

2. **Reject the executing-request heuristic. Use identity, generation, and positive socket-liveness evidence.**

“Not currently executing” is not a reconnect discriminator. It permits a fresh, duplicate process to steal an idle but healthy lane; two duplicate clients can then repeatedly displace each other. It also has a check/start race unless request admission and takeover share one lock ([plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:175)).

The handshake draft is missing the `connectionGeneration` required by the governing spec ([plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:151), [spec](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-08-20-item-d-design.md:114)). Use this rule:

- `clientInstance` is stable across both lanes for one `CoordinationClient` lifetime.
- `connectionGeneration` is monotonic per role lane.
- Same actor, role, and client instance with a strictly higher generation: accept and fence the old connection, whether idle or executing.
- Same/lower generation: reject as stale.
- Different client instance while any lane belonging to the old actor instance is live: reject `lane_conflict`.
- Different client instance may take over only after positive transport evidence that every old-instance lane is dead—EOF/HUP from a non-consuming socket probe—not merely because it looks idle.
- Atomically replace the registry binding, then shut down the old socket outside the registry lock.
- Handler cleanup must compare a unique binding token before removal, so an old handler cannot unregister its replacement.

An admitted old mutation may continue after fencing, but exact replay remains safe: completed requests return the cached response, while pending/effect-result requests are serialized or return `request_in_progress` ([session.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:544)).

There is an unavoidable information boundary: if a new process has a fresh instance ID and the old socket has no observable HUP, it is indistinguishable from a live duplicate. In that state, rejection—not the busy/idle heuristic—is the honest contract.

Also make ownership actor-level, not just `(actor, role)`-level. Otherwise duplicate clients can race so A owns `work` while B owns `observation`. The registry should enforce one `clientInstance` owner for an actor, with two role slots beneath it.

3. **Keep `ack_events` on the observation lane.**

Lane assignment and mutating/read-only classification answer different questions:

- Work: `begin_change_set`, `add_intent`, `submit_change_set`, `advance_change_set`, `cancel_change_set`.
- Observation: discovery/inspection actions, `read_events`, `ack_events`, `read_operation`, and validation-fixture reads.

`ack_events` remains mutating for idempotency but observational for scheduling. Putting read and ack on the same serial lane preserves their natural ordering and does not defeat work/observation isolation. Current code already classifies `ack_events` as mutating ([protocol.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:642), [protocol.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/protocol.ts:233)).

Create a separate exhaustive `laneForAction` authority and dual-language fixture. Do not derive lanes from `isMutatingAction`. Reject a wrong-lane action before any journal binding or fsync.

4. **The explicit concurrency enumeration is correct, but the absolute claim is not.**

The two explicit sites use distinct clients:

- Gate 1 uses `a` and `b` in `Promise.allSettled` ([gate1Intrusion.test.ts](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Intrusion.test.ts:397), [gate1Intrusion.test.ts](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Intrusion.test.ts:412)).
- `liveAdapter` launches one `runCoordinationAgent` per assignment ([liveAdapter.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/liveAdapter.ts:155)), and each agent constructs its own client ([agent.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/agent.ts:182)).

However, one agent gives a single client to all MCP handlers ([tools.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/tools.ts:190), [tools.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/tools.ts:341)). The installed SDK permits multiple tool calls in one assistant message ([sdk.d.ts](/Users/toddhebebrand/Strata/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:181)) and dispatches control requests without awaiting the previous handler ([sdk.mjs](/Users/toddhebebrand/Strata/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:59)).

Therefore:

- No explicit harness code concurrently invokes one client.
- The live agent path can nevertheless produce concurrent calls.
- The client must queue same-lane calls FIFO while allowing one work and one observation request concurrently.
- Queue waiting counts against the request’s original wall-clock deadline; an expired queued request must fail unsent.
- Add a direct concurrent-call test proving request 2 is not written until response 1 arrives.

This needs no caller migration if serialization is internal, but it does invalidate the plan’s “no current caller” justification.

5. **Yes: unbounded thread admission is a live resource-exhaustion issue today.**

Every accepted connection spawns a detached OS thread with no cap ([server.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:94)). An idle or partial peer holds it for five seconds ([server.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:195)); a valid request can occupy the handler for the protocol’s 300-second maximum because the socket timeout does not bound synchronous request execution ([protocol.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:13), [session.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:440)). A connection or valid-request storm can therefore exhaust threads now.

Recommended policy:

- 64 total admitted connections.
- At most 16 unhandshaken connections.
- Five-second absolute handshake deadline.
- Five-second absolute partial-frame deadline measured from the first byte, not reset by every byte.
- Fifteen-minute established-idle timeout, with lazy reconnect afterward.
- Retain the five-second per-response write timeout.
- Capacity is acquired before spawning a handler and released through an RAII guard.
- Over-cap connections receive a small pre-session `server_busy` frame and close.
- Retryable admission failures use bounded jitter.

Sixty-four permits 20 normal lanes, 20 simultaneous replacement lanes, and operational/harness headroom. A cap of 20 would deadlock takeover because replacements could not connect until old lanes released their permits.

## Other blocking corrections

- **Reject identity and lane mismatches before journal binding.** Today parsing is followed immediately by `bind_request` and its fsync ([session.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:388), [audit.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:170)). Reads then trust `request.client_id` directly ([session.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:449)). Connection-bound actor/role validation must occur between decode and `bind_request`.

- **Resolve the pipelining contradiction.** The plan says one outstanding request and no pipelining, but tests two requests written back-to-back and two responses delivered in one chunk ([plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:84), [plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:92), [plan](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-21-item-d2-sessions-plan.md:125)). Replace these with same-socket request→response→request→response tests plus the concurrent-caller queue test. Otherwise the implementation freezes pipelining while the retry proof assumes at most one ambiguous request.

- **Migrate ownership sites to `close()`/`finally`.** Adding `close()` without calling it leaves persistent sockets referenced. `runCoordinationAgent` currently constructs a client, awaits the session, and returns without cleanup ([agent.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/agent.ts:182), [agent.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/agent.ts:261)); the harness client is similarly not closed explicitly ([liveAdapter.ts](/Users/toddhebebrand/Strata/packages/live-compare/src/liveAdapter.ts:192)). Twenty leaked lane sockets can keep Node alive and consume the admission cap.

## Factual audit

The core factual claims hold:

- Server: first-LF read, whole-buffer rescanning, one response then connection drop, blanket five-second read/write timeout, and unbounded thread-per-accept are all present ([server.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:94), [server.rs](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:195)).
- Client: one connection per attempt, response completion at EOF/close, cumulative per-connection byte counting, and no close lifecycle are all present ([client.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:90), [client.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:128), [client.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:136), [client.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:165)).
- The client’s original wall budget already spans retries through `expiresAt`; preserve that across lane queues ([client.ts](/Users/toddhebebrand/Strata/packages/coordination-client/src/client.ts:199)).
- The plan’s client line anchors are stale after D-1 extraction—`requestOnce` is now lines 90–163 rather than 100–173—but the analysis itself is correct.
