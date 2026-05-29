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
- **T05 (debug a failing test):** **stale signal under review.** The 2026-05-16 reading was "substrate costs ~5× tokens for identical quality" — that was true with the pre-iteration-3 tool surface. A single paired N=1 dogfood on 2026-05-27 (decisions.md entry of that date) found substrate+L1 at ~51% the cost of the file-tools baseline on the same task (1,012 vs 783 non-cached tokens — substrate uses ~29% more tokens but creates 81% less cache, and cache pricing dominates). Don't generalize from N=1, but the prior "5× tokens, dead weight" framing is wrong now and needs a fresh paired round before being re-quoted. The task is still local — file tools win on tool count (5 vs 6) — but on cost the substrate wins.
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
- [x] **Graph materialization** — created/inserted functions, imports, and `add_parameter` edits are now materialized into the node graph at commit time (findable via `find_declarations`, correct `node_references` edges). Implemented as a commit-time pass: class-1 emits Identifier children for additive nodes (EOF off-by-one fixed first); class-2 re-derives identifiers for structurally-changed statements; `refreshReferenceEdges` resolves edges over the bounded dirty-module set. `isNoop` gate keeps rename-class (T03) commits off the TypeChecker path. This was the `extract_function` prerequisite. (commits `887cf54`–`7ae2008`)
- [x] `extract_function` — pull a span of statements into a new function. Full auto-infer (statement index range + name), sync + await, graph-consistent via the materialization prerequisite; rejects control-flow escapes / this / generics / outer reassignment with explicit reasons. (merge `eb35759`, plan `docs/superpowers/plans/2026-05-28-extract-function.md`)
  - **Validation (N=1 paired dogfood, 2026-05-29, decisions.md):** the file-tools baseline **wins both** the one-shot extraction ($0.097 vs $0.117, +21%; 4 vs 7 tools) AND the compound extract→rename→add_parameter ($0.100 vs $0.209, **+108%**; 3 vs 16 tools). Both arms produced correct, tsc-clean results. The compound made the substrate *worse*, not better — a freshly-extracted helper has one caller, so no follow-on op is bulk, while the substrate pays transaction+validate+commit ceremony per op. **Conclusion: extract-class tasks are not a substrate cost win and aren't expected to be.** The substrate's cost edge is specific to **bulk propagation over many existing references** (rename/add_parameter on widely-used symbols, T01/T03-class — T03 already demonstrates it). extract_function's value is correctness/safety + graph-citizenship for future bulk ops, not cost. Harness: `pnpm --filter @strata/bench dogfood:extract`. The "visibly wins" gate is met by T03, not by extract.
- [ ] `inline_function` — opposite. Moderate complexity around captures.
- [x] `move_declaration` — cross-module move of a declaration with importer rewrite; bulk-propagation class (repoints every named importer). v1 is self-contained (only moves symbols whose deps are global / own-internal / already in the target) and named-imports-only — refuses namespace, default, re-export, and dynamic imports with specific reasons. Intentional ID churn (delete-from-source + recreate-in-target, logged per the stable-IDs invariant); `appendChildStatement` extracted as a shared insert helper; first top-level-statement deletion in the codebase (source-sibling + EOF re-index DOWN); overlay now restores deleted edges on rollback. `dogfood:move` harness ready for keyed validation (not run as part of the build). (commits `bcc88a3`–`9606fa3`, decisions.md 2026-05-29)

Each new tool needs at least one task it visibly wins on. The bench is the right tool for that question — but only after the tool exists, not before.

### Iteration 2.5 — Three-layer codebase index (done, unvalidated)

Goal: every `strata agent` invocation gives the agent a structural view of the codebase before the first tool call, and the substrate compounds across sessions.

Specs: [`docs/specs/2026-05-26-three-layer-codebase-index-design.md`](specs/2026-05-26-three-layer-codebase-index-design.md), [`docs/specs/2026-05-26-three-layer-codebase-index-plan.md`](specs/2026-05-26-three-layer-codebase-index-plan.md). Telemetry + structured-pattern follow-up from PR review landed alongside.

- [x] **L1 — static module index (always-on).** `buildModuleIndex(db, corpusRoot)` injected as `## Codebase shape` before the user prompt. `module_index_injected` log event. `--no-index` flag for paired comparison. `assembleAgentPrompt` extracted as a pure function so the L1+L3+separator ordering is test-pinned.
- [x] **L2 — vector-augmented retrieval.** `sqlite-vec@0.1.9` integrated (gated by `isVecAvailable` for graceful disable). `OpenAIEmbeddingProvider` against text-embedding-3-small with content-hash skip. `semantic_search` agent tool (tool count 16 → 17). Auto-embeds at session start when `STRATA_EMBED_API_KEY` is set; `embeddings_built` / `embeddings_failed` log events. `strata embed` CLI for explicit re-embed.
- [x] **L3 — operation log as memory.** `triggering_prompt` column on `transactions` (idempotent ALTER). `commit_pattern_meta.pattern_json` (structured `CommitPattern`, not parsed string) + `commit_pattern_embeddings` vec table. `retrieveSimilarPastTasks` injected as `## Past tasks like this one` between L1 and the user prompt. Cold-start silent. `past_tasks_injected` / `past_tasks_failed` / `commit_pattern_embed` log events.
- [x] **L1.4 dogfood harness.** `pnpm --filter @strata/bench dogfood:l1 -- <corpus>` runs the freeform agent twice (index-off, then index-on) on T05 and prints a comparison table. Operator-only, key-gated.
- [x] **L1.4 dogfood run** (2026-05-27, decisions.md). N=1 paired on T05/examples/medium. PASS on primary acceptance (cost USD ratio 62.8% ≤ 80%). Total-tokens-as-acceptance was found to be the wrong metric (cache pricing dominates); harness updated to use cost USD primary, tokens secondary.
- [x] **T05 substrate-vs-file-baseline** (2026-05-27, decisions.md). N=1 paired. Strata+L1 at ~51% baseline cost on T05; "T05 substrate ~5× tokens" claim above is stale and reframed in-place.
- [x] **L3.4 dogfood run + control arm** (2026-05-27, decisions.md). N=1 paired on examples/medium (User→Account then Clock→TimeSource), plus a control arm running Clock alone on a fresh DB. All four harness-acceptance criteria PASS (mechanism activates end-to-end), but the control isolates the L3 contribution at ~3% cost / 1 fewer tool call / 1 fewer turn on this small corpus. The "B is 54% of A" headline is overwhelmingly task-size, not L3. Conclusion: L3 mechanism works as designed; L3's compounding value on a 22-module corpus with one past pattern is modest. Re-evaluate when L2.5 runs on a larger corpus.
- [ ] **L2.5 dogfood.** Corpus identified and smoke-validated: valibot/library (~1,087 modules, ingest + find_declarations + agent-path commit gate verified as of 2026-05-27, notes in `docs/dogfood-results/l2.5-prep-2026-05-27T19-07-05Z.md`). Smoke surfaced (and fixed in-session) a find_declarations JSDoc-offset bug across 6 store call sites; also surfaced (deferred) a validate() non-src scoping gap in bare commit(). Ready for keyed comparison with caveat: use the agent path (commitWithBehavioralGate), not bare commit(). Next step: build a dogfood:l2 harness paralleling dogfood:l1 / dogfood:l3, then run the keyed paired comparison; primary task P-Luhn (_isLuhnAlgo rename) per spec.

Known follow-up hardening (deferred from PR review, none state-corrupting): L2 in-session staleness after rename, group `embeddingProvider`+`taskPrompt` on ctx into one `semanticIndex?` field, `embed` CLI returning `{ok:false,reason}` instead of throwing, multi-module commit-pattern tests, content-changed re-embed tests, k-cap tests, OpenAI HTTP error-path tests, batching boundary tests, non-`src/` module-path branches.

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
