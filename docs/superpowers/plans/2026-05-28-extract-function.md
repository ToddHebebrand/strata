# extract_function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single high-level `extract_function` operation that pulls a contiguous run of statements out of a function body into a new top-level function, auto-inferring parameters / return values / async-ness and replacing the original span with a call — rejecting anything it cannot prove safe with a specific reason.

**Architecture:** A pure analysis unit in `@strata/store` (`analyzeExtraction`) builds a `ts.Program`/`TypeChecker` over caller-supplied **rendered** text to infer params (parent-scope free vars), returns (span-declared bindings used after the span), and `async` (span contains `await`), and to reject hazards (`return`/escaping `break`/`yield`/`this`/enclosing generics/param reassignment). The apply unit (`extract_function`) computes the mechanical text splice on the parent's **stored payload** (the statement index range bridges the two coordinate systems), inserts the new function via the existing `create_function` path (class-1 materialization), splices the parent via `queueTextSpanEdit` (class-2), and logs an `ExtractFunction` op. A verify-layer seam (`buildAnalysisContext`) supplies rendered text + compiler options to the agent tool. The commit-time `validate` (tsc) is the inference backstop.

**Tech Stack:** TypeScript, `typescript` compiler API (`ts.createProgram`, `TypeChecker`, `getTypeOfSymbolAtLocation`, `typeToString`), `better-sqlite3`, Vitest. Monorepo: pnpm workspaces (`@strata/store`, `@strata/verify`, `@strata/agent`).

**Spec:** `docs/superpowers/specs/2026-05-28-extract-function-design.md` (approved 2026-05-28). Prerequisite graph-materialization is landed and re-ingest-equivalence-proven.

---

## Background the engineer needs

- **Body statements are not nodes.** The graph is Module → top-level declarations (e.g. `FunctionDeclaration`) → `Identifier` children. The statements *inside* a function live in that declaration's `payload` text. So extract operates on a sub-span of one parent declaration's payload, addressed by a **statement index range** over the body's top-level statements.
- **Two coordinate systems.** Type inference needs a `ts.Program` over **rendered** (Prettier-canonical) module text. The parent payload splice must use the **stored payload** text (formatting can differ — `add_parameter` edits payloads directly for this reason). The statement index range is identical in both because rendering never adds/removes/reorders statements. So: semantic facts from the rendered program at `sf.statements[parentStatementIndex]`; mechanical splice from parsing `parent.payload` and taking the same indices.
- **`sf.statements[childIndex]` is the parent.** A module's children are real statements at `child_index` `0..N-1` plus one `EndOfFileTrivia` at the highest index. `EndOfFileTrivia` is not a `ts.Statement`, so `renderedSourceFile.statements[parentNode.childIndex]` is exactly the parent declaration.
- **Existing primitives to reuse:**
  - `create_function(db, tx, moduleId, functionText)` → `{ newNodeId, name }` (`packages/store/src/createFunction.ts`). Appends a function at the re-ingest-consistent index (EOF fix), tracks it for rollback, queues a `CreateFunction` op. Its identifiers/edges materialize as class-1 at commit.
  - `queueTextSpanEdit(tx, statementId, { start, end, oldText, newText })` (`packages/store/src/transactions.ts:96`). Splices payload text; the statement re-derives as class-2 at commit. `TextSpanEdit = { start: number; end: number; oldText: string; newText: string }`.
  - `queuePendingOp(tx, { kind, paramsJson, affectedNodeIdsJson, reasoning })` (`transactions.ts:107`). `PendingOp = { kind: string; paramsJson: string; affectedNodeIdsJson: string; reasoning: string | null }`.
  - `createInMemoryProgram` / `normalizePath` inside `packages/store/src/resolveReferences.ts` (currently private — Task 2 exports them) build a `ts.Program` over an in-memory rendered map.
  - `renderPendingModules(db, tx)` (exported from `@strata/verify`) → `{ renderedFiles: Map<absPath, text>, sourceMaps }`. Keys are `path.resolve`d. `loadCompilerOptions` is private in `validate.ts` — Task 6 wraps it.
  - Store query `readNode(db, id, { includeChildren })` → `ReadNodeResult { node; children? }` (`packages/store/src/read_node.ts`).
- **Test seeding pattern** (`packages/store/tests/*.test.ts`): `const batch = ingestBatch([{ path, text }]); const db = openDb(":memory:"); insertNodes(db, batch.allNodes); insertReferences(db, batch.references);`. Store tests may import `@strata/ingest` (dev-only).
- **Compiler options for tests** (reused verbatim across analysis tests):
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
packages/store/src/resolveReferences.ts   (modify) — export createInMemoryProgram + normalizePath for reuse
packages/store/src/extractAnalysis.ts      (new)    — listBodyStatements + analyzeExtraction (pure, TypeChecker)
packages/store/src/extractFunction.ts      (new)    — extract_function apply (payload splice + create_function + op)
packages/store/src/read_node.ts            (modify) — add bodyStatements to ReadNodeResult for FunctionDeclaration
packages/store/src/index.ts                (modify) — barrel exports
packages/verify/src/validate.ts            (modify) — export buildAnalysisContext seam
packages/verify/src/index.ts               (modify) — re-export buildAnalysisContext
packages/agent/src/tools.ts                (modify) — extract_function tool + read_node bodyStatements passthrough
packages/agent/src/prompt.ts               (modify) — tool description

packages/store/tests/listBodyStatements.test.ts   (new)
packages/store/tests/extractAnalysis.test.ts       (new)
packages/store/tests/extractFunction.test.ts       (new)
packages/verify/tests/extractFunctionCommit.test.ts(new)
```

---

## Task 1: `listBodyStatements` helper + `read_node` body-statement enrichment

Gives the agent the indexed body-statement list it needs to choose a range, and provides the shared parser used by the analysis/apply units.

**Files:**
- Create: `packages/store/src/extractAnalysis.ts` (start with just this helper)
- Modify: `packages/store/src/read_node.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/listBodyStatements.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/listBodyStatements.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { listBodyStatements } from "../src/extractAnalysis";

describe("listBodyStatements", () => {
  it("enumerates the top-level body statements of a function payload in order", () => {
    const payload = `export function f(a: number): number {\n  const b = a + 1;\n  const c = b * 2;\n  return c;\n}`;
    const stmts = listBodyStatements(payload);
    expect(stmts.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(stmts[0]!.text).toBe("const b = a + 1;");
    expect(stmts[1]!.text).toBe("const c = b * 2;");
    expect(stmts[2]!.text).toBe("return c;");
  });

  it("returns [] for a payload whose first statement is not a function declaration", () => {
    expect(listBodyStatements(`export const x = 1;`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- listBodyStatements`
Expected: FAIL — `../src/extractAnalysis` does not exist.

- [ ] **Step 3: Create `extractAnalysis.ts` with the helper**

Create `packages/store/src/extractAnalysis.ts`:

```typescript
import ts from "typescript";

export interface BodyStatement {
  index: number;
  text: string;
}

/**
 * Parse a FunctionDeclaration payload and enumerate its block body's top-level
 * statements in source order. Returns [] if the payload's first statement is
 * not a function declaration with a block body. `text` is the statement's
 * source slice (leading/trailing trivia excluded).
 */
export function listBodyStatements(payload: string): BodyStatement[] {
  const sf = ts.createSourceFile(
    "__parent__.ts",
    payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fn = sf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) return [];
  return fn.body.statements.map((stmt, index) => ({
    index,
    text: payload.slice(stmt.getStart(sf), stmt.getEnd())
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- listBodyStatements`
Expected: PASS.

- [ ] **Step 5: Add `bodyStatements` to `read_node`**

In `packages/store/src/read_node.ts`, add the import and extend the result type + function:

```typescript
import { findNodeById, listChildren, type NodeRow } from "./nodes";
import type { Db } from "./schema";
import { listBodyStatements, type BodyStatement } from "./extractAnalysis";

export interface ReadNodeOptions {
  /** When true, include the node's direct children (one level only). */
  includeChildren?: boolean;
}

export interface ReadNodeResult {
  node: NodeRow;
  /** Present only when includeChildren is true. */
  children?: NodeRow[];
  /**
   * Present only for FunctionDeclaration nodes: the indexed top-level
   * statements of the function body, so callers can choose an extract_function
   * statement range without computing character offsets.
   */
  bodyStatements?: BodyStatement[];
}

export function readNode(
  db: Db,
  id: string,
  options: ReadNodeOptions = {}
): ReadNodeResult | undefined {
  const node = findNodeById(db, id);
  if (!node) return undefined;
  const result: ReadNodeResult = { node };
  if (options.includeChildren) result.children = listChildren(db, id);
  if (node.kind === "FunctionDeclaration") {
    result.bodyStatements = listBodyStatements(node.payload);
  }
  return result;
}

export const read_node = readNode;
```

- [ ] **Step 6: Export the helper + type from the barrel**

In `packages/store/src/index.ts`, add:

```typescript
export { listBodyStatements, type BodyStatement } from "./extractAnalysis";
```

- [ ] **Step 7: Add a read_node enrichment test**

Add to `packages/store/tests/listBodyStatements.test.ts`:

```typescript
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import { read_node } from "../src/read_node";
import { nodeId } from "../src/ids";

it("read_node attaches bodyStatements for a FunctionDeclaration", () => {
  const batch = ingestBatch([
    { path: "m.ts", text: `export function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n` }
  ]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  const fnId = nodeId("m.ts", [0], "FunctionDeclaration");
  const result = read_node(db, fnId);
  expect(result?.bodyStatements?.map((s) => s.index)).toEqual([0, 1]);
  db.close();
});
```

- [ ] **Step 8: Run the store suite to check for regressions**

Run: `pnpm --filter @strata/store test -- listBodyStatements`
Expected: PASS (all three tests).

- [ ] **Step 9: Commit**

```bash
git add packages/store/src/extractAnalysis.ts packages/store/src/read_node.ts packages/store/src/index.ts packages/store/tests/listBodyStatements.test.ts
git commit -m "feat(store): listBodyStatements + read_node body-statement enrichment"
```

---

## Task 2: Export the in-memory program builder + analysis scaffolding & params

Builds the analysis program and infers parameters (parent-scope free variables). No returns/async/hazards yet — those are Tasks 3-4.

**Files:**
- Modify: `packages/store/src/resolveReferences.ts`
- Modify: `packages/store/src/extractAnalysis.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/extractAnalysis.test.ts`

- [ ] **Step 1: Export `createInMemoryProgram` + `normalizePath` from resolveReferences**

In `packages/store/src/resolveReferences.ts`, change the declarations of `createInMemoryProgram` and `normalizePath` from `function` to `export function` (do not change their bodies or signatures). Then in `packages/store/src/index.ts` add:

```typescript
export { createInMemoryProgram, normalizePath } from "./resolveReferences";
```

- [ ] **Step 2: Write the failing params test**

Create `packages/store/tests/extractAnalysis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeExtraction } from "../src/extractAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

function rendered(source: string): Map<string, string> {
  return new Map([["/p/m.ts", source]]);
}

describe("analyzeExtraction — parameters", () => {
  it("infers parent-scope free variables as parameters with inferred types", () => {
    const source = `export function f(a: number, b: number): number {\n  const sum = a + b;\n  const scaled = sum * 2;\n  return scaled;\n}\n`;
    // Extract statement index 0 (`const sum = a + b;`). It reads a and b (params)
    // and declares sum.
    const result = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "computeSum");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" }
    ]);
  });

  it("does NOT treat module-level or imported symbols as parameters", () => {
    const source = `const FACTOR = 10;\nexport function f(a: number): number {\n  const scaled = a * FACTOR;\n  return scaled;\n}\n`;
    // Parent is statements[1]; extract index 0 of its body (`const scaled = a * FACTOR;`).
    const result = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 1, { start: 0, end: 0 }, "scale");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a is a parameter; FACTOR is module-level and must be excluded.
    expect(result.params).toEqual([{ name: "a", type: "number" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: FAIL — `analyzeExtraction` is not exported.

- [ ] **Step 4: Implement scaffolding + params**

Add to `packages/store/src/extractAnalysis.ts`:

```typescript
import { createInMemoryProgram, normalizePath } from "./resolveReferences";
import path from "node:path";

export interface ExtractParam {
  name: string;
  type: string;
}

export interface ExtractReturn {
  name: string;
  type: string;
  declKind: "const" | "let";
}

export interface ExtractionPlan {
  ok: true;
  params: ExtractParam[];
  returns: ExtractReturn[];
  isAsync: boolean;
  returnType: string;
  callSiteText: string;
}

export interface ExtractionRejection {
  ok: false;
  reason: string;
}

export type ExtractionResult = ExtractionPlan | ExtractionRejection;

interface SpanContext {
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
  parent: ts.FunctionDeclaration;
  spanStmts: ts.Statement[];
  spanStart: number;
  spanEnd: number;
}

function reject(reason: string): ExtractionRejection {
  return { ok: false, reason };
}

/**
 * Build the analysis context (program, checker, located parent + span) or a
 * rejection if the inputs do not resolve to a function-body statement range.
 */
function buildSpanContext(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  parentPath: string,
  parentStatementIndex: number,
  range: { start: number; end: number }
): SpanContext | ExtractionRejection {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [p, text] of renderedByPath) {
    sourceFiles.set(
      normalizePath(p),
      ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }
  const program = createInMemoryProgram(renderedByPath, sourceFiles, options);
  const checker = program.getTypeChecker();
  const key = normalizePath(path.resolve(parentPath));
  const sf = sourceFiles.get(key) ?? sourceFiles.get(normalizePath(parentPath));
  if (!sf) return reject(`extract: parent module not found in rendered set: ${parentPath}`);
  const parent = sf.statements[parentStatementIndex];
  if (!parent || !ts.isFunctionDeclaration(parent) || !parent.body) {
    return reject(
      `extract: statement at index ${parentStatementIndex} is not a function declaration with a body`
    );
  }
  const bodyStmts = parent.body.statements;
  if (range.start < 0 || range.end >= bodyStmts.length || range.start > range.end) {
    return reject(
      `extract: statement range [${range.start}, ${range.end}] out of bounds (body has ${bodyStmts.length} statements)`
    );
  }
  const spanStmts = bodyStmts.slice(range.start, range.end + 1);
  return {
    sf,
    checker,
    parent,
    spanStmts,
    spanStart: spanStmts[0]!.getStart(sf),
    spanEnd: spanStmts[spanStmts.length - 1]!.getEnd()
  };
}

function isInside(node: ts.Node, sf: ts.SourceFile, start: number, end: number): boolean {
  return node.getStart(sf) >= start && node.getEnd() <= end;
}

/** Walk every identifier in the span statements, in source order. */
function forEachSpanIdentifier(
  ctx: SpanContext,
  visit: (id: ts.Identifier) => void
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) visit(node);
    node.forEachChild(walk);
  };
  for (const stmt of ctx.spanStmts) walk(stmt);
}

/**
 * Parameters = identifiers in the span whose symbol has a value meaning and is
 * declared lexically inside the parent function but outside the span (a param
 * or a local declared before the span). Module-level, imported, and global
 * symbols stay in scope at the new top-level function and are excluded.
 */
function inferParams(ctx: SpanContext): ExtractParam[] {
  const params: ExtractParam[] = [];
  const seen = new Set<ts.Symbol>();
  const parentStart = ctx.parent.getStart(ctx.sf);
  const parentEnd = ctx.parent.getEnd();
  forEachSpanIdentifier(ctx, (id) => {
    const symbol = ctx.checker.getSymbolAtLocation(id);
    if (!symbol || seen.has(symbol)) return;
    if ((symbol.flags & ts.SymbolFlags.Value) === 0) return; // type-only / namespace
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl || decl.getSourceFile() !== ctx.sf) return; // imported / cross-module
    const insideParent = isInside(decl, ctx.sf, parentStart, parentEnd);
    const insideSpan = isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd);
    if (!insideParent || insideSpan) return;
    seen.add(symbol);
    const type = ctx.checker.typeToString(
      ctx.checker.getTypeOfSymbolAtLocation(symbol, id),
      ctx.parent
    );
    params.push({ name: symbol.getName(), type });
  });
  return params;
}

/**
 * Analyze a candidate extraction. Returns a plan with inferred params/returns/
 * async, or a rejection with a specific reason. Pure: no DB access, no writes.
 */
export function analyzeExtraction(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  parentPath: string,
  parentStatementIndex: number,
  range: { start: number; end: number },
  name: string
): ExtractionResult {
  const ctx = buildSpanContext(renderedByPath, options, parentPath, parentStatementIndex, range);
  if ("ok" in ctx) return ctx; // rejection

  const params = inferParams(ctx);

  // Returns + async + hazards arrive in Tasks 3-4. For now: no returns, sync.
  return {
    ok: true,
    params,
    returns: [],
    isAsync: false,
    returnType: "void",
    callSiteText: `${name}(${params.map((p) => p.name).join(", ")});`
  };
}
```

In `packages/store/src/index.ts` add:

```typescript
export {
  analyzeExtraction,
  type ExtractionResult,
  type ExtractionPlan,
  type ExtractionRejection,
  type ExtractParam,
  type ExtractReturn
} from "./extractAnalysis";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: PASS (both param tests).

- [ ] **Step 6: Run ingest tests to confirm the resolveReferences export change is harmless**

Run: `pnpm --filter @strata/ingest test && pnpm --filter @strata/store test -- resolveReferences`
Expected: PASS (only visibility changed on `createInMemoryProgram`/`normalizePath`).

- [ ] **Step 7: Commit**

```bash
git add packages/store/src/resolveReferences.ts packages/store/src/extractAnalysis.ts packages/store/src/index.ts packages/store/tests/extractAnalysis.test.ts
git commit -m "feat(store): analyzeExtraction scaffolding + parameter inference"
```

---

## Task 3: Return inference (used-after bindings) + return type + call-site text

Infers which span-declared bindings are used after the span (the returns), shapes 0/1/many, and builds the real `returnType` and `callSiteText`.

**Files:**
- Modify: `packages/store/src/extractAnalysis.ts`
- Test: `packages/store/tests/extractAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/store/tests/extractAnalysis.test.ts`:

```typescript
describe("analyzeExtraction — returns", () => {
  it("returns nothing when no span-declared binding is used after the span", () => {
    const source = `export function f(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`;
    // Extract both statements (0..1): b is declared and consumed entirely inside.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 1 }, "logIt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns).toEqual([]);
    expect(r.returnType).toBe("void");
    expect(r.callSiteText).toBe("logIt(a);");
  });

  it("returns a single used-after binding and builds a const call site", () => {
    const source = `export function f(a: number): number {\n  const b = a + 1;\n  return b * 2;\n}\n`;
    // Extract index 0 (`const b = a + 1;`); b is used after the span (in the return).
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "incr");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns).toEqual([{ name: "b", type: "number", declKind: "const" }]);
    expect(r.returnType).toBe("number");
    expect(r.callSiteText).toBe("const b = incr(a);");
  });

  it("returns multiple used-after bindings as a destructured object", () => {
    const source = `export function f(a: number): number {\n  const lo = a - 1;\n  const hi = a + 1;\n  return lo + hi;\n}\n`;
    // Extract indices 0..1; both lo and hi are used after.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 1 }, "bounds");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns.map((x) => x.name)).toEqual(["lo", "hi"]);
    expect(r.returnType).toBe("{ lo: number; hi: number }");
    expect(r.callSiteText).toBe("const { lo, hi } = bounds(a);");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: FAIL — current stub returns `[]`/`void` and a plain call site.

- [ ] **Step 3: Implement return inference + shaping**

In `packages/store/src/extractAnalysis.ts`, add these helpers above `analyzeExtraction`:

```typescript
interface DeclaredBinding {
  symbol: ts.Symbol;
  name: string;
  declKind: "const" | "let";
}

/** Bindings (variables, nested fn/class names) declared at any depth in the span. */
function collectSpanDeclarations(ctx: SpanContext): DeclaredBinding[] {
  const out: DeclaredBinding[] = [];
  const add = (nameNode: ts.Node, declKind: "const" | "let") => {
    if (!ts.isIdentifier(nameNode)) return; // v1: skip destructuring binding patterns
    const symbol = ctx.checker.getSymbolAtLocation(nameNode);
    if (symbol) out.push({ symbol, name: symbol.getName(), declKind });
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      const declKind = flags & ts.NodeFlags.Const ? "const" : "let";
      for (const d of node.declarationList.declarations) add(d.name, declKind);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      add(node.name, "const");
    }
    node.forEachChild(walk);
  };
  for (const stmt of ctx.spanStmts) walk(stmt);
  return out;
}

/** True if any identifier after the span (within the parent) resolves to `symbol`. */
function isReferencedAfterSpan(ctx: SpanContext, symbol: ts.Symbol): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isIdentifier(node) &&
      node.getStart(ctx.sf) >= ctx.spanEnd &&
      ctx.checker.getSymbolAtLocation(node) === symbol
    ) {
      found = true;
      return;
    }
    node.forEachChild(walk);
  };
  walk(ctx.parent.body!);
  return found;
}

function inferReturns(ctx: SpanContext): ExtractReturn[] {
  const returns: ExtractReturn[] = [];
  const seen = new Set<ts.Symbol>();
  for (const decl of collectSpanDeclarations(ctx)) {
    if (seen.has(decl.symbol)) continue;
    if (!isReferencedAfterSpan(ctx, decl.symbol)) continue;
    seen.add(decl.symbol);
    const type = ctx.checker.typeToString(
      ctx.checker.getTypeOfSymbolAtLocation(decl.symbol, ctx.parent),
      ctx.parent
    );
    returns.push({ name: decl.name, type, declKind: decl.declKind });
  }
  return returns;
}

function buildReturnType(returns: ExtractReturn[], isAsync: boolean): string {
  let base: string;
  if (returns.length === 0) base = "void";
  else if (returns.length === 1) base = returns[0]!.type;
  else base = `{ ${returns.map((r) => `${r.name}: ${r.type}`).join("; ")} }`;
  return isAsync ? `Promise<${base}>` : base;
}

function buildCallSiteText(
  name: string,
  params: ExtractParam[],
  returns: ExtractReturn[],
  isAsync: boolean
): string {
  const args = params.map((p) => p.name).join(", ");
  const call = `${isAsync ? "await " : ""}${name}(${args})`;
  if (returns.length === 0) return `${call};`;
  if (returns.length === 1) return `${returns[0]!.declKind} ${returns[0]!.name} = ${call};`;
  const declKind = returns.every((r) => r.declKind === "const") ? "const" : "let";
  return `${declKind} { ${returns.map((r) => r.name).join(", ")} } = ${call};`;
}
```

Then replace the return block of `analyzeExtraction` (everything after `const params = inferParams(ctx);`) with:

```typescript
  const returns = inferReturns(ctx);
  const isAsync = false; // await detection arrives in Task 4
  return {
    ok: true,
    params,
    returns,
    isAsync,
    returnType: buildReturnType(returns, isAsync),
    callSiteText: buildCallSiteText(name, params, returns, isAsync)
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: PASS (params + all three return tests).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/extractAnalysis.ts packages/store/tests/extractAnalysis.test.ts
git commit -m "feat(store): extract return inference (used-after bindings) + call-site shaping"
```

---

## Task 4: async (`await`) detection + hazard rejections

Detects `await` (→ async, allowed) and rejects unsafe spans with specific reasons: `return`, escaping `break`/`continue`, `yield`, `this`/`super`/`arguments`, enclosing type-parameter dependence, and reassignment of a parent-scope binding (the param case).

**Files:**
- Modify: `packages/store/src/extractAnalysis.ts`
- Test: `packages/store/tests/extractAnalysis.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/store/tests/extractAnalysis.test.ts`:

```typescript
describe("analyzeExtraction — async + hazards", () => {
  it("marks the extraction async and wraps the return type when the span awaits", () => {
    const source = `async function f(p: Promise<number>): Promise<number> {\n  const v = await p;\n  return v + 1;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "load");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.isAsync).toBe(true);
    expect(r.returnType).toBe("Promise<number>");
    expect(r.callSiteText).toBe("const v = await load(p);");
  });

  it("rejects a span containing a return statement", () => {
    const source = `export function f(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return -a;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/return/i);
  });

  it("rejects a span with a break that escapes the span", () => {
    const source = `export function f(xs: number[]): void {\n  for (const x of xs) {\n    if (x < 0) break;\n    console.log(x);\n  }\n}\n`;
    // Extract the inner if (index 0 of the for body)? Simpler: extract a break-bearing
    // statement directly. Here extract the whole for-loop body's first statement set
    // by targeting a nested span is awkward; instead test a labeled escape:
    const labeled = `export function f(xs: number[]): void {\n  outer: for (const x of xs) {\n    break outer;\n  }\n}\n`;
    const r = analyzeExtraction(rendered(labeled), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/break|continue/i);
  });

  it("rejects a span referencing this", () => {
    const source = `export function f(this: { n: number }): number {\n  const v = this.n + 1;\n  return v;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/this|super|arguments/i);
  });

  it("rejects reassignment of a parent-scope binding", () => {
    const source = `export function f(a: number): number {\n  let acc = 0;\n  acc = acc + a;\n  return acc;\n}\n`;
    // Extract index 1 (`acc = acc + a;`) — reassigns acc, declared outside the span.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 1, end: 1 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/reassign|assignment/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: FAIL — async not detected; hazards not rejected.

- [ ] **Step 3: Implement the hazard scan + await detection**

In `packages/store/src/extractAnalysis.ts`, add:

```typescript
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isLoopOrSwitch(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node)
  );
}

/**
 * Scan the span for control-flow / binding hazards that change meaning when the
 * code moves into a new top-level function. Returns a rejection reason, or
 * null (safe). Sets isAsync via the out-param ref when `await` is present.
 * `fnDepth` and `loopDepth` track nesting *within the span* so escapes are
 * distinguished from constructs fully contained in the span.
 */
function scanHazards(ctx: SpanContext, asyncRef: { value: boolean }): string | null {
  const parentStart = ctx.parent.getStart(ctx.sf);
  const parentEnd = ctx.parent.getEnd();
  let reason: string | null = null;

  const walk = (node: ts.Node, fnDepth: number, loopDepth: number): void => {
    if (reason) return;

    if (fnDepth === 0) {
      if (ts.isReturnStatement(node)) {
        reason = "extract: span contains a `return`; it would return from the new function, not the parent";
        return;
      }
      if (ts.isYieldExpression(node)) {
        reason = "extract: span contains `yield`; generators cannot be extracted";
        return;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
        reason = "extract: span references `this`/`super`; binding would change in a top-level function";
        return;
      }
      if (ts.isIdentifier(node) && node.text === "arguments") {
        reason = "extract: span references `arguments`; not available in a top-level function";
        return;
      }
      if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && loopDepth === 0) {
        reason = "extract: span contains a `break`/`continue` that escapes the extracted code";
        return;
      }
    }

    if (ts.isAwaitExpression(node) && fnDepth === 0) {
      asyncRef.value = true;
    }

    // Enclosing type-parameter dependence (any depth).
    if (ts.isIdentifier(node)) {
      const sym = ctx.checker.getSymbolAtLocation(node);
      const decl = sym?.declarations?.[0];
      if (
        sym &&
        (sym.flags & ts.SymbolFlags.TypeParameter) !== 0 &&
        decl &&
        decl.getSourceFile() === ctx.sf &&
        isInside(decl, ctx.sf, parentStart, parentEnd) &&
        !isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd)
      ) {
        reason = "extract: span depends on the enclosing function's type parameter(s)";
        return;
      }
    }

    // Reassignment of a parent-scope binding (would become a by-value parameter).
    if (fnDepth === 0) {
      let target: ts.Expression | undefined;
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind >= ts.SyntaxKind.PlusEqualsToken &&
            node.operatorToken.kind <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        target = node.left;
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        target = node.operand;
      }
      if (target && ts.isIdentifier(target)) {
        const sym = ctx.checker.getSymbolAtLocation(target);
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        if (
          sym &&
          decl &&
          decl.getSourceFile() === ctx.sf &&
          isInside(decl, ctx.sf, parentStart, parentEnd) &&
          !isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd)
        ) {
          reason = `extract: span reassigns the outer binding \`${sym.getName()}\`; pass-by-value would lose the write`;
          return;
        }
      }
    }

    const nextFnDepth = isFunctionLike(node) ? fnDepth + 1 : fnDepth;
    const nextLoopDepth = isLoopOrSwitch(node) ? loopDepth + 1 : loopDepth;
    node.forEachChild((c) => walk(c, nextFnDepth, nextLoopDepth));
  };

  for (const stmt of ctx.spanStmts) walk(stmt, 0, 0);
  return reason;
}
```

Then update `analyzeExtraction`'s tail (replace the Task-3 return block) with:

```typescript
  const asyncRef = { value: false };
  const hazard = scanHazards(ctx, asyncRef);
  if (hazard) return reject(hazard);

  const params = inferParams(ctx);
  const returns = inferReturns(ctx);
  const isAsync = asyncRef.value;
  return {
    ok: true,
    params,
    returns,
    isAsync,
    returnType: buildReturnType(returns, isAsync),
    callSiteText: buildCallSiteText(name, params, returns, isAsync)
  };
```

> Note: the reassignment operator-range check uses `PlusEqualsToken .. CaretEqualsToken`, the contiguous compound-assignment token range in the TS SyntaxKind enum. This covers `+= -= *= /= %= **= <<= >>= >>>= &= |= ^=`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @strata/store test -- extractAnalysis`
Expected: PASS (params, returns, async, all hazard rejections).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/extractAnalysis.ts packages/store/tests/extractAnalysis.test.ts
git commit -m "feat(store): extract await-detection + hazard rejections with specific reasons"
```

---

## Task 5: `extract_function` apply — payload splice + create_function + op + manifest

Computes the payload-coordinate span, builds the new function text and call-site, inserts via `create_function` (class-1), splices the parent (class-2), and logs the op.

**Files:**
- Create: `packages/store/src/extractFunction.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/extractFunction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/extractFunction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren } from "../src/nodes";
import { begin } from "../src/transactions";
import { extract_function } from "../src/extractFunction";
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

function seed(source: string) {
  const batch = ingestBatch([{ path: "/p/m.ts", text: source }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  return { db, rendered: new Map<string, string>([["/p/m.ts", source]]) };
}

describe("extract_function apply", () => {
  it("inserts a new function, splices the parent to a call, and returns a manifest", () => {
    const source = `export function f(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");

    const manifest = extract_function(db, tx, parentId, 0, 0, "computeSum", rendered, OPTIONS);

    expect(manifest.name).toBe("computeSum");
    expect(manifest.params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" }
    ]);
    expect(manifest.returns).toEqual([{ name: "sum", type: "number", declKind: "const" }]);
    expect(manifest.callSiteText).toBe("const sum = computeSum(a, b);");

    // The parent payload now contains the call, not the original declaration.
    const parent = findNodeById(db, parentId)!;
    expect(parent.payload).toContain("const sum = computeSum(a, b);");
    expect(parent.payload).not.toContain("const sum = a + b;");

    // A new FunctionDeclaration node exists with the expected body + signature.
    const newFn = findNodeById(db, manifest.newNodeId)!;
    expect(newFn.kind).toBe("FunctionDeclaration");
    expect(newFn.payload).toContain("function computeSum(a: number, b: number): number");
    expect(newFn.payload).toContain("const sum = a + b;");
    expect(newFn.payload).toContain("return sum;");
    db.close();
  });

  it("throws a specific reason when the span is unsafe (no overlay mutation)", () => {
    const source = `export function f(a: number): number {\n  return a + 1;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    expect(() => extract_function(db, tx, parentId, 0, 0, "g", rendered, OPTIONS)).toThrow(/return/i);
    // Parent untouched; no new function node added.
    const parent = findNodeById(db, parentId)!;
    expect(parent.payload).toContain("return a + 1;");
    db.close();
  });

  it("throws on a name collision with an existing top-level declaration", () => {
    const source = `export function taken(): void {}\nexport function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "test");
    expect(() => extract_function(db, tx, parentId, 0, 0, "taken", rendered, OPTIONS)).toThrow(/taken|exists|collision/i);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- extractFunction`
Expected: FAIL — `../src/extractFunction` does not exist.

- [ ] **Step 3: Implement `extract_function`**

Create `packages/store/src/extractFunction.ts`:

```typescript
import ts from "typescript";
import path from "node:path";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { nodeId } from "./ids";
import { create_function } from "./createFunction";
import { queuePendingOp, queueTextSpanEdit, type TxHandle } from "./transactions";
import {
  analyzeExtraction,
  type ExtractParam,
  type ExtractReturn
} from "./extractAnalysis";

export interface ExtractFunctionManifest {
  newNodeId: string;
  name: string;
  isAsync: boolean;
  params: ExtractParam[];
  returns: ExtractReturn[];
  callSiteText: string;
  newFunctionText: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Extract body statements [start..end] of a top-level FunctionDeclaration into
 * a new top-level function, replacing the span with a call. Auto-infers params,
 * returns, and async via analyzeExtraction (over caller-supplied rendered text);
 * computes the mechanical splice on the stored payload. Throws on structural
 * misuse or a semantic rejection (no overlay mutation in either case).
 */
export function extract_function(
  db: Db,
  tx: TxHandle,
  parentId: string,
  startIndex: number,
  endIndex: number,
  name: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): ExtractFunctionManifest {
  if (!IDENT.test(name)) {
    throw new Error(`extract_function: invalid identifier: ${JSON.stringify(name)}`);
  }
  const parent = findNodeById(db, parentId);
  if (!parent) throw new Error(`extract_function: parent not found: ${parentId}`);
  if (parent.kind !== "FunctionDeclaration") {
    throw new Error(`extract_function: parent ${parentId} is not a FunctionDeclaration (kind=${parent.kind})`);
  }
  if (parent.childIndex === null || parent.parentId === null) {
    throw new Error(`extract_function: parent ${parentId} is not a top-level declaration`);
  }
  const moduleId = parent.parentId;
  const modulePath = modulePathOf(db, parentId);

  // Name-collision check against existing top-level declarations in the module.
  for (const sibling of listChildren(db, moduleId)) {
    if (sibling.kind === "EndOfFileTrivia" || sibling.id === parentId) continue;
    const declName = topLevelDeclName(sibling.payload);
    if (declName === name) {
      throw new Error(`extract_function: a declaration named \`${name}\` already exists in this module`);
    }
  }

  // Semantic analysis over rendered text (the parent at its module child index).
  const analysis = analyzeExtraction(
    renderedByPath,
    options,
    modulePath,
    parent.childIndex,
    { start: startIndex, end: endIndex },
    name
  );
  if (!analysis.ok) throw new Error(analysis.reason);

  // Mechanical splice on the stored payload: locate the same statement range.
  const payloadSf = ts.createSourceFile(
    "__parent__.ts",
    parent.payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fn = payloadSf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) {
    throw new Error(`extract_function: parent payload is not a function declaration with a body`);
  }
  const bodyStmts = fn.body.statements;
  if (startIndex < 0 || endIndex >= bodyStmts.length || startIndex > endIndex) {
    throw new Error(
      `extract_function: statement range [${startIndex}, ${endIndex}] out of bounds (body has ${bodyStmts.length})`
    );
  }
  const spanStartOff = bodyStmts[startIndex]!.getStart(payloadSf);
  const spanEndOff = bodyStmts[endIndex]!.getEnd();
  const spanText = parent.payload.slice(spanStartOff, spanEndOff);

  // Build the new function text. Body = span text; append a return if needed.
  const sig = analysis.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  const returnLine =
    analysis.returns.length === 0
      ? ""
      : analysis.returns.length === 1
        ? `\n  return ${analysis.returns[0]!.name};`
        : `\n  return { ${analysis.returns.map((r) => r.name).join(", ")} };`;
  const newFunctionText =
    `${analysis.isAsync ? "async " : ""}function ${name}(${sig}): ${analysis.returnType} {\n` +
    `${spanText}${returnLine}\n}`;

  // Insert the new function (class-1 materialization at commit) + splice parent (class-2).
  const { newNodeId } = create_function(db, tx, moduleId, newFunctionText);
  queueTextSpanEdit(tx, parentId, {
    start: spanStartOff,
    end: spanEndOff,
    oldText: spanText,
    newText: analysis.callSiteText
  });

  queuePendingOp(tx, {
    kind: "ExtractFunction",
    paramsJson: JSON.stringify({
      parent_id: parentId,
      new_node_id: newNodeId,
      name,
      start_index: startIndex,
      end_index: endIndex,
      is_async: analysis.isAsync,
      param_count: analysis.params.length,
      return_count: analysis.returns.length
    }),
    affectedNodeIdsJson: JSON.stringify([newNodeId, parentId]),
    reasoning: null
  });

  return {
    newNodeId,
    name,
    isAsync: analysis.isAsync,
    params: analysis.params,
    returns: analysis.returns,
    callSiteText: analysis.callSiteText,
    newFunctionText
  };
}

/** Best-effort name of a top-level declaration payload (for collision checks). */
function topLevelDeclName(payload: string): string | undefined {
  const sf = ts.createSourceFile("__d__.ts", payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  if (!stmt) return undefined;
  if (
    (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
    stmt.name
  ) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name.text;
  }
  return undefined;
}

export const extractFunction = extract_function;
```

In `packages/store/src/index.ts` add:

```typescript
export {
  extract_function,
  extractFunction,
  type ExtractFunctionManifest
} from "./extractFunction";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- extractFunction`
Expected: PASS (apply, unsafe-throws, name-collision).

> If the unsafe-throws test leaves overlay state: note `analyzeExtraction` runs *before* any `create_function`/`queueTextSpanEdit`, and the collision/ident checks run before analysis, so a throw never mutates the overlay. Confirm by the assertion that the parent payload is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/extractFunction.ts packages/store/src/index.ts packages/store/tests/extractFunction.test.ts
git commit -m "feat(store): extract_function apply (payload splice + create_function + op log)"
```

---

## Task 6: verify caller seam — `buildAnalysisContext`

Exposes a one-call helper that renders the current store state and loads compiler options, so the agent tool (and integration tests) can supply `renderedByPath` + `options` to `extract_function` without reaching into private `validate.ts` internals.

**Files:**
- Modify: `packages/verify/src/validate.ts`
- Modify: `packages/verify/src/index.ts`
- Test: `packages/verify/tests/extractFunctionCommit.test.ts` (created here, expanded in Task 8)

- [ ] **Step 1: Write the failing test**

Create `packages/verify/tests/extractFunctionCommit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb, insertNodes, insertReferences, begin, nodeId } from "@strata/store";
import { buildAnalysisContext } from "../src/validate";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("buildAnalysisContext", () => {
  it("returns rendered text keyed by resolved path plus compiler options", () => {
    const db = seed("/project/m.ts", `export function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n`);
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    // The module's rendered text is present and contains the function.
    const text = [...renderedByPath.values()].join("\n");
    expect(text).toContain("function f");
    expect(options.target).toBeDefined();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- extractFunctionCommit`
Expected: FAIL — `buildAnalysisContext` is not exported.

- [ ] **Step 3: Implement the seam**

In `packages/verify/src/validate.ts`, add (near `renderPendingModules`; it reuses the existing private `loadCompilerOptions` and the existing `renderPendingModules`):

```typescript
/**
 * Build the inputs analyzeExtraction / extract_function need at mutation time:
 * the current rendered modules (keyed by resolved path) and the corpus compiler
 * options. Keeps loadCompilerOptions private; mirrors how the commit path
 * assembles rendered text. Renders the full set (correctness over minimality);
 * the program only analyzes the parent module.
 */
export function buildAnalysisContext(
  db: Db,
  tx: TxHandle
): { renderedByPath: Map<string, string>; options: ts.CompilerOptions } {
  const { renderedFiles } = renderPendingModules(db, tx);
  const options = loadCompilerOptions([...renderedFiles.keys()]);
  return { renderedByPath: renderedFiles, options };
}
```

(If `ts` is not already imported in `validate.ts`, it is — the file uses `ts.createProgram`. Confirm `Db` and `TxHandle` are already imported there; they are, used by `validate`/`commit`.)

In `packages/verify/src/index.ts`, add `buildAnalysisContext` to the `from "./validate"` export block.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/verify test -- extractFunctionCommit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/src/index.ts packages/verify/tests/extractFunctionCommit.test.ts
git commit -m "feat(verify): buildAnalysisContext seam for extract_function rendered inputs"
```

---

## Task 7: Agent tool surface + prompt + read_node passthrough

Surfaces `extract_function` as an MCP tool (the agent's only way to call it) and passes `bodyStatements` through `read_node`.

**Files:**
- Modify: `packages/agent/src/tools.ts`
- Modify: `packages/agent/src/prompt.ts`

- [ ] **Step 1: Add the import + tool**

In `packages/agent/src/tools.ts`, add `extract_function` to the `@strata/store` import block and `buildAnalysisContext` to the `@strata/verify` import block. Then register the tool alongside `createFunctionTool` (the existing `tool(...)` helper, `ctx.db`, `txHandleSchema`, `nodeIdSchema`, `textResult`, and `z` are already in scope in this file):

```typescript
  const extractFunctionTool = tool(
    "extract_function",
    "Extract a contiguous run of statements from a function body into a NEW top-level function, replacing the original statements with a call — all in one operation in the open transaction you pass. You give the parent function's node ID, an inclusive statement index range over its body's top-level statements (read them first via read_node, which lists `bodyStatements` with their indices), and the new function's name. The tool AUTO-INFERS everything: parameters (the variables the span reads from the enclosing function), the return value(s) (variables the span declares that are used after it — one becomes `return x`, several become a returned object you destructure at the call site), and whether the new function must be `async` (if the span awaits). You do NOT, and must not, hand-write the new function or edit the call site afterward — both are produced and applied for you; editing them yourself double-edits the transaction. The tool REFUSES, with a specific reason, spans it cannot prove safe to move: a `return`, a `break`/`continue` that escapes the span, `yield`, `this`/`super`/`arguments`, dependence on the enclosing function's type parameters, or reassignment of an outer variable. When refused, pick a different range or fall back to create_function + replace_body. Requires an open transaction; mutates the overlay only. The new function and the rewritten call site are graph-consistent after commit, so the new function is findable and its call site resolves to it.",
    {
      tx: txHandleSchema,
      parent_id: nodeIdSchema,
      start_index: z.number().int().min(0).describe("Inclusive 0-based index of the first body statement to extract."),
      end_index: z.number().int().min(0).describe("Inclusive 0-based index of the last body statement to extract."),
      name: z.string().min(1).describe("Name of the new function.")
    },
    async (args) => {
      const { renderedByPath, options } = buildAnalysisContext(ctx.db, args.tx as TxHandle);
      const manifest = extract_function(
        ctx.db,
        args.tx as TxHandle,
        args.parent_id,
        args.start_index,
        args.end_index,
        args.name,
        renderedByPath,
        options
      );
      return textResult(manifest);
    }
  );
```

- [ ] **Step 2: Register the tool in the returned tool list**

Find where the tools are collected into the returned array/object in `packages/agent/src/tools.ts` (the same place `createFunctionTool`, `replaceBodyTool`, etc. are listed) and add `extractFunctionTool` to it. (Grep for `createFunctionTool` to find both its definition site and the list it is added to.)

- [ ] **Step 3: Pass bodyStatements through read_node**

The `read_node` store function already returns `bodyStatements` (Task 1). The agent `readNodeTool` calls `read_node(...)` and wraps the whole result in `textResult`, so `bodyStatements` already flows through unchanged. No code change needed — verify by reading the `readNodeTool` definition and confirming it returns the full `read_node(...)` result.

- [ ] **Step 4: Update the system prompt**

In `packages/agent/src/prompt.ts`, add a sentence to the structural-tools description paragraph (near the `create_function`/`replace_body` lines):

```
extract_function pulls a contiguous run of body statements out of a function into a new top-level function and replaces them with a call, inferring parameters, return values, and async automatically; read the parent with read_node first to choose the statement index range. It refuses unsafe spans (a return, an escaping break/continue, yield, this/super/arguments, enclosing generics, or outer-variable reassignment) with a specific reason — when refused, choose a different range or fall back to create_function plus replace_body.
```

And add `extract_function` to the tool-selection guidance sentence (the one listing when to pick each structural tool): "… create_function for adding a brand-new function declaration; extract_function for pulling existing body statements into a new function and replacing them with a call; …".

- [ ] **Step 5: Build the agent package + run its tests**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS (the agent suite builds with the new tool; replay/keyed tests are unaffected — they don't call extract_function).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/prompt.ts
git commit -m "feat(agent): surface extract_function tool + prompt; read_node bodyStatements"
```

---

## Task 8: Integration — commit an extract end to end

Proves the headline behavior through the real commit path: validate clean, findability, a resolved call edge, re-ingest equivalence, and clean rollback on failure.

**Files:**
- Modify: `packages/verify/tests/extractFunctionCommit.test.ts`
- Test helper: reuse the equivalence comparison from `packages/verify/tests/materializeReingestEquivalence.test.ts` (inline a small comparator here to keep the test self-contained)

- [ ] **Step 1: Write the failing integration tests**

Add to `packages/verify/tests/extractFunctionCommit.test.ts`:

```typescript
import { render } from "@strata/render";
import {
  extract_function,
  find_declarations,
  get_references,
  loadModule,
  listModules
} from "@strata/store";
import { commit } from "../src/validate";

function renderAll(db: ReturnType<typeof openDb>) {
  return listModules(db).map((m) => {
    const loaded = loadModule(db, m.id);
    return { path: m.payload, text: render(loaded.module, loaded.children) };
  });
}

function nodeIdSet(db: ReturnType<typeof openDb>): Set<string> {
  return new Set(
    (db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id)
  );
}
function refSet(db: ReturnType<typeof openDb>): Set<string> {
  return new Set(
    (db.prepare(`SELECT from_node_id, to_node_id, kind FROM node_references`).all() as {
      from_node_id: string;
      to_node_id: string;
      kind: string;
    }[]).map((r) => `${r.from_node_id}|${r.to_node_id}|${r.kind}`)
  );
}

describe("extract_function commit (integration)", () => {
  it("extracts, commits clean, and the new function is findable", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const sum = a + b;\n  const scaled = sum * 2;\n  return scaled;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = extract_function(db, tx, parentId, 0, 0, "addUp", renderedByPath, options);
    const result = commit(db, tx);
    expect(result.ok).toBe(true);
    expect(find_declarations(db, { name: "addUp" })).toHaveLength(1);
    expect(manifest.callSiteText).toBe("const sum = addUp(a, b);");
    db.close();
  });

  it("the rewritten call site resolves to the new function (real edge)", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    extract_function(db, tx, parentId, 0, 0, "addUp", renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    const decl = find_declarations(db, { name: "addUp" })[0]!;
    expect(get_references(db, decl.id).length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("the committed graph equals a clean re-ingest (node IDs + edges)", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const lo = a - b;\n  const hi = a + b;\n  return lo + hi;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    extract_function(db, tx, parentId, 0, 1, "bounds", renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);

    const liveNodes = nodeIdSet(db);
    const liveRefs = refSet(db);
    const batch = ingestBatch(renderAll(db));
    const reNodes = new Set(batch.allNodes.map((n) => n.id));
    const reRefs = new Set(batch.references.map((r) => `${r.fromNodeId}|${r.toNodeId}|${r.kind}`));
    expect([...reNodes].filter((id) => !liveNodes.has(id))).toEqual([]); // none missing
    expect([...liveNodes].filter((id) => !reNodes.has(id))).toEqual([]); // none stale
    expect([...reRefs].filter((r) => !liveRefs.has(r))).toEqual([]);
    expect([...liveRefs].filter((r) => !reRefs.has(r))).toEqual([]);
    db.close();
  });

  it("rolls back cleanly when the extracted code fails to type-check", () => {
    // Force a post-extraction type error by extracting into a context that can't
    // satisfy the inferred type: a span whose declared binding is used after with
    // an incompatible operation is hard to force; instead, make validate fail by
    // referencing an undefined symbol within the span.
    const db = seed(
      "/project/m.ts",
      `export function f(a: number): number {\n  const b = a + missing;\n  return b;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    // analyzeExtraction may still succeed structurally (missing is treated as a
    // global it can't resolve to a param); commit's tsc rejects it.
    try {
      extract_function(db, tx, parentId, 0, 0, "g", renderedByPath, options);
    } catch {
      // If analysis itself rejects, that's also acceptable — assert nothing leaked.
    }
    const result = commit(db, tx);
    expect(result.ok).toBe(false);
    expect(find_declarations(db, { name: "g" })).toHaveLength(0);
    const dangling = db
      .prepare(
        `SELECT count(*) AS n FROM node_references r
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.from_node_id)
            OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.to_node_id)`
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify behavior**

Run: `pnpm --filter @strata/verify test -- extractFunctionCommit`
Expected: PASS (findability, edge, equivalence, rollback). If the equivalence test fails, inspect the missing/stale node or edge it prints — that is a real materialization/coordinate bug, not a test artifact.

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/extractFunctionCommit.test.ts
git commit -m "test(verify): extract_function commit integration — findability, edge, equivalence, rollback"
```

---

## Task 9: Real-corpus extract + negative pre-commit rejection

Exercises a real `examples/medium` function and confirms hazards are refused before commit with the transaction left open.

**Files:**
- Modify: `packages/verify/tests/extractFunctionCommit.test.ts`

- [ ] **Step 1: Write the real-corpus + negative tests**

Add to `packages/verify/tests/extractFunctionCommit.test.ts` (add `import ts from "typescript";` to the file's import block if not already present from earlier tasks):

```typescript
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function loadMedium(): { root: string; files: { path: string; text: string }[] } {
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

describe("extract_function on the real corpus", () => {
  it("extracts a contiguous span from a medium-corpus function and commits green", () => {
    const { root, files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Pick a function with >=2 simple body statements. Inspect via read_node-style
    // listing: find the first top-level FunctionDeclaration in lru.ts with a body
    // of at least 2 statements and extract its first statement.
    const lruPath = `${root}/lru.ts`;
    const lruModule = nodeId(lruPath, [], "Module");
    // Find a FunctionDeclaration child of lru.ts (fall back to any module if none).
    const candidates = listModules(db)
      .flatMap((m) => loadModule(db, m.id).children.map((c) => ({ m, c })))
      .filter(({ c }) => c.kind === "FunctionDeclaration");
    const target = candidates.find(({ c }) => {
      const sf = ts.createSourceFile("x.ts", c.payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const fn = sf.statements[0];
      return fn && ts.isFunctionDeclaration(fn) && fn.body && fn.body.statements.length >= 2;
    });
    expect(target).toBeDefined();
    if (!target) return;

    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const analysis = (() => {
      try {
        return extract_function(db, tx, target.c.id, 0, 0, "__extracted_probe__", renderedByPath, options);
      } catch (e) {
        return e as Error;
      }
    })();
    // Either the extraction is safe and commits green, or it was refused with a
    // reason (also acceptable — the point is no corruption). If it applied, commit.
    if (!(analysis instanceof Error)) {
      const result = commit(db, tx);
      expect(result.ok).toBe(true);
      expect(find_declarations(db, { name: "__extracted_probe__" })).toHaveLength(1);
    }
    db.close();
  });
});

describe("extract_function pre-commit rejection (transaction stays open)", () => {
  it("refuses a span containing a return, before any mutation", () => {
    const db = seed("/project/m.ts", `export function f(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return -a;\n}\n`);
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => extract_function(db, tx, parentId, 0, 0, "g", renderedByPath, options)).toThrow(/return/i);
    // Parent unchanged; the transaction is still usable for a different op.
    expect(find_declarations(db, { name: "g" })).toHaveLength(0);
    db.close();
  });
});
```

> Note: the real-corpus test is deliberately tolerant — it asserts "commits green OR refused with a reason, never corrupts". Extraction targets in real code vary; the firm guarantees live in the synthetic tests. If `__extracted_probe__` applies, the equivalence invariant is still enforced by Task 8's dedicated test on controlled inputs.

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @strata/verify test -- extractFunctionCommit`
Expected: PASS (real-corpus tolerant test + negative pre-commit test, plus all Task 8 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/verify/tests/extractFunctionCommit.test.ts
git commit -m "test(verify): extract_function real-corpus probe + pre-commit rejection"
```

---

## Task 10: Final regression + decisions + roadmap

- [ ] **Step 1: Full build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS across all packages. The new `verify`/`store` tests are green; T03 (rename) and the materialization suite are unaffected.

- [ ] **Step 2: T03 acceptance unchanged**

Run: `pnpm --filter @strata/cli build && node packages/cli/dist/cli.js t03 examples/medium`
Expected: all criteria true (extract_function does not touch the rename path).

- [ ] **Step 3: Log the decisions**

Append an entry to `decisions.md` recording: (a) the v1 surface (sync + await; rejects control-flow escapes / this / generics / outer reassignment) and the refinement that the reassignment hazard targets parent-scope (param-candidate) bindings specifically rather than all enclosing bindings (module-level writes are safe because scope is shared); (b) that `extract_function` reuses `create_function`, so the op log records a `CreateFunction` followed by an `ExtractFunction` for one extract (intentional provenance, not a bug); (c) the two-coordinate approach (rendered program for semantics, payload parse for the splice, bridged by the statement index range). Commit:

```bash
git add decisions.md
git commit -m "docs: log extract_function v1 decisions (surface, op-log, two-coordinate)"
```

- [ ] **Step 4: Update the roadmap**

In `docs/product-roadmap.md`, check off the `extract_function` item (the one currently `- [ ]` under Iteration 2) with a one-line note: full auto-infer (span index range + name), sync + await, graph-consistent via the materialization prerequisite; outer-reassignment / control-flow escapes / generics deferred with explicit reasons. Commit:

```bash
git add docs/product-roadmap.md
git commit -m "docs: mark extract_function landed in the roadmap"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** surface/signature → Tasks 5, 7; `read_node` bodyStatements → Task 1; two-coordinate splice → Task 5; analysis (params/returns/async/hazards) → Tasks 2-4; caller seam → Task 6; op log → Task 5; testing falsifiers (analysis unit, apply, integration findability+edge+equivalence+rollback, real corpus, negative) → Tasks 2-4, 5, 8, 9; known limits honored by the hazard rejections in Task 4.
- **Type consistency:** `analyzeExtraction(renderedByPath, options, parentPath, parentStatementIndex, range, name)` and `extract_function(db, tx, parentId, start, end, name, renderedByPath, options)` are used identically across Tasks 2-9. `ExtractParam`/`ExtractReturn`/`ExtractionPlan`/`ExtractionRejection`/`ExtractFunctionManifest` field names match between definition (Tasks 2-3, 5) and assertions (Tasks 2-5, 8). `buildAnalysisContext(db, tx) → { renderedByPath, options }` is stable across Tasks 6-9.
- **Coordinate correctness:** the parent is located in the rendered program at `sf.statements[parent.childIndex]` (EOF is not a statement) and in the payload at `payloadSf.statements[0].body.statements[index]`; the statement index range is the only shared addressing — never mix offsets across the two.
- **Known soft spots:** (1) `typeToString` can emit non-portable type text for anonymous/inferred types; the commit `validate` gate is the backstop — if an inferred param/return type fails tsc, the commit fails loudly rather than corrupting. (2) Destructuring binding patterns in span declarations are skipped by `collectSpanDeclarations` (v1); a span that declares via destructuring and uses those names after will under-return and fail validate — acceptable v1 limit, surfaced by the gate, not silent. (3) The real-corpus test is intentionally tolerant; firm guarantees are on synthetic inputs.
