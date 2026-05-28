# Graph materialization for inserted/edited nodes — design

**Date:** 2026-05-28
**Status:** reviewed (Codex xhigh, 2026-05-28); decision recorded below. Ready for an implementation plan. The chosen approach is **R1 + scoped per-statement re-derivation** (not pure R1 — pure R1 was found insufficient for extract's call-site edge). Touches the stable-node-ID invariant in a bounded way; logged in `decisions.md` (2026-05-28 entry).
**Why this exists:** prerequisite for `extract_function` (`docs/superpowers/specs/2026-05-27-extract-function-design.md`), surfaced by Codex review on 2026-05-28. Also fixes a pre-existing gap in the shipped `create_function` and `add_import`.

## Codex review outcome (2026-05-28)

Codex (gpt-5.5, xhigh, read-only) reviewed this spec. Every pivotal claim below was verified
against the code before acceptance (per `CLAUDE.md`). Full transcript was at
`/tmp/codex-graphmat-response.log` (tmp, not committed). Findings:

1. **R1 over R2/R3 for the ID contract, but NOT pure R1 as drafted.** R1 is the only option that
   respects the position-derived ID scheme (`ids.ts:9`; `[statementIndex, identifierDFSIndex]`
   via `identifiers.ts:20,28`, mirrored by the resolver `batch.ts:185,193,218`). R2 (re-derive +
   remap everything) and R3 (re-key IDs off content) are larger and cut against the invariant
   (`CLAUDE.md:27`). **But pure R1 cannot give extract's inserted call site a reference edge**
   (see #2), so the chosen design extends R1 with a *scoped per-statement re-derivation* for
   statements whose internal identifier set/order changed.
2. **Blind spot confirmed — the call-site edge is required, not optional.** Extract splices the
   call via a text-span edit on the parent body (`extract-function-design.md:46,155`;
   `transactions.ts:83` records only payload surgery), not a new top-level node. "Helper
   findable only" is incoherent: `rename_symbol` propagates through reference edges
   (`rename.ts:61` — renames the declaration identifier **plus** every `getReferencesByTo`
   source), so without the call-site→helper edge, a later rename of the extracted helper updates
   the declaration but leaves the inserted call stale. `add_parameter` likewise discovers
   callsites from references (`addParameter.ts:155`, `callsites.ts:59`). This breaks future
   structural tools, not just observability. **Verified.**
3. **No clean position-stable ID exists for a mid-statement inserted identifier under the
   current scheme.** Re-running DFS shifts survivors after the splice point; reusing freed
   indices repurposes old IDs (corrupts op-history); fresh non-DFS IDs diverge from what the
   re-ingest resolver (`batch.ts:218`) computes. The honest consequence: any statement whose
   identifier set/order changes must have *that statement's* identifiers re-derived, and the
   resulting bounded ID churn is a deliberate, logged divergence from the strict invariant. **Verified.**
4. **EOF off-by-one bug in the additive tools (pre-existing, must fix first).** Ingest stores an
   `EndOfFileTrivia` node as the last module child at `childIndex = statements.length`
   (`ingest/index.ts:42-49`). `create_function`/`add_import` use `listChildren(moduleId).length`
   as the new statement index (`createFunction.ts:75`, `addImport.ts:64`), i.e. `N+1` for a
   module with `N` real statements + 1 EOF node — but a clean re-ingest of the rendered text
   places the appended statement at index `N` and EOF at `N+1`. The batch resolver derives `[N]`.
   So additive materialization would compute IDs that never match the stored node. **Verified
   against `ingest/index.ts:42-49`; decision-grade, fix before trusting additive materialization.**
5. **Dependency direction confirmed; one added caveat.** The resolver core + `emitIdentifiers`
   can live in `@strata/store` with no ingest cycle (ingest→store only; `store/package.json` has
   no ingest dep; store already imports `typescript`). **But `@strata/render` depends on store**
   (`render/package.json`), and `verify` imports both — so store-resident materialization must
   accept the **final rendered text as a parameter**; it must not call render (would create a
   store↔render cycle). **Verified.**
6. **Edge-deletion must be surgical, not wholesale.** References are `{from_node_id (PK),
   to_node_id, kind}` (`schema.ts:43-49`); `insertReferences` is a plain INSERT, not upsert
   (`references.ts:11`). Deleting by "any edge whose from/to is in the deleted-or-re-derived
   identifier set" is complete for the schema, but the spec's original "replace the dirty
   module's outgoing edges wholesale" is **wrong** — under R1 the surviving (not re-derived)
   identifiers keep their edges, and wholesale deletion would drop valid references. Delete
   (and re-insert) only for identifiers actually re-derived or deleted; delete-before-insert to
   avoid PK conflicts. **Verified.**
7. **Commit-path hazards (all confirmed, plus additions).** `materializeStatementPayloads`
   clears `overlay.textSpanMutations` (`validate.ts:285`) — snapshot the dirty/removal plan
   before it runs. The no-op gate is "no inserted nodes AND no identifier-set-changing structural
   edit," not "dirty set empty" (pure rename only queues identifier text updates, `rename.ts:67`,
   and must skip the program build). **`commit()` returns before materializing on diagnostics
   (`validate.ts:101`) and rollback only deletes `overlay.insertedNodeIds` (`transactions.ts:107`)
   — so any Identifier rows / references materialization writes must be inside one DB transaction
   with the rest of the commit, or be tracked for rollback.** The resolver must use the same
   tsconfig-derived compiler options as `validate()` (`validate.ts:392`), not `batch.ts`'s
   hardcoded options (`batch.ts:133`). **Verified.**

## Problem

Strata's batch ingest (`packages/ingest/src/batch.ts`) builds the full graph in one pass: it parses every module, emits Identifier children for every statement (`emitIdentifiers`), then builds a TypeChecker over an in-memory program of the whole corpus and resolves every identifier → symbol → declaration into a `Reference` edge.

But the **incremental** mutation path does none of this for newly-inserted structure. `create_function` (`createFunction.ts:91-99`) inserts only the FunctionDeclaration node — no Identifier children, no reference edges. Consequences (verified):

- A created/extracted function is **invisible to `find_declarations({name})`** — `resolveDeclarationNameIdentifier` queries for Identifier children and finds none.
- It's invisible to `list_module_exports` (same name-resolution path).
- `get_references` against it returns nothing, and references **from** its body to other symbols are untracked.

The renderer still emits the payload text, so `tsc` passes — which is why the `create_function` dogfood looked clean. The text is right; the **graph** is stale.

`extract_function` cannot be built on this: its helper must be findable, and the call site it inserts must produce a real edge into the helper.

## Goal

A commit-time pass that brings the node graph back into agreement with the rendered text for the modules a transaction changed — emitting Identifier children and reference edges for inserted/edited structure, the same graph facts batch ingest produces. Scoped to the transaction's **dirty set** (not the whole corpus), so it scales to large corpora.

## Scope decision (made 2026-05-28)

**Dirty-module re-resolution** (not full-corpus, not identifiers-only). When a transaction changes a module's structure, re-derive that module's graph facts by building a TypeChecker program over the dirty modules plus the modules they import, and re-resolving. Rationale: correct for the common case (extract's helper + call site live in one module), scales because it doesn't re-resolve the world per commit, and cross-module incoming references only change when the referencing module's text changes — which puts that module in the dirty set anyway.

## The dirty set

A module is dirty in a transaction if any of these touched it:
- An inserted node (`trackInsertedNode`) whose module is M.
- A queued text-span edit (`queueTextSpanEdit`) or identifier update (`queueIdentifierUpdate`) targeting a node in M.
- A deleted node in M.

The transaction overlay (`packages/store/src/transactions.ts`) already tracks inserted node IDs and queued edits; the materialization pass maps each to its owning module via `modulePathOf` / parent walk.

## Where it runs

Inside the commit path, after the structural edits are applied to produce the post-edit module text, before the operation log finalizes. Concretely: `commit()` / `commitWithBehavioralGate()` already render the dirty modules to validate them; the materialization pass consumes the same rendered text, so the program is built once.

Sequence within commit (ordering matters — see Codex #7):
1. **Snapshot the materialization plan** (dirty modules, inserted nodes, re-derived statement IDs,
   deleted IDs) from the overlay — *before* step 3 clears `overlay.textSpanMutations`.
2. Validate (tsc) against the rendered dirty modules — unchanged. If it fails, return early; no
   graph write, no payload materialization (matches today's `commit()` at `validate.ts:101`).
3. Apply queued payload edits to the nodes table (`materializeStatementPayloads`).
4. **[new]** Materialize the graph *surgically* per the plan (not wholesale): emit identifiers for
   inserted nodes (class-1), re-derive changed statements' identifiers (class-2), and refresh only
   the affected edges (delete-before-insert). See "What gets recomputed" + "Reference-edge
   recomputation" below.
5. Append the operation log and finalize.

Steps 3–5 (and the early-return safety of step 2) must run inside **one DB transaction**, so a
failure in step 4 rolls back the inserted nodes *and* any materialized Identifier rows/edges —
today's `rollback` only deletes `overlay.insertedNodeIds` (`transactions.ts:107`), which is not
enough on its own.

## What gets recomputed, and the node-ID-stability question

This was the primary risk; the Codex review resolved it (see "Codex review outcome" #1–#3). The
background and the decided resolution follow.

Strata derives identifier node IDs from **position**: `nodeId(modulePath, [statementIndex, identifierDFSIndex], "Identifier")` (`packages/ingest/src/identifiers.ts`, `ids.ts`). The "stable node IDs across mutations" invariant (`CLAUDE.md`) says a mutated expression is the same node with new state, not a new node — the operation-log and reference story depends on it.

The existing in-place mutations (`rename_symbol`, `add_parameter`) honor this by editing identifier **payloads** (text/offset) without re-deriving IDs — the node keeps its ID, only its state changes. Reference edges are keyed by node ID and are text-agnostic, so they survive a rename untouched.

But structural change is different:

- **Inserted top-level declaration** (create_function, extract's helper): it's a new statement at a new `statementIndex`, so its Identifier children get fresh, non-colliding IDs. **No churn** — clean case.
- **A module whose existing statement's internal identifiers changed** (extract removes statements from a parent body; the body is one text payload): re-emitting that statement's Identifier children by DFS order would change their derived IDs (different identifier set/order) — **ID churn** for identifiers that other modules may reference. This collides with the invariant.

Candidate resolutions (Codex-reviewed; decision below):

- **(R1) Materialize only purely-additive structure.** Recompute graph facts only for
  newly-inserted top-level nodes (helpers, imports) where IDs are fresh by construction. Leave
  edited-in-place statements' internal identifiers untouched. **Rejected as the whole answer:**
  cannot give extract's inserted call site a reference edge (Codex finding #2/#3), because the
  call lives inside an edited-in-place statement.
- **(R2) Allow scoped re-derivation + an ID-remap table.** Re-derive the dirty module's
  identifiers, and when IDs shift, rewrite reference edges + operation-log affected-ID lists via
  a remap. Most general; biggest blast radius.
- **(R3) Stable identifier IDs not by position.** Re-key identifier node IDs off something
  position-independent (e.g. content + a per-declaration counter). Largest change; touches
  ingest and every ID consumer. Out of scope for a prerequisite.

### Decision (2026-05-28): R1 + scoped per-statement re-derivation

Adopt **R1 for additive structure, plus a bounded R2 scoped to a single statement** for
edited-in-place statements whose internal identifier set/order changed. This is the smallest
design that (a) fixes the shipped `create_function`/`add_import` invisibility cleanly and (b)
gives extract's call site a real edge.

The scoping property that keeps the divergence bounded: identifier IDs are
`[statementIndex, identifierDFSIndex]`, and structural edits change only a statement's
**internal** identifiers. Top-level `statementIndex` values stay stable — extract removes
*body* statements (inside one top-level FunctionDeclaration), not top-level statements;
`create_function`/`add_import` append at the end. So re-deriving one changed statement's
identifiers does **not** perturb any other statement's identifier IDs. Churn is contained to the
identifiers *inside the one statement that structurally changed.*

Three classes, three behaviors:

1. **Additive top-level node** (create_function helper, add_import): emit its Identifier
   children with fresh, re-ingest-consistent IDs. **Requires the EOF off-by-one fix first**
   (Codex #4): the inserted node's `statementIndex` must equal what a clean re-ingest computes
   (`N`, not `N+1`), or the emitted identifiers' parent IDs won't match.
2. **Edited-in-place statement with a changed identifier set/order** (extract's parent body
   splice): **re-derive that statement's identifiers entirely** (DFS over its final rendered
   text). Delete the statement's old Identifier rows + their outgoing edges, insert the re-derived
   rows, recompute their edges via the resolver. Removed-span identifiers vanish (not re-emitted);
   the inserted call-site identifier gets a normal DFS-derived ID that the cross-module resolver
   will also compute, so incoming edges resolve. **This is the deliberate, bounded invariant
   divergence** — the changed statement's body-internal identifier IDs are not stable across this
   edit.
   - **`add_parameter` IS included in class-2 (deferral reversed during implementation,
     2026-05-28 — see decisions.md).** The class-2 trigger is "statement has a queued
     `textSpanMutation`," and `add_parameter` queues text-span edits on the signature + each
     callsite, so those statements are re-derived at commit. Originally this spec deferred
     `add_parameter` to limit blast radius, but (a) there is no clean discriminator between
     `add_parameter`'s and extract's text-span edits, and (b) `extract_function` does not exist
     yet, so deferring would leave class-2 dead/untested. Routing `add_parameter` through class-2
     gives the path a real shipping consumer now AND closes `add_parameter`'s own staleness gap.
     Verified by `packages/verify/tests/materializeCommit.test.ts` ("add_parameter graph is
     consistent after commit"): findable, stable decl id, live callsite edge, no dangling edges,
     updated signature.
3. **In-place payload edit that preserves identifier set/order** (`rename_symbol`): unchanged —
   keep the existing payload-edit model (`materializeStatementPayloads`), no re-derivation, no
   program build. IDs stable, edges survive (text-agnostic).

**Op-log / invariant cost (logged):** when class-2 re-derivation churns a body-internal
identifier ID, historical `operations.affected_node_ids_json` entries that named the old ID
become point-in-time pointers. v1 stance (consistent with extract's "offsets are point-in-time"
note): **reference edges are always made consistent** (resolver recomputes them — this is what
`get_references`/`rename`/`add_parameter` depend on), but op-log `affected_node_ids` for
re-derived body-internal identifiers are *not* retroactively remapped in v1. The op-log's
**operation sequence and reasoning remain canonical history**; only the affected-ID *pointers*
to churned body-internal identifiers go stale, and op-log replay is not a v1 use case. If a
remap proves necessary later, build old→new maps per re-derived statement and rewrite the JSON;
deferred until a replay use case exists. This boundary is recorded in `decisions.md`.

## Reference-edge recomputation

Reusing `batch.ts`'s resolver, scoped: build a `ts.Program` over (dirty modules ∪ their imports),
get a TypeChecker, and for each identifier in each **dirty** module, resolve symbol →
declaration → `toNodeId` and emit a `Reference`.

**Do NOT replace the dirty module's outgoing edges wholesale** (Codex #6). Under this design,
surviving identifiers in class-3 (rename) statements are intentionally not re-derived and must
keep their existing edges. Delete + recompute edges **only for the identifiers actually
materialized this commit**: the additive node's new identifiers, and the re-derived statement's
old→new identifier set. Concretely:

- For each re-derived/deleted identifier, `DELETE FROM node_references WHERE from_node_id = ? OR
  to_node_id = ?` (edges are keyed solely by from/to node IDs — `schema.ts:43-49` — so this is
  complete).
- Then resolve and `insertReferences` for the newly-materialized identifiers. `insertReferences`
  is a plain INSERT with `from_node_id` as PK (`references.ts:11`), so the delete-before-insert
  ordering above is mandatory to avoid PK conflicts on any re-derived `from_node_id`.

Incoming edges from clean modules are stable (their text didn't change) **unless** a target
identifier's ID changed. Class-2 re-derivation can change a body-internal identifier's ID, but
body-internal identifiers are reference *sources* (locals/uses), not *targets* importable from
other modules — top-level declarations (stable, separate nodes) are the cross-module targets.
Any incoming edge to a re-derived identifier would originate within the same (dirty) module and
is handled by that module's own recomputation.

The resolver code in `batch.ts` is currently private to ingest. The prerequisite extracts the
reusable core (program build + identifier→reference resolution) into a shared unit **living in
`@strata/store`** (no ingest cycle — Codex #5), callable from both batch ingest and the
incremental commit path, parameterized by "which modules to resolve." The unit takes the **final
rendered module text as input** — it must not call `@strata/render` (store↔render cycle). It must
use the **same tsconfig-derived compiler options** the commit gate's `validate()` uses
(`validate.ts:392`), not `batch.ts`'s hardcoded options (Codex #7), so resolution matches what
tsc accepted.

## Proposed file structure

```
packages/store/src/resolveReferences.ts     (new) — the reusable resolver core, moved here from
                                            batch.ts. Needs only nodeId + typescript + final
                                            rendered text (no render, no ingest cycle).
                                            export resolveReferencesForModules(renderedByPath, options, dirtyModulePaths)
packages/store/src/emitIdentifiers.ts        (new, or move from ingest/identifiers.ts) — shared
                                            identifier-emission DFS, since both ingest and
                                            materialization need identical indexing.
packages/ingest/src/batch.ts                (modify) — import the resolver + emitIdentifiers from store
packages/ingest/src/identifiers.ts           (modify/remove) — re-export from store, or delete if moved
packages/store/src/createFunction.ts         (modify) — FIX the EOF off-by-one: append at the
                                            EOF node's index (statement index N), bump EOF to N+1
packages/store/src/addImport.ts               (modify) — same EOF off-by-one fix
packages/store/src/materializeGraph.ts        (new) — incremental commit-time pass:
  ├ planMaterialization(db, overlay) → { dirtyModulePaths, insertedNodeIds, reDerivedStatementIds }
  │     (SNAPSHOT before materializeStatementPayloads clears overlay.textSpanMutations;
  │      removed-span identifier deletion is handled inside reDeriveChangedStatements, not a plan field)
  ├ isNoop(plan) → true when no inserted nodes AND no identifier-set-changing edit (skip program build)
  ├ emitIdentifiersForInserted(db, tx, plan)     (class-1: additive nodes)
  ├ reDeriveChangedStatements(db, tx, plan)       (class-2: delete old ids+edges, re-emit from final text)
  └ refreshReferenceEdges(db, plan, renderedByPath, options) (resolver; delete-before-insert)
packages/verify/src/validate.ts              (modify) — invoke materializeGraph inside the SAME
                                            DB transaction as commitWithoutValidate, after
                                            payload materialization, only when validation passed
packages/store/tests/materializeGraph.test.ts (new)
```

Resolver placement is settled (Codex #5): it lives in `@strata/store`. Ingest→store already
holds; store has no ingest dep and already imports `typescript`. The resolver takes rendered text
as a parameter so it never imports `@strata/render` (which depends on store).

## Testing

Codex's minimal falsifier set (the highest-value tests — each would expose a specific way the
design is wrong if it is):

1. **EOF off-by-one guard.** `create_function` after ingesting a one-statement module: assert the
   new node's ID/childIndex equals the statement index a clean re-ingest of the rendered text
   would produce (`[N]`, not `[N+1]`). Exposes the EOF bug (Codex #4). Write this FIRST — the
   additive path is built on it.
2. **Extract-shaped tx (the headline).** Create a helper node; text-span-replace a parent body
   span with `helper(a);`; commit; then assert `find_declarations("helper")` works AND
   `get_references(helper)` returns the inserted call-site identifier.
3. **Edge is not cosmetic.** Same as #2, then `rename_symbol(helper, "renamedHelper")`: the
   rendered parent call site must change to `renamedHelper(a)`. Proves the call-site→helper edge
   is real and load-bearing.
4. **Containment + no-dangling-edge guard.** A module has the edited statement plus at least one
   *other* top-level statement (with identifiers) and an importing module. After materialization,
   assert: (a) the **other top-level statements'** identifier IDs are unchanged (containment — the
   churn must not leak past the one structurally-changed statement); (b) removed-span identifier
   IDs are absent; (c) **no `node_references` row points to a missing node** (the dangling-edge
   check — the real correctness assertion). Note deliberately *not* asserted: that body-internal
   identifiers *within* the re-derived statement keep their IDs — under class-2 they change by
   design, and Codex's original "after-span IDs unchanged" phrasing would contradict the decision.
5. **No-op cost guard.** A pure `rename_symbol` tx must NOT enter the materialization TypeChecker
   path and must leave `node_references` unchanged (class-3, Codex #7 no-op gate).
6. **Build/dependency guard.** Resolver exported from `@strata/store`; ingest imports it; `store`
   still has no `@strata/ingest` and no `@strata/render` import (Codex #5).

Plus the original coverage:
- `add_import` then the imported name is resolvable as a reference target (class-1 for imports).
- Dirty-set computation: a tx touching module A but not B re-resolves only A.
- Cross-module: helper in A whose body references an imported symbol from B → outgoing edge to
  B's declaration exists.
- Large-corpus sanity: materialization over a 1-dirty-module tx on the valibot store does not
  build a program over all 1087 modules (assert the program input set is bounded to dirty ∪ imports).
- Rollback: failed validation leaves the graph facts unchanged — **specifically** that any
  Identifier rows / references the pass would write are not persisted (Codex #7: this only holds
  if materialization shares the commit's DB transaction; test it).

## Risks (post-review, residual)

1. **Bounded invariant divergence (primary).** Class-2 re-derivation churns the changed
   statement's body-internal identifier IDs. Mitigation: scoped to one statement; reference edges
   always recomputed; op-log affected-ID staleness accepted in v1 (no replay use case) and
   logged. The thing to watch: a future replay/audit feature would need the deferred old→new remap.
2. **EOF off-by-one fix must land first** and not break existing `create_function`/`add_import`
   tests or T03. It changes where the appended statement sits relative to EOF; verify rendered
   output is unchanged (function still appears at file end) while the derived ID moves `N+1`→`N`.
3. **Program-build cost** — building a TypeChecker over dirty ∪ imports per *structural* commit is
   heavier than today's no-op. The no-op gate keeps rename-class (T03) commits off this path
   entirely; confirm rename commit latency is unchanged.
4. **Rollback safety** — materialized Identifier rows + references must be inside the commit's DB
   transaction (or tracked), since `rollback` only deletes `overlay.insertedNodeIds` today
   (`transactions.ts:107`) and `commit()` returns before materializing on diagnostics
   (`validate.ts:101`).
5. **`add_parameter` is included (deferral reversed) and verified.** `add_parameter` flows
   through class-2 (see Decision class-2 note). Its graph is now materialized consistently at
   commit — verified by a dedicated test. Resolved, not a residual risk.
6. **Compiler-options parity** — resolver must use `validate()`'s tsconfig-derived options
   (`validate.ts:392`), not `batch.ts`'s hardcoded ones, or resolution can disagree with what tsc
   accepted at the gate.

## Process gate — SATISFIED

Codex (gpt-5.5, xhigh, read-only, repo-grounded) reviewed this spec on 2026-05-28. Outcome and
verified findings are recorded in the "Codex review outcome" section at the top; the decision
(R1 + scoped per-statement re-derivation) and its bounded invariant divergence are logged in
`decisions.md` (2026-05-28). **Ready for `writing-plans` → implementation.**

## Out of scope

- Re-keying node IDs off content (R3) — too large for a prerequisite.
- extract_function itself — this unblocks it; it's specified separately.
- Full-corpus re-resolution — rejected in favor of dirty-module scoping.
- Op-log old→new ID remap for churned body-internal identifiers — deferred until a replay/audit
  use case exists (see "Op-log / invariant cost").
- Incremental re-ingest on external file change (watch mode) — not a Strata goal (`strata-design.md` scope).
