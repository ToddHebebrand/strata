# Item D — typed client library + session hygiene (design, post-review)

**Status:** chartered 2026-08-20. Independent design review completed BEFORE
this spec was written: brief at `2026-08-20-item-d-review-brief.md`, Codex
gpt-5.6-sol xhigh read-only output archived at
`2026-08-20-item-d-review-codex.md`. All four decision-grade review claims were
source-verified in-session (16-vs-256 intent bound, retryable-error caching,
per-request fsync, unbounded `request_bindings`/`change_set_locks`) — see the
archive's verification header. The review's re-slicing is adopted, not deferred.
Implementation plans: not yet written; this spec governs them.

## Why item D exists

The surface principle (decisions.md 2026-07-18) is that the coordination
protocol IS the agent surface, and what harnesses embed is a thin typed client;
any MCP or CLI surface is an adapter over that client, never a parallel
implementation. Item B earned the first half of that claim — until discovery and
an honest validation gate existed, nothing real could orient on the kernel. Item
D earns the second half: today there is no client anyone could embed, only a
well-tested one living inside the benchmark harness with provisional session
hygiene.

Three gaps, all verified:

1. **A connection per request.** The convergence review named this as one of
   five hidden N=1 costs. It cannot be fixed client-side: "connection contains
   multiple frames" is an enforced, tested protocol error in both languages
   (`protocol.rs:1203`, `protocol.ts:741`), and the server handles exactly one
   request per connection and drops it (`server.rs:195-215`).
2. **Identity is a filesystem capability.** `--socket-token` is validated for
   length only and never reaches the wire (`server.rs:175-180`); it merely
   derives a 0600 socket path. So authentication is "any local process of the
   same uid." Meanwhile `clientId` is self-asserted and unbound, yet drives
   change-set ownership (`session.rs:1518`), the delivered-events cursor and ack
   ceiling (`session.rs:1531`), the change-set ID namespace (`session.rs:1724`),
   and becomes the canonical operation's `actor` (`publication.rs:625`).
3. **No single owner, no lifecycle.** `bind_private_socket` unconditionally
   unlinks an existing socket (`server.rs:186-188`), so a second daemon silently
   steals the endpoint. There is no lock, pidfile, signal handling, or drain.

Item E (~10 concurrent agents, scratch to green release) consumes this client,
so E is its first real exercise — and it is where each of these stops being
cosmetic.

## Threat model (stated, because the design depends on it)

> Clients are cooperating processes under one OS user. Connection binding must
> prevent accidental cross-talk, duplicate configuration, and misleading
> attribution. A deliberately hostile same-uid process is OUTSIDE the current
> security boundary.

This is adopted deliberately. Peer credentials (`LOCAL_PEERCRED`) authenticate
the wrong axis — every agent in the fleet shares a uid — and issued per-actor
capabilities buy little against a same-principal attacker unless their delivery
and storage are also isolated, which is a larger system than this project needs.
**Product copy and docs must say that attribution is authoritative within a
cooperating session, not proof against malicious same-uid software.**

## Structure: THREE independently green slices

Adjudicated by the review, which reordered the provisional split so extraction
lands before the wire change rather than with it.

### Slice D-1 — extraction and wire parity

Move the dependency-light client into its own workspace package with **no
behavior change**. `client.ts` + `protocol.ts` are a clean cut: their only
dependencies are `node:crypto`, `node:net`, and `zod`, and `live-compare` is a
leaf that nothing imports.

- The MCP tool server does NOT come along: `tools.ts` couples to
  `@anthropic-ai/claude-agent-sdk@0.2.118`. It becomes a separate package or an
  optional subpath export, so "thin embeddable client" stays true.
- `service.ts` (daemon launcher) is NOT moved — it is rewritten in D-3. It
  carries CJS `__dirname` and hardcoded repo-relative `target/debug` paths that
  cannot survive a published package.
- **Fix the 16-vs-256 intent bound** before extraction freezes the contract, and
  add cross-language boundary fixtures so the two validators cannot drift again.
  Rust already documents that the constant must track `MAX_INTENTS`; the mirror
  did not.
- The read-only action list is duplicated in `client.ts:62-73` and enforced
  independently in Rust. Give it one source of truth or one shared fixture.
- v1 one-shot behavior stays green here as a transitional checkpoint.

**Gates:** the existing client suite passes unchanged against the extracted
package; a maximal (256-intent) `read_operation` response round-trips in BOTH
languages; the full key-free chain stays green.

### Slice D-2 — protocol v2 sessions

Serial newline-delimited framing over persistent connections, with **two role
lanes per actor** — a work lane for change-set operations, an observation lane
for reads, events, and acks.

Serial-plus-lanes, not multiplexing. Head-of-line blocking is real
(`advance_change_set` can consume its 300s deadline while ready offers are
time-limited), but general multiplexing would add a concurrency model the server
does not have — there is no executor, only one unbounded OS thread per
connection — and could not raise semantic throughput anyway, because the
persistent Node bridge is explicitly single-flight behind one mutex
(`persistent.rs:232`). Multiplexing would enlarge queues, not increase work
done.

Constitutive requirements:
- Response-byte accounting resets at every delimiter; today the client counts
  per-connection totals (`client.ts:138`).
- Idle sessions are permitted; the 5s read timeout applies only once a partial
  frame has begun. The current blanket timeout would disconnect every thinking
  agent.
- One outstanding request per lane, bounded retained prefix. No unbounded
  pipelining.
- Admission cap on sessions/threads: ten actors imply ~twenty connections, but a
  reconnect storm must not spawn unbounded threads.
- **Versioned handshake** binds the connection to `(actor, role,
  client-instance)`. Subsequent requests omit `clientId` or are rejected on
  mismatch. The daemon detects duplicate `(actor, role)` lanes. Reconnect
  carries an explicit client-instance/session generation so a replacement lane
  supersedes a dead one without waiting out a 300s deadline (otherwise a
  duplicate-actor rejection strands the client).
- Peer uid/pid MAY be recorded for diagnostics; it is not agent identity.
- **No permanent v1 mode.** A v1 client waits for EOF and would hang against a
  persistent server, so v1 must fail fast and close rather than linger. The
  final D surface retains no route that bypasses connection-bound identity.
- The request-ID check stays GLOBAL. The 1024-entry protocol context is a
  transient validation window drained immediately after journal binding
  (`session.rs:388`); making it per-connection would weaken cross-connection
  replay checking.

**Retry contract** (transport replay and semantic redrive are different things):
- Unsent request → send normally after reconnect.
- Sent mutation, no response → replay the exact bytes with the same `requestId`
  and `idempotencyKey`, inside the original deadline.
- Read with no response → do NOT auto-replay; reissuing may observe a later
  generation. Caller-driven.
- `request_in_progress` → backoff with jitter, same identity.
- **A received retryable operational failure is NOT transport replay.** Because
  `append_effect_result` durably caches that error response against the request
  identity (`session.rs:699`), reusing the key only replays the error. A later
  `advance_change_set` must be a NEW top-level request with a NEW idempotency
  key. The transport layer must never silently convert
  `candidate_execution_failed` into a new semantic operation; it surfaces
  retryability upward, with bounded backoff and jitter so ten clients do not
  redrive in lockstep.

**Gates:** deterministic ten-client transport gates; lane isolation (an
observation-lane read completes while the work lane is mid-advance); reconnect
takeover; the retry matrix above; key-free chain green.

### Slice D-3 — lifecycle

- **Ownership by lifetime-held file lock**, keyed to the canonical
  database/state directory, acquired BEFORE `ServiceSession::open`. Ordering is
  load-bearing: today recovery and durable session construction happen before
  binding (`server.rs:41`, `session.rs:200`), so a losing second daemon must be
  excluded before any of that work, not when it eventually tries to bind. PID
  data is metadata, never authority (stale-file and PID-reuse races); a liveness
  probe without a held lock has a check/unlink/bind race.
- Startup: canonicalize state identity → acquire non-blocking owner lock → claim
  or verify endpoint ownership → if an existing socket answers a valid health
  handshake, fail as already-running → if we hold the lock and the socket is
  dead, unlink as stale → open/recover, seed-green, hydrate, bind, publish
  readiness.
- `start` / `stop` / `health`. Health is served by the lightweight session
  handshake, NOT the journalled request path — otherwise polling health
  generates durable fsync traffic.
- `stop` drains **active request handlers**, not durable change sets: stop
  accepting sessions, close idle lanes, return typed retryable
  `service_draining` for unstarted requests, give running requests a bounded
  grace period, leave drafts and queued tickets durable, then exit and let crash
  recovery reconcile. An agent sees exactly one of: a normal response,
  `service_draining`, or a disconnect followed by ordinary mutation replay.
  **Shutdown must never report a change set as cancelled unless the canonical
  lifecycle actually cancelled it.**
- The lifecycle surface retains the readiness identity the current harness
  discards: `serviceEpoch`, `recovered`, `validationMode`,
  `validationManifestDigest` (`service.ts:112` keeps only `socketPath`).

**Gates:** two daemons race for one state dir and exactly one serves; stale
socket recovered; drain semantics observable; crash/restart tests.

## Cut from item D

**Platform-binary distribution is deferred until after item E.** The daemon is
not self-contained — six mandatory path flags, a required built `worker.js`, and
`node` from `PATH` (`main.rs:85`, `:146`). Freezing those assumptions into
distribution machinery before E has shown what an embedder actually needs would
be guessing. E uses an explicit developer launcher with caller-supplied binary,
worker, and corpus paths.

## Risks to gate explicitly (surfaced by review, verified)

These are not D deliverables by default, but D must not pretend they are absent;
each needs a decision before the daemon is called long-lived.

- **Global durable-I/O serialization.** Every previously-unseen request —
  successful reads included — appends a `RequestBound` record that ends in
  `sync_data()` (`audit.rs:241-255`, `:170-182`), and successful reads then
  append to the audit log. Ten event pollers can serialize on disk before
  transport matters. Measure this before attributing latency to the socket.
- **Unbounded journal growth / restart time.** `request_bindings` is
  insert-only and rebuilt by a full journal scan at startup (`audit.rs:83`,
  `:87`). A retention/checkpoint story is required before "long-lived."
- **Single-flight semantic bridge.** All persistent-worker requests queue behind
  one mutex; B-2 already discloses that queue wait per request. Expose it; do
  not misattribute it to the transport.
- **`change_set_locks` leak.** Insert-only, no eviction (`session.rs:162`,
  `:1549`) — one map entry plus a mutex per change set, for a ten-agent build
  that creates many small ones.
- **Restarted event acks.** The delivered ceiling is in-memory only, so after a
  restart, acking events delivered before the crash fails until the client
  rereads. The client should deliberately reread and deduplicate on a
  service-epoch change.
- **Slow/partial clients.** Admission count, partial-frame bytes, per-frame
  duration, outbound bytes, and idle lifetime need separate bounds. One generic
  5s socket timeout is not a persistent-session policy.

## Hard boundaries (unchanged)

Clients never open canonical storage; workers never mutate redb; TS semantics
stay in Node; validation is never bypassed and no N=1 correctness fast path is
introduced; typed operations infer reservation scope; bounded responses
everywhere; deterministic key-free gates before any keyed spend; local Unix
socket only, no network transport or multi-host consensus; SQLite product path
stays supported; item C stays out; Strata never decomposes or assigns tasks;
recorded gate artifacts stay immutable.

## Process

Each slice gets its own implementation plan (v1 → independent methodology
review → v2) before any build, as B-1 and B-2 did. D-1's plan first.
