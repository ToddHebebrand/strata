# extract_function — design

**Date:** 2026-05-27
**Status:** approved (design); pending Codex xhigh review before the implementation plan is written
**Roadmap line:** `docs/product-roadmap.md` § "Iteration 2", unchecked `extract_function`
**Design-doc reference:** `strata-design.md` § "Tool set" — `extract_function(scope_node_id, name, params)` listed as a high-level structural operation

## Goal

Ship the first `extract_function` structural tool: the agent names a span of statements inside a function body and a new function name; the substrate infers the parameters (free variables captured from the enclosing scope) and the return shape (variables defined in the span and used afterward), synthesizes the new function, and replaces the span with a call. This extends the rename-class substrate win ("agent supplies intent + a name; substrate owns the graph operation") to a new task class: structural refactoring of function bodies.

This is **Shape B** (substrate infers params and returns), **Envelope 2** (handles pure sync spans + async spans; rejects control-flow, `this`, generators, and captured-mutation spans with named reasons).

## Non-goals (v1)

- Control-flow-spanning extraction (early `return`/`break`/`continue` inside the span). Rejected.
- `throw` inside the span. Rejected in v1 (conservative — extracting a throw out of a surrounding `try/catch` changes semantics). Revisit in v2.
- Mutation of a captured `let`/`var` (defined outside the span, reassigned inside). Rejected in v1 — handling it correctly requires return-and-reassign synthesis (Envelope 3).
- `this` references, generators (`yield`). Rejected.
- Choosing placement of the new function (always appended after the parent declaration in the same module).
- Synthesizing explicit type annotations (relies on TypeScript inference + the commit gate).
- Extracting from arrow functions with expression bodies (no statement block). Rejected (`body-not-block`).

## Architecture

`extract_function` is a transactional mutation primitive in `packages/store/src/extractFunction.ts`, the same shape as `rename_symbol` / `add_parameter` / `replace_body`. It requires an open transaction and produces two queued edits committed atomically:

1. **Body splice** on the parent function's text payload: delete the span, insert the call expression.
2. **New function node** appended as a top-level statement in the parent's module.

Both edits live in one transaction; `validate(tx)` type-checks the post-edit rendered module via the existing commit gate; `commit()` blocks if tsc fails; `rollback` discards both.

### Why a dedicated primitive, not a composite

`extract_function` is not factored as `replace_body` + `create_function` because (a) `replace_body` replaces an entire body, not a span; (b) the operation log should record "extract" as one named intent with its captures/returns, not two unrelated text edits. This mirrors why `add_parameter` is its own primitive rather than "edit body + edit each callsite."

### Representation constraint this design works within

Strata's ingest persists only **top-level** statements as nodes (children of the Module). Statements *inside* a function body are not addressable by node ID — the body is stored as a single text payload (`statement.getFullText()`). Identifiers inside the body *are* first-class nodes (children of the function statement, with `{text, offset}` payloads). `extract_function` therefore addresses the span by **statement index within the body**, parsed live from the payload via `ts.createSourceFile` — the same text-span-surgery approach `add_parameter` uses (`locateSpan` + `queueTextSpanEdit`). No ingest or schema change.

## API

```typescript
extract_function(
  db: Db,
  tx: TxHandle,
  parentFunctionId: string,    // FunctionDeclaration / FirstStatement node containing the span
  startStatementIndex: number, // 0-based, within the parent's body block
  endStatementIndex: number,   // inclusive
  newFunctionName: string
): ExtractFunctionResult
```

```typescript
type ExtractFunctionResult =
  | {
      ok: true;
      newFunctionId: string;   // node ID of the new top-level function
      params: string[];        // inferred captures, ordered by first-use offset in the span
      returns: string[];       // inferred returns (defined-in-span, used-after)
      isAsync: boolean;        // span contained await / for-await → extracted fn is async
    }
  | {
      ok: false;
      reason: ExtractFunctionRejection;
      detail: string;          // human-readable, includes statement index where applicable
    };

type ExtractFunctionRejection =
  | "span-out-of-range"
  | "parent-not-function"
  | "body-not-block"
  | "contains-early-return"
  | "contains-throw"
  | "contains-break-or-continue"
  | "contains-this"
  | "contains-yield"
  | "contains-mutation-of-capture"
  | "name-conflicts";
```

Structural rejections return synchronously (no commit needed). Type errors that survive structural checks fall to the commit gate via `validate(tx)`.

Typical agent flow:
1. `find_declarations({ name: "myFunction" })` → parent function id.
2. `read_node(parentId)` → body text; index statements.
3. `extract_function(tx, parentId, 3, 7, "helper")` → result.

## Capture analysis

The substrate parses the parent function's payload, locates statements `[start..end]` in the body block, and runs four passes.

### Pass 1 — Free variables → params

Walk identifiers in the span. For each, determine its declaration site:
- **Inside the span** → not a param.
- **In the enclosing function's scope but outside the span** (parameters of the parent, or `let`/`const`/`var`/`function` declared earlier in the parent body) → **capture → param.**
- **Module-level or imported** → not a param (visible to the new top-level function too).

Params are ordered by first-use offset within the span (stable, predictable). Deduplicated.

**Open correctness question for Codex:** whether this requires a TypeScript `TypeChecker` (expensive — `ts.createProgram` over the module per call) or a hand-rolled scope walker is correct for the cases Envelope 2 claims. A hand-rolled walker must handle `var` hoisting, block vs. function scope, destructuring patterns, and shadowing. This is the single biggest correctness risk in the design and the primary thing the Codex review must attack.

### Pass 2 — Defined-in-span, used-after → returns

For each `let`/`const`/`var` name declared in the span, check for any use in statements `[end+1..]` of the parent body. If used after → return.
- 0 returns → call site: `helper(captures...);`
- 1 return → call site: `const r = helper(captures...);`
- 2+ returns → call site: `const { a, b } = helper(captures...);`; new function ends `return { a, b };`

### Pass 3 — Rejection scans

Walk the span for: `ReturnStatement` → `contains-early-return`; `ThrowStatement` → `contains-throw`; `BreakStatement`/`ContinueStatement` → `contains-break-or-continue`; `ThisKeyword` → `contains-this`; `YieldExpression` → `contains-yield`. Any hit → synchronous rejection.

### Pass 4 — Captured-mutation scan

For each captured variable (from Pass 1) that is a `let`/`var` in the enclosing scope, check whether the span reassigns it (assignment, `++`/`--`, compound assignment). If so → `contains-mutation-of-capture`. (Without return-and-reassign synthesis, extracting would silently drop the mutation. v2 handles it; v1 rejects it.)

### Async detection

Walk the span for `AwaitExpression` and `ForOfStatement` with an `awaitModifier`. Either → `isAsync = true`. Not a rejection: the new function is marked `async` and the call site is `await`ed.

## Synthesis

New function text:
```
{async }function {name}({params joined by ", "}) {
  {span statements verbatim}
  {return synthesis per Pass 2}
}
```

No type annotations synthesized (relies on inference + tsc gate — consistent with `create_function`). Call expression: `{await }{const binding }{name}({params...});`. Formatting is canonical/lossy per `strata-design.md`; the render pipeline normalizes.

The new-function insertion reuses `create_function(db, tx, moduleId, functionText)` internals. The body splice uses `queueTextSpanEdit(tx, parentFunctionId, span, callExpressionText)`.

## Operation log

One `ExtractFunction` op recorded with `{parent_function_id, span: [start_offset, end_offset], new_function_id, captures, returns, isAsync}`, actor + reasoning per the standard mutation path. `affected_node_ids` = `[parentFunctionId, newFunctionId]`.

**Note:** the span offsets are point-in-time facts relative to the pre-edit payload; they are not valid for replay after subsequent edits. v1 has no extract-replay use case — confirm with Codex that this is acceptable.

## File structure

```
packages/store/src/extractFunction.ts          (new, ~250-350 lines)
  ├ extract_function(db, tx, parentFunctionId, start, end, newFunctionName)
  ├ collectCaptures(span, parentBody) → string[]
  ├ collectReturns(span, parentBody, end) → string[]
  ├ scanForRejections(span) → ExtractFunctionRejection | undefined
  ├ scanForCapturedMutations(span, captures, parentBody) → boolean
  ├ detectAsync(span) → boolean
  ├ synthesizeFunctionText(name, params, returns, isAsync, spanText) → string
  └ synthesizeCallExpression(name, params, returns, isAsync) → string

packages/store/src/index.ts                     (barrel: add export)
packages/store/tests/extractFunction.test.ts    (new; see Testing)
packages/agent/src/tools.ts                      (MCP wrapper; STRATA_TOOL_NAMES 17 → 18)
```

No ingest, schema, or render changes. No new tables.

## Testing

TDD. Each rejection case fails before its scanner exists, then passes. Happy-path cases are real ingest→extract→render→validate flows against small in-memory fixtures (pattern: `tests/jsdocDeclarations.test.ts`).

Cases:
- pure: no captures, no returns
- pure: with captures
- pure: single return (const binding at call site)
- pure: multiple returns (destructure at call site)
- async: `await` in span → `async function` + `await` call
- async: `for await ... of` in span → async
- rejection: early return
- rejection: throw
- rejection: break / continue
- rejection: this
- rejection: yield
- rejection: mutation of captured `let`
- rejection: name conflicts in module
- rejection: span out of range
- rejection: parent not a function
- rejection: body not a block (arrow with expression body)
- integration: commit gate passes on a clean extract; operation log records the op with correct captures/returns
- integration: rollback discards both the body splice and the new function
- **integration: extract from a JSDoc'd parent function** — mandatory, given the JSDoc-offset fix this session; verifies the tool resolves the parent's identifier correctly via `resolveDeclarationNameIdentifier` (not the lowest-offset child)

## Risks (carried into the Codex review)

1. **Capture analysis correctness (Pass 1).** TypeChecker vs hand-rolled scope walk. Biggest risk. The Codex review must attack whether the chosen approach is correct for `var` hoisting, block scope, destructuring, and shadowing.
2. **Captured-mutation detection completeness (Pass 4).** Does the scan catch all reassignment forms (`x = `, `x += `, `x++`, destructuring assignment `({x} = ...)`, array-destructuring assignment)?
3. **Operation-log offset encoding** is point-in-time, not replay-safe. Confirm no replay use case for extract.
4. **Async detection** must include `for await ... of`, not just bare `await`.
5. **New-function placement** ("after the parent declaration") is a non-load-bearing default.

## Process gate

Per `CLAUDE.md`: this is a non-trivial, different-class lever. **Before the implementation plan is written, the spec goes to Codex (gpt-5.5, reasoning xhigh, read-only, repo-grounded) for an independent review.** Codex's brief: attack Pass 1's correctness, the rejection-list completeness, the op-log encoding, and propose the cheapest falsifier tests. Verify Codex's pivotal claims against the actual code before accepting. Codex's verdict drives whether the plan needs adjustment before execution.

## Out of scope this iteration

- Envelope 3 (mutation-as-return, control-flow-aware extraction).
- `inline_function` (the inverse; separate roadmap item).
- `move_declaration`.
- Any bench/keyed measurement of extract_function — that follows after the tool exists and a task that exercises it is identified, per the iteration-2 rule ("the bench is the right tool for that question, but only after the tool exists").
