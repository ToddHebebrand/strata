# Iteration 6 slice A — kernel convergence first slice (design)

**Status:** designed 2026-07-18, awaiting operator review; gate-1 implementation
authorized by the Iteration 6 approval (decisions.md 2026-07-18).

**Governing frame:** the verified Codex convergence review
([`2026-07-18-kernel-convergence-review-codex.md`](2026-07-18-kernel-convergence-review-codex.md))
§4 defines the slice and its five ordered measurement gates; §5's six falsifiers
are stop conditions, not delays. The kernel design spec
([`2026-07-13-multi-agent-coordination-kernel-design.md`](2026-07-13-multi-agent-coordination-kernel-design.md))
still governs kernel semantics. This document only decides how slice A lands in
this codebase.

## What the slice is

A fresh-store, rename-only, N=1 compatibility slice in which the Rust kernel's
memory-native graph with redb is the **sole durable authority** for the graph
and operation history, with **full coordination semantics** (no solo bypass —
refuted by the review), and the **minimal real product surface for T03**:
declaration discovery, bounded inspection/reference reads, one rename, one
logical change-set lifecycle. SQLite exists only ephemerally inside the
TypeScript candidate worker.

Work proceeds gate-by-gate in the review's order. This design covers the whole
slice's architecture; the accompanying implementation plan covers **gate 1
(key-free semantic parity, including crash injection and second-client
intrusion)** in detail. Gates 2–5 get their own plans as they open.

## Where the code already is (recon, 2026-07-18)

- **Redb is already the only durable store in the kernel arm.** Every
  kernel-bridge SQLite database is `:memory:` and byte-verified on hydrate
  (`packages/kernel-bridge/src/snapshot.ts:75-101`); `live-compare` touches no
  SQLite. The slice's storage constraint is already true — slice A's job is to
  make it a *product* fact (fresh-store init, auditable history, product
  surface), not to move data.
- **Seeding is fresh-store by construction.** TS ingest →
  `toKernelSnapshot` → transient `snapshot.json` → daemon `store.seed` writes
  generation 0 into redb when `--db` does not exist
  (`packages/live-compare/src/service.ts:27-63`,
  `crates/strata-kernel/src/bin/strata_kernel_service/session.rs:62-106`,
  `kernel.rs:142-181`). If the db exists, `--snapshot` is ignored and recovery
  (snapshot + delta replay + digest verification) runs.
- **No discovery request exists.** The wire protocol has nine request types;
  lookup is strictly by caller-supplied node ID
  (`crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:100-128`,
  `session.rs:695-749`). Phase-6 agents were handed IDs in the prompt.
- **Reasoning and typed intent parameters are write-only over the wire.**
  `OperationRecord` (`crates/strata-kernel/src/model.rs:56-68`) carries actor,
  reasoning, affected IDs, renames — not the typed parameters. Params live
  durably in the `coordination_intents` table; the in-process join
  operation → change set → intents exists, but no request returns any of it.
- **Behavioral (tsc+vitest) validation is fully built and dormant.** The bridge
  protocol and `candidate.ts` support `behavioral`
  (`commitWithBehavioralGate`, `packages/kernel-bridge/src/candidate.ts:111-144`);
  no Rust constructor emits it — `NodeBridgeConfig` offers only `tsc_only` and
  the daemon hard-codes it (`main.rs:88-95`).
- **Publication is already one redb transaction** covering operation, delta,
  ticket, event, fences, resource clocks, lifecycle, attempt
  (`storage.rs:231-341`). Crash boundaries have failpoints on both layers:
  `PublishFailpoint` (4 durable boundaries, `kernel.rs:48-89`) and
  `ServiceFailpoint` (5 request-journal stages, `session.rs:31-39`).
- **The Phase-6 final-tree extraction is manifest-bound** (only rewrites
  statement IDs registered in the task manifest,
  `packages/live-compare/src/service.ts:70-94`) — it cannot serve as a
  full-graph parity oracle.
- **Hard action budgets:** `submit_change_set` requires ≥30.1 s and
  `advance_change_set` ≥60.1 s of remaining deadline (`session.rs:27-29`).
- **The SQLite control arm exists in product form:** `find_declarations`
  (`packages/store/src/queries.ts:35`) → `begin` → `rename_symbol` →
  tsc+vitest commit gate via `@strata-code/verify` → `evaluateT03Criteria`
  (`packages/verify/src/t03Criteria.ts`).

## Design decisions

### D1. Fresh-store initialization stays a two-step seed; the snapshot file is a transient artifact

Keep TS ingest as the semantic authority (per the kernel spec) and the existing
seed path: ingest → canonical snapshot JSON → daemon seeds redb generation 0 in
one transaction, then the file has no further role. Redb is the sole durable
authority from that moment. No SQLite database is created anywhere in the
kernel arm.

*Alternative rejected:* embedding ingest invocation inside the daemon. It adds
a Rust→Node orchestration path for zero semantic gain in this slice; gate 4
(clean-room) wraps the two steps in one product command instead.

*Hardening folded in:* `createQualifiedKernelSnapshot`'s generation coercion
(canonical-u64 string → JS number) is replaced with the canonical string form
end-to-end, so seeding does not pass through a lossy numeric type.

### D2. One new discovery request: `find_declarations`

Add a read-only wire request and matching tool
`find_declarations { name, kind? }` → bounded list of
`{ nodeId, kind, name, moduleId }`, capped (fail-closed) at a small result
limit, served from the in-memory declaration index against the current
generation. This is the *minimal* discovery T03 needs — the exact capability
the SQLite arm's `find_declarations` provides — not slice B's discovery
worldview (no semantic search, no module listing, no subtree reads).
`inspect_nodes` remains the bounded inspection/reference read.

*Alternative rejected:* keep handing IDs via prompt (Phase-6 style). The review
explicitly says the slice's agent surface must include declaration discovery;
prompt-fed IDs are what makes the existing evidence non-product.

### D3. The canonical operation record becomes self-contained and auditable over the wire

Extend `OperationRecord` with per-intent typed parameters:

```rust
pub struct OperationIntentRecord {
    pub kind: String,            // "rename_symbol"
    pub parameters_json: String, // canonical JSON of the typed intent params
}
// OperationRecord gains: #[serde(default)] pub intents: Vec<OperationIntentRecord>
```

written in the same single publication transaction (no second write). Add a
read-only wire request `read_operation { operation_id }` returning the full
auditable record: actor, change-set reasoning (the original task context),
per-intent kind + parameters, affected node IDs, renames, generation, digest.

Gate 1 requires "one auditable rename carrying actor, original task
context/reasoning, parameters, and affected IDs"; today parameters and
reasoning are write-only over the wire. Making the canonical record
self-contained avoids audit correctness depending on change-set/intent
retention forever, and `#[serde(default)]` keeps old records readable (fresh
store, so no migration is implied — the lossless-migration falsifier stays out
of this slice by design).

*Alternative rejected:* audit via join-only (operation → change set → intents)
exposed through a request. Works today, but couples canonical audit to
coordination-table retention and gives L3-class consumers the "different join
semantics" problem the review flagged. Parameters are tiny; embedding them at
publication is the honest canonical history.

### D4. Gate 1 runs the task-registered validation profile — tsc-only in both arms (revised after review)

**Premise correction (independent review, verified):** the shipped T03 product
gate is tsc-only *by registration* — `packages/verify/src/taskBehavioralFixtures.ts`
maps `T03: []` ("no behavioral-only failure mode; tsc + text criteria fully
constrain it", per the BG-4 decision), `vitestRun(tree, [])` short-circuits to
pass, and the bridge worker *rejects* behavioral mode with an empty fixture
list. Running a behavioral gate in either arm would therefore test a **new**
gate profile, not parity with the shipped product.

Decided: both arms run T03's registered profile. The SQLite arm uses the
existing product `commit` gate; the kernel daemon stays `tsc_only` (already the
hard-coded configuration). The gate-1 harness *additionally* runs tsc **and**
vitest externally, identically, on both arms' rendered corpora — that is a
harness equivalence check satisfying gate 1's "equivalent tsc/Vitest results",
not a commit gate, and no whole-suite autodiscovery enters any commit gate.

The behavioral-profile daemon plumbing (`NodeBridgeConfig::behavioral` +
flags) moves out of slice A back to slice B, where the general behavioral gate
belongs. Gate 5's comparability concern is resolved the same way: both arms
run the registered T03 profile, so neither does more validation work than the
product actually ships.

### D5. Canonical export is an offline subcommand, not an agent surface

Add `strata-kernel-service export-snapshot --db PATH --out PATH`: opens redb
(recovery path, digest-verified), writes the canonical sorted
`KernelSnapshotV1` JSON. The gate-1 harness uses it as the parity/crash oracle
(after daemon shutdown or restart); gate 4 uses it to prove "reopen the same
canonical database." It is deliberately not a wire request — full-graph dumps
are an operator/harness concern, not part of the coordination surface.

### D6. Gate-1 parity harness lives in `live-compare` as a key-free suite

`live-compare` already owns daemon spawn, the socket client, corpus prep, and
verification helpers. Add a key-free vitest suite (gate-1 parity) plus a root
script `kernel:gate1:test`, folded into `pnpm kernel:full-key-free:test` (the
canonical green gate per repo convention). Both arms run on `examples/medium`:

Both arms ingest the **same corpus-relative module-path inputs** (one shared
builder; node IDs hash the module path, so a mixed absolute/relative domain
would silently break "same ingest, same IDs" — review-verified against the
CLI T03 flow's absolute paths):

- **SQLite control arm (product path, scripted):** ingest → `find_declarations`
  (`User`/interface, exactly one) → `begin` → `rename_symbol` → product
  `commit` gate (T03-registered profile, tsc-only) → post-commit validate →
  render.
- **Kernel arm (product path, scripted):** seed fresh store → spawn daemon
  (tsc_only, the same registered profile) → `find_declarations` →
  `begin_change_set` → `add_intent` (rename → `Account`) →
  `submit_change_set` → `advance_change_set` → `read_operation` → shutdown
  preserving the database → `export-snapshot`.

Parity assertions, all deterministic:

1. Node records byte-equal (canonical sort) between arms' exports.
2. Reference records byte-equal.
3. Rendered corpus byte-equal per module (same `@strata-code/render` on both
   exports).
4. tsc `--noEmit` and vitest green on both rendered corpora.
5. `evaluateT03TextCriteria` pass on both.
6. Audit equivalence via a **normalized projection** (revised after review —
   the raw records are legitimately different shapes: the SQLite operations
   row stores snake_case params, semantic Identifier affected IDs, and
   `reasoning: null` with task context on the transaction; the kernel's
   `affected_node_ids` is delta-derived and intentionally broader). Both arms
   project to `{actor, taskContext, operationClass, declarationId, oldName,
   newName, renamedIdentifierIds}` and the projections must match; the
   kernel's broader affected set must contain every projected identifier and
   is documented as a superset, never asserted "equal".

*Alternative rejected:* a new leaf package — duplicates spawn/client machinery
for no isolation gain. *Alternative rejected:* Rust-only harness — the SQLite
control arm and render/tsc/vitest live in TypeScript; the comparison naturally
sits on the TS side, with Rust tests keeping their existing coverage.

### D7. Crash injection runs through the T03 product surface (choreography revised after review)

The failpoints are global per-mutating-request (`ServiceFailpoint` trips on
*every* mutation, so enabled-from-start it would abort at `begin_change_set`,
never reaching publication), and the coordinated `PublishFailpoint` path
exists only under `redb-spike-api` (`execute_claimed_with_failpoint`,
camelCase boundary names). The choreography is therefore staged: run the T03
prep (begin/add/submit) against a failpoint-free daemon, stop cleanly
preserving the redb, restart the same database with the failpoint armed, and
issue **only** `advance_change_set`. After the abort, restart clean and apply
the oracle.

The oracle is stronger than a graph export (review: graph-only old/new is too
weak — gate 1 could pass with duplicated or missing history/events/tickets):
`export-snapshot` gains a `redb-spike-api`-gated atomic-state projection
(sharing the row-8 `CanonicalFinalState` capture) covering operations, deltas,
events, tickets, change sets, idempotency records, publication attempts,
fences, resource clocks, and scheduler revisions; the crash suite asserts the
projection equals the prep-only or the completed reference state exactly, and
replays the **same** request identity (same idempotency key), asserting the
journal's cached response — a fresh T03 run with new IDs is not an idempotency
test.

### D8. Second-client intrusion at every nominal "solo" stage

At each externally observable stage of client A's T03 flow — after discovery,
after `begin_change_set`, after `add_intent`, after `submit_change_set`, and
concurrently with `advance_change_set` — a second client B performs (i) a
disjoint rename (must commit independently; the target is pre-registered in
the test, not discovered ad hoc) and (ii) an overlapping rename of the same
symbol. Expectations are **stage-specific**, because FIFO is the kernel's
contract and an "either serial order" oracle would mask fairness bugs
(review-verified: the scheduler's older-overlap rule forbids a later
overlapping B from passing a submitted A): before A submits, B may commit
first and A must get `needs_decision` with the rename transitions named;
after A submits, A must win and B gets ordered/fresh-decision behind it; in
the concurrent-advance case the required winner is derived from durable queue
order, never "either". Silent overwrite anywhere is a hard failure; actor
ownership is asserted (B cannot advance or cancel A's change set). This is
the review's "a second client introduced at every nominal solo stage must not
change correctness," and it is precisely why no solo bypass exists to test.

### D9. Deadlines and environment

The harness budgets request deadlines above the hard minimums (30.1 s submit /
60.1 s advance). Test commands run with `PATH=/opt/homebrew/bin:$PATH` (native
module ABI), and green claims for kernel work are made only via
`pnpm kernel:full-key-free:test` plus `pnpm -r test`.

## Out of scope for slice A

Legacy SQLite→redb history migration; L2/L3 index layers on kernel
generations; `add_parameter` in the product surface (the coordination protocol
keeps supporting it; the T03 tool schema exposes rename only); stable logical
IDs (slice C); the full discovery worldview and generalized behavioral gate
(slice B); typed client library, connection reuse, daemon lifecycle/packaging
(slice D — gate 4 does the minimum clean-room packaging the review demands and
no more); snapshot compaction policy (revisit if gate 2/3 measurements force
it); MCP/CLI adapters.

## Gate map and falsifier watch

- **Gate 1 (this plan):** parity + crash + intrusion suite above. Watch
  falsifier 1: if parity or the intrusion suite can only pass by weakening
  scope inference, fresh analysis, validation binding, reservations, or fenced
  publication, stop and log — "converge" is falsified, not delayed.
- **Gate 2:** per-stage observability (wall, peak memory, snapshot bytes,
  worker starts, hydration, validation, publication, replay). Instrumentation
  lands on both the daemon and the bridge; no keyed spend.
- **Gate 3:** unkeyed noninferiority — p95 mutation wall ≤1.25× SQLite, bounded
  memory, `examples/medium` + a ~1k-module corpus, no extra agent-visible
  lifecycle calls. Failure stops keyed spend. Watch falsifier 5 (fixing bridge
  costs must not violate the semantic boundary).
- **Gate 4:** clean-room packed CLI + native daemon: install, start/restart,
  discover, rename, tsc+tests, reopen the same canonical database. Watch
  falsifier 6 (a real product surface must not need the SQLite authority).
- **Gate 5:** keyed N=3 kernel-N=1 vs SQLite-N=1: both arms 3/3 green, paired
  cost ratio ≤1.10, no extra tool calls/turns, median wall ≤1.25×. Same model,
  prompt, reduced tool surface (same tool descriptions and call structure in
  both arms — pre-registered before the round), scorer, corpus, order
  balancing. **Operator approval required before any keyed spend.** No
  published T03/Phase-6 number is re-quoted for the kernel store before this
  gate passes.

## Testing strategy

TDD throughout: each protocol addition (D2, D3 read path, D5) starts with a
failing Rust test at the session/protocol layer plus a failing TS test at the
client/tool layer; the parity, crash, and intrusion suites (D6–D8) are written
against the acceptance criteria before the plumbing that satisfies them.
Existing suites must stay green unmodified except where a test encodes the old
write-only audit behavior.
