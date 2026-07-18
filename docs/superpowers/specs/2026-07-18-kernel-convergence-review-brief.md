# Independent review brief: converging Strata on the Rust/redb kernel

Status: review input (read-only). Written 2026-07-18 for an independent
Codex review per the repo's working-style rule. The reviewer's verdict is
input to a future operator decision — nothing here is decided.

## What Strata is (30 seconds)

An agent-native structural code substrate for TypeScript: the codebase is
a queryable node graph with stable IDs, mutated through ~20 structural
tools inside transactions, with a commit gate (in-process tsc + corpus
tests) and an operation log as canonical history. Agents have no
filesystem tools; files exist only as transient render artifacts.
Published on npm 2026-07-18 as `@strata-code/*` 0.1.0.

Two parallel storage paths exist today:

1. **SQLite path** (`packages/store`, better-sqlite3): the entire shipped
   single-agent product — all 20 tools, persistence, explore CLI,
   three-layer index (L2 is sqlite-vec). All published single-agent
   evidence was measured here.
2. **Rust/redb kernel** (`crates/strata-kernel` + `packages/kernel-bridge`):
   a sealed single-owner daemon; typed operations with graph-inferred
   reservation scopes; deterministic leases; fenced, only-green-together
   publication; fresh-decision on scope invalidation. Two operations
   bridged (`rename_symbol`, uniform-value `add_parameter`). All
   multi-agent evidence was measured here (Phase-6: N=3 directional
   round, every evaluable cell favored the kernel arm 2.5–25.6× over a
   git-worktrees-plus-integration-agent baseline).

The decision log (decisions.md 2026-07-18, "SQLite and kernel paths both
stay") declares the split **provisional** with three re-convergence
triggers. The operator leans toward an eventual converged Rust-core
product; this review is the required independent pass before that leaning
becomes a plan.

## The question under review

**Is converging on the kernel — kernel becomes the only canonical store;
SQLite demotes to derived index or is deleted; single-agent becomes the
N=1 case of the coordination lifecycle — the right end state? And if so,
what design shape avoids the known hazards?**

## Two claims to attack (the point of this review)

### Claim 1: a solo fast-path can avoid regressing single-agent economics

The kernel lifecycle is draft → submit → analyze → schedule → claim →
validate → publish. The SQLite path is open-transaction → mutate →
validate → commit. Our measured taxonomy (decisions.md 2026-05-29) says
per-operation ceremony is exactly why the substrate *loses* single-site
tasks to file tools (+21% simple extract, +108% compound). Forcing solo
sessions through coordination machinery risks quietly regressing the
published single-agent numbers (T03 rename ~3.5× fewer tokens, ~4.9×
cheaper).

The convergence bet assumes a "solo fast-path" (bypass leases/scheduling
at N=1) keeps single-agent cost parity. Attack this: is a fast-path that
skips scheduling still meaningfully "one code path," or does it fork the
semantics into two paths again — the exact thing convergence was supposed
to eliminate? Where does the latency actually come from in the bridged
operations today (IPC hops to the daemon, candidate materialization,
fresh checks)? Is cost parity at N=1 plausible or wishful?

### Claim 2: stable logical IDs are a solvable prerequisite, not a wall

Node IDs are `sha1(modulePath + ":" + childIndexPath + ":" + kind)`
(decisions.md 2026-05-15) — position-dependent by construction. The
roadmap's hard boundary: structural insert/delete/move concurrency waits
for logical IDs independent of sibling position. Any kernel port carries
this scheme or replaces it.

Attack this: is there an ID scheme that (a) survives sibling insertion /
deletion / move, (b) stays deterministic across re-ingest of unchanged
code, (c) doesn't collapse into content-addressing (which breaks the
"mutated node is the same node" invariant — a renamed function must keep
its ID), and (d) has a sane migration story for existing persisted DBs
and the operation log? Candidates we're aware of: allocation-ordered
opaque IDs with a position index kept separately; hybrid
anchor-plus-disambiguator schemes; Unison-style content hashes (rejected
on (c) — verify that rejection is actually sound). Is the prerequisite
weeks or quarters?

## Settled results — do not re-propose

- **Per-callsite expressiveness (T01)** is a verified scripting trap by
  scorer construction (decisions.md 2026-05-17 TERMINAL). No structural
  lever closes it honestly.
- **Reimplementing tsc semantics in Rust.** The TypeScript compiler stays
  the semantic oracle (ingest resolution, render, verify). A fully-Rust
  Strata is out of scope permanently; the maximal end state is a Rust
  kernel core with TypeScript workers.
- **Single-site synthesis as a cost win.** Measured negative. The
  substrate's cost edge is bulk propagation over many existing
  references; convergence must not be justified by hoping this changes.
- **Multi-language, git integration, FUSE, multi-host consensus, task
  orchestration.** Out of scope per the design doc.
- **Re-running benches to see if numbers moved.** Only new-capability
  scoring justifies keyed rounds.

## Hard constraints on any convergence design

- tsc remains the semantic authority; candidate validation is real
  render + type-check + tests.
- Clients never open canonical storage directly (kernel is sealed,
  single-owner).
- Typed operations infer reservation scope from the graph; agents never
  enumerate lock keys.
- Stable node IDs across mutations: a mutated node is the same node.
- The operation log is canonical history; every mutation carries actor +
  reasoning.
- Files are not first-class anywhere above render/verify.
- Deterministic, key-free gates must pass before any live re-validation
  spend; published numbers may not be re-quoted for a converged store
  without re-measurement.
- The SQLite path remains supported until a convergence decision is
  actually taken (decisions.md 2026-07-18).

## What we want back

1. A verdict: is kernel convergence the right end state, or is the
   provisional split actually the honest architecture (coordination as a
   layer, not a store)? Argue either way from the repo, not from taste.
2. The strongest attack you can mount on Claims 1 and 2, grounded in the
   actual code (`crates/strata-kernel`, `packages/kernel-bridge`,
   `packages/store`, `packages/agent`).
3. Sequencing risks we have not named (migration of persisted DBs and
   operation logs, npm packaging of a native daemon, L2/L3 index fate,
   crash-recovery semantics differences, anything else you find).
4. If you endorse convergence: the smallest honest first slice, and what
   measurement gates it.
5. What evidence would *falsify* "converge" as the right call — state it
   before we spend anything.

Verify any pivotal empirical claim you make against the actual code and
logs before asserting it; cite file:line. Do not propose implementations
— this is a design review, read-only.
