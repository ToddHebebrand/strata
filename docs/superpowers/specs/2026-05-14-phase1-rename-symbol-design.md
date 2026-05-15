---
title: "Phase 1 design — rename_symbol as the verticalization hero"
date: 2026-05-14
status: draft
authors:
  - todd@olivetech.co
related:
  - ../../../strata-design.md
  - ../../../CLAUDE.md
  - ../../../decisions.md
  - ../../benchmarks.md
---

## Summary

Phase 1 of Strata is implemented as a single vertical slice through the
architecture rather than as a wide build-out of every Phase-1 tool listed in
`strata-design.md`. The hero operation is `rename_symbol`. Everything below
the tool — identifier-level lowering, a references index resolved via the
TypeScript Compiler API's `TypeChecker`, transactions, the operation log, and
validate-before-commit — is built only as far as `rename_symbol` and its
acceptance test (benchmark task T03) require. Other mutations listed under
Phase 1 in the design doc (`add_parameter`, `extract_function`,
`replace_body`, etc.) are deferred; they will follow the same spine in a
Phase 1.5 / Phase 2 pass.

## Background

**Phase 0 state.** Phase 0 proved a TypeScript file can be ingested into
SQLite-backed statement nodes and rendered back through `tsc --noEmit`
without semantic loss. The store schema is a single `nodes` table; ingest
walks `sourceFile.statements`, emits one node per top-level statement keyed
by its `SyntaxKind`, and stores `statement.getFullText(sourceFile)` as the
payload. EOF trivia rides as a sibling `EndOfFileTrivia` node (see
`decisions.md` 2026-05-14). Render concatenates children by `childIndex`.
Verify uses the in-process TypeScript Compiler API with options loaded from
`tsconfig.base.json`. The pipeline is intentionally pre-schema — no edges,
no references, no operation log, no transactions.

**Phase 1 in the design doc.** `strata-design.md` § "Phase 1: Core store and
operations" calls for the node-graph schema in SQLite, 5–7 query tools, 5–7
mutation tools, transactions with rollback, an operation log, and tests for
each operation. The mutation surface enumerated in § "Tool set" includes
`rename_symbol`, `add_parameter`, `remove_parameter`, `replace_body`,
`extract_function`, `inline_function`, `create_function`, `delete_node`,
`add_import`, and `move_declaration`.

**What this spec narrows it to.** One mutation (`rename_symbol`) and the
minimum infrastructure that operation forces into existence. The other
mutations are explicitly deferred. The narrowing is not a scope cut against
the design doc; it is a phasing choice. The design doc's Phase 1
deliverables remain the target — this spec specifies the first vertical
slice through them.

## Approach

Tools-first verticalization: pick one hero operation, build all the
supporting machinery it requires end-to-end, then let later passes broaden
horizontally along the same spine.

`rename_symbol` is the hero because:

- It is the design doc's archetypal structural operation (the canonical
  example for "agents work on the graph, not text").
- It corresponds directly to benchmark task T03 (`docs/benchmarks.md`),
  which is identified as a Strata-advantage task — template literals,
  JSDoc tags, and type-only re-exports are the realistic failure surface
  for grep-and-replace agents, and reference-aware rename is the
  substrate's clearest win.
- It forces symbol resolution and a references index — the load-bearing
  Phase 1 infrastructure — without also forcing signature mutation, free-
  variable analysis, or callsite arg reordering (which `add_parameter`,
  `extract_function`, and `inline_function` respectively require).

**Why not wide Phase 1?** Building every mutation listed in the design doc
in parallel commits architectural decisions (lowering granularity, the
reference index shape, the transaction view semantics) before any of them
have been pressure-tested by a real operation. Wide builds optimize for the
imagined operations, not the actual ones.

**Why not narrow Phase 1?** Starting with trivial operations (`add_import`,
`delete_node`) builds an operation log and transactions against ops that
don't exercise reference resolution or multi-node mutation. The lowering
that comes out the other side won't be shaped by anything load-bearing.

`rename_symbol` is in the middle: small enough to fit in Phase 1, large
enough to force every Phase 1 architectural decision against an honest
forcing function.

## Acceptance test

T03 from `docs/benchmarks.md`, reproduced programmatically.

**What we test.** Against `examples/medium/` (or its closest available
analogue if the seed isn't yet built), invoke `rename_symbol` on the
declaration node for the exported interface `User` in `src/types/user.ts`
with `new_name = "Account"`. The invocation goes through the same
internal API the agent will eventually call — `begin`,
`rename_symbol(tx, ...)`, `validate(tx)`, `commit(tx)` — but the caller is
a unit test, not the agent. The agent is Phase 3.

**Success criteria.**

1. `commit(tx)` returns `{ ok: true }`.
2. Re-rendering every touched module and running the in-process verify
   path produces zero diagnostics.
3. The audit-log string literal `"User"` in `src/server/audit.ts` is
   unchanged (substrate proof: it is not a reference and was never a
   candidate).
4. The type-only re-export in `src/index.ts` is updated.
5. JSDoc `@param {User} ...` occurrences referencing the renamed type are
   updated.
6. One row appears in the `operations` table with `kind = 'RenameSymbol'`,
   the original declaration ID and all reference IDs in
   `affected_node_ids_json`, and the transaction ID matches the committed
   transaction.

**Out of scope for the acceptance test.** Token cost, wall time, the
agent loop, retry behavior. Those are Phase 3 and Phase 4 concerns. Phase
1 ships when the unit-level invocation produces a correct, validated,
operation-logged rename.

## What rename_symbol forces us to build

Each subsection below is in scope for Phase 1 only because the rename
requires it. Anything not in this section is out of scope (see § "Out of
scope").

### 1. Identifier-level lowering

Statement nodes keep their raw-text payload from Phase 0 — that work is
not thrown away. Phase 1 adds a new node kind, `Identifier`, as a child
of statement nodes. One `Identifier` node is emitted per identifier
occurrence within the statement (both declaration sites and reference
sites). The `Identifier` payload is a JSON record:

```json
{ "text": "User", "offset": 17 }
```

where `offset` is the byte offset of the identifier within the parent
statement's raw-text payload. `text` is duplicated so queries against the
references index don't need to seek back into the parent.

This is the smallest lowering that makes `rename_symbol` addressable:
each renameable identifier is a node with a stable ID, and rendering can
splice updated text back into the parent statement at a known offset.
Expression-level lowering, JSX, and other intermediate node kinds are
not introduced in Phase 1.

### 2. Symbol resolution + references index

At ingest time, after the statement and identifier nodes are emitted for
all modules in the ingest batch, run a second pass that creates a
`ts.Program` over the ingested sources and uses
`checker.getSymbolAtLocation(identifier)` (and `getAliasedSymbol` where
needed) to resolve each identifier node to its declaration identifier
node. The resolved mapping is persisted to a new `references` table:

```
references(from_node_id, to_node_id, kind)
```

where `kind ∈ { value, type, namespace }` to distinguish (for example)
`User` in a type position from `User` as a value identifier.

The store consumes only the resolved output. It does not know about
`ts.Symbol`, `ts.TypeChecker`, or any TS Compiler API surface. If
resolution swaps to a different mechanism later (a custom resolver, a
language-server backend), the store API is unaffected.

JSDoc `@param {User}` annotations and similar comment-bound references
are resolved through the TypeChecker's existing JSDoc support; if it
turns out the TypeChecker doesn't surface those identifiers as resolvable
locations, that is a bail signal (see § "Bail signals").

### 3. Transactions wrapping multi-node mutations

A rename touches `1 + N` nodes: the declaration identifier and every
reference identifier. They must commit atomically or roll back atomically
— a partial rename leaves the codebase broken at compile time. Hence
transactions.

New `transactions` table:

```
transactions(tx_id, started_at, committed_at, status, actor)
```

with `status ∈ { open, committed, rolled_back }`. The transaction is the
unit the operation log is grouped by, the unit `validate` runs against,
and the unit `commit` either accepts or rejects atomically.

A transaction's "view" is the union of the canonical store state with any
pending mutations queued on the open transaction. Mutations are not
applied to the canonical store rows until commit; they live in an
in-memory overlay keyed by `tx_id`. Read queries inside a transaction see
the overlay; reads outside the transaction see canonical state.

### 4. Operation log

New `operations` table:

```
operations(op_id, tx_id, kind, params_json, affected_node_ids_json,
           actor, ts, reasoning)
```

One row per logical operation. A `rename_symbol` call appends a single
`RenameSymbol` entry with `params_json = { declaration_id, old_name,
new_name }` and `affected_node_ids_json = [declaration_id, ...reference_ids]`.

The operation log is canonical history (`CLAUDE.md` invariant). There is
no separate diff representation, no git-style commit object. Replaying
the operation log against an empty store reproduces the current state
(this property is not implemented in Phase 1 but is preserved as an
invariant — log entries carry enough information to make replay
possible).

### 5. Validate-before-commit

`validate(tx)` materializes the transaction's view of every module that
contains at least one node mutated by the transaction, runs them through
the existing render pipeline, hands the rendered files to the in-process
TypeScript Compiler API (`ts.createProgram` + `getPreEmitDiagnostics`,
same path Phase 0 wired), and maps any diagnostics back to node IDs via
the render source map. Returns a structured `Diagnostic[]`.

`commit(tx)` calls `validate(tx)` first. If diagnostics are non-empty,
`commit` returns `{ ok: false, diagnostics }` and the transaction
remains `open` (the caller can mutate further or roll back). If
diagnostics are empty, the overlay is flushed to canonical state, the
operation log is appended, the transaction is marked `committed`, and
`commit` returns `{ ok: true }`.

The single-file source map produced in Phase 0 needs to be extended to
multi-file. The straightforward extension is one source map per rendered
module, keyed by module ID; the validate path looks up the module ID
from the diagnostic's file path. This is the one place Phase 0's
single-module assumption breaks and needs reworking.

## Schema

All additions are over the Phase 0 schema (`nodes` table only). Sketches
below show shape; final column ordering, defaults, and indexes are an
implementation detail.

### `nodes` (existing, extended)

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  parent_id   TEXT,
  child_index INTEGER,
  payload     TEXT
);
```

Phase 1 introduces a new `kind` value: `Identifier`. `Identifier` rows
have a statement node as their `parent_id`. The `payload` is a JSON-encoded
`{ text: string, offset: number }`. Statement nodes keep their existing
raw-text payload unchanged.

No schema migration is strictly required for the table itself — the new
node kind is data, not structure. An index on `(parent_id, kind)` is added
to speed up "find all identifiers under this statement" queries that
render uses.

### `references` (new)

```sql
-- `references` is reserved in SQL; the table is named `node_references`.
CREATE TABLE IF NOT EXISTS node_references (
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- 'value' | 'type' | 'namespace'
  PRIMARY KEY (from_node_id),
  FOREIGN KEY (from_node_id) REFERENCES nodes(id),
  FOREIGN KEY (to_node_id)   REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS node_references_to_idx ON node_references(to_node_id);
```

The `(from_node_id)` PK reflects that each identifier resolves to exactly
one declaration. (A single identifier representing both a value and a
type — TypeScript's rare "merge" cases — is a known limitation; if it
hits the hero test, it's a bail signal.)

The `node_references_to_idx` index is what `get_references(declaration_id)`
reads from. It must be fast — `rename_symbol`'s first action is to walk
this index.

### `transactions` (new)

```sql
CREATE TABLE IF NOT EXISTS transactions (
  tx_id        TEXT PRIMARY KEY,
  started_at   INTEGER NOT NULL,           -- epoch ms
  committed_at INTEGER,                    -- epoch ms; null while open
  status       TEXT NOT NULL,              -- 'open' | 'committed' | 'rolled_back'
  actor        TEXT NOT NULL
);
```

Only `committed` transactions need to survive process restarts strictly.
`open` transactions in a crashed process are effectively rolled back
(their overlay was in memory). The row is still persisted at `begin()`
time so post-mortem inspection works.

### `operations` (new)

```sql
CREATE TABLE IF NOT EXISTS operations (
  op_id                   TEXT PRIMARY KEY,
  tx_id                   TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  params_json             TEXT NOT NULL,
  affected_node_ids_json  TEXT NOT NULL,
  actor                   TEXT NOT NULL,
  ts                      INTEGER NOT NULL,    -- epoch ms
  reasoning               TEXT,                 -- optional, agent-supplied
  FOREIGN KEY (tx_id) REFERENCES transactions(tx_id)
);
CREATE INDEX IF NOT EXISTS operations_tx_idx ON operations(tx_id);
```

Append-only by convention. There is no `UPDATE` path for `operations` in
the Phase 1 API.

### Render adjustment

Render still concatenates children by `childIndex`, but for statement
nodes that have `Identifier` children with mutations queued on the open
transaction, the renderer must splice the new identifier text into the
parent statement's raw payload at the stored byte offsets.

The splicing must be applied in descending offset order so earlier
splices don't invalidate later offsets. If two identifiers within the
same statement are both mutated, both splices happen against the same
original payload. The render output for that statement is a new string;
the original payload on the canonical statement node is unchanged until
commit, at which point the canonical statement payload is overwritten
with the spliced text (and the identifier offsets within it are
recomputed).

This splicing is the one piece of real engineering in Phase 1's render
layer. It is small but worth getting right.

## API surface

All functions below are internal — the agent does not see them in Phase
1. The agent layer (Phase 3) will wrap a subset as tool definitions. The
intent is that the agent's tool surface is a thin adapter, not a
divergent API.

### `begin(actor: string): TxHandle`

Open a new transaction. Persists a row in `transactions` with
`status = 'open'`. Returns an opaque handle that downstream calls treat
as the transaction key.

**Edge cases.** `actor` is required (no anonymous transactions). The
handle is opaque to callers — they must not construct one by hand. Open
transactions across process restart are not supported (the in-memory
overlay is lost, and the row is left dangling at `status = 'open'`; a
startup cleanup pass should mark such rows `rolled_back` with a synthetic
`committed_at`).

### `commit(tx: TxHandle): { ok: true } | { ok: false, diagnostics: Diagnostic[] }`

Call `validate(tx)`; if diagnostics are non-empty, return `{ ok: false,
diagnostics }` without changing transaction status. If diagnostics are
empty, flush the overlay to canonical state, append the operation-log
entries, mark the transaction `committed`, and return `{ ok: true }`.

**Edge cases.** Committing an already-committed or rolled-back
transaction throws. Committing a transaction with no operations is a
no-op (still validates current state, still marks `committed`, but
appends no `operations` rows — explicitly not an empty-commit error).

### `rollback(tx: TxHandle): void`

Discard the transaction's overlay. Mark the row `rolled_back`. No
operation-log entries are written.

**Edge cases.** Rolling back an already-terminated transaction throws.

### `find_declarations({ name?: string, kind?: DeclarationKind }): DeclarationNode[]`

Read-only query against canonical state. Returns declaration nodes
matching the supplied criteria. For Phase 1, `DeclarationKind` is the
minimal set the hero needs: `'interface' | 'type-alias' | 'class' |
'function' | 'variable'`. `name` is an exact match against the
declaration identifier text.

**Edge cases.** Empty result is `[]`, not `null`. Matching is
case-sensitive. The query does not see overlays — declarations
introduced in an open transaction are not visible. (This is a deliberate
limit: Phase 1's hero never queries for things it just created. If a
later operation needs to, that's the moment to widen the API.)

### `get_references(declaration_id: NodeId): Reference[]`

Read-only query against the `references` table for the inverse direction
of the resolved index. Returns the set of identifier nodes whose
`to_node_id` is the supplied declaration. Each `Reference` includes the
`from_node_id`, the resolution `kind`, and the parent statement ID for
convenience.

**Edge cases.** A declaration with no references returns `[]`. The query
does not see overlays. References stay coherent across `rename_symbol` —
rename only mutates identifier *text*, not node identity or parent/child
structure, so the `(from_node_id, to_node_id)` rows remain accurate
post-commit. The "references not re-resolved on mutation" limitation only
matters for *structural* operations (`add_parameter`, `move_declaration`,
etc.) which are Phase 1.5+; those phases will need to extend ingest's
resolver into commit-time to keep `node_references` in sync.

### `rename_symbol(tx: TxHandle, declaration_id: NodeId, new_name: string): void`

The hero. Requires an open transaction. Implementation:

1. Look up the declaration node by ID. If it is not a declaration kind,
   throw.
2. Validate `new_name` against TypeScript identifier syntax. If invalid,
   throw.
3. Look up the existing identifier text via the declaration's identifier
   child node.
4. Read `get_references(declaration_id)`; collect the set of identifier
   nodes to mutate (the declaration's own identifier + all references).
5. Queue identifier-text mutations on the transaction's overlay (one per
   node — payload's `text` field updated, `offset` unchanged).
6. Append an in-memory pending `operations` entry of `kind =
   'RenameSymbol'` to the transaction.

The function returns `void`. It does not validate, does not render, does
not commit. Validation and commit are caller-controlled.

**Edge cases.** Renaming to the same name is a no-op (queues nothing,
appends no operation entry). Renaming to a name that already exists in
scope is *not* checked at the API layer — it will surface as a `tsc`
diagnostic at `validate(tx)` time. That is the design: the substrate
trusts the compiler as the arbiter of correctness, not its own
half-reimplementation of TS scoping rules.

### `validate(tx: TxHandle): Diagnostic[]`

Render every ingested module under the transaction's overlay, build a
single `ts.Program` over the rendered files using `tsconfig.base.json`
options, collect `getPreEmitDiagnostics`, and map each diagnostic's
`file + start` back to a node ID via the module's render source map.
Return the mapped diagnostics.

**Phase 1 scope rule.** Always include the *full set* of ingested modules
in the Program, not just the modules the transaction touched or their
importers. The `examples/medium/` corpus is small enough that whole-
program validation is comfortably under any tolerable budget, and this
rule trivially catches broken re-exports without an importer-closure
analysis. If whole-program validate becomes too slow at realistic scale,
that is bail signal #3 firing — narrowing the scope is a workaround, not
a fix.

**Edge cases.** A transaction with no mutations validates the canonical
state and returns `[]`. A diagnostic that can't be mapped back to a node
(e.g., a whole-program error like "no inputs found") is returned with a
null `node_id` and the message preserved verbatim.

## Out of scope

Explicit deferrals. The design doc lists each of these under Phase 1
(`strata-design.md` § "Tool set"); they are pushed to Phase 1.5 or later
because they are not required by `rename_symbol`.

- `add_parameter`, `remove_parameter`, `replace_body`, `extract_function`,
  `inline_function`, `move_declaration`, `add_import`, `delete_node`,
  `create_function` — each follows the same spine (transactional,
  operation-logged, validate-before-commit) but introduces its own
  mechanics (signature mutation, callsite arg reordering, free-variable
  analysis, body replacement). Deferred until `rename_symbol` is shipped.
- `find_nodes` with general predicates. Only `find_declarations` is
  needed for the hero; the general predicate surface is deferred until a
  later operation forces it.
- `get_callsites`, `trace_path`, `get_type_info`,
  `list_module_exports`. None are needed for rename.
- Comments-as-nodes. Comments stay as trivia attached to statements per
  Phase 0. JSDoc identifier references *are* in scope (because they are
  references), but the comment text around them is not structured.
- Type-level operations on generics, conditional types, mapped types.
  Identifiers within these positions are still resolvable through the
  TypeChecker; the surrounding type machinery is opaque text.
- The agent (Phase 3). Phase 1 ships an internal API only.
- Anything multi-language.
- `run_tests`. Phase 1 ships `validate`; running rendered tests is
  Phase 2/4 territory.

## Bail signals

Exit criteria for "stop and surface, don't work around". The point of
the prototype is to learn. Surfacing a wall is more valuable than
plastering over it.

### 1. TypeChecker resolution gaps that hit the hero test

If `getSymbolAtLocation` (or its JSDoc/alias variants) fails to resolve
a meaningful fraction of references in `examples/medium/` — type-only
re-exports through type aliases, namespace imports, conditional types
referencing the renamed symbol, JSDoc `@param` tags — and the workaround
is anything more elaborate than calling a different TypeChecker method,
that is a bail signal. The TypeChecker is the most mature TS resolver
in existence. If it can't resolve T03's references, no reasonable
substitute will, and the substrate hypothesis is in trouble for TS.

### 2. better-sqlite3 throughput cliff at realistic size

If ingesting a single 2k-LOC module takes >1 second, or if a single
mutation transaction with ~50 affected nodes takes >100ms end-to-end
(including validate), the agent loop in Phase 3 will be unusable. The
agent fires many small reads and mutations per task; sub-100ms feel per
operation is necessary. If the cliff is in SQLite specifically (not in
TypeChecker or render), it's a strong signal to revisit storage before
building more on top of it.

### 3. TS Compiler API hits a memory or correctness wall

The Phase 1 validate path creates a new `ts.Program` per call. The
expectation is that the agent will validate constantly. If creating
Programs on demand becomes prohibitive (cold-start cost, memory growth
from leaked SourceFile objects, incorrect cross-program type sharing),
and the TS Compiler API can't cleanly support a long-lived,
incrementally-updated Program for this use case, Phase 3 will pay that
cost on every cycle. The decision then is whether to invest in a
custom long-lived program manager (significant work) or accept the cost
(degraded agent latency).

### 4. `@anthropic-ai/claude-agent-sdk` tool surface mismatch

The agent comes in Phase 3, but Phase 1 should register at least one
smoke-test tool (a no-op `find_declarations` wrapper) against the SDK
to confirm the schema and description shapes the tools need are
expressible. If tool descriptions don't fit in the agent's worldview
budget, or schemas can't represent the inputs we want (`TxHandle`,
`NodeId`, `Diagnostic[]` as return shape), surface that now rather than
discover it three weeks into Phase 3.

## Open questions

These are deliberately left open. They should be answered by what we
observe building, not pre-resolved on paper.

### 1. How accurate does symbol resolution actually need to be?

The cheapest resolver story is "module graph + lexical scope" — walk
imports, walk lexical scopes, resolve identifiers against the resulting
binding tables. The full-fat story is "TypeChecker everywhere", which
catches `as Foo` cast positions, template literal types, conditional
type parameters, mapped-type key references, declaration merging, and
the long tail of TS resolution edge cases.

T03's seed deliberately stresses some of these positions (JSDoc, type-
only re-exports, type generics). If `getSymbolAtLocation` handles them
all, we are using the right tool. If we find ourselves writing custom
resolution logic on top of it, the question becomes "would module-graph-
plus-scopes have been enough?" — and the cost/benefit of pulling the
full TypeChecker into the ingest path is suddenly real.

Answer this by building Phase 1 with the TypeChecker, then *after*
the hero test passes, inventorying which resolution calls were
actually load-bearing versus which were over-spec.

### 2. Node identity stability across re-ingest

Currently, ingest mints fresh UUIDs every time. Re-ingesting the same
file produces a different node graph with the same shape. Per
`CLAUDE.md`, "Stable node IDs across mutations" is a load-bearing
invariant — but it is also a load-bearing invariant *across re-ingest*,
because the operation log records node IDs and stale operation entries
should still resolve to the same logical nodes after a re-ingest.

A content-or-position-based stable ID scheme is required. Two candidate
shapes:

- **Path + structural-position hash.** ID = hash(modulePath +
  childIndex-path-from-root + nodeKind). Stable across re-parse of an
  unchanged file. Breaks the moment a statement is inserted earlier in
  the file (every later sibling gets a new ID).
- **Content-anchored.** ID = hash(modulePath + canonical-identifier-of-
  nearest-named-ancestor + relativePositionWithin). Stable across
  reordering siblings that don't change naming. More complex.

Phase 1 should propose one scheme and validate it during implementation
against this test: ingest `examples/medium/`, run `rename_symbol`,
re-ingest the resulting source files, confirm the operation-log entries
still resolve to the renamed declaration's new ID via the documented
remapping rule. If they don't, the scheme is wrong; iterate.

This is fundamental, not optional, and not deferred. It does not show
up explicitly in the hero acceptance test because the test runs in a
single process, but the moment Phase 3 has a session-resumable agent,
stable IDs across re-ingest become a hard requirement.

## Suggested build order

A suggestion, not a prescription. Implementers may resequence if a
different order surfaces problems earlier.

1. **Schema migrations.** Add `references`, `transactions`,
   `operations` tables. Add `Identifier`-kind data path through the
   existing `nodes` table. Add indexes.
2. **Ingest extension.** Walk one AST level deeper. Emit `Identifier`
   child nodes for every name occurrence (declaration sites + reference
   sites) under each statement. Store offsets relative to the parent
   statement's raw payload.
3. **Symbol resolution at ingest time.** After identifier nodes are
   emitted across the ingest batch, create a `ts.Program`, ask the
   `TypeChecker` to resolve each identifier, persist the resolved
   `(from, to, kind)` triples into the `references` table.
4. **Render extension.** Teach render to splice updated identifier text
   into a parent statement's raw payload by offset (descending order;
   single statement, multiple identifiers). Multi-module render +
   source map per module.
5. **Transactions + operation log.** Implement `begin`, `rollback`,
   commit-without-mutation, the in-memory overlay, the operation-log
   append. Get the transaction state machine right before adding the
   hero.
6. **Validate.** Wire `validate(tx)` against the multi-module render
   and the in-process verify path. Get diagnostics mapping back to node
   IDs via per-module source maps. `commit` blocks on non-empty
   diagnostics.
7. **`rename_symbol`.** The hero, against the now-complete spine.
   Implementation should be a few dozen lines once 1–6 are real.
8. **Hero test.** Programmatically reproduce T03 against
   `examples/medium/`. Confirm all six acceptance criteria in §
   "Acceptance test".

Each step should be independently testable. The Phase 0 pattern of one
package per concern holds — `store` for schema and transactions,
`ingest` for AST walking and resolution, `render` for splicing, `verify`
(or the validate path inside `store`) for compiler integration.

## Glossary

- **Node.** A row in the `nodes` table. Has a stable ID, a kind, an
  optional parent, an optional `childIndex`, and a typed payload.
  Statement nodes and `Identifier` nodes are the two kinds Phase 1
  introduces beyond Phase 0.
- **Declaration.** A node that names something (interface, type alias,
  class, function, variable). The declaration's own identifier is a
  child `Identifier` node. References resolve to the declaration node,
  not to its identifier child — though for `rename_symbol`'s purposes
  both are addressable.
- **Reference.** A row in the `references` table. Records that a given
  identifier node resolves to a given declaration node, with a
  resolution kind (value/type/namespace).
- **Transaction.** A row in the `transactions` table plus an in-memory
  overlay of pending mutations. The atomicity boundary for multi-node
  operations. Identified by an opaque `TxHandle`.
- **Operation.** A row in the `operations` table. The canonical
  history record of a logical mutation. One `rename_symbol` call
  produces one operation row, regardless of how many identifier nodes
  it touches.
