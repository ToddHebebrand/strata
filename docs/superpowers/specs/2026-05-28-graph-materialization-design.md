# Graph materialization for inserted/edited nodes — design

**Date:** 2026-05-28
**Status:** draft; pending its own Codex xhigh review before an implementation plan is written (the node-ID-stability question below touches a core invariant)
**Why this exists:** prerequisite for `extract_function` (`docs/superpowers/specs/2026-05-27-extract-function-design.md`), surfaced by Codex review on 2026-05-28. Also fixes a pre-existing gap in the shipped `create_function` and `add_import`.

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

Sequence within commit:
1. Apply queued edits + inserted nodes to produce post-edit rendered text for dirty modules (already happens for validation).
2. **[new]** For each dirty module, re-emit Identifier children and recompute reference edges (see below).
3. Validate (tsc) — unchanged.
4. Persist if validation passes — now including the refreshed graph facts.

If validation fails, the whole transaction (including the materialization) rolls back — no partial graph update.

## What gets recomputed, and the node-ID-stability question (PRIMARY RISK)

This is the part the prerequisite's own Codex review must resolve. Stated plainly so the review can attack it.

Strata derives identifier node IDs from **position**: `nodeId(modulePath, [statementIndex, identifierDFSIndex], "Identifier")` (`packages/ingest/src/identifiers.ts`, `ids.ts`). The "stable node IDs across mutations" invariant (`CLAUDE.md`) says a mutated expression is the same node with new state, not a new node — the operation-log and reference story depends on it.

The existing in-place mutations (`rename_symbol`, `add_parameter`) honor this by editing identifier **payloads** (text/offset) without re-deriving IDs — the node keeps its ID, only its state changes. Reference edges are keyed by node ID and are text-agnostic, so they survive a rename untouched.

But structural change is different:

- **Inserted top-level declaration** (create_function, extract's helper): it's a new statement at a new `statementIndex`, so its Identifier children get fresh, non-colliding IDs. **No churn** — clean case.
- **A module whose existing statement's internal identifiers changed** (extract removes statements from a parent body; the body is one text payload): re-emitting that statement's Identifier children by DFS order would change their derived IDs (different identifier set/order) — **ID churn** for identifiers that other modules may reference. This collides with the invariant.

Candidate resolutions (for the Codex review to adjudicate):

- **(R1) Materialize only purely-additive structure.** The prerequisite recomputes graph facts only for newly-inserted nodes (helpers, imports) where IDs are fresh by construction. For edited-in-place statements, keep the existing in-place-payload-edit model and accept that the parent body's *internal* identifier nodes are not re-derived. Extract would then need to express the parent-body splice as in-place payload edits (the call expression replaces the span text) — the removed statements' identifiers simply cease to exist, and we delete those identifier nodes + any edges to them. This keeps churn to "deletion of removed identifiers + creation of the helper's identifiers," no re-derivation of surviving identifiers. Cleanest fit with the invariant; needs a careful "delete identifier nodes whose offset falls in the removed span" step.
- **(R2) Allow scoped re-derivation + an ID-remap table.** Re-derive the dirty module's identifiers, and when IDs shift, rewrite reference edges + operation-log affected-ID lists via a remap. Most general; biggest blast radius; arguably violates the invariant's spirit.
- **(R3) Stable identifier IDs not by position.** Re-key identifier node IDs off something position-independent (e.g. content + a per-declaration counter). Largest change; touches ingest and every ID consumer. Out of scope for a prerequisite.

The spec's tentative lean is **R1** — it's the smallest change that preserves the invariant and is sufficient for extract_function (whose only edited-in-place module is the parent, and whose removed-span identifiers genuinely should disappear). The Codex review should confirm R1 is sufficient and that "delete identifier nodes in the removed span + delete edges to/from them" is complete.

## Reference-edge recomputation

Reusing `batch.ts`'s resolver, scoped: build a `ts.Program` over (dirty modules ∪ their imports), get a TypeChecker, and for each identifier in each **dirty** module, resolve symbol → declaration → `toNodeId` and emit a `Reference`. Replace the dirty modules' outgoing edges (edges whose `fromNodeId` is in a dirty module) wholesale. Incoming edges from clean modules are stable (their text didn't change) **unless** a target identifier's ID changed — which R1 avoids for surviving identifiers and handles by deletion for removed ones.

The resolver code in `batch.ts` is currently private to ingest. The prerequisite extracts the reusable core (program build + identifier→reference resolution) into a shared unit callable from both batch ingest and the incremental commit path, parameterized by "which modules to resolve."

## Proposed file structure

```
packages/ingest/src/resolveReferences.ts   (new) — extract the resolver core from batch.ts;
                                            export resolveReferencesForModules(programInputs, dirtyModulePaths)
packages/ingest/src/batch.ts                (modify) — call the shared resolver
packages/store/src/materializeGraph.ts      (new) — incremental commit-time pass:
  ├ computeDirtySet(db, tx) → modulePaths
  ├ emitIdentifiersForInserted(db, tx, dirtyModules)  (R1: additive only)
  ├ deleteRemovedSpanIdentifiers(db, tx, dirtyModules) (R1: removed-span cleanup)
  └ refreshReferenceEdges(db, tx, dirtyModules)       (calls the shared resolver)
packages/verify/src/validate.ts             (modify) — invoke materializeGraph in the commit path
packages/store/tests/materializeGraph.test.ts (new)
```

Exact placement of the resolver (ingest vs a shared package) is a dependency-direction question — `@strata/store` must not depend on `@strata/ingest` if that creates a cycle. The Codex review should check the dependency graph; the resolver may need to live in `@strata/store` or a new leaf package.

## Testing

- create_function then find_declarations({name}) finds the new function (the headline fix; fails today).
- create_function then get_references sees a reference from a caller added in the same/another tx.
- add_import then the imported name is resolvable as a reference target.
- Dirty-set computation: a tx touching module A but not B re-resolves only A.
- Cross-module: helper in A whose body references an imported symbol from B → outgoing edge to B's declaration exists.
- Invariant guard (R1): a rename in module A does NOT churn unrelated identifier IDs (existing behavior must survive).
- Large-corpus sanity: materialization over a 1-dirty-module tx on the valibot store does not re-resolve all 1087 modules (assert the program input set is bounded).
- Rollback: failed validation leaves the graph facts unchanged.

## Risks

1. **Node-ID stability (primary)** — see above; R1 is the tentative answer, Codex must confirm.
2. **Dependency direction** — the shared resolver's package home must not create a `store → ingest` cycle.
3. **Program-build cost** — building a TypeChecker over dirty + imports per commit is heavier than today's no-op. For small dirty sets it's cheap; confirm it doesn't regress the rename-class commit latency that the T03 win depends on.
4. **Incoming-edge correctness under R1** — deleting removed-span identifiers must also delete edges *into* them; a dangling edge to a deleted node would corrupt get_references.
5. **`add_import` shape** — imports create binding names too; confirm the materialization handles import specifiers, not just function declarations.

## Process gate

Per `CLAUDE.md`, and because the node-ID-stability question touches a core invariant: **this spec goes to Codex (gpt-5.5, xhigh, read-only) before its implementation plan is written.** The review must adjudicate R1 vs R2 vs R3, confirm the dirty-set + removed-span-identifier-deletion approach is complete, check the dependency direction for the shared resolver, and propose the cheapest falsifiers. Verify Codex's pivotal claims against the code before accepting.

## Out of scope

- Re-keying node IDs off content (R3) — too large for a prerequisite.
- extract_function itself — this unblocks it; it's specified separately.
- Full-corpus re-resolution — rejected in favor of dirty-module scoping.
- Incremental re-ingest on external file change (watch mode) — not a Strata goal (`strata-design.md` scope).
