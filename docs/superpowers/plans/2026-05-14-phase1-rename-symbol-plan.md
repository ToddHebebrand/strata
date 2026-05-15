# Phase 1 — `rename_symbol` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 1 of Strata as a single vertical slice: a `rename_symbol` operation that goes through identifier-level lowering, a TypeChecker-resolved references index, transactions, an operation log, and validate-before-commit — proven by reproducing benchmark task T03 programmatically against `examples/medium/`.

**Architecture:** Extend the Phase 0 four-package layout (`store`, `ingest`, `render`, `cli`) plus one new package `verify` (see Plan amendment A — `validate` is its own package, not part of `store`). `store` gains schema (Identifier child node kind, `node_references`, `transactions`, `operations` tables), an in-memory transaction overlay, and the query/mutation API; `verify` owns the `validate` path that calls into `render` + the in-process TS Compiler API and the validating `commit`. `ingest` walks one AST level deeper to emit `Identifier` children with byte offsets relative to the parent statement's raw payload, then performs a second-pass `TypeChecker` resolution across the ingest batch to populate `node_references`. `render` learns to splice identifier-text mutations into a statement's raw payload by descending offset and emits a per-module source map mapping rendered positions back to node IDs. `cli` gains a `rename` smoke command and the T03 acceptance script. The agent layer (Phase 3) is out of scope; a tiny `@anthropic-ai/claude-agent-sdk` schema smoke test exists only to fire bail signal #4 early if the tool surface doesn't fit.

**Tech Stack:** TypeScript 5.8, Node 22, pnpm workspaces, `better-sqlite3` 12, in-process `typescript` 5.8 Compiler API for parsing/printing/checking/diagnostics, `vitest` 3 for tests, `@anthropic-ai/claude-agent-sdk` (smoke only).

---

## Plan amendments (authoritative — override any conflicting task detail below)

Two amendments were made after the plan was drafted. **Where any task, file-structure line, or code snippet below conflicts with these, the amendment wins.** Implementers must adapt import paths, `package.json` deps, and barrel exports accordingly using judgment — the intent here is unambiguous even where a downstream snippet still shows the old shape.

### Amendment A — `validate` lives in a new `packages/verify`, not in `packages/store`

The design doc's package list is `store / ingest / render / verify / agent / bench`. Phase 1 honors that: `validate` is a verification concern and gets its own package. Concretely:

- **New package `@strata/verify`** at `packages/verify/` (own `package.json`, `tsconfig.json` extending `tsconfig.base.json`, `src/`, `tests/`). The pnpm `packages/*` glob already includes it; no workspace-config change needed beyond creating the directory and its `package.json`.
- `@strata/verify` **depends on** `@strata/store` and `@strata/render`. `@strata/store` **does not** depend on `@strata/render` and stays a leaf w.r.t. render. This removes the `store → render` edge the plan's Task 9 introduced.
- The plan's `packages/store/src/validate.ts` (Task 9) is instead `packages/verify/src/validate.ts`, exporting `validate(db, tx)`.
- **Commit boundary:** `@strata/store` keeps `commitWithoutValidate` (Task 6) and exposes it. The *validating* `commit(db, tx)` — the one that runs `validate` then finalizes — lives in `@strata/verify` (it calls `store`'s `commitWithoutValidate` after `validate` returns no diagnostics). This keeps the dependency direction acyclic: `verify → store`, `verify → render`. `rename.ts` (Task 10, still in `store`) mutates overlay only and does not import `verify`. The T03 script (Task 11, in `cli`) imports `validate` and the validating `commit` from `@strata/verify`.
- The `cli` package gains `@strata/verify` as a dependency for the `t03` and `rename` commands.

### Amendment B — decisions are logged per-task, when made, not batched at Task 14

`decisions.md` is append-only, newest-first, and exists to capture choices *and the failures that shaped them* at the moment they happen. Batching at the end risks omitting superseded choices. Therefore:

- Each task that finalizes one of the five "Self-contained decisions" appends its `decisions.md` entry **in that task's own commit**. Mapping: decision 1 (stable IDs) → Task 1; decision 5 (identifier emission boundary) → Task 3; decision 4 (JSDoc handling) → Task 4; decision 2 (overlay shape) → Task 6; decision 3 (render source-map shape) → Task 9 (in `verify`).
- If implementation forces a decision to change, log the divergence **in the task where it changed** (append a new newest-first entry; do not edit the old one).
- Bail-signal timing observations are logged in the task that surfaces them, not deferred.
- **Task 14 is reduced** to: final `CLAUDE.md` command/section updates, and any genuinely cross-cutting decision that only crystallizes once the whole slice is green. It no longer batches the five.

---

## Source-of-truth pointers

- Spec: `/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-05-14-phase1-rename-symbol-design.md` (authoritative for what to build).
- Invariants: `/Users/toddhebebrand/Strata/CLAUDE.md` (stable node IDs across mutations; files are not first-class outside render/verify; operation log is canonical; transactions wrap related mutations; render is canonical and lossy).
- Phase 0 decisions: `/Users/toddhebebrand/Strata/decisions.md` (TypeScript Compiler API for parse/print/verify; EOF trivia as a sibling node; in-process verify reading `tsconfig.base.json`).
- T03 fixture description: `/Users/toddhebebrand/Strata/docs/benchmarks.md` § T03.

## Bail-signal map (from spec § "Bail signals")

Each major step below cross-references which bail signal it can surface. Stop and surface if any of these fire — do not work around.

- **BS1 — TypeChecker resolution gaps.** Surface in Task 4 (symbol resolution) and Task 11 (hero against T03 corpus). If `getSymbolAtLocation` + JSDoc + alias variants can't resolve the T03 references and the workaround is more than a different TypeChecker method, stop and log a decision.
- **BS2 — better-sqlite3 throughput cliff.** Surface in Task 2 (Identifier-row insertion at scale), Task 7 (overlay-merged reads), and Task 11 (end-to-end timing). Hard thresholds: ingesting any single 2k-LOC module >1s; one transaction with ~50 affected nodes >100ms end-to-end including validate.
- **BS3 — TS Compiler API memory/correctness wall.** Surface in Task 4 (Program creation across the ingest batch) and Task 9 (validate creates a Program per call). If repeated `ts.createProgram` calls leak SourceFiles or take >500ms cold-start at `examples/medium/` size, stop and log a decision.
- **BS4 — `@anthropic-ai/claude-agent-sdk` schema mismatch.** Surface in Task 12 (a tiny smoke harness registering a no-op `find_declarations` wrapper). If schemas can't represent `TxHandle`/`NodeId`/`Diagnostic[]`, log a decision before Phase 3 starts.

## Self-contained decisions this plan locks in

These are durable choices not pinned by the spec. Each one ships with a planned `decisions.md` entry (Task 14). If implementation reveals a better answer, log the divergence rather than silently changing.

1. **Stable node ID scheme.** Path + structural-position hash (spec § "Open questions" candidate A). ID = sha1(`modulePath` + ":" + dot-joined childIndex path from root + ":" + nodeKind), truncated to 16 hex. Known limitation: inserting a statement earlier in a file rewrites all later sibling IDs; this is acceptable for Phase 1 because the operation log only needs stability across mutations within a single ingest session and re-ingest of unchanged files. The alternative (content-anchored) is more work and Phase 1's hero does not require it.
2. **Overlay shape.** A `TxOverlay` is `Map<nodeId, NodeRow>` of replacement rows plus a `pendingOps: PendingOp[]` array, both held only in JS memory keyed by `tx_id`. Reads inside the transaction overlay `Map.get` over canonical rows. Open transactions across process restart are not supported (spec § "API surface" allows this). A startup cleanup pass marks any `status='open'` rows from previous processes as `rolled_back` with a synthetic `committed_at`.
3. **Per-module render source map shape.** `Array<{ renderedStart: number; renderedEnd: number; nodeId: string }>` sorted ascending by `renderedStart`. Validate maps a diagnostic by file path → module ID → binary-search `renderedStart` for the diagnostic's `start`.
4. **JSDoc identifier handling.** Rely on the TypeChecker's existing JSDoc support (`ts.getJSDocTags` traversal + `getSymbolAtLocation` on JSDoc identifier nodes). If a JSDoc identifier in T03's fixture isn't surfaced by the TypeChecker, that's BS1 firing.
5. **Identifier emission boundary.** A statement's `Identifier` children include every `ts.Identifier` AST node under the statement (declaration name, type references, expression references, JSDoc tag names that the TypeChecker treats as identifiers). Identifiers inside string literals, template literal text, and comment text (other than JSDoc) are *not* identifier nodes. Phase 1 does not introduce property-access lowering — identifiers used as the right-hand side of `.` are not renamed, matching TypeScript's own rename semantics for non-property symbols.

These decisions get written into `decisions.md` in Task 14 only if they survive implementation. If any of them is forced to change during implementation, log the change instead.

## File structure

Files created or modified in this plan, with one-line responsibilities. Group is by package; sequencing is by task number.

**`packages/store/src/` (most files new):**
- `index.ts` — modified to re-export the public surface listed below.
- `schema.ts` — `openDb(path)` plus `CREATE TABLE` statements for `nodes`, `node_references`, `transactions`, `operations` and required indexes. One responsibility: schema. (Splits the previous monolithic `index.ts`.)
- `nodes.ts` — `NodeRow`, `insertNodes`, `loadModule`, `listModules`, `findNodeById`, `listChildren`. Pure canonical-state reads/writes against the `nodes` table. (Moved from current `index.ts`.)
- `references.ts` — `Reference`, `ReferenceKind`, `insertReferences`, `getReferencesByTo`, `getReferenceFrom`. Pure canonical-state reads/writes against `node_references`.
- `ids.ts` — `nodeId(modulePath, childIndexPath, kind)` deterministic ID computation. The one source of truth for stable IDs.
- `transactions.ts` — `TxHandle`, `begin`, `rollback`, `commit`, `getOverlay`, `startupRecoverOpenTransactions`. The transaction state machine and the in-memory overlay map.
- `operations.ts` — `PendingOp`, `OperationRow`, `appendOperations`. Append-only operations table writes.
- `queries.ts` — `find_declarations`, `get_references`. The read-side API that downstream tasks (rename, agent) consume. Snake-case names match the spec's API surface; TypeScript-side function names are camelCase aliases (`findDeclarations`, `getReferences`) with the snake-case exports re-exported under their spec names.
- `rename.ts` — `renameSymbol(db, tx, declarationId, newName)`. The hero. Mutates overlay only.
- `validate.ts` — `validate(db, tx)`. Whole-program render + `ts.createProgram` + diagnostic mapping.

**`packages/ingest/src/` (one file split, one new):**
- `index.ts` — keeps `ingest(sourceText, modulePath)` (now returns identifier children too) and re-exports the new batch entry point.
- `identifiers.ts` — walks a `ts.SourceFile` and emits `Identifier` child rows with `{ text, offset }` payloads, offsets relative to the parent statement's raw text.
- `batch.ts` — `ingestBatch(modules: { path, text }[]): IngestBatchResult` that runs identifier emission across all modules, builds a single `ts.Program`, runs the TypeChecker resolution pass, and emits `Reference[]` plus all node rows.

**`packages/render/src/` (one file split):**
- `index.ts` — `render(module, children)` plus the new `renderWithSourceMap(module, children, identifiersById, overlay?)` returning `{ text, sourceMap }`.
- `splice.ts` — pure helper `spliceStatement(rawPayload, mutations)` that takes a statement's raw payload and a list of `{ offset, oldText, newText }` mutations and returns the new payload with all splices applied in descending offset order.

**`packages/cli/src/`:**
- `cli.ts` — modified to dispatch new subcommands (`roundtrip` retained, plus `ingest-batch`, `rename`, `t03`).
- `commands/ingestBatch.ts` — ingests every `.ts` file under a directory into `.strata.db`.
- `commands/rename.ts` — programmatic `rename_symbol` from CLI args (for manual exploration).
- `commands/t03.ts` — runs the T03 acceptance script: ingest `examples/medium`, rename `User` → `Account`, validate, commit, assert all six acceptance criteria.

**`examples/medium/src/` (new fixture files for T03):**
- `types/user.ts` — exported `interface User { ... }` (the rename target).
- `server/audit.ts` — uses the *string literal* `"User"` as a discriminator (negative test — must not be touched).
- `index.ts` — gains `export type { User } from "./types/user.ts"` (the type-only re-export).
- 5 additional consumer modules under `src/users/` using `User` in type positions, JSDoc `@param {User}` tags, generic `Promise<User[]>`, and a namespace import. Total: a tight `examples/medium/` extension exercising T03's failure surface.
- Update `examples/medium/tsconfig.json` `include` if needed (already `src/**/*.ts`).

**`packages/cli/tests/` and per-package tests:**
- Tests live next to the files they exercise; one `*.test.ts` per source module.
- New test fixtures live under `packages/<pkg>/tests/fixtures/`.

**Documentation:**
- `decisions.md` — appended only at the end of the plan (Task 14), once decisions have actually held up.
- `CLAUDE.md` — appended only if commands change (Task 14).

---

## Task 0: Workspace bootstrap and dependency add

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/store/package.json`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts` (split into multiple files in Task 1 — Task 0 only adds new test scripts)
- Modify: `/Users/toddhebebrand/Strata/package.json` (root) to add `@anthropic-ai/claude-agent-sdk` for Task 12
- Verify: `/Users/toddhebebrand/Strata/CLAUDE.md` § "Tooling commands"

- [ ] **Step 1: Verify Phase 0 still passes from a clean state**

Run from `/Users/toddhebebrand/Strata`:
```bash
pnpm -r build && pnpm -r test
```
Expected: all four packages build and test successfully. If anything fails, fix before continuing — this plan extends, not rebuilds, Phase 0.

- [ ] **Step 2: Add `@anthropic-ai/claude-agent-sdk` as a root devDependency**

This is only used by the Task 12 smoke test; pinning at the root keeps it out of any shipped package.

Run:
```bash
pnpm add -D -w @anthropic-ai/claude-agent-sdk@latest
```
Expected: `package.json` updated, `pnpm-lock.yaml` updated, no other changes.

- [ ] **Step 3: Commit**

```bash
git add /Users/toddhebebrand/Strata/package.json /Users/toddhebebrand/Strata/pnpm-lock.yaml
git commit -m "chore: add claude-agent-sdk devDep for Phase 1 smoke harness"
```

---

## Task 1: Split `store` into focused modules and add stable IDs

Refactor first so subsequent tasks land in the right files. Pure code motion plus the new `ids.ts`. Behaviour preserved.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/schema.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/src/nodes.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/src/ids.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts` (now a re-export barrel)
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/ids.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/tests/store.test.ts` (imports unchanged, behaviour unchanged)

- [ ] **Step 1: Write the failing test for `nodeId`**

Create `/Users/toddhebebrand/Strata/packages/store/tests/ids.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { nodeId } from "../src/ids";

describe("nodeId", () => {
  it("is deterministic across calls with the same inputs", () => {
    const a = nodeId("src/types/user.ts", [], "Module");
    const b = nodeId("src/types/user.ts", [], "Module");
    expect(a).toEqual(b);
  });

  it("differs when modulePath differs", () => {
    expect(nodeId("a.ts", [0], "Identifier")).not.toEqual(
      nodeId("b.ts", [0], "Identifier")
    );
  });

  it("differs when child path differs", () => {
    expect(nodeId("a.ts", [0, 1], "Identifier")).not.toEqual(
      nodeId("a.ts", [0, 2], "Identifier")
    );
  });

  it("differs when kind differs", () => {
    expect(nodeId("a.ts", [0], "Identifier")).not.toEqual(
      nodeId("a.ts", [0], "InterfaceDeclaration")
    );
  });

  it("is a 16-hex string", () => {
    expect(nodeId("a.ts", [0], "Identifier")).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/ids'".

- [ ] **Step 3: Implement `ids.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/ids.ts`:
```ts
import { createHash } from "node:crypto";

/**
 * Deterministic node ID.
 *
 * `childIndexPath` is the path of childIndex values from the module root to
 * the node (e.g., the third Identifier inside the second statement is
 * `[1, 2]`). Module nodes use `[]`.
 *
 * IDs are stable across re-ingest of an unchanged file, and across
 * mutations that do not change parent/child structure (which is all Phase 1
 * mutations — `rename_symbol` only changes identifier `text`, not shape).
 */
export function nodeId(
  modulePath: string,
  childIndexPath: readonly number[],
  kind: string
): string {
  const hash = createHash("sha1");
  hash.update(modulePath);
  hash.update("\0");
  hash.update(childIndexPath.join("."));
  hash.update("\0");
  hash.update(kind);
  return hash.digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test`
Expected: PASS on the new file.

- [ ] **Step 5: Split existing `index.ts` into `schema.ts` and `nodes.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/schema.ts`:
```ts
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      parent_id TEXT,
      child_index INTEGER,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS nodes_parent_kind_idx ON nodes(parent_id, kind);
  `);
  return db;
}
```

Create `/Users/toddhebebrand/Strata/packages/store/src/nodes.ts` containing the existing `NodeRow`, `LoadedModule`, `insertNodes`, `loadModule`, `listModules`, plus row helpers from the current `index.ts`. Add a new helper `findNodeById`:
```ts
import type { Db } from "./schema";

export interface NodeRow {
  id: string;
  kind: string;
  parentId: string | null;
  childIndex: number | null;
  payload: string;
}

export interface LoadedModule {
  module: NodeRow;
  children: NodeRow[];
}

export function insertNodes(db: Db, nodes: NodeRow[]): void {
  const insert = db.prepare(`
    INSERT INTO nodes (id, kind, parent_id, child_index, payload)
    VALUES (@id, @kind, @parentId, @childIndex, @payload)
  `);
  const insertMany = db.transaction((rows: NodeRow[]) => {
    for (const row of rows) insert.run(row);
  });
  insertMany(nodes);
}

export function findNodeById(db: Db, id: string): NodeRow | undefined {
  const row = db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes WHERE id = ?`
    )
    .get(id);
  return rowToNode(row);
}

export function loadModule(db: Db, moduleId: string): LoadedModule {
  const module = findNodeById(db, moduleId);
  if (!module) throw new Error(`Module not found: ${moduleId}`);

  const children = db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes
       WHERE parent_id = ? ORDER BY child_index ASC`
    )
    .all(moduleId)
    .map(rowToNodeRequired);

  return { module, children };
}

export function listModules(db: Db): NodeRow[] {
  return db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes
       WHERE kind = 'Module' ORDER BY id ASC`
    )
    .all()
    .map(rowToNodeRequired);
}

export function listChildren(db: Db, parentId: string): NodeRow[] {
  return db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes
       WHERE parent_id = ? ORDER BY child_index ASC`
    )
    .all(parentId)
    .map(rowToNodeRequired);
}

interface NodeDbRow {
  id: string;
  kind: string;
  parent_id: string | null;
  child_index: number | null;
  payload: string;
}

function rowToNode(row: unknown): NodeRow | undefined {
  if (!row) return undefined;
  const dbRow = row as NodeDbRow;
  return {
    id: dbRow.id,
    kind: dbRow.kind,
    parentId: dbRow.parent_id,
    childIndex: dbRow.child_index,
    payload: dbRow.payload
  };
}

function rowToNodeRequired(row: unknown): NodeRow {
  const node = rowToNode(row);
  if (!node) throw new Error("Expected node row");
  return node;
}
```

Replace `/Users/toddhebebrand/Strata/packages/store/src/index.ts` with a re-export barrel:
```ts
export { openDb, type Db } from "./schema";
export {
  findNodeById,
  insertNodes,
  listChildren,
  listModules,
  loadModule,
  type LoadedModule,
  type NodeRow
} from "./nodes";
export { nodeId } from "./ids";
```

- [ ] **Step 6: Run all store tests to verify the split preserved behaviour**

Run: `pnpm --filter @strata/store test`
Expected: PASS (existing `store.test.ts` plus the new `ids.test.ts`).

- [ ] **Step 7: Run dependent package tests**

Run: `pnpm -r test`
Expected: PASS across all four packages. The `index.ts` re-exports preserve the old import surface.

- [ ] **Step 8: Commit**

```bash
git add packages/store/src packages/store/tests
git commit -m "refactor(store): split into schema/nodes/ids modules; add stable nodeId"
```

**Bail-signal note:** None yet. Pure code motion. If `pnpm -r test` regresses on `ingest`/`render`/`cli`, the barrel is missing an export — fix and re-run before continuing.

---

## Task 2: Schema — `node_references`, `transactions`, `operations` tables

Add the three new tables and exercise them with a smoke test. No ingest, no resolution, no overlay yet — just schema and CRUD primitives.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/schema.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/src/references.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/src/operations.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts` (export new symbols)
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/references.test.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/operations.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/references.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import {
  getReferencesByTo,
  getReferenceFrom,
  insertReferences,
  type Reference
} from "../src/references";

describe("node_references", () => {
  it("round-trips references with a from→to mapping and inverse lookup", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "decl", kind: "Identifier", parentId: null, childIndex: 0, payload: "" },
      { id: "ref1", kind: "Identifier", parentId: null, childIndex: 1, payload: "" },
      { id: "ref2", kind: "Identifier", parentId: null, childIndex: 2, payload: "" }
    ]);

    const refs: Reference[] = [
      { fromNodeId: "ref1", toNodeId: "decl", kind: "type" },
      { fromNodeId: "ref2", toNodeId: "decl", kind: "type" }
    ];
    insertReferences(db, refs);

    expect(getReferencesByTo(db, "decl")).toEqual(
      expect.arrayContaining(refs)
    );
    expect(getReferenceFrom(db, "ref1")).toEqual(refs[0]);
    expect(getReferenceFrom(db, "missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/references'".

- [ ] **Step 3: Extend `schema.ts` with the three new tables**

Append to `schema.ts`'s `openDb` body (inside `db.exec`):
```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_references (
      from_node_id TEXT NOT NULL PRIMARY KEY,
      to_node_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id),
      FOREIGN KEY (to_node_id)   REFERENCES nodes(id)
    );
    CREATE INDEX IF NOT EXISTS node_references_to_idx
      ON node_references(to_node_id);

    CREATE TABLE IF NOT EXISTS transactions (
      tx_id        TEXT PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      committed_at INTEGER,
      status       TEXT NOT NULL,
      actor        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      op_id                  TEXT PRIMARY KEY,
      tx_id                  TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      params_json            TEXT NOT NULL,
      affected_node_ids_json TEXT NOT NULL,
      actor                  TEXT NOT NULL,
      ts                     INTEGER NOT NULL,
      reasoning              TEXT,
      FOREIGN KEY (tx_id) REFERENCES transactions(tx_id)
    );
    CREATE INDEX IF NOT EXISTS operations_tx_idx ON operations(tx_id);
  `);
```

Combine into one `db.exec` call inside `openDb`. Keep `CREATE TABLE IF NOT EXISTS` semantics so existing DB files still open.

- [ ] **Step 4: Implement `references.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/references.ts`:
```ts
import type { Db } from "./schema";

export type ReferenceKind = "value" | "type" | "namespace";

export interface Reference {
  fromNodeId: string;
  toNodeId: string;
  kind: ReferenceKind;
}

export function insertReferences(db: Db, refs: Reference[]): void {
  const insert = db.prepare(
    `INSERT INTO node_references (from_node_id, to_node_id, kind)
     VALUES (@fromNodeId, @toNodeId, @kind)`
  );
  const insertMany = db.transaction((rows: Reference[]) => {
    for (const row of rows) insert.run(row);
  });
  insertMany(refs);
}

export function getReferencesByTo(db: Db, toNodeId: string): Reference[] {
  return db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references WHERE to_node_id = ?`
    )
    .all(toNodeId) as Reference[];
}

export function getReferenceFrom(db: Db, fromNodeId: string): Reference | undefined {
  const row = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references WHERE from_node_id = ?`
    )
    .get(fromNodeId);
  return (row as Reference | undefined) ?? undefined;
}
```

- [ ] **Step 5: Run the references test**

Run: `pnpm --filter @strata/store test`
Expected: PASS on `references.test.ts`.

- [ ] **Step 6: Write the failing operations test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/operations.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import {
  appendOperations,
  listOperationsByTx,
  type OperationRow
} from "../src/operations";

describe("operations", () => {
  it("appends and reads back operation rows by transaction", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO transactions (tx_id, started_at, status, actor)
       VALUES ('tx-1', 0, 'open', 'test')`
    ).run();

    const op: OperationRow = {
      opId: "op-1",
      txId: "tx-1",
      kind: "RenameSymbol",
      paramsJson: JSON.stringify({ declaration_id: "d", new_name: "X" }),
      affectedNodeIdsJson: JSON.stringify(["d", "r1"]),
      actor: "test",
      ts: 12345,
      reasoning: null
    };
    appendOperations(db, [op]);

    expect(listOperationsByTx(db, "tx-1")).toEqual([op]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/operations'".

- [ ] **Step 8: Implement `operations.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/operations.ts`:
```ts
import type { Db } from "./schema";

export interface OperationRow {
  opId: string;
  txId: string;
  kind: string;
  paramsJson: string;
  affectedNodeIdsJson: string;
  actor: string;
  ts: number;
  reasoning: string | null;
}

export function appendOperations(db: Db, ops: OperationRow[]): void {
  const insert = db.prepare(
    `INSERT INTO operations
       (op_id, tx_id, kind, params_json, affected_node_ids_json, actor, ts, reasoning)
     VALUES
       (@opId, @txId, @kind, @paramsJson, @affectedNodeIdsJson, @actor, @ts, @reasoning)`
  );
  const insertMany = db.transaction((rows: OperationRow[]) => {
    for (const row of rows) insert.run(row);
  });
  insertMany(ops);
}

export function listOperationsByTx(db: Db, txId: string): OperationRow[] {
  return db
    .prepare(
      `SELECT
         op_id  AS opId,
         tx_id  AS txId,
         kind,
         params_json            AS paramsJson,
         affected_node_ids_json AS affectedNodeIdsJson,
         actor,
         ts,
         reasoning
       FROM operations
       WHERE tx_id = ?
       ORDER BY ts ASC`
    )
    .all(txId) as OperationRow[];
}
```

- [ ] **Step 9: Update `index.ts` barrel**

Add to `/Users/toddhebebrand/Strata/packages/store/src/index.ts`:
```ts
export {
  getReferenceFrom,
  getReferencesByTo,
  insertReferences,
  type Reference,
  type ReferenceKind
} from "./references";
export {
  appendOperations,
  listOperationsByTx,
  type OperationRow
} from "./operations";
```

- [ ] **Step 10: Run all store tests**

Run: `pnpm --filter @strata/store test`
Expected: PASS — `ids`, `store`, `references`, `operations` tests all green.

- [ ] **Step 11: Commit**

```bash
git add packages/store/src packages/store/tests
git commit -m "feat(store): add node_references/transactions/operations schema and CRUD"
```

**Bail-signal note:** BS2 — if the schema additions slow `openDb` measurably or `insertReferences` against ~1000 references takes more than a few ms, that's premature but worth noting. Don't fix here; flag for Task 11's timing pass.

---

## Task 3: Identifier-level ingest

Walk one AST level deeper inside each statement, emit `Identifier` child nodes with `{ text, offset }` payloads. Pure ingest extension — no resolution yet. Use stable IDs from Task 1.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/ingest/src/identifiers.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/ingest/src/index.ts` (emit identifier children; use stable IDs)
- Create: `/Users/toddhebebrand/Strata/packages/ingest/tests/identifiers.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/ingest/tests/ingest.test.ts` (assert identifier children exist on a small fixture)
- Create: `/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/identifiers.ts` (small fixture)

- [ ] **Step 1: Create the fixture**

Create `/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/identifiers.ts`:
```ts
export interface User {
  id: string;
}

export function greet(user: User): string {
  return `hello ${user.id}`;
}
```

(Note: this is a fixture for the test, not part of `examples/medium/`.)

- [ ] **Step 2: Write the failing identifier-emission test**

Create `/Users/toddhebebrand/Strata/packages/ingest/tests/identifiers.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { emitIdentifiers } from "../src/identifiers";

const fixturePath = path.resolve(__dirname, "fixtures/identifiers.ts");
const fixtureText = readFileSync(fixturePath, "utf8");

function parse(): ts.SourceFile {
  return ts.createSourceFile(
    "fixtures/identifiers.ts",
    fixtureText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

describe("emitIdentifiers", () => {
  it("emits one Identifier node per identifier occurrence inside a statement", () => {
    const sourceFile = parse();
    const interfaceStatement = sourceFile.statements[0];
    if (!interfaceStatement) throw new Error("fixture missing first statement");

    const stmtPayload = interfaceStatement.getFullText(sourceFile);
    const ids = emitIdentifiers(
      sourceFile,
      interfaceStatement,
      "fixtures/identifiers.ts",
      [0]
    );

    // The interface declaration has identifier "User" plus the property "id".
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const texts = ids.map((n) => JSON.parse(n.payload).text);
    expect(texts).toContain("User");
    expect(texts).toContain("id");

    // Each identifier's offset points into the statement payload.
    for (const node of ids) {
      const { text, offset } = JSON.parse(node.payload);
      expect(stmtPayload.slice(offset, offset + text.length)).toEqual(text);
    }
  });

  it("emits identifiers for function declaration with parameter type and JSDoc", () => {
    const sourceFile = parse();
    const fnStatement = sourceFile.statements[1];
    if (!fnStatement) throw new Error("fixture missing second statement");

    const ids = emitIdentifiers(
      sourceFile,
      fnStatement,
      "fixtures/identifiers.ts",
      [1]
    );

    const texts = ids.map((n) => JSON.parse(n.payload).text);
    expect(texts).toContain("greet");
    expect(texts).toContain("user");
    expect(texts).toContain("User");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/ingest test`
Expected: FAIL with "Cannot find module '../src/identifiers'".

- [ ] **Step 4: Implement `identifiers.ts`**

Create `/Users/toddhebebrand/Strata/packages/ingest/src/identifiers.ts`:
```ts
import ts from "typescript";
import { nodeId, type NodeRow } from "@strata/store";

/**
 * Walks a statement's subtree and emits one Identifier child node per
 * `ts.Identifier` occurrence (declaration sites and reference sites).
 *
 * `offset` is the byte offset of the identifier relative to the start of
 * the parent statement's `getFullText(sourceFile)` payload.
 *
 * Identifiers inside string literals, template literal raw text, and
 * comment text (other than JSDoc identifiers that the TS parser surfaces
 * as `ts.Identifier` nodes within JSDoc nodes) are not visited because
 * the AST walk only descends `forEachChild`.
 */
export function emitIdentifiers(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  modulePath: string,
  statementChildPath: readonly number[]
): NodeRow[] {
  const stmtStart = statement.getFullStart();
  const out: NodeRow[] = [];
  let childIndex = 0;

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const offset = node.getStart(sourceFile) - stmtStart;
      const text = node.text;
      const path = [...statementChildPath, childIndex];
      out.push({
        id: nodeId(modulePath, path, "Identifier"),
        kind: "Identifier",
        parentId: nodeId(modulePath, statementChildPath, ts.SyntaxKind[statement.kind]),
        childIndex,
        payload: JSON.stringify({ text, offset })
      });
      childIndex += 1;
    }
    ts.forEachChild(node, visit);
    if ((node as ts.JSDocContainer).jsDoc) {
      for (const jsDoc of (node as ts.JSDocContainer).jsDoc ?? []) {
        ts.forEachChild(jsDoc, visit);
      }
    }
  }

  visit(statement);
  return out;
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @strata/ingest test`
Expected: the two `identifiers.test.ts` assertions PASS.

- [ ] **Step 6: Wire identifier emission into `ingest()` and switch to stable IDs**

Replace `/Users/toddhebebrand/Strata/packages/ingest/src/index.ts`:
```ts
import ts from "typescript";
import { nodeId, type NodeRow } from "@strata/store";
import { emitIdentifiers } from "./identifiers";

export interface IngestResult {
  module: NodeRow;
  children: NodeRow[];
}

export function ingest(sourceText: string, modulePath: string): IngestResult {
  const sourceFile = ts.createSourceFile(
    modulePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const moduleNodeId = nodeId(modulePath, [], "Module");
  const module: NodeRow = {
    id: moduleNodeId,
    kind: "Module",
    parentId: null,
    childIndex: null,
    payload: modulePath
  };

  const children: NodeRow[] = [];

  sourceFile.statements.forEach((statement, index) => {
    const kind = ts.SyntaxKind[statement.kind];
    const stmtId = nodeId(modulePath, [index], kind);
    children.push({
      id: stmtId,
      kind,
      parentId: moduleNodeId,
      childIndex: index,
      payload: statement.getFullText(sourceFile)
    });
    children.push(...emitIdentifiers(sourceFile, statement, modulePath, [index]));
  });

  const eofIndex = sourceFile.statements.length;
  children.push({
    id: nodeId(modulePath, [eofIndex], "EndOfFileTrivia"),
    kind: "EndOfFileTrivia",
    parentId: moduleNodeId,
    childIndex: eofIndex,
    payload: sourceFile.endOfFileToken.getFullText(sourceFile)
  });

  return { module, children };
}

export type { NodeRow };
```

- [ ] **Step 7: Update existing ingest test for the new shape**

The existing test in `packages/ingest/tests/ingest.test.ts` asserts the Phase 0 schema. Update it to:
1. Filter `children` by `kind !== "Identifier"` for the existing assertions about statement + EOF children.
2. Add one new assertion: `expect(children.some((c) => c.kind === "Identifier"))` is true on a non-trivial input.

Read the current file and modify in-place; do not delete the existing assertions.

- [ ] **Step 8: Run all ingest tests**

Run: `pnpm --filter @strata/ingest test`
Expected: PASS.

- [ ] **Step 9: Run dependent package tests**

Run: `pnpm -r test`
Expected: `render` and `cli` tests still pass — `render` ignores Identifier children for now because it sorts and concatenates `payload` and Identifier nodes are not yet on the rendered path (statements still hold raw text). The `cli` roundtrip remains valid: Identifier nodes are extra children that contribute their payload (a JSON string) to render output, which would break round-trip.

**Diagnostic check at this step:** if the `cli` roundtrip test fails because Identifier payloads were concatenated, that means render naively iterates *all* children. The fix is part of Task 5 (render extension). To keep this task green without anticipating Task 5, make `emitIdentifiers` emit children whose `childIndex` is `null`, and filter `null`-childIndex children out in the render concatenation in `packages/render/src/index.ts` as a one-line guard. Add a test in `packages/render/tests/render.test.ts` to lock this in.

Run: `pnpm -r test` again.
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/ingest packages/render packages/store
git commit -m "feat(ingest): emit Identifier child nodes with offsets; switch to stable IDs"
```

**Bail-signal note:** BS2 (sqlite perf) — Identifier counts are roughly 5-20× statement counts in real TS. If ingest of `packages/store/src/nodes.ts` (a representative module) takes >100ms with identifier emission, log a timing observation; don't optimize yet.

---

## Task 4: Symbol resolution + references index

Build the second-pass resolver. Take the whole ingest batch, create one `ts.Program` over the source texts, walk identifier nodes, resolve each via `getSymbolAtLocation` (with `getAliasedSymbol` and JSDoc support), and emit `Reference[]`.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/ingest/src/batch.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/ingest/src/index.ts` (re-export `ingestBatch`)
- Create: `/Users/toddhebebrand/Strata/packages/ingest/tests/batch.test.ts`
- Create: `/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/batch-rename/` (small two-file fixture)

- [ ] **Step 1: Build the resolution fixture**

Create directory and files:

`/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/batch-rename/types/user.ts`:
```ts
export interface User {
  id: string;
}
```

`/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/batch-rename/consumer.ts`:
```ts
import type { User } from "./types/user";

/**
 * @param {User} u
 */
export function greet(u: User): string {
  return u.id;
}

export type Users = User[];
```

`/Users/toddhebebrand/Strata/packages/ingest/tests/fixtures/batch-rename/index.ts`:
```ts
export type { User } from "./types/user";
export { greet } from "./consumer";
```

- [ ] **Step 2: Write the failing batch resolution test**

Create `/Users/toddhebebrand/Strata/packages/ingest/tests/batch.test.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestBatch } from "../src/batch";

function loadFixtureModules(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (entry.endsWith(".ts")) {
        out.push({ path: path.relative(root, abs), text: readFileSync(abs, "utf8") });
      }
    }
  }
  walk(root);
  return out;
}

describe("ingestBatch", () => {
  it("resolves every `User` identifier in the fixture back to the declaration", () => {
    const root = path.resolve(__dirname, "fixtures/batch-rename");
    const modules = loadFixtureModules(root);
    const result = ingestBatch(modules);

    const userIdentifiers = result.allNodes.filter(
      (n) => n.kind === "Identifier" && JSON.parse(n.payload).text === "User"
    );
    // 1 declaration site + at least 5 reference sites (import, JSDoc, param
    // type, return type via `Users`, type-only re-export).
    expect(userIdentifiers.length).toBeGreaterThanOrEqual(6);

    // Exactly one of them is the declaration (its parentId points at an
    // InterfaceDeclaration statement in types/user.ts).
    const declarations = userIdentifiers.filter((id) => {
      const parent = result.allNodes.find((n) => n.id === id.parentId);
      return parent?.kind === "InterfaceDeclaration";
    });
    expect(declarations).toHaveLength(1);
    const declId = declarations[0]!.id;

    // Every non-declaration `User` identifier should resolve to declId.
    const refIdentifierIds = userIdentifiers
      .filter((id) => id.id !== declId)
      .map((id) => id.id);

    for (const refId of refIdentifierIds) {
      const ref = result.references.find((r) => r.fromNodeId === refId);
      expect(ref, `expected resolution for ${refId}`).toBeDefined();
      expect(ref!.toNodeId).toEqual(declId);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/ingest test`
Expected: FAIL with "Cannot find module '../src/batch'".

- [ ] **Step 4: Implement `batch.ts`**

Create `/Users/toddhebebrand/Strata/packages/ingest/src/batch.ts`:
```ts
import ts from "typescript";
import { nodeId, type NodeRow, type Reference, type ReferenceKind } from "@strata/store";
import { ingest } from "./index";

export interface IngestBatchInput {
  path: string;
  text: string;
}

export interface IngestBatchResult {
  allNodes: NodeRow[];
  references: Reference[];
  /** Modules in the order they were ingested, mapped to their module-node id. */
  modules: { path: string; moduleId: string }[];
}

export function ingestBatch(inputs: IngestBatchInput[]): IngestBatchResult {
  const allNodes: NodeRow[] = [];
  const modules: { path: string; moduleId: string }[] = [];
  const sourceFiles = new Map<string, ts.SourceFile>();

  for (const input of inputs) {
    const sourceFile = ts.createSourceFile(
      input.path,
      input.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    sourceFiles.set(input.path, sourceFile);

    const single = ingest(input.text, input.path);
    allNodes.push(single.module, ...single.children);
    modules.push({ path: input.path, moduleId: single.module.id });
  }

  // Single Program across the batch.
  const compilerHost: ts.CompilerHost = {
    fileExists: (p) => sourceFiles.has(p),
    readFile: (p) => sourceFiles.get(p)?.getFullText(),
    getSourceFile: (p) => sourceFiles.get(p),
    getDefaultLibFileName: ts.getDefaultLibFileName,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (p) => p,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  };

  const program = ts.createProgram({
    rootNames: inputs.map((i) => i.path),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true
    },
    host: compilerHost
  });
  const checker = program.getTypeChecker();

  const references: Reference[] = [];

  for (const input of inputs) {
    const sourceFile = sourceFiles.get(input.path)!;
    visit(sourceFile, input.path);
  }

  function visit(node: ts.Node, modulePath: string): void {
    if (ts.isIdentifier(node)) {
      tryResolve(node, modulePath);
    }
    ts.forEachChild(node, (c) => visit(c, modulePath));
    if ((node as ts.JSDocContainer).jsDoc) {
      for (const jsDoc of (node as ts.JSDocContainer).jsDoc ?? []) {
        ts.forEachChild(jsDoc, (c) => visit(c, modulePath));
      }
    }
  }

  function tryResolve(identifier: ts.Identifier, modulePath: string): void {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // Aliased lookup can throw on unresolvable aliases — leave as the
        // local alias symbol in that case.
      }
    }
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return;
    const decl = declarations[0]!;
    const declSourceFile = decl.getSourceFile();
    const declModulePath = declSourceFile.fileName;
    if (!sourceFiles.has(declModulePath)) return; // out-of-batch (lib.d.ts)

    const declIdentifier = pickDeclarationIdentifier(decl);
    if (!declIdentifier) return;

    const fromNodeId = identifierNodeId(identifier, modulePath, sourceFiles.get(modulePath)!);
    const toNodeId = identifierNodeId(
      declIdentifier,
      declModulePath,
      declSourceFile
    );
    if (!fromNodeId || !toNodeId) return;
    if (fromNodeId === toNodeId) return; // declaration's own identifier; not a reference

    references.push({
      fromNodeId,
      toNodeId,
      kind: classifyReferenceKind(symbol)
    });
  }

  return { allNodes, references, modules };
}

function pickDeclarationIdentifier(decl: ts.Declaration): ts.Identifier | undefined {
  const named = decl as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name;
  return undefined;
}

function classifyReferenceKind(symbol: ts.Symbol): ReferenceKind {
  if (symbol.flags & ts.SymbolFlags.Namespace) return "namespace";
  if (
    symbol.flags &
    (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
  ) {
    return "type";
  }
  return "value";
}

/**
 * Recompute the stable identifier node ID by re-deriving the (statement
 * child path, identifier child index) from the source file. Mirrors the
 * walk inside `emitIdentifiers`.
 */
function identifierNodeId(
  identifier: ts.Identifier,
  modulePath: string,
  sourceFile: ts.SourceFile
): string | undefined {
  // Find owning top-level statement.
  let owner: ts.Node = identifier;
  while (owner.parent && owner.parent.kind !== ts.SyntaxKind.SourceFile) {
    owner = owner.parent;
  }
  if (owner.parent?.kind !== ts.SyntaxKind.SourceFile) return undefined;
  const statementIndex = sourceFile.statements.indexOf(owner as ts.Statement);
  if (statementIndex < 0) return undefined;

  // Find the identifier's child index inside the statement's identifier walk.
  let childIndex = -1;
  let found = -1;
  function visit(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      childIndex += 1;
      if (node === identifier) {
        found = childIndex;
        return true;
      }
    }
    let stop = false;
    ts.forEachChild(node, (c) => {
      if (stop) return;
      if (visit(c)) stop = true;
    });
    if (!stop && (node as ts.JSDocContainer).jsDoc) {
      for (const jsDoc of (node as ts.JSDocContainer).jsDoc ?? []) {
        ts.forEachChild(jsDoc, (c) => {
          if (stop) return;
          if (visit(c)) stop = true;
        });
      }
    }
    return stop;
  }
  visit(owner);
  if (found < 0) return undefined;

  return nodeId(modulePath, [statementIndex, found], "Identifier");
}
```

Notes for the implementer:
- The compiler host above is in-memory (no disk reads beyond the batch). That keeps the resolver hermetic for tests.
- `pickDeclarationIdentifier` is intentionally simple. If T03 fixtures hit declarations whose `name` isn't an `Identifier` (e.g., a computed property name), that's BS1 — log and stop.
- Recomputing the identifier's child index on every resolution call is O(N) per identifier; total O(N^2). For `examples/medium/` this is fine. If Task 11 timing flags it as the bottleneck, refactor to a precomputed map; do not pre-optimize.

- [ ] **Step 5: Re-export from `index.ts`**

Append to `/Users/toddhebebrand/Strata/packages/ingest/src/index.ts`:
```ts
export { ingestBatch, type IngestBatchInput, type IngestBatchResult } from "./batch";
```

- [ ] **Step 6: Run the batch test**

Run: `pnpm --filter @strata/ingest test`
Expected: PASS — all `User` identifiers resolve to the declaration in `types/user.ts`.

- [ ] **Step 7: Add a bail-signal probe test for JSDoc**

Add a third `it` to `batch.test.ts`:
```ts
it("resolves the JSDoc @param {User} identifier (BS1 probe)", () => {
  const root = path.resolve(__dirname, "fixtures/batch-rename");
  const modules = loadFixtureModules(root);
  const result = ingestBatch(modules);

  const consumerModule = result.modules.find((m) =>
    m.path.endsWith("consumer.ts")
  )!;
  // Find all `User` identifiers in consumer.ts and ensure at least one is
  // a JSDoc-bound reference resolving to the declaration.
  const userIdsInConsumer = result.allNodes.filter(
    (n) =>
      n.kind === "Identifier" &&
      JSON.parse(n.payload).text === "User" &&
      n.parentId &&
      result.allNodes.find((p) => p.id === n.parentId)?.id !==
        consumerModule.moduleId
  );
  expect(userIdsInConsumer.length).toBeGreaterThan(0);
  const resolved = userIdsInConsumer.filter((id) =>
    result.references.some((r) => r.fromNodeId === id.id)
  );
  // If the count of resolved < count of `User` identifiers, the
  // TypeChecker missed one (likely JSDoc) — that's BS1.
  expect(resolved.length).toEqual(userIdsInConsumer.length);
});
```

Run: `pnpm --filter @strata/ingest test`
Expected: PASS. **If this fails**, stop and surface BS1 — do not work around. The failure mode here is the TypeChecker not resolving JSDoc identifiers; the spec calls out that as a bail signal.

- [ ] **Step 8: Commit**

```bash
git add packages/ingest
git commit -m "feat(ingest): batch ingest with TypeChecker reference resolution"
```

**Bail-signal note:**
- BS1 — Step 7 is the explicit probe. If it fails on JSDoc, namespace import, or type re-export, surface and stop.
- BS3 — `ts.createProgram` on a 3-file fixture should complete in <100ms. If it takes >500ms here, the cold-start cost will be painful once Task 9 calls Program creation on every validate. Note in commit message; do not fix yet.

---

## Task 5: Render extension — splice identifier mutations into statement payloads

Render must now produce *modified* text when an open transaction has queued identifier-text mutations against the children of a statement. Build the splicer first as a pure function, then wire it into render. Also emit per-module source maps.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/render/src/splice.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/render/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/render/tests/splice.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/render/tests/render.test.ts`

- [ ] **Step 1: Write the failing splice test**

Create `/Users/toddhebebrand/Strata/packages/render/tests/splice.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { spliceStatement, type IdentifierMutation } from "../src/splice";

describe("spliceStatement", () => {
  it("returns the original payload when no mutations are applied", () => {
    expect(spliceStatement("export interface User {}", [])).toEqual(
      "export interface User {}"
    );
  });

  it("applies a single splice at a known offset", () => {
    const payload = "export interface User {}";
    const result = spliceStatement(payload, [
      { offset: 17, oldText: "User", newText: "Account" }
    ]);
    expect(result).toEqual("export interface Account {}");
  });

  it("applies multiple splices in descending offset order so earlier splices do not invalidate later offsets", () => {
    // Two `User` occurrences in one statement.
    const payload = "function f(u: User): User { return u; }";
    const mutations: IdentifierMutation[] = [
      { offset: 14, oldText: "User", newText: "Account" },
      { offset: 21, oldText: "User", newText: "Account" }
    ];
    expect(spliceStatement(payload, mutations)).toEqual(
      "function f(u: Account): Account { return u; }"
    );
  });

  it("throws if oldText does not match at the given offset", () => {
    expect(() =>
      spliceStatement("export interface User {}", [
        { offset: 17, oldText: "Account", newText: "User" }
      ])
    ).toThrow(/oldText mismatch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/render test`
Expected: FAIL with "Cannot find module '../src/splice'".

- [ ] **Step 3: Implement `splice.ts`**

Create `/Users/toddhebebrand/Strata/packages/render/src/splice.ts`:
```ts
export interface IdentifierMutation {
  offset: number;
  oldText: string;
  newText: string;
}

export function spliceStatement(
  payload: string,
  mutations: IdentifierMutation[]
): string {
  if (mutations.length === 0) return payload;

  // Descending offset so earlier splices don't shift later offsets.
  const sorted = [...mutations].sort((a, b) => b.offset - a.offset);

  let out = payload;
  for (const m of sorted) {
    const slice = out.slice(m.offset, m.offset + m.oldText.length);
    if (slice !== m.oldText) {
      throw new Error(
        `oldText mismatch at offset ${m.offset}: expected ${JSON.stringify(m.oldText)}, got ${JSON.stringify(slice)}`
      );
    }
    out = out.slice(0, m.offset) + m.newText + out.slice(m.offset + m.oldText.length);
  }
  return out;
}
```

- [ ] **Step 4: Run the splice test**

Run: `pnpm --filter @strata/render test`
Expected: splice tests PASS.

- [ ] **Step 5: Write the failing renderWithSourceMap test**

Add to `/Users/toddhebebrand/Strata/packages/render/tests/render.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { render, renderWithSourceMap } from "../src";
import type { NodeRow } from "@strata/store";

const moduleNode: NodeRow = {
  id: "m", kind: "Module", parentId: null, childIndex: null, payload: "x.ts"
};
const stmt: NodeRow = {
  id: "s1", kind: "InterfaceDeclaration", parentId: "m", childIndex: 0,
  payload: "export interface User {}\n"
};
const userIdentifier: NodeRow = {
  id: "i1", kind: "Identifier", parentId: "s1", childIndex: 0,
  payload: JSON.stringify({ text: "User", offset: 17 })
};
const eof: NodeRow = {
  id: "e1", kind: "EndOfFileTrivia", parentId: "m", childIndex: 1, payload: ""
};

describe("renderWithSourceMap", () => {
  it("returns the canonical text with a source map keyed to statement IDs when no mutations", () => {
    const { text, sourceMap } = renderWithSourceMap(
      moduleNode,
      [stmt, userIdentifier, eof]
    );
    expect(text).toEqual("export interface User {}\n");
    expect(sourceMap).toEqual([
      { renderedStart: 0, renderedEnd: 25, nodeId: "s1" },
      { renderedStart: 25, renderedEnd: 25, nodeId: "e1" }
    ]);
  });

  it("applies identifier-text mutations from the overlay before rendering", () => {
    const { text } = renderWithSourceMap(
      moduleNode,
      [stmt, userIdentifier, eof],
      {
        identifierMutations: new Map([
          ["i1", { text: "Account" }]
        ])
      }
    );
    expect(text).toEqual("export interface Account {}\n");
  });
});
```

Note: the existing `render` test (which calls the no-overlay `render(...)` signature) must continue to pass. The old signature stays for back-compat with `cli`'s `roundtrip` command.

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @strata/render test`
Expected: FAIL with "renderWithSourceMap is not a function" or similar.

- [ ] **Step 7: Implement `renderWithSourceMap`**

Replace `/Users/toddhebebrand/Strata/packages/render/src/index.ts`:
```ts
import type { NodeRow } from "@strata/store";
import { spliceStatement, type IdentifierMutation } from "./splice";

export interface SourceMapEntry {
  renderedStart: number;
  renderedEnd: number;
  nodeId: string;
}

export interface RenderOverlay {
  /** identifierId → new text. Offset is the canonical offset from the
   *  Identifier node's payload. */
  identifierMutations: Map<string, { text: string }>;
}

export interface RenderResult {
  text: string;
  sourceMap: SourceMapEntry[];
}

/**
 * Phase 0 compatibility: concatenate statement-kind and EOF-kind children
 * by childIndex. Identifier children are skipped here (they live as
 * decoration under statements and are emitted via splicing when the
 * mutation overlay carries changes).
 */
export function render(module: NodeRow, children: NodeRow[]): string {
  return renderWithSourceMap(module, children).text;
}

export function renderWithSourceMap(
  _module: NodeRow,
  children: NodeRow[],
  overlay?: RenderOverlay
): RenderResult {
  const topLevel = children
    .filter((c) => c.kind !== "Identifier" && c.childIndex !== null)
    .sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0));

  const identifiersByParent = new Map<string, NodeRow[]>();
  for (const child of children) {
    if (child.kind !== "Identifier" || !child.parentId) continue;
    const bucket = identifiersByParent.get(child.parentId) ?? [];
    bucket.push(child);
    identifiersByParent.set(child.parentId, bucket);
  }

  const sourceMap: SourceMapEntry[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const node of topLevel) {
    const identifiers = identifiersByParent.get(node.id) ?? [];
    const mutations: IdentifierMutation[] = [];
    for (const id of identifiers) {
      const updated = overlay?.identifierMutations.get(id.id);
      if (!updated) continue;
      const payload = JSON.parse(id.payload) as { text: string; offset: number };
      mutations.push({
        offset: payload.offset,
        oldText: payload.text,
        newText: updated.text
      });
    }
    const text = spliceStatement(node.payload, mutations);
    parts.push(text);
    const renderedStart = cursor;
    cursor += text.length;
    sourceMap.push({ renderedStart, renderedEnd: cursor, nodeId: node.id });
  }

  return { text: parts.join(""), sourceMap };
}
```

- [ ] **Step 8: Run all render tests**

Run: `pnpm --filter @strata/render test`
Expected: PASS.

- [ ] **Step 9: Run dependent tests**

Run: `pnpm -r test`
Expected: PASS. The `cli` `roundtrip` still works because `render` is preserved.

- [ ] **Step 10: Commit**

```bash
git add packages/render
git commit -m "feat(render): splice identifier mutations; emit per-module source map"
```

**Bail-signal note:** None. Splicing is small isolated engineering. If a fixture's statement contains identifiers with overlapping offsets (e.g., a single byte appears in two identifier nodes — which shouldn't happen for valid TS), the splicer throws on `oldText mismatch`; that's a Task 4 ingest bug surfacing here.

---

## Task 6: Transactions and the in-memory overlay

Implement `begin`, `rollback`, the overlay shape, and a barebones `commit` that does *not* yet validate (we want overlay correctness pinned before validate is wired). The pending-operations buffer also lives on the overlay.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/transactions.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/transactions.test.ts`

- [ ] **Step 1: Write the failing transaction test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/transactions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import {
  begin,
  commitWithoutValidate,
  getOverlay,
  queueIdentifierUpdate,
  queuePendingOp,
  rollback,
  startupRecoverOpenTransactions
} from "../src/transactions";

describe("transactions", () => {
  it("opens a transaction and persists an `open` row", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test-actor");
    const row = db
      .prepare("SELECT tx_id, status, actor FROM transactions WHERE tx_id = ?")
      .get(tx.id);
    expect(row).toEqual({ tx_id: tx.id, status: "open", actor: "test-actor" });
  });

  it("rolls back: marks `rolled_back` and drops the overlay", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test");
    queueIdentifierUpdate(tx, "id-1", "NewText");
    rollback(db, tx);

    const row = db
      .prepare("SELECT status FROM transactions WHERE tx_id = ?")
      .get(tx.id);
    expect(row).toEqual({ status: "rolled_back" });
    // Overlay is discarded — calling getOverlay on a rolled-back tx throws.
    expect(() => getOverlay(tx)).toThrow();
  });

  it("commitWithoutValidate marks `committed` and flushes overlay rows", () => {
    const db = openDb(":memory:");
    // Seed a Node row to update.
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, child_index, payload)
       VALUES ('i-1', 'Identifier', 'stmt-1', 0, '{"text":"Old","offset":0}')`
    ).run();
    const tx = begin(db, "test");
    queueIdentifierUpdate(tx, "i-1", "New");
    queuePendingOp(tx, {
      kind: "RenameSymbol",
      paramsJson: JSON.stringify({ new_name: "New" }),
      affectedNodeIdsJson: JSON.stringify(["i-1"]),
      reasoning: null
    });
    commitWithoutValidate(db, tx);

    // Identifier payload updated in canonical state.
    const row = db
      .prepare("SELECT payload FROM nodes WHERE id = ?")
      .get("i-1") as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ text: "New", offset: 0 });

    // Operation row appended.
    const ops = db
      .prepare("SELECT kind FROM operations WHERE tx_id = ?")
      .all(tx.id);
    expect(ops).toEqual([{ kind: "RenameSymbol" }]);

    // Transaction status updated.
    const txRow = db
      .prepare("SELECT status FROM transactions WHERE tx_id = ?")
      .get(tx.id);
    expect(txRow).toEqual({ status: "committed" });
  });

  it("startupRecoverOpenTransactions marks orphans as rolled_back", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO transactions (tx_id, started_at, status, actor)
       VALUES ('orphan', 0, 'open', 'crashed-process')`
    ).run();
    startupRecoverOpenTransactions(db);
    const row = db
      .prepare("SELECT status, committed_at FROM transactions WHERE tx_id = 'orphan'")
      .get() as { status: string; committed_at: number };
    expect(row.status).toEqual("rolled_back");
    expect(row.committed_at).toBeGreaterThan(0);
  });

  it("re-committing a committed transaction throws", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "t");
    commitWithoutValidate(db, tx);
    expect(() => commitWithoutValidate(db, tx)).toThrow(/not open/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/transactions'".

- [ ] **Step 3: Implement `transactions.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/transactions.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { Db } from "./schema";
import { appendOperations, type OperationRow } from "./operations";

export interface TxHandle {
  readonly id: string;
  readonly actor: string;
}

export interface PendingOp {
  kind: string;
  paramsJson: string;
  affectedNodeIdsJson: string;
  reasoning: string | null;
}

interface OverlayState {
  /** identifierId → new identifier text. */
  identifierMutations: Map<string, { text: string }>;
  pendingOps: PendingOp[];
  status: "open" | "committed" | "rolled_back";
}

const overlays = new Map<string, OverlayState>();

export function begin(db: Db, actor: string): TxHandle {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transactions (tx_id, started_at, status, actor)
     VALUES (?, ?, 'open', ?)`
  ).run(id, Date.now(), actor);
  overlays.set(id, { identifierMutations: new Map(), pendingOps: [], status: "open" });
  return { id, actor };
}

export function getOverlay(tx: TxHandle): OverlayState {
  const overlay = overlays.get(tx.id);
  if (!overlay) throw new Error(`Transaction ${tx.id} has no overlay (rolled back or unknown)`);
  if (overlay.status !== "open") {
    throw new Error(`Transaction ${tx.id} is ${overlay.status}, not open`);
  }
  return overlay;
}

export function queueIdentifierUpdate(tx: TxHandle, identifierId: string, newText: string): void {
  const overlay = getOverlay(tx);
  overlay.identifierMutations.set(identifierId, { text: newText });
}

export function queuePendingOp(tx: TxHandle, op: PendingOp): void {
  const overlay = getOverlay(tx);
  overlay.pendingOps.push(op);
}

export function rollback(db: Db, tx: TxHandle): void {
  const overlay = overlays.get(tx.id);
  if (!overlay) throw new Error(`Unknown transaction ${tx.id}`);
  if (overlay.status !== "open") throw new Error(`Transaction ${tx.id} not open`);
  db.prepare(
    `UPDATE transactions SET status = 'rolled_back', committed_at = ? WHERE tx_id = ?`
  ).run(Date.now(), tx.id);
  overlay.status = "rolled_back";
  overlays.delete(tx.id);
}

/**
 * Flush overlay rows to canonical state and append operation rows. Does
 * NOT run validate — Task 9 wires the validating `commit`. This function
 * is used internally and by tests that need to inspect post-commit state
 * without the validate path.
 */
export function commitWithoutValidate(db: Db, tx: TxHandle): void {
  const overlay = getOverlay(tx);

  const flush = db.transaction(() => {
    // Apply identifier mutations to canonical state. We rewrite the
    // Identifier payload's `text` field; the `offset` field stays.
    const updateIdentifier = db.prepare(
      `UPDATE nodes SET payload = ? WHERE id = ?`
    );
    const readIdentifier = db.prepare(`SELECT payload FROM nodes WHERE id = ?`);
    for (const [identifierId, mutation] of overlay.identifierMutations) {
      const row = readIdentifier.get(identifierId) as { payload: string } | undefined;
      if (!row) continue;
      const current = JSON.parse(row.payload) as { text: string; offset: number };
      const next = JSON.stringify({ text: mutation.text, offset: current.offset });
      updateIdentifier.run(next, identifierId);
    }

    // Statement payload rewriting (so the canonical text stays in sync
    // with identifier-text changes) is deferred to `commit` in Task 9,
    // which has both render and validate available. Tests in this task
    // only assert identifier-row updates; Task 9's tests assert
    // statement-row updates.

    // Append operation log entries.
    const opRows: OperationRow[] = overlay.pendingOps.map((op) => ({
      opId: randomUUID(),
      txId: tx.id,
      kind: op.kind,
      paramsJson: op.paramsJson,
      affectedNodeIdsJson: op.affectedNodeIdsJson,
      actor: tx.actor,
      ts: Date.now(),
      reasoning: op.reasoning
    }));
    if (opRows.length > 0) appendOperations(db, opRows);

    db.prepare(
      `UPDATE transactions SET status = 'committed', committed_at = ? WHERE tx_id = ?`
    ).run(Date.now(), tx.id);
  });

  flush();
  overlay.status = "committed";
  overlays.delete(tx.id);
}

export function startupRecoverOpenTransactions(db: Db): void {
  db.prepare(
    `UPDATE transactions
       SET status = 'rolled_back', committed_at = ?
     WHERE status = 'open'`
  ).run(Date.now());
}
```

The note inside `commitWithoutValidate` flags that statement-payload rewriting moves to Task 9. That's deliberate: Task 6 nails the overlay state machine; Task 9 ties it to render + validate.

- [ ] **Step 4: Update barrel**

Append to `/Users/toddhebebrand/Strata/packages/store/src/index.ts`:
```ts
export {
  begin,
  commitWithoutValidate,
  getOverlay,
  queueIdentifierUpdate,
  queuePendingOp,
  rollback,
  startupRecoverOpenTransactions,
  type PendingOp,
  type TxHandle
} from "./transactions";
```

- [ ] **Step 5: Run all store tests**

Run: `pnpm --filter @strata/store test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store
git commit -m "feat(store): transactions, in-memory overlay, commitWithoutValidate"
```

**Bail-signal note:** None. Overlay is pure JS memory; perf doesn't apply yet.

---

## Task 7: Read-side queries — `find_declarations`, `get_references`

Thin canonical-state reads matching the spec's API surface. Snake-case names are the spec API; provide both.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/queries.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/queries.test.ts`

- [ ] **Step 1: Write the failing query test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/queries.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import { insertReferences } from "../src/references";
import { find_declarations, get_references } from "../src/queries";

describe("find_declarations", () => {
  it("returns interface declarations whose identifier child has matching text", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "m", kind: "Module", parentId: null, childIndex: null, payload: "x.ts" },
      { id: "s", kind: "InterfaceDeclaration", parentId: "m", childIndex: 0,
        payload: "export interface User {}\n" },
      { id: "i", kind: "Identifier", parentId: "s", childIndex: 0,
        payload: JSON.stringify({ text: "User", offset: 17 }) }
    ]);
    const found = find_declarations(db, { name: "User", kind: "interface" });
    expect(found.map((d) => d.id)).toEqual(["s"]);
  });

  it("returns [] for an unknown name", () => {
    const db = openDb(":memory:");
    expect(find_declarations(db, { name: "Missing" })).toEqual([]);
  });
});

describe("get_references", () => {
  it("returns all references whose to_node_id matches the declaration's identifier", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "m", kind: "Module", parentId: null, childIndex: null, payload: "x.ts" },
      { id: "s1", kind: "InterfaceDeclaration", parentId: "m", childIndex: 0, payload: "export interface User {}\n" },
      { id: "i1", kind: "Identifier", parentId: "s1", childIndex: 0, payload: JSON.stringify({ text: "User", offset: 17 }) },
      { id: "s2", kind: "FunctionDeclaration", parentId: "m", childIndex: 1, payload: "function f(u: User): void {}\n" },
      { id: "i2", kind: "Identifier", parentId: "s2", childIndex: 1, payload: JSON.stringify({ text: "User", offset: 13 }) }
    ]);
    insertReferences(db, [{ fromNodeId: "i2", toNodeId: "i1", kind: "type" }]);

    expect(get_references(db, "s1").map((r) => r.fromNodeId)).toEqual(["i2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/queries'".

- [ ] **Step 3: Implement `queries.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/queries.ts`:
```ts
import type { Db } from "./schema";
import { findNodeById, listChildren, type NodeRow } from "./nodes";
import { getReferencesByTo, type Reference } from "./references";

export type DeclarationKind =
  | "interface"
  | "type-alias"
  | "class"
  | "function"
  | "variable";

const KIND_TO_STATEMENT_KIND: Record<DeclarationKind, string> = {
  interface: "InterfaceDeclaration",
  "type-alias": "TypeAliasDeclaration",
  class: "ClassDeclaration",
  function: "FunctionDeclaration",
  variable: "VariableStatement"
};

export interface FindDeclarationsInput {
  name?: string;
  kind?: DeclarationKind;
}

export function find_declarations(
  db: Db,
  input: FindDeclarationsInput
): NodeRow[] {
  let sql = `SELECT id, kind, parent_id, child_index, payload FROM nodes WHERE 1=1`;
  const params: unknown[] = [];

  if (input.kind) {
    sql += ` AND kind = ?`;
    params.push(KIND_TO_STATEMENT_KIND[input.kind]);
  } else {
    sql += ` AND kind IN (${Object.values(KIND_TO_STATEMENT_KIND).map(() => "?").join(",")})`;
    params.push(...Object.values(KIND_TO_STATEMENT_KIND));
  }

  const stmts = db.prepare(sql).all(...params) as Array<{
    id: string; kind: string; parent_id: string | null;
    child_index: number | null; payload: string;
  }>;
  const candidates: NodeRow[] = stmts.map((r) => ({
    id: r.id, kind: r.kind, parentId: r.parent_id,
    childIndex: r.child_index, payload: r.payload
  }));

  if (!input.name) return candidates;

  return candidates.filter((decl) => {
    const children = listChildren(db, decl.id);
    const declIdentifier = children.find((c) => c.kind === "Identifier");
    if (!declIdentifier) return false;
    const payload = JSON.parse(declIdentifier.payload) as { text: string };
    return payload.text === input.name;
  });
}

export function get_references(db: Db, declarationId: string): Reference[] {
  // The declaration's own identifier is the `to_node_id` in node_references.
  const decl = findNodeById(db, declarationId);
  if (!decl) return [];
  const declChildren = listChildren(db, declarationId);
  const declIdentifier = declChildren.find((c) => c.kind === "Identifier");
  if (!declIdentifier) return [];
  return getReferencesByTo(db, declIdentifier.id);
}

// Camel-case aliases for ergonomic internal use.
export const findDeclarations = find_declarations;
export const getReferences = get_references;
```

- [ ] **Step 4: Update barrel and run tests**

Append to `/Users/toddhebebrand/Strata/packages/store/src/index.ts`:
```ts
export {
  find_declarations,
  findDeclarations,
  get_references,
  getReferences,
  type DeclarationKind,
  type FindDeclarationsInput
} from "./queries";
```

Run: `pnpm --filter @strata/store test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat(store): find_declarations and get_references queries"
```

**Bail-signal note:** BS2 (sqlite perf) — `find_declarations` without `name` filter scans all statement-kind nodes. With ~1k modules × ~10 statements that's 10k rows; sqlite handles it. If it doesn't, that's BS2 firing early.

---

## Task 8: Persist ingest-batch results into the store

Wire `ingestBatch` to the store. This is the bridge between Task 4 (in-memory resolution) and Tasks 7/9/10 (store-backed reads, validate, rename).

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/cli/src/cli.ts` (add `ingest-batch` subcommand)
- Create: `/Users/toddhebebrand/Strata/packages/cli/src/commands/ingestBatch.ts`
- Create: `/Users/toddhebebrand/Strata/packages/cli/tests/ingestBatch.test.ts`

- [ ] **Step 1: Write the failing CLI batch ingest test**

Create `/Users/toddhebebrand/Strata/packages/cli/tests/ingestBatch.test.ts`:
```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runIngestBatch } from "../src/commands/ingestBatch";
import { openDb } from "@strata/store";

describe("ingest-batch command", () => {
  it("ingests every .ts file in a directory tree and populates nodes + node_references", () => {
    const work = mkdtempSync(path.join(tmpdir(), "strata-batch-"));
    try {
      mkdirSync(path.join(work, "src/types"), { recursive: true });
      writeFileSync(
        path.join(work, "src/types/user.ts"),
        `export interface User { id: string; }\n`
      );
      writeFileSync(
        path.join(work, "src/main.ts"),
        `import type { User } from "./types/user";\nexport function f(u: User): User { return u; }\n`
      );

      const dbPath = path.join(work, ".strata.db");
      const result = runIngestBatch({
        rootDir: path.join(work, "src"),
        dbPath
      });
      expect(result.ok).toBe(true);

      const db = openDb(dbPath);
      try {
        const moduleCount = db.prepare(
          `SELECT COUNT(*) AS n FROM nodes WHERE kind = 'Module'`
        ).get() as { n: number };
        expect(moduleCount.n).toBe(2);

        const userIdentifiers = db.prepare(
          `SELECT id, payload FROM nodes WHERE kind = 'Identifier'`
        ).all() as Array<{ id: string; payload: string }>;
        const userIds = userIdentifiers.filter(
          (r) => JSON.parse(r.payload).text === "User"
        );
        expect(userIds.length).toBeGreaterThanOrEqual(4);

        const refCount = db.prepare(
          `SELECT COUNT(*) AS n FROM node_references`
        ).get() as { n: number };
        expect(refCount.n).toBeGreaterThanOrEqual(3);
      } finally {
        db.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/cli test`
Expected: FAIL with "Cannot find module '../src/commands/ingestBatch'".

- [ ] **Step 3: Implement `ingestBatch` command**

Create `/Users/toddhebebrand/Strata/packages/cli/src/commands/ingestBatch.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  insertNodes,
  insertReferences,
  openDb
} from "@strata/store";

export interface RunIngestBatchInput {
  rootDir: string;
  dbPath: string;
}

export function runIngestBatch(input: RunIngestBatchInput): { ok: boolean } {
  const inputs = collectModules(input.rootDir);
  const batch = ingestBatch(inputs);

  const db = openDb(input.dbPath);
  try {
    db.exec("DELETE FROM node_references; DELETE FROM operations; DELETE FROM transactions; DELETE FROM nodes;");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    return { ok: true };
  } finally {
    db.close();
  }
}

function collectModules(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }
  walk(rootDir);
  return out;
}
```

- [ ] **Step 4: Wire into `cli.ts` dispatch**

Modify `/Users/toddhebebrand/Strata/packages/cli/src/cli.ts` `main` to also handle `ingest-batch`:
```ts
import { runIngestBatch } from "./commands/ingestBatch";

// inside main:
if (command === "ingest-batch") {
  const [, rootDir, dbPath] = argv;
  if (!rootDir || !dbPath) {
    console.error("Usage: strata ingest-batch <rootDir> <dbPath>");
    return 1;
  }
  const result = runIngestBatch({ rootDir, dbPath });
  return result.ok ? 0 : 1;
}
```

Update the usage string:
```ts
console.error("Usage: strata roundtrip <input.ts> | ingest-batch <rootDir> <dbPath>");
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @strata/cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): ingest-batch command persists nodes and references"
```

**Bail-signal note:** BS2 — record wall time on `examples/medium/` ingest in Task 11. If `ingest-batch` against `examples/medium/` takes >5s total, log a timing observation; the bail threshold (1s per 2k-LOC module) is per-module, not whole-corpus.

---

## Task 9: Validate-before-commit with multi-module render and source-map diagnostic mapping

Wire `validate(tx)` and turn `commit(tx)` into the validating commit from the spec. This is the largest task by line count; it's load-bearing.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/validate.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/transactions.ts` (replace `commitWithoutValidate` callers' surface with `commit(db, tx)`; the inner function stays)
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/validate.test.ts`

The store now depends on `@strata/render`. Update `packages/store/package.json` to add `"@strata/render": "workspace:*"` and `"typescript": "^5.8.3"` (already present transitively, but make explicit) under `dependencies`.

- [ ] **Step 1: Update `packages/store/package.json` dependencies**

Edit to add under `dependencies`:
```json
"@strata/render": "workspace:*",
"typescript": "^5.8.3"
```

Run `pnpm install` from the repo root to refresh the workspace.

Expected: install completes; `pnpm -r build` still succeeds.

- [ ] **Step 2: Write the failing validate + commit test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/validate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/schema";
import {
  begin,
  queueIdentifierUpdate,
  queuePendingOp,
  rollback
} from "../src/transactions";
import { commit, validate } from "../src/validate";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences } from "../src/index";

function setupCorpus(): { dbPath: string; cleanup: () => void; userDeclIdentifierId: string } {
  const work = mkdtempSync(path.join(tmpdir(), "strata-validate-"));
  mkdirSync(path.join(work, "src/types"), { recursive: true });
  writeFileSync(
    path.join(work, "src/types/user.ts"),
    `export interface User { id: string; }\n`
  );
  writeFileSync(
    path.join(work, "src/consumer.ts"),
    `import type { User } from "./types/user";\nexport function f(u: User): User { return u; }\n`
  );

  const batch = ingestBatch([
    { path: path.join(work, "src/types/user.ts"),
      text: `export interface User { id: string; }\n` },
    { path: path.join(work, "src/consumer.ts"),
      text: `import type { User } from "./types/user";\nexport function f(u: User): User { return u; }\n` }
  ]);
  const dbPath = path.join(work, ".strata.db");
  const db = openDb(dbPath);
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);

  // Find the declaration's Identifier node id.
  const declIdentifier = batch.allNodes.find((n) => {
    if (n.kind !== "Identifier") return false;
    const payload = JSON.parse(n.payload);
    if (payload.text !== "User") return false;
    const parent = batch.allNodes.find((p) => p.id === n.parentId);
    return parent?.kind === "InterfaceDeclaration";
  });
  if (!declIdentifier) throw new Error("setup failed: no declaration identifier");
  db.close();

  return {
    dbPath,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
    userDeclIdentifierId: declIdentifier.id
  };
}

describe("validate", () => {
  it("returns [] when the transaction has no mutations", () => {
    const { dbPath, cleanup } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      expect(validate(db, tx)).toEqual([]);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("returns [] when the transaction renames an interface consistently across all references", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      // Queue mutations: the declaration identifier and every reference.
      queueIdentifierUpdate(tx, userDeclIdentifierId, "Account");
      const refIdentifiers = db.prepare(
        `SELECT from_node_id FROM node_references WHERE to_node_id = ?`
      ).all(userDeclIdentifierId) as Array<{ from_node_id: string }>;
      for (const r of refIdentifiers) {
        queueIdentifierUpdate(tx, r.from_node_id, "Account");
      }
      expect(validate(db, tx)).toEqual([]);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("returns diagnostics with mapped node IDs when the rename leaves a dangling reference", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      // Only rename the declaration; leave references pointing at `User`.
      queueIdentifierUpdate(tx, userDeclIdentifierId, "Account");
      const diags = validate(db, tx);
      expect(diags.length).toBeGreaterThan(0);
      // At least one diagnostic should map to a node ID inside consumer.ts.
      const mapped = diags.filter((d) => d.nodeId !== null);
      expect(mapped.length).toBeGreaterThan(0);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });
});

describe("commit", () => {
  it("commits successfully when validate is clean and refuses commit when not", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);

      // Clean rename.
      const tx1 = begin(db, "test");
      queueIdentifierUpdate(tx1, userDeclIdentifierId, "Account");
      const refs = db.prepare(
        `SELECT from_node_id FROM node_references WHERE to_node_id = ?`
      ).all(userDeclIdentifierId) as Array<{ from_node_id: string }>;
      for (const r of refs) queueIdentifierUpdate(tx1, r.from_node_id, "Account");
      queuePendingOp(tx1, {
        kind: "RenameSymbol",
        paramsJson: JSON.stringify({ new_name: "Account" }),
        affectedNodeIdsJson: JSON.stringify([userDeclIdentifierId, ...refs.map((r) => r.from_node_id)]),
        reasoning: null
      });
      const result1 = commit(db, tx1);
      expect(result1).toEqual({ ok: true });

      // Half-rename to confirm refusal.
      const tx2 = begin(db, "test");
      queueIdentifierUpdate(tx2, userDeclIdentifierId, "Profile");
      const result2 = commit(db, tx2);
      expect(result2.ok).toBe(false);
      if (!result2.ok) expect(result2.diagnostics.length).toBeGreaterThan(0);
      // Transaction remains `open`.
      const status = db
        .prepare("SELECT status FROM transactions WHERE tx_id = ?")
        .get(tx2.id) as { status: string };
      expect(status.status).toEqual("open");
      rollback(db, tx2);
      db.close();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/validate'".

- [ ] **Step 4: Implement `validate.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/validate.ts`:
```ts
import path from "node:path";
import ts from "typescript";
import { renderWithSourceMap, type SourceMapEntry } from "@strata/render";
import type { Db } from "./schema";
import { listModules, loadModule } from "./nodes";
import {
  commitWithoutValidate,
  getOverlay,
  type TxHandle
} from "./transactions";

export interface Diagnostic {
  nodeId: string | null;
  modulePath: string | null;
  message: string;
  code: number;
}

export type CommitResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };

export function validate(db: Db, tx: TxHandle): Diagnostic[] {
  const overlay = getOverlay(tx);
  const modules = listModules(db);

  const renderedFiles = new Map<string, string>();
  const sourceMaps = new Map<string, SourceMapEntry[]>();

  for (const module of modules) {
    const loaded = loadModule(db, module.id);
    const { text, sourceMap } = renderWithSourceMap(loaded.module, loaded.children, {
      identifierMutations: overlay.identifierMutations
    });
    renderedFiles.set(module.payload, text);
    sourceMaps.set(module.payload, sourceMap);
  }

  const compilerOptions = loadCompilerOptions();

  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVersion, onError, shouldCreateNewSourceFile) => {
    if (renderedFiles.has(fileName)) {
      return ts.createSourceFile(
        fileName,
        renderedFiles.get(fileName)!,
        langVersion,
        true,
        ts.ScriptKind.TS
      );
    }
    return originalGetSourceFile(fileName, langVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) =>
    renderedFiles.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    renderedFiles.get(fileName) ?? ts.sys.readFile(fileName);

  const program = ts.createProgram({
    rootNames: [...renderedFiles.keys()],
    options: compilerOptions,
    host
  });
  const tsDiagnostics = ts.getPreEmitDiagnostics(program);

  return tsDiagnostics.map((diag) => mapDiagnostic(diag, sourceMaps));
}

export function commit(db: Db, tx: TxHandle): CommitResult {
  const diagnostics = validate(db, tx);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Statement-payload rewrite: for every statement that has a mutated
  // identifier child, materialise the spliced text and persist it as the
  // statement's new canonical payload. This makes the canonical state
  // post-commit identical to what `validate` just verified.
  const overlay = getOverlay(tx);
  const affectedStatements = new Set<string>();
  for (const identifierId of overlay.identifierMutations.keys()) {
    const row = db.prepare(`SELECT parent_id FROM nodes WHERE id = ?`).get(identifierId) as
      | { parent_id: string | null }
      | undefined;
    if (row?.parent_id) affectedStatements.add(row.parent_id);
  }

  for (const stmtId of affectedStatements) {
    const stmtRow = db.prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes WHERE id = ?`
    ).get(stmtId) as
      | { id: string; kind: string; parent_id: string | null; child_index: number | null; payload: string }
      | undefined;
    if (!stmtRow) continue;

    const children = db.prepare(
      `SELECT id, kind, parent_id, child_index, payload FROM nodes WHERE parent_id = ?`
    ).all(stmtId) as Array<{ id: string; kind: string; parent_id: string; child_index: number | null; payload: string }>;

    const mutations: { offset: number; oldText: string; newText: string }[] = [];
    for (const child of children) {
      if (child.kind !== "Identifier") continue;
      const updated = overlay.identifierMutations.get(child.id);
      if (!updated) continue;
      const payload = JSON.parse(child.payload) as { text: string; offset: number };
      mutations.push({ offset: payload.offset, oldText: payload.text, newText: updated.text });
    }
    if (mutations.length === 0) continue;

    // Apply splices in descending order.
    mutations.sort((a, b) => b.offset - a.offset);
    let next = stmtRow.payload;
    const lengthDeltaAfterEach: { offset: number; delta: number }[] = [];
    for (const m of mutations) {
      next =
        next.slice(0, m.offset) +
        m.newText +
        next.slice(m.offset + m.oldText.length);
      lengthDeltaAfterEach.push({ offset: m.offset, delta: m.newText.length - m.oldText.length });
    }
    db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`).run(next, stmtId);

    // Recompute Identifier offsets within this statement.
    // Sort deltas ascending so we shift later identifiers correctly.
    lengthDeltaAfterEach.sort((a, b) => a.offset - b.offset);
    for (const child of children) {
      if (child.kind !== "Identifier") continue;
      const payload = JSON.parse(child.payload) as { text: string; offset: number };
      let shift = 0;
      for (const delta of lengthDeltaAfterEach) {
        if (delta.offset < payload.offset) shift += delta.delta;
      }
      const updatedIdentifierText = overlay.identifierMutations.get(child.id)?.text ?? payload.text;
      const newPayload = JSON.stringify({ text: updatedIdentifierText, offset: payload.offset + shift });
      db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`).run(newPayload, child.id);
    }
  }

  commitWithoutValidate(db, tx);
  return { ok: true };
}

function mapDiagnostic(
  diagnostic: ts.Diagnostic,
  sourceMaps: Map<string, SourceMapEntry[]>
): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const code = diagnostic.code;
  if (!diagnostic.file || typeof diagnostic.start !== "number") {
    return { nodeId: null, modulePath: null, message, code };
  }
  const fileName = diagnostic.file.fileName;
  const map = sourceMaps.get(fileName);
  if (!map) {
    return { nodeId: null, modulePath: fileName, message, code };
  }
  const entry = map.find(
    (e) => diagnostic.start! >= e.renderedStart && diagnostic.start! < e.renderedEnd
  );
  return {
    nodeId: entry?.nodeId ?? null,
    modulePath: fileName,
    message,
    code
  };
}

function loadCompilerOptions(): ts.CompilerOptions {
  // Validate uses the same options the project builds under.
  const configPath = findTsconfigBase();
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
  }
  // Force these to keep validate hermetic.
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true
  };
}

function findTsconfigBase(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "tsconfig.base.json");
    if (ts.sys.fileExists(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate tsconfig.base.json");
}
```

- [ ] **Step 5: Update store barrel and run tests**

Append to `/Users/toddhebebrand/Strata/packages/store/src/index.ts`:
```ts
export { commit, validate, type CommitResult, type Diagnostic } from "./validate";
```

Run: `pnpm --filter @strata/store test`
Expected: all three new `validate.test.ts` cases PASS.

- [ ] **Step 6: Run dependent tests**

Run: `pnpm -r test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/store
git commit -m "feat(store): validate(tx) and committing commit(tx) via render + ts.Program"
```

**Bail-signal note:**
- BS3 — the "diagnostics with mapped node IDs when rename leaves a dangling reference" test is the explicit probe. Time it. If `validate` takes >500ms on a 2-module corpus, log a timing observation and *consider* a long-lived `ts.Program` (but don't build that here — log the decision instead, per spec).
- BS2 — the post-commit statement-payload + identifier-offset rewrite is the heaviest write path. With a typical rename touching ~50 identifiers across ~10 statements, this should be sub-millisecond per statement.

---

## Task 10: `rename_symbol` — the hero

The hero. Implementation should be small because every prerequisite is now in place.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/rename.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/rename.test.ts`

- [ ] **Step 1: Write the failing rename test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/rename.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb, insertNodes, insertReferences, begin, commit } from "../src/index";
import { rename_symbol } from "../src/rename";
import { ingestBatch } from "@strata/ingest";

function setup(): { dbPath: string; userDeclId: string; cleanup: () => void } {
  const work = mkdtempSync(path.join(tmpdir(), "strata-rename-"));
  mkdirSync(path.join(work, "src/types"), { recursive: true });
  const userText = `export interface User { id: string; }\n`;
  const consumerText = `import type { User } from "./types/user";\nexport function f(u: User): User { return u; }\n`;
  writeFileSync(path.join(work, "src/types/user.ts"), userText);
  writeFileSync(path.join(work, "src/consumer.ts"), consumerText);

  const batch = ingestBatch([
    { path: path.join(work, "src/types/user.ts"), text: userText },
    { path: path.join(work, "src/consumer.ts"), text: consumerText }
  ]);
  const dbPath = path.join(work, ".strata.db");
  const db = openDb(dbPath);
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);

  const decl = batch.allNodes.find(
    (n) => n.kind === "InterfaceDeclaration"
  );
  if (!decl) throw new Error("setup: missing InterfaceDeclaration");
  db.close();
  return {
    dbPath,
    userDeclId: decl.id,
    cleanup: () => rmSync(work, { recursive: true, force: true })
  };
}

describe("rename_symbol", () => {
  it("renames the declaration and all references in a single transaction", () => {
    const { dbPath, userDeclId, cleanup } = setup();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      rename_symbol(db, tx, userDeclId, "Account");
      const result = commit(db, tx);
      expect(result).toEqual({ ok: true });

      const userIdentifiers = db.prepare(
        `SELECT payload FROM nodes WHERE kind = 'Identifier'`
      ).all() as Array<{ payload: string }>;
      const renamedTexts = userIdentifiers
        .map((r) => JSON.parse(r.payload).text)
        .filter((t: string) => t === "Account" || t === "User");
      // No "User" identifier survives.
      expect(renamedTexts.every((t: string) => t === "Account")).toBe(true);

      // Operation row was appended.
      const ops = db.prepare(
        `SELECT kind, params_json, affected_node_ids_json FROM operations`
      ).all() as Array<{ kind: string; params_json: string; affected_node_ids_json: string }>;
      expect(ops.length).toEqual(1);
      expect(ops[0]!.kind).toEqual("RenameSymbol");
      const affected = JSON.parse(ops[0]!.affected_node_ids_json);
      expect(affected.length).toBeGreaterThan(1);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("is a no-op when newName matches the existing identifier text", () => {
    const { dbPath, userDeclId, cleanup } = setup();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      rename_symbol(db, tx, userDeclId, "User");
      const result = commit(db, tx);
      expect(result).toEqual({ ok: true });
      const ops = db.prepare(`SELECT * FROM operations`).all();
      expect(ops.length).toEqual(0);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("throws when newName is not a valid TypeScript identifier", () => {
    const { dbPath, userDeclId, cleanup } = setup();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      expect(() => rename_symbol(db, tx, userDeclId, "1notValid")).toThrow();
      db.close();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test`
Expected: FAIL with "Cannot find module '../src/rename'".

- [ ] **Step 3: Implement `rename.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/rename.ts`:
```ts
import type { Db } from "./schema";
import { findNodeById, listChildren } from "./nodes";
import { getReferencesByTo } from "./references";
import {
  queueIdentifierUpdate,
  queuePendingOp,
  type TxHandle
} from "./transactions";

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const DECLARATION_KINDS = new Set([
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "VariableStatement"
]);

export function rename_symbol(
  db: Db,
  tx: TxHandle,
  declarationId: string,
  newName: string
): void {
  if (!IDENT_PATTERN.test(newName)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(newName)}`);
  }
  const decl = findNodeById(db, declarationId);
  if (!decl) throw new Error(`Declaration not found: ${declarationId}`);
  if (!DECLARATION_KINDS.has(decl.kind)) {
    throw new Error(
      `Node ${declarationId} is not a declaration (kind=${decl.kind})`
    );
  }

  const declChildren = listChildren(db, declarationId);
  const declIdentifier = declChildren.find((c) => c.kind === "Identifier");
  if (!declIdentifier) {
    throw new Error(`Declaration ${declarationId} has no identifier child`);
  }
  const declPayload = JSON.parse(declIdentifier.payload) as { text: string };
  if (declPayload.text === newName) {
    return; // no-op
  }
  const oldName = declPayload.text;

  const references = getReferencesByTo(db, declIdentifier.id);
  const affected = [declIdentifier.id, ...references.map((r) => r.fromNodeId)];

  for (const identifierId of affected) {
    queueIdentifierUpdate(tx, identifierId, newName);
  }

  queuePendingOp(tx, {
    kind: "RenameSymbol",
    paramsJson: JSON.stringify({
      declaration_id: declarationId,
      old_name: oldName,
      new_name: newName
    }),
    affectedNodeIdsJson: JSON.stringify(affected),
    reasoning: null
  });
}

// Spec-spelling alias.
export { rename_symbol as renameSymbol };
```

- [ ] **Step 4: Update barrel and run tests**

Append to `/Users/toddhebebrand/Strata/packages/store/src/index.ts`:
```ts
export { rename_symbol, renameSymbol } from "./rename";
```

Run: `pnpm --filter @strata/store test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat(store): rename_symbol — the Phase 1 hero operation"
```

**Bail-signal note:** None new. If this task fails, it's almost certainly a Task 4 (resolution) or Task 9 (validate) bug surfacing. Stop and surface; don't paper over.

---

## Task 11: T03 acceptance test — seed `examples/medium/` and reproduce the benchmark

This task does two things: (1) extend the `examples/medium/` corpus with the T03 fixture files (since the current tree has no `User` symbol), and (2) write a single CLI command + unit-test pair that executes the spec's "Success criteria" list end-to-end.

**Files:**
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/types/user.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/server/audit.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/users/greet.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/users/list.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/users/repo.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/users/serializer.ts`
- Create: `/Users/toddhebebrand/Strata/examples/medium/src/users/legacy.ts`
- Modify: `/Users/toddhebebrand/Strata/examples/medium/src/index.ts` (add `export type { User } from "./types/user.ts";`)
- Create: `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/cli/src/cli.ts` (wire `t03` subcommand)
- Create: `/Users/toddhebebrand/Strata/packages/cli/tests/t03.test.ts`

- [ ] **Step 1: Seed the T03 fixture files**

Create the following files exactly. They are chosen to cover the failure surfaces named in `docs/benchmarks.md` § T03.

`/Users/toddhebebrand/Strata/examples/medium/src/types/user.ts`:
```ts
export interface User {
  id: string;
  email: string;
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/server/audit.ts` (negative test — the string literal `"User"` must not be renamed):
```ts
export type AuditKind = "User" | "Session" | "Token";

export interface AuditEntry {
  kind: AuditKind;
  subjectId: string;
  ts: number;
}

export function userAudit(subjectId: string, ts: number): AuditEntry {
  return { kind: "User", subjectId, ts };
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/users/greet.ts` (JSDoc + parameter type position):
```ts
import type { User } from "../types/user.ts";

/**
 * Greet a user by name.
 * @param {User} user
 */
export function greet(user: User): string {
  return `hello ${user.email}`;
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/users/list.ts` (generic position `Promise<User[]>`):
```ts
import type { User } from "../types/user.ts";

export async function listUsers(load: () => Promise<User[]>): Promise<User[]> {
  return load();
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/users/repo.ts` (multiple reference positions in one module):
```ts
import type { User } from "../types/user.ts";

export interface UserRepo {
  byId(id: string): Promise<User | undefined>;
  all(): Promise<User[]>;
  save(user: User): Promise<void>;
}

export function emptyRepo(): UserRepo {
  return {
    byId: async () => undefined,
    all: async () => [],
    save: async () => {}
  };
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/users/serializer.ts` (named import of the type):
```ts
import { type User } from "../types/user.ts";

export function serialize(user: User): string {
  return JSON.stringify({ id: user.id, email: user.email });
}
```

`/Users/toddhebebrand/Strata/examples/medium/src/users/legacy.ts` (JSDoc-only reference, no value import):
```ts
import type { User } from "../types/user.ts";

/**
 * @param {User} u
 * @returns {string}
 */
export function legacyId(u: User): string {
  return u.id;
}
```

Modify `/Users/toddhebebrand/Strata/examples/medium/src/index.ts` by adding a type-only re-export line:
```ts
export type { User } from "./types/user.ts";
```

(Add it at the bottom of the existing exports, preserving everything already there.)

- [ ] **Step 2: Sanity-check the fixture compiles**

Run from `/Users/toddhebebrand/Strata/examples/medium`:
```bash
npx tsc --noEmit
```
Expected: 0 errors. If errors appear, fix the fixture; the corpus must be valid before T03 can run.

- [ ] **Step 3: Write the failing T03 acceptance test**

Create `/Users/toddhebebrand/Strata/packages/cli/tests/t03.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { runT03 } from "../src/commands/t03";

describe("T03 acceptance", () => {
  it("renames `User` to `Account` through every reference position; commits cleanly; audit literal untouched; operation logged", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const result = runT03({ corpusRoot });

    expect(result.commitOk, JSON.stringify(result.diagnostics ?? [], null, 2)).toBe(true);
    expect(result.criteria.commitReturnedOk).toBe(true);
    expect(result.criteria.validateAfterCommitClean).toBe(true);
    expect(result.criteria.auditLiteralUntouched).toBe(true);
    expect(result.criteria.indexReExportRenamed).toBe(true);
    expect(result.criteria.jsdocReferencesRenamed).toBe(true);
    expect(result.criteria.operationRowAppended).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @strata/cli test`
Expected: FAIL with "Cannot find module '../src/commands/t03'".

- [ ] **Step 5: Implement `t03.ts`**

Create `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";
import {
  begin,
  commit,
  find_declarations,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  rename_symbol,
  validate
} from "@strata/store";

export interface RunT03Input {
  corpusRoot: string;
}

export interface RunT03Result {
  commitOk: boolean;
  diagnostics?: unknown;
  criteria: {
    commitReturnedOk: boolean;
    validateAfterCommitClean: boolean;
    auditLiteralUntouched: boolean;
    indexReExportRenamed: boolean;
    jsdocReferencesRenamed: boolean;
    operationRowAppended: boolean;
  };
}

export function runT03(input: RunT03Input): RunT03Result {
  const srcRoot = path.join(input.corpusRoot, "src");
  const modules = collectTsFiles(srcRoot);

  const batch = ingestBatch(modules);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);

  // Locate the declaration node.
  const decls = find_declarations(db, { name: "User", kind: "interface" });
  if (decls.length !== 1) {
    throw new Error(
      `Expected exactly one InterfaceDeclaration named User; got ${decls.length}`
    );
  }
  const declId = decls[0]!.id;

  // Perform the rename.
  const tx = begin(db, "t03-test");
  rename_symbol(db, tx, declId, "Account");
  const commitResult = commit(db, tx);
  if (!commitResult.ok) {
    return {
      commitOk: false,
      diagnostics: commitResult.diagnostics,
      criteria: empty()
    };
  }

  // Open a fresh transaction to re-validate post-commit.
  const txCheck = begin(db, "t03-check");
  const postValidate = validate(db, txCheck);

  // Verify audit literal untouched: re-render `server/audit.ts` and grep for `"User"` literal.
  const auditModule = batch.modules.find((m) => m.path.endsWith("/server/audit.ts"))!;
  const auditLoaded = loadModule(db, auditModule.moduleId);
  const { text: auditText } = renderWithSourceMap(auditLoaded.module, auditLoaded.children);
  const auditLiteralUntouched = /"User"/.test(auditText);

  // Verify index.ts re-export was renamed.
  const indexModule = batch.modules.find((m) => m.path.endsWith("/src/index.ts"))!;
  const indexLoaded = loadModule(db, indexModule.moduleId);
  const { text: indexText } = renderWithSourceMap(indexLoaded.module, indexLoaded.children);
  const indexReExportRenamed =
    /export type \{\s*Account\s*\} from "\.\/types\/user\.ts"/.test(indexText) &&
    !/export type \{\s*User\s*\} from "\.\/types\/user\.ts"/.test(indexText);

  // Verify JSDoc references were renamed in legacy.ts and greet.ts.
  const legacyModule = batch.modules.find((m) => m.path.endsWith("/users/legacy.ts"))!;
  const legacyLoaded = loadModule(db, legacyModule.moduleId);
  const { text: legacyText } = renderWithSourceMap(legacyLoaded.module, legacyLoaded.children);
  const greetModule = batch.modules.find((m) => m.path.endsWith("/users/greet.ts"))!;
  const greetLoaded = loadModule(db, greetModule.moduleId);
  const { text: greetText } = renderWithSourceMap(greetLoaded.module, greetLoaded.children);
  const jsdocReferencesRenamed =
    /@param \{Account\}/.test(legacyText) &&
    /@param \{Account\}/.test(greetText) &&
    !/@param \{User\}/.test(legacyText) &&
    !/@param \{User\}/.test(greetText);

  // Verify operation row.
  const ops = db.prepare(
    `SELECT kind, params_json, affected_node_ids_json FROM operations`
  ).all() as Array<{ kind: string; params_json: string; affected_node_ids_json: string }>;
  const operationRowAppended =
    ops.length === 1 &&
    ops[0]!.kind === "RenameSymbol" &&
    JSON.parse(ops[0]!.params_json).new_name === "Account" &&
    JSON.parse(ops[0]!.affected_node_ids_json).length > 1;

  return {
    commitOk: true,
    criteria: {
      commitReturnedOk: commitResult.ok === true,
      validateAfterCommitClean: postValidate.length === 0,
      auditLiteralUntouched,
      indexReExportRenamed,
      jsdocReferencesRenamed,
      operationRowAppended
    }
  };
}

function empty(): RunT03Result["criteria"] {
  return {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    auditLiteralUntouched: false,
    indexReExportRenamed: false,
    jsdocReferencesRenamed: false,
    operationRowAppended: false
  };
}

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }
  walk(rootDir);
  return out;
}
```

- [ ] **Step 6: Wire `t03` into `cli.ts`**

Modify `main` to handle the subcommand:
```ts
import { runT03 } from "./commands/t03";

// inside main:
if (command === "t03") {
  const [, corpusRoot] = argv;
  if (!corpusRoot) {
    console.error("Usage: strata t03 <examples/medium dir>");
    return 1;
  }
  const result = runT03({ corpusRoot });
  console.log(JSON.stringify(result, null, 2));
  return result.commitOk && Object.values(result.criteria).every(Boolean) ? 0 : 1;
}
```

Update the usage string to include `t03 <examples/medium dir>`.

- [ ] **Step 7: Run the T03 test**

Run: `pnpm --filter @strata/cli test`
Expected: PASS — all six criteria true.

**If it fails**, the diagnostics returned in the `result.diagnostics` slot point to the exact node. Walk back through Task 4 (did the JSDoc/named-import/re-export identifier get resolved?), Task 5 (did the splice land at the right offset?), or Task 9 (did the source map map the diagnostic correctly?). Do not patch around a missing resolution — that is BS1.

- [ ] **Step 8: Time the run for the bail-signal record**

After running `pnpm -r build`, time the T03 command:
```bash
time node packages/cli/dist/cli.js t03 ./examples/medium
```

Record the wall time in the Task 14 decisions log. If `t03` total wall time exceeds 5 seconds, log a BS2/BS3 timing observation.

- [ ] **Step 9: Commit**

```bash
git add examples/medium packages/cli
git commit -m "test(cli): T03 acceptance — programmatic rename of User to Account in examples/medium"
```

**Bail-signal note:** This task is the integration point where every bail signal can fire. The grading rubric:
- Validate hits diagnostics that map to JSDoc nodes → BS1 (TypeChecker didn't resolve JSDoc).
- Wall time >5s → BS2 or BS3 depending on `time` breakdown.
- Validate hits diagnostics that map to nodes we *did* mutate but at wrong offsets → render-splice bug; fix in Task 5, not here.

---

## Task 12: `@anthropic-ai/claude-agent-sdk` schema smoke

The Phase 3 work hasn't started, but we should know now (BS4) whether the SDK can express the schemas we'll need. A 30-line smoke harness, run once, then archived.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/cli/src/commands/sdkSmoke.ts`
- Create: `/Users/toddhebebrand/Strata/packages/cli/tests/sdkSmoke.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/cli/src/cli.ts` (add `sdk-smoke` subcommand)

- [ ] **Step 1: Write the failing smoke test**

Create `/Users/toddhebebrand/Strata/packages/cli/tests/sdkSmoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { describeSdkToolSchema } from "../src/commands/sdkSmoke";

describe("SDK smoke (BS4)", () => {
  it("can describe a find_declarations tool with TxHandle/NodeId/Diagnostic types in its schema", () => {
    const schema = describeSdkToolSchema();
    expect(schema.name).toEqual("find_declarations");
    expect(typeof schema.description).toEqual("string");
    expect(schema.description.length).toBeLessThan(4096); // budget probe
    expect(schema.input_schema).toBeDefined();
    expect(schema.input_schema.type).toEqual("object");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/cli test`
Expected: FAIL with "Cannot find module '../src/commands/sdkSmoke'".

- [ ] **Step 3: Implement `sdkSmoke.ts`**

Create `/Users/toddhebebrand/Strata/packages/cli/src/commands/sdkSmoke.ts`:
```ts
/**
 * BS4 probe — confirm the Anthropic SDK's tool schema shape can express
 * find_declarations + the types `rename_symbol` and `validate` will need.
 *
 * Phase 1 does not ship an agent. This file exists only to fail loudly
 * if the SDK's schema surface won't fit the Phase 3 tool shape.
 */
export interface SdkToolShape {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function describeSdkToolSchema(): SdkToolShape {
  return {
    name: "find_declarations",
    description:
      "Find declaration nodes by name and/or kind. Returns an array of declaration NodeRow values. Used by rename_symbol and other structural operations to locate the declaration to operate on.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact-match declaration name (case sensitive)." },
        kind: {
          type: "string",
          enum: ["interface", "type-alias", "class", "function", "variable"],
          description: "Restrict to a single declaration kind."
        }
      },
      required: []
    }
  };
}
```

- [ ] **Step 4: Wire optional `sdk-smoke` subcommand**

Add to `cli.ts`:
```ts
import { describeSdkToolSchema } from "./commands/sdkSmoke";

// inside main, before the fallback:
if (command === "sdk-smoke") {
  console.log(JSON.stringify(describeSdkToolSchema(), null, 2));
  return 0;
}
```

- [ ] **Step 5: Run all CLI tests**

Run: `pnpm --filter @strata/cli test`
Expected: PASS.

- [ ] **Step 6: Manual import-side check (the real BS4 probe)**

From `/Users/toddhebebrand/Strata`, dump the SDK's exports:
```bash
node -e "const a = require('@anthropic-ai/claude-agent-sdk'); console.log(Object.keys(a).slice(0,20))"
```
Expected: at least one export name visible (typical SDKs expose `Anthropic`, `Tool`, etc.). If the package failed to install or has zero exports, surface BS4.

If the SDK exports a typed `Tool` shape, write a one-line cast in `sdkSmoke.ts`:
```ts
import type { Tool } from "@anthropic-ai/claude-agent-sdk";
// type assertion that our shape is assignable:
const _shapeProbe: Tool = describeSdkToolSchema() as unknown as Tool;
void _shapeProbe;
```
If the SDK's actual `Tool` type doesn't accept our shape, that is BS4 firing. Log the mismatch and stop.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "test(cli): claude-agent-sdk schema smoke (BS4 probe)"
```

---

## Task 13: Stable-ID round-trip sanity test

Final invariant check before logging decisions: re-ingest after rename and verify that the operation log's `affected_node_ids_json` still resolves to the renamed declaration's identifier node.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/cli/tests/stableIds.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/toddhebebrand/Strata/packages/cli/tests/stableIds.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  begin, commit, find_declarations, insertNodes, insertReferences,
  loadModule, openDb, rename_symbol
} from "@strata/store";
import { ingestBatch } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";

describe("stable IDs across re-ingest", () => {
  it("keeps the declaration identifier's ID stable when an unchanged-shape file is re-ingested after rename", () => {
    const work = mkdtempSync(path.join(tmpdir(), "strata-ids-"));
    try {
      mkdirSync(path.join(work, "src/types"), { recursive: true });
      const userPath = path.join(work, "src/types/user.ts");
      const consumerPath = path.join(work, "src/consumer.ts");
      writeFileSync(userPath, `export interface User { id: string; }\n`);
      writeFileSync(consumerPath, `import type { User } from "./types/user.ts";\nexport function f(u: User): User { return u; }\n`);

      // Ingest #1
      const inputs1 = [userPath, consumerPath].map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
      const batch1 = ingestBatch(inputs1);
      const db = openDb(":memory:");
      insertNodes(db, batch1.allNodes);
      insertReferences(db, batch1.references);

      // Rename and commit.
      const decls = find_declarations(db, { name: "User", kind: "interface" });
      expect(decls).toHaveLength(1);
      const declId1 = decls[0]!.id;
      const tx = begin(db, "ids-test");
      rename_symbol(db, tx, declId1, "Account");
      expect(commit(db, tx)).toEqual({ ok: true });

      // Write the rendered files to disk to simulate a real persist-and-reopen.
      for (const m of batch1.modules) {
        const loaded = loadModule(db, m.moduleId);
        const { text } = renderWithSourceMap(loaded.module, loaded.children);
        writeFileSync(m.path, text);
      }

      // Ingest #2 against the on-disk text after rename.
      const inputs2 = [userPath, consumerPath].map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
      const batch2 = ingestBatch(inputs2);

      const decls2 = batch2.allNodes.filter(
        (n) => n.kind === "InterfaceDeclaration"
      );
      expect(decls2).toHaveLength(1);
      const declId2 = decls2[0]!.id;
      // Because the AST shape is unchanged (still one statement at index 0
      // in types/user.ts, kind = InterfaceDeclaration, modulePath unchanged),
      // the declaration node ID must be identical.
      expect(declId2).toEqual(declId1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @strata/cli test`
Expected: PASS. The stable-ID scheme (path + structural-position hash) holds across re-ingest of an unchanged file.

**If it fails**, the ID scheme has a flaw. The most likely cause: `modulePath` is being normalized differently between the two ingest runs (e.g., absolute vs relative). Audit `ingest`'s `modulePath` handling. If the failure is a fundamental flaw in the scheme (not a path-normalization quirk), surface and log a decision before continuing — the content-anchored alternative is the next thing to try.

- [ ] **Step 3: Commit**

```bash
git add packages/cli
git commit -m "test(cli): verify stable node IDs across re-ingest after rename"
```

---

## Task 14: Document durable decisions and refresh CLAUDE.md

Append decisions only for choices that held up through implementation. If anything in the "Self-contained decisions" header drifted during implementation, log the divergence and the reason.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/decisions.md`
- Modify: `/Users/toddhebebrand/Strata/CLAUDE.md`

- [ ] **Step 1: Append decisions to `decisions.md`**

Add new entries at the top of the existing "newest first" list:

```markdown
## 2026-05-14 — Phase 1 verticalization, `rename_symbol`-only

**Context:** Phase 1 implementation. Spec `docs/superpowers/specs/2026-05-14-phase1-rename-symbol-design.md` narrowed Phase 1 from the wide tool set in `strata-design.md` § "Tool set" to a single hero (`rename_symbol`) plus the infrastructure that operation forces (identifier-level lowering, references index, transactions, operation log, validate-before-commit).

**Considered:** wide build of every Phase-1 tool in parallel; narrow build starting with trivial ops (`add_import`, `delete_node`); single-hero verticalization.

**Decided:** single-hero verticalization. `rename_symbol` is the spine; other mutations follow in Phase 1.5+ along the same spine.

**Why:** Wide build commits architecture (lowering, index shape, transaction view semantics) before any of it is pressure-tested. Narrow build never forces reference resolution. The hero in the middle forces every Phase 1 decision against an honest forcing function.

**Design-doc impact:** `strata-design.md` § "Phase 1" remains the target. This spec specifies the first vertical slice through it. Phase 1.5 / Phase 2 will broaden horizontally.

**Revisit when:** Phase 1.5 starts (the second mutation lands). If the second op fits cleanly onto the spine, the verticalization paid off; if it requires re-shaping the schema or API, log the divergence.
```

```markdown
## 2026-05-14 — Stable node IDs via path + structural-position hash

**Context:** Phase 1 ingest. Phase 0 used `randomUUID()` per node, which breaks across re-ingest. `CLAUDE.md` mandates stable IDs across mutations; spec § "Open questions" § 2 requires stable IDs across re-ingest of an unchanged file.

**Considered:** (a) path + structural-position hash (sha1 of modulePath + childIndex path + nodeKind, truncated to 16 hex). (b) Content-anchored (hash of nearest-named-ancestor + relative position).

**Decided:** (a). Implemented in `packages/store/src/ids.ts`. Verified by `packages/cli/tests/stableIds.test.ts`.

**Why:** Simpler. Stable across the cases Phase 1 hero needs (rename, which doesn't change AST shape, only identifier text). Known limitation: inserting a statement earlier in a file rewrites all later sibling IDs. Acceptable for Phase 1 because the hero doesn't insert statements. When Phase 1.5+ adds `delete_node` or `add_import`, this limitation hits — log the divergence then.

**Design-doc impact:** none yet — Phase 0 was pre-schema and the design doc doesn't pin an ID scheme. Add a paragraph to `strata-design.md` § "Phase 1" when revisited.

**Revisit when:** the first structural mutation (Phase 1.5) lands or when the stable-ID test in `packages/cli/tests/stableIds.test.ts` fails on a real corpus.
```

```markdown
## 2026-05-14 — In-memory transaction overlay; open transactions don't survive process restart

**Context:** Phase 1 transactions. Spec § "Schema" § `transactions` allows open-transaction state to be lost on restart.

**Decided:** Overlay is a JS `Map` keyed by `tx_id`. `commit`/`rollback` flush or discard. Process startup runs `startupRecoverOpenTransactions(db)` which marks any orphaned `status='open'` rows as `rolled_back` with synthetic `committed_at`.

**Why:** Phase 1 has no multi-process or session-resume use case. Adding overlay persistence would multiply implementation work and add a sync point we don't need.

**Design-doc impact:** none.

**Revisit when:** Phase 3 (agent session resumption) needs to recover an in-flight transaction across a session boundary.
```

```markdown
## 2026-05-14 — Validate creates a fresh ts.Program per call

**Context:** Phase 1 validate. Spec § "Bail signals" § 3 names long-lived Program as a possible cost-saving alternative.

**Decided:** Fresh `ts.createProgram` per `validate(tx)` call. Implemented in `packages/store/src/validate.ts`.

**Why:** Simplest correct implementation. Phase 1's hero acceptance test runs <5s end-to-end against `examples/medium/`. Long-lived Program is a Phase 3 optimization if the agent loop forces validate constantly enough for cold-start cost to dominate.

**Design-doc impact:** none.

**Revisit when:** Phase 3 agent loop timing shows `ts.createProgram` >50% of validate wall time, OR memory growth from leaked SourceFiles exceeds 100MB per session.
```

If any of the above decisions changed during implementation, replace its text with what was actually done and a brief "why".

- [ ] **Step 2: Update `CLAUDE.md` § "Tooling commands"**

Replace the current `## Tooling commands` section in `/Users/toddhebebrand/Strata/CLAUDE.md` with concrete commands now that Phase 1 has shipped:

````markdown
## Tooling commands

The monorepo uses pnpm workspaces.

**Build everything:** `pnpm -r build`
**Test everything:** `pnpm -r test`
**Test one package:** `pnpm --filter @strata/store test` (replace package name)

**Phase 0 round-trip CLI** (single file):
```bash
pnpm --filter @strata/cli build
node packages/cli/dist/cli.js roundtrip path/to/input.ts
```

**Phase 1 batch ingest** (populate the store from a directory tree):
```bash
node packages/cli/dist/cli.js ingest-batch <rootDir> <dbPath>
```

**Phase 1 T03 acceptance** (the hero test):
```bash
node packages/cli/dist/cli.js t03 examples/medium
```

Benchmark harness against a single task: not yet implemented; arrives in Phase 4.
````

- [ ] **Step 3: Commit decisions and CLAUDE.md update**

```bash
git add decisions.md CLAUDE.md
git commit -m "docs: Phase 1 decisions (verticalization, stable IDs, overlay, fresh Program) + CLAUDE.md commands"
```

---

## Self-review checklist (already executed)

1. **Spec coverage.**
   - § Acceptance test → Task 11.
   - § What rename_symbol forces us to build § 1 (Identifier lowering) → Task 3.
   - § § 2 (Symbol resolution + references index) → Task 4 + Task 2.
   - § § 3 (Transactions) → Task 6.
   - § § 4 (Operation log) → Task 2 + Task 6.
   - § § 5 (Validate-before-commit) → Task 9.
   - § Schema → Task 1 (extended `nodes`) + Task 2 (new tables).
   - § API surface — `begin/commit/rollback` (Task 6 + Task 9), `find_declarations`/`get_references` (Task 7), `rename_symbol` (Task 10), `validate` (Task 9). All present.
   - § Render adjustment → Task 5.
   - § Out of scope — every listed item is *absent* from the plan. Confirmed.
   - § Bail signals — BS1 (Task 4 step 7), BS2 (Tasks 2, 7, 11), BS3 (Tasks 4, 9, 11), BS4 (Task 12). All probed.
   - § Open questions — § 1 (TypeChecker accuracy) is the BS1 probe in Task 4; § 2 (ID stability across re-ingest) is Task 13.

2. **Placeholder scan.** Searched for "TODO", "TBD", "Add appropriate", "Similar to Task". None found in step bodies. Code blocks are complete.

3. **Type consistency.** `TxHandle` is used consistently across `transactions.ts`, `validate.ts`, `rename.ts`, and tests. `NodeRow` shape is preserved across packages via the `@strata/store` barrel. `Reference`/`ReferenceKind` defined once in `references.ts` and imported elsewhere. `Diagnostic` defined in `validate.ts` (with `nodeId: string | null`) and used in T03's command. `OperationRow` consistent between `operations.ts` and `transactions.ts`. Function names: `rename_symbol` (snake-case API) and `renameSymbol` (alias) both exported; `find_declarations` / `findDeclarations` likewise. The spec's snake-case names are the canonical exports.

---

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-05-14-phase1-rename-symbol-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Best fit for a 14-task plan with explicit bail signals — each task review is a natural place to check whether a bail signal fired.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
