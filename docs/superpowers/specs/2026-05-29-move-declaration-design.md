# move_declaration — design spec

**Date:** 2026-05-29
**Status:** Approved (brainstormed 2026-05-29)
**Why this tool:** The 2026-05-29 extract_function dogfood established that the substrate's *cost* win is specific to **bulk graph-traceable propagation over many existing references** (T03 rename-class), not new-code/few-caller ops. `move_declaration` is that class: moving an exported declaration to another module rewrites every importer's import path — N importer edits, all graph-driven. It is the strongest remaining lever to give the architectural write-up a second, different-shaped bulk win.

## Goal

Move an exported top-level declaration from its source module to a target module, and rewrite every importer so the codebase still type-checks — in one transaction. The agent names the declaration and the target module; the tool finds all importers via the reference graph and rewrites their import paths (the bulk-propagation win), reproducing what a clean re-ingest of the moved code would produce, with `validate` (tsc) as the backstop.

## Non-goals (v1 — rejected with a specific reason, not silently mishandled)

- **Non-self-contained declarations.** If the moved declaration references a symbol declared in, or imported into, the source module (anything beyond globals/builtins, its own internals, or symbols already declared in the target module), reject. v1 does not relocate or back-import the declaration's dependencies.
- **Non-named importers.** Namespace imports (`import * as A from "./src"` + `A.X` access), default imports, re-export statements (`export { X } from "./src"`), and dynamic `import()` of the source — reject with a reason.
- **Non-exported declarations** (can't have cross-module importers) — reject.
- **Moving multiple declarations at once**, moving into a non-existent/new module, and barrel/index re-export maintenance — out of scope.

Each rejection returns a specific, actionable message so the agent can fall back to manual edits or a different approach.

## Surface

### Agent-facing tool (single call)

```
move_declaration(tx, declaration_id, target_module_id)
```

- `tx` — open transaction handle.
- `declaration_id` — node ID of the exported top-level declaration to move (function / class / interface / type alias / const — the `find_declarations` kinds).
- `target_module_id` — node ID of the destination Module.

Returns a manifest:

```ts
interface MoveDeclarationManifest {
  /** New (target-derived) node ID of the moved declaration. */
  newDeclarationId: string;
  name: string;
  sourceModulePath: string;
  targetModulePath: string;
  /** Importer modules whose import of the symbol was rewritten. */
  importersRewritten: {
    modulePath: string;
    style: "path-rewrite" | "split-out";
    before: string; // the import statement before
    after: string; //  the import statement (or statements) after
  }[];
  /** True if a back-import was added to the source module (source still uses X). */
  sourceBackImportAdded: boolean;
}
```

## Components

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/store/src/moveAnalysis.ts` | new | **Pure** analysis over a `ts.Program` built from caller-supplied rendered text: `analyzeMove(...)` → `MovePlan \| MoveRejection`. Verifies the declaration is exported + self-contained; classifies each importer (sole/mixed named import → handled; namespace/default/re-export/dynamic → rejection); computes each importer's rewritten import text (style-preserving relative path); detects source self-use. No DB writes. |
| `packages/store/src/moveDeclaration.ts` | new | `move_declaration(db, tx, declId, targetModuleId, renderedByPath, options)`. Runs the analysis, then applies the mutation through existing store primitives (recreate-in-target, delete-from-source, importer text-span edits, optional back-import, op log). |
| `packages/store/src/index.ts` | modify | Barrel-export `move_declaration`, `analyzeMove`, and the plan/rejection/manifest types. |
| `packages/agent/src/tools.ts` | modify | Surface the `move_declaration` tool (handler builds `renderedByPath`/`options` via `buildAnalysisContext`, then calls the store fn). |
| `packages/agent/src/prompt.ts` | modify | Tool description (agent worldview): what it does, that importers are rewritten automatically, what it rejects and why. |
| op-log | — | New `pendingOp` kind `"MoveDeclaration"`. |
| materialization | none | recreate-in-target = class-1; importer import-statement edits + source back-import = class-2/class-1; edges recompute over the dirty set. Reuses the proven commit pass. |

Store stays render-free: `moveAnalysis.ts`/`moveDeclaration.ts` import only `typescript` + store-internal modules. Rendered text comes from the caller (`buildAnalysisContext` in `@strata/verify`), mirroring `extract_function`/`resolveReferencesForModules`.

## The move mechanism (inherent ID churn)

A move is **delete-from-source + recreate-in-target**:

1. Read the source declaration node + its payload (the full declaration text, including its `export` modifier).
2. **Recreate in target:** append the declaration's payload to the target module via the same insert path `create_function` uses (EOF-shift fix, `trackInsertedNode`), but generalized to any declaration kind (a shared `appendDeclarationNode(db, tx, moduleId, kind, payload)` helper, extracted from `createFunction.ts`). The new node's ID is `nodeId(targetModulePath, [targetChildIndex], kind)` — **target-derived, hence new**. Its identifiers materialize as class-1 at commit.
3. **Delete from source:** delete the source declaration node + its Identifier children (tracked via `trackDeletedNodeForRestore` for rollback) and the reference edges whose endpoints are those identifiers.
4. **Edge re-pointing happens via materialization, not by hand.** The importer modules and the source module become dirty (their import statements / back-import change), so the commit-time `refreshReferenceEdges` recomputes their edges over the bounded dirty set and re-resolves every use of the symbol to the *new* target declaration. The integration test asserts re-ingest equivalence to prove this.

**ID churn is logged** (decisions.md): the moved declaration and its identifiers get new target-derived IDs; this is intrinsic to a cross-module move and permitted by the design-doc invariant when logged.

## Importer discovery + path rewriting (the bulk-propagation win)

**Discovery:** `getReferencesByTo(sourceDeclarationIdentifierId)` returns every identifier across all modules that resolves to the declaration (the same mechanism `rename_symbol` uses) — including the `import { X }` clause identifiers (the resolver follows import aliases). Map each `fromNodeId` to its containing module; the set of distinct importer modules (excluding source) is the rewrite set.

**Per importer**, locate the `ImportDeclaration` that imports the moved symbol from the source module (parse the module's `ImportDeclaration` children; match a named binding equal to the symbol whose module specifier resolves to the source path). Two cases:

- **Sole import** (`import { X } from "./src.ts"` — X is the only binding): rewrite the module-specifier string to the relative path from the importer to the target module. `path-rewrite` style.
- **Mixed import** (`import { X, Y } from "./src.ts"`): remove `X` (and its comma) from the existing binding list via a text-span edit, and add a new `import { X } from "<target>"` statement to the importer (reusing the `add_import` insert path). `split-out` style.

**Style-preserving relative path:** compute `path.relative(dirname(importerPath), targetPath)`, normalize to POSIX, ensure a leading `./` when not already `../`. Preserve the importer's *existing* extension convention: if the original specifier ended in `.ts`/`.tsx`/`.js`/`.mjs`, keep that extension on the new path; otherwise emit no extension. (examples/medium uses `.ts`; other corpora may not.)

**Source self-use:** if the source module still references the symbol after removal (a `getReferencesByTo` `fromNodeId` lives in the source module, in a non-import statement), add one back-import `import { X } from "<target>"` to the source module (reusing the `add_import` insert path). `sourceBackImportAdded = true`.

## Self-contained verification (`analyzeMove`)

Build a `ts.Program`/`TypeChecker` over `renderedByPath` (caller-supplied), locate the source declaration at `sourceModuleSourceFile.statements[declChildIndex]`. Reject (specific reason) if:

- the declaration is not exported (no `export` modifier);
- the target module is not found, or the target already has a top-level declaration named `X` (collision);
- **any identifier in the declaration's subtree resolves to a symbol whose declaration lives in a rendered (non-lib) module, is *not* within the moved declaration's own span, and is *not* declared in the target module** — i.e. it depends on a source-local or imported symbol that won't be in scope at the target. (Globals/builtins resolve to lib files or have no rendered declaration → allowed; the declaration's own internals are within its span → allowed; symbols already declared in the **target** module are in scope after the move → allowed, no import needed.)
- any importer of the symbol uses a non-named form (namespace / default / re-export / dynamic).

Otherwise emit a `MovePlan` with: the declaration payload + kind, the per-importer rewrite instructions (sole/mixed, computed new text + edit spans), and the source-self-use flag.

## Apply (`move_declaration`)

`analyzeMove` (throw on rejection) → recreate-in-target (capture `newDeclarationId`) → delete-from-source (track for rollback) → for each importer, `queueTextSpanEdit` (sole: specifier; mixed: binding removal) and, for mixed, append the new target import → optional source back-import → `queuePendingOp({kind:"MoveDeclaration", affectedNodeIds:[newDeclarationId, sourceDeclId, ...importerStmtIds]})` → return manifest. At commit, materialization re-derives the dirty modules and `validate` (tsc) backstops any inference miss (commit fails + rolls back cleanly).

## Error handling

- Structural misuse (bad IDs, non-Module target, non-declaration source, non-exported) → `throw` precise message; no overlay mutation.
- Semantic rejection (not self-contained, non-named importer, name collision) → `throw` the analysis reason; no overlay mutation.
- Anything that slips past analysis → caught by `validate` at commit; `{ ok: false, diagnostics }`, transaction rolls back.

## Testing (falsifiers)

**Analysis unit (`packages/store/tests/moveAnalysis.test.ts`)**
- Self-contained exported decl with sole-import importers → plan with correct rewritten paths (style preserved).
- Mixed-import importer → `split-out` plan (binding removed + new import).
- Reject: non-exported; non-self-contained (references a source-local symbol); namespace importer; target name collision.
- Source self-use detected → `sourceBackImportAdded` planned.

**Apply unit (`packages/store/tests/moveDeclaration.test.ts`)**
- Declaration node recreated in target (new target-derived ID), deleted from source; manifest fields correct; throw-before-mutation on rejection.

**Integration (`packages/verify/tests/moveDeclarationCommit.test.ts`)**
- Move a self-contained exported symbol imported by ≥2 modules → commit clean → `find_declarations` finds it in the target (not source) → each importer's use resolves to the new declaration (real edges) → **re-ingest equivalence** (node IDs + edges) → rollback-clean on a forced type error → no dangling edges.
- Mixed-import importer end-to-end (split-out) commits clean and resolves.

**Real corpus**
- Move a widely-imported symbol out of `examples/medium/src/types.ts` (imported 5×) and commit green; assert all importers rewritten + resolve.

**Dogfood validation (operator, keyed)**
- `dogfood:move` (parallel to `dogfood:extract`): paired substrate-vs-baseline on moving a widely-imported symbol. This is the bulk-propagation task our finding predicts the substrate should win — the actual point of building the tool. Verify both arms relocate the symbol + rewrite all importers, tsc-clean, then compare cost.

## Open questions resolved during brainstorming

- **v1 import surface:** named imports only (sole + mixed); namespace/default/re-export/dynamic rejected.
- **Dependency handling:** none — declaration must be self-contained; reject otherwise (validate backstops).
- **Source self-use:** add one back-import (move-correctness, not dependency handling).
- **ID churn:** accepted and logged; edges re-pointed via materialization.
- **Architecture:** pure-store analysis taking caller-supplied rendered text (mirrors extract_function), keeping the render-free dependency guard intact.
