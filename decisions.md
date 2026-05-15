# Decisions

A running log of build-time decisions for Strata. Append-only. Newest at the top.

Log an entry whenever:
- A choice diverges from `strata-design.md` (swapped library, changed schema, dropped/added scope, different tool shape).
- A spec-level question from § "Open design questions" gets resolved.
- A non-obvious trade-off is made that a future reader would otherwise have to re-derive.
- An attempt fails and shapes the next attempt (record the failure too — silent retries lose information).

If the decision is durable, also update `strata-design.md` and reference the diff or commit from the entry.

## Entry format

```
## YYYY-MM-DD — <short title>

**Context:** what triggered this decision (phase, package, problem encountered).

**Considered:** the alternatives weighed (briefly).

**Decided:** what we're doing now.

**Why:** the reasoning, especially anything not obvious from the alternatives.

**Design-doc impact:** "none" / "updated § X" / "supersedes § X paragraph N".

**Revisit when:** the condition that should make us reopen this (e.g., "if Phase 4 benchmarks show ingest is the bottleneck").
```

---

<!-- New entries go below this line, newest first. -->

## 2026-05-15 — Stable node IDs use path plus structural child path

**Context:** Phase 1 Task 1 needs deterministic node IDs before identifier-level ingest and rename operations can preserve identity across non-structural mutations.

**Considered:**
- Path + structural-position hash: `modulePath`, dot-joined child index path, and node kind.
- Content-anchored IDs based on source text or syntax-node content.

**Decided:** Use `sha1(modulePath + ":" + childIndexPath + ":" + kind)`, truncated to 16 hex characters, implemented as the single `nodeId()` helper in `@strata/store`.

**Why:** This is deterministic across re-ingest of unchanged files and stable across Phase 1 rename mutations, which only change identifier text and do not alter parent/child shape. Content anchoring would better survive statement insertion, but it is more work than Phase 1's rename slice needs.

**Design-doc impact:** none yet — this resolves a Phase 1 plan-level open choice without changing the design direction.

**Revisit when:** operations need identity stability across structural edits such as inserted statements or moved declarations.

## 2026-05-14 — EOF trivia stored as a sibling `EndOfFileTrivia` node, not on the module

**Context:** Phase 0 ingest review found trailing trivia (comments/whitespace between the last statement's end and EOF) was silently dropped because `sourceFile.statements` doesn't include the `endOfFileToken`. A real codebase with a trailing footer comment would round-trip lossy without ingest noticing.

**Considered:**
- (a) Add a synthetic child node of kind `EndOfFileTrivia` at the highest `childIndex`, with the trivia text as its payload.
- (b) Attach the trivia to the module node (e.g., JSON-encode `{ path, trailingTrivia }` into the module payload).

**Decided:** (a). The module payload stays a plain string label, and rendering — which already orders children by `childIndex` — concatenates the trivia naturally as the last child.

**Why:** Keeps the module payload schema simple (still just a path string), avoids special-casing module payload parsing in render, and produces byte-identical round-trip on the new comment fixture and on all examples/small/*.ts. The trade-off is one extra node per module and a non-statement kind in the child list — fine because `EndOfFileTrivia` is structurally just another payload-bearing child for Phase 0.

**Design-doc impact:** none yet — Phase 0 is intentionally pre-schema. Lock in when the formal node-graph schema is written for Phase 1.

**Revisit when:** statement-level lowering lands and ingest no longer stores raw source text per child. The lowering for EOF trivia will probably remain "verbatim text" since it has no semantic structure, but the node kind may want renaming once other trivia kinds (between-statement comments, JSDoc) get their own representation.

## 2026-05-14 — Verify uses in-process TypeScript Compiler API, not subprocess `tsc`

**Context:** Phase 0 CLI initially shelled out to `npx tsc --noEmit` with hard-coded compiler options that didn't match `tsconfig.base.json`. Three problems: (1) PATH-dependent `npx` resolution, (2) the rendered output was being type-checked under different settings than the project's own build, (3) it contradicted the 2026-05-14 "TS Compiler API everywhere" decision logged below.

**Decided:** Verify is now in-process: `ts.createProgram([outputPath], options)` + `ts.getPreEmitDiagnostics(program)`. Compiler options are loaded from `tsconfig.base.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. No subprocesses anywhere in `packages/cli`.

**Why:** Consistency with the parser/printer decision; one toolchain for parse, print, and verify. Also faster (no `npx` cold start), and the rendered output is checked under the same compiler options that the project's own packages build under.

**Design-doc impact:** Consistent with strata-design.md § Verify ("TypeScript Compiler API for in-process type checks"). The design doc was already correct — Phase 0's first cut diverged and has now been brought back in line.

**Revisit when:** multi-file verification is needed (Phase 2). The current implementation only type-checks the single rendered file; Phase 2 will need program-level verification across all rendered modules.

## 2026-05-14 — Use TypeScript Compiler API for parse + print in Phase 0 (drop tree-sitter and Prettier)

**Context:** Phase 0 bootstrap. The design doc specifies `tree-sitter-typescript` for parsing and `prettier` for canonical rendering, with the TS compiler API reserved for type-checking in `verify`.

**Considered:**
- tree-sitter + Prettier as specified.
- @swc/core (fast Rust parser with a built-in printer).
- TypeScript Compiler API (`typescript` package) for both parse and print, with Prettier added later only if style needs tightening.

**Decided:** Use the TypeScript Compiler API for both parse and print in Phase 0. No tree-sitter, no swc, no Prettier yet.

**Why:** The design's stated reason for tree-sitter is "round-trip preservation," but Strata renders canonically and discards original formatting — that benefit is moot for our pipeline. Meanwhile `verify` already needs the TS compiler API, so using it as the parser too collapses three toolchains into one. `ts.createPrinter()` produces serviceable canonical output; Prettier can be a post-pass when we have a reason to add it. Cuts dependencies, install time, and conceptual surface for a phase whose only goal is proving the pipeline.

**Design-doc impact:** Supersedes the Tech stack § "Parser" recommendation and the Render § "prettier" line *for Phase 0*. Will revisit at Phase 1 boundary; if expression-level lowering reveals TS-printer output to be inadequate, reopen.

**Revisit when:** (a) we need richer formatting control than `ts.createPrinter()` provides; (b) ingest perf becomes a bottleneck (swc); (c) we need incremental reparse for live editing (tree-sitter).
