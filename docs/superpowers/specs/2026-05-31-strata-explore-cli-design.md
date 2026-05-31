# Strata exploration CLI — design

**Status:** approved 2026-05-31
**Iteration:** 3 (make the substrate usable by someone other than us) — first sub-project.
**Scope:** a read-only, human-facing CLI surface for exploring a Strata store. No mutation, no REPL, no packaging changes.

## Problem

Strata's pitch is "a persistent, queryable node graph." Today the CLI is a research/bench harness (`agent`, `baseline`, `t03`, `roundtrip`, `ingest-batch`, `rename`, `embed`, `sdk-smoke`). A newcomer can *run the agent*, but has no way to **explore or inspect the substrate directly** — there is no `query`, `show`, `exports`, or `refs` command. The "queryable graph" claim is real for the agent and unproven for a person. The store already exposes the query primitives (`listModules`, `find_declarations`, `list_module_exports`, `read_node`, `get_references`, `semantic_search`); this project gives a human ergonomic CLI access to them.

This is the first Iteration-3 sub-project. It deliberately does NOT cover mutation-by-hand (the agent's job), packaging/global-binary work, or a recorded demo — those are separate, lower-ranked gaps.

## Goals

- A person can point a single command at a corpus directory or a persisted `.db` and explore the node graph: list modules, see a module's exports, find declarations by name/kind, inspect a node's text + structure, list every reference to a declaration, and semantic-search.
- The reference graph (`refs`) — the capability files cannot offer — is the most polished output.
- Every listing surfaces node IDs copy-pasteably, because IDs are the join key between discovery commands (`modules`/`exports`/`find`) and inspection commands (`show`/`refs`).
- Machine-composable: every command supports `--json`.
- Zero new store logic. New code is argument parsing, the `openOrIngest` helper, and formatting.

## Non-goals (YAGNI)

- No mutation commands (rename/move/inline/extract by hand). Read-only only.
- No interactive REPL, pagination, or watch mode.
- No packaging / global-binary / npm-publish work (separate gap).
- No recorded demo (separate gap).
- No new query capabilities in `@strata/store`.

## Approach (A — auto-detecting positional source + flat subcommands)

A single positional `<source>` is auto-detected:
- a **directory** → `ingestBatch` the `*.ts` tree into `openDb(":memory:")` (ephemeral, zero setup);
- a **file** (`.db` or otherwise) → `openDb(source)` (persisted, stable IDs across calls).

Six flat subcommands, each mapping 1:1 onto a store query primitive:

```
strata modules <source>                      # listModules → module path + top-level decl count   (alias: ls)
strata exports <source> <modulePath>         # list_module_exports(moduleId)
strata find    <source> <name> [--kind k]    # find_declarations({name, kind})
strata show    <source> <nodeId>             # read_node(id, {includeChildren:true})
strata refs    <source> <nodeId>             # get_references(declarationId)
strata search  <source> "<query>" [-k N]     # semantic_search(query, k)
```

- `<modulePath>` for `exports` is matched against module payloads by suffix (e.g. `store.ts` or `server/events.ts`), so a person needn't type the absolute ingest path. Ambiguous suffix → list the candidates and exit non-zero.
- `--kind` accepts the `DeclarationKind` values (`interface`, `type-alias`, `class`, `function`, `variable`).
- `-k N` for `search` defaults to 8.
- `--json` on every command emits the raw store rows/hits (IDs included) for piping to `jq`.
- Human-readable default output is a compact table.

### The ID chain (key ergonomic property)

A human cannot guess a node ID (`<modulePath>::[childIndexPath]::Kind`). The workflow is a **chain**: a discovery command (`modules`/`exports`/`find`) prints IDs; the person copies one into an inspection command (`show`/`refs`). Therefore every listing command surfaces the ID prominently (first column / dedicated field), and `--json` always includes it.

Because node IDs are derived from `(modulePath, childIndexPath, kind)`, the chain works **even in ephemeral mode**: a `find` against a corpus directory yields an ID that a subsequent `show` against the same unchanged directory re-resolves (re-ingest is deterministic). This is stated in `--help` and the README so newcomers trust cross-invocation IDs without a persisted DB.

## Components

- **`openOrIngest(source): { db, ephemeral }`** (new, `packages/cli/src/commands/explore/openOrIngest.ts`). `statSync(source)`: directory → walk `*.ts`, `ingestBatch`, `insertNodes` + `insertReferences` into `openDb(":memory:")`; file → `openDb(source)`. Throws a clear error if the path doesn't exist. Shared by all six commands. The walk mirrors the existing `ingest-batch` / dogfood tree-walkers (skip `node_modules`/`.git`/`dist`).
- **Six command modules** (`packages/cli/src/commands/explore/{modules,exports,find,show,refs,search}.ts`). Each: parse args → `openOrIngest` → call the store query → format → return exit code. No store logic.
- **Formatting helpers** (`packages/cli/src/commands/explore/format.ts`): `printTable(rows, columns)`; `nodeSummary(db, row)` → `{ id, kind, name, module }` (name via `resolveDeclarationNameIdentifier`, module via `modulePathOf`). `show` prints the node's payload text (its rendered source) plus a one-line children summary; for a `FunctionDeclaration` it also lists the indexed body statements `read_node` already returns.
- **Dispatch + help** (`packages/cli/src/cli.ts`): extend the existing `argv` string-compare block with the six commands; add a grouped `help` / no-arg listing that separates **exploration** commands from **research/harness** commands; update the master usage string.

## Data flow

`argv → dispatch → command module → openOrIngest(source) → store query(db, …) → format(rows | --json) → stdout → exit code`. Ephemeral DBs are closed at the end of the command; persisted DBs are opened read-only-in-spirit (no writes occur).

## Error handling

- Missing/!exists `<source>` → stderr message + exit 1.
- `exports` suffix matches 0 modules → "no module matching `<suffix>`" + exit 1; matches >1 → list candidates + exit 1 (disambiguation).
- `show`/`refs` with an unknown ID → "no node with id `<id>`; run `strata find`/`modules` to list IDs" + exit 1.
- `search` when embeddings/`sqlite-vec` unavailable → actionable message: "semantic search needs embeddings; set `STRATA_EMBED_API_KEY` and run `strata embed <source> --db <path>`" + exit 1 (NOT a crash). Detected via the store's `isVecAvailable` + an empty-index check.
- All "expected" failures are exit 1 with a one-line reason; unexpected throws bubble as exit 1 with the stack (matches existing CLI behavior).

## Testing

`packages/cli/tests/explore.test.ts` (no key required):
- Ingest `examples/medium` (corpus-root mode) and assert: `modules` lists the known module count and includes `lib/format`; `exports lib/format` includes `formatTimestamp`; `find User` returns ≥1 hit whose `id` resolves; `show <that id>` output contains the declaration's text; `refs` on a multi-referenced symbol (e.g. `User`) returns the expected referrer count across modules; `search` without embeddings hits the graceful no-embeddings path (exit 1, actionable message — asserted, not a throw).
- Persisted-`.db` round-trip: `ingest-batch examples/medium <tmp.db>`, then run `modules`/`find`/`show` against `<tmp.db>` and assert the same IDs resolve (proves both input modes + cross-invocation ID stability).
- `--json` shape: assert `find --json` emits an array of rows each carrying `id` + `kind`.

## Docs

- README: add an "Explore the graph" section with the six commands; bump the stale tool count (17 → 20) and command list.
- `docs/quickstart.md`: add a short "poke the substrate" walkthrough (`modules` → `find` → `show` → `refs`) on `examples/medium`.

## Build sequence (for the plan)

1. `openOrIngest` + a test.
2. `format` helpers.
3. `modules` (+ `ls` alias), `exports`, `find` — the discovery commands (IDs out).
4. `show`, `refs` — the inspection commands (IDs in).
5. `search` (+ graceful degrade).
6. Dispatch wiring + grouped `help`.
7. `explore.test.ts` end-to-end.
8. README + quickstart updates.
