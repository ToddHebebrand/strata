# Item D — independent design review (Codex gpt-5.6-sol, xhigh, read-only)

**Provenance.** Run 2026-08-20 against branch `main` at ff6adcd, read-only
sandbox, reasoning effort `xhigh`, ~392k tokens. Brief:
`2026-08-20-item-d-review-brief.md`.

**Verification status (this project's rule: pivotal empirical claims are
checked against source before they are accepted).** All four decision-grade
claims were re-verified in-session and HOLD:

1. **The 16-vs-256 intent bound is a real cross-language defect.**
   `packages/live-compare/src/protocol.ts:16` caps `MAX_OPERATION_INTENTS` at
   16; `crates/.../protocol.rs:31` allows 256, matching `session.rs:30`'s
   `MAX_INTENTS = 256`. A change set with more than 16 intents therefore
   produces a `read_operation` response the typed client rejects. The Rust side
   even carries a comment (`protocol.rs:1375`) saying this constant must track
   `MAX_INTENTS` — the TypeScript mirror did not. Latent today only because no
   test builds a change set that large.
2. **A retryable operational error IS durably recorded as completed.**
   `session.rs:699` `append_effect_result` stores the error response against the
   request identity, so replaying the same `idempotencyKey` returns the cached
   error rather than re-driving. The reviewer's conclusion — a later
   `advance_change_set` must be a NEW top-level request with a new key — is
   correct, and is a client-contract detail the current client does not state.
3. **Every fresh request, including reads, costs an fsync.**
   `audit.rs:241-255` `append()` ends in `self.file.sync_data()`, and
   `bind_request` (`audit.rs:170-182`) appends a `RequestBound` record for every
   previously-unseen request — reads included (`session.rs:396-402`). Ten event
   pollers really can serialize on disk before transport matters.
4. **Both unbounded-growth claims hold.** `request_bindings` (`audit.rs:83`) is
   insert-only and rebuilt by a full journal scan at startup; `change_set_locks`
   (`session.rs:162`, used at `:1549`) is insert-only with no removal path.

The reviewer also corrected the brief on four points, all accepted: the
capacity-bounded protocol context is a transient validation window rather than
the durable dedupe mechanism (so it is NOT the reuse bottleneck, and making it
per-connection would weaken replay checking); the operation `actor` is copied at
`publication.rs:625` rather than at the anchor the brief cited; "drain another
actor's cursor" takes two calls, not one, with the vulnerability unchanged; and
there is no existing thread pool to multiplex onto — the server spawns one
unbounded OS thread per connection.

---

## Bottom line

The brief is substantially accurate. My recommendations are:

| Fork | Recommendation |
|---|---|
| 1 | **1a + 1d:** serial newline-framed sessions with two role-based connections per actor |
| 2 | Replay ambiguous mutations; no resume ledger; keep transport replay distinct from semantic redrive |
| 3 | **3c**, strengthened with actor/role binding and duplicate-lane detection |
| 4 | Lifetime-held file locks acquired before opening redb; bounded request drain on shutdown |
| 5 | Extract first, then protocol v2, then lifecycle; defer binary distribution packaging until after E |

I would not build multiplexing for D. It adds a concurrency model that the server does not have and cannot overcome the existing single-flight Node bridge.

## Section 2 source audit

The pivotal claims check out, with these corrections and qualifications.

1. **The capacity-bounded request map is not the durable deduplication mechanism.**

   `LocalServiceProtocolContext.requests` is process-global and bounded, but it is only a transient validation window ([protocol.rs:567](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:567)). The entry is removed immediately after journal binding ([session.rs:388](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:388)). The durable binding is the journal’s unbounded `request_bindings` map ([audit.rs:79](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:79), [audit.rs:170](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:170)).

   Therefore, the 1,024-entry volatile capacity is not the multiplexing/reconnect bottleneck. Moving it per-connection would actually weaken cross-connection replay checking.

2. **The operation-actor conclusion is correct, but the final anchor is indirect.**

   The cited lines set the change-set actor from `pending.client_id` ([session.rs:853](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:853)). The published operation subsequently copies that stored actor at [publication.rs:625](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:625). So the security conclusion stands, but `session.rs:861-866` is not itself the operation-record construction.

3. **“Drain another actor’s cursor” requires two calls.**

   `read_events` obtains that actor’s events and raises an in-memory delivered ceiling ([session.rs:1233](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1233)); `ack_events` then advances the durable cursor, subject only to that ceiling ([session.rs:1531](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1531)). An impersonator can perform both, so the practical vulnerability is unchanged.

4. **There is no “existing thread pool” for 1b.**

   The server directly creates one unbounded OS thread per accepted connection ([server.rs:94](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:94)). Multiplexing would require a new bounded executor plus a serialized response writer and outbound backpressure.

5. **Multiple-frame rejection is real but timing-dependent in the current server.**

   Both decoders reject interior newlines ([protocol.rs:1203](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:1203), [protocol.ts:741](/Users/toddhebebrand/Strata/packages/live-compare/src/protocol.ts:741)). However, the server stops reading once its current buffer contains the first LF ([server.rs:195](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:195)). A later second frame may simply meet a closed connection rather than receive the explicit error. This does not change the conclusion that reuse needs a server-side protocol change.

6. **There is already a cross-language schema defect.**

   Rust accepts up to 256 operation intents ([protocol.rs:31](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:31)), while TypeScript accepts only 16 ([protocol.ts:16](/Users/toddhebebrand/Strata/packages/live-compare/src/protocol.ts:16)). A valid `read_operation` response can therefore be rejected by the typed client. An independent read-only pass surfaced this; I reverified it directly. D-1 should fix it before extraction freezes the contract.

The remaining pivotal claims—EOF-delimited client completion, mutation-only disconnect retry, self-asserted `clientId`, unconditional socket unlink, mandatory path flags, `node` from `PATH`, and hardcoded harness paths—are accurate ([client.ts:100](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:100), [client.ts:189](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:189), [server.rs:170](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:170), [server.rs:182](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:182), [main.rs:85](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:85), [service.ts:76](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:76)).

## Fork 1 — framing

**Recommendation: combine 1a and 1d.**

Use newline-delimited, strictly serial framing per connection, with two persistent role lanes per actor:

- a work lane for change-set operations;
- an observation lane for reads, events, and acknowledgements.

Head-of-line blocking is real enough to address. `advance_change_set` can consume the 300-second deadline and performs candidate execution and publication synchronously. Meanwhile, ready offers are time-limited, so an actor with other queued work may need event delivery while an advance is running ([protocol.ts:3](/Users/toddhebebrand/Strata/packages/live-compare/src/protocol.ts:3), [coordination design:135](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:135)). Two serial lanes solve that without creating general multiplexing.

I reject 1b for D because:

- there is no existing executor;
- concurrent handlers need one response-writer queue or writes can interleave;
- every connection needs bounded in-flight and outbound-response capacities;
- one slow reader can retain multiple 256 KiB responses;
- a disconnect creates N ambiguous requests;
- the persistent Node bridge is itself explicitly single-flight behind one mutex ([persistent.rs:232](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/persistent.rs:232), [persistent.rs:316](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/persistent.rs:316)).

Multiplexing would mostly enlarge queues; it would not increase semantic execution throughput.

I reject 1c because strict single-line JSON plus 64/256 KiB frame limits makes delimiter scanning trivial.

Additional requirements for 1a:

- Reset response-byte accounting at every delimiter; the current client counts the entire connection ([client.ts:138](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:138)).
- Permit idle sessions while retaining a short timeout once a partial frame begins. The current five-second read timeout would disconnect every thinking agent ([server.rs:195](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:195)).
- Allow one outstanding request per lane and bound the retained prefix. Do not accept unbounded pipelining.
- Cap admitted sessions/threads. Ten actors imply roughly twenty normal connections, but reconnect storms must not create unbounded threads.

**Compatibility:** do not ship a permanent v1 mode. The old client waits for EOF, so it would hang against a persistent server. Use a protocol-v2 handshake and make v1 fail fast and close. D-1 may temporarily keep v1 green while extracting the client, but the final D surface should not retain a route that bypasses connection-bound identity.

The request-ID check should remain global. The transient 1,024-entry map is immediately drained and is ample for this topology; the durable journal’s growth and fsync behavior are the actual concerns.

## Fork 2 — retry semantics

No resume/replay handshake is needed with two serial lanes because each lane has at most one ambiguous request.

The client contract should distinguish:

- **Unsent request:** send normally after reconnect.
- **Sent mutation without response:** reconnect and replay the exact serialized request with the same `requestId` and `idempotencyKey`, retaining the original overall deadline.
- **Read without response:** do not automatically replay as though it were the same observation. Reissuing a read may observe a later generation; keep it caller-driven.
- **`request_in_progress`:** back off with jitter and replay the same identity within the original deadline.
- **Received retryable operational failure:** this is semantic redrive, not transport replay.

That last distinction is important after B-2. Operational failure releases and requeues the claim first ([session.rs:1083](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1083)), but the retryable error response is then durably recorded as completed ([session.rs:699](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:699)). Reusing the same idempotency key only replays that error. A later `advance_change_set` must be a new top-level request with a new idempotency key.

The transport layer should therefore never automatically turn `candidate_execution_failed` into a new semantic operation. Expose that retryability to the higher-level client and use bounded backoff/jitter so ten clients do not redrive simultaneously.

## Fork 3 — actor identity

**Recommendation: 3c, but stronger than “the first frame contains an actor string.”**

The appropriate D/E threat model is:

> Clients are cooperating processes under one OS user. Connection binding must prevent accidental cross-talk, duplicate configuration, and misleading attribution. A deliberately hostile same-UID process is outside the current security boundary.

Within that model:

- A versioned handshake binds the connection to `(actor, role, client-instance)`.
- Subsequent requests omit `clientId`, or the server rejects any mismatch.
- The daemon detects duplicate `(actor, role)` lanes.
- Reconnect uses an explicit client-instance/session generation so a replacement lane can supersede a dead connection without waiting 300 seconds.
- Peer UID/PID may be recorded for diagnostics, but peer credentials are not agent identity.

This makes 3a insufficient: all ten agents share the same UID. I would not adopt 3b yet: capabilities do not buy much against a hostile process sharing the same OS principal unless their delivery and storage are also isolated. That is more than a token field.

I reject 3d. `clientId` currently controls ownership, acknowledgements, deterministic change-set IDs, and canonical attribution ([session.rs:1518](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1518), [session.rs:1724](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1724), [publication.rs:625](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:625)). With ten clients, duplicate or misrouted actor configuration is plausible enough to corrupt audit meaning even without an attacker.

The documentation must still say that attribution is authoritative within the cooperating session, not proof against malicious same-UID software.

## Fork 4 — single owner and lifecycle

**Recommendation: lifetime-held file locking; PID data is metadata, never authority.**

The authoritative ownership lock must be keyed to the canonical database/state directory, not merely the socket token. If caller-chosen tokens remain independent, also serialize ownership of the token-derived endpoint.

Startup should be:

1. Canonicalize the state/database identity.
2. Acquire its nonblocking owner lock and hold the descriptor for the daemon’s lifetime.
3. Acquire or verify endpoint ownership.
4. If an existing socket answers a valid health handshake, fail as already running.
5. If the lock is held by this process and the socket is dead, unlink it as stale.
6. Open/recover the `ServiceSession`, validate the seed, hydrate, bind, then publish readiness.

The ordering is critical. Today `ServiceSession::open` performs recovery and constructs durable session state before socket binding ([server.rs:41](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:41), [session.rs:200](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:200)). A losing second daemon must be excluded before any of that work, not merely when it eventually tries to bind.

A liveness probe without a held lock has a check/unlink/bind race. A PID alone has stale-file and PID-reuse races.

For `stop`, drain **active request handlers**, not all durable change sets:

- stop accepting new sessions;
- close idle lanes;
- return a typed retryable `service_draining` for requests not yet started;
- allow already-running requests a bounded grace period;
- leave drafts and queued tickets durable;
- after grace, exit and let existing crash recovery reconcile ambiguous execution.

An agent then sees exactly one of: a normal response, `service_draining`, or a disconnect followed by ordinary mutation replay. Shutdown must not report a change set as cancelled unless the canonical lifecycle actually cancelled it.

The health check should be served by the lightweight session handshake, not the ordinary journalled request path; otherwise polling health itself produces durable fsync traffic.

## Fork 5 — slicing and sequencing

I would change the provisional split to:

1. **D-1: extraction and wire parity.** Move the dependency-light protocol/client into its own workspace package without changing behavior. Fix the 16-versus-256 intent mismatch and add cross-language boundary fixtures. Keep v1 one-shot green only as a transitional checkpoint.

2. **D-2: protocol v2 sessions.** Add serial NDJSON framing, two role lanes, actor/role handshake, reconnect takeover, retry state separation, idle/partial-frame timeouts, and deterministic ten-client transport gates.

3. **D-3: lifecycle.** Add pre-open ownership locks, stale-socket recovery, `start/stop/health`, bounded draining, and crash/restart tests.

Cut full binary/platform distribution packaging from D. Item E can use an explicit developer launcher with caller-supplied binary, worker, and corpus paths. The current daemon requires six paths plus a token and launches `node` from `PATH` ([main.rs:85](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:85), [main.rs:146](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/main.rs:146)); the harness assumes repository-relative debug artifacts ([service.ts:80](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:80)). E should establish what an embedder genuinely needs before those assumptions are frozen into distribution machinery.

## Risks missing from the brief

These deserve explicit D/E gates:

- **Global durable-I/O serialization.** Every fresh request—including successful reads—first binds and fsyncs the request journal, and successful reads then append/fsync the audit log ([session.rs:397](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:397), [audit.rs:241](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:241), [audit.rs:321](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:321)). Ten event pollers can serialize on disk before socket handling matters.

- **Unbounded journal growth and restart time.** Request bindings and mutation results have no eviction, and startup scans the complete journal ([audit.rs:87](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:87)). The design needs an explicit retention/checkpoint story before calling the daemon long-lived.

- **Single-flight semantic bridge.** All persistent-worker requests queue behind one mutex. Measure and expose its queue wait; do not attribute that delay to the socket transport.

- **Restarted event acknowledgements.** The delivered ceiling is only in memory. After restart, acknowledging events delivered before the crash will fail until the client rereads them. The client should deliberately reread and deduplicate after a service-epoch change.

- **Per-change-set lock retention.** `change_set_locks` only inserts and has no eviction path ([session.rs:1547](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:1547)). A long-running ten-agent build that creates many small change sets leaks one map entry and mutex per change set.

- **Reconnect split-brain.** With role lanes, a dead client can reconnect while its old server handler is still executing. The handshake needs explicit same-instance takeover semantics; merely rejecting duplicate actors can strand the client for the full request deadline.

- **Slow/partial clients.** Admission count, partial-frame bytes, per-frame duration, outbound bytes, and idle lifetime all need separate bounds. One generic five-second socket timeout is not an adequate persistent-session policy.
