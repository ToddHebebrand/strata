# Item D-2 — Protocol v2 sessions: implementation plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review — READY TO EXECUTE. The v1 methodology review
returned **PROCEED-WITH-CORRECTIONS** (archived:
`docs/superpowers/specs/2026-08-21-item-d2-plan-review-codex.md`). Every
correction is folded in, including one that overturns a claim I had verified
myself. Governing spec: `docs/superpowers/specs/2026-08-20-item-d-design.md`
§ Slice D-2. Baseline: `main` ≥ 9d06770.

**Goal:** connections stop being per-request, and identity stops being a string
a client asserts about itself. Both change bytes on the wire, on both sides.

## What v1 got wrong

1. **The split is rejected. D-2 ships as ONE mergeable contract.** A
   transport-only D-2a would define a `protocolVersion: 2` whose first frame and
   authority model then change again in D-2b — freezing two incompatible
   meanings of v2, or temporarily shipping exactly the identity-bypass route the
   governing spec prohibits. Internal commits still stage the work; only the
   merge is atomic.
2. **My takeover discriminator was wrong, and so was my justification for it.**
   See Task 5.
3. **My "no existing caller issues concurrent requests" claim was wrong.** I
   enumerated explicit `Promise.all` sites and concluded serial-per-lane broke
   nobody. But `createCoordinationToolServer(client)` hands ONE client to all 15
   MCP tool handlers (`agent.ts:186`, `tools.ts:190`, `:341` — verified: 15 call
   sites close over the same instance), and the agent SDK permits several tool
   calls in one assistant message. **The live agent path can therefore produce
   concurrent calls on one client**, even though no harness code does so
   explicitly. The client must serialize internally.

   *Honesty note for the implementer:* the installed SDK is minified, so I could
   not verify its dispatch ordering from source. That does not matter — FIFO
   queueing is correct whether or not the SDK happens to await between handlers,
   and assuming it serializes would be betting the transport on an unverifiable
   internal. Do not spend time reverse-engineering `sdk.mjs`.

## Global constraints

- **No agent-visible semantic change.** Same actions, same results, same
  validation.
- **Every existing suite must pass over the new transport**, not a compatibility
  path. That is the acceptance bar.
- **The request-ID check stays GLOBAL.** The bounded protocol context is a
  transient validation window drained right after journal binding
  (`session.rs:404-406`).
- **No v1 compatibility mode.** A v1 first frame gets a narrow fail-fast
  rejection and close.
- Bounded everything; strict JSON and `deny_unknown_fields` / `.strict()` stay.
- No lifecycle work (D-3), no packaging, no item-C work, no keyed runs.
- `packages/live-compare/src/tasks.ts` is never staged.

---

### Task 1: The `open_session` handshake — the sole negotiation point

The first frame on every connection is the final handshake. Request frames may
carry `protocolVersion: 2` as a consistency check, but that is NOT a second
negotiation mechanism.

```json
{"protocolVersion":2,"type":"open_session","actor":"client:alpha","role":"work",
 "clientInstance":"<uuid>","connectionGeneration":"1"}
```

- `clientInstance` is stable across BOTH lanes for one `CoordinationClient`
  lifetime. `connectionGeneration` is monotonic **per role lane**.
- The reply carries the session identity: service epoch, validation mode,
  manifest digest, bound actor and role.
- **The handshake does NOT go through the journalled request path.** Every
  previously-unseen request appends a `RequestBound` record ending in
  `sync_data()` (`audit.rs:170-182`, `:241-255`) — a handshake per connection
  must not buy one.
- **Both failure directions are tested:** v1 client → v2 server, and v2 client →
  v1 server. Both must fail promptly; neither may wait for EOF indefinitely.
- `clientId` stays REQUIRED on request frames and is rejected on mismatch with
  the connection's binding, rather than omitted — this preserves the request
  schema and the whole golden corpus byte-for-byte, and closes the impersonation
  hole either way.

- [ ] Steps: wire RED (dual-language + golden fixtures, B-1 Task 1 pattern) →
  handshake handling in `server.rs` ahead of the request path → both fail-fast
  directions → green → commit.

### Task 2: Server read loop

**File:** `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`
(`handle_connection`, `:195-215`).

- Persistent buffer; split at the FIRST `\n`, retain the remainder as the next
  frame's prefix. Replace the whole-buffer `contains(&b'\n')` rescan with a scan
  from the last examined offset.
- **Do not relax `decode_frame`'s interior-newline check**
  (`protocol.rs:1203-1213`) — the connection layer splits before calling it, so
  the shared frame validator is untouched.
- **Strictly one outstanding request per connection: request → response →
  request.** v1 contradicted itself by forbidding pipelining while testing two
  frames written back-to-back and two responses in one chunk. Those tests are
  replaced. The retry proof depends on at most one ambiguous request per lane,
  so pipelining must not be accidentally frozen in.

- [ ] Steps: RED (same-socket request→response→request→response; idle survives
  past 5s then serves; half-written frame times out and closes with no
  response) → implement → green including the whole existing `local_service*`
  suite → commit.

### Task 3: Timeouts and admission — a LIVE issue, not a latent one

The review's answer to open question 5 was unambiguous, and I verified the
mechanism: every accepted connection spawns a detached OS thread with no cap
(`server.rs:94-101`); a valid request can occupy that handler for the protocol's
300-second maximum (`MAX_DEADLINE_MS`, `protocol.rs:16`) because the socket
timeout does not bound synchronous request execution. **A connection or
valid-request storm can exhaust threads on today's daemon.**

Policy to implement, with the review's numbers:
- 64 total admitted connections; at most 16 un-handshaken.
- 5s absolute handshake deadline.
- 5s absolute partial-frame deadline **measured from the first byte, not reset
  by every byte** (otherwise a slow trickle holds a thread forever).
- 15-minute established-idle timeout; lazy reconnect afterwards.
- Keep the 5s per-response write timeout.
- Capacity acquired BEFORE spawning a handler, released via an RAII guard.
- Over-cap connections get a small pre-session `server_busy` frame and close;
  clients retry with bounded jitter.

**Why 64 and not 20:** ten actors imply 20 normal lanes, but takeover needs
replacement lanes to connect while the old ones still hold permits. A cap of 20
would deadlock takeover.

- [ ] Steps: RED (cap refuses with `server_busy`; slow-trickle frame is killed
  at the absolute deadline; idle lane survives 10 minutes) → implement →
  commit.

### Task 4: Client persistent connection + internal FIFO queue

**File:** `packages/coordination-client/src/client.ts` (`requestOnce` is now
lines **90–163** after the D-1 extraction — v1's anchors were stale).

- Replace EOF-completion with an incremental scan for the first `0x0a`, keeping
  bytes past it as the next response's prefix.
- **Per-FRAME byte accounting**: reset at every delimiter. Today's counter is
  cumulative per connection (`client.ts:136`).
- Explicit lifecycle: connect lazily, reuse, `close()` that is safe to call
  twice.
- **Internal FIFO queue per lane** (the correction to my wrong claim): same-lane
  calls queue; one work and one observation request may be in flight
  concurrently. **Queue wait counts against the request's ORIGINAL wall-clock
  deadline** — the client already tracks that as `expiresAt` (`client.ts:199`),
  and an expired queued request must fail UNSENT rather than be written.

- [ ] Steps: RED — the existing `unixServer` fake is one-frame-per-connection
  (`client.test.ts:32-66`) and needs a persistent variant. Cases: two sequential
  requests use ONE connection; a response split across chunk boundaries is
  assembled; per-frame bound; **a direct concurrent-call test proving request 2
  is not written until response 1 arrives**; a queued request whose deadline
  expires fails unsent → implement → commit.

### Task 5: Ownership, takeover, and the honest boundary

**v1's rule is rejected.** "Not currently executing" lets a fresh duplicate
process steal an idle but healthy lane, lets two duplicates repeatedly displace
each other, and has a check/start race unless admission and takeover share one
lock.

**The rule to implement:**
- Ownership is **actor-level, not `(actor, role)`-level** — otherwise duplicate
  clients race such that A owns `work` while B owns `observation`. The registry
  enforces one `clientInstance` owner per actor, with two role slots beneath it.
- Same actor + role + `clientInstance`, strictly higher `connectionGeneration`:
  **accept and fence the old connection**, whether idle or executing.
- Same or lower generation: reject as stale.
- Different `clientInstance` while any lane of the old instance is live: reject
  `lane_conflict`.
- Different `clientInstance` may take over **only after positive transport
  evidence that every old-instance lane is dead** — EOF/HUP from a
  non-consuming socket probe — never merely because a lane looks idle.
- Atomically replace the registry binding; shut the old socket down OUTSIDE the
  registry lock.
- **Handler cleanup compares a unique binding token before removing itself**, so
  a dying old handler cannot unregister its replacement.

**The information boundary, stated rather than papered over:** if a new process
presents a fresh instance id and the old socket shows no observable HUP, it is
genuinely indistinguishable from a live duplicate. In that state the honest
contract is **rejection**, not a busy/idle guess.

A fenced-but-admitted old mutation may still complete; exact replay stays safe
because completed requests return the cached response and
pending/effect-result requests serialize or return `request_in_progress`
(`session.rs:544`).

- [ ] Steps: registry with binding tokens → the five-arm rule above, each arm a
  named test → takeover-under-load case → commit.

### Task 6: Lane assignment is its own authority

**Do NOT derive lanes from `isMutatingAction`** — they answer different
questions. `ack_events` is mutating (for idempotency) but observational (for
scheduling), and keeping read and ack on the SAME serial lane preserves their
natural ordering.

- **Work:** `begin_change_set`, `add_intent`, `submit_change_set`,
  `advance_change_set`, `cancel_change_set`.
- **Observation:** all discovery/inspection actions, `read_events`,
  `ack_events`, `read_operation`, and the validation-fixture reads.

Create an exhaustive `laneForAction` authority with its own dual-language
fixture, in the same shape as D-1's `action-partition.json`.

- [ ] Steps: `laneForAction` + `action-lane.json` fixture, asserted exhaustively
  in BOTH languages → client routes by it → lane-isolation gate (an observation
  read completes while the work lane is mid-`advance`) → commit.

### Task 7: Reject identity and lane mismatches BEFORE journal binding

Today `handle_frame` parses and then immediately calls `bind_request` with its
fsync (`session.rs:388-402`), and reads then trust `request.client_id` directly
(`session.rs:449`). Connection-bound actor/role validation must sit **between
decode and `bind_request`**, so a spoofed or wrong-lane request costs no durable
write.

- [ ] Steps: RED (a wrong-actor request appends nothing to the journal) →
  implement → commit.

### Task 8: The retry contract

Transport replay and semantic redrive are different (verified: `session.rs:699`
durably caches a retryable error against the request identity, so replaying the
same key returns the cached error).

- Unsent → send normally after reconnect.
- Sent mutation, no response → replay exact bytes, same `requestId` and
  `idempotencyKey`, within the original deadline.
- Read, no response → do NOT auto-replay; reissuing may observe a later
  generation. Caller-driven.
- `request_in_progress` → backoff with jitter, same identity.
- **Retryable operational failure → NOT transport replay.** Surface it upward; a
  later `advance_change_set` is a NEW request with a NEW idempotency key.
  Bounded jitter so ten clients do not redrive in lockstep.

- [ ] Steps: encode the matrix as named tests first → implement → commit.

### Task 9: Migrate ownership sites to `close()`

Adding `close()` without calling it leaves persistent sockets referenced —
twenty leaked lane sockets can keep Node alive AND consume the admission cap.
Verified: `agent.ts` constructs a client, awaits the session, and returns with
no cleanup (no `close()` or `finally` anywhere in the file);
`liveAdapter.ts:192`'s harness client is likewise never closed.

- [ ] Steps: `try/finally` at `agent.ts:182+` and `liveAdapter.ts:192+`; a test
  asserting no lingering handles after a session → commit.

### Task 10: Ten-client gate, chain, close

- [ ] Deterministic ten-client gate: 20 lanes, concurrent work, no lane
  starvation, admission cap respected, takeover under load, `server_busy` above
  the cap.
- [ ] Full chain detached (Orca) + workspace sweep with the documented
  path-dependent exceptions; decisions.md close; roadmap.

---

## Risks carried, with one now measured

- **Per-request fsync — measured, and it redirects the concern.** A successful
  read costs TWO `sync_data()` calls, not one: the request journal
  (`audit.rs:252`, via `bind_request`) and the audit log (`audit.rs:331`). A
  synthetic probe of the same write shape on this machine: **0.036 ms per
  fsynced append vs 0.0033 ms un-synced**, so ~0.07 ms per read. Ten pollers
  therefore do NOT "serialize on disk" in any meaningful sense (~0.7 ms
  aggregate). **Caveat that matters more than the number:** macOS `fsync` flushes
  to the drive's write cache and does not force a device flush (`F_FULLFSYNC`
  would), so this is a page-cache figure and would be far worse elsewhere.
  **Therefore the before/after D-2 owes is LOCK HOLD TIME, not disk** — the
  protocol context, journal, and audit mutexes are each taken globally per
  request, and their critical sections happen to contain an fsync.
- Unbounded `request_bindings` (`audit.rs:83`, insert-only, rebuilt by a full
  journal scan at startup `audit.rs:87`) — untouched by the above, still open.
- `change_set_locks` insert-only (`session.rs:162`, `:1549`).
- In-memory-only delivered ceilings: after a restart, acking events delivered
  before the crash fails until the client rereads. The client should deliberately
  reread and deduplicate on a service-epoch change.

## Self-review (v2)

All review corrections mapped: split rejected → one merge, Task 1 as sole
negotiation point; takeover heuristic rejected → Task 5's generation +
liveness + actor-level ownership + binding token; lane authority → Task 6;
concurrency claim overturned → Task 4's FIFO queue; live admission exhaustion →
Task 3 with concrete caps; pre-binding rejection → Task 7; pipelining
contradiction → Task 2's replaced tests; `close()` migration → Task 9; stale
client anchors corrected to 90–163. The three factual claims I could check
myself (shared client across 15 handlers, no cleanup in `agent.ts`, the 300s
deadline ceiling) were verified before adoption; the SDK's internal dispatch
ordering could not be, and the design is deliberately correct either way.
