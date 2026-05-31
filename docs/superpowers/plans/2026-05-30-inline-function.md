# inline_function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every call site of an expression-body function with the function's body (arguments substituted for parameters), delete the declaration, and strip it from importers — in one transaction (a bulk-propagation operation, the substrate's cost-win class).

**Architecture:** A pure analysis unit in `@strata/store` (`analyzeInline`) builds a `ts.Program`/`TypeChecker` over caller-supplied **rendered** text to: normalize the declaration to `{params, bodyExpr}` across four accepted forms; verify the body is self-contained + hazard-free; discover every reference via the rendered program and verify each value use is a **pure-argument direct call**; and compute each call site's offset-free substitution intent (hygienic AST param→arg substitution, parenthesized). The apply unit (`inline_function`) re-parses each call-site statement's stored **payload** to splice the substitution (two-coordinate discipline), deletes the declaration + re-indexes source siblings via a new shared `removeChildStatement` helper (extracted from `move_declaration`), strips importers (remove binding / remove now-empty import statement), and logs the op. The whole inline is **all-or-nothing**: any unsafe call site refuses before mutating. Commit-time materialization re-derives the changed call-site statements (class-2); `validate` (tsc) is the type backstop.

**Tech Stack:** TypeScript, `typescript` compiler API (`ts.createProgram`, `TypeChecker`, `getSymbolAtLocation`, `getAliasedSymbol`), `node:path`, `better-sqlite3`, Vitest. Monorepo: pnpm workspaces (`@strata/store`, `@strata/verify`, `@strata/agent`, `@strata/bench`).

**Spec:** `docs/superpowers/specs/2026-05-29-inline-function-design.md` (approved 2026-05-29). Builds on `move_declaration` (merged to `main` 2026-05-29) and graph-materialization.

---

## Background the engineer needs

- **inline is the inverse of extract and a sibling of move.** Read these merged files first — inline reuses their patterns nearly verbatim:
  - `packages/store/src/moveAnalysis.ts` — the pure-analysis shape: `buildProgram`, `normalizePath`/`createInMemoryProgram` (from `resolveReferences`), `declName`/`declNameNode`, `isExported`, `findOutOfScopeDependency` (self-containment with `getAliasedSymbol` alias following), `collectImporters`/`resolveSpecifier`/`sameModule`, the `MoveResult = MovePlan | MoveRejection` discriminated union.
  - `packages/store/src/moveDeclaration.ts` — the apply shape: `findNodeById`, `modulePathOf`, `resolveDeclarationNameIdentifier`, `queueTextSpanEdit`, `queuePendingOp`, `trackDeletedNodeForRestore`, `trackDeletedEdgeForRestore`, `computeBindingRemoval` (strip a named binding from an import payload), `nthImportDeclaration`, `listModules`, and **the source-deletion + sibling-re-index block** (the `drop` transaction that deletes the decl + its Identifier children + edges, then re-indexes surviving siblings + `EndOfFileTrivia` DOWN by one). Task 1 extracts that block into `removeChildStatement`.
  - `packages/store/src/transactions.ts` — `deletedEdgesToRestore`, `trackDeletedEdgeForRestore`, and the **first-seen-wins guard** in `trackDeletedNodeForRestore` (an id inserted earlier this tx then re-deleted is ephemeral, not restored). These already exist (from move); inline reuses them unchanged.
  - `packages/store/src/materializeGraph.ts` — `planMaterialization` (turns `overlay.insertedNodeIds`, skipping `EndOfFileTrivia`, into emitted identifiers + dirty modules; turns `overlay.textSpanMutations.keys()` into re-derived statements), `emitIdentifiersForInserted`, `reDeriveChangedStatements`, `refreshReferenceEdges`. A call-site statement whose text we splice re-derives as **class-2** automatically.
- **Reference discovery (the bulk win):** resolve the function's name identifier via `resolveDeclarationNameIdentifier(db, fnId)`, then `getReferencesByTo(db, nameId)` returns every `{ fromNodeId, toNodeId, kind }` edge pointing at the function — every identifier across all modules that resolves to it, INCLUDING `import { f }` clause identifiers. This is what `rename`/`move` use. BUT the **pure analysis** (`analyzeInline`) does reference discovery over the rendered `ts.Program` (like `analyzeMove`'s `collectImporters`), not the DB, so it needs no DB — the apply step uses node lookups for the splice coordinates.
- **Node IDs are position+module derived:** `nodeId(modulePath, childIndexPath, kind)` (`packages/store/src/ids.ts`). Deleting a top-level statement at child index K means every surviving sibling at index > K (and the `EndOfFileTrivia` node) must be re-indexed DOWN by one — their ids change. This is exactly what `move_declaration` does for its source module; Task 1 extracts it.
- **Declaration kinds:** ingest stores `const` as kind `"FirstStatement"` (TS alias for VariableStatement); `function` as `"FunctionDeclaration"`. Use the **stored** node kind (`findNodeById(id).kind`), not the parsed `ts.SyntaxKind` name.
- **Caller seam:** `buildAnalysisContext(db, tx)` (exported from `@strata/verify`) → `{ renderedByPath: Map<absPath,text>, options: ts.CompilerOptions }`. The agent tool / integration tests pass these into `inline_function`. Store stays render-free.
- **Test seeding:** `const batch = ingestBatch(inputs); const db = openDb(":memory:"); insertNodes(db, batch.allNodes); insertReferences(db, batch.references);`. Use absolute `/project/...` paths. **Store-level analysis tests** (no commit) may use `.ts`-extension relative imports. **Commit-path integration tests** (`@strata/verify`) MUST use **extensionless** relative imports (`"./a"`, not `"./a.ts"`) — the synthetic `/project` corpus resolves via `tsconfig.base.json` which is Node10 without `allowImportingTsExtensions`, so `.ts`-extension specifiers fail tsc (this is the lesson from the move integration test; see `packages/verify/tests/moveDeclarationCommit.test.ts`).
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
packages/store/src/removeChildStatement.ts   (new)    — shared delete-top-level-statement + re-index-siblings-down helper
packages/store/src/moveDeclaration.ts         (modify) — use removeChildStatement (DRY)
packages/store/src/inlineAnalysis.ts          (new)    — analyzeInline (pure): normalize decl, body scan, reference/call validation, substitution intents, importer strip plan
packages/store/src/inlineFunction.ts          (new)    — inline_function apply
packages/store/src/index.ts                   (modify) — barrel exports
packages/agent/src/tools.ts                   (modify) — inline_function tool (20th)
packages/agent/src/prompt.ts                  (modify) — tool description
packages/bench/src/dogfoodInline.ts           (new)    — paired dogfood harness
packages/bench/src/dogfoodInlineCli.ts         (new)    — dogfood CLI
packages/bench/package.json                   (modify) — dogfood:inline script

packages/store/tests/removeChildStatement.test.ts  (new)
packages/store/tests/inlineAnalysis.test.ts        (new)
packages/store/tests/inlineFunction.test.ts        (new)
packages/verify/tests/inlineFunctionCommit.test.ts (new)
```

---

## Task 1: Extract `removeChildStatement` shared helper

`move_declaration` open-codes "delete a top-level statement + its Identifier children + edges, then re-index surviving siblings + EOF DOWN by one (captured for rollback)." `inline_function` needs the identical operation. Factor it out (parallel to `appendChildStatement`) and refactor `move_declaration` to use it — behavior-preserving.

**Files:**
- Create: `packages/store/src/removeChildStatement.ts`
- Modify: `packages/store/src/moveDeclaration.ts`, `packages/store/src/index.ts`
- Test: `packages/store/tests/removeChildStatement.test.ts`

- [ ] **Step 1: Read the current move source-deletion block**

Open `packages/store/src/moveDeclaration.ts` and locate the `drop` `db.transaction` that (a) deletes the moved declaration node + its `Identifier` children + their `node_references` edges, and (b) re-indexes surviving siblings + the `EndOfFileTrivia` node down by one (delete-all-then-insert-all), capturing deleted nodes via `trackDeletedNodeForRestore` and edges via `trackDeletedEdgeForRestore`, and tracking re-inserted survivors via `trackInsertedNode`. This block is the body of the new helper.

- [ ] **Step 2: Write the failing test**

Create `packages/store/tests/removeChildStatement.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, insertReferences, findNodeById, listChildren } from "../src/nodes";
import { begin, rollback } from "../src/transactions";
import { removeChildStatement } from "../src/removeChildStatement";
import { nodeId } from "../src/ids";

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("removeChildStatement", () => {
  it("deletes a top-level statement and re-indexes surviving siblings + EOF down by one", () => {
    const db = seed([{ path: "/p/a.ts", text: `export type A = string;\nexport const KEEP = 1;\n` }]);
    const moduleId = nodeId("/p/a.ts", [], "Module");
    const aId = nodeId("/p/a.ts", [0], "TypeAliasDeclaration");
    const tx = begin(db, "t");

    removeChildStatement(db, tx, moduleId, 0);

    expect(findNodeById(db, aId)).toBeUndefined(); // removed
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length); // no collision / gap-free
    // KEEP shifted 1 -> 0
    expect(findNodeById(db, nodeId("/p/a.ts", [0], "FirstStatement"))).toBeDefined();
    expect(findNodeById(db, nodeId("/p/a.ts", [1], "FirstStatement"))).toBeUndefined();
    // EOF shifted 2 -> 1
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(1);
    db.close();
  });

  it("restores nodes AND edges on rollback", () => {
    const db = seed([
      { path: "/p/a.ts", text: `export type Id = string;\nexport const first: Id = "1";\n` }
    ]);
    const moduleId = nodeId("/p/a.ts", [], "Module");
    const nodesBefore = new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
    const edgesBefore = new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
    expect(edgesBefore.size).toBeGreaterThan(0);

    const tx = begin(db, "t");
    removeChildStatement(db, tx, moduleId, 0); // remove `Id`
    rollback(db, tx);

    const nodesAfter = new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
    const edgesAfter = new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
    expect([...nodesAfter].sort()).toEqual([...nodesBefore].sort());
    expect([...edgesAfter].sort()).toEqual([...edgesBefore].sort());
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- removeChildStatement`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the helper**

Create `packages/store/src/removeChildStatement.ts`. Move the source-deletion + re-index logic out of `moveDeclaration.ts` verbatim, parameterized by `(db, tx, moduleId, childIndex)`. Shape:

```typescript
import { nodeId } from "./ids";
import { findNodeById, insertNodes, listChildren } from "./nodes";
import type { Db } from "./schema";
import { trackDeletedNodeForRestore, trackInsertedNode, type TxHandle } from "./transactions";
import type { Reference } from "./references"; // confirm the exported row type name

/**
 * Remove the top-level statement at `childIndex` from `moduleId`: delete that
 * node + its Identifier children + their reference edges, then re-index every
 * surviving sibling AND the EndOfFileTrivia node DOWN by one (a node's
 * childIndex is part of its id, so the survivors get re-derived ids). All
 * deleted rows + edges are captured for rollback (trackDeletedNodeForRestore /
 * trackDeletedEdgeForRestore); re-inserted survivors are tracked as inserted
 * (trackInsertedNode) so commit re-emits their identifiers + edges. The first
 * top-level-statement *deletion* primitive (appendChildStatement only shifts UP).
 * Shared by move_declaration (source side) and inline_function.
 */
export function removeChildStatement(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  childIndex: number
): void {
  // ... the exact block currently in moveDeclaration.ts:
  //  1. find the module's modulePath (findNodeById(moduleId).payload).
  //  2. find the statement node at childIndex (listChildren filter).
  //  3. gather the deleted set = [that node + its Identifier children].
  //  4. gather surviving siblings (childIndex > childIndex), sorted asc, incl. EOF.
  //  5. capture all edges touching {deleted set ∪ survivors ∪ their identifier children}
  //     via SELECT ... WHERE from_node_id IN (...) OR to_node_id IN (...); trackDeletedEdgeForRestore.
  //  6. trackDeletedNodeForRestore each old row (deleted set + survivors + survivors' identifiers).
  //  7. delete-all (nodes + edges) then insert survivors at childIndex-1 with re-derived ids;
  //     trackInsertedNode each re-inserted survivor.
}
```

IMPORTANT: lift the EXISTING move code so behavior is byte-identical (it captures edges via `trackDeletedEdgeForRestore` and re-inserts survivors as `trackInsertedNode`). The helper takes the childIndex of the statement to remove and does BOTH the removal and the re-index. Confirm the real `Reference` row type name + the edge-capture query already used in moveDeclaration.ts and reuse them. Use `trackDeletedEdgeForRestore` (already exported from transactions.ts).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- removeChildStatement`
Expected: PASS (delete + re-index; rollback restores nodes + edges).

- [ ] **Step 6: Refactor move_declaration to use it**

In `packages/store/src/moveDeclaration.ts`, replace the open-coded source-deletion + re-index block with a single call `removeChildStatement(db, tx, decl.parentId, decl.childIndex)` (the source module id is `decl.parentId`). Keep everything else (the target recreate via `appendChildStatement`, importer rewrites, back-import, manifest). Remove now-unused imports from `moveDeclaration.ts` (e.g. the edge-capture query, `trackDeletedEdgeForRestore` if no longer used directly there) only if genuinely unreferenced.

- [ ] **Step 7: Export + full regression**

In `packages/store/src/index.ts` add `export { removeChildStatement } from "./removeChildStatement";`.

Run: `pnpm --filter @strata/store test && pnpm --filter @strata/verify build && pnpm --filter @strata/verify test -- moveDeclarationCommit && pnpm --filter @strata/cli build && pnpm --filter @strata/cli test`
Expected: PASS — move's store tests + the move commit integration (incl. re-ingest equivalence + rollback) + cli T03 all green. The refactor must not change move's behavior.

- [ ] **Step 8: Commit**

```bash
git add packages/store/src/removeChildStatement.ts packages/store/src/moveDeclaration.ts packages/store/src/index.ts packages/store/tests/removeChildStatement.test.ts
git commit -m "refactor(store): extract removeChildStatement; reuse in move_declaration"
```
End commit messages with the trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 2: `analyzeInline` scaffolding — locate + normalize declaration form

Build the analysis program, locate the declaration, and normalize the four accepted expression-body forms to `{ params: string[]; bodyExprText: string; bodyExprNode }`. Reject non-expression-body shapes, non-identifier params, generics, multi-declarator const. No reference/importer/substitution logic yet.

**Files:**
- Create: `packages/store/src/inlineAnalysis.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/inlineAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/store/tests/inlineAnalysis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeInline } from "../src/inlineAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true
};

// A declaration is located by (modulePath, childIndex, name).
describe("analyzeInline — scaffolding (normalize + shape rejection)", () => {
  it("accepts a function declaration with a single returned expression (no refs → empty plan)", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("dbl");
    expect(r.callSites).toEqual([]);
    expect(r.importerStrips).toEqual([]);
  });

  it("accepts an arrow const with a concise expression body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const dbl = (n: number): number => n * 2;\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
  });

  it("accepts an arrow const with a single-return block body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const dbl = (n: number): number => { return n * 2; };\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
  });

  it("rejects a multi-statement body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(n: number): number { const x = n + 1; return x * 2; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/single|expression|one returned|multi/i);
  });

  it("rejects a generic function", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function id<T>(x: T): T { return x; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "id" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/generic|type parameter/i);
  });

  it("rejects a destructured parameter", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f({ a }: { a: number }): number { return a; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/parameter|identifier|destructur/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scaffolding**

Read `packages/store/src/moveAnalysis.ts` for `buildProgram`, `normalizePath`/`createInMemoryProgram` (from `./resolveReferences`), and the result-union pattern. Create `packages/store/src/inlineAnalysis.ts`:

```typescript
import ts from "typescript";
import path from "node:path";
import { createInMemoryProgram, normalizePath } from "./resolveReferences";

export interface InlineInput {
  functionPath: string;
  functionChildIndex: number;
  name: string;
}

export interface SubstitutionIntent {
  callSitePath: string;       // normalized module key of the call-site statement
  callSiteStatementIndex: number; // child index of the containing top-level statement
  replacementText: string;    // parenthesized inlined expression (params→args substituted)
}

export interface ImporterStrip {
  importerPath: string;
  importStatementIndex: number;
  style: "removed-statement" | "removed-binding";
  removeName?: string;        // for removed-binding
}

export interface InlinePlan {
  ok: true;
  name: string;
  callSites: SubstitutionIntent[];
  importerStrips: ImporterStrip[];
}
export interface InlineRejection { ok: false; reason: string; }
export type InlineResult = InlinePlan | InlineRejection;

function reject(reason: string): InlineRejection { return { ok: false, reason }; }

// Normalize the four accepted forms to params + body-expression node.
interface NormalizedFn {
  params: ts.ParameterDeclaration[];
  bodyExpr: ts.Expression;
  typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>;
}
function normalizeDeclaration(stmt: ts.Statement): NormalizedFn | { reason: string } {
  // FunctionDeclaration with block { return <expr>; }
  if (ts.isFunctionDeclaration(stmt)) {
    return fromFunctionLike(stmt, stmt.body);
  }
  // const f = (…) => <expr>  |  const f = (…) => { return <expr>; }  |  const f = function(…){ return <expr>; }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length !== 1) return { reason: "inline: only a single-declarator const is supported" };
    const init = decls[0]!.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      if (ts.isArrowFunction(init) && !ts.isBlock(init.body)) {
        // concise expression body
        return { params: [...init.parameters], bodyExpr: init.body, typeParameters: init.typeParameters };
      }
      return fromFunctionLike(init, init.body as ts.Block | undefined);
    }
    return { reason: "inline: declaration initializer is not an arrow/function expression" };
  }
  return { reason: "inline: not an inlinable function declaration (expected function declaration or const arrow/function)" };
}
function fromFunctionLike(
  fn: { parameters: ts.NodeArray<ts.ParameterDeclaration>; typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> },
  body: ts.Block | undefined
): NormalizedFn | { reason: string } {
  if (!body || body.statements.length !== 1) {
    return { reason: "inline: body must be exactly one returned expression (v1 inlines expression-body functions only)" };
  }
  const only = body.statements[0]!;
  if (!ts.isReturnStatement(only) || !only.expression) {
    return { reason: "inline: body must be a single `return <expr>;`" };
  }
  return { params: [...fn.parameters], bodyExpr: only.expression, typeParameters: fn.typeParameters };
}

export function analyzeInline(
  rendered: Map<string, string>,
  options: ts.CompilerOptions,
  input: InlineInput
): InlineResult {
  const { sourceFiles, checker } = buildProgram(rendered, options); // mirror moveAnalysis.buildProgram
  const fnKey = normalizePath(path.resolve(input.functionPath));
  const sf = sourceFiles.get(fnKey) ?? sourceFiles.get(normalizePath(input.functionPath));
  if (!sf) return reject(`inline: function module not found in rendered set: ${input.functionPath}`);
  const stmt = sf.statements[input.functionChildIndex];
  if (!stmt) return reject(`inline: no statement at ${input.functionPath} index ${input.functionChildIndex}`);

  const norm = normalizeDeclaration(stmt);
  if ("reason" in norm) return reject(norm.reason);
  if (norm.typeParameters && norm.typeParameters.length > 0) {
    return reject(`inline: ${input.name} is generic; v1 does not inline functions with type parameters`);
  }
  for (const p of norm.params) {
    if (!ts.isIdentifier(p.name)) return reject(`inline: ${input.name} has a non-identifier parameter (destructuring/pattern); v1 supports plain identifier params only`);
    if (p.dotDotDotToken) return reject(`inline: ${input.name} has a rest parameter; v1 supports plain identifier params only`);
    if (p.initializer) return reject(`inline: ${input.name} has a default-valued parameter; v1 supports plain identifier params only`);
  }

  // Tasks 3-6 fill these.
  return { ok: true, name: input.name, callSites: [], importerStrips: [] };
}
```

Add a `buildProgram` mirroring `moveAnalysis.ts` (returns `{ program, checker, sourceFiles }`). In `packages/store/src/index.ts` add:
```typescript
export {
  analyzeInline,
  type InlineResult, type InlinePlan, type InlineRejection,
  type InlineInput, type SubstitutionIntent, type ImporterStrip
} from "./inlineAnalysis";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: PASS (3 accept forms + 3 shape rejections).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineAnalysis.ts packages/store/src/index.ts packages/store/tests/inlineAnalysis.test.ts
git commit -m "feat(store): analyzeInline scaffolding — normalize 4 forms, reject shape hazards"
```

---

## Task 3: `analyzeInline` — body scan (hazards + self-containment)

Reject `this`/`super`/`arguments`/`await`, recursion, and out-of-scope free variables in the body expression. The body may reference only its parameters and globals/builtins.

**Files:**
- Modify: `packages/store/src/inlineAnalysis.ts`
- Test: `packages/store/tests/inlineAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/store/tests/inlineAnalysis.test.ts`:

```typescript
describe("analyzeInline — body scan", () => {
  it("accepts a body using only params + globals", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function clamp(n: number, lo: number, hi: number): number { return Math.min(Math.max(n, lo), hi); }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "clamp" });
    expect(r.ok).toBe(true);
  });

  it("rejects a body referencing a module-local free variable", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 1, name: "scaled" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/BASE|self-contained|scope/i);
  });

  it("rejects a body referencing an imported symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/c.ts", `export const K = 2;\n`],
      ["/p/a.ts", `import { K } from "./c.ts";\nexport function f(n: number): number { return n * K; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 1, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/K|self-contained|scope/i);
  });

  it("rejects a recursive function", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(n: number): number { return n <= 0 ? 0 : f(n - 1); }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/recurs/i);
  });

  it("rejects a body using this", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(): number { return (this as any).x; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/this|super|arguments/i);
  });

  it("rejects a body using await", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export async function f(p: Promise<number>): Promise<number> { return await p; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/await|async/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: FAIL — scaffolding accepts these.

- [ ] **Step 3: Implement the body scan**

In `analyzeInline`, after the param checks and before the success return, add a body scan. Reuse the self-containment idea from `moveAnalysis.ts`'s `findOutOfScopeDependency` (including `getAliasedSymbol` alias-following, guarded by try/catch). The function's own symbol is the recursion target.

```typescript
  // Resolve the function's own symbol (the declaration name) for recursion detection.
  const fnNameNode = declNameNodeForInline(stmt); // function name OR const variable name
  const fnSym = fnNameNode ? checker.getSymbolAtLocation(fnNameNode) : undefined;

  // Collect the parameter symbols.
  const paramSyms = new Set<ts.Symbol>();
  for (const p of norm.params) {
    const s = checker.getSymbolAtLocation(p.name);
    if (s) paramSyms.add(s);
  }

  let bodyReason: string | null = null;
  const scan = (node: ts.Node): void => {
    if (bodyReason) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      bodyReason = `inline: ${input.name} body uses this/super; not safe to inline`; return;
    }
    if (ts.isIdentifier(node) && node.text === "arguments") {
      bodyReason = `inline: ${input.name} body uses arguments; not safe to inline`; return;
    }
    if (ts.isAwaitExpression(node)) {
      bodyReason = `inline: ${input.name} body uses await; v1 does not inline async expression bodies`; return;
    }
    if (ts.isIdentifier(node) && !isMemberPropertyName(node)) {
      let sym = checker.getSymbolAtLocation(node);
      if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
      const decl = sym?.declarations?.[0];
      if (sym && fnSym && sym === fnSym) { bodyReason = `inline: ${input.name} is recursive; cannot inline`; return; }
      if (decl) {
        const declSf = decl.getSourceFile();
        const inLib = declSf.isDeclarationFile;
        const isParam = sym ? paramSyms.has(sym) : false;
        if (!inLib && !isParam) {
          bodyReason = `inline: ${input.name} body references \`${sym!.getName()}\` which is not a parameter or global (v1 inlines only self-contained expression bodies)`;
          return;
        }
      }
    }
    node.forEachChild(scan);
  };
  scan(norm.bodyExpr);
  if (bodyReason) return reject(bodyReason);
```

Add helpers: `declNameNodeForInline(stmt)` (function name identifier, or the const variable name identifier), and `isMemberPropertyName(id)` (true when `id` is the `.name` of a `PropertyAccessExpression` — those are not free variables; e.g. `Math.min` → `min` is a property name). Verify against the real TS API:
```typescript
function isMemberPropertyName(id: ts.Identifier): boolean {
  const p = id.parent;
  return ts.isPropertyAccessExpression(p) && p.name === id;
}
```
(Note: `Math` in `Math.min` is an identifier resolving to a lib `.d.ts` global → allowed by `inLib`. `min` is a property name → skipped. Object-literal property names / shorthand also handled by `isMemberPropertyName` and by being non-symbols; verify the `clamp` test passes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: PASS (self-contained accept; module-local + imported free var reject; recursion; this; await).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineAnalysis.ts packages/store/tests/inlineAnalysis.test.ts
git commit -m "feat(store): analyzeInline body scan — reject this/await/recursion/out-of-scope deps"
```

---

## Task 4: `analyzeInline` — reference discovery + call classification

Find every reference to the function across the rendered program. Partition out the declaration's own name and named-import bindings. Every remaining value-position use must be the callee of a direct `CallExpression` with matching arity and no spread arg. Reject any non-call use (value/callback, re-export, default/namespace import, dynamic import, bare property access). (Argument purity + substitution text is Task 5; this task records the call-site location + the `CallExpression` node.)

**Files:**
- Modify: `packages/store/src/inlineAnalysis.ts`
- Test: `packages/store/tests/inlineAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/store/tests/inlineAnalysis.test.ts`:

```typescript
describe("analyzeInline — reference discovery + call classification", () => {
  const fn = `export function dbl(n: number): number { return n * 2; }\n`;

  it("accepts direct calls across modules and records call-site count", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const y = dbl(3);\n`],
      ["/p/c.ts", `import { dbl } from "./a.ts";\nexport const z = dbl(4);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites.length).toBe(2);
  });

  it("rejects a non-call value use (passed as a callback)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const ys = [1, 2].map(dbl);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/value|callback|not a (direct )?call/i);
  });

  it("rejects a re-export", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `export { dbl } from "./a.ts";\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/re-export|export .* from|value|not a (direct )?call/i);
  });

  it("rejects a spread-argument call", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nconst args: [number] = [3];\nexport const y = dbl(...args);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/spread|arity|argument/i);
  });

  it("rejects an arity mismatch", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function add(a: number, b: number): number { return a + b; }\n`],
      ["/p/b.ts", `import { add } from "./a.ts";\nexport const y = (add as any)(1);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "add" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/arity|argument count/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: FAIL — `callSites` empty / non-call uses not rejected.

- [ ] **Step 3: Implement reference discovery + classification**

In `analyzeInline`, after the body scan, walk every rendered SourceFile for identifiers named `input.name` that resolve to the function symbol (`checker.getSymbolAtLocation(id)`, alias-followed, `=== fnSym`). Classify each:

```typescript
  const callExprs: { sf: ts.SourceFile; call: ts.CallExpression }[] = [];
  let refReason: string | null = null;
  for (const file of sourceFiles.values()) {
    const visit = (node: ts.Node): void => {
      if (refReason) return;
      if (ts.isIdentifier(node) && node.text === input.name && !isMemberPropertyName(node)) {
        let sym = checker.getSymbolAtLocation(node);
        if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
        if (sym && fnSym && sym === fnSym) {
          // It's a reference to our function. Classify by parent.
          if (node === fnNameNode) { /* the declaration itself */ }
          else if (isNamedImportBinding(node)) { /* importer; handled in Task 6 */ }
          else if (isDirectCallee(node)) {
            const call = node.parent as ts.CallExpression;
            if (call.arguments.some((a) => ts.isSpreadElement(a))) { refReason = `inline: ${input.name} is called with a spread argument; cannot map args to params`; return; }
            if (call.arguments.length !== norm.params.length) { refReason = `inline: a call to ${input.name} has ${call.arguments.length} args but the function takes ${norm.params.length} (arity mismatch)`; return; }
            callExprs.push({ sf: file, call });
          } else {
            refReason = `inline: ${input.name} is used as a value (not a direct call) at ${normalizePath(file.fileName)}; v1 inlines only direct calls`;
            return;
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  if (refReason) return reject(refReason);
```

Helpers (verify against the real TS API):
```typescript
function isDirectCallee(id: ts.Identifier): boolean {
  const p = id.parent;
  return ts.isCallExpression(p) && p.expression === id;
}
function isNamedImportBinding(id: ts.Identifier): boolean {
  // import { f } from "..."  →  the ImportSpecifier name (or its alias local).
  const p = id.parent;
  return ts.isImportSpecifier(p) || (ts.isImportClause(p));
}
```
Note on re-export (`export { dbl } from "./a"`): the `dbl` there is an `ExportSpecifier`, NOT a direct callee and NOT a named-import binding → falls into the `else` branch → rejected with "used as a value / not a direct call". That satisfies the re-export test. (If you prefer a more specific message, special-case `ts.isExportSpecifier(p)`.)

For now, record only the call locations (the substitution text is Task 5). Convert each `callExprs` entry to a partial `SubstitutionIntent` carrying `callSitePath = normalizePath(file.fileName)` and `callSiteStatementIndex` (the index of the call's enclosing TOP-LEVEL statement — walk up `call` to the statement whose parent is the SourceFile). Store the `ts.CallExpression` alongside internally for Task 5. Set `callSites` to these (replacing `[]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: PASS (2 cross-module calls recorded; callback/re-export/spread/arity rejected).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineAnalysis.ts packages/store/tests/inlineAnalysis.test.ts
git commit -m "feat(store): analyzeInline reference discovery + call classification"
```

---

## Task 5: `analyzeInline` — argument purity + hygienic substitution

For each call site, require every argument to be syntactically pure; then build the inlined expression by substituting each parameter's argument text into the body expression (hygienic, via AST), parenthesized. Emit the final `SubstitutionIntent[]`.

**Files:**
- Modify: `packages/store/src/inlineAnalysis.ts`
- Test: `packages/store/tests/inlineAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/store/tests/inlineAnalysis.test.ts`:

```typescript
describe("analyzeInline — argument purity + substitution", () => {
  it("substitutes pure args into the body, parenthesized", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function add(a: number, b: number): number { return a + b; }\n`],
      ["/p/b.ts", `import { add } from "./a.ts";\nexport const y = add(x, 2);\nconst x = 1;\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "add" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites).toHaveLength(1);
    expect(r.callSites[0]!.replacementText).toBe("(x + 2)");
  });

  it("substitutes a member-access pure arg and handles a multiply-used param", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function sq(n: number): number { return n * n; }\n`],
      ["/p/b.ts", `import { sq } from "./a.ts";\ndeclare const o: { v: number };\nexport const y = sq(o.v);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "sq" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites[0]!.replacementText).toBe("(o.v * o.v)");
  });

  it("rejects an impure argument (call expression)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`],
      ["/p/b.ts", `import { dbl } from "./a.ts";\ndeclare function side(): number;\nexport const y = dbl(side());\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pure|side effect|argument/i);
  });

  it("rejects an impure argument (await/assignment)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nlet k = 0;\nexport const y = dbl((k += 1));\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pure|side effect|argument/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: FAIL — replacementText empty / impure args not rejected.

- [ ] **Step 3: Implement purity + substitution**

Add a syntactic purity predicate and a hygienic substitution builder. For each recorded call, check every argument is pure; then build the replacement.

```typescript
/** Syntactically pure: identifier, literal, this, or member-access chain over those.
 *  Rejects anything containing a call/new/await/assignment/inc-dec/yield/spread/arrow/template-with-calls. */
function isPureArg(node: ts.Expression): boolean {
  let pure = true;
  const walk = (n: ts.Node): void => {
    if (!pure) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) ||
        ts.isYieldExpression(n) || ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind) ||
        n.kind === ts.SyntaxKind.PlusPlusToken || n.kind === ts.SyntaxKind.MinusMinusToken ||
        ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ||
        ts.isPostfixUnaryExpression(n) ||
        ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isTaggedTemplateExpression(n)) {
      pure = false; return;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return pure;
}
function isAssignmentOperator(k: ts.SyntaxKind): boolean {
  return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}
```

Substitution (hygienic via param symbols). Build a map from each parameter symbol → its argument's source text (from the rendered SF: `arg.getText(sf)`). Then re-walk the body expression and emit text, substituting identifiers whose symbol is a parameter:

```typescript
function buildReplacement(
  checker: ts.TypeChecker, fnSf: ts.SourceFile, bodyExpr: ts.Expression,
  paramSyms: ts.Symbol[], argTexts: string[]
): string {
  const symToArg = new Map<ts.Symbol, string>();
  paramSyms.forEach((s, i) => symToArg.set(s, argTexts[i]!));
  // Collect identifier nodes in bodyExpr whose symbol is a param; replace their
  // text spans within the bodyExpr's own text. Work on offsets relative to
  // bodyExpr.getStart(fnSf). Replace right-to-left to keep offsets stable.
  const base = bodyExpr.getStart(fnSf);
  let text = bodyExpr.getText(fnSf);
  const edits: { start: number; end: number; with: string }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && !isMemberPropertyName(n)) {
      let sym = checker.getSymbolAtLocation(n);
      if (sym && symToArg.has(sym)) {
        edits.push({ start: n.getStart(fnSf) - base, end: n.getEnd() - base, with: symToArg.get(sym)! });
        return;
      }
    }
    n.forEachChild(walk);
  };
  walk(bodyExpr);
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) text = text.slice(0, e.start) + e.with + text.slice(e.end);
  return `(${text})`;
}
```

In `analyzeInline`, for each recorded call: gather its args; if any `!isPureArg(arg)`, `return reject("inline: a call to <name> passes a non-pure argument (<text>); inlining could change evaluation, so it is refused")`. Else build `replacementText = buildReplacement(checker, fnSf, norm.bodyExpr, [...paramSyms-in-order], argTexts)`. Note: keep parameter ORDER (use `norm.params` order, mapping each to its symbol, not the Set). Emit the `SubstitutionIntent`.

> Correctness note: parenthesize the whole replacement so precedence is preserved (`a + b` inlined into `x * add(...)` becomes `x * (a + b)`). Member-property names (`o.v`) are not substituted because `isMemberPropertyName` skips them and `v`'s symbol isn't a param. Verify the `(o.v * o.v)` test passes.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: PASS (pure substitution incl. member-access + multiply-used param; impure call/await/assign rejected).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineAnalysis.ts packages/store/tests/inlineAnalysis.test.ts
git commit -m "feat(store): analyzeInline argument purity + hygienic substitution"
```

---

## Task 6: `analyzeInline` — importer strip plan

Every module importing the (soon-deleted) function via a named import must have that binding removed: sole binding → remove the whole import statement; mixed → remove just the binding. Reuse `move_declaration`'s importer classification.

**Files:**
- Modify: `packages/store/src/inlineAnalysis.ts`
- Test: `packages/store/tests/inlineAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/store/tests/inlineAnalysis.test.ts`:

```typescript
describe("analyzeInline — importer strip plan", () => {
  const fn = `export function dbl(n: number): number { return n * 2; }\n`;

  it("plans removed-statement for a sole-binding importer", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const y = dbl(1);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const strip = r.importerStrips.find((s) => s.importerPath.endsWith("b.ts"))!;
    expect(strip.style).toBe("removed-statement");
  });

  it("plans removed-binding for a mixed-binding importer", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 1;\n`],
      ["/p/b.ts", `import { dbl, OTHER } from "./a.ts";\nexport const y = dbl(OTHER);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const strip = r.importerStrips.find((s) => s.importerPath.endsWith("b.ts"))!;
    expect(strip.style).toBe("removed-binding");
    expect(strip.removeName).toBe("dbl");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: FAIL — `importerStrips` empty.

- [ ] **Step 3: Implement the strip plan**

Mirror `moveAnalysis.ts`'s `collectImporters` to find each module with a named import of `input.name` from the function's module (`resolveSpecifier` + `sameModule`). For each: `style = bindingNames.length === 1 ? "removed-statement" : "removed-binding"`, `importStatementIndex = <statement index>`, and `removeName = input.name` for the mixed case. Emit `ImporterStrip[]`. (Namespace/default/re-export importers are already refused by Task 4's non-call rejection, so this scan only encounters named imports; if you encounter a non-named importer here, it's a belt-and-suspenders reject with a reason.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineAnalysis`
Expected: PASS (sole → removed-statement; mixed → removed-binding + removeName).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineAnalysis.ts packages/store/tests/inlineAnalysis.test.ts
git commit -m "feat(store): analyzeInline importer strip plan (sole→statement, mixed→binding)"
```

---

## Task 7: `inline_function` apply — substitution edits + delete declaration

Apply the call-site substitutions (payload-relative) and delete the declaration + re-index siblings via `removeChildStatement`. Importer strips + manifest are Task 8.

**Files:**
- Create: `packages/store/src/inlineFunction.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/inlineFunction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/inlineFunction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, insertReferences, findNodeById, listChildren, listModules } from "../src/nodes";
import { begin, getOverlay } from "../src/transactions";
import { inline_function } from "../src/inlineFunction";
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
  return { db, rendered: new Map(inputs.map((i) => [i.path, i.text])) };
}
function stmtIn(db: ReturnType<typeof openDb>, modulePath: string, contains: string) {
  const mod = listModules(db).find((m) => m.payload.endsWith(modulePath))!;
  return listChildren(db, mod.id).find((c) => c.payload?.includes(contains));
}

describe("inline_function apply — substitution + delete", () => {
  it("splices each call site to the inlined expression and deletes the declaration", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export function add(a: number, b: number): number { return a + b; }\n` },
      { path: "/project/b.ts", text: `import { add } from "./a.ts";\nexport const y = add(1, 2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");

    const manifest = inline_function(db, tx, fnId, rendered, OPTIONS);

    expect(manifest.name).toBe("add");
    expect(manifest.callSitesInlined).toBe(1);
    expect(findNodeById(db, fnId)).toBeUndefined(); // declaration deleted

    // b.ts's `y` statement got a queued edit replacing add(1, 2) with (1 + 2)
    const yStmt = stmtIn(db, "b.ts", "y")!;
    const edits = getOverlay(tx).textSpanMutations.get(yStmt.id);
    expect(edits).toBeDefined();
    expect(edits!.some((e) => e.newText === "(1 + 2)")).toBe(true);
    db.close();
  });

  it("throws on a non-self-contained function (no mutation)", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `const K = 3;\nexport function f(n: number): number { return n * K; }\n` },
      { path: "/project/b.ts", text: `import { f } from "./a.ts";\nexport const y = f(2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "t");
    expect(() => inline_function(db, tx, fnId, rendered, OPTIONS)).toThrow(/K|self-contained|scope/i);
    expect(findNodeById(db, fnId)).toBeDefined(); // untouched
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineFunction`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the apply (substitution + delete, no importer strip yet)**

Read `packages/store/src/moveDeclaration.ts` for the apply patterns (`findNodeById`, `modulePathOf`, `resolveDeclarationNameIdentifier`, `queueTextSpanEdit`, `queuePendingOp`, `nthImportDeclaration`, `listModules`, `normalizeKey`). Create `packages/store/src/inlineFunction.ts`:

```typescript
import ts from "typescript";
import path from "node:path";
import { findNodeById, listChildren, listModules, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { removeChildStatement } from "./removeChildStatement";
import { resolveDeclarationNameIdentifier } from "./declarationName";
import { queuePendingOp, queueTextSpanEdit, type TxHandle } from "./transactions";
import { analyzeInline, type ImporterStrip } from "./inlineAnalysis";

export interface InlineFunctionManifest {
  name: string;
  callSitesInlined: number;
  modulesTouched: string[];
  importersStripped: { modulePath: string; style: ImporterStrip["style"] }[];
  removedDeclarationId: string;
}

function normalizeKey(p: string): string { return path.resolve(p).replaceAll("\\", "/"); }

export function inline_function(
  db: Db, tx: TxHandle, functionId: string,
  renderedByPath: Map<string, string>, options: ts.CompilerOptions
): InlineFunctionManifest {
  const fn = findNodeById(db, functionId);
  if (!fn) throw new Error(`inline_function: declaration not found: ${functionId}`);
  if (fn.parentId === null || fn.childIndex === null) throw new Error(`inline_function: ${functionId} is not a top-level declaration`);
  const fnModulePath = modulePathOf(db, functionId);

  const nameId = resolveDeclarationNameIdentifier(db, functionId);
  if (!nameId) throw new Error(`inline_function: ${functionId} has no name identifier`);
  const name = (JSON.parse(nameId.payload) as { text: string }).text;

  const analysis = analyzeInline(renderedByPath, options, {
    functionPath: fnModulePath, functionChildIndex: fn.childIndex, name
  });
  if (!analysis.ok) throw new Error(analysis.reason);

  // Module-path -> module id map for call-site + importer lookups.
  const moduleByPath = new Map<string, string>();
  for (const m of listModules(db)) moduleByPath.set(normalizeKey(m.payload), m.id);

  // 1) Apply each call-site substitution on the call-site statement's PAYLOAD.
  const touched = new Set<string>();
  for (const cs of analysis.callSites) {
    const modId = moduleByPath.get(normalizeKey(cs.callSitePath));
    if (!modId) throw new Error(`inline_function: call-site module not found: ${cs.callSitePath}`);
    const stmt = listChildren(db, modId).find((c) => c.childIndex === cs.callSiteStatementIndex);
    if (!stmt) throw new Error(`inline_function: call-site statement #${cs.callSiteStatementIndex} not found in ${cs.callSitePath}`);
    // Re-parse the stored payload, find the CallExpression to `name`, splice it.
    const span = locateCallSpanInPayload(stmt.payload, name, cs); // see note below
    if (!span) throw new Error(`inline_function: could not locate call to ${name} in ${cs.callSitePath} payload`);
    queueTextSpanEdit(tx, stmt.id, { start: span.start, end: span.end, oldText: span.text, newText: cs.replacementText });
    touched.add(modulePathOf(db, stmt.id));
  }

  // 2) Delete the declaration + re-index siblings (shared helper).
  removeChildStatement(db, tx, fn.parentId, fn.childIndex);
  touched.add(fnModulePath);

  // 3) Importer strip: Task 8.
  queuePendingOp(tx, {
    kind: "InlineFunction",
    paramsJson: JSON.stringify({ function_id: functionId, name, call_sites: analysis.callSites.length, importers: analysis.importerStrips.length }),
    affectedNodeIdsJson: JSON.stringify([functionId]),
    reasoning: null
  });

  return {
    name, callSitesInlined: analysis.callSites.length,
    modulesTouched: [...touched],
    importersStripped: [], // Task 8
    removedDeclarationId: functionId
  };
}
```

`locateCallSpanInPayload(payload, name, cs)`: parse the payload as a source file, walk for a `CallExpression` whose callee is an identifier named `name`, return `{ start, end, text }` payload-relative offsets. If a statement has MULTIPLE calls to `name`, this must handle all of them — return all spans and queue an edit per span (the analysis recorded one `SubstitutionIntent` per call; ensure call-site intents are matched to spans in source order, or re-derive replacement per call here). For v1 simplicity: in `analyzeInline`, if a single statement contains multiple calls, emit one intent per call WITH its own replacementText, and here match them left-to-right by order of appearance in the payload. Verify with the multi-call integration test in Task 10.

In `packages/store/src/index.ts` add:
```typescript
export { inline_function, type InlineFunctionManifest } from "./inlineFunction";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineFunction`
Expected: PASS (call spliced; declaration deleted; non-self-contained throws before mutation). Run the full store suite to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineFunction.ts packages/store/src/index.ts packages/store/tests/inlineFunction.test.ts
git commit -m "feat(store): inline_function apply — call-site substitution + delete declaration"
```

---

## Task 8: `inline_function` apply — importer strip + manifest

Strip the function's binding from every importer (remove the whole statement for a sole binding; remove just the binding for a mixed import), and fill the manifest's `importersStripped`.

**Files:**
- Modify: `packages/store/src/inlineFunction.ts`
- Test: `packages/store/tests/inlineFunction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/store/tests/inlineFunction.test.ts` (the imports + `seed`/`stmtIn` helpers already exist at the top of the file):

```typescript
describe("inline_function apply — importer strip", () => {
  it("removes a sole-binding importer's statement and a mixed importer's binding", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 9;\n` },
      { path: "/project/sole.ts", text: `import { dbl } from "./a.ts";\nexport const y = dbl(2);\n` },
      { path: "/project/mixed.ts", text: `import { dbl, OTHER } from "./a.ts";\nexport const z = dbl(OTHER);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");

    const manifest = inline_function(db, tx, fnId, rendered, OPTIONS);

    const styles = manifest.importersStripped.map((s) => s.style).sort();
    expect(styles).toEqual(["removed-binding", "removed-statement"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- inlineFunction`
Expected: FAIL — `importersStripped` empty.

- [ ] **Step 3: Implement importer strip**

Replace the "Task 8" placeholder. For each `ImporterStrip`:
- find the importer module id (`moduleByPath`), and the import statement node at `importStatementIndex` (`nthImportDeclaration`-style lookup from moveDeclaration.ts).
- `removed-binding`: compute the binding-removal span on the import payload (reuse `move_declaration`'s `computeBindingRemoval(payload, removeName)`; if it isn't exported, lift it into a shared spot or re-implement the same re-parse logic) and `queueTextSpanEdit`.
- `removed-statement`: remove the whole import statement. The cleanest mechanism mirroring deletion is `removeChildStatement(db, tx, importerModuleId, importStatementIndex)` — it deletes the statement + re-indexes the importer's siblings/EOF down, keeping coordinates consistent. (This reuses Task 1's helper for the sole-import case.)
- record `{ modulePath, style }` in `importersStripped`; add the importer path to `modulesTouched`.

Set `importersStripped` in the returned manifest.

> Note: a `removed-statement` importer shifts that module's later statements down (via `removeChildStatement`); a call site in the SAME module (if any) was located by `callSiteStatementIndex` BEFORE this shift. Order matters: apply ALL call-site substitution edits and the declaration deletion FIRST, then importer strips — but a `removed-statement` in an importer that is ALSO a call-site module would invalidate the call-site index. In practice an importer that imports the function and calls it is the common case: the import is at index 0 and the call is later, so removing the import (index 0) shifts the call's statement down by one AFTER its edit was queued by statement id (not index). Since `queueTextSpanEdit` keys by statement node **id** (not index), and `removeChildStatement` re-inserts shifted siblings under NEW ids, a queued edit on the OLD statement id would be lost. AVOID this hazard: collect all edits/deletions, then order operations so importer-statement removal in a module does not strip a statement whose later siblings carry queued edits. SIMPLEST SAFE RULE for v1: for a `removed-statement` importer that also has call sites in the same module, instead of `removeChildStatement`, queue a text-span edit that blanks the import statement's payload to `""` (or rewrite the import to drop the binding), so no re-indexing occurs and call-site statement ids stay stable. Decide one mechanism and cover it with the Task 10 integration test (an importer that imports AND calls the function). Document the chosen mechanism in a comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- inlineFunction`
Expected: PASS (sole → removed-statement; mixed → removed-binding).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/inlineFunction.ts packages/store/tests/inlineFunction.test.ts
git commit -m "feat(store): inline_function importer strip + manifest"
```

---

## Task 9: Agent tool surface + prompt

**Files:**
- Modify: `packages/agent/src/tools.ts`, `packages/agent/src/prompt.ts`, `packages/agent/tests/elevenTools.test.ts`, `packages/agent/tests/tools.test.ts`

- [ ] **Step 1: Add the tool**

In `packages/agent/src/tools.ts`, import `inline_function` from `@strata/store` and register a tool next to `moveDeclarationTool`, matching that tool's exact `tool(...)` shape (schema helpers, `buildAnalysisContext`, `textResult`):

```typescript
  const inlineFunctionTool = tool(
    "inline_function",
    "Inline an expression-body function (function declaration or `const f = (…) => <expr>`) into EVERY call site: each call `f(args)` is replaced by the function's body with arguments substituted for parameters (parenthesized), the declaration is deleted, and it is stripped from every importer — all in one operation in the open transaction you pass. You give only the function's node ID. Because it rewrites every reference, this is a bulk operation; the function's node ID is gone after commit. You do NOT, and must not, hand-edit call sites or importers afterward — they are already rewritten. The tool REFUSES, with a specific reason, anything it cannot prove safe: a body that is not a single returned expression; a body referencing source-local or imported symbols (v1 inlines only self-contained bodies using params + globals); `this`/`await`/recursion; non-identifier params or generics; ANY call site whose arguments are not syntactically pure (a call/await/assignment in an argument — inlining could change evaluation); a call with the wrong arity or a spread argument; or any non-call reference to the function (used as a value/callback, re-exported, default/namespace-imported, or dynamically imported). It is all-or-nothing: if any call site is unsafe, nothing is mutated. Requires an open transaction; mutates the overlay only.",
    { tx: txHandleSchema, function_id: nodeIdSchema },
    async (args) => {
      const { renderedByPath, options } = buildAnalysisContext(ctx.db, args.tx as TxHandle);
      const manifest = inline_function(ctx.db, args.tx as TxHandle, args.function_id, renderedByPath, options);
      return textResult({ ok: true, ...manifest });
    }
  );
```

- [ ] **Step 2: Register + update tool-count tests**

Add `inlineFunctionTool` to the returned tools array and `"inline_function"` to `STRATA_TOOL_NAMES` (grep `moveDeclarationTool` for both sites). Update the tool-count assertions (currently 19 → 20) and add `"inline_function"` to the sorted name lists in `packages/agent/tests/elevenTools.test.ts` and `packages/agent/tests/tools.test.ts`. VERIFY the current count by reading the tests first.

- [ ] **Step 3: Update the prompt**

In `packages/agent/src/prompt.ts`, add to the structural-tools description paragraph:
```
inline_function replaces every call site of a small expression-body function with its body (arguments substituted in), deletes the declaration, and strips it from importers — a bulk operation in one transaction; the function's node ID is gone afterward. It refuses bodies that aren't a single self-contained expression, impure call arguments, non-call references, wrong arity/spread calls, and this/await/recursion/generics — each with a specific reason.
```
And add to the tool-selection guidance sentence: "… inline_function for folding a small expression-body function into its call sites and removing it; …".

- [ ] **Step 4: Build + test the agent package**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS (20-tool surface; replay/keyed tests skipped without a key).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/prompt.ts packages/agent/tests/elevenTools.test.ts packages/agent/tests/tools.test.ts
git commit -m "feat(agent): surface inline_function tool + prompt"
```

---

## Task 10: Integration — commit an inline end to end

**Files:**
- Create: `packages/verify/tests/inlineFunctionCommit.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/verify/tests/inlineFunctionCommit.test.ts`. Use **extensionless** imports (Node10 synthetic corpus). Model the helpers (`seed`, `renderAll`, `nodeIds`, `refKeys`) on `packages/verify/tests/moveDeclarationCommit.test.ts`.

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  openDb, insertNodes, insertReferences, begin,
  inline_function, find_declarations, listModules, loadModule, nodeId
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
  return listModules(db).map((m) => { const l = loadModule(db, m.id); return { path: m.payload, text: render(l.module, l.children) }; });
}
function nodeIds(db: ReturnType<typeof openDb>) { return new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id)); }
function refKeys(db: ReturnType<typeof openDb>) { return new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`)); }

describe("inline_function commit (integration)", () => {
  it("inlines a function called by 2 modules; commits clean; declaration gone; re-ingest equivalent", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function add(a: number, b: number): number { return a + b; }\n` },
      { path: "/project/b.ts", text: `import { add } from "./a";\nexport const y = add(1, 2);\n` },
      { path: "/project/c.ts", text: `import { add } from "./a";\nexport const z = add(3, 4);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = inline_function(db, tx, fnId, renderedByPath, options);
    expect(manifest.callSitesInlined).toBe(2);

    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "add" })).toHaveLength(0); // gone

    // Re-ingest equivalence.
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

  it("importer that imports AND calls the function commits clean (sole-binding strip + call splice in one module)", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\n` },
      { path: "/project/b.ts", text: `import { dbl } from "./a";\nexport const y = dbl(21);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    inline_function(db, tx, fnId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "dbl" })).toHaveLength(0);
    db.close();
  });

  it("mixed-importer (split binding) commits clean and leaves the sibling import", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 5;\n` },
      { path: "/project/b.ts", text: `import { dbl, OTHER } from "./a";\nexport const y = dbl(OTHER);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    inline_function(db, tx, fnId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "OTHER" })).toHaveLength(1); // untouched
    db.close();
  });

  it("rolls back cleanly when a non-self-contained inline is refused", () => {
    const db = seed([
      { path: "/project/a.ts", text: `const K = 3;\nexport function f(n: number): number { return n * K; }\n` },
      { path: "/project/b.ts", text: `import { f } from "./a";\nexport const y = f(2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => inline_function(db, tx, fnId, renderedByPath, options)).toThrow(/K|self-contained|scope/i);
    expect(commit(db, tx).ok).toBe(true); // empty tx
    expect(find_declarations(db, { name: "f" })).toHaveLength(1); // still there
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @strata/store build && pnpm --filter @strata/verify build && pnpm --filter @strata/verify test -- inlineFunctionCommit`
Expected: PASS. If re-ingest equivalence fails, inspect the missing/stale node or edge — a real coordinate bug (e.g. the importer-strip-vs-call-site ordering hazard from Task 8). Do NOT weaken the assertion; route the fix to inlineFunction.ts/removeChildStatement.ts.

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/inlineFunctionCommit.test.ts
git commit -m "test(verify): inline_function commit integration — equivalence, same-module strip+splice, mixed strip, rollback"
```

---

## Task 11: Real-corpus inline

**Files:**
- Modify: `packages/verify/tests/inlineFunctionCommit.test.ts`

- [ ] **Step 1: Write the real-corpus test**

Add a tolerant probe (move-or-refuse, never corrupt) modeled on `move_declaration`'s real-corpus test. Inspect `examples/medium/src` for a self-contained expression-body function called by ≥1 module and not re-exported through `index.ts` (the `formatTimestamp`-in-`lib/format.ts` symbol the `dogfood:move` work identified is a strong candidate — it's a small expression-body function with named importers; confirm its body is a single self-contained expression). If none exists, the test logs and passes (tolerant). Mirror the `loadMedium()` walker from `moveDeclarationCommit.test.ts`.

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

describe("inline_function on the real corpus", () => {
  it("inlines a self-contained expression-body function (or refuses with a reason); never corrupts", () => {
    const { root, files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Pick formatTimestamp from lib/format.ts if it is a single-return expression body; else first eligible.
    const formatMod = listModules(db).find((m) => m.payload.endsWith("lib/format.ts"));
    if (!formatMod) { console.log("no lib/format.ts; skipping"); return; }
    const candidate = loadModule(db, formatMod.id).children.find(
      (c) => (c.kind === "FunctionDeclaration" || c.kind === "FirstStatement") && c.payload?.includes("formatTimestamp")
    );
    if (!candidate) { console.log("no formatTimestamp; skipping"); return; }

    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    let inlined = true;
    try { inline_function(db, tx, candidate.id, renderedByPath, options); }
    catch (e) { inlined = false; console.log("inline refused:", (e as Error).message); }
    if (inlined) expect(commit(db, tx).ok).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @strata/verify test -- inlineFunctionCommit`
Expected: PASS (inlined+commit-clean OR refused-with-reason; never corrupts). Report whether `formatTimestamp` actually inlined (its body must be a single self-contained expression — if it is multi-statement, the probe refuses, which is acceptable).

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/inlineFunctionCommit.test.ts
git commit -m "test(verify): inline_function real-corpus probe (tolerant)"
```

---

## Task 12: `dogfood:inline` paired harness

A keyed paired dogfood paralleling `dogfood:move`, validating the bulk-propagation cost claim for inline. Non-keyed parts (arg parse, key-gate, `verifyInline`) must be verifiable without spend.

**Files:**
- Create: `packages/bench/src/dogfoodInline.ts`, `packages/bench/src/dogfoodInlineCli.ts`
- Modify: `packages/bench/package.json`

- [ ] **Step 1: Implement the harness**

Create `packages/bench/src/dogfoodInline.ts` modeled on `packages/bench/src/dogfoodMove.ts` (read it for `DogfoodArmCost`, `costFromLog`, arm runners, ratios, markdown, the symmetric quality floor). Differences:
- Prompt constant:
  ```typescript
  export const INLINE_DOGFOOD_PROMPT =
    "Inline the formatTimestamp function from src/lib/format.ts into every file " +
    "that calls it (replace each call with the function's body), delete the " +
    "declaration, and update imports so the project still type-checks. Keep behavior identical.";
  ```
  (Operator may override with `--prompt`. CONFIRM `formatTimestamp` is a single self-contained expression body inlinable by the substrate — if its body is multi-statement, pick another self-contained expression function imported by ≥1 module, update the prompt + `DEFAULT_INLINE_TARGET`, and note it. If the corpus has no inlinable function, document that and frame the dogfood as a capability-boundary demo, like the move default did.)
- Verification (`verifyInline(textByPath, target)`): the inline is performed iff (a) the function's declaration is gone from its module, (b) no module still imports it from the old path, and (c) at least one former call site no longer contains a call to the symbol (the body was substituted). Return `{ declRemoved, importsStripped, callsReplaced, performed }` with `performed = declRemoved && importsStripped && callsReplaced`. Parse with the TS compiler API (parallel to `verifyMove`). Make the symbol/module parameters (`DEFAULT_INLINE_TARGET`).
- Symmetric quality floor: tsc-clean + `performed`; `vitestPassed` informational.
- Substrate arm: render every module from the db; baseline arm: read the kept temp tree.

Create `packages/bench/src/dogfoodInlineCli.ts` modeled on `dogfoodMoveCli.ts` (arg parse, key-gate requiring `ANTHROPIC_API_KEY`, `--prompt`/`--model`/`--max-turns`/`--wall-ms`/`--out-dir`/`--json-out`, exit 0 iff both arms quality-pass else 2).

- [ ] **Step 2: Wire the script**

In `packages/bench/package.json` scripts add:
```json
    "dogfood:inline": "node dist/dogfoodInlineCli.js"
```

- [ ] **Step 3: Build + verify non-keyed behavior**

Run:
```bash
pnpm --filter @strata/bench build
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN node packages/bench/dist/dogfoodInlineCli.js examples/medium ; echo "exit=$?"
```
Expected: prints the key-gate message and exits 1 (no spend). Then sanity-check `verifyInline` with a `node --input-type=module` snippet importing the built `dogfoodInline.js`: a before corpus (function present, callers call it) → `performed:false`; an after corpus (function gone, callers contain the inlined body, imports stripped) → `performed:true`. Paste results.

If feasible without a key, also prove the substrate CAN perform the default inline: run `inline_function` + `commit` on an in-memory db ingested from `examples/medium` for the chosen target and assert `commit().ok === true` and `verifyInline(renderedAfter).performed === true`. (Mirrors the move dogfood-target proof.)

- [ ] **Step 4: Commit**

```bash
git add packages/bench/src/dogfoodInline.ts packages/bench/src/dogfoodInlineCli.ts packages/bench/package.json
git commit -m "feat(bench): dogfood:inline harness — inline_function substrate vs file-tools (bulk propagation)"
```

> The KEYED run is operator-triggered and budgeted (not part of this plan). Inline is predicted to extend the substrate's bulk-propagation cost edge (it rewrites every call site); the operator runs `pnpm --filter @strata/bench dogfood:inline -- "$PWD/examples/medium" --out-dir "$PWD/packages/bench/results"` and the result is recorded then.

---

## Task 13: Final regression + decisions + roadmap

- [ ] **Step 1: Full build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across all packages. If a cli/verify subprocess test flakes under parallel load, re-run that package in isolation to confirm.

- [ ] **Step 2: T03 acceptance unchanged**

Run: `pnpm --filter @strata/cli build && node packages/cli/dist/cli.js t03 examples/medium`
Expected: all criteria true (inline_function doesn't touch the rename path).

- [ ] **Step 3: Log the decisions**

Append a 2026-05-30 entry to `decisions.md` recording: (a) inline_function v1 shipped — surface (`inline_function(function_id)`, the 20th tool), the four accepted expression-body forms, the all-or-nothing semantics, the pure-argument rule (covers duplication + reordering), the self-contained body boundary, and the full rejection list; (b) the bulk-propagation framing (rewrites every call site → the substrate's cost-win class, unlike extract); (c) `removeChildStatement` extracted from `move_declaration` (the shared top-level-statement-deletion + sibling-re-index helper, parallel to `appendChildStatement`); (d) the hygienic AST substitution mechanism + the importer-strip-vs-call-site ordering decision from Task 8; (e) any v1 limitations surfaced during the build (e.g. same-module-only free vars not allowed; multi-call-per-statement handling). Commit:
```bash
git add decisions.md
git commit -m "docs: log inline_function v1 decisions (surface, all-or-nothing, removeChildStatement, substitution)"
```

- [ ] **Step 4: Update the roadmap**

In `docs/product-roadmap.md`, check off `inline_function` under Iteration 2 with a one-line note (inline expression-body functions at every call site; bulk-propagation class; v1 self-contained + pure-args; `removeChildStatement` extracted; `dogfood:inline` harness ready for keyed validation). Commit:
```bash
git add docs/product-roadmap.md
git commit -m "docs: mark inline_function landed in the roadmap"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** removeChildStatement extraction → Task 1; normalize 4 forms + shape rejects → Task 2; body scan (this/await/recursion/self-contained) → Task 3; reference discovery + call classification (non-call/arity/spread reject) → Task 4; argument purity + hygienic substitution → Task 5; importer strip plan → Task 6; apply substitution + delete → Task 7; importer strip + manifest → Task 8; agent surface → Task 9; integration (equivalence, same-module strip+splice, mixed strip, rollback) → Task 10; real corpus → Task 11; dogfood → Task 12; decisions/roadmap → Task 13.
- **Type consistency:** `analyzeInline(rendered, options, InlineInput)` and `inline_function(db, tx, functionId, renderedByPath, options)` are stable across Tasks 2-12. `SubstitutionIntent` (`callSitePath`, `callSiteStatementIndex`, `replacementText`) and `ImporterStrip` (`importerPath`, `importStatementIndex`, `style`, optional `removeName`) are defined once (Task 2) and filled across Tasks 4-6, consumed in Tasks 7-8. `InlineFunctionManifest` (`name`, `callSitesInlined`, `modulesTouched`, `importersStripped`, `removedDeclarationId`) is used in Tasks 7-9.
- **Two-coordinate discipline:** `analyzeInline` works in rendered-module coordinates and emits OFFSET-FREE substitution intents (replacement text + statement index); `inline_function` (apply) re-parses each call-site statement's stored payload to locate the `CallExpression` span — never mixing module offsets into payload edits. Same discipline as move/extract.
- **Known soft spots:** (1) the importer-strip-vs-call-site ordering when a module both imports AND calls the function (Task 8 note) — its dedicated integration test (Task 10, second case) is the guard; prefer a payload edit over `removeChildStatement` for a same-module sole-import to keep call-site statement ids stable. (2) multiple calls to the function in one statement (Task 7 note) — one intent per call, matched left-to-right; covered by an integration assertion. (3) the pure-argument rule is conservative (rejects effectful args) — honest and safe; the rejection reason guides the agent. (4) self-contained = params + globals only (no same-module relaxation) — mirrors move; logged as a v1 limitation.
