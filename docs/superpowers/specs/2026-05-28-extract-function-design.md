# extract_function — design spec

**Date:** 2026-05-28
**Status:** Approved (brainstormed 2026-05-28)
**Prerequisite:** graph materialization (commits `2502535`→`d5b00bb`; re-ingest equivalence proven in `packages/verify/tests/materializeReingestEquivalence.test.ts`). An extract is exactly "insert a top-level function (class-1) + splice the parent statement (class-2)", which materialization already makes graph-consistent.

## Goal

Give the agent a single high-level operation that pulls a contiguous run of statements out of a function body into a new top-level function, replacing the original span with a call. The tool **auto-infers** parameters, return values, and `async`-ness, and **rejects** (with a specific reason) anything it cannot prove safe. After commit the new function is a first-class graph citizen: findable via `find_declarations`, with real `node_references` edges, so subsequent `rename_symbol`/`add_parameter`/`get_references` work on it — the compounding-leverage story that distinguishes the substrate from file edits.

## Non-goals (v1 — rejected with a clear reason, not silently mishandled)

- Outer-binding reassignment (a span that writes to any enclosing binding — see the hazard rule for the exact, conservative definition).
- Control-flow escapes: `return`, `break`/`continue` targeting a loop/label outside the span, `yield`/generators.
- `this` / `super` / `arguments` references in the span (binding changes when moved to a top-level function).
- Dependence on the enclosing function's type parameters (the new function would need its own generics).
- Expression extraction (extracting a sub-expression rather than whole statements).
- Moving the new function to a different module (it lands in the parent's module).

Each rejection returns a specific, actionable message so the agent can fall back to `replace_body` / `create_function`.

## Surface

### Agent-facing tool (single call, full auto-infer)

```
extract_function(tx, parent_id, start_index, end_index, name)
```

- `tx` — open transaction handle (required, like every mutation tool).
- `parent_id` — the declaration whose body contains the span. v1: a top-level `FunctionDeclaration`.
- `start_index`, `end_index` — inclusive, 0-based range over the parent body's **top-level statements** (the statements directly inside the function's `{ … }` block, not nested ones).
- `name` — the new function's name. Must be a valid identifier and must not collide with an existing top-level declaration/export in the module.

Returns a manifest:

```ts
interface ExtractFunctionManifest {
  newNodeId: string;
  name: string;
  isAsync: boolean;
  params: { name: string; type: string }[];
  returns: { name: string; type: string }[]; // 0, 1, or many
  callSiteText: string;                       // what replaced the span
  newFunctionText: string;                    // what was inserted
}
```

### Supporting query change

Extend `read_node` so that when the node is a `FunctionDeclaration`, the result includes an indexed body-statement list:

```ts
bodyStatements?: { index: number; text: string }[];
```

This lets the agent choose `start_index`/`end_index` from what it reads, without computing character offsets. The list enumerates the **top-level** statements of the function body in source order.

## Components

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/store/src/extractAnalysis.ts` | new | **Pure** `analyzeExtraction(...)` → `ExtractionPlan \| ExtractionRejection`. Owns all semantic reasoning via a `ts.Program` / `TypeChecker`. No DB writes. |
| `packages/store/src/extractFunction.ts` | new | `extract_function(db, tx, parentId, start, end, name, renderedByPath, options)`. Runs the analysis, then applies the mutation through existing store primitives. |
| `packages/store/src/index.ts` | modify | Barrel-export `extract_function`, `analyzeExtraction`, and the plan/rejection/manifest types. |
| `packages/store/src/extractAnalysis.ts` | (above) | Also export a small pure helper `listBodyStatements(payload) → { index, text }[]` that parses a `FunctionDeclaration` payload and enumerates its top-level body statements. Used by both the analysis and the `read_node` enrichment. |
| `packages/agent/src/tools.ts` (`read_node` handler) | modify | When the read node is a `FunctionDeclaration`, attach `bodyStatements` (from `listBodyStatements`) to the tool output. |
| `packages/agent/src/tools.ts` | modify | Surface the `extract_function` tool. The handler renders the parent module (+ its direct imports) to build `renderedByPath`, loads `options`, and calls the store function. |
| `packages/agent/src/prompt.ts` | modify | Tool description (part of the agent's worldview): what it does, that inference is automatic, what it rejects and why, and that it must not hand-edit the call site afterward. |
| op-log | — | New `pendingOp` kind `"ExtractFunction"`. |
| materialization | none | An extract is class-1 (new fn) + class-2 (spliced parent), both already handled and proven. |

The store dependency guard holds: `extractFunction.ts`/`extractAnalysis.ts` import only `typescript` + store-internal modules, never `@strata/render`. Rendered text is supplied by the caller, mirroring `resolveReferencesForModules`.

## The two-coordinate insight (key correctness point)

Two text coordinate systems are in play and must not be conflated:

- **Rendered/program coordinates** — type inference and "used-after" data-flow need a real `ts.Program` over the *rendered* module (Prettier-canonical text).
- **Payload coordinates** — the parent's text-span splice must be computed on the **stored node payload**, whose formatting can differ from rendered text (`add_parameter` already edits payloads directly for exactly this reason).

The **statement index range is the stable bridge**: rendering never adds or removes body statements or reorders them, so `start_index`/`end_index` resolve to the same statements in both coordinate systems. Therefore:

- **Semantic** facts (hazards, param names+types, return names+types, `async`) come from the rendered program, locating the parent at `sf.statements[parentStatementIndex]`.
- **Mechanical** facts (the verbatim span text and the payload character offsets to splice) come from parsing `parent.payload` and taking the *same* index range.

The new function's body text is taken from the **payload** span (consistent with where we splice); param/return **types** come from the rendered-program inference. Prettier re-canonicalizes everything at render time.

## Analysis algorithm (`analyzeExtraction`)

Inputs: `renderedByPath: Map<string,string>`, `options: ts.CompilerOptions`, `parentPath: string`, `parentStatementIndex: number`, `range: { start: number; end: number }`, `name: string`.

1. Build the program over `renderedByPath`; get the `TypeChecker`; get the parent `SourceFile`; take `sf.statements[parentStatementIndex]`; assert it is a `FunctionDeclaration` with a block body. Enumerate the body's top-level statements. Validate `0 <= start <= end < count`.
2. **Hazard scan** over the span subtree. Reject (specific reason) on:
   - any `ReturnStatement`;
   - `break`/`continue` whose target loop/label is *outside* the span (a loop fully inside the span is fine);
   - `yield` / the parent being a generator;
   - `this` / `super` / `arguments` references;
   - identifiers resolving to the enclosing function's type parameters;
   - any reassignment (`=`, `++`, `--`, compound assignment) of a binding declared *outside* the span (outer-reassign). v1 uses this simpler, strictly-safe rule rather than a "read-after" refinement: a write to an enclosing binding is refused regardless of whether the new value is later read. (Conservative — may reject some safe cases; honest and simple.)
   - `await` is **not** a hazard — record `isAsync = true`.
3. **Params.** For each identifier in the span, `checker.getSymbolAtLocation`. Include as a parameter iff the symbol's declaration is lexically within the parent function (a parameter or a local declared before the span) and outside the span itself. Exclude module-level, imported, and global/library symbols (they remain in scope at the new top-level function). Deduplicate; keep first-use order. Type = `checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, useSite))`.
4. **Returns.** Collect bindings *declared in the span* (variable declarations, and nested function/class declarations at span top level) whose symbol is referenced in the parent *after* the span's end offset. For each, capture name, declaration kind (`const`/`let`), and type. Shape:
   - `0` → return type `void`; call site is an expression statement `name(args);`.
   - `1` → `return x;`; call site `const|let x = name(args);` (matching the original declaration kind).
   - `>1` → `return { a, b };`; call site `const { a, b } = name(args);`. (All destructured; original `const`/`let` of each is preserved by using `const` for the destructure when all are `const`, else `let`. If kinds are mixed, use `let` for the destructure — a safe superset — and note it.)
5. Compute the **return type string**: `void` / single type / `{ a: TA; b: TB }`. If `isAsync`, wrap as `Promise<...>` (the body's existing `return` becomes the resolved value; for `void` async → `Promise<void>`).
6. Emit `ExtractionPlan { params, returns, isAsync, returnType, callSiteText }` or `ExtractionRejection { reason }`.

`callSiteText` is built from names only (no offsets), so it is coordinate-independent.

## Apply (`extract_function`)

1. Load `parent` node; assert kind `FunctionDeclaration`.
2. `analyzeExtraction(...)`; if it returns a rejection, `throw new Error(reason)`.
3. Name-collision check against existing top-level declarations/exports in the module → throw if taken.
4. Parse `parent.payload`; enumerate body statements; take the same `[start, end]` → payload span offsets + verbatim span text.
5. Build `newFunctionText` (v1 does **not** export — the call site is same-module):
   ```
   [async ]function <name>(<p: T, …>): <returnType> {
     <payload span text>
     [return <…>;]
   }
   ```
6. Insert via the **`create_function` path** (`create_function(db, tx, moduleId, newFunctionText)`) — this reuses the EOF off-by-one fix and yields a node whose identifiers/edges materialize as class-1 at commit. Capture `newNodeId`.
7. `queueTextSpanEdit(tx, parentId, { start, end, oldText: spanText, newText: callSiteText })` (payload offsets) — the parent re-derives as class-2 at commit.
8. `queuePendingOp(tx, { kind: "ExtractFunction", paramsJson, affectedNodeIdsJson: [newNodeId, parentId], reasoning: null })`.
9. Return the manifest.

At commit, `validate` (tsc) is the correctness backstop: if any inferred type, parameter, or return is wrong, the commit fails and rolls back cleanly (the overlay restore proven by the materialization rollback tests). The agent sees the diagnostics and can adjust.

## Caller seam (rendered text)

`extract_function` needs `renderedByPath` + `options` at *mutation* time (before commit), because inference needs a program. The agent tool handler (which has access to render via `@strata/verify`/`@strata/render`) renders the parent module plus the modules it imports (reuse the bounded import-scan from materialization) and the project's compiler options, then passes them in. This mirrors how `resolveReferencesForModules` is called. Store stays render-free.

## Error handling

- Structural misuse (bad `parent_id`, non-function parent, out-of-range indices, name collision, invalid identifier) → `throw` with a precise message; no overlay mutation.
- Semantic rejection (hazards, unsupported v1 cases) → `throw` the analysis `reason`; no overlay mutation.
- Type-incorrect inference that slips past analysis → caught by `validate` at commit; commit returns `{ ok: false, diagnostics }` and the transaction rolls back.

## Testing (falsifiers)

**Analysis unit (`packages/store/tests/extractAnalysis.test.ts`)**
- Params inferred from parent-scope locals/params; module-level and imported symbols excluded.
- Returns: 0 (void/statement call), 1 (`const x = …`), many (`const { a, b } = …`); `const`/`let` preserved.
- `await` in span → `isAsync` true, return type `Promise<…>`.
- Each hazard (`return`, escaping `break`, `yield`, `this`, enclosing generic, outer-reassign) → rejection with a specific reason.

**Apply unit (`packages/store/tests/extractFunction.test.ts`)**
- New function inserted at the re-ingest-consistent index; parent payload spliced to the call; manifest fields correct.
- Name collision throws; out-of-range indices throw; non-function parent throws.

**Integration (`packages/verify/tests/extractFunctionCommit.test.ts`)**
- Commit an extract → `validate` clean → `find_declarations(name)` returns the new function → the original call site resolves to it (a real `node_references` edge).
- **Re-ingest equivalence** holds after the extract commit (extend / reuse the equivalence harness).
- Forced type error in the extracted code → commit `{ ok: false }`, transaction rolls back, no materialized rows, no dangling edges.

**Real corpus**
- Extract a contiguous span from a function in `examples/medium` and commit green; assert findability + a resolved call edge.

**Negative (pre-commit)**
- Spans containing `return` / escaping `break` / `this` are rejected *before* commit with a clear reason (no overlay mutation, transaction still open).

## Open questions resolved during brainstorming

- **Inference level:** full auto-infer (agent gives span + name only).
- **Span selection:** statement index range over the parent body's top-level statements.
- **v1 surface (operator discretion):** sync value-in/value-out **+ `await`**; reject outer-reassign, control-flow escapes, `this`/generators, enclosing generics, expression extraction.
- **Architecture:** pure-store analysis taking rendered text supplied by the caller (Approach A), keeping all structural ops in `@strata/store` and the dependency guard intact.
