# Three-layer codebase index — implementation plan

**Companion to:** `2026-05-26-three-layer-codebase-index-design.md`. Design rationale and what-and-why live there; this doc is the build order.

**Build order is strict.** Each layer depends on the one before it for either infrastructure or for the dogfood scenario that proves it works.

---

## Layer 1 — Static module index (target: ship today / next session)

**Goal:** every `strata agent` invocation auto-injects a codebase-shape summary as the agent's turn-1 context. Demonstrable token reduction on T05-class tasks.

### Tasks

#### L1.1 — `buildModuleIndex` in `@strata/agent` (new file)

- New file: `packages/agent/src/moduleIndex.ts`
- Export `buildModuleIndex(db: Db, corpusRoot: string): string` — returns the index text (markdown-ish, parseable by the model).
- Reuse `list_module_exports` from `@strata/store` per module. Reuse `listModules` for the module list.
- For each module: emit a line like `<corpus-relative-module-path>: <kind> <name>[ exported], ...`
- After the modules section, add a "tests/ (not in graph, use read_test_file):" section listing `.test.ts` / `.spec.ts` files under `tests/` or `test/` (filesystem walk; not in the graph).
- Pure function. No DB writes. No filesystem mutations.

**Acceptance:**
- Unit test in `packages/agent/tests/moduleIndex.test.ts`:
  - Seeded store with 3 modules; emitted index contains all three module paths and their declaration names.
  - A non-exported declaration is marked without the `[exported]` tag; an exported one has it.
  - Test files under `<corpus>/tests/` and `<corpus>/test/` both appear in the "tests/" section.
  - Empty corpus → returns an empty-but-well-formed string ("Codebase shape: (empty)\ntests/: (none)\n" or similar).

#### L1.2 — Inject the index into `runAgent`

- Modify `packages/agent/src/runAgent.ts` and/or `packages/agent/src/session.ts`.
- New optional param `injectModuleIndex?: boolean` (default `true`) on `RunAgentParams`.
- When true and an `acceptance.corpusRoot` exists, build the index right after ingest and pass it through to `runLiveSession` so it's the FIRST thing in the agent's prompt context.
- Implementation choice: prepend the index to the agent's task prompt as a `## Codebase shape` section, BEFORE the user's prompt. Avoids touching the system prompt (keeps prompt cache clean per CLAUDE.md).
- Log the index size (chars + lines) in a `SessionLogEvent` so we can later measure how much per-session context this added.

**Acceptance:**
- Run `strata agent /tmp/defu 'rename ...'` and capture the session log; first `assistant_text` or first tool call sees an injected context block.
- Run the same task twice; cumulative agent tokens DROP on tasks where the agent previously did speculative `find_declarations` (T05-class). One paired dogfood comparison (with vs without `--no-index`) is the proof.

#### L1.3 — CLI flag to disable for measurement

- `strata agent ... --no-index` toggles `injectModuleIndex: false` so we can run with/without and compare token counts. Default is on.

**Acceptance:**
- `strata agent <corpus> "<prompt>" --no-index` runs cleanly; output JSON's `cost` block shows higher token usage on a T05-style task than the same run with the index.

#### L1.4 — Dogfood comparison

- Pick a T05-style task on `examples/medium` (or defu): the bench's T05 prompt against examples/medium.
- Run twice: once with index, once with `--no-index`.
- Capture cost block both times. Record the delta in a new entry in `decisions.md` (or a small `docs/dogfood-results.md` if we want a running log).

**Acceptance:**
- Index-on cost ≤ 80% of index-off cost on this single comparison. (Honest read: N=1, not a claim about all tasks.)

### Files changed in L1

- New: `packages/agent/src/moduleIndex.ts`
- New: `packages/agent/tests/moduleIndex.test.ts`
- Modified: `packages/agent/src/runAgent.ts`, `packages/agent/src/session.ts`, `packages/agent/src/index.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/agent.ts`

### Out of scope for L1

- Per-module signature lines (just names, per design doc).
- Live re-index after mutations (the index is built at session start; the agent's own mutations are visible via existing tools, no need to re-inject).
- Index for the operation log (that's L3).

---

## Layer 2 — Vector-augmented retrieval (target: 1–2 days after L1 lands)

**Goal:** semantic discovery via `semantic_search(query, k?)` that returns top-K declarations with structural metadata. Scales past Layer 1's token-per-module ceiling.

### Tasks

#### L2.1 — `sqlite-vec` integration

- Add `sqlite-vec` to `packages/store` dependencies. Verify it loads against the existing `better-sqlite3` build (it ships as a SQLite extension).
- Extend `openDb()` to load the vec extension. On platforms where loading fails, fall back to "no vec available" mode (Layer 2 gets disabled gracefully; Layer 1 still works).
- Schema migration: add a `node_embeddings` virtual table (vec0 form). Columns: `node_id TEXT PRIMARY KEY`, `embedding FLOAT[<dim>]` where dim depends on the chosen model (1536 for OpenAI text-embedding-3-small, 1024 for voyage-3-lite).
- A second table `embedding_meta`: `node_id TEXT PRIMARY KEY, model TEXT, content_hash TEXT, embedded_at INTEGER` — lets us re-embed on content change and know which embedding model produced the vector.

**Acceptance:**
- Unit test: openDb works with vec available and works (Layer 2 disabled) when vec isn't available.
- Unit test: insert a vector, search for it, get it back as top-1.

#### L2.2 — Embedding pipeline

- New file: `packages/store/src/embed.ts` (or new package `@strata/embed` if we want isolation; start with `embed.ts` in store).
- Single function `embedDeclarations(db, declarations, opts)` that:
  - Builds the embedding text for each declaration (per the design doc: signature + module path + ref counts + body excerpt — NOT naked code).
  - Calls the embedding API in batches (~100 per call).
  - Writes vectors to `node_embeddings` and metadata to `embedding_meta`.
  - Skips re-embed when `content_hash` matches.
- Embedding API: start with OpenAI text-embedding-3-small (cheap, widely available). Abstract through an interface so voyage-3 / cohere / local can swap in.
- API key from env var `STRATA_EMBED_API_KEY` (or use the existing `ANTHROPIC_API_KEY` if we go with Anthropic-future or `OPENAI_API_KEY` if OpenAI). Keep env var name explicit so it's clear which provider.

**Acceptance:**
- Unit test (mock the API) that batches correctly, persists vectors, skips unchanged content.
- Smoke run against examples/medium: embed all top-level declarations, verify the `node_embeddings` row count matches the `list_module_exports` count.

#### L2.3 — `semantic_search` agent tool

- New file: `packages/store/src/semanticSearch.ts` — `semantic_search(db, query, k = 10)`:
  - Embed the query (single API call).
  - SQL: `SELECT node_id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`.
  - Resolve each `node_id` to its NodeRow + parent module path. Return `{id, kind, name, modulePath, distance}[]`.
- Wire as `semantic_search` tool in `packages/agent/src/tools.ts`. Tool description emphasizes "use when you don't know the symbol name; for known names use find_declarations".
- Update `STRATA_TOOL_NAMES` and the count tests.

**Acceptance:**
- Wire-up test: agent surface registers 17 tools (was 16); regression tests in `elevenTools.test.ts` updated to 17.
- Smoke: against an embedded defu store, `semantic_search('plain object check')` returns `isPlainObject` in top-3.

#### L2.4 — Index pipeline triggers

- `runAgent`: after ingest, if embeddings are stale (any node missing an embedding or content_hash mismatch), embed them. Gated by `STRATA_EMBED_API_KEY` being set; absent → skip silently (Layer 2 disabled).
- Optional CLI: `strata embed <corpusRoot> --db <path>` for explicit re-embed.

**Acceptance:**
- Smoke: `strata agent /tmp/defu '...' --db /tmp/defu/.strata.db` with `STRATA_EMBED_API_KEY` set populates `node_embeddings` on first run; second run reads cached embeddings without re-embedding.

#### L2.5 — Dogfood comparison

- Find a larger TS project where Layer 1's index becomes unwieldy (200+ modules). Cancel out the embedding cost in the measurement (one-time per ingest, amortized).
- Run a discovery-heavy task with and without `semantic_search` available. Capture tokens.

**Acceptance:**
- semantic_search-on cost ≤ index-on cost on a corpus where Layer 1 alone would inject >5k tokens.

### Files changed in L2

- New: `packages/store/src/embed.ts`, `packages/store/src/semanticSearch.ts`, dependency on `sqlite-vec`.
- Modified: `packages/store/src/schema.ts` (extension loading + table), `packages/store/src/index.ts`, `packages/agent/src/tools.ts`, `packages/agent/src/prompt.ts`, agent tests.

### Risks / open items

- `sqlite-vec` ships native binaries; platform-specific loading may need work. Fallback path is graceful disable.
- Embedding-provider choice: OpenAI text-embedding-3-small is cheapest and best-tested. Voyage-3 is reportedly better at code. Defer the comparison; start with one provider.
- Embedding cost: a 10k-declaration codebase at ~200 tokens per declaration = ~2M input tokens = ~$0.04 to embed. Negligible.

---

## Layer 3 — Operation-log as memory (target: when L2 stabilizes)

**Goal:** the substrate compounds. Past agent sessions inform future ones via embedded commit-pattern retrieval.

### Tasks

#### L3.1 — Capture the prompt that triggered each transaction

- Operations table currently has `actor, ts, reasoning` per op but NOT the triggering prompt.
- Schema migration: add `transactions.triggering_prompt TEXT NULL` (or a sibling `commit_patterns` table linked by tx_id).
- Plumb the agent's prompt through `runAgent` → `ctx` → `begin()` so it's recorded on every `begin_transaction` call.

**Acceptance:**
- After a `strata agent <corpus> "<prompt>"` invocation that commits, the transactions row has the prompt text in `triggering_prompt`.

#### L3.2 — Embed commit patterns

- After each successful commit, build a "commit pattern" string:
  ```
  Prompt: <triggering_prompt truncated to ~200 chars>
  Ops: <op_kind list>
  Modules: <unique affected module paths>
  Declarations: <unique affected declaration names where derivable>
  ```
- Embed and store via the same pipeline as L2, in a sibling table `commit_pattern_embeddings`.

**Acceptance:**
- After two committed transactions in the same store, both have rows in `commit_pattern_embeddings`.

#### L3.3 — Retrieve similar past patterns at session start

- New function `retrieveSimilarPastTasks(db, taskPrompt, k = 5)` — embeds the incoming prompt, top-K commit patterns by cosine similarity, returns `{prompt, ops, modules, declarations, similarity}[]`.
- Inject into the agent's turn-1 context as a "Past tasks like this" section, AFTER the Layer 1 module index. Bounded to a small number (k=5) so context cost stays small.
- Skip injection silently when `commit_pattern_embeddings` is empty (cold start).

**Acceptance:**
- After running task A on a corpus, running a similar task B sees A's pattern in the injected context.
- After running 10 unrelated tasks, the 11th retrieves only the actually-similar ones (k=5 cap holds).

#### L3.4 — Dogfood compounding

- On a fresh corpus, run task A: rename type X. Capture cost.
- Run task B (similar shape): rename type Y. Capture cost.
- The expectation: B's cost is lower than A's because the agent retrieves A's pattern and immediately knows what tools to use and which modules to expect to touch.

**Acceptance:**
- B's session cost < A's, with both producing successful commits. Honest read: N=1 demo, not a claim about general compounding.

### Files changed in L3

- Modified: `packages/store/src/schema.ts` (new column/table), `packages/store/src/transactions.ts` (capture prompt at begin), `packages/store/src/embed.ts` (extended for commit patterns), `packages/agent/src/runAgent.ts` (retrieval + inject).
- New: `packages/store/src/commitPatterns.ts` (build + embed + retrieve).

### Out of scope for L3 (deferred to v2)

- Cross-corpus commit-pattern sharing.
- Negative examples (the agent's failed attempts) as training data.
- An explicit `note(text)` tool — wait to see if op-log mining alone is sufficient.

---

## Validation thread (runs through all three layers)

Each layer ships with **one paired dogfood comparison** in its acceptance criteria. These are not bench rounds; they're single demonstrations that the layer does what its design says it does. We capture them as a running record (probably a new `docs/dogfood-results.md` or appended to `docs/RESULTS.md`) so the cumulative picture is honest:

- L1 dogfood: T05-style task with/without `--no-index`. Expect ≥20% token reduction with index.
- L2 dogfood: discovery-heavy task on a 200+ module corpus with/without `semantic_search`. Expect Layer 2 to cost less than Layer 1's full-dump alternative.
- L3 dogfood: two similar-shape tasks on the same corpus. Expect the second to cost less than the first.

When any of these comparisons disconfirms the design, **stop and re-read the design doc** before adding more layers. Per CLAUDE.md: "do not chase N=2 noise into product claims." A single paired comparison is N=1, presented as such.
