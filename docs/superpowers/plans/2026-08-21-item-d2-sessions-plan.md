# Item D-2 — Protocol v2 sessions: implementation plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v1, pre-review. Governing spec:
`docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-2. Charter:
decisions.md 2026-08-20. Baseline: `main` ≥ 9d06770 (D-1 merged).

**Goal:** connections stop being per-request, and identity stops being a string
a client asserts about itself. Both change bytes on the wire, on both sides.

## The proposed sub-split (REVIEWER: adjudicate this first)

D-2 as specified carries framing, lanes, handshake identity, reconnect
takeover, timeout policy, admission control, and a retry contract. That is
larger than D-1 and larger than either B slice. I propose splitting it so each
half is independently green:

- **D-2a — framed persistent transport.** Server read loop, client leftover
  buffer, per-frame byte accounting, idle-vs-partial-frame timeouts, admission
  cap, v2 negotiation with v1 fail-fast. ONE connection per client, one
  outstanding request. No identity, no lanes.
- **D-2b — session identity and lanes.** `(actor, role, client-instance)`
  handshake, connection-bound actor, duplicate-lane detection, reconnect
  takeover, two role lanes, the retry contract.

The seam is real: D-2a is a transport change provable by existing suites
running unchanged over persistent connections; D-2b is a semantics change on
top. **If you disagree, say so and I will do D-2 as one slice** — this is the
first question, because everything below is organized around it.

Risk of the split: the design says the final D surface must retain no route
that bypasses connection-bound identity. D-2a is such a route. It is acceptable
ONLY as an intermediate state inside item D, and D must not close until D-2b
lands. Alternative if that is too loose: fold a minimal handshake into D-2a and
leave only lanes/takeover for D-2b.

## Global constraints

- **No agent-visible semantic change.** Same actions, same results, same
  validation. This slice changes how a client talks to the daemon, not what it
  can ask for.
- **Every existing suite must pass over the new transport**, not a v1
  compatibility path. That is the acceptance bar: if `gate1`/`gate3`/behavioral
  suites go green with persistent connections, the transport is honest.
- **The request-ID check stays GLOBAL** (review-adjudicated). The bounded
  protocol context is a transient validation window drained immediately after
  journal binding (`session.rs:404-406`); making it per-connection would weaken
  cross-connection replay checking.
- **No permanent v1 mode.** A v1 client waits for EOF and would HANG against a
  persistent server, so v1 must fail fast and close, never linger.
- Bounded everything; strict JSON and `deny_unknown_fields` / `.strict()` stay.
- No lifecycle work (D-3), no packaging, no item-C work, no keyed runs.
- `packages/live-compare/src/tasks.ts` is never staged.

---

## D-2a — framed persistent transport

### Task 1: Server read loop

**Files:** `crates/strata-kernel/src/bin/strata_kernel_service/server.rs`.

Today `handle_connection` (`:195-215`) reads until the first `\n`, handles,
writes one response, and drops the connection. It must loop.

**Interfaces / behavior:**
- Read into a persistent buffer; on each iteration, split at the FIRST `\n` and
  retain the remainder as the next frame's prefix. Today's
  `request.contains(&b'\n')` is an O(n) rescan of the whole buffer per read —
  replace with a scan from the last examined offset.
- **Do not relax `decode_frame`'s interior-newline check**
  (`protocol.rs:1203-1213`). The connection layer splits BEFORE calling it, so
  the frame validator keeps rejecting multi-frame payloads exactly as today.
  This is deliberately the lower-blast-radius option: `decode_frame` is shared
  with the offline oracle and both languages' fixture suites.
- **Timeout policy split.** The blanket `set_read_timeout(5s)` (`:196`) would
  disconnect every thinking agent. Replace with: an IDLE timeout between frames
  (generous — a client may sit idle for minutes), and a short PARTIAL-FRAME
  timeout once a frame's first byte has arrived. A timeout must close the
  connection cleanly, not propagate as an `Err` that skips the response.
- **Bound the retained prefix** so a client cannot buy unbounded memory by
  sending 63KB of a frame and stopping.
- **One outstanding request per connection.** The loop is serial by
  construction; reject (or simply never read) a second frame while one is
  executing. No pipelining.
- **Admission cap.** The accept loop spawns an unbounded OS thread per
  connection (`:94-101`). Cap concurrent sessions; beyond the cap, refuse with
  a typed error and close, so a reconnect storm cannot exhaust threads. Ten
  actors imply ~20 connections in D-2b; pick a cap with headroom and state it.

- [ ] **Step 1 (RED).** Rust integration test: two request frames written
  back-to-back on ONE connection each get their own response, in order.
- [ ] **Step 2 (RED).** Idle connection survives well past 5s and then serves a
  request; a half-written frame times out and closes without a response.
- [ ] **Step 3.** Implement; green those plus the whole existing
  `local_service*` suite (which still uses one-request connections — the server
  must serve both shapes, since a client that sends one frame and closes is
  just a session of length one).
- [ ] **Step 4: commit.**

### Task 2: Client persistent connection

**Files:** `packages/coordination-client/src/client.ts`.

`requestOnce` (`:100-173`) completes a response only at EOF and counts
`MAX_RESPONSE_FRAME_BYTES` per CONNECTION (`:139-142`).

**Interfaces / behavior:**
- Replace EOF-completion with an incremental scan for the first `0x0a`, keeping
  any bytes past it as the next response's prefix.
- **Per-FRAME byte accounting** (review): reset the counter at every delimiter.
- A connection object with explicit lifecycle: connect lazily, reuse, `close()`.
  The class currently has no `close()`/`dispose()` — add one, and make it safe
  to call twice.
- **v2 negotiation with v1 fail-fast.** State on the wire which version the
  connection speaks; a v1 peer must fail immediately and close rather than hang.
  Decide and record: is the version a field on the handshake frame (D-2b) or on
  every request frame? If D-2a ships before the handshake exists, it needs its
  own negotiation point — **this is the strongest argument for folding a minimal
  handshake into D-2a.**
- Keep the existing deadline semantics: `deadlineMs` remains the absolute wall
  budget for the whole `request()` call.

- [ ] **Step 1 (RED).** Client unit tests over the existing `unixServer` fake,
  which is one-frame-per-connection today (`client.test.ts:32-66`) and needs a
  persistent variant: two sequential requests use ONE connection; a response
  arriving split across chunk boundaries is assembled; two responses in one
  chunk are demultiplexed in order; a frame over the bound fails per-frame, not
  per-connection.
- [ ] **Step 2.** Implement; green the client suite.
- [ ] **Step 3: commit.**

### Task 3: Transport parity gate

- [ ] **Step 1.** Run the ENTIRE existing suite over persistent connections
  unchanged — `gate1`, `gate2`, `gate3`, oracle, memory, discovery, behavioral.
  This is the real acceptance: no semantic test should notice.
- [ ] **Step 2.** A connection-count assertion proving reuse actually happened
  (the fake server already counts connections; the daemon side can be observed
  via the admission counter). Without this the slice could "pass" while silently
  still opening one connection per request.
- [ ] **Step 3.** Full key-free chain; commit.

---

## D-2b — session identity and lanes

### Task 4: The handshake

**Wire shape (draft — reviewer, critique this):**

```json
{"protocolVersion":2,"type":"open_session","actor":"client:alpha","role":"work","clientInstance":"<uuid>"}
```

replying with the session's identity — service epoch, validation mode, manifest
digest, and the bound lane.

**Decisions taken, with reasons (challenge them):**
- **`clientId` stays REQUIRED on request frames and is rejected on mismatch**,
  rather than omitted. The design allows either. Keeping it preserves the
  request schema and the entire golden corpus byte-for-byte, and the
  impersonation hole closes either way — the daemon stops believing the field
  and starts checking it against the connection's binding.
- **The handshake does NOT go through the journalled request path.** Every
  previously-unseen request currently appends a `RequestBound` record ending in
  `sync_data()` (`audit.rs:170-182`, `:241-255`). A handshake per connection —
  and later a health probe — must not buy an fsync each.

- [ ] **Steps:** wire RED (dual-language, golden fixtures as B-1 Task 1) →
  session binding in `server.rs`/`session.rs` → requests validated against the
  binding → green → commit.

### Task 5: Duplicate lanes and reconnect takeover

**The tension to resolve (REVIEWER: this is the second question).** Two rules
pull against each other:
- *Duplicate detection*: two live processes misconfigured with the same
  `(actor, role)` must not silently share an identity — that is the
  ten-client failure mode the design cites as plausible with no attacker.
- *Reconnect takeover*: a client whose lane died must be able to replace it
  without waiting out a 300s deadline.

Both present as "a second connection claims an existing `(actor, role)`."
Distinguishing them by `clientInstance` alone fails: a misconfigured second
process also has a fresh instance id, so it would take over rather than be
refused.

**My proposal:** accept a takeover only when the existing lane is NOT currently
executing a request; if it is, refuse with a typed error naming the conflict.
Then a genuine reconnect (old lane dead or idle) succeeds immediately, while two
live misconfigured clients collide as soon as both are active. **This is a
heuristic, not a proof** — it mistakes a genuinely dead-but-mid-request lane for
a conflict, stranding the client until that request's deadline. Is there a
better discriminator?

- [ ] **Steps:** lane registry keyed `(actor, role)` → binding; takeover rule
  with the executing-request guard; old lane closed on takeover; typed
  `lane_conflict` error; tests for both arms.

### Task 6: Two role lanes in the client

Work lane (change-set operations) and observation lane (reads, events, acks),
each serial. This is what buys the head-of-line-blocking fix: an
`advance_change_set` may hold the work lane for its full deadline while events
still flow.

- [ ] **Steps:** route each action to its lane by the SAME partition source of
  truth D-1 introduced where possible (note: the work/observation split is NOT
  identical to mutating/read-only — `read_events`/`ack_events` are observation
  but `ack_events` is mutating; state the mapping explicitly and fixture it) →
  lane-isolation gate: an observation read completes while the work lane is
  mid-advance → commit.

### Task 7: The retry contract

Transport replay and semantic redrive are different things and the client must
not conflate them (verified: `session.rs:699` durably caches a retryable error
against the request identity, so replaying the same key returns the cached
error).

- Unsent → send normally after reconnect.
- Sent mutation, no response → replay exact bytes, same `requestId` and
  `idempotencyKey`, within the original deadline.
- Read, no response → do NOT auto-replay; reissuing may observe a later
  generation. Caller-driven.
- `request_in_progress` → backoff with jitter, same identity.
- **Retryable operational failure → NOT transport replay.** Surface
  retryability upward; a later `advance_change_set` is a NEW request with a NEW
  idempotency key. Bounded backoff with jitter so ten clients do not redrive in
  lockstep.

- [ ] **Steps:** encode the matrix as tests first (each row a named case) →
  implement → commit.

### Task 8: Ten-client transport gate, chain, close

- [ ] Deterministic ten-client gate: 20 lanes, concurrent work, no lane
  starvation, admission cap respected, reconnect takeover under load.
- [ ] Full chain detached (Orca) + workspace sweep with the documented
  path-dependent exceptions; decisions.md close; roadmap.

---

## Risks to disclose, not fix here

The design's "risks to gate" list stays open in D-2 and must not be silently
absorbed: per-request fsync on the read path (ten pollers serialize on disk
before transport matters — **measure before crediting D-2 with any latency
win**), unbounded `request_bindings`, `change_set_locks` insert-only, and
in-memory-only delivered ceilings meaning acks fail after restart until reread.

## Open questions for the methodology review

1. **The D-2a/D-2b split** — right seam, or one slice? And if split, does D-2a
   need a minimal handshake for version negotiation anyway (which would argue
   for folding identity in)?
2. **The takeover discriminator** (Task 5) — is the executing-request guard the
   right rule, or is there a cleaner one?
3. **Work/observation lane assignment** — `ack_events` is mutating but
   observational. Does splitting by lane rather than by mutating-ness create a
   case where a lane must carry both, defeating the isolation?
4. *(Answered before review, by enumeration — retained for the record.)* No
   existing harness issues concurrent requests on ONE client. The two
   concurrent sites both use separate clients:
   `tests/gate1Intrusion.test.ts:412` fires two advances via
   `Promise.allSettled` on distinct clients `a` and `b`, and
   `src/liveAdapter.ts:155` runs one agent per assignment, each with its own
   `clientId`. So the serial-per-lane model breaks no current caller and needs
   no migration step. **Reviewer: confirm I have not missed a site.**
5. Anything in the timeout/admission policy that is a live DoS today rather than
   a latent hazard.
