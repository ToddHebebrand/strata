# Item D — typed client + session hygiene: independent design review brief

**For the reviewer.** This is a pre-design brief, not a plan. Nothing has been
built. I want your judgment on the design fork below BEFORE I write the spec,
which is this project's standing process (the same sequence caught a
decision-grade error on item B). Read-only against the repo at branch `main`.

Every code claim below was read from source this session; file:line anchors are
given so you can check me rather than trust me. **If a pivotal claim is wrong,
say so** — I will re-verify anything you flag before it reaches the spec.

---

## 1. What Strata is, in one paragraph

Strata is an agent-native structural substrate for TypeScript. The current
research iteration is a Rust/redb **coordination kernel**: a single-owner daemon
over a Unix socket that lets multiple agent clients mutate one shared canonical
code graph — no git branches, no worktrees, no text merges. Agents submit typed
intents (`rename_symbol`, `add_parameter`); the kernel infers reservation scope
from the graph, schedules, leases, validates (tsc + vitest, as of the just-landed
B-2 behavioral gate), and publishes atomically behind a fence. Agents never open
storage and never enumerate lock keys.

The adopted **surface principle** (decisions.md 2026-07-18) is: *the coordination
protocol IS the agent surface. A thin typed client is what harnesses embed; any
MCP or CLI surface is an adapter over that client, never a parallel
implementation.*

Roadmap item D is that client, plus the session hygiene it needs. Item E — the
payoff scenario, ~10 concurrent agents building an app from scratch to a green
release — consumes this client, so E is its first real exercise.

## 2. What exists today (verified)

`packages/live-compare/src/client.ts` (426 lines) is a real, well-tested client
living inside the benchmark harness package. It is deliberately
**one-request-per-connection** (its own docblock, `client.ts:175-178`).

**Transport, exactly:**
- Framing is one JSON object plus a single trailing `\n`. No length prefix.
- The client writes the whole frame on `connect`, accumulates every `data`
  chunk, and treats the response as complete **only at EOF** (`end`/`close`),
  then checks the last byte is `0x0a` as a truncation test — there is no
  incremental delimiter scan (`client.ts:100-173`).
- The server reads until the first `\n`, handles, writes one response, drops the
  connection. No loop (`server.rs:195-215`).
- **Multiple frames on one connection is an explicit, tested protocol error** in
  both languages: `if payload.contains(&b'\n') { bail!("connection contains
  multiple frames") }` (`protocol.rs:1211-1213`, mirrored `protocol.ts:748-750`).
- Per-connection `set_read_timeout(5s)`; a timeout propagates as `Err` via `?`
  and drops the connection with **no response written** (`server.rs:196-197`).
- Thread per accepted connection (`server.rs:96-101`).
- `MAX_RESPONSE_FRAME_BYTES` (256 KiB) is counted client-side as
  **per-connection total**, not per frame (`client.ts:139-142`).

**Retry:** exactly one retry, only for mutations, only on a post-connect
`disconnect` (`client.ts:237-244`). `requestId` and `idempotencyKey` are fixed
once and reused across the retry; the daemon dedupes via a **process-global,
capacity-bounded** requestId→body-hash map plus a durable journal binding
(`session.rs:164`, `protocol.rs:568-596`, `audit.rs:170-182`).

**Identity — the part I think is worse than the roadmap says.** There are three
weakly-coupled notions:
- The `--socket-token` is validated only for length (1..=512 bytes,
  `server.rs:175-180`) and **never appears on the wire**. It only derives the
  path `/tmp/strata-lc/{sha256(token)}.sock`, mode 0600 in a 0700 dir. So
  authentication is exactly *"a local process running as the same uid."* No
  `SO_PEERCRED`/`LOCAL_PEERCRED` check exists.
- `clientId` is **self-asserted**, validated for shape only, and never bound to
  a connection, process, or uid.
- Yet `clientId` drives all per-actor authorization and becomes the operation
  log's `actor` verbatim: change-set ownership (`session.rs:1518-1528`), the
  per-client delivered-events cursor and ack ceiling (`session.rs:1531-1544`),
  the change-set ID namespace (`deterministic_change_set_id`,
  `session.rs:1724-1727`), and `actor:` on the published operation
  (`session.rs:861-866`).

So any local process that can open the socket may claim any actor: take over
another agent's change sets, drain another agent's event cursor, and forge
attribution in the canonical operation log.

**Single owner is not enforced.** `bind_private_socket` unconditionally unlinks
an existing socket before binding (`server.rs:186-188`), so a second daemon on
the same token silently steals the endpoint while the first keeps serving an
unlinked listener. There is no pidfile, no flock, no signal handling, no drain,
and no socket cleanup on exit.

**Packaging.** Nothing in the repo does platform-binary distribution. The daemon
is **not self-contained**: `serve` requires six path flags (all mandatory), needs
`--bridge-worker` pointing at a built Node script, and spawns `node` from `PATH`
(`main.rs:87`, `:146-153`). The TS harness finds the binary via a hardcoded
`target/debug/...` path and CJS `__dirname` (`service.ts:11`, `:80-81`).

**Extraction blast radius:** `live-compare` is a leaf — nothing imports it.
`client.ts` + `protocol.ts` depend only on `node:crypto`, `node:net`, and `zod`
— a genuinely clean cut. But `tools.ts` couples to
`@anthropic-ai/claude-agent-sdk@0.2.118`, and `service.ts` (daemon launcher)
should be rewritten rather than moved.

## 3. Constraints that are NOT open for redesign

Please design within these; proposing their removal is the one thing that
wastes the round.

- Clients never open canonical storage; workers never mutate redb.
- Typed operations infer reservation scope from the graph. Agents never
  enumerate lock keys.
- **No correctness bypass for the N=1 case.** Your own earlier review
  (2026-07-18) rejected a solo-publisher fast path that skipped reservations or
  fencing; that verdict stands. Transport coalescing is allowed; skipping scope
  inference, fresh-state checks, validation binding, fences, or atomic
  publication is not.
- Local Unix socket only. No network transport, no multi-host consensus.
- Deterministic, key-free gates must pass before any keyed model spend.
- Strata coordinates code activity; it never decomposes or assigns tasks.
- Item C (stable logical IDs) stays out of this item.
- The SQLite product path stays supported.
- Bounded responses everywhere; the strict-JSON, `deny_unknown_fields` /
  `.strict()` contract on both sides is load-bearing and stays.

## 4. The forks I want judged

### Fork 1 — the framing change (the pivotal one)

Connection reuse cannot be a client-side optimization: the "one frame per
connection" rule is enforced and tested on both sides. Candidates:

- **(1a) Newline-delimited streaming, serial per connection.** Server loops:
  scan for first `\n`, retain remainder as the next frame's prefix, handle,
  respond, repeat. Client keeps a leftover buffer and completes a response at the
  first `\n` instead of at EOF. Requests on one connection are strictly serial.
  *Concern:* head-of-line blocking. `advance_change_set` can legitimately run for
  minutes under the behavioral gate (its deadline ceiling is 300s), and a client
  that wants to `read_events` during that wait is stuck behind it.
- **(1b) Same framing, but multiplexed** — responses keyed by the `requestId`
  already on the wire, client keeps a pending-map, server dispatches each frame
  to the existing thread pool. Removes head-of-line blocking; costs a real
  concurrency-model change per connection and makes "disconnect" ambiguous across
  N in-flight requests.
- **(1c) Length-prefixed frames** instead of newline-delimited. Cleaner parsing,
  no delimiter scan, but changes bytes on the wire for every existing
  test/fixture and buys little given the strict single-line JSON contract.
- **(1d) Two connections per client by role** — one for long mutations, one for
  reads/events. Sidesteps head-of-line blocking without multiplexing.

**Questions.** Which of these is right, and is head-of-line blocking a real
problem for this workload or am I inventing it? If multiplexing: does the
process-global, capacity-bounded requestId dedupe map survive the higher
throughput, or does it need to become per-connection/per-actor? Is there a
reason to keep one-shot connections working (a compatibility mode), or should
the old shape simply go?

### Fork 2 — retry semantics under reuse

Today `disconnect` unambiguously means "this one request may or may not have
landed," and a single retry with the same `requestId`+`idempotencyKey` is safe
because of the durable journal binding. Under reuse (especially 1b), one
disconnect kills N in-flight requests. **Does the existing idempotency/journal
machinery still make blind retry safe for all of them, or does reuse require a
resume/replay handshake?** The B-2 slice added `release_claim_for_retry`, so an
operational failure now atomically releases and requeues a claim — does that
change your answer?

### Fork 3 — actor identity

The gap is that authentication is coarse (one filesystem capability granting all
authority to any same-uid process) while authorization is fine-grained but keyed
on an unauthenticated string. Candidates:

- **(3a) Peer credentials** — `getsockopt(LOCAL_PEERCRED)` on macOS /
  `SO_PEERCRED` on Linux, binding a connection to a uid/pid. *Concern:* every
  agent in the fleet runs as the same uid, so this authenticates the wrong axis.
- **(3b) Per-actor issued tokens** — the daemon issues or is configured with a
  token per actor; a handshake binds connection → actor; `clientId` becomes a
  claim the daemon verifies rather than accepts.
- **(3c) Handshake-bound identity without secrets** — first frame on a
  connection declares the actor; the daemon binds it for the connection's life
  and rejects mismatches, with no cryptographic claim. Stops accidental
  cross-talk and makes attribution meaningful within a cooperating fleet, but
  stops no deliberate impersonation.
- **(3d) Out of scope** — declare the threat model "cooperating fleet, same
  uid," document that attribution is advisory, and do nothing.

**Question.** What is the *right* threat model here for a research kernel whose
next milestone is 10 cooperating agents on one machine? I lean (3c) + an honest
written statement, on the grounds that (3b) invents an auth system this project
does not need yet and (3a) authenticates a dimension that does not discriminate.
Argue me out of it if that is wrong. Note the connection binding pairs naturally
with Fork 1 — identity established once per connection rather than per request
is only meaningful if connections persist.

### Fork 4 — single owner and lifecycle

`strata daemon start/stop/health` is in scope. The unconditional stale-socket
unlink must be replaced with real single-owner enforcement. Candidates: pidfile
+ flock; bind-without-unlink plus a liveness probe to distinguish stale from
live; Linux abstract namespace (unavailable on macOS, which is this repo's only
platform). **Which, and what is the correct stale-socket recovery story?** Also:
should `stop` drain in-flight change sets, and if so, what does an agent see?

### Fork 5 — slicing and sequencing

My provisional split is (D-1) framed session transport + client extraction,
(D-2) lifecycle + single-owner + identity, (D-3) packaging. **Is that the right
decomposition and order?** Specifically: is packaging premature given the daemon
is not self-contained (needs `node` on PATH plus a built `worker.js`), and
should it be cut from D entirely until item E proves what an embedder actually
needs?

## 5. What I am NOT asking

Don't re-propose: a solo/N=1 correctness bypass; content-addressed node identity;
moving to a network protocol; a second semantic path alongside coordinated
publication; or bringing item C's stable logical IDs into this item.

## 6. Deliverable

For each fork: a recommendation with the reasoning, and — where you disagree
with my lean — the specific evidence that should change my mind. Flag anything
in §2 you believe I have read wrong. If you see a risk I have not listed
(especially one that only bites at 10 concurrent clients), that is the most
valuable thing you can return.
