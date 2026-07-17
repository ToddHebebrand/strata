# Validation-circle narrowing: statement-granular coordination

**Date:** 2026-07-17
**Status:** Draft — pending independent review
**Predecessors:** `2026-07-13-multi-agent-coordination-kernel-design.md`,
`2026-07-16-phase-6-live-comparison-design.md`, decisions.md 2026-07-16
("Operator amends M") and 2026-07-17 ("X protocol-usability iteration").

## Problem

Two independent same-module operations cannot publish concurrently. The
mechanism probe (`packages/live-compare/tests/mMechanism.test.ts`) pins the
current behavior: two appended same-module functions with no shared references
submit `ready`/`queued`, and the successor returns `needs_decision` after the
first publishes — even though the operations are byte-disjoint. The
operator-amended M acceptance (decisions.md 2026-07-16) explicitly deferred
within-module concurrent publication to this iteration, whose acceptance test
is the deliberate flip of that probe: `ready`/`ready`, both publish, zero
fresh decisions, one green shared tree, both orders convergent.

## Root-cause inventory (verified against the code)

The kernel itself is not module-granular anywhere. Module granularity enters
at four coherent pinch points; all four must move together or the probe stays
pinned:

1. **Bridge validation closure** — `validationDependencies` in
   `packages/kernel-bridge/src/analyze.ts` maps seed nodes → owning modules →
   transitive module dependency closure → **every node of every selected
   module**. Those nodes become `validation_set` resource versions, so any
   sibling payload edit drifts the successor's re-analysis
   (`classify_scope_change` → `MateriallyChanged` → `needs_decision`).
2. **Validation-fact reservations** — `ScopeBuilder::add_validation_facts`
   (`crates/strata-kernel/src/bridge/provider.rs`) reserves `node:{id}` and
   `node:{parent}` for every validation node. With a module-wide validation
   set, both siblings reserve every module node → reservation overlap →
   `queued` at submit.
3. **Parent reservation + delta containment** — `reserve_node_and_parent`
   reserves `node:{module}` for every module-level statement an operation
   reads or writes, and `required_delta_authority`
   (`coordination/analyzer.rs`) demands `node:{parent}` reservation coverage
   for every upserted node. A rename splices statement payloads
   (`textSpanMutations` in `packages/store/src/transactions.ts`), so both
   siblings must reserve `node:{module}` today — overlap even without the
   validation closure.
4. **Membership hashing and clocks** — `children_resource`
   (`coordination/resources.rs`) hashes **full member records including
   payloads**, and `affected_resource_keys` bumps `children:{parent}` on any
   child upsert. Both siblings hold `children:{module}` (pushed by
   `read_node`'s parent-membership pin) in read+validation sets and in
   `claim.dependency_versions`. A sibling's statement-payload publish
   therefore (a) drifts the membership hash → `classify_scope_change` sees
   version drift with no added keys → `MateriallyChanged`, and (b) bumps the
   clock → `clocks.matches` fails at publish → invalidated. (The
   `common_resources_allow_only_membership_drift` tolerance only rescues the
   `Expanded` classification; membership drift alone with no new keys is
   `MateriallyChanged`.)

## Design

### Principle

An operation's validity depends on (a) the statement subtrees it reads and
writes, (b) the *shape* of the statement lists it renders into (sibling
insert/delete/reorder still conflicts; sibling payload edits do not), and
(c) the declarations its intent *content* will reference once executed.
Everything else is covered by reference propagation: within the current
intent vocabulary (renameSymbol, addParameter), any change that alters the
resolution of a name used by statement S rewrites S itself (rename rewrites
all referencing statements, including import statements), so statement-level
read/write conflict detection already serializes it. The module import/export
surface therefore needs **no separate pin** for the current vocabulary; that
is a documented constraint on future intents (see Boundaries).

### Change 1 — narrow `validationDependencies` (TS bridge)

`validationDependencies(db, seeds)` returns, instead of the module closure:

- For each seed node: its enclosing **module-level statement** (walk parents
  until the node whose parent is a Module) plus that statement's full
  descendant subtree.
- `validationDependencyReferenceFromNodeIds`: references whose `fromNodeId`
  lies in the pinned node set (unchanged rule, now over the narrowed set).
- Module nodes themselves are no longer included (nothing in the current
  vocabulary mutates a module record; structural ops are out of scope).

The result stays canonical (sorted, deduped). The seed lists of
`analyzeRename` and `analyzeAddParameter` are unchanged — they already
enumerate the declaration, name, references, and referencing statements.

### Change 2 — pin intent-content dependencies for `addParameter` (TS bridge)

`analyzeAddParameter` now receives the intent's `typeText` and
`defaultValue` and resolves their expression content against the graph:

- Parse each text with `ts.createSourceFile` (expression/type context), walk
  it, and collect root identifiers and the first member name of each
  namespace-member access (`UserTypes.displayUser` → root `UserTypes`,
  member `displayUser`).
- Resolve each root against the target function's module: a module-level
  declaration with that name pins that declaration; an import binding pins
  the imported declaration in the source module (for a namespace import, the
  *member* name is resolved against the source module's module-level
  declaration names).
- Every resolved declaration contributes its name identifier and enclosing
  statement subtree to the validation dependencies (validation-only — see
  Change 3; no reservations).
- Unresolved names pin nothing: the candidate build's tsc validation remains
  the fail-closed backstop, and `needs_decision` could not have named a
  symbol that never existed.

This preserves the X flow's just-shipped protocol-usability mechanism
(decisions.md 2026-07-17): in the X1-first order, X1's rename drifts the
pinned `node:{displayUser name}` version, so X2's claim re-analysis returns
`MateriallyChanged` → `needs_decision` **with `renamedSymbols`**, exactly as
qualified — instead of falling through to a wasted candidate build and a
`ValidationFailed` auto-cancel that carries no rename context.

### Change 3 — validation pins stop reserving (Rust provider)

`add_validation_facts` keeps pushing validation resources but no longer
inserts reservation keys. Reservations for everything the operation actually
reads or writes still come from the `read_node`/`read_write_node`/
`read_reference`/`read_reference_membership` paths, which are untouched — so
R (writer vs. reader of the same name identifier) and S (same declaration
node) still queue pessimistically at submit. No kernel invariant ties
validation resources to reservations (`InferredScope::validate` and
`validate_ticket_scope` verified).

### Change 4 — module parents are not reserved (Rust provider)

`reserve_node_and_parent` reserves `node:{parent}` only when the parent is
not a `Module` node. Statement-internal parents (identifier → statement) are
still reserved; they are op-local and never overlap across disjoint siblings.

### Change 5 — shape-only membership, shape-only clocks, payload-only
containment (Rust kernel)

Three rules change together so hashing, clock bumps, and containment agree
on one meaning of membership — *sibling shape*, not sibling content:

- `children_resource` hashes the ordered member tuples
  `(id, kind, child_index)` instead of full records.
- `affected_resource_keys` adds the `children:{parent}` bucket only when the
  change alters shape: node insert, node delete, or an upsert whose
  `parent_id`, `child_index`, or `kind` differs from the current record.
  Payload-only upserts bump only `node:{id}`.
- `required_delta_authority` requires parent reservation coverage only for
  shape-altering changes by the same definition. Payload-only upserts require
  `node:{id}` write authority and reservation only.

Content drift remains fully detected: every node whose payload matters to an
operation is pinned individually as a `node:{id}` resource (read, write, or
validation), and `node:{id}` clocks and versions still move on payload
changes. Structural concurrency (insert/delete/move) still conflicts on the
parent bucket exactly as before, preserving the standing hard boundary that
structural ops wait for stable logical IDs.

## Behavior changes (deliberate flips) and preservations

Flips — each is asserted in the implementation's tests:

- **mMechanism probe (the acceptance test):** `ready`/`ready`; both publish;
  zero fresh decisions; both orders converge to identical publication and
  final-tree digests; green tree.
- **M task:** restores M's *original* pre-amendment acceptance — disjoint
  same-module renames go `ready`/`ready` and both publish with no fresh
  decision. The 2026-07-16 amendment anticipated exactly this transfer. All
  M rows in the live-compare qualification and kernel acceptance suites flip
  accordingly; a decisions.md entry records the restoration.
- **X submit states:** with validation pins non-reserving, X1/X2 no longer
  overlap at submit; both submit `ready`. Outcomes per order are preserved
  (below).
- **Scope fingerprints:** every golden fingerprint/digest fixture in the
  Rust and TS shared conformance suites regenerates (validation sets and
  reservation key lists shrink; membership versions change).

Preservations — each is re-asserted, not assumed:

- **R:** R2's body-read pins reserve `node:{User name}`; R1 writes it →
  still `queued` at submit; after R1 publishes, node-version drift still
  produces exactly one fresh decision with a byte-identical resubmission.
- **S:** same-declaration overlap → still serialized, same fresh-decision
  semantics.
- **D and G:** cross-module and single-agent flows are untouched.
- **X2-first:** X2 publishes, X1's claim re-analysis picks up the new
  reference → `ScopeExpanded` → requeue → publish, as qualified.
- **X1-first:** `needs_decision` with `renamedSymbols` (via Change 2).
- **Only-green-together:** unchanged — every candidate is still built and
  tsc-validated against the current merged graph inside publish; a
  semantically conflicting concurrent pair that slips past scope analysis
  fails candidate validation closed (`ValidationFailed` + auto-cancel), it
  cannot publish red.
- **Crash recovery, sealing, lease, event-cursor suites:** no schema or
  protocol changes; wire shapes are untouched (only computed values narrow).

## Boundaries and recorded constraints

- **Future intents that change name resolution without rewriting dependent
  statements** (e.g., `add_import`, `move_declaration`, structural inserts
  that shadow) must extend validation pinning before joining the concurrent
  vocabulary. This is the narrowed circle's standing constraint and goes in
  decisions.md; the current vocabulary (renameSymbol, addParameter) is
  closed under reference propagation.
- **Structural insert/delete/move concurrency** remains out of scope
  (unchanged hard boundary); shape membership deliberately still serializes
  it.
- **No live spend.** This iteration is deterministic and key-free end to
  end. Any live X/M retry afterward needs a fresh operator approval file
  (new sourceCommit, digests), per the standing guard.

## Verification plan

1. RED first: flip `mMechanism.test.ts` to the target assertions and watch
   it fail for the current reasons (queued, needs_decision).
2. Land Changes 1–5 with unit coverage at each pinch point (bridge
   validation-dependency shape; provider reservation rules; membership hash;
   clock bump rule; containment rule), including a regression row proving a
   *structural* upsert still bumps membership, still requires parent
   coverage, and still conflicts.
3. Regenerate shared conformance fixtures (Rust + TS) — golden and rejected
   rows both.
4. Full `cargo test -p strata-kernel` (including the ignored
   node-bridge-gated rows via `pnpm kernel:full-key-free:test`), full
   live-compare suite in both orders, `pnpm -r test` at the accepted
   baseline (only the two documented stale replay-fixture failures).
5. decisions.md entry: the narrowing, the M restoration, the X submit-state
   change, the future-intent constraint; design-doc pointers amended
   (2026-07-16 spec M section and safe-status list already carry pointers —
   extend, don't rewrite history).

## Alternatives considered

- **Pin the module import/export surface** (the follow-on sketch's literal
  wording): rejected — for the current vocabulary it is redundant (reference
  propagation rewrites import statements of renamed symbols, producing
  statement-level conflicts already) and it creates false serialization: an
  unrelated same-module rename of a *different* imported symbol rewrites the
  shared import statement and would needlessly drift every sibling that
  pinned the surface.
- **Read/write-typed reservations** (readers don't conflict with readers):
  would additionally let shared-callee readers run concurrently, but it is a
  scheduler semantic change with a much larger sealed surface, and no target
  flow needs it (M is rename+rename and shares nothing). Deferred.
- **Skip Change 2 and let X1-first fail at candidate build:** rejected — it
  degrades the just-qualified X usability mechanism from a `needs_decision`
  naming the rename to an opaque `ValidationFailed` cancel, and burns a
  worker candidate build to learn what analysis already knew.
- **Shape-only membership for Module parents only:** rejected in favor of a
  uniform membership meaning; per-node resources already carry content
  versions wherever content matters, and a split rule would leave
  `children:{statement}` and `children:{module}` with different semantics to
  reason about at every call site.
