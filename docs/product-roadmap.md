# Strata product roadmap

Living document. Update as iterations land. Source of truth for "what we're building next."

## Orientation

Strata's MVP success, per `strata-design.md` § "What success looks like":

1. End-to-end working substrate ✓
2. Benchmark shows measurable improvement on enough tasks that the architectural argument lands — T03 (rename) clearly wins; T01/T05/T08 are mixed or losses, and that's the honest current surface.
3. Write-up — not started.
4. Open source release with README — not started.

We have #1 in the bench-task sense. We don't have it in the "can we actually use this thing" sense — the agent can only run the four hardcoded bench prompts (T01/T03/T05/T08) on the bench corpora, and every session re-ingests into `:memory:` so the operation log dies with the process. **That's the next gap.** Polish for outside users (CLI surface, README, demo) is later.

## Stable signal (don't re-litigate)

- **T03 (rename across the corpus):** substrate wins materially on tokens, same quality. By design — this is the task the rename tool was built for.
- **T05 (debug a failing test):** substrate costs ~5× tokens for identical quality. The task is local; graph navigation is dead weight.
- **T08 (narrow return type):** substrate costs ~2× tokens for same quality. Mixed task; half structural, half creative caller refactor.
- **T01 (add parameter with per-callsite logic):** the per-callsite expressiveness gap is unresolved — value-channel is strings (decisions.md 2026-05-17 TERMINAL + 2026-05-26 forward-looking constraint).

## Iterations

Each iteration ships a thing. "Ships" means: it works end-to-end, the code is committed, and it has at least one real use.

### Iteration 1 — Works end-to-end on something real (done)

Goal: we can point the substrate at an arbitrary TypeScript codebase, give the agent an arbitrary task in plain English, and have it actually do it — with the operation log persisting so the next session sees the history.

- [x] **Arbitrary prompts.** `runAgent({corpusRoot, prompt, ...})` in `@strata/agent` plus `strata agent <corpusRoot> "<prompt>" [--db <path>] [--reset] [--print]` in the CLI. (commit `ec60f62`)
- [x] **Persistence.** SQLite store opens against any disk path; operation log + node graph durable across sessions; node IDs stable across the round trip (verified via two consecutive `strata agent` invocations against the same db). (commit `ec60f62`)
- [x] **External corpora work.** In-process `validate()` now resolves `@types` by walking up from the corpus tsconfig and falling back to the Strata repo's `@types`. Without this, the commit gate rejected anything outside the monorepo on missing-`@types/node` errors. (commit `252d56a`)
- [x] **One real dogfood.** Cloned `unjs/defu` (real TS lib, real deps, TS 6.x) and renamed `Merger` → `MergerFn` end-to-end. Same task surfaced and we fixed three real product gaps: typeRoots discovery, strict-src-only tsconfig assertion, and corpus-vs-Strata TypeScript version mismatch. (commit `a13f624`)

Out of scope for iteration 1: CLI polish beyond what dogfooding needs, README aimed at outside users, render-back utility (unless dogfooding forces it), watch-mode, schema migrations.

### Iteration 2 — Broaden the agent's capability surface (in progress)

Goal: tools that exercise tasks the agent literally can't do today.

- [x] **`create_function`** — append a new function declaration to a module. Unblocks the entire "add new code" class of tasks. Inserts into the nodes table immediately so validate() sees it within the same transaction; rollback deletes. Dogfooded: defu got a new exported `isEmptyPlainObject` helper, commit gate clean. (commit `338925e`)
- [x] **`add_import`** — add an import declaration to a module. Same shape as create_function. Dogfooded chained: defu got `import type { Input } from "./types"` plus a new `isInput(value): value is Input` type-predicate function in one transaction, commit gate clean, two ops in the log. (commit `5b68bac`)
- [x] **`list_module_exports`** — top-level exports of one module via one SQL + Identifier join. No more find_declarations + filter round-trips for module-API discovery. (commit `2749a52`)
- [x] **`find_declarations_in_module`** — module-scoped variant of find_declarations. Cuts speculative codebase-wide fishing when the module is already known. (commit `2749a52`)
- [x] **`read_test_file`** — reads a corpus test file by corpus-relative path (must resolve under corpusRoot, no `..`). Tests aren't ingested; this gives the agent direct text access for T05-class "fix the failing test" tasks without using the commit gate as an oracle. (commit `2749a52`)
- [x] **Perf: kill double tsc in commit gate + collapse N+1 SQL in find_declarations / get_references.** Substrate-side cost win on every commit and every query. (commit `42fd557`)
- [x] **`strata baseline` paired-cost CLI.** File-tools Claude Code on a temp copy of any corpus, same output shape as `strata agent`. Refactored shared baseline primitives out of `@strata/bench` into `@strata/agent/baselineShared.ts`. First paired comparison (Merger rename on defu): substrate 6 tools/32s/$0.05, baseline 12 tools/60s/$0.16 — substrate ~3× cheaper, ~2× faster on real external code. (commit `3268a67`)
- [ ] `extract_function` — pull a span of statements into a new function. The hero refactor; complex (parameter inference, span replacement with call site).
- [ ] `inline_function` — opposite. Moderate complexity around captures.
- [ ] `move_declaration` — move a declaration to a different module with import updates. Needs `add_import` first.

Each new tool needs at least one task it visibly wins on. The bench is the right tool for that question — but only after the tool exists, not before.

### Iteration 3 — Make it usable by someone else

Goal: someone who isn't us can clone the repo, follow a README, and use Strata.

Only after iterations 1 and 2 have landed. This is the iteration where the CLI surface, README, demo, and OSS-release prep happen — not before. Premature polish on an empty product is what we're trying to avoid.

### Iteration 4 — Write-up

Goal: the architectural argument is publishable.

Architecture write-up, results post (T03 win + honest gaps + what the rename-class win implies), demo capture.

## What not to do

These are off-roadmap until something forces them on:

- **Re-running benches to see if a number moved.** The numbers we have are the numbers; new bench task only when a new tool needs scoring.
- **Trying to close T01's per-callsite gap before shipping iteration 1.** The gap is documented; ship around it.
- **Building a UI.** Out of scope per `strata-design.md` § Scope of MVP.
- **Multi-language support, git integration, FUSE, multi-client concurrency.** Out of scope.
- **Sandbox experiments (`packages/lab`) without a falsifiable product question.** The lab has served its purpose; new lab work needs an explicit product justification.
