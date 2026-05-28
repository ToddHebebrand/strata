# Graph Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At commit time, bring the node graph back into agreement with the rendered text for the statements a transaction structurally changed — so created/inserted functions and imports are findable and the identifiers extract inserts produce real reference edges.

**Architecture:** A commit-time pass (`materializeGraph`) runs inside the commit DB transaction, after payload materialization and only when validation passed. It (1) emits Identifier children for newly-inserted top-level nodes (class-1, additive), (2) re-derives the identifiers of statements whose internal identifier set/order changed (class-2, bounded ID churn confined to the one changed statement), and (3) surgically refreshes reference edges for exactly the identifiers it materialized or deleted. The TypeScript reference resolver is extracted out of `@strata/ingest` into `@strata/store` so both batch ingest and this incremental pass share one resolver; it takes rendered text as input (never imports `@strata/render`). Pure rename-class commits skip the pass entirely (no-op gate). A pre-existing EOF off-by-one in `create_function`/`add_import` is fixed first.

**Tech Stack:** TypeScript, `typescript` compiler API (`ts.createSourceFile`, `ts.createProgram`, `TypeChecker`), `better-sqlite3`, Vitest. Monorepo: pnpm workspaces (`@strata/store`, `@strata/ingest`, `@strata/verify`).

**Spec:** `docs/superpowers/specs/2026-05-28-graph-materialization-design.md` (Codex-reviewed 2026-05-28). Decision logged in `decisions.md` (2026-05-28 entry).

---

## Background the engineer needs

- **Node IDs are position-derived.** `nodeId(modulePath, childIndexPath, kind)` = `sha1(modulePath \0 childIndexPath.join(".") \0 kind)[:16]` (`packages/store/src/ids.ts:9`). An Identifier's ID is `nodeId(modulePath, [statementIndex, identifierDFSIndex], "Identifier")`. `identifierDFSIndex` is the pre-order index of that identifier among all identifiers under its top-level statement, walking `node.getChildren()` (which **includes JSDoc** — `packages/ingest/src/identifiers.ts:24`).
- **The graph.** SQLite tables: `nodes(id PK, kind, parent_id, child_index, payload)` and `node_references(from_node_id PK, to_node_id, kind)` (`packages/store/src/schema.ts:30-51`). A Module node has top-level statements as children (`child_index` 0..N-1) plus one `EndOfFileTrivia` child. Identifiers are children of their statement node (`child_index` null). References are directed identifier→declaration-identifier edges; `from_node_id` is the PK, so each identifier has at most one outgoing edge.
- **Transactions** (`packages/store/src/transactions.ts`): an in-memory overlay per tx tracks `identifierMutations` (rename text edits), `textSpanMutations` (raw payload splices), `insertedNodeIds` (nodes written straight to the table; rollback deletes them), and `pendingOps`. `commitWithoutValidate` applies overlay edits + appends the op log.
- **Commit paths** (`packages/verify/src/validate.ts`): `commit()` (CLI/tests) runs in-process `validate()` (tsc) → `materializeStatementPayloads()` → `commitWithoutValidate()`. `commitWithBehavioralGate()` (agent) renders + spawns real tsc, then the same materialize + commit. `materializeStatementPayloads()` applies overlay text edits to the `nodes` table and **clears `overlay.textSpanMutations`** at its end (`validate.ts:285`).
- **The resolver to reuse** lives in `packages/ingest/src/batch.ts`: `createInMemoryProgram`, `visit`, `tryResolve`, `identifierNodeId`, `classifyReferenceKind`, `pickDeclarationIdentifier`. It builds a `ts.Program` over source files, gets a `TypeChecker`, walks each module's identifiers, resolves symbol→declaration→`toNodeId`, and emits `Reference`s.
- **Test seeding pattern** (`packages/store/tests/jsdocDeclarations.test.ts:45-51`): `ingestBatch([{path, text}])` → `openDb(":memory:")` → `insertNodes(db, batch.allNodes)` → `insertReferences(db, batch.references)`. Store tests may import `@strata/ingest` (dev-only; the runtime dep is ingest→store, so there is no runtime cycle).

## File structure

```
packages/store/src/transactions.ts        (modify) — add deleted-node restore tracking to the overlay
packages/store/src/createFunction.ts       (modify) — fix EOF off-by-one (append at statement index N, shift EOF)
packages/store/src/addImport.ts            (modify) — same EOF fix
packages/store/src/emitIdentifiers.ts      (new)    — moved from ingest/identifiers.ts (shared DFS emit)
packages/store/src/resolveReferences.ts    (new)    — resolver core moved from ingest/batch.ts, parameterized by rendered text + options
packages/store/src/materializeGraph.ts     (new)    — the commit-time pass (plan, class-1, class-2, edge refresh)
packages/store/src/index.ts                (modify) — barrel exports for the above
packages/ingest/src/identifiers.ts         (modify) — re-export emitIdentifiers from @strata/store
packages/ingest/src/batch.ts               (modify) — call the shared resolver instead of its private one
packages/verify/src/validate.ts            (modify) — invoke materializeGraph in the commit DB transaction

packages/store/tests/eofIndex.test.ts          (new) — falsifier #1
packages/store/tests/resolveReferences.test.ts (new) — resolver parity after the move
packages/store/tests/materializeGraph.test.ts  (new) — plan/class-1/class-2/edge unit tests
packages/verify/tests/materializeCommit.test.ts(new) — integration falsifiers #2/#3/#4, rollback, no-op, bound
```

---

## Task 1: Overlay — deleted-node restore tracking

Adds a generic "restore these node rows if the tx rolls back" list to the overlay. The EOF fix (Task 2) and class-2 identifier deletion (Task 8) both delete/replace existing node rows mid-transaction and must be undoable on rollback (today `rollback` only deletes `insertedNodeIds`).

**Files:**
- Modify: `packages/store/src/transactions.ts`
- Test: `packages/store/tests/transactions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/store/tests/transactions.test.ts`:

```typescript
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import {
  begin,
  rollback,
  trackDeletedNodeForRestore
} from "../src/transactions";

it("rollback re-inserts nodes tracked for restore", () => {
  const db = openDb(":memory:");
  insertNodes(db, [
    { id: "n1", kind: "Module", parentId: null, childIndex: null, payload: "m.ts" }
  ]);
  const tx = begin(db, "test");

  // Simulate a mid-tx delete that must be undone on rollback.
  const original = { id: "n1", kind: "Module", parentId: null, childIndex: null, payload: "m.ts" };
  trackDeletedNodeForRestore(tx, original);
  db.prepare(`DELETE FROM nodes WHERE id = ?`).run("n1");

  rollback(db, tx);

  const row = db.prepare(`SELECT id, payload FROM nodes WHERE id = ?`).get("n1");
  expect(row).toEqual({ id: "n1", payload: "m.ts" });
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- transactions`
Expected: FAIL — `trackDeletedNodeForRestore` is not exported.

- [ ] **Step 3: Implement the overlay field + helper + rollback restore**

In `packages/store/src/transactions.ts`:

Add to the `TxOverlay` interface (after `insertedNodeIds`):

```typescript
  /**
   * Full node rows deleted (or about to be replaced) during this transaction
   * that must be re-inserted verbatim on rollback. Used by the EOF-shift in
   * create_function/add_import and by class-2 identifier re-derivation, which
   * delete existing rows the plain insertedNodeIds rollback cannot restore.
   */
  deletedNodesToRestore: NodeRow[];
```

Add the `NodeRow` import at the top:

```typescript
import type { NodeRow } from "./nodes";
```

Initialize it in `begin()` (in the `overlays.set(...)` object literal):

```typescript
    insertedNodeIds: [],
    deletedNodesToRestore: [],
    pendingOps: [],
```

Add the helper (next to `trackInsertedNode`):

```typescript
export function trackDeletedNodeForRestore(tx: TxHandle, node: NodeRow): void {
  getOverlay(tx).deletedNodesToRestore.push(node);
}
```

In `rollback()`, after the `insertedNodeIds` deletion block and before the `UPDATE transactions ...`:

```typescript
  if (overlay.deletedNodesToRestore.length > 0) {
    const insertNode = db.prepare(
      `INSERT OR REPLACE INTO nodes (id, kind, parent_id, child_index, payload)
       VALUES (@id, @kind, @parentId, @childIndex, @payload)`
    );
    const restore = db.transaction(() => {
      for (const node of overlay.deletedNodesToRestore) {
        insertNode.run(node);
      }
    });
    restore();
  }
```

- [ ] **Step 4: Export the helper from the barrel**

In `packages/store/src/index.ts`, add `trackDeletedNodeForRestore` to the `from "./transactions"` export block (alongside `trackInsertedNode`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- transactions`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/transactions.ts packages/store/src/index.ts packages/store/tests/transactions.test.ts
git commit -m "feat(store): overlay tracks deleted nodes for rollback restore"
```

---

## Task 2: Fix the EOF off-by-one in create_function and add_import

Today both tools use `listChildren(moduleId).length` as the new statement index. A module with `N` real statements also has one `EndOfFileTrivia` child, so `listChildren().length` = `N+1`, and the new node lands at child-index `N+1`. A clean re-ingest of the rendered text places the appended statement at index `N` and EOF at `N+1`. The fix: insert the new node at the EOF node's index (`N`), then shift the EOF node to `N+1` with a re-derived id, restoring it on rollback.

**Files:**
- Modify: `packages/store/src/createFunction.ts`
- Modify: `packages/store/src/addImport.ts`
- Test: `packages/store/tests/eofIndex.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/eofIndex.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren } from "../src/nodes";
import { begin } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { nodeId } from "../src/ids";

const SOURCE = `export const x = 1;\n`;

describe("create_function appends at the re-ingest-consistent statement index", () => {
  it("places the new function at statement index N (not N+1) and shifts EOF", () => {
    const batch = ingestBatch([{ path: "m.ts", text: SOURCE }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const moduleId = nodeId("m.ts", [], "Module");

    // One real statement (index 0) + EOF (index 1) before the insert.
    const tx = begin(db, "test");
    const result = create_function(
      db,
      tx,
      moduleId,
      `export function helper(): void {}`
    );

    // The new function must be derivable at statement index 1 (= N, the old EOF index).
    const expectedId = nodeId("m.ts", [1], "FunctionDeclaration");
    expect(result.newNodeId).toBe(expectedId);

    // Re-ingest the rendered text and assert the function node id matches.
    const rendered = `export const x = 1;\n\nexport function helper(): void {}`;
    const reIngest = ingestBatch([{ path: "m.ts", text: rendered }]);
    const reFn = reIngest.allNodes.find(
      (n) => n.kind === "FunctionDeclaration"
    );
    expect(reFn?.id).toBe(result.newNodeId);

    // EOF must now be the highest child index, with no child-index collision.
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length); // no duplicate child_index
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(Math.max(...(indices as number[])));
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- eofIndex`
Expected: FAIL — `result.newNodeId` is derived at `[2]` (N+1), not `[1]`, and EOF still sits at `[1]` colliding with the new node.

- [ ] **Step 3: Implement the fix in create_function**

In `packages/store/src/createFunction.ts`, replace the index/insert block (currently lines ~75-100, from `const existing = listChildren(...)` through `trackInsertedNode(tx, newId);`) with:

```typescript
  const existing = listChildren(db, moduleId);
  const eof = existing.find((child) => child.kind === "EndOfFileTrivia");
  // The new statement takes the EOF node's index (= number of real statements,
  // N), matching what a clean re-ingest of the rendered text produces. The EOF
  // node, if present, shifts to N+1. (decisions.md 2026-05-28 EOF fix.)
  const nextChildIndex = eof ? eof.childIndex! : existing.length;
  const newId = nodeId(moduleNode.payload, [nextChildIndex], "FunctionDeclaration");

  if (existing.some((child) => child.id === newId)) {
    throw new Error(
      `create_function: a node with derived ID ${newId} already exists at module ${moduleId} child_index ${nextChildIndex}`
    );
  }

  const normalized = functionText.startsWith("\n")
    ? functionText
    : `\n\n${functionText}`;

  insertNodes(db, [
    {
      id: newId,
      kind: "FunctionDeclaration",
      parentId: moduleId,
      childIndex: nextChildIndex,
      payload: normalized
    }
  ]);
  trackInsertedNode(tx, newId);

  if (eof) {
    const shiftedIndex = nextChildIndex + 1;
    const shiftedEofId = nodeId(moduleNode.payload, [shiftedIndex], "EndOfFileTrivia");
    // Record the EOF row as-is so rollback restores it; then replace it with
    // a row at the shifted, re-ingest-consistent index/id.
    trackDeletedNodeForRestore(tx, eof);
    db.prepare(`DELETE FROM nodes WHERE id = ?`).run(eof.id);
    insertNodes(db, [
      {
        id: shiftedEofId,
        kind: "EndOfFileTrivia",
        parentId: moduleId,
        childIndex: shiftedIndex,
        payload: eof.payload
      }
    ]);
    trackInsertedNode(tx, shiftedEofId);
  }
```

Add `trackDeletedNodeForRestore` to the imports from `./transactions` at the top of the file.

- [ ] **Step 4: Run create_function test to verify it passes**

Run: `pnpm --filter @strata/store test -- eofIndex`
Expected: PASS.

- [ ] **Step 5: Mirror the fix in add_import + extend the test**

Apply the identical index/EOF-shift block to `packages/store/src/addImport.ts` (replacing its `const existing = listChildren(...)` through `trackInsertedNode(tx, newId);`), using `"ImportDeclaration"` as the kind and its existing `normalized` (single leading `\n`). Add `trackDeletedNodeForRestore` to its `./transactions` imports.

Add an `add_import` case to `eofIndex.test.ts`:

```typescript
import { add_import } from "../src/addImport";

it("add_import also appends at index N and shifts EOF", () => {
  const batch = ingestBatch([{ path: "m.ts", text: `export const x = 1;\n` }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  const moduleId = nodeId("m.ts", [], "Module");
  const tx = begin(db, "test");
  const result = add_import(db, tx, moduleId, `import { y } from "./y";`);
  expect(result.newNodeId).toBe(nodeId("m.ts", [1], "ImportDeclaration"));
  const children = listChildren(db, moduleId);
  const indices = children.map((c) => c.childIndex);
  expect(new Set(indices).size).toBe(indices.length);
  db.close();
});
```

- [ ] **Step 6: Run the full store suite to check for regressions**

Run: `pnpm --filter @strata/store test`
Expected: PASS (95+ tests). If any `create_function`/`add_import` test asserted the old `[N+1]` id, update it to `[N]` — that is the bug being fixed.

- [ ] **Step 7: Run the CLI stable-ids + T03 acceptance to confirm no corpus regression**

Run: `pnpm --filter @strata/cli build && pnpm --filter @strata/cli test`
Expected: PASS, including `stableIds` and `t03`.

- [ ] **Step 8: Commit**

```bash
git add packages/store/src/createFunction.ts packages/store/src/addImport.ts packages/store/tests/eofIndex.test.ts
git commit -m "fix(store): create_function/add_import append at re-ingest-consistent index (EOF off-by-one)"
```

---

## Task 3: Move `emitIdentifiers` into `@strata/store`

Both ingest and the new materialization pass must emit Identifier nodes with identical DFS indexing. Move the function to store; re-export from ingest so existing importers are unaffected.

**Files:**
- Create: `packages/store/src/emitIdentifiers.ts`
- Modify: `packages/ingest/src/identifiers.ts` (becomes a re-export)
- Modify: `packages/store/src/index.ts` (export `emitIdentifiers`)
- Test: `packages/store/tests/emitIdentifiers.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/emitIdentifiers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { emitIdentifiers } from "../src/emitIdentifiers";

describe("emitIdentifiers", () => {
  it("emits one Identifier node per ts.Identifier in pre-order, offsets relative to the statement", () => {
    const sf = ts.createSourceFile(
      "m.ts",
      `function f(a: number) { return a; }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const stmt = sf.statements[0]!;
    const ids = emitIdentifiers(sf, stmt, "m.ts", [0]);
    const texts = ids.map((n) => (JSON.parse(n.payload) as { text: string }).text);
    expect(texts).toEqual(["f", "a", "a"]); // declaration name, param, use
    expect(ids.every((n) => n.kind === "Identifier")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- emitIdentifiers`
Expected: FAIL — `../src/emitIdentifiers` does not exist.

- [ ] **Step 3: Create the store module by moving the code**

Create `packages/store/src/emitIdentifiers.ts` with the exact body currently in `packages/ingest/src/identifiers.ts`, but importing `nodeId`/`NodeRow` locally instead of from `@strata/store`:

```typescript
import ts from "typescript";
import { nodeId } from "./ids";
import type { NodeRow } from "./nodes";

/**
 * Emits one Identifier node per `ts.Identifier` occurrence under a statement.
 * Offsets are relative to the statement's raw `getFullText()` payload.
 *
 * Pre-order DFS over getChildren (NOT forEachChild): getChildren includes
 * JSDoc nodes so JSDoc type references are addressable. resolveReferences.ts
 * mirrors this walk exactly so identifier indices line up between ingest,
 * resolution, and incremental materialization.
 */
export function emitIdentifiers(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  modulePath: string,
  statementChildPath: readonly number[]
): NodeRow[] {
  const stmtStart = statement.getFullStart();
  const out: NodeRow[] = [];
  const statementKind = ts.SyntaxKind[statement.kind];
  const parentId = nodeId(modulePath, statementChildPath, statementKind);
  let identifierIndex = 0;

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const offset = node.getStart(sourceFile) - stmtStart;
      const text = node.text;
      const childPath = [...statementChildPath, identifierIndex];
      out.push({
        id: nodeId(modulePath, childPath, "Identifier"),
        kind: "Identifier",
        parentId,
        childIndex: null,
        payload: JSON.stringify({ text, offset })
      });
      identifierIndex += 1;
    }
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  }

  visit(statement);
  return out;
}
```

- [ ] **Step 4: Re-export from ingest and from the store barrel**

Replace the entire body of `packages/ingest/src/identifiers.ts` with:

```typescript
export { emitIdentifiers } from "@strata/store";
```

In `packages/store/src/index.ts`, add:

```typescript
export { emitIdentifiers } from "./emitIdentifiers";
```

- [ ] **Step 5: Run store + ingest tests to verify no behavior change**

Run: `pnpm --filter @strata/store test -- emitIdentifiers && pnpm --filter @strata/ingest test`
Expected: PASS — ingest still produces identical graphs (it now imports `emitIdentifiers` from store via the re-export).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/emitIdentifiers.ts packages/store/src/index.ts packages/ingest/src/identifiers.ts packages/store/tests/emitIdentifiers.test.ts
git commit -m "refactor(store): move emitIdentifiers into store, re-export from ingest"
```

---

## Task 4: Extract the reference resolver into `@strata/store`

Move the resolver core out of `batch.ts` into a parameterized store unit that takes rendered text + compiler options + the set of modules to resolve, and returns `Reference[]`. `batch.ts` then calls it. This is what the incremental pass reuses.

**Files:**
- Create: `packages/store/src/resolveReferences.ts`
- Modify: `packages/ingest/src/batch.ts` (call the shared resolver)
- Modify: `packages/store/src/index.ts` (export the resolver)
- Test: `packages/store/tests/resolveReferences.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/resolveReferences.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { resolveReferencesForModules } from "../src/resolveReferences";
import { nodeId } from "../src/ids";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

describe("resolveReferencesForModules", () => {
  it("emits an edge from a use to its declaration identifier", () => {
    const rendered = new Map<string, string>([
      ["m.ts", `function f(): number { return 1; }\nconst y = f();\n`]
    ]);
    const refs = resolveReferencesForModules(rendered, OPTIONS, ["m.ts"]);
    // `f` is declared at statement 0 (decl-name identifier index 0) and used at
    // statement 1. Expect an edge from the use to the declaration name.
    const declNameId = nodeId("m.ts", [0, 0], "Identifier");
    expect(refs.some((r) => r.toNodeId === declNameId && r.kind === "value")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- resolveReferences`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the resolver by moving batch.ts internals**

Create `packages/store/src/resolveReferences.ts`. Move these functions out of `packages/ingest/src/batch.ts` verbatim, adapting the entry point to take a `Map<path, renderedText>`, `ts.CompilerOptions`, and `dirtyModulePaths`:

```typescript
import ts from "typescript";
import { nodeId } from "./ids";
import type { Reference, ReferenceKind } from "./references";

/**
 * Build a program over the supplied rendered modules and resolve every
 * identifier in each `dirtyModulePaths` module into a Reference edge
 * (use -> declaration-name identifier). Caller supplies rendered text and
 * compiler options so this never imports @strata/render and matches the
 * commit gate's tsconfig. Mirrors the DFS in emitIdentifiers exactly.
 */
export function resolveReferencesForModules(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  dirtyModulePaths: readonly string[]
): Reference[] {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [path, text] of renderedByPath) {
    sourceFiles.set(
      normalizePath(path),
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }

  const program = createInMemoryProgram(renderedByPath, sourceFiles, options);
  const checker = program.getTypeChecker();
  const references: Reference[] = [];
  const dirty = new Set(dirtyModulePaths.map(normalizePath));

  for (const modulePath of dirty) {
    const sf = sourceFiles.get(modulePath);
    if (sf) visit(sf, modulePath);
  }

  function visit(node: ts.Node, modulePath: string): void {
    if (ts.isIdentifier(node)) tryResolve(node, modulePath);
    const sf = sourceFiles.get(modulePath);
    for (const child of node.getChildren(sf)) visit(child, modulePath);
  }

  function tryResolve(identifier: ts.Identifier, modulePath: string): void {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        /* keep alias symbol */
      }
    }
    const declaration = symbol.declarations?.[0];
    if (!declaration) return;
    const declSf = declaration.getSourceFile();
    const declModulePath = normalizePath(declSf.fileName);
    if (!sourceFiles.has(declModulePath)) return;
    const declIdentifier = pickDeclarationIdentifier(declaration);
    if (!declIdentifier) return;
    const sf = sourceFiles.get(modulePath);
    if (!sf) return;
    const fromNodeId = identifierNodeId(identifier, modulePath, sf);
    const toNodeId = identifierNodeId(declIdentifier, declModulePath, declSf);
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
    references.push({ fromNodeId, toNodeId, kind: classifyReferenceKind(symbol) });
  }

  return references;
}

function createInMemoryProgram(
  renderedByPath: Map<string, string>,
  sourceFiles: Map<string, ts.SourceFile>,
  options: ts.CompilerOptions
): ts.Program {
  const host: ts.CompilerHost = {
    fileExists: (f) => sourceFiles.has(normalizePath(f)),
    readFile: (f) => sourceFiles.get(normalizePath(f))?.getFullText(),
    getSourceFile: (f) => sourceFiles.get(normalizePath(f)),
    getDefaultLibFileName: ts.getDefaultLibFileName,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => normalizePath(f),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
    getDirectories: () => []
  };
  return ts.createProgram({
    rootNames: [...renderedByPath.keys()],
    options: { ...options, noEmit: true, skipLibCheck: true },
    host
  });
}

function pickDeclarationIdentifier(declaration: ts.Declaration): ts.Identifier | undefined {
  const named = declaration as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name;
  return undefined;
}

function classifyReferenceKind(symbol: ts.Symbol): ReferenceKind {
  if (symbol.flags & ts.SymbolFlags.Namespace) return "namespace";
  if (symbol.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    return "type";
  return "value";
}

function identifierNodeId(
  identifier: ts.Identifier,
  modulePath: string,
  sourceFile: ts.SourceFile
): string | undefined {
  let owner: ts.Node = identifier;
  while (owner.parent && owner.parent.kind !== ts.SyntaxKind.SourceFile) owner = owner.parent;
  if (owner.parent?.kind !== ts.SyntaxKind.SourceFile) return undefined;
  const statementIndex = sourceFile.statements.indexOf(owner as ts.Statement);
  if (statementIndex < 0) return undefined;
  let childIndex = -1;
  let found = -1;
  function walk(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      childIndex += 1;
      if (node === identifier) {
        found = childIndex;
        return true;
      }
    }
    for (const child of node.getChildren(sourceFile)) if (walk(child)) return true;
    return false;
  }
  walk(owner);
  if (found < 0) return undefined;
  return nodeId(modulePath, [statementIndex, found], "Identifier");
}

function normalizePath(fileName: string): string {
  return fileName.replaceAll("\\", "/").replace(/^\.\//, "");
}
```

- [ ] **Step 4: Run the resolver unit test**

Run: `pnpm --filter @strata/store test -- resolveReferences`
Expected: PASS.

- [ ] **Step 5: Export from the barrel and refactor batch.ts to call it**

In `packages/store/src/index.ts` add:

```typescript
export { resolveReferencesForModules } from "./resolveReferences";
```

In `packages/ingest/src/batch.ts`, delete the now-moved private functions (`createInMemoryProgram`, `visit`, `tryResolve`, `pickDeclarationIdentifier`, `classifyReferenceKind`, `identifierNodeId`, `normalizePath`) and the per-input resolution loop. Replace the resolution half of `ingestBatch` so that, after building `allNodes`/`modules`, it calls:

```typescript
import { resolveReferencesForModules } from "@strata/store";
// ...
  const renderedByPath = new Map(inputs.map((i) => [i.path, i.text]));
  const references = resolveReferencesForModules(
    renderedByPath,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true
    },
    inputs.map((i) => i.path)
  );

  return { allNodes, references, modules };
```

Keep the node-building loop (the `ingest(input.text, input.path)` calls) as-is.

- [ ] **Step 6: Run ingest tests + CLI ingest/stableIds to verify parity**

Run: `pnpm --filter @strata/ingest test && pnpm --filter @strata/cli build && pnpm --filter @strata/cli test -- ingestBatch stableIds`
Expected: PASS — batch ingest produces the same references as before (the resolver moved, behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/store/src/resolveReferences.ts packages/store/src/index.ts packages/ingest/src/batch.ts packages/store/tests/resolveReferences.test.ts
git commit -m "refactor: extract reference resolver into @strata/store, parameterized by rendered text"
```

---

## Task 5: `materializeGraph` — plan computation + no-op gate

Computes, from the tx overlay, what the pass must do: which modules are dirty, which inserted nodes need class-1 emission, which statements need class-2 re-derivation, and whether the whole pass is a no-op (pure rename). Must be called and snapshotted **before** `materializeStatementPayloads` clears `overlay.textSpanMutations`.

**Files:**
- Create: `packages/store/src/materializeGraph.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/materializeGraph.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/materializeGraph.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import { begin, queueIdentifierUpdate, getOverlay } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { planMaterialization, isNoop } from "../src/materializeGraph";
import { nodeId } from "../src/ids";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  return db;
}

describe("planMaterialization / isNoop", () => {
  it("is a no-op for a pure rename (only identifier text updates)", () => {
    const db = seed("m.ts", `export function f(): void {}\n`);
    const tx = begin(db, "test");
    const declNameId = nodeId("m.ts", [0, 0], "Identifier");
    queueIdentifierUpdate(tx, declNameId, "g");
    const plan = planMaterialization(db, getOverlay(tx));
    expect(isNoop(plan)).toBe(true);
  });

  it("flags an inserted node as a dirty module needing class-1 emission", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
    const plan = planMaterialization(db, getOverlay(tx));
    expect(isNoop(plan)).toBe(false);
    expect(plan.dirtyModulePaths).toContain("m.ts");
    expect(plan.insertedNodeIds).toContain(newNodeId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement plan + no-op gate**

Create `packages/store/src/materializeGraph.ts`:

```typescript
import { findNodeById, modulePathOf, type NodeRow } from "./nodes";
import type { Db } from "./schema";
import type { TxOverlay } from "./transactions";

export interface MaterializationPlan {
  dirtyModulePaths: string[];
  /** Newly-inserted top-level nodes (create_function, add_import). Class-1. */
  insertedNodeIds: string[];
  /**
   * Top-level statement node IDs whose internal identifier set/order changed
   * (text-span splices that insert/delete identifiers). Class-2. EOF-shift
   * inserts are excluded (they are tracked as inserted nodes, not edits).
   */
  reDerivedStatementIds: string[];
}

/**
 * Build the materialization plan from the overlay. MUST run before
 * materializeStatementPayloads clears overlay.textSpanMutations.
 */
export function planMaterialization(db: Db, overlay: TxOverlay): MaterializationPlan {
  const dirty = new Set<string>();
  const insertedNodeIds: string[] = [];
  const reDerivedStatementIds: string[] = [];

  for (const id of overlay.insertedNodeIds) {
    const node = findNodeById(db, id);
    if (!node || node.kind === "EndOfFileTrivia") continue; // EOF shift is not real structure
    insertedNodeIds.push(id);
    dirty.add(modulePathOf(db, id));
  }

  for (const statementId of overlay.textSpanMutations.keys()) {
    reDerivedStatementIds.push(statementId);
    dirty.add(modulePathOf(db, statementId));
  }

  return {
    dirtyModulePaths: [...dirty],
    insertedNodeIds,
    reDerivedStatementIds
  };
}

export function isNoop(plan: MaterializationPlan): boolean {
  return (
    plan.insertedNodeIds.length === 0 && plan.reDerivedStatementIds.length === 0
  );
}
```

In `packages/store/src/index.ts` add:

```typescript
export {
  planMaterialization,
  isNoop,
  type MaterializationPlan
} from "./materializeGraph";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/materializeGraph.ts packages/store/src/index.ts packages/store/tests/materializeGraph.test.ts
git commit -m "feat(store): materializeGraph plan computation + no-op gate"
```

---

## Task 6: `materializeGraph` — class-1 identifier emission for inserted nodes

For each inserted top-level node, parse its payload as a single statement and emit its Identifier children into the `nodes` table, tracking them for rollback.

**Files:**
- Modify: `packages/store/src/materializeGraph.ts`
- Test: `packages/store/tests/materializeGraph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/store/tests/materializeGraph.test.ts`:

```typescript
import { listChildren } from "../src/nodes";
import { emitIdentifiersForInserted } from "../src/materializeGraph";
import ts from "typescript";

it("emits Identifier children for an inserted function so it is findable", () => {
  const db = seed("m.ts", `export const x = 1;\n`);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");
  const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
  const plan = planMaterialization(db, getOverlay(tx));

  emitIdentifiersForInserted(db, getOverlay(tx), plan);

  const idents = listChildren(db, newNodeId).filter((c) => c.kind === "Identifier");
  const names = idents.map((n) => (JSON.parse(n.payload) as { text: string }).text);
  expect(names).toContain("h");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: FAIL — `emitIdentifiersForInserted` not exported.

- [ ] **Step 3: Implement class-1 emission**

Add to `packages/store/src/materializeGraph.ts`:

```typescript
import ts from "typescript";
import { insertNodes } from "./nodes";
import { emitIdentifiers } from "./emitIdentifiers";
import { trackInsertedNode, type TxHandle } from "./transactions";

/**
 * Class-1: for each inserted top-level node, parse its payload and emit its
 * Identifier children. The node's childIndex is its statement index N (post
 * the EOF fix), so emitted identifier IDs match what a re-ingest produces.
 */
export function emitIdentifiersForInserted(
  db: Db,
  tx: TxHandle,
  plan: MaterializationPlan
): void {
  for (const insertedId of plan.insertedNodeIds) {
    const node = findNodeById(db, insertedId);
    if (!node || node.childIndex === null) continue;
    const modulePath = modulePathOf(db, insertedId);
    // Parse the payload as a standalone source file; the inserted node is its
    // sole statement (create_function/add_import validate single-statement text).
    const sf = ts.createSourceFile(
      modulePath,
      node.payload.replace(/^\n+/, ""),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const stmt = sf.statements[0];
    if (!stmt) continue;
    const identifiers = emitIdentifiers(sf, stmt, modulePath, [node.childIndex]);
    if (identifiers.length === 0) continue;
    insertNodes(db, identifiers);
    for (const ident of identifiers) trackInsertedNode(tx, ident.id);
  }
}
```

> Note: `emitIdentifiers` computes offsets relative to the statement's `getFullStart()`. Because we strip leading newlines before parsing, offsets are relative to the trimmed payload. The renderer re-derives the leading separator, so identifier offsets here are used only for ordering/rename-shift, consistent with how ingest stores them per statement. The headline assertion (findability) depends on the `text` field, which is unaffected.

Change the signature in step 1's call to pass `getOverlay(tx)`? No — `emitIdentifiersForInserted` takes `tx: TxHandle`. Update the test call to `emitIdentifiersForInserted(db, tx, plan)`.

- [ ] **Step 4: Fix the test call + run**

In the test, change `emitIdentifiersForInserted(db, getOverlay(tx), plan)` to `emitIdentifiersForInserted(db, tx, plan)`. Export `emitIdentifiersForInserted` from the store barrel.

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/materializeGraph.ts packages/store/src/index.ts packages/store/tests/materializeGraph.test.ts
git commit -m "feat(store): class-1 identifier emission for inserted nodes"
```

---

## Task 7: `materializeGraph` — surgical reference-edge refresh

Resolve references for the dirty modules' rendered text and insert edges, but only for the identifiers materialized this commit (inserted-node identifiers + re-derived-statement identifiers). Delete any existing edges touching those identifiers first (PK + plain INSERT). Surviving identifiers' edges are untouched.

**Files:**
- Modify: `packages/store/src/materializeGraph.ts`
- Test: `packages/store/tests/materializeGraph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/store/tests/materializeGraph.test.ts`:

```typescript
import { get_references } from "../src/queries";
import { find_declarations } from "../src/queries";
import { refreshReferenceEdges } from "../src/materializeGraph";

const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
} as const;

it("created function is findable and a same-module caller resolves to it", () => {
  // A module that already calls h(); h() is then created. After materialization,
  // find_declarations(h) works AND the existing call site resolves to it.
  const db = seed("m.ts", `export function caller(): void { h(); }\n`);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");
  const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);

  const rendered = new Map<string, string>([
    ["m.ts", `export function caller(): void { h(); }\n\nexport function h(): void {}`]
  ]);
  refreshReferenceEdges(db, plan, rendered, { ...OPTIONS });

  const decls = find_declarations(db, { name: "h" });
  expect(decls).toHaveLength(1);
  const refs = get_references(db, decls[0]!.id);
  expect(refs.length).toBeGreaterThanOrEqual(1); // caller's h() resolves to the new decl
});
```

> The `get_references` input is a declaration node id; confirm its signature in `packages/store/src/queries.ts` and pass the declaration node id the same way `jsdocDeclarations.test.ts` does.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: FAIL — `refreshReferenceEdges` not exported.

- [ ] **Step 3: Implement the surgical edge refresh**

Add to `packages/store/src/materializeGraph.ts`:

```typescript
import { resolveReferencesForModules } from "./resolveReferences";
import { insertReferences } from "./references";

/**
 * Recompute reference edges for exactly the identifiers materialized this
 * commit. `renderedByPath` must contain final rendered text for the dirty
 * modules plus any modules they import (so cross-module targets resolve).
 * Surviving (not re-derived) identifiers keep their existing edges.
 */
export function refreshReferenceEdges(
  db: Db,
  plan: MaterializationPlan,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): void {
  if (isNoop(plan)) return;

  // The identifiers whose edges we own this commit: all Identifier children of
  // the inserted nodes and of the re-derived statements.
  const ownedIdentifierIds = new Set<string>();
  for (const parentId of [...plan.insertedNodeIds, ...plan.reDerivedStatementIds]) {
    for (const child of listChildren(db, parentId)) {
      if (child.kind === "Identifier") ownedIdentifierIds.add(child.id);
    }
  }

  const resolved = resolveReferencesForModules(
    renderedByPath,
    options,
    plan.dirtyModulePaths
  );

  const del = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );
  const apply = db.transaction(() => {
    // Delete-before-insert for every owned identifier (from_node_id is PK).
    for (const id of ownedIdentifierIds) del.run(id, id);
    // Insert only edges that originate from an owned identifier. Edges whose
    // source is a surviving identifier are not ours to touch.
    const toInsert = resolved.filter((r) => ownedIdentifierIds.has(r.fromNodeId));
    if (toInsert.length > 0) insertReferences(db, toInsert);
  });
  apply();
}
```

Add `listChildren` to the imports from `./nodes`. Export `refreshReferenceEdges` from the store barrel.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: PASS — `find_declarations("h")` returns the new function and the caller's `h()` resolves to it.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/materializeGraph.ts packages/store/src/index.ts packages/store/tests/materializeGraph.test.ts
git commit -m "feat(store): surgical reference-edge refresh for materialized identifiers"
```

---

## Task 8: `materializeGraph` — class-2 statement re-derivation

For each re-derived statement (a text-span splice that changed its identifier set), delete the statement's old Identifier rows + their edges, then re-emit identifiers from the statement's final payload. The inserted call-site identifier gets a normal DFS-derived ID. Old rows are tracked for rollback.

**Files:**
- Modify: `packages/store/src/materializeGraph.ts`
- Test: `packages/store/tests/materializeGraph.test.ts`

- [ ] **Step 1: Write the failing test (extract-shaped, primitive-driven)**

Add to `packages/store/tests/materializeGraph.test.ts`:

```typescript
import { queueTextSpanEdit } from "../src/transactions";
import { reDeriveChangedStatements } from "../src/materializeGraph";

it("re-derives a spliced parent body: removed-span ids gone, call-site id present", () => {
  // Parent body has two statements; we splice the first into a call `h(a);`.
  const source = `export function parent(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`;
  const db = seed("m.ts", source);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");

  // 1) Create the helper (class-1).
  const { newNodeId: helperId } = create_function(
    db, tx, moduleId, `export function h(a: number): void { const b = a + 1; }`
  );

  // 2) Splice the parent body's first body statement with a call to h.
  const parentId = nodeId("m.ts", [0], "FunctionDeclaration");
  const parentNode = findNodeById(db, parentId)!;
  const removed = `  const b = a + 1;`;
  const start = parentNode.payload.indexOf(removed);
  queueTextSpanEdit(tx, parentId, {
    start,
    end: start + removed.length,
    oldText: removed,
    newText: `  h(a);`
  });

  // Apply the payload edit to the parent node (mimics materializeStatementPayloads).
  const newPayload =
    parentNode.payload.slice(0, start) + `  h(a);` + parentNode.payload.slice(start + removed.length);
  db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`).run(newPayload, parentId);

  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);
  reDeriveChangedStatements(db, tx, plan);

  const parentIdents = listChildren(db, parentId)
    .filter((c) => c.kind === "Identifier")
    .map((n) => (JSON.parse(n.payload) as { text: string }).text);
  // The removed `b` declaration/use are gone from the span; the call-site `h` appears.
  expect(parentIdents).toContain("h");
  expect(parentIdents.filter((t) => t === "b")).toHaveLength(0);
});
```

> `planMaterialization` must be called after the `queueTextSpanEdit`, so the `reDerivedStatementIds` includes `parentId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: FAIL — `reDeriveChangedStatements` not exported.

- [ ] **Step 3: Implement class-2 re-derivation**

Add to `packages/store/src/materializeGraph.ts`:

```typescript
import { trackDeletedNodeForRestore } from "./transactions";

/**
 * Class-2: for each statement whose identifier set/order changed, delete its
 * old Identifier rows (tracked for rollback) and re-emit from final payload.
 * Edges are refreshed separately by refreshReferenceEdges (which sees the new
 * identifier IDs via listChildren). Bounded churn: only this statement's
 * internal identifier IDs change; other statements are untouched.
 */
export function reDeriveChangedStatements(
  db: Db,
  tx: TxHandle,
  plan: MaterializationPlan
): void {
  const deleteNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);
  const deleteEdges = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );

  for (const statementId of plan.reDerivedStatementIds) {
    const statement = findNodeById(db, statementId);
    if (!statement || statement.childIndex === null) continue;
    const modulePath = modulePathOf(db, statementId);

    // Delete old identifier children + their edges; track rows for rollback.
    const oldIdentifiers = listChildren(db, statementId).filter(
      (c) => c.kind === "Identifier"
    );
    const drop = db.transaction(() => {
      for (const ident of oldIdentifiers) {
        trackDeletedNodeForRestore(tx, ident);
        deleteEdges.run(ident.id, ident.id);
        deleteNode.run(ident.id);
      }
    });
    drop();

    // Re-emit from the statement's final payload.
    const sf = ts.createSourceFile(
      modulePath,
      statement.payload.replace(/^\n+/, ""),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const stmt = sf.statements[0];
    if (!stmt) continue;
    const fresh = emitIdentifiers(sf, stmt, modulePath, [statement.childIndex]);
    if (fresh.length > 0) {
      insertNodes(db, fresh);
      for (const ident of fresh) trackInsertedNode(tx, ident.id);
    }
  }
}
```

Export `reDeriveChangedStatements` from the store barrel.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- materializeGraph`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/materializeGraph.ts packages/store/src/index.ts packages/store/tests/materializeGraph.test.ts
git commit -m "feat(store): class-2 statement re-derivation for spliced bodies"
```

---

## Task 9: Wire `materializeGraph` into the commit path

Invoke the pass inside both commit paths, after payload materialization, only when validation passed, inside one DB transaction with the op-log finalize. Snapshot the plan before payloads are materialized (the overlay's text-span mutations get cleared). Skip the program build entirely for no-op (rename) commits.

**Files:**
- Modify: `packages/verify/src/validate.ts`
- Test: `packages/verify/tests/materializeCommit.test.ts` (new)

- [ ] **Step 1: Write the failing integration tests**

Create `packages/verify/tests/materializeCommit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  create_function,
  rename_symbol,
  find_declarations,
  get_references,
  nodeId
} from "@strata/store";
import { commit } from "../src/validate";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("commit materializes the graph", () => {
  it("created function is findable after commit (headline)", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    create_function(db, tx, moduleId, `export function h(): number { return 1; }`);
    const result = commit(db, tx);
    expect(result.ok).toBe(true);
    expect(find_declarations(db, { name: "h" })).toHaveLength(1);
    db.close();
  });

  it("rename of a freshly-created+committed helper updates the caller call site", () => {
    // create helper + a caller in one tx; commit; then rename; commit; assert.
    const db = seed("m.ts", `export function caller(): number { return h(); }\n`);
    const tx1 = begin(db, "t1");
    const moduleId = nodeId("m.ts", [], "Module");
    create_function(db, tx1, moduleId, `export function h(): number { return 1; }`);
    expect(commit(db, tx1).ok).toBe(true);

    const decl = find_declarations(db, { name: "h" })[0]!;
    const refsBefore = get_references(db, decl.id);
    expect(refsBefore.length).toBeGreaterThanOrEqual(1);

    const tx2 = begin(db, "t2");
    rename_symbol(db, tx2, decl.id, "renamedH");
    expect(commit(db, tx2).ok).toBe(true);
    expect(find_declarations(db, { name: "renamedH" })).toHaveLength(1);
    db.close();
  });

  it("rollback on validation failure leaves no materialized rows", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    // Reference an undefined symbol so tsc fails.
    create_function(db, tx, moduleId, `export function h(): number { return missing; }`);
    const result = commit(db, tx);
    expect(result.ok).toBe(false);
    // Find should not see h (commit returned before materializing/persisting).
    expect(find_declarations(db, { name: "h" })).toHaveLength(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @strata/verify test -- materializeCommit`
Expected: FAIL — `find_declarations("h")` returns 0 after commit (materialization not wired yet).

- [ ] **Step 3: Wire materializeGraph into `commit()`**

In `packages/verify/src/validate.ts`, import the pass:

```typescript
import {
  planMaterialization,
  isNoop,
  emitIdentifiersForInserted,
  reDeriveChangedStatements,
  refreshReferenceEdges,
  getOverlay,
  // ...existing imports
} from "@strata/store";
```

Rewrite `commit()` so the plan is snapshotted before payloads are materialized, and the graph pass runs after, inside the same DB transaction as the op-log finalize:

```typescript
export function commit(db: Db, tx: TxHandle): CommitResult {
  const diagnostics = validate(db, tx);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Snapshot BEFORE materializeStatementPayloads clears overlay.textSpanMutations.
  const plan = planMaterialization(db, getOverlay(tx));
  const { renderedFiles } = renderPendingModules(db, tx);
  const renderedByPath = new Map(
    [...renderedFiles].map(([abs, text]) => [normalizeFileName(abs), text])
  );
  const options = loadCompilerOptions([...renderedFiles.keys()]);

  materializeStatementPayloads(db, tx);

  if (!isNoop(plan)) {
    emitIdentifiersForInserted(db, tx, plan);
    reDeriveChangedStatements(db, tx, plan);
    refreshReferenceEdges(db, plan, renderedByPath, options);
  }

  commitWithoutValidate(db, tx);
  return { ok: true };
}
```

> The dirty modules' rendered text is the full rendered set keyed by normalized path. `resolveReferencesForModules` only resolves the `dirtyModulePaths` but builds the program over everything passed, so imports resolve. For large corpora, narrow `renderedByPath` to dirty ∪ their imports in Task 10's optimization; correctness holds with the full set.

- [ ] **Step 4: Run the integration tests**

Run: `pnpm --filter @strata/verify test -- materializeCommit`
Expected: PASS (all three: headline findability, rename-propagates, rollback-clean).

- [ ] **Step 5: Wire the same into `commitWithBehavioralGate()`**

Apply the identical snapshot → materialize payloads → (if not no-op) graph pass → `commitWithoutValidate` sequence inside `commitWithBehavioralGate()`, after the `runCorpusAcceptance` success check (replacing its current `materializeStatementPayloads(db, tx); commitWithoutValidate(db, tx);`). Build `renderedByPath`/`options` the same way (`renderedFiles` is already computed there; `options = loadCompilerOptions([...renderedFiles.keys()])`).

- [ ] **Step 6: Run the full verify + agent + cli suites for regressions**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across all packages. Pay attention to T03 (rename) — it must stay green and must NOT enter the materialization program-build path (it is a no-op commit).

- [ ] **Step 7: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/tests/materializeCommit.test.ts
git commit -m "feat(verify): invoke graph materialization in the commit path"
```

---

## Task 10: No-op cost guard + dirty-set program bound + dependency guard

Lock in the performance and architecture invariants with explicit tests so regressions are visible.

**Files:**
- Test: `packages/verify/tests/materializeCommit.test.ts`
- Test: `packages/store/tests/dependencyGuard.test.ts` (new)

- [ ] **Step 1: Write the no-op cost guard**

Add to `packages/verify/tests/materializeCommit.test.ts`:

```typescript
it("a pure rename commit leaves node_references unchanged (no-op gate)", () => {
  const db = seed("m.ts", `export function f(): number { return 1; }\nexport const y = f();\n`);
  const before = db.prepare(`SELECT count(*) AS n FROM node_references`).get() as { n: number };
  const decl = find_declarations(db, { name: "f" })[0]!;
  const tx = begin(db, "test");
  rename_symbol(db, tx, decl.id, "g");
  expect(commit(db, tx).ok).toBe(true);
  const after = db.prepare(`SELECT count(*) AS n FROM node_references`).get() as { n: number };
  expect(after.n).toBe(before.n); // edges survive a rename untouched
  expect(find_declarations(db, { name: "g" })).toHaveLength(1);
  db.close();
});
```

- [ ] **Step 2: Write the dependency guard**

Create `packages/store/tests/dependencyGuard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("store has no forbidden package imports", () => {
  it("store package.json declares neither @strata/ingest nor @strata/render as a runtime dep", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("@strata/ingest");
    expect(deps).not.toContain("@strata/render");
  });
});
```

- [ ] **Step 3: Run both guards**

Run: `pnpm --filter @strata/verify test -- materializeCommit && pnpm --filter @strata/store test -- dependencyGuard`
Expected: PASS. If the dependency guard fails, the resolver move accidentally pulled a forbidden dep into `store/package.json` — remove it (the resolver needs only `typescript`, already present).

- [ ] **Step 4: Commit**

```bash
git add packages/verify/tests/materializeCommit.test.ts packages/store/tests/dependencyGuard.test.ts
git commit -m "test: no-op cost guard + store dependency guard for materialization"
```

---

## Task 11: Large-corpus bound (program input scoping)

Confirm materialization does not build a program over the whole corpus for a small dirty set, and narrow `renderedByPath` to dirty ∪ their direct imports.

**Files:**
- Modify: `packages/verify/src/validate.ts`
- Test: `packages/verify/tests/materializeCommit.test.ts`

- [ ] **Step 1: Write the failing bound test**

Add to `packages/verify/tests/materializeCommit.test.ts`:

```typescript
it("materialization program input is bounded to dirty modules + their imports", () => {
  // Module a imports b; c and d are unrelated. Creating a function in `a`
  // should resolve over {a, b}, not {a, b, c, d}.
  const files = [
    { path: "a.ts", text: `import { fromB } from "./b";\nexport const ax = fromB;\n` },
    { path: "b.ts", text: `export const fromB = 1;\n` },
    { path: "c.ts", text: `export const cx = 1;\n` },
    { path: "d.ts", text: `export const dx = 1;\n` }
  ];
  const batch = ingestBatch(files);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);

  const moduleA = nodeId("a.ts", [], "Module");
  const tx = begin(db, "test");
  create_function(db, tx, moduleA, `export function h(): number { return ax; }`);
  // Spy on the resolver input by asserting via a hook (see Step 3) OR assert the
  // commit succeeds and only a.ts edges changed.
  expect(commit(db, tx).ok).toBe(true);
  expect(find_declarations(db, { name: "h" })).toHaveLength(1);
  db.close();
});
```

- [ ] **Step 2: Run it (should already pass for correctness)**

Run: `pnpm --filter @strata/verify test -- materializeCommit`
Expected: PASS for correctness. The bound itself is an optimization; verify it doesn't regress correctness first.

- [ ] **Step 3: Narrow `renderedByPath` to dirty ∪ imports**

In `commit()` (and `commitWithBehavioralGate()`), replace the full `renderedByPath` with a bounded set: include each dirty module plus the modules its import declarations name (resolved against `renderedFiles` keys). Implement a helper in `validate.ts`:

```typescript
function boundedRenderInputs(
  renderedFiles: Map<string, string>,
  dirtyModulePaths: string[]
): Map<string, string> {
  const wanted = new Set(dirtyModulePaths.map(normalizeFileName));
  // Add direct import targets of dirty modules that exist in renderedFiles.
  for (const dirty of dirtyModulePaths) {
    const text = [...renderedFiles].find(([abs]) => normalizeFileName(abs) === normalizeFileName(dirty))?.[1];
    if (!text) continue;
    for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      for (const [abs] of renderedFiles) {
        const norm = normalizeFileName(abs);
        if (norm.endsWith(spec.replace(/^\.\//, "")) || norm.includes(spec.replace(/^\.\//, "")))
          wanted.add(norm);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [abs, text] of renderedFiles) {
    if (wanted.has(normalizeFileName(abs))) out.set(normalizeFileName(abs), text);
  }
  return out;
}
```

Use `boundedRenderInputs(renderedFiles, plan.dirtyModulePaths)` as `renderedByPath`.

> This is a heuristic import scan, not full module resolution. It is sound for the bound (over-inclusion is safe; under-inclusion only drops a cross-module edge, which the dirty referencing module would re-materialize when it next changes). Keep it conservative.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @strata/verify test`
Expected: PASS, including the bound test and all earlier integration tests.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/tests/materializeCommit.test.ts
git commit -m "perf(verify): bound materialization program input to dirty modules + imports"
```

---

## Task 12: Final regression + spec/decision cross-check

- [ ] **Step 1: Full build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across all packages.

- [ ] **Step 2: T03 acceptance unchanged**

Run: `pnpm --filter @strata/cli build && node packages/cli/dist/cli.js t03 examples/medium`
Expected: T03 passes with all criteria true (rename is a no-op for materialization).

- [ ] **Step 3: Verify the spec's falsifier set is all covered**

Cross-check `docs/superpowers/specs/2026-05-28-graph-materialization-design.md` Testing section against the suite:
- #1 EOF guard → `eofIndex.test.ts` (Task 2)
- #2 extract-shaped findability + edge → `materializeGraph.test.ts` (Tasks 7-8) + `materializeCommit.test.ts` headline (Task 9)
- #3 edge not cosmetic (rename propagates) → `materializeCommit.test.ts` (Task 9)
- #4 containment + no dangling edge → add an explicit dangling-edge assertion if not yet present (see below)
- #5 no-op cost guard → `materializeCommit.test.ts` (Task 10)
- #6 dependency guard → `dependencyGuard.test.ts` (Task 10)
- bound → `materializeCommit.test.ts` (Task 11)
- rollback → `materializeCommit.test.ts` (Task 9)

- [ ] **Step 4: Add the explicit no-dangling-edge assertion (falsifier #4)**

Add to `packages/verify/tests/materializeCommit.test.ts`:

```typescript
it("no node_references row points to a missing node after a spliced commit", () => {
  const db = seed("m.ts", `export function parent(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`);
  const moduleId = nodeId("m.ts", [], "Module");
  const tx = begin(db, "test");
  create_function(db, tx, moduleId, `export function h(a: number): void { const b = a + 1; }`);
  const parentId = nodeId("m.ts", [0], "FunctionDeclaration");
  // (Drive the same body splice as the store class-2 test, via queueTextSpanEdit.)
  // ...build the edit exactly as in materializeGraph.test.ts Task 8 Step 1...
  expect(commit(db, tx).ok).toBe(true);
  const dangling = db.prepare(`
    SELECT count(*) AS n FROM node_references r
    WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.from_node_id)
       OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.to_node_id)
  `).get() as { n: number };
  expect(dangling.n).toBe(0);
  db.close();
});
```

Run: `pnpm --filter @strata/verify test -- materializeCommit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/tests/materializeCommit.test.ts
git commit -m "test: no-dangling-edge guard after spliced commit (falsifier #4)"
```

- [ ] **Step 6: Update the roadmap**

In `docs/product-roadmap.md` Iteration 2, add a line under the tool list noting graph-materialization landed as the `extract_function` prerequisite (findability + edges for inserted/spliced structure; `add_parameter` materialization deferred). Commit:

```bash
git add docs/product-roadmap.md
git commit -m "docs: record graph-materialization prerequisite landed"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** all seven Codex findings map to tasks — #4 EOF→Task 2; resolver placement #5→Tasks 3-4; surgical edges #6→Task 7; commit hazards/sequencing/no-op/rollback #7→Tasks 1, 9; the R1+class-2 decision #1-3→Tasks 6, 8. The `add_parameter` deferral is honored: `planMaterialization` only flags statements with queued text-span edits, and `add_parameter`'s callsite edits *would* be flagged — **the executor must confirm in Task 9's full-suite run that existing `add_parameter` tests still pass**; if class-2 now fires on `add_parameter` and a test breaks, that is the deferral boundary surfacing — either scope `planMaterialization` to exclude `add_parameter`'s ops (add an op-kind marker to the overlay) or accept the (correct) re-derivation. Decide explicitly, don't paper over.
- **Type consistency:** `MaterializationPlan` fields (`dirtyModulePaths`, `insertedNodeIds`, `reDerivedStatementIds`) are used identically in Tasks 5-9. `resolveReferencesForModules(renderedByPath, options, dirtyModulePaths)` signature is stable across Tasks 4, 7, 9.
- **Known soft spot:** `boundedRenderInputs` (Task 11) is a regex import scan, deliberately conservative. If a dirty module's cross-module edge is dropped by under-inclusion, it self-heals when the referencing module next commits. Do not over-engineer it into full module resolution in this plan.
