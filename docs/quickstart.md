# Strata quickstart

A hands-on tour. Clone, build, run the agent against a real TypeScript codebase, look at what the substrate actually shows the model. Every command below works against the repo as-is.

If you want the architectural argument first, read [`../strata-design.md`](../strata-design.md). If you want the published research result, read [`RESULTS.md`](RESULTS.md). This doc is for the "what happens when I actually run it" question.

## 1. Setup

```bash
git clone <this-repo>
cd Strata
pnpm install
pnpm -r build
pnpm -r test                      # ~400 passing, 2 key-gated skipped
```

You now have the CLI built at `packages/cli/dist/cli.js`. Wherever this doc says `strata`, use `node packages/cli/dist/cli.js`.

## 2. The pipeline, end-to-end, with no agent and no key

```bash
node packages/cli/dist/cli.js roundtrip examples/phase0-sample.ts
```

Expected output:

```
Round-trip succeeded (byte-identical).
Output: examples/phase0-sample.ts.out.ts
```

What just happened: the file was parsed via the TS Compiler API into a node tree, every node was stored in an in-memory SQLite, then the store was rendered back to TypeScript through the canonical printer. The output is byte-identical to the input. The substrate did not see "a file" anywhere — files are only on the edges (parse-in, render-out). The whole interior is the node graph.

You can also batch-ingest a directory tree into a persistent SQLite store:

```bash
node packages/cli/dist/cli.js ingest-batch examples/medium /tmp/medium.db
```

The store at `/tmp/medium.db` now contains every node from `examples/medium/src/**/*.ts`. The operation log is empty (no mutations yet).

## 2.5 Poke the substrate by hand (no key)

The "persistent, queryable node graph" claim is checkable directly. The exploration commands take a corpus directory (ephemeral in-memory ingest) or a persisted `.db` (like `/tmp/medium.db` above) and chain through node IDs:

```bash
node packages/cli/dist/cli.js modules examples/medium
```

```
ID                DECLS  MODULE
a74fb961a099c24f  10     examples/medium/src/cli.ts
36b87a02617425a6  1      examples/medium/src/clock.ts
...
```

Find a declaration by name, then inspect it with the ID the previous command printed:

```bash
node packages/cli/dist/cli.js find examples/medium User
node packages/cli/dist/cli.js show examples/medium a074a656322cd0c7
node packages/cli/dist/cli.js refs examples/medium a074a656322cd0c7
```

`refs` is the part files can't do — every *resolved* reference to `User` across the corpus, including type positions and JSDoc, with same-spelling string literals correctly absent:

```
ID                KIND  MODULE                              CONTEXT
4933b7d50864cd69  type  examples/medium/src/index.ts        export type { User } from "./types/user.ts";
9e60f482f141fc19  type  examples/medium/src/users/greet.ts  import type { User } from "../types/user.ts";
636faf4f69105634  type  examples/medium/src/users/greet.ts  export function greet(user: User): string {
...
15 references across 6 modules
```

IDs are deterministic for an unchanged corpus, so the chain works across invocations without a persisted db. Add `--json` to any command to pipe into `jq`. `exports <source> <modulePath>` lists one module's top-level declarations; `search <source> "<query>"` does semantic search once a persisted db has embeddings (see the L2 section below).

## 3. Run the agent on a real corpus

Needs `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`). Costs roughly $0.04–$0.10 per run on `examples/medium` at the current `claude-sonnet-4-6` pricing.

```bash
export ANTHROPIC_API_KEY=...
node packages/cli/dist/cli.js agent examples/medium \
  "Rename the exported interface User to Account everywhere it is referenced as a type, including type-only re-exports and JSDoc. Leave unrelated string literals untouched. The full test suite must pass." \
  --db /tmp/strata-medium.db --print
```

The `--print` flag streams assistant text and tool calls. You'll see something like:

```
[1] I'll start by exploring the codebase structure.
  ✓ find_declarations 12ms
  ✓ read_node 5ms
  ✓ get_references 8ms
  ✓ begin_transaction 1ms
  ✓ rename_symbol 6ms
  ✓ validate 1843ms
  ✓ commit_transaction 4521ms
```

The agent's tools are NOT `read`, `edit`, `grep`. They're `find_declarations`, `rename_symbol`, `validate`, `commit_transaction` — the structural operations from `strata-design.md` § Tool set. No filesystem tools exist in the agent's allowed-tool list.

The trailing JSON shows the cost and result:

```json
{
  "terminalReason": "success",
  "lastCommitOk": true,
  "newOperations": 1,
  "totalOperations": 1,
  "dbPath": "/tmp/strata-medium.db",
  "cost": {
    "totalTokens": 1012,
    "cacheReadInputTokens": 50072,
    "cacheCreationInputTokens": 2622,
    "wallMs": 20871,
    "numTurns": 7,
    "toolCalls": 6,
    "costUsd": 0.0409
  }
}
```

The mutation lives in the operation log at `/tmp/strata-medium.db`. The files on disk under `examples/medium/src/` are untouched — Strata never wrote back to the corpus. To see the renamed TypeScript, you'd run the render pipeline against the store (the bench harness does this; a `strata render` CLI is on the roadmap).

## 4. What the agent actually saw on turn 1

Before the agent's first tool call, Strata injects a `## Codebase shape` section into the prompt — the "L1 module index" layer of the codebase index design. For `examples/medium`, it looks like this:

```
## Codebase shape

Codebase shape (auto-generated at session start):
src/cli.ts: interface CliEnv [exported], const HELP, function runCli [exported], function handlePut, function handleGet, function handleDelete, function handleList, function handleStats, function handleSave, function handleLoad
src/clock.ts: class ManualClock [exported]
src/events.ts: type Listener [exported], class EventBus [exported]
src/flags.ts: interface ParsedArgs [exported], class FlagParseError [exported], function parseArgs [exported], function numberOption [exported]
src/index.ts: (no top-level declarations)
src/lib/dateRange.ts: function isWithinRange [exported]
src/lib/format.ts: function formatTimestamp [exported]
src/lib/permissions.ts: const ROLES, function getRole [exported], function describeRole [exported]
src/lru.ts: class LruIndex [exported]
src/main.ts: function main, const isDirectRun
src/persistence.ts: function saveToFile [exported], function loadFromFile [exported]
src/server/audit.ts: type AuditKind [exported], interface AuditEntry [exported], function userAudit [exported]
src/server/events.ts: function logEvent [exported], function eventLine [exported]
src/store.ts: interface StoreOptions [exported], class KvStore [exported]
src/types.ts: type Millis [exported], interface PutOptions [exported], interface Entry [exported], interface StoreStats [exported], type StoreEvent [exported], interface Clock [exported], const systemClock [exported], interface SnapshotShape [exported]
src/types/user.ts: interface User [exported]
src/ui/timeline.ts: function timelineRows [exported], function firstRow [exported]
src/users/greet.ts: function param [exported]
src/users/legacy.ts: function param [exported]
src/users/list.ts: function listUsers [exported]
src/users/repo.ts: interface UserRepo [exported], function emptyRepo [exported]
src/users/serializer.ts: function serialize [exported]

tests/ (not in graph, use read_test_file):
  tests/dateRange.test.ts
  tests/format.test.ts

---

<your user prompt>
```

This is the "agent never has to fish for the codebase shape" piece of the design. The agent now knows where `User` lives (`src/types/user.ts`) without making a single discovery tool call. To run without it (e.g. for a paired comparison):

```bash
node packages/cli/dist/cli.js agent examples/medium "<prompt>" --db /tmp/strata-medium.db --reset --no-index
```

A paired N=1 dogfood on this corpus (full result in [`docs/dogfood-results/`](dogfood-results/)) found L1 cuts cost by ~37% on a T05-class debug task. See [`decisions.md`](../decisions.md) 2026-05-27 for the honest read.

## 5. Persistence — the operation log lives across sessions

Run the agent twice against the same `--db`:

```bash
node packages/cli/dist/cli.js agent examples/medium "<task A>" --db /tmp/strata-medium.db
# ... agent commits one operation ...

node packages/cli/dist/cli.js agent examples/medium "<task B>" --db /tmp/strata-medium.db
# Second session opens the SAME store. The first session's
# rename is already applied in the graph.
```

The graph state persists. The operation log is canonical history — there's no git-style commit object; every mutation is an `operations` row with the actor, the tool kind, the affected node IDs, and the agent's `reasoning` field. Run twice and you'll see `totalOperations` grow.

Add `--reset` to wipe the store and re-ingest fresh. Add `--print` to stream the transcript.

## 6. Layer 2 — semantic search (optional, needs an OpenAI key)

If you set `STRATA_EMBED_API_KEY` (OpenAI, `text-embedding-3-small`), Strata embeds every top-level declaration on first run into a `sqlite-vec` virtual table inside the same SQLite file. A new `semantic_search` tool becomes available to the agent — useful when it doesn't know the symbol name but knows what concept to look for.

```bash
export STRATA_EMBED_API_KEY=...
node packages/cli/dist/cli.js embed examples/medium --db /tmp/strata-medium.db
# Embeds ~25 declarations, costs about $0.001
```

Without the key, L2 silently disables and the agent runs with the other 16 tools (Layer 1 still works).

## 7. Layer 3 — past tasks (optional, also needs the OpenAI key)

When you commit a transaction, Strata also embeds a "commit pattern" — the triggering prompt + ops + modules + declarations — into another `sqlite-vec` table. On the next session start, if your new prompt is similar to a past one, you'll see:

```
## Past tasks like this one

- Rename the exported interface User to Account everywhere it is referenced...
  ops: RenameSymbol
  modules: src/types/user.ts
  declarations: Account
```

injected between the `## Codebase shape` section and your prompt. The agent goes in knowing where similar work touched.

Honest scope: on a small corpus with one past pattern, the isolated effect of L3 over L1-alone is small (~3% cost savings at N=1 — see `decisions.md` 2026-05-27 control-arm entry). L3's value should scale with corpus size and pattern count; that's unproven on a real-sized codebase yet.

## 8. What doesn't work yet

Honest list:

- **No `strata render` CLI.** To see the rendered TypeScript after a session, you currently need the bench harness's render pipeline. The agent's mutations are in the store, not on disk.
- **No incremental re-ingest.** Re-running against the same `--db` skips ingestion when the store has nodes, but if the on-disk corpus has changed under it, you need `--reset`. Watch-mode is not built.
- **TypeScript only.** No other languages.
- **17 structural tools.** `extract_function`, `inline_function`, `move_declaration` are on the roadmap but unstarted. The "rename-class" win is the strongest validated finding; other task classes are mixed (see [`docs/RESULTS.md`](RESULTS.md)).
- **Bench is operator-only.** `pnpm --filter @strata/bench bench:t03` runs paired live trials against `examples/medium` and is gated behind `ANTHROPIC_API_KEY`. The dogfood harnesses (`dogfood:l1`, `dogfood:l3`) are the same shape but single-paired.
- **License is unchosen.** The repo has no LICENSE file yet.

## 9. Read next

- [`../strata-design.md`](../strata-design.md) — the architectural spec.
- [`RESULTS.md`](RESULTS.md) — the published research result (T03 substrate-vs-baseline finding).
- [`product-roadmap.md`](product-roadmap.md) — current iteration scope and what "done" means.
- [`../decisions.md`](../decisions.md) — append-only log of every build-time decision and divergence, newest at top.
- [`specs/2026-05-26-three-layer-codebase-index-design.md`](specs/2026-05-26-three-layer-codebase-index-design.md) — the design behind L1/L2/L3.

## 10. Where to go from here

If you want to:

- **Replicate the headline result** — `pnpm --filter @strata/bench bench:t03 -- --trials=3` (operator-only, ~$0.30).
- **Try your own task** — `strata agent <your-corpus> "<your prompt>" --db /tmp/your.db --print`. The agent works on any TypeScript directory with a `src/` root.
- **Compare against file-tools Claude Code on the same task** — `strata baseline <your-corpus> "<your prompt>"`. Same shape, file tools.
- **Inspect the operation log** — open `/tmp/your.db` in any SQLite browser; the `operations` table is the canonical history, `nodes` is the graph state.
