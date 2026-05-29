# inline_function — design spec

**Date:** 2026-05-29
**Status:** Approved (brainstormed 2026-05-29)
**Prerequisites:** graph materialization (commits `2502535`→`d5b00bb`) and `move_declaration` (merged 2026-05-29). Inline reuses move's declaration-deletion + source-sibling re-index, importer binding-strip, overlay edge-restore, and the materialization commit pass. The one new mechanism is **call-site substitution**.

## Goal

Give the agent a single high-level operation that replaces **every** call site of an expression-body function with the function's body — substituting each argument for its parameter — then deletes the declaration and strips it from importers, all in one transaction. Because it rewrites every reference to the symbol, inline is a **bulk-propagation** operation (rename/move class): the substrate's demonstrated cost edge, unlike `extract_function` (whose freshly-created helper has one caller and is not a cost win). The operation is **all-or-nothing**: if any call site cannot be safely inlined, it refuses before mutating anything (the declaration must be deleted, so every caller must be handled).

## Non-goals (v1 — rejected with a clear reason, not silently mishandled)

- **Multi-statement bodies.** v1 inlines only a single returned expression. A function whose body is anything other than exactly `return <expr>;` (block form) or `=> <expr>` (concise arrow) is refused.
- **Statement-position-only inlining.** No attempt to inline a multi-statement body into a statement-position call. (Subsumed by the multi-statement rejection.)
- **Effectful arguments.** If any argument at any call site is not syntactically pure, the inline is refused (see the purity rule). This single rule discharges both the duplication hazard (a param used twice re-evaluates its arg) and the reordering hazard (the body referencing params in a different order than the call passes them).
- **Out-of-scope free variables.** The body may reference only its parameters and globals/builtins. Any module-local or imported free variable is refused (it would be out of scope at a call site in another module).
- **Non-call references.** Every reference to the function must be a direct call `f(args)`. Using the function as a value (passed as a callback, assigned, stored), `export { f } from`/re-export, `export default`, default-import, namespace-import use (`ns.f`), and dynamic `import()` are each refused — the declaration cannot be deleted while a non-call reference survives.
- **Shape hazards.** Generics on the function; non-identifier parameters (default values, rest `...args`, destructuring); `this`/`super`/`arguments` in the body; `await` in the body; recursion (the body references the function itself); a call site with arity mismatch or spread args (`f(...xs)`).

Each rejection returns a specific, actionable message so the agent can fall back to `replace_body` / manual edits.

## Surface

### Agent-facing tool (single call)

```
inline_function(tx, function_id)
```

- `tx` — open transaction handle (required, like every mutation tool).
- `function_id` — the node id of the declaration to inline (a top-level `FunctionDeclaration`, or a `const f = (…) => <expr>` variable statement whose initializer is an arrow/function expression). Found via `find_declarations`.

Returns a manifest:

```ts
interface InlineFunctionManifest {
  name: string;
  callSitesInlined: number;
  modulesTouched: string[];            // call-site + importer module paths
  importersStripped: {
    modulePath: string;
    style: "removed-statement" | "removed-binding";
  }[];
  removedDeclarationId: string;        // the deleted function's id (now gone from the graph)
}
```

No `read_node` enrichment is needed (unlike `extract_function`, which added `bodyStatements`): the agent supplies only the function's node id. The manifest reports the bulk fan-out (how many call sites and importers were rewritten) so the agent sees the scope of what happened. The moved/inlined symbol's id is gone after commit; the manifest carries it for the op-log record.

### Accepted declaration forms

All four reduce to "one returned expression," and the analysis normalizes them to `{ params: Identifier[], bodyExpr: Expression }`:

1. `function f(p) { return <expr>; }` — `FunctionDeclaration`, block body with a single `ReturnStatement` returning an expression.
2. `const f = (p) => <expr>;` — `VariableStatement` (stored kind `FirstStatement`), arrow with a concise expression body.
3. `const f = (p) => { return <expr>; };` — arrow with a single-return block body.
4. `const f = function (p) { return <expr>; };` — function-expression initializer, single-return block body.

For the `const` forms, the declaration's `childIndex`/name come from the `VariableStatement`; the params and body expression come from the initializer. (A `const` with more than one declarator, or a non-arrow/non-function initializer, is refused.)

## Components

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/store/src/inlineAnalysis.ts` | new | **Pure** `analyzeInline(...)` → `InlinePlan \| InlineRejection`. All semantic reasoning via a `ts.Program`/`TypeChecker`: declaration-shape normalization, body hazard + self-containment scan, reference discovery, per-call-site purity + arity validation, and the per-call-site substitution intent. No DB writes. |
| `packages/store/src/inlineFunction.ts` | new | `inline_function(db, tx, functionId, renderedByPath, options)`. Runs the analysis, then applies the mutation through store primitives: per-call-site `queueTextSpanEdit` (payload-relative), declaration deletion + sibling re-index via the shared helper, importer binding-strip, op-log entry. |
| `packages/store/src/removeChildStatement.ts` | new | Shared helper extracted from `move_declaration`: delete a top-level statement from a module, re-index every surviving sibling **and** the `EndOfFileTrivia` node DOWN by one (re-derived ids, tracked for rollback), capturing their edges for restore. Parallel to `appendChildStatement`. |
| `packages/store/src/moveDeclaration.ts` | modify | Refactor the open-coded delete+re-index block to call `removeChildStatement` (DRY; same behavior, regression-guarded by move's existing store + integration tests). |
| `packages/store/src/index.ts` | modify | Barrel-export `inline_function`, `analyzeInline`, `removeChildStatement`, and the plan/rejection/manifest types. |
| `packages/agent/src/tools.ts` | modify | Surface the `inline_function` tool (20th structural tool). Handler renders the function's module + every call-site/importer module via `buildAnalysisContext`, then calls the store function. Add `"inline_function"` to `STRATA_TOOL_NAMES`. |
| `packages/agent/src/prompt.ts` | modify | Tool description (agent worldview): what it does, that it rewrites every call site (bulk), the rejection set, and that the agent must not hand-edit call sites or importers afterward. |
| `packages/agent/tests/*` | modify | Tool-count assertions 19 → 20; add `"inline_function"` to sorted name lists. |
| op-log | — | New `pendingOp` kind `"InlineFunction"`. |
| materialization | none | Call-site statements re-derive as class-2 (their text changed); the deleted declaration + re-indexed siblings are handled exactly as in `move_declaration`. No new materialization path. |

The store dependency guard holds: `inlineAnalysis.ts`/`inlineFunction.ts`/`removeChildStatement.ts` import only `typescript` + store-internal modules, never `@strata/render`. Rendered text is supplied by the caller, mirroring `move_declaration`/`extract_function`.

## The two-coordinate discipline (key correctness point)

Two text coordinate systems, never conflated (same as extract/move):

- **Rendered/program coordinates** — semantic facts need a real `ts.Program` over the *rendered* modules: parameter symbols, free-variable scope, argument purity, and "is this reference the callee of a direct `CallExpression`."
- **Payload coordinates** — every text splice is computed on a **stored node payload**: the body-expression text comes from the function declaration's payload; each call-site replacement is computed on the call-site statement's stored payload.

`analyzeInline` emits **offset-free substitution intents** (which call-site statement, by module path + statement index; and the replacement expression text). The apply step recomputes payload-relative spans by re-parsing each call-site statement's stored payload and locating the `CallExpression` to the function there — exactly the discipline `move_declaration`'s importer rewrites use.

## Substitution (the one new mechanism)

For each call site `f(a, b)`:

1. From the rendered program, confirm the reference is the callee of a `CallExpression`, the arity matches the parameter count, there are no spread args, and **every argument is syntactically pure** — an identifier, literal, `this`, or a member-access chain over those, containing no `CallExpression`/`NewExpression`/`AwaitExpression`/assignment/`++`/`--`. Any impure argument refuses the whole inline (naming the offending call site).
2. Build the inlined expression **hygienically via AST**: re-parse the function's body expression, walk its identifiers, and for each identifier whose symbol resolves to a parameter, replace its text with the corresponding argument's source text. (Identifiers resolving to globals or member-property names are left untouched.) Wrap the result in parentheses to preserve precedence: `f(a, b)` → `(<bodyExpr[p0→a, p1→b]>)`.
3. The replacement is purely a function of names + argument text, so it is coordinate-independent; the apply step splices it into the call-site statement payload at the `CallExpression` span.

Multiple calls in one statement (`const x = f(a) + f(b);`) produce multiple non-overlapping `queueTextSpanEdit`s on that statement — `queueTextSpanEdit` already supports several edits per statement (applied right-to-left at commit).

## Analysis algorithm (`analyzeInline`)

Inputs: `renderedByPath: Map<string,string>`, `options: ts.CompilerOptions`, `{ functionPath: string; functionChildIndex: number; name: string }`.

1. Build the program; get the `TypeChecker`; locate the declaration at `sf.statements[functionChildIndex]` in the function's module; **normalize** it to `{ params, bodyExpr }` across the four accepted forms. Reject if it is not an accepted expression-body form, has non-identifier params, or has type parameters.
2. **Body scan** over `bodyExpr`:
   - reject `this`/`super`/`arguments`/`await`;
   - reject recursion (an identifier in `bodyExpr` resolving to the function's own symbol);
   - **self-containment**: every identifier in `bodyExpr` must resolve to (i) one of the parameters, (ii) a global/lib symbol (declaration in a `.d.ts`), or (iii) a member-property name (not a free variable). Any module-local or imported free variable → reject (it would be out of scope at a cross-module call site). Mirrors `move_declaration`'s `findOutOfScopeDependency` (including `getAliasedSymbol` following).
3. **Reference discovery.** Resolve the function's name symbol; collect every referencing identifier across the rendered program (the same resolver `rename`/`move` use). Partition them: the declaration's own name identifier and **named-import binding identifiers** (`import { f }`) are *not* value uses — the former is the declaration (deleted in apply), the latter are handled by importer discovery (step 4). Every **remaining (value-position) reference** must be the `expression` (callee) of a `CallExpression`. Any other value-position use (passed as a value/callback, assigned, `export { f }` / `export { f } from`, `export default f`, namespace-import use `ns.f`, default-import binding, dynamic `import()`, bare property access) → reject with the specific shape. For each valid call reference:
   - the call must have arity equal to the parameter count and no spread argument → reject otherwise.
   - **every argument must be syntactically pure** (above) → reject otherwise, naming the call site.
   - record an offset-free substitution intent: `{ callSitePath, callSiteStatementIndex, replacementText }`.
4. **Importer discovery** (for the now-deleted symbol): every module that imports the function. Each must be a named import (`import { f }`) — `move`'s importer classifier is reused; namespace/default/re-export are already refused by step 3's non-call rejection, but the importer scan also yields the binding-strip plan: sole binding → remove the whole import statement; mixed → remove just the `f` binding. (There is no path-rewrite and no new import — the symbol ceases to exist.)
5. Emit `InlinePlan { name, removedDeclarationId, callSites: SubstitutionIntent[], importerStrips: ImporterStrip[] }` or `InlineRejection { reason }`. Zero call sites is a valid plan (degenerate bulk = delete the declaration + strip importers).

## Apply (`inline_function`)

1. Load the function node; resolve its name + module path; run `analyzeInline`; on rejection `throw new Error(reason)` (no overlay mutation).
2. For each call site: look up the call-site statement node (module path + statement index), re-parse its payload, locate the `CallExpression` to the function, and `queueTextSpanEdit(tx, statementId, { start, end, oldText: callText, newText: replacementText })` (payload offsets). Multiple calls in one statement → multiple edits.
3. Delete the declaration + re-index siblings via `removeChildStatement(db, tx, moduleId, declChildIndex)` (the shared helper, which captures deleted nodes + edges for rollback).
4. For each importer strip: remove the binding (mixed) or the whole import statement (sole) from the importer's payload via `queueTextSpanEdit` / statement removal — reusing `move_declaration`'s binding-removal computation.
5. `queuePendingOp(tx, { kind: "InlineFunction", paramsJson, affectedNodeIdsJson, reasoning: null })`.
6. Return the manifest.

At commit, `validate` (tsc) is the correctness backstop: if any substitution produced a type error (e.g. the inlined expression in a context expecting the former return type, or a subtle scope issue), the commit fails `{ ok: false, diagnostics }` and the transaction rolls back cleanly (overlay node + edge restore, proven by move's rollback tests).

## Caller seam (rendered text)

`inline_function` needs `renderedByPath` + `options` at mutation time (the analysis needs a program over the function's module plus every call-site and importer module). The agent tool handler renders those modules via `buildAnalysisContext` (the same seam `move_declaration`/`extract_function` use) and passes them in. Store stays render-free.

## Error handling

- Structural misuse (bad `function_id`, not an accepted declaration form, non-identifier params, generics) → `throw` a precise message; no overlay mutation.
- Semantic rejection (multi-statement body, impure arg, out-of-scope free var, non-call reference, arity/spread, this/await/recursion, namespace/default/re-export importer) → `throw` the analysis `reason`; no overlay mutation.
- Type-incorrect substitution that slips past analysis → caught by `validate` at commit; commit returns `{ ok: false, diagnostics }`, transaction rolls back, no materialized rows, no dangling edges.

## Testing (falsifiers)

**Analysis unit (`packages/store/tests/inlineAnalysis.test.ts`)**
- Accepts a clean getter/wrapper in all four declaration forms; normalizes params + body expression correctly.
- Substitution intent: `f(a, b)` → `(<expr with p0→a, p1→b>)`, parenthesized; multiply-used param substituted at each occurrence; member-property names not substituted.
- Rejects each boundary with a specific reason: multi-statement body; impure argument (call/await/assignment in an arg); out-of-scope free var (module-local + imported); non-call reference (value use, re-export, default/namespace import, dynamic import); arity mismatch; spread arg; default/rest/destructured param; generics; `this`/`super`/`arguments`/`await`; recursion.

**Shared-helper unit (`packages/store/tests/removeChildStatement.test.ts`)**
- Deletes a top-level statement; surviving siblings + EOF re-indexed DOWN by one with re-derived ids; gap-free contiguous indices; deleted nodes + edges captured for rollback; rollback restores both.
- `move_declaration`'s existing store + integration tests still pass after the refactor (no behavior change).

**Apply unit (`packages/store/tests/inlineFunction.test.ts`)**
- Each call-site `CallExpression` spliced to the parenthesized inlined expression; declaration deleted + siblings re-indexed; importer binding/statement stripped; manifest fields correct (callSitesInlined, importersStripped styles, modulesTouched).
- Rejection throws before any overlay mutation; rollback restores nodes + edges.
- Zero-call-site function: declaration deleted, importers stripped, `callSitesInlined === 0`.

**Integration (`packages/verify/tests/inlineFunctionCommit.test.ts`)**
- Inline a function called by ≥2 modules → commit clean → `find_declarations(name)` empty; every former call site type-checks; **re-ingest equivalence holds** (reuse the equivalence harness); forced type error in a substitution → commit `{ ok: false }`, transaction rolls back, no materialized rows / dangling edges.
- Mixed-importer strip (an importer importing `f` alongside another symbol) commits clean with only the `f` binding removed.

**Real corpus (`examples/medium`)**
- Inline a self-contained expression function called from ≥1 module and commit green (or refuse with a reason). Tolerant probe (never corrupts), like the move real-corpus test.

## Open questions resolved during brainstorming

- **v1 scope:** expression-body functions only (one returned expression).
- **Declaration forms:** `function` declaration + `const` arrow/function-expression (concise or single-return block body).
- **Argument safety:** require every argument at every call site to be syntactically pure (covers duplication + reordering in one rule).
- **Free variables:** params + globals/builtins only (self-contained, mirroring `move_declaration`); module-local/imported free vars refused.
- **Shared helper:** extract `removeChildStatement` from `move_declaration` and have both use it.
- **Zero call sites:** valid — inline degenerates to deleting the declaration + stripping importers.
- **Architecture:** pure-store analysis taking caller-supplied rendered text, reusing move's deletion/re-index/importer-strip + materialization; the only new mechanism is the hygienic AST substitution.
