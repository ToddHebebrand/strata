# move_declaration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move an exported, self-contained top-level declaration from its source module to a target module and rewrite every importer's named import so the codebase still type-checks — in one transaction (the bulk-propagation operation the substrate's cost edge is specific to).

**Architecture:** A pure analysis unit in `@strata/store` (`analyzeMove`) builds a `ts.Program`/`TypeChecker` over caller-supplied **rendered** text to verify the declaration is exported + self-contained, classify every importer (sole/mixed named import → handled; namespace/default/re-export/dynamic → rejection), and compute style-preserving import rewrites. The apply unit (`move_declaration`) recreates the declaration in the target (class-1 materialization, target-derived ID), deletes it from the source, queues importer import-statement edits (class-2), adds a back-import if the source still uses the symbol, and logs the op. Edges re-point via the commit-time materialization pass; `validate` (tsc) is the backstop. A shared `appendChildStatement` helper (extracted from `create_function`/`add_import`) does the EOF-shift insert for any declaration kind.

**Tech Stack:** TypeScript, `typescript` compiler API (`ts.createProgram`, `TypeChecker`, `getSymbolAtLocation`), `node:path`, `better-sqlite3`, Vitest. Monorepo: pnpm workspaces (`@strata/store`, `@strata/verify`, `@strata/agent`, `@strata/bench`).

**Spec:** `docs/superpowers/specs/2026-05-29-move-declaration-design.md` (approved 2026-05-29). Builds on graph-materialization + the extract_function pattern (both merged to `main`).

---

## Background the engineer needs

- **Node IDs are position+module derived.** `nodeId(modulePath, childIndexPath, kind)` (`packages/store/src/ids.ts`). A declaration's ID encodes its module path, so moving it across modules **necessarily changes its ID** — a move is delete-from-source + recreate-in-target. This ID churn is intentional and logged (decisions.md, Task 12).
- **Cross-module referencer discovery (the win):** `getReferencesByTo(db, toNodeId)` (exported from `@strata/store`) returns every `{ fromNodeId, toNodeId, kind }` edge pointing at a node — i.e. every identifier across all modules that resolves to the declaration, INCLUDING `import { X }` clause identifiers (the resolver follows import aliases). This is exactly what `rename_symbol` uses (`packages/store/src/rename.ts`). An identifier's containing statement node is `findNodeById(db, identifierId).parentId`; its module path is `modulePathOf(db, identifierId)`.
- **The declaration's name identifier:** `resolveDeclarationNameIdentifier(db, declarationId)` → the name `Identifier` NodeRow (handles JSDoc'd decls correctly). Use its `.id` for `getReferencesByTo`.
- **Declaration kinds:** ingest stores `const` as kind `"FirstStatement"` (TS alias for VariableStatement). The movable kinds are `FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `FirstStatement` (see `DECLARATION_KINDS` in `rename.ts`).
- **EOF-shift insert pattern:** both `create_function` and `add_import` append a node at the EOF child's index, then shift the `EndOfFileTrivia` node to index+1 with a re-derived ID (the 2026-05-28 off-by-one fix). Task 1 factors this into `appendChildStatement`.
- **Materialization:** at commit, `planMaterialization` reads `overlay.insertedNodeIds` (class-1: emit Identifier children) and `overlay.textSpanMutations.keys()` (class-2: re-derive that statement's identifiers), then `refreshReferenceEdges` recomputes edges over the dirty module set. So: recreate-in-target node → tracked via `trackInsertedNode` → class-1; importer import-statement edits → `queueTextSpanEdit` → class-2; the moved symbol's uses re-resolve to the new target declaration automatically. Proven by the re-ingest equivalence pattern.
- **Caller seam:** `buildAnalysisContext(db, tx)` (exported from `@strata/verify`) → `{ renderedByPath: Map<absPath,text>, options: ts.CompilerOptions }`. The agent tool / integration tests pass these into `move_declaration`. Store stays render-free.
- **Test seeding:** `const batch = ingestBatch(inputs); const db = openDb(":memory:"); insertNodes(db, batch.allNodes); insertReferences(db, batch.references);`. Use absolute `/project/...` paths so `validate`'s tsconfig discovery falls back to `tsconfig.base.json` (see extractFunctionCommit tests). The corpus `examples/medium` uses `.ts`-extension relative imports.
- **Shared compiler options for analysis tests:**
  ```typescript
  const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true
  };
  ```

## File structure

```
packages/store/src/appendChildStatement.ts   (new)    — shared EOF-shift insert, kind-parameterized
packages/store/src/createFunction.ts          (modify) — use appendChildStatement
packages/store/src/addImport.ts               (modify) — use appendChildStatement
packages/store/src/moveAnalysis.ts            (new)    — analyzeMove (pure): exported+self-contained checks, importer classification + rewrite computation
packages/store/src/moveDeclaration.ts         (new)    — move_declaration apply
packages/store/src/index.ts                   (modify) — barrel exports
packages/agent/src/tools.ts                   (modify) — move_declaration tool
packages/agent/src/prompt.ts                  (modify) — tool description
packages/bench/src/dogfoodMove.ts             (new)    — paired dogfood harness
packages/bench/src/dogfoodMoveCli.ts          (new)    — dogfood CLI
packages/bench/package.json                   (modify) — dogfood:move script

packages/store/tests/appendChildStatement.test.ts (new)
packages/store/tests/moveAnalysis.test.ts          (new)
packages/store/tests/moveDeclaration.test.ts       (new)
packages/verify/tests/moveDeclarationCommit.test.ts(new)
```

---

## Task 1: Extract `appendChildStatement` shared helper

Both `create_function` and `add_import` duplicate the EOF-shift insert. Factor it out so `move_declaration` can append a declaration of any kind without a third copy.

**Files:**
- Create: `packages/store/src/appendChildStatement.ts`
- Modify: `packages/store/src/createFunction.ts`, `packages/store/src/addImport.ts`, `packages/store/src/index.ts`
- Test: `packages/store/tests/appendChildStatement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/appendChildStatement.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren, findNodeById } from "../src/nodes";
import { begin } from "../src/transactions";
import { appendChildStatement } from "../src/appendChildStatement";
import { nodeId } from "../src/ids";

describe("appendChildStatement", () => {
  it("appends at the EOF index, shifts EOF, returns the new id, tracks for rollback", () => {
    const batch = ingestBatch([{ path: "m.ts", text: `export const x = 1;\n` }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const moduleId = nodeId("m.ts", [], "Module");
    const tx = begin(db, "t");

    const newId = appendChildStatement(
      db, tx, moduleId, "FunctionDeclaration", `\n\nexport function h(): void {}`
    );

    expect(newId).toBe(nodeId("m.ts", [1], "FunctionDeclaration"));
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length); // no collision
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(Math.max(...(indices as number[])));
    expect(findNodeById(db, newId)?.payload).toBe(`\n\nexport function h(): void {}`);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- appendChildStatement`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `packages/store/src/appendChildStatement.ts`:

```typescript
import { nodeId } from "./ids";
import { findNodeById, insertNodes, listChildren } from "./nodes";
import type { Db } from "./schema";
import { trackDeletedNodeForRestore, trackInsertedNode, type TxHandle } from "./transactions";

/**
 * Append a child statement node to a module at the re-ingest-consistent index
 * (the EOF child's index = number of real statements N), shifting the
 * EndOfFileTrivia node to N+1 with a re-derived id. The node is inserted into
 * the table immediately (visible within the tx) and tracked for rollback.
 * `payload` is the EXACT stored text (caller normalizes any leading separator).
 * Returns the new node's id. Shared by create_function, add_import,
 * move_declaration. (decisions.md 2026-05-28 EOF fix.)
 */
export function appendChildStatement(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  kind: string,
  payload: string
): string {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) throw new Error(`Module not found: ${moduleId}`);
  if (moduleNode.kind !== "Module") {
    throw new Error(`Node ${moduleId} is not a Module (kind=${moduleNode.kind})`);
  }
  const existing = listChildren(db, moduleId);
  const eof = existing.find((child) => child.kind === "EndOfFileTrivia");
  const nextChildIndex = eof ? eof.childIndex! : existing.length;
  const newId = nodeId(moduleNode.payload, [nextChildIndex], kind);
  if (existing.some((child) => child.id === newId)) {
    throw new Error(
      `appendChildStatement: a node with derived ID ${newId} already exists at module ${moduleId} child_index ${nextChildIndex}`
    );
  }

  insertNodes(db, [{ id: newId, kind, parentId: moduleId, childIndex: nextChildIndex, payload }]);
  trackInsertedNode(tx, newId);

  if (eof) {
    const shiftedIndex = nextChildIndex + 1;
    const shiftedEofId = nodeId(moduleNode.payload, [shiftedIndex], "EndOfFileTrivia");
    trackDeletedNodeForRestore(tx, eof);
    db.prepare(`DELETE FROM nodes WHERE id = ?`).run(eof.id);
    insertNodes(db, [
      { id: shiftedEofId, kind: "EndOfFileTrivia", parentId: moduleId, childIndex: shiftedIndex, payload: eof.payload }
    ]);
    trackInsertedNode(tx, shiftedEofId);
  }

  return newId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- appendChildStatement`
Expected: PASS.

- [ ] **Step 5: Refactor create_function to use it**

In `packages/store/src/createFunction.ts`, replace the block from `const existing = listChildren(db, moduleId);` through the EOF-shift `if (eof) { ... }` (the insert + EOF logic, ending before `queuePendingOp`) with:

```typescript
  const normalized = functionText.startsWith("\n") ? functionText : `\n\n${functionText}`;
  const newId = appendChildStatement(db, tx, moduleId, "FunctionDeclaration", normalized);
```

Add `import { appendChildStatement } from "./appendChildStatement";` and remove now-unused imports (`nodeId`, `insertNodes`, `listChildren`, `trackDeletedNodeForRestore`) from `createFunction.ts` ONLY if no longer referenced (keep `findNodeById`, `trackInsertedNode`? — `trackInsertedNode` is now inside the helper; remove from createFunction if unused; keep `findNodeById` for the module lookup and `queuePendingOp`). Verify by building.

- [ ] **Step 6: Refactor add_import to use it**

In `packages/store/src/addImport.ts`, replace the same insert+EOF block with:

```typescript
  const normalized = importText.startsWith("\n") ? importText : `\n${importText}`;
  const newId = appendChildStatement(db, tx, moduleId, "ImportDeclaration", normalized);
```

Add the import; prune now-unused imports. Keep the `validateImportText`/module-kind checks before the call.

- [ ] **Step 7: Export + run the full store + cli suites (regression guard)**

In `packages/store/src/index.ts` add `export { appendChildStatement } from "./appendChildStatement";`.

Run: `pnpm --filter @strata/store test && pnpm --filter @strata/cli build && pnpm --filter @strata/cli test`
Expected: PASS — create_function/add_import behavior unchanged (eofIndex, t03, stableIds, materialization tests all green).

- [ ] **Step 8: Commit**

```bash
git add packages/store/src/appendChildStatement.ts packages/store/src/createFunction.ts packages/store/src/addImport.ts packages/store/src/index.ts packages/store/tests/appendChildStatement.test.ts
git commit -m "refactor(store): extract appendChildStatement EOF-shift insert; reuse in create_function/add_import"
```

---

## Task 2: `analyzeMove` scaffolding — locate, exported, collision

Build the analysis program, locate the source declaration + target module, and reject non-exported declarations and target name collisions. No self-contained/importer logic yet.

**Files:**
- Create: `packages/store/src/moveAnalysis.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/moveAnalysis.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/moveAnalysis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeMove } from "../src/moveAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

// A declaration is located by (modulePath, childIndex, name). The analysis takes
// these plus the target module path and the rendered set.
describe("analyzeMove — scaffolding", () => {
  it("rejects a non-exported declaration", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `function helper(): number { return 1; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "helper", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/export/i);
  });

  it("rejects when the target already declares the same name", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const FOO = 1;\n`],
      ["/p/b.ts", `export const FOO = 2;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "FOO", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already|collision|exists/i);
  });

  it("accepts a self-contained exported decl with no importers (plan, empty rewrites)", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string | number;\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("Id");
    expect(r.importerRewrites).toEqual([]);
    expect(r.sourceStillUses).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scaffolding**

Create `packages/store/src/moveAnalysis.ts`:

```typescript
import ts from "typescript";
import path from "node:path";
import { createInMemoryProgram, normalizePath } from "./resolveReferences";

export interface MoveInput {
  sourcePath: string;
  declChildIndex: number;
  name: string;
  targetPath: string;
}

export interface ImporterRewrite {
  importerPath: string;
  /** child index of the importer's ImportDeclaration statement in its module. */
  importStatementIndex: number;
  style: "path-rewrite" | "split-out";
  /** path-rewrite: original specifier text incl. quotes, and its replacement (filled in Task 5). */
  oldSpecifier?: string;
  newSpecifier?: string;
  /** split-out: the symbol name to remove from this import's binding list (filled in Task 5). */
  removeName?: string;
  /** split-out: a new `import { X } from "<target>"` to append to the importer (filled in Task 5). */
  newImportText?: string;
}

export interface MovePlan {
  ok: true;
  name: string;
  declKind: string;
  declPayload: string;
  /** child index of the source declaration's statement in the source module. */
  sourceChildIndex: number;
  importerRewrites: ImporterRewrite[];
  sourceStillUses: boolean;
}

export interface MoveRejection {
  ok: false;
  reason: string;
}

export type MoveResult = MovePlan | MoveRejection;

function reject(reason: string): MoveRejection {
  return { ok: false, reason };
}

function buildProgram(rendered: Map<string, string>, options: ts.CompilerOptions) {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [p, text] of rendered) {
    sourceFiles.set(
      normalizePath(p),
      ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }
  const program = createInMemoryProgram(rendered, sourceFiles, options);
  return { program, checker: program.getTypeChecker(), sourceFiles };
}

function declName(stmt: ts.Statement): string | undefined {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
       ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && stmt.name) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name.text;
  }
  return undefined;
}

function isExported(stmt: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Analyze a candidate move. Pure: builds a program over the rendered set, no DB.
 * Self-contained verification + importer classification arrive in Tasks 3-5;
 * this scaffolding handles location, exported, and target-collision checks.
 */
export function analyzeMove(
  rendered: Map<string, string>,
  options: ts.CompilerOptions,
  input: MoveInput
): MoveResult {
  const { sourceFiles } = buildProgram(rendered, options);
  const srcSf = sourceFiles.get(normalizePath(path.resolve(input.sourcePath)))
    ?? sourceFiles.get(normalizePath(input.sourcePath));
  if (!srcSf) return reject(`move: source module not found in rendered set: ${input.sourcePath}`);
  const tgtSf = sourceFiles.get(normalizePath(path.resolve(input.targetPath)))
    ?? sourceFiles.get(normalizePath(input.targetPath));
  if (!tgtSf) return reject(`move: target module not found in rendered set: ${input.targetPath}`);

  const stmt = srcSf.statements[input.declChildIndex];
  if (!stmt || declName(stmt) !== input.name) {
    return reject(`move: no declaration named ${input.name} at ${input.sourcePath} index ${input.declChildIndex}`);
  }
  if (!isExported(stmt)) {
    return reject(`move: declaration ${input.name} is not exported; only exported declarations can be moved (importers need an export to import)`);
  }
  if (tgtSf.statements.some((s) => declName(s) === input.name)) {
    return reject(`move: target module already declares ${input.name} (name collision)`);
  }

  return {
    ok: true,
    name: input.name,
    declKind: ts.SyntaxKind[stmt.kind],
    declPayload: srcSf.text.slice(stmt.getStart(srcSf), stmt.getEnd()),
    sourceChildIndex: input.declChildIndex,
    importerRewrites: [],
    sourceStillUses: false
  };
}
```

In `packages/store/src/index.ts` add:

```typescript
export {
  analyzeMove,
  type MoveResult,
  type MovePlan,
  type MoveRejection,
  type MoveInput,
  type ImporterRewrite
} from "./moveAnalysis";
```

> Note: `declKind` from `ts.SyntaxKind[stmt.kind]` yields e.g. `"FunctionDeclaration"`, `"VariableStatement"`. The apply step maps `VariableStatement`→stored kind `"FirstStatement"` (ingest's alias) when needed; confirm against `findNodeById(declId).kind` in Task 6 (use the stored node's kind, not the parsed one, to avoid the alias mismatch).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: PASS (3 scaffolding tests).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveAnalysis.ts packages/store/src/index.ts packages/store/tests/moveAnalysis.test.ts
git commit -m "feat(store): analyzeMove scaffolding — locate, exported, target-collision checks"
```

---

## Task 3: `analyzeMove` — self-contained verification

Reject declarations that reference symbols not in scope at the target (source-local or imported), allowing globals/builtins, the declaration's own internals, and symbols already in the target module.

**Files:**
- Modify: `packages/store/src/moveAnalysis.ts`
- Test: `packages/store/tests/moveAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/store/tests/moveAnalysis.test.ts`:

```typescript
describe("analyzeMove — self-contained verification", () => {
  it("accepts a declaration that uses only globals + its own internals", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(Math.max(n, lo), hi);\n}\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "clamp", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
  });

  it("rejects a declaration that references a source-local symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    // scaled is statements[1]; it references BASE (source-local, statements[0]).
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "scaled", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/BASE|self-contained|depends/i);
  });

  it("rejects a declaration that references an imported symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/types.ts", `export type User = { id: string };\n`],
      ["/p/a.ts", `import { User } from "./types.ts";\nexport function idOf(u: User): string { return u.id; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "idOf", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/User|self-contained|depends/i);
  });

  it("accepts a declaration that references a symbol already in the target", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `import { User } from "./b.ts";\nexport function idOf(u: User): string { return u.id; }\n`],
      ["/p/b.ts", `export type User = { id: string };\n`]
    ]);
    // idOf uses User which lives in the TARGET (b.ts) — in scope after the move.
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "idOf", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: FAIL — scaffolding accepts all of these.

- [ ] **Step 3: Implement self-contained check**

In `packages/store/src/moveAnalysis.ts`, add a helper and call it from `analyzeMove` after the collision check (before the `return { ok: true, ... }`). Pass `checker` and `tgtSf` into scope — refactor `analyzeMove` to keep `checker`, `srcSf`, `tgtSf` available:

```typescript
/**
 * The declaration is self-contained iff every identifier in its subtree
 * resolves to: its own internals (decl inside the statement span), a global/lib
 * symbol (no rendered declaration), or a symbol declared in the TARGET module
 * (in scope after the move). Any other rendered-module declaration (source-local
 * or imported) means it depends on context that won't move with it → reject.
 */
function findDependencyDependency(
  checker: ts.TypeChecker,
  srcSf: ts.SourceFile,
  tgtSf: ts.SourceFile,
  stmt: ts.Statement
): string | null {
  const spanStart = stmt.getStart(srcSf);
  const spanEnd = stmt.getEnd();
  let bad: string | null = null;
  const walk = (node: ts.Node): void => {
    if (bad) return;
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      const decl = sym?.declarations?.[0];
      if (decl) {
        const declSf = decl.getSourceFile();
        const inLib = declSf.isDeclarationFile; // .d.ts / lib
        const inOwnSpan = declSf === srcSf && decl.getStart(declSf) >= spanStart && decl.getEnd() <= spanEnd;
        const inTarget = declSf === tgtSf;
        const inRendered = !inLib;
        if (inRendered && !inOwnSpan && !inTarget) {
          bad = sym!.getName();
          return;
        }
      }
    }
    node.forEachChild(walk);
  };
  walk(stmt);
  return bad;
}
```

Then in `analyzeMove`, before the success return:

```typescript
  const dep = findDependencyDependency(checker, srcSf, tgtSf, stmt);
  if (dep) {
    return reject(`move: declaration ${input.name} references \`${dep}\` which is not in scope at the target (v1 moves only self-contained declarations; relocate or keep it manually)`);
  }
```

(Rename `findDependencyDependency` to `findOutOfScopeDependency` — clearer. Use that name in both the definition and the call.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: PASS (scaffolding + 4 self-contained tests).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveAnalysis.ts packages/store/tests/moveAnalysis.test.ts
git commit -m "feat(store): analyzeMove self-contained verification (reject out-of-scope deps)"
```

---

## Task 4: `analyzeMove` — importer discovery + classification

Find every module importing the symbol from the source and classify each importer's import form. Reject non-named forms. (Rewrite computation is Task 5.) Discovery is done by scanning each rendered module's import declarations (the store-side `getReferencesByTo` is used in the APPLY step; the pure analysis scans the rendered ASTs so it needs no DB).

**Files:**
- Modify: `packages/store/src/moveAnalysis.ts`
- Test: `packages/store/tests/moveAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/store/tests/moveAnalysis.test.ts`:

```typescript
describe("analyzeMove — importer classification", () => {
  const base = (extra: Record<string, string>) =>
    new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ...Object.entries(extra)
    ]);

  it("rejects a namespace importer", () => {
    const r = analyzeMove(
      base({ "/p/c.ts": `import * as A from "./a.ts";\nexport const y: A.Id = "1";\n` }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/namespace|import \*/i);
  });

  it("rejects a re-export importer", () => {
    const r = analyzeMove(
      base({ "/p/c.ts": `export { Id } from "./a.ts";\n` }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/re-export|export .* from/i);
  });

  it("accepts named importers (sole and mixed) and records them", () => {
    const r = analyzeMove(
      base({
        "/p/c.ts": `import { Id } from "./a.ts";\nexport const y: Id = "1";\n`,
        "/p/d.ts": `import { Id, } from "./a.ts";\nimport { x } from "./b.ts";\nexport const z: Id = "2";\n`
      }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importerRewrites.map((i) => i.importerPath).sort()).toEqual(
      [normalizePathTest("/p/c.ts"), normalizePathTest("/p/d.ts")].sort()
    );
  });
});

// helper mirroring resolveReferences.normalizePath for assertion convenience
function normalizePathTest(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: FAIL — `importerRewrites` is `[]`.

- [ ] **Step 3: Implement discovery + classification**

In `packages/store/src/moveAnalysis.ts`, add. The classifier walks each module's `ImportDeclaration`s; if one imports `name` and its module specifier resolves to the source module, classify it. Reject non-named forms anywhere they import the symbol.

```typescript
/** Resolve a relative import specifier from an importer file to a normalized module key. */
function resolveSpecifier(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // bare/package — not our source
  const dir = path.dirname(normalizePath(importerPath));
  const joined = normalizePath(path.join(dir, specifier));
  return joined; // compared against source key (both may carry/omit extension; see caller)
}

/** True if two module keys refer to the same file, ignoring a .ts/.tsx/.js/.mjs extension. */
function sameModule(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/\.(ts|tsx|js|mjs)$/, "");
  return strip(a) === strip(b);
}

interface ImporterHit {
  importerPath: string;
  sf: ts.SourceFile;
  importDecl: ts.ImportDeclaration;
  /** index of this ImportDeclaration among the module's top-level statements. */
  statementIndex: number;
  /** the named bindings in this import (text of each specifier name). */
  bindingNames: string[];
}

/** Find/validate importers of `name` from `srcKey`. Returns hits or a rejection reason. */
function collectImporters(
  sourceFiles: Map<string, ts.SourceFile>,
  srcKey: string,
  name: string
): { hits: ImporterHit[] } | { reason: string } {
  const hits: ImporterHit[] = [];
  for (const [importerKey, sf] of sourceFiles) {
    if (sameModule(importerKey, srcKey)) continue; // skip the source module itself
    for (let i = 0; i < sf.statements.length; i++) {
      const stmt = sf.statements[i]!;
      // Re-export: export { X } from "./src"
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const resolved = resolveSpecifier(importerKey, stmt.moduleSpecifier.text);
        if (resolved && sameModule(resolved, srcKey) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)
            && stmt.exportClause.elements.some((e) => e.name.text === name)) {
          return { reason: `move: ${importerKey} re-exports ${name} (export { ${name} } from ...); v1 does not rewrite re-exports` };
        }
        continue;
      }
      if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const resolved = resolveSpecifier(importerKey, stmt.moduleSpecifier.text);
      if (!resolved || !sameModule(resolved, srcKey)) continue;
      const clause = stmt.importClause;
      if (!clause) continue; // side-effect import — doesn't bind the symbol
      // default import of the symbol
      if (clause.name && clause.name.text === name) {
        return { reason: `move: ${importerKey} imports ${name} as a default import; v1 handles named imports only` };
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        // import * as A — can't tell statically whether A.name is used; reject conservatively
        return { reason: `move: ${importerKey} uses a namespace import (import * as ${bindings.name.text}); v1 handles named imports only` };
      }
      if (bindings && ts.isNamedImports(bindings)) {
        const names = bindings.elements.map((e) => e.name.text);
        if (names.includes(name)) {
          hits.push({ importerPath: importerKey, sf, importDecl: stmt, statementIndex: i, bindingNames: names });
        }
      }
    }
  }
  return { hits };
}
```

Then in `analyzeMove`, replace `importerRewrites: []` in the success return by computing hits first (after the self-contained check):

```typescript
  const srcKey = normalizePath(path.resolve(input.sourcePath));
  const importers = collectImporters(sourceFiles, srcKey, input.name);
  if ("reason" in importers) return reject(importers.reason);
  // Task 5 fills in the specifier / split-out fields; this task records identity + style.
  const importerRewrites: ImporterRewrite[] = importers.hits.map((h) => ({
    importerPath: h.importerPath,
    importStatementIndex: h.statementIndex,
    style: h.bindingNames.length === 1 ? "path-rewrite" : "split-out"
  }));
```

Use `importerRewrites` in the return. (The `edit` spans are filled in Task 5; this task only asserts discovery/classification + importerPath.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: PASS (namespace/re-export rejected; named sole+mixed recorded).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveAnalysis.ts packages/store/tests/moveAnalysis.test.ts
git commit -m "feat(store): analyzeMove importer discovery + classification (reject non-named forms)"
```

---

## Task 5: `analyzeMove` — rewrite computation + source self-use

Turn importer hits into concrete edits: sole imports get a specifier path rewrite (style-preserving); mixed imports get a binding removed + a new target import. Detect whether the source module still uses the symbol.

**Files:**
- Modify: `packages/store/src/moveAnalysis.ts`
- Test: `packages/store/tests/moveAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/store/tests/moveAnalysis.test.ts`:

```typescript
describe("analyzeMove — rewrite computation", () => {
  it("sole import → specifier path rewrite, style preserved (.ts kept)", () => {
    const rendered = new Map<string, string>([
      ["/p/sub/a.ts", `export type Id = string;\n`],
      ["/p/lib/b.ts", `export const x = 1;\n`],
      ["/p/c.ts", `import { Id } from "./sub/a.ts";\nexport const y: Id = "1";\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/sub/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/lib/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rw = r.importerRewrites.find((i) => i.importerPath.endsWith("c.ts"))!;
    expect(rw.style).toBe("path-rewrite");
    // c.ts is at /p/c.ts; target /p/lib/b.ts → "./lib/b.ts"
    expect(rw.edit.newText).toBe(`"./lib/b.ts"`);
    expect(rw.edit.oldText).toBe(`"./sub/a.ts"`);
  });

  it("mixed import → remove the binding + add a new target import", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport type Other = number;\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ["/p/c.ts", `import { Id, Other } from "./a.ts";\nexport const y: Id = "1";\nexport const z: Other = 2;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rw = r.importerRewrites.find((i) => i.importerPath.endsWith("c.ts"))!;
    expect(rw.style).toBe("split-out");
    // binding removal turns `{ Id, Other }` into `{ Other }`
    expect(rw.edit.oldText + " => " + rw.edit.newText).toMatch(/Id/);
    expect(rw.newImportText).toBe(`import { Id } from "./b.ts";`);
  });

  it("detects source self-use", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport const first: Id = "1";\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    // a.ts itself uses Id (in `first`), so after moving Id a back-import is needed.
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceStillUses).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: FAIL — edits are empty / sourceStillUses false / no newImportText.

- [ ] **Step 3: Implement rewrite computation**

In `packages/store/src/moveAnalysis.ts`:

```typescript
/** Relative import path from importer to target, preserving the importer's extension style. */
function rewrittenSpecifier(importerPath: string, targetPath: string, originalSpecifier: string): string {
  const fromDir = path.dirname(normalizePath(importerPath));
  let rel = normalizePath(path.relative(fromDir, normalizePath(targetPath)));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  const hadExt = /\.(ts|tsx|js|mjs)$/.exec(originalSpecifier);
  if (!hadExt) rel = rel.replace(/\.(ts|tsx|js|mjs)$/, "");
  // if original had .ts and rel already ends in the right extension, keep as-is
  return rel;
}

/** Compute the binding-removal edit on a mixed `{ A, X, B }` import clause payload. */
function removeBindingEdit(
  importerText: string, importDecl: ts.ImportDeclaration, sf: ts.SourceFile, name: string, stmtStartInPayload: number
): { start: number; end: number; oldText: string; newText: string } {
  const named = importDecl.importClause!.namedBindings as ts.NamedImports;
  const elements = named.elements;
  const idx = elements.findIndex((e) => e.name.text === name);
  const el = elements[idx]!;
  // Remove the element plus one adjacent comma. Offsets are relative to the
  // statement payload (importer statement node payload), so subtract stmtStart.
  let start = el.getStart(sf);
  let end = el.getEnd();
  if (idx < elements.length - 1) {
    // remove trailing comma + whitespace up to next element start
    end = elements[idx + 1]!.getStart(sf);
  } else if (idx > 0) {
    // last element: remove leading comma after previous element's end
    start = elements[idx - 1]!.getEnd();
  }
  const relStart = start - stmtStartInPayload;
  const relEnd = end - stmtStartInPayload;
  const oldText = importerText.slice(relStart, relEnd);
  return { start: relStart, end: relEnd, oldText, newText: "" };
}
```

> IMPORTANT — payload-relative offsets. The store node payload for an importer's `ImportDeclaration` is that statement's own text (sliced at ingest), NOT the whole module. But `analyzeMove` parses the whole rendered MODULE, so AST offsets are module-relative. The apply step (Task 7) re-parses the importer's *payload* and recomputes the edit there, exactly like `extract_function` does the payload-coordinate splice. Therefore `analyzeMove` must emit edits in terms the apply step can re-derive: emit `style`, `importStatementIndex`, the target `name`, the `newSpecifier` text, and (for split-out) `newImportText` — NOT module-relative spans. Revise `ImporterRewrite` to carry semantic intent, and let Task 7 compute payload offsets.

The `ImporterRewrite` interface (defined in Task 2) is already offset-free; this task fills in the specifier / split-out fields. Replace the Task-4 mapping (which set only `importerPath`/`importStatementIndex`/`style`) with:

```typescript
  const importerRewrites: ImporterRewrite[] = importers.hits.map((h) => {
    const spec = (h.importDecl.moduleSpecifier as ts.StringLiteral);
    const originalSpecifierText = spec.text; // without quotes
    const quote = h.sf.text[spec.getStart(h.sf)] ?? '"';
    const newRel = rewrittenSpecifier(h.importerPath, input.targetPath, originalSpecifierText);
    if (h.bindingNames.length === 1) {
      return {
        importerPath: h.importerPath, importStatementIndex: h.statementIndex, style: "path-rewrite" as const,
        oldSpecifier: `${quote}${originalSpecifierText}${quote}`, newSpecifier: `${quote}${newRel}${quote}`
      };
    }
    return {
      importerPath: h.importerPath, importStatementIndex: h.statementIndex, style: "split-out" as const,
      removeName: input.name, newImportText: `import { ${input.name} } from ${quote}${newRel}${quote};`
    };
  });
```

Delete the now-unused `removeBindingEdit` helper from this file (binding removal happens in Task 7 on the payload). Keep `rewrittenSpecifier`.

For **source self-use**: after the self-contained check, walk the source module statements OTHER than the declaration and OTHER than import statements; if any identifier resolves to the declaration's symbol, set `sourceStillUses = true`:

```typescript
function sourceUsesSymbol(checker: ts.TypeChecker, srcSf: ts.SourceFile, declStmt: ts.Statement, name: string): boolean {
  const declSym = checker.getSymbolAtLocation(
    (declStmt as ts.FunctionDeclaration).name ??
    ((declStmt as ts.VariableStatement).declarationList?.declarations[0]?.name as ts.Node)
  );
  let used = false;
  for (const stmt of srcSf.statements) {
    if (stmt === declStmt || ts.isImportDeclaration(stmt)) continue;
    const walk = (n: ts.Node): void => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name && checker.getSymbolAtLocation(n) === declSym) { used = true; return; }
      n.forEachChild(walk);
    };
    walk(stmt);
  }
  return used;
}
```

Set `sourceStillUses: sourceUsesSymbol(checker, srcSf, stmt, input.name)` in the return.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveAnalysis`
Expected: PASS (path-rewrite specifier; split-out removeName + newImportText; source self-use).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveAnalysis.ts packages/store/tests/moveAnalysis.test.ts
git commit -m "feat(store): analyzeMove rewrite computation (sole path-rewrite, mixed split-out) + source self-use"
```

---

## Task 6: `move_declaration` apply — recreate-in-target + delete-from-source

The move mechanism: recreate the declaration in the target (new ID, class-1), delete from source (tracked for rollback), return the manifest skeleton. Importer rewrites are Task 7.

**Files:**
- Create: `packages/store/src/moveDeclaration.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/moveDeclaration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/moveDeclaration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, insertReferences, findNodeById, listChildren } from "../src/nodes";
import { begin } from "../src/transactions";
import { move_declaration } from "../src/moveDeclaration";
import { nodeId } from "../src/ids";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true
};

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const rendered = new Map(inputs.map((i) => [i.path, i.text]));
  return { db, rendered };
}

describe("move_declaration apply — move mechanism", () => {
  it("recreates the declaration in the target and deletes it from the source", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export type Id = string | number;\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");

    const manifest = move_declaration(db, tx, declId, targetId, rendered, OPTIONS);

    expect(manifest.name).toBe("Id");
    expect(findNodeById(db, declId)).toBeUndefined(); // deleted from source
    const moved = findNodeById(db, manifest.newDeclarationId)!;
    expect(moved.kind).toBe("TypeAliasDeclaration");
    expect(moved.payload).toContain("export type Id = string | number;");
    // new id is target-derived
    expect(manifest.newDeclarationId).not.toBe(declId);
    expect(manifest.targetModulePath).toContain("b.ts");
    db.close();
  });

  it("throws a specific reason on a non-self-contained move (no overlay mutation)", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");
    expect(() => move_declaration(db, tx, declId, targetId, rendered, OPTIONS)).toThrow(/BASE|self-contained|depends/i);
    expect(findNodeById(db, declId)).toBeDefined(); // untouched
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveDeclaration`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the move mechanism (no importer rewrites yet)**

Create `packages/store/src/moveDeclaration.ts`:

```typescript
import ts from "typescript";
import path from "node:path";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { appendChildStatement } from "./appendChildStatement";
import { resolveDeclarationNameIdentifier } from "./declarationName";
import { getReferencesByTo } from "./references";
import { queuePendingOp, trackDeletedNodeForRestore, type TxHandle } from "./transactions";
import { analyzeMove, type ImporterRewrite } from "./moveAnalysis";

export interface MoveDeclarationManifest {
  newDeclarationId: string;
  name: string;
  sourceModulePath: string;
  targetModulePath: string;
  importersRewritten: { modulePath: string; style: ImporterRewrite["style"] }[];
  sourceBackImportAdded: boolean;
}

export function move_declaration(
  db: Db,
  tx: TxHandle,
  declarationId: string,
  targetModuleId: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): MoveDeclarationManifest {
  const decl = findNodeById(db, declarationId);
  if (!decl) throw new Error(`move_declaration: declaration not found: ${declarationId}`);
  if (decl.parentId === null || decl.childIndex === null) {
    throw new Error(`move_declaration: ${declarationId} is not a top-level declaration`);
  }
  const target = findNodeById(db, targetModuleId);
  if (!target || target.kind !== "Module") {
    throw new Error(`move_declaration: target ${targetModuleId} is not a Module`);
  }
  const sourceModulePath = modulePathOf(db, declarationId);
  const targetModulePath = target.payload;
  if (decl.parentId === targetModuleId) {
    throw new Error(`move_declaration: declaration already lives in the target module`);
  }

  const nameId = resolveDeclarationNameIdentifier(db, declarationId);
  if (!nameId) throw new Error(`move_declaration: declaration ${declarationId} has no name identifier`);
  const name = (JSON.parse(nameId.payload) as { text: string }).text;

  const analysis = analyzeMove(renderedByPath, options, {
    sourcePath: sourceModulePath, declChildIndex: decl.childIndex, name, targetPath: targetModulePath
  });
  if (!analysis.ok) throw new Error(analysis.reason);

  // Recreate in target (class-1). Payload keeps a leading blank-line separator.
  const normalized = decl.payload.startsWith("\n") ? decl.payload : `\n\n${decl.payload.replace(/^\s+/, "")}`;
  const newDeclarationId = appendChildStatement(db, tx, targetModuleId, decl.kind, normalized);

  // Delete from source: the declaration node + its Identifier children + their edges.
  const idChildren = listChildren(db, declarationId).filter((c) => c.kind === "Identifier");
  const delEdges = db.prepare(`DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`);
  const delNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);
  const drop = db.transaction(() => {
    for (const ch of [...idChildren, decl]) {
      trackDeletedNodeForRestore(tx, ch);
      delEdges.run(ch.id, ch.id);
      delNode.run(ch.id);
    }
  });
  drop();

  // Importer rewrites + back-import: Task 7. Manifest skeleton for now.
  queuePendingOp(tx, {
    kind: "MoveDeclaration",
    paramsJson: JSON.stringify({
      declaration_id: declarationId, new_node_id: newDeclarationId,
      name, source: sourceModulePath, target: targetModulePath,
      importer_count: analysis.importerRewrites.length
    }),
    affectedNodeIdsJson: JSON.stringify([newDeclarationId, declarationId]),
    reasoning: null
  });

  return {
    newDeclarationId,
    name,
    sourceModulePath,
    targetModulePath,
    importersRewritten: analysis.importerRewrites.map((r) => ({ modulePath: r.importerPath, style: r.style })),
    sourceBackImportAdded: false
  };
}

export const moveDeclaration = move_declaration;
```

In `packages/store/src/index.ts` add:

```typescript
export { move_declaration, moveDeclaration, type MoveDeclarationManifest } from "./moveDeclaration";
```

> Note: `decl.kind` is the STORED kind (e.g. `"FirstStatement"` for const) — pass it straight to `appendChildStatement` so the recreated node's id matches a clean re-ingest. Do not use the parsed `ts.SyntaxKind` name here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveDeclaration`
Expected: PASS (recreate+delete; non-self-contained throws before mutation).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveDeclaration.ts packages/store/src/index.ts packages/store/tests/moveDeclaration.test.ts
git commit -m "feat(store): move_declaration recreate-in-target + delete-from-source"
```

---

## Task 7: `move_declaration` apply — importer rewrites + back-import

Apply each importer rewrite on the importer's ImportDeclaration payload (sole: specifier; mixed: binding removal + new import), and add a back-import to the source if it still uses the symbol.

**Files:**
- Modify: `packages/store/src/moveDeclaration.ts`
- Test: `packages/store/tests/moveDeclaration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/store/tests/moveDeclaration.test.ts`:

```typescript
import { queueTextSpanEdit, getOverlay } from "../src/transactions";
import { listModules } from "../src/nodes";

function importDeclFor(db: ReturnType<typeof openDb>, modulePath: string, name: string) {
  const mod = listModules(db).find((m) => m.payload.endsWith(modulePath))!;
  return listChildren(db, mod.id).filter((c) => c.kind === "ImportDeclaration")
    .find((c) => c.payload.includes(name));
}

describe("move_declaration apply — importer rewrites", () => {
  it("rewrites a sole importer's specifier and adds a back-import when source still uses it", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export type Id = string;\nexport const first: Id = "1";\n` },
      { path: "/project/lib/b.ts", text: `export const x = 1;\n` },
      { path: "/project/c.ts", text: `import { Id } from "./a.ts";\nexport const y: Id = "z";\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/lib/b.ts", [], "Module");
    const tx = begin(db, "t");

    const manifest = move_declaration(db, tx, declId, targetId, rendered, OPTIONS);

    expect(manifest.sourceBackImportAdded).toBe(true); // a.ts still uses Id in `first`
    expect(manifest.importersRewritten.map((i) => i.style)).toContain("path-rewrite");

    // c.ts ImportDeclaration got a queued text-span edit rewriting "./a.ts" -> "./lib/b.ts"
    const cImport = importDeclFor(db, "c.ts", "Id")!;
    const edits = getOverlay(tx).textSpanMutations.get(cImport.id);
    expect(edits).toBeDefined();
    expect(edits!.some((e) => e.newText === `"./lib/b.ts"` && e.oldText === `"./a.ts"`)).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- moveDeclaration`
Expected: FAIL — no edit queued; sourceBackImportAdded false.

- [ ] **Step 3: Implement importer rewrites + back-import**

In `packages/store/src/moveDeclaration.ts`, add imports `import { add_import } from "./addImport"; import { queueTextSpanEdit } from "./transactions";` and helper to find an importer's ImportDeclaration node by module path + statement index. Replace the "Importer rewrites + back-import: Task 7" comment + the skeleton return with:

```typescript
  // Build module-path -> Module node id map for importer lookups.
  const moduleByPath = new Map<string, string>();
  for (const m of listChildrenModules(db)) moduleByPath.set(normalizeKey(m.payload), m.id);

  let sourceBackImportAdded = false;
  for (const rw of analysis.importerRewrites) {
    const importerModuleId = moduleByPath.get(normalizeKey(rw.importerPath));
    if (!importerModuleId) continue; // importer not in store (shouldn't happen)
    const importStmt = nthImportDeclaration(db, importerModuleId, rw.importStatementIndex);
    if (!importStmt) continue;
    if (rw.style === "path-rewrite") {
      // Replace the specifier text inside the importer statement payload.
      const at = importStmt.payload.indexOf(rw.oldSpecifier!);
      if (at < 0) continue;
      queueTextSpanEdit(tx, importStmt.id, {
        start: at, end: at + rw.oldSpecifier!.length, oldText: rw.oldSpecifier!, newText: rw.newSpecifier!
      });
    } else {
      // split-out: remove the binding from this import's payload + add a new import.
      const removal = computeBindingRemoval(importStmt.payload, rw.removeName!);
      if (removal) queueTextSpanEdit(tx, importStmt.id, removal);
      add_import(db, tx, importerModuleId, rw.newImportText!);
    }
  }

  if (analysis.sourceStillUses) {
    const srcModuleId = decl.parentId; // still the source module id
    const rel = relativeImport(sourceModulePath, targetModulePath, name);
    add_import(db, tx, srcModuleId, rel);
    sourceBackImportAdded = true;
  }
```

Add these helpers at the bottom of `moveDeclaration.ts`:

```typescript
import { listModules } from "./nodes";

function listChildrenModules(db: Db) {
  return listModules(db);
}
function normalizeKey(p: string): string {
  return path.resolve(p).replaceAll("\\", "/");
}
function nthImportDeclaration(db: Db, moduleId: string, statementIndex: number) {
  // statementIndex is the child index among the module's top-level statements.
  return listChildren(db, moduleId).find(
    (c) => c.childIndex === statementIndex && c.kind === "ImportDeclaration"
  );
}
/** Remove `name` (and one adjacent comma) from a `{ ... }` import payload; payload-relative span. */
function computeBindingRemoval(payload: string, name: string): { start: number; end: number; oldText: string; newText: string } | null {
  const sf = ts.createSourceFile("__imp__.ts", payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  if (!stmt || !ts.isImportDeclaration(stmt) || !stmt.importClause?.namedBindings) return null;
  const named = stmt.importClause.namedBindings;
  if (!ts.isNamedImports(named)) return null;
  const els = named.elements;
  const idx = els.findIndex((e) => e.name.text === name);
  if (idx < 0) return null;
  let start = els[idx]!.getStart(sf);
  let end = els[idx]!.getEnd();
  if (idx < els.length - 1) end = els[idx + 1]!.getStart(sf);
  else if (idx > 0) start = els[idx - 1]!.getEnd();
  return { start, end, oldText: payload.slice(start, end), newText: "" };
}
/** Build a back-import statement for the source module, style-matched to a sibling import if any. */
function relativeImport(fromModulePath: string, toModulePath: string, name: string): string {
  const fromDir = path.dirname(normalizeKey(fromModulePath));
  let rel = path.relative(fromDir, normalizeKey(toModulePath)).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // Source corpus convention: keep .ts extension (matches examples/medium). If the
  // source had extensionless imports, tsc with bundler resolution still resolves;
  // prefer .ts to match the dominant corpus style.
  return `import { ${name} } from "${rel}";`;
}
```

(Replace the `listChildrenModules`/`listChildrenModules(db)` call name typo: use `listModules(db)` directly. Remove the redundant `listChildrenModules` wrapper.)

Set `sourceBackImportAdded` in the returned manifest (replace the `false`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- moveDeclaration`
Expected: PASS (sole specifier rewrite queued; back-import added).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/moveDeclaration.ts packages/store/tests/moveDeclaration.test.ts
git commit -m "feat(store): move_declaration importer rewrites (sole + split-out) + source back-import"
```

---

## Task 8: Agent tool surface + prompt

**Files:**
- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/prompt.ts`

- [ ] **Step 1: Add the tool**

In `packages/agent/src/tools.ts`, add `move_declaration` to the `@strata/store` import block (`buildAnalysisContext` is already imported from `@strata/verify` for extract_function). Register a tool next to `extractFunctionTool`:

```typescript
  const moveDeclarationTool = tool(
    "move_declaration",
    "Move an exported top-level declaration (function/class/interface/type/const) from its current module to a different module, and rewrite EVERY importer's import path to point at the new module — all in one operation in the open transaction you pass. You give the declaration's node ID and the target module's node ID; the tool finds all importers through the reference graph and rewrites them (a sole `import { X } from \"old\"` has its path rewritten; a mixed `import { X, Y }` has X split out into a new import from the target). If the source module still uses the symbol, a back-import is added there. You do NOT, and must not, hand-edit importers afterward — they are already rewritten, so editing them yourself double-edits the transaction. The moved declaration gets a new node ID (IDs encode the module); use find_declarations to re-locate it after commit. The tool REFUSES, with a specific reason, moves it cannot do safely: a declaration that references source-local or imported symbols (v1 moves only self-contained declarations — those using just globals, their own internals, or symbols already in the target), a non-exported declaration, a target that already declares the name, or importers that use namespace/default/re-export/dynamic forms. Requires an open transaction; mutates the overlay only.",
    {
      tx: txHandleSchema,
      declaration_id: nodeIdSchema,
      target_module_id: nodeIdSchema
    },
    async (args) => {
      const { renderedByPath, options } = buildAnalysisContext(ctx.db, args.tx as TxHandle);
      const manifest = move_declaration(
        ctx.db, args.tx as TxHandle, args.declaration_id, args.target_module_id, renderedByPath, options
      );
      return textResult({ ok: true, ...manifest });
    }
  );
```

- [ ] **Step 2: Register the tool + update tool-count tests**

Add `moveDeclarationTool` to the returned tools array and `"move_declaration"` to `STRATA_TOOL_NAMES` (grep for `extractFunctionTool` to find both sites). Update the tool-count assertions (currently 18 → 19) in `packages/agent/tests/elevenTools.test.ts` and `packages/agent/tests/tools.test.ts`, adding `"move_declaration"` to the sorted name lists.

- [ ] **Step 3: Update the prompt**

In `packages/agent/src/prompt.ts`, add to the structural-tools description paragraph:

```
move_declaration relocates an exported declaration to another module and rewrites every importer's import path automatically (and adds a back-import to the source if it still uses the symbol); the moved declaration gets a new node ID, so re-find it with find_declarations after commit. It refuses moves of declarations that depend on source-local or imported symbols (v1 moves only self-contained ones), non-exported declarations, target name collisions, and namespace/default/re-export/dynamic importers.
```

And add to the tool-selection guidance sentence: "… move_declaration for relocating a declaration to a different module and rewiring its importers; …".

- [ ] **Step 4: Build + test the agent package**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS (19-tool surface; replay/keyed tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/prompt.ts packages/agent/tests/elevenTools.test.ts packages/agent/tests/tools.test.ts
git commit -m "feat(agent): surface move_declaration tool + prompt"
```

---

## Task 9: Integration — commit a move end to end

**Files:**
- Create: `packages/verify/tests/moveDeclarationCommit.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/verify/tests/moveDeclarationCommit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  openDb, insertNodes, insertReferences, begin,
  move_declaration, find_declarations, get_references, listModules, loadModule, nodeId
} from "@strata/store";
import { render } from "@strata/render";
import { buildAnalysisContext, commit } from "../src/validate";

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}
function renderAll(db: ReturnType<typeof openDb>) {
  return listModules(db).map((m) => {
    const loaded = loadModule(db, m.id);
    return { path: m.payload, text: render(loaded.module, loaded.children) };
  });
}
function nodeIds(db: ReturnType<typeof openDb>) {
  return new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
}
function refKeys(db: ReturnType<typeof openDb>) {
  return new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
}

describe("move_declaration commit (integration)", () => {
  it("moves a symbol imported by 2 modules; commits clean; importers resolve to the new decl; re-ingest equivalent", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export type Id = string | number;\n` },
      { path: "/project/shared.ts", text: `export const VERSION = 1;\n` },
      { path: "/project/c.ts", text: `import { Id } from "./a.ts";\nexport const y: Id = "1";\n` },
      { path: "/project/d.ts", text: `import { Id } from "./a.ts";\nexport const z: Id = 2;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/shared.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = move_declaration(db, tx, declId, targetId, renderedByPath, options);
    expect(manifest.importersRewritten).toHaveLength(2);

    expect(commit(db, tx).ok).toBe(true);

    // Found in the target, not the source.
    const found = find_declarations(db, { name: "Id" });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(manifest.newDeclarationId);
    // Both importers' uses resolve to the new declaration (real edges).
    expect(get_references(db, found[0]!.id).length).toBeGreaterThanOrEqual(2);

    // Re-ingest equivalence: committed graph == clean re-ingest of rendered text.
    const live = nodeIds(db), liveR = refKeys(db);
    const batch = ingestBatch(renderAll(db));
    const reNodes = new Set(batch.allNodes.map((n) => n.id));
    const reRefs = new Set(batch.references.map((r) => `${r.fromNodeId}|${r.toNodeId}|${r.kind}`));
    expect([...reNodes].filter((i) => !live.has(i))).toEqual([]);
    expect([...live].filter((i) => !reNodes.has(i))).toEqual([]);
    expect([...reRefs].filter((r) => !liveR.has(r))).toEqual([]);
    expect([...liveR].filter((r) => !reRefs.has(r))).toEqual([]);
    db.close();
  });

  it("mixed-import importer (split-out) commits clean and resolves", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export type Id = string;\nexport type Other = number;\n` },
      { path: "/project/shared.ts", text: `export const VERSION = 1;\n` },
      { path: "/project/c.ts", text: `import { Id, Other } from "./a.ts";\nexport const y: Id = "1";\nexport const z: Other = 2;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/shared.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    move_declaration(db, tx, declId, targetId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "Id" })).toHaveLength(1);
    expect(find_declarations(db, { name: "Other" })).toHaveLength(1); // untouched
    db.close();
  });

  it("rolls back cleanly when the move would not type-check", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export const NEEDED = 5;\nexport function uses(): number { return NEEDED; }\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    // Force a tsc failure path: move NEEDED away but `uses` (left in a.ts) still
    // references it WITHOUT a back-import being applicable (uses is a separate decl).
    // analyzeMove will add a back-import for NEEDED since a.ts still uses it, so this
    // commits clean — instead, assert a genuine reject: move `uses` which depends on NEEDED.
    const declId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => move_declaration(db, tx, declId, targetId, renderedByPath, options)).toThrow(/NEEDED|self-contained|depends/i);
    expect(commit(db, tx).ok).toBe(true); // empty tx commits fine; nothing moved
    expect(find_declarations(db, { name: "uses" })).toHaveLength(1); // still in a.ts
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @strata/store build && pnpm --filter @strata/verify build && pnpm --filter @strata/verify test -- moveDeclarationCommit`
Expected: PASS. If re-ingest equivalence fails, inspect the missing/stale node or edge — that is a real coordinate/materialization bug, not a test artifact (do not weaken the assertion).

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/moveDeclarationCommit.test.ts
git commit -m "test(verify): move_declaration commit integration — findability, edges, equivalence, split-out, rollback"
```

---

## Task 10: Real-corpus move

**Files:**
- Modify: `packages/verify/tests/moveDeclarationCommit.test.ts`

- [ ] **Step 1: Write the real-corpus test**

Add to `packages/verify/tests/moveDeclarationCommit.test.ts`:

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function loadMedium() {
  const root = path.resolve(__dirname, "../../../examples/medium/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts")) files.push({ path: full.replaceAll("\\", "/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return { root, files };
}

describe("move_declaration on the real corpus", () => {
  it("moves a self-contained exported symbol from types.ts to a new home and rewrites importers (or refuses with a reason)", () => {
    const { root, files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Find a self-contained exported TYPE/const in types.ts (parse for the first
    // type alias whose body is primitive-only), and a different module as target.
    const typesPath = `${root}/types.ts`;
    const typesMod = listModules(db).find((m) => m.payload === typesPath);
    const clockPath = `${root}/clock.ts`;
    const clockMod = listModules(db).find((m) => m.payload === clockPath);
    expect(typesMod && clockMod).toBeTruthy();
    if (!typesMod || !clockMod) return;

    // Pick the first exported TypeAliasDeclaration child of types.ts.
    const candidate = loadModule(db, typesMod.id).children.find((c) => c.kind === "TypeAliasDeclaration");
    if (!candidate) { console.log("no type alias in types.ts; skipping"); return; }

    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    let moved = true;
    try {
      move_declaration(db, tx, candidate.id, clockMod.id, renderedByPath, options);
    } catch (e) {
      moved = false; // self-contained / importer-shape refusal is acceptable
      console.log("move refused:", (e as Error).message);
    }
    if (moved) {
      const result = commit(db, tx);
      expect(result.ok).toBe(true);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @strata/verify test -- moveDeclarationCommit`
Expected: PASS (moves green OR refused-with-reason; never corrupts).

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/moveDeclarationCommit.test.ts
git commit -m "test(verify): move_declaration real-corpus probe (tolerant)"
```

---

## Task 11: `dogfood:move` paired harness

A keyed paired dogfood paralleling `dogfood:extract`, for the bulk-propagation validation. Non-keyed parts (arg parse, key-gate, verification) must be verifiable without spend.

**Files:**
- Create: `packages/bench/src/dogfoodMove.ts`, `packages/bench/src/dogfoodMoveCli.ts`
- Modify: `packages/bench/package.json`

- [ ] **Step 1: Implement the harness**

Create `packages/bench/src/dogfoodMove.ts` modeled on `packages/bench/src/dogfoodExtract.ts` (read it first for the exact shape of `DogfoodArmCost`, `costFromLog`, the substrate/baseline arm runners, ratios, and markdown rendering). Differences:
- `EXTRACT_DOGFOOD_PROMPT` → `MOVE_DOGFOOD_PROMPT`:
  ```typescript
  export const MOVE_DOGFOOD_PROMPT =
    "Move the User type (and only that declaration) from src/types/user.ts into " +
    "a new home in src/types.ts, and update every file that imports it so the " +
    "project still type-checks. Keep behavior identical.";
  ```
  (Operator may override with `--prompt`. Pick a symbol that exists in the corpus and is imported by ≥2 modules; `User` from `src/types/user.ts` is imported 5×.)
- Verification (`verifyMove(text-by-path)` instead of `verifyFlags`): parse the resulting corpus; the move is performed iff (a) the symbol's declaration is gone from the source module and present in the target module, and (b) no importer still imports it from the old path. Return `{ movedToTarget, removedFromSource, importersRepointed, performed }`.
- Quality floor (symmetric, like the corrected extract harness): tsc-clean + `performed`. `vitestPassed` informational (examples/medium ships the pre-existing T05 failing test).
- For the substrate arm, render every module from the db (reuse `listModules`+`loadModule`+`render`) to get the resulting text-by-path; for the baseline arm, read the kept temp tree files.

Create `packages/bench/src/dogfoodMoveCli.ts` modeled on `dogfoodExtractCli.ts` (arg parse, key-gate requiring `ANTHROPIC_API_KEY`, `--prompt`/`--model`/`--max-turns`/`--wall-ms`/`--out-dir`/`--json-out`, exit 0 iff both arms quality-pass else 2).

- [ ] **Step 2: Wire the script**

In `packages/bench/package.json` scripts add:

```json
    "dogfood:move": "node dist/dogfoodMoveCli.js"
```

- [ ] **Step 3: Build + verify non-keyed behavior**

Run:
```bash
pnpm --filter @strata/bench build
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN node packages/bench/dist/dogfoodMoveCli.js examples/medium ; echo "exit=$?"
```
Expected: prints the key-gate message and exits 1 (no spend). Then sanity-check `verifyMove` with a tiny `node --input-type=module` snippet importing the built `dogfoodMove.js`: a before/after corpus where the symbol moved → `performed:true`; the original corpus → `performed:false`.

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/dogfoodMove.ts packages/bench/src/dogfoodMoveCli.ts packages/bench/package.json
git commit -m "feat(bench): dogfood:move harness — move_declaration substrate vs file-tools (bulk propagation)"
```

> The KEYED run is operator-triggered and budgeted (not part of this plan). Per decisions.md 2026-05-29, this is the bulk-propagation task the substrate is predicted to win; the operator runs `pnpm --filter @strata/bench dogfood:move -- "$PWD/examples/medium" --out-dir "$PWD/packages/bench/results"` and the result is recorded then.

---

## Task 12: Final regression + decisions + roadmap

- [ ] **Step 1: Full build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across all packages. (A cli/verify subprocess test can flake under parallel load; re-run that one package in isolation to confirm, per the 30s vitest timeouts added earlier.)

- [ ] **Step 2: T03 acceptance unchanged**

Run: `pnpm --filter @strata/cli build && node packages/cli/dist/cli.js t03 examples/medium`
Expected: all criteria true (move_declaration doesn't touch the rename path).

- [ ] **Step 3: Log the decisions**

Append a 2026-05-29 entry to `decisions.md` recording: (a) move_declaration v1 shipped — surface, self-contained boundary (allows globals/own/target-module symbols; rejects source-local/imported), named-imports-only (sole path-rewrite, mixed split-out), back-import for source self-use, rejection list; (b) **ID churn is intentional** — a cross-module move is delete-from-source + recreate-in-target, so the moved declaration + its identifiers get new target-derived IDs and reference edges re-point via the materialization pass; logged per the design-doc "stable IDs across mutations" invariant which permits logged churn; (c) `appendChildStatement` extracted and now shared by create_function/add_import/move_declaration. Commit:

```bash
git add decisions.md
git commit -m "docs: log move_declaration v1 decisions (surface, ID churn, appendChildStatement)"
```

- [ ] **Step 4: Update the roadmap**

In `docs/product-roadmap.md`, check off `move_declaration` under Iteration 2 with a one-line note (cross-module move + importer rewrite; bulk-propagation class; v1 self-contained + named-imports-only; dogfood:move harness ready for keyed validation). Commit:

```bash
git add docs/product-roadmap.md
git commit -m "docs: mark move_declaration landed in the roadmap"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** surface/signature → Tasks 6-8; exported/collision/self-contained → Tasks 2-3; importer discovery + classification + rewrite (sole/mixed) → Tasks 4-5, 7; back-import → Tasks 5,7; ID churn + recreate/delete → Task 6; materialization+validate → Task 9 (equivalence/rollback); real corpus → Task 10; dogfood → Task 11; decisions/roadmap → Task 12. The `appendChildStatement` DRY extraction (Task 1) is foundational.
- **Type consistency:** `analyzeMove(rendered, options, MoveInput)` and `move_declaration(db, tx, declId, targetModuleId, renderedByPath, options)` are stable across Tasks 2-11. `ImporterRewrite` is defined once (Task 2) in its final offset-free shape (`importerPath`, `importStatementIndex`, `style`, optional `oldSpecifier`/`newSpecifier` for path-rewrite, optional `removeName`/`newImportText` for split-out); Task 4 sets identity+style, Task 5 fills the specifier/split fields, Task 7 consumes them. `MovePlan` fields (`name`, `declKind`, `declPayload`, `sourceChildIndex`, `importerRewrites`, `sourceStillUses`) are used in Task 6.
- **Two-coordinate discipline:** `analyzeMove` works in rendered-module coordinates and emits OFFSET-FREE rewrite intents; `move_declaration` (apply) computes payload-relative spans by re-parsing each importer's stored `ImportDeclaration` payload (`computeBindingRemoval`) or `indexOf(oldSpecifier)` for the specifier — never mix module offsets into payload edits. Same discipline as extract_function.
- **Known soft spots:** (1) `computeBindingRemoval` comma handling is the fiddliest code — its dedicated mixed-import integration test (Task 9) is the guard. (2) `sameModule`/extension-stripping path matching assumes relative specifiers; bare/package specifiers are correctly skipped (never the source). (3) back-import always emits a `.ts` extension to match examples/medium; a corpus with extensionless imports would still resolve under bundler resolution but the style would differ — acceptable v1, noted. (4) the moved declaration's payload may carry source indentation; render canonicalizes at commit, and IDs are position-derived, so equivalence holds (same argument as extract_function).
