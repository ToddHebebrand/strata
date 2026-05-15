# Phase 3 — Agent-Drives-T03 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a real headless `@anthropic-ai/claude-agent-sdk` agent — with **no** filesystem/bash tools — can drive the existing Strata `rename_symbol` spine through the verbatim T03 benchmark prompt and pass all 11 existing T03 acceptance criteria, scored through the same pure function the programmatic path uses.

**Architecture:** One new leaf package `packages/agent` (`@strata/agent`) that wraps the existing `@strata/store` + `@strata/verify` functions as eight in-process SDK MCP tools over one shared `{ db, actor }` session context, runs a headless `query(...)` session with `tools: []` (hard-removes built-ins), iterates the message stream, and scores the agent-produced store state via a `evaluateT03Criteria(...)` pure function extracted from `packages/cli/src/commands/t03.ts` into `@strata/verify` (see Plan amendment 1 — both `cli` and `agent` consume it from the `@strata/verify` barrel; no `agent → cli` edge). The session loop is built so the message stream can come live from `query(...)` or be replayed from a committed JSON-lines transcript fixture, making CI deterministic without an API key.

**Tech Stack:** TypeScript 5.8, Node 22, pnpm workspaces, `@anthropic-ai/claude-agent-sdk@0.2.118` (installed; `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), `zod@4.4.3` imported as `zod/v4` (matching `sdkSmoke.ts`), `vitest@3`, the existing `@strata/store` / `@strata/verify` / `@strata/ingest` / `@strata/render` packages.

---

## Plan amendments (authoritative — override any conflicting task detail below)

**Where any task, file-layout line, code snippet, or "Resolution" below conflicts with these, the amendment wins.** The implementer adapts package boundaries, imports, `package.json` deps, and tsconfig `references` accordingly using judgment; the intent is unambiguous even where a downstream snippet still shows the old shape.

### Amendment 1 — the shared T03 scorer lives in `@strata/verify`, not `@strata/cli`

The plan's Resolution 3 places `evaluateT03Criteria` / `emptyT03Criteria` / `T03Criteria` in `@strata/cli` and has `@strata/agent` deep-import `@strata/cli/dist/commands/t03Criteria`, adding an `@strata/agent → @strata/cli` dependency. That inverts the normal layering (`cli` is the top of the dependency graph — everything else should not feed back through it) and relies on a fragile no-`exports`-map subpath import. Override:

- The scorer module is **`packages/verify/src/t03Criteria.ts`**, exporting `evaluateT03Criteria(db, batch, srcRoot, input)`, `emptyT03Criteria()`, and the `T03Criteria` / `T03CriteriaInput` types, **re-exported from `@strata/verify`'s barrel** (`packages/verify/src/index.ts`).
- Rationale: `@strata/verify` already depends on `@strata/store` + `@strata/render`, which is exactly the surface the scorer needs (it `loadModule`s and `renderWithSourceMap`s committed store state, then regex/op-row checks it). Both `@strata/cli` (its `t03` command) and `@strata/agent` **already depend on `@strata/verify`** — so this adds **zero new dependency edges**, no deep `dist/` import, no "do not add an `exports` map to cli" fragility, and a clean package boundary.
- **Task 0** extracts the scoring block out of `packages/cli/src/commands/t03.ts` into `packages/verify/src/t03Criteria.ts` (verbatim regex/logic move, behavior-preserving) and re-exports it from verify's barrel. `runT03` in `@strata/cli` imports `{ evaluateT03Criteria, emptyT03Criteria, type T03Criteria }` from `@strata/verify` (barrel, not a deep path). The existing `cli` `t03` command + `t03.test.ts` must still pass unchanged.
- **Task 8** imports the scorer from `@strata/verify` (barrel). Do **not** add `@strata/cli` as a dependency of `@strata/agent`; do **not** add a `{ "path": "../cli" }` tsconfig reference. `@strata/agent`'s deps stay `@strata/store`, `@strata/verify`, `@strata/ingest` (+ sdk, zod). The Task 8 "Resolution"/"Deep-import resolution caveat" steps are superseded by this amendment.
- The Task 0 test (`t03Criteria.test.ts`) moves to `packages/verify/tests/t03Criteria.test.ts` and imports from the verify barrel. It will need `@strata/ingest` as a verify **devDependency** (test-only, to build the `batch`); that is acyclic (ingest does not depend on verify) and test-scoped only — add it under `devDependencies`, not `dependencies`.
- Note for Phase 4: when `packages/bench` is created, the T03 scorer may relocate there (it is benchmark-acceptance logic). For Phase 3 it lives in `@strata/verify` because `bench` does not exist yet and the scorer's render+store surface is verify's.

---

## Operator-vs-implementer split (read first)

The implementer (Codex) **cannot use git** and **cannot reliably reach the npm registry** from its sandbox. Therefore:

- **The implementer never runs `git`.** Every task below ends at a "**Operator commit boundary**" marker instead of a `git commit` step. The implementer's definition of done for a task is: the listed tests pass **and** `pnpm -r build` is green **and** `pnpm -r test` is green. The human operator runs `git add`/`git commit` at each boundary, runs the one-time `pnpm install` in Task 1, regenerates the live transcript fixture in Task 11, and runs the clean phase-boundary verification.
- **The implementer must run BOTH `pnpm -r build` and `pnpm -r test` at every task boundary.** Vitest does **not** typecheck (it transpiles per-file). A green `pnpm -r test` with a broken `pnpm -r build` (`tsc -b`) is **NOT done** — this trap bit Phase 1. Build first, then test. Both green = task done.
- **`pnpm install` is operator-only and happens once (Task 1, Step 2).** The implementer must not run `pnpm add`/`pnpm install`. Task 1 writes the `package.json` and `tsconfig.json`; the operator runs install before the implementer continues to Task 1 Step 4.
- **No API key is required to run `pnpm -r test` green.** The only test that calls a live model is `describe.skipIf(!hasAuth)`-gated (Task 10) and is *skipped*, not failed, when no key is present. The replay-mode test (Task 11) runs key-free from a committed fixture. Steps 1–9 and the replay assertion in 11 need no key.
- **Only public TypeScript / SDK APIs.** No internal `.jsDoc`-style property hacks; no reaching into other packages' `src/` internals — consume them through their `@strata/*` barrels. (See `decisions.md` 2026-05-15 "BS1 ... `getChildren` traversal" for why internal-property hacks are banned: they break `tsc -b` even when vitest is green.)

## Source-of-truth pointers

- Spec (authoritative for WHAT): `/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-05-15-phase3-agent-design.md`
- Invariants: `/Users/toddhebebrand/Strata/CLAUDE.md` — agent has NO filesystem/bash tools; files are not first-class; operation log is canonical; transactions wrap mutations.
- Prior decisions (do not re-litigate): `/Users/toddhebebrand/Strata/decisions.md` (newest-first; per-task entries).
- Benchmark task: `/Users/toddhebebrand/Strata/docs/benchmarks.md` § T03 (the verbatim prompt and success criteria).
- Phase 1 plan (format/convention reference): `/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-05-14-phase1-rename-symbol-plan.md`
- Existing code integrated: `packages/store/src/index.ts`, `packages/verify/src/index.ts`, `packages/ingest/src/batch.ts`, `packages/cli/src/commands/t03.ts` (refactor target), `packages/cli/src/commands/sdkSmoke.ts` (proven SDK Zod tool pattern).

## Decisions logged by this plan (per-task, newest-first convention)

`decisions.md` is append-only, newest-first. Each task that finalizes a durable choice appends its entry **in that task's own operator commit** (the implementer writes the `decisions.md` text; the operator commits it). Mapping:

- **D1 — shared `evaluateT03Criteria` extraction.** Logged in Task 0.
- **D2 — `read_node` export added to `@strata/store`.** Logged in Task 3.
- **D3 — SDK session integration shape (`tools: []` + single-yield async generator + in-process MCP server) cleared BS-B.** Logged in Task 5.
- **D4 — record/replay transcript determinism mechanism (or the live-only fallback if replay can't be threaded).** Logged in Task 11.
- **D5 — Phase 3 verticalizes on agent-drives-T03; BS-A / BS-C observations.** Logged in Task 12.

If implementation forces a logged decision to change, append a **new** newest-first entry in the task where it changed; do not edit the old one. Bail-signal observations are logged in the task that surfaces them, not deferred.

## Bail-signal map (from spec § "Bail signals")

Stop and surface if any of these fire. Do **not** work around. A surfaced wall is more valuable than a papered-over one.

- **BS-A — agent ergonomics.** Surfaced primarily in **Task 10** (live agent T03 run) and probed cheaply in **Task 4** (direct handler unit test proves the spine is tool-drivable without a model). If no *reasonable worldview* system prompt gets the model to form explore → `rename_symbol` → `validate` → `commit_transaction` (it keeps reaching for file tools, can't thread a `TxHandle` across calls, commits without validating, can't recover via `rollback_transaction`), STOP. Do **not** degrade the prompt into a hardcoded "call A then B then C" script — a scripted prompt passing T03 proves nothing. Log the finding in Task 10's `decisions.md` entry and stop.
- **BS-B — SDK session integration.** Surfaced in **Task 5** (minimal one-tool round-trip session probe — *before* the full tool set). If the SDK can't run headless with only custom in-process tools and `tools: []` (built-ins leak into the `init` tool list, the MCP server instance isn't invoked in-process, or tool results aren't delivered back so a later call can use an earlier call's `TxHandle`), STOP. Do not shell out, fake the loop, or pre-apply the mutation outside the agent.
- **BS-C — cost / latency.** Recorded in **Task 10** (first live run) and surfaced via the session log. Capture tokens + wall time from `SDKResultMessage` usage fields every run. Not a hard bail unless orders-of-magnitude worse than a file edit with no plausible path to parity — it is a primary Phase 4 signal. Record it regardless of outcome in Task 12's `decisions.md` entry.

## File structure

Files created or modified, with one-line responsibilities. Sequencing is by task number.

**`packages/cli/src/` (refactor only — behavior preserved):**
- `commands/t03Criteria.ts` — **new.** Exports the pure `evaluateT03Criteria(db, batch, srcRoot, input)`, `emptyT03Criteria()`, and the `T03Criteria` / `T03CriteriaInput` types. The post-commit scoring block of `runT03` moved here verbatim.
- `commands/t03.ts` — **modified.** `runT03` keeps driving the rename programmatically but delegates scoring to `evaluateT03Criteria`. Public `RunT03Result` shape unchanged.

**`packages/agent/` (new package):**
- `package.json` — `@strata/agent`; deps on `@strata/store`/`@strata/verify`/`@strata/ingest` (`workspace:*`), `@anthropic-ai/claude-agent-sdk`, `zod`.
- `tsconfig.json` — extends `../../tsconfig.base.json`, `composite: true`, `references` store/verify/ingest.
- `src/index.ts` — barrel: `runAgentT03`, `createStrataToolServer`, `STRATA_SYSTEM_PROMPT`, log + result types.
- `src/tools.ts` — the eight `tool(...)` definitions over a shared `{ db, actor }` context + `createStrataToolServer` (`createSdkMcpServer` wrapper) + the Zod schema fragments.
- `src/prompt.ts` — `STRATA_SYSTEM_PROMPT` constant (the static worldview prompt).
- `src/log.ts` — JSON-lines session-log event types + an in-memory + file writer.
- `src/session.ts` — `runAgentT03` orchestrator: ingest-as-t03, build server+prompt, `query(...)` with locked options, iterate, pair `tool_use`/`tool_use_result`, capture `SDKResultMessage`, support live + replay sources, assert the runtime invariant guard.
- `tests/tools.test.ts` — direct handler unit tests (no model, no key); shared-context transaction threading; BS-B-relevant schema/loop-shape probe.
- `tests/sessionSmoke.test.ts` — key-gated one-tool round-trip SDK session probe (BS-B).
- `tests/agentT03.test.ts` — key-gated live T03 acceptance run (BS-A) + key-free replay-mode variant.
- `tests/fixtures/agent-t03-transcript.jsonl` — committed recorded transcript fixture for replay mode (recorded by the operator in Task 11).

**`packages/store/src/` (one small addition):**
- `read_node.ts` — **new.** `readNode(db, id, opts?)` thin wrapper over `findNodeById` + `listChildren`.
- `index.ts` — **modified.** Re-export `readNode` / `read_node`.

**Documentation:**
- `decisions.md` — appended per-task (D1–D5) as listed above.
- `CLAUDE.md` § "Tooling commands" — appended in Task 13 with the agent commands.

---

## Task 0: Extract shared `evaluateT03Criteria` (refactor, behavior-preserving)

De-risk the refactor before any agent code. The agent path and the programmatic path must score through *identical* logic so the agent cannot get a weaker check.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03Criteria.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts`
- Create: `/Users/toddhebebrand/Strata/packages/cli/tests/t03Criteria.test.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Confirm Phase 1 is green from a clean state**

Run from `/Users/toddhebebrand/Strata`:
```bash
pnpm -r build && pnpm -r test
```
Expected: every package builds (`tsc -b`) and tests pass, including `packages/cli/tests/t03.test.ts`. If anything fails, stop — this plan extends a green Phase 1, it does not repair it.

- [ ] **Step 2: Write the failing test for the extracted scorer**

Create `/Users/toddhebebrand/Strata/packages/cli/tests/t03Criteria.test.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import { describe, expect, it } from "vitest";
import { evaluateT03Criteria } from "../src/commands/t03Criteria";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

describe("evaluateT03Criteria", () => {
  it("returns all 11 criteria true after a correct programmatic rename", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decls = find_declarations(db, { name: "User", kind: "interface" });
      const tx = begin(db, "t03");
      rename_symbol(db, tx, decls[0]!.id, "Account");
      const commitResult = commit(db, tx);
      expect(commitResult.ok).toBe(true);

      const criteria = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true,
        renameTxId: tx.id
      });
      for (const [key, value] of Object.entries(criteria)) {
        expect(value, `criterion ${key}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("returns criteria false when no rename was applied", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const criteria = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        renameTxId: "none"
      });
      // No rename, no transaction: the rename-positive criteria must be false.
      expect(criteria.commitReturnedOk).toBe(false);
      expect(criteria.validateAfterCommitClean).toBe(false);
      expect(criteria.importRenamed).toBe(false);
      expect(criteria.indexReExportRenamed).toBe(false);
      expect(criteria.operationRowAppended).toBe(false);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/cli test -- t03Criteria`
Expected: FAIL with "Cannot find module '../src/commands/t03Criteria'".

- [ ] **Step 4: Create `t03Criteria.ts` by moving the scoring block verbatim**

Create `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03Criteria.ts`. Move the post-commit scoring logic out of `runT03` **without changing the regexes or logic**. The function takes the db, the `ingestBatch` result, and `srcRoot`, and returns the existing 11-field criteria object. It must NOT re-drive the rename and must NOT read the post-commit re-validate (that stays in `runT03`, see Step 5 — `validateAfterCommitClean` and `commitReturnedOk` are passed in as inputs):

```ts
import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T03Criteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  importRenamed: boolean;
  typeAnnotationRenamed: boolean;
  genericPromiseRenamed: boolean;
  namespaceImportRenamed: boolean;
  auditLiteralUntouched: boolean;
  auditLiteralOnlyRemainingUser: boolean;
  indexReExportRenamed: boolean;
  jsdocReferencesRenamed: boolean;
  operationRowAppended: boolean;
}

export interface T03Batch {
  modules: { path: string; moduleId: string }[];
}

export interface T03CriteriaInput {
  /** Result of the agent/programmatic commit: did commit return ok? */
  commitReturnedOk: boolean;
  /** Result of a post-commit re-validate on a throwaway tx: zero diagnostics? */
  validateAfterCommitClean: boolean;
  /** The tx id whose single operation row must be the RenameSymbol row. */
  renameTxId: string;
}

interface OperationRow {
  tx_id: string;
  kind: string;
  params_json: string;
  affected_node_ids_json: string;
}

/**
 * Pure post-commit scoring for T03. The caller drives the rename and the
 * post-commit re-validate (programmatic command or agent session); this
 * function only inspects the resulting store state. Both the `cli t03`
 * command and the Phase 3 agent acceptance test call this so neither path
 * can get a weaker check.
 */
export function evaluateT03Criteria(
  db: Db,
  batch: T03Batch,
  srcRoot: string,
  input: T03CriteriaInput
): T03Criteria {
  const renderedBySuffix = new Map<string, string>();
  for (const module of batch.modules) {
    renderedBySuffix.set(
      toPosix(path.relative(srcRoot, module.path)),
      renderModule(db, module.moduleId)
    );
  }

  const auditText = mustGet(renderedBySuffix, "server/audit.ts");
  const indexText = mustGet(renderedBySuffix, "index.ts");
  const greetText = mustGet(renderedBySuffix, "users/greet.ts");
  const legacyText = mustGet(renderedBySuffix, "users/legacy.ts");
  const listText = mustGet(renderedBySuffix, "users/list.ts");
  const serializerText = mustGet(renderedBySuffix, "users/serializer.ts");
  const repoText = mustGet(renderedBySuffix, "users/repo.ts");
  const userText = mustGet(renderedBySuffix, "types/user.ts");

  const remainingUserOccurrences = [...renderedBySuffix.values()]
    .flatMap((text) => text.match(/\bUser\b/g) ?? []).length;
  const auditUserOccurrences = (auditText.match(/\bUser\b/g) ?? []).length;
  const operations = db
    .prepare(
      `SELECT tx_id, kind, params_json, affected_node_ids_json FROM operations`
    )
    .all() as OperationRow[];

  return {
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    importRenamed:
      /import type \{\s*Account\s*\} from "\.\.\/types\/user\.ts";/.test(
        greetText
      ),
    typeAnnotationRenamed:
      /export function greet\(user: Account\): string/.test(greetText) &&
      /export interface Account\b/.test(userText) &&
      /save\(user: Account\): Promise<void>;/.test(repoText),
    genericPromiseRenamed:
      /Promise<Account\[\]>/.test(listText) &&
      !/Promise<User\[\]>/.test(listText),
    namespaceImportRenamed:
      /import type \* as UserTypes from "\.\.\/types\/user\.ts";/.test(
        serializerText
      ) && /user: UserTypes\.Account/.test(serializerText),
    auditLiteralUntouched:
      /"User"/.test(auditText) && /kind: "User"/.test(auditText),
    auditLiteralOnlyRemainingUser:
      remainingUserOccurrences === auditUserOccurrences &&
      auditUserOccurrences > 0,
    indexReExportRenamed:
      /export type \{\s*Account\s*\} from "\.\/types\/user\.ts";/.test(
        indexText
      ) &&
      !/export type \{\s*User\s*\} from "\.\/types\/user\.ts";/.test(indexText),
    jsdocReferencesRenamed:
      /@param \{Account\} user/.test(greetText) &&
      /@param \{Account\} u/.test(legacyText) &&
      !/@param \{User\}/.test(greetText) &&
      !/@param \{User\}/.test(legacyText),
    operationRowAppended: operationLogged(operations, input.renameTxId)
  };
}

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
}

function operationLogged(
  operations: OperationRow[],
  txId: string
): boolean {
  if (operations.length !== 1) return false;
  const operation = operations[0]!;
  if (operation.tx_id !== txId || operation.kind !== "RenameSymbol")
    return false;
  const params = JSON.parse(operation.params_json) as {
    old_name?: string;
    new_name?: string;
  };
  const affected = JSON.parse(operation.affected_node_ids_json) as unknown[];
  return (
    params.old_name === "User" &&
    params.new_name === "Account" &&
    affected.length > 1
  );
}

function mustGet(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing rendered module: ${key}`);
  return value;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
```

Rationale for the 4th `input` arg: the function stays pure (it does not re-drive commit or re-validate). The caller — programmatic `runT03` or the agent session — feeds in `commitReturnedOk` / `validateAfterCommitClean` / `renameTxId` from its own commit + post-commit re-validate. This is what lets the agent path score through the *identical* function rather than re-deriving commit success, while keeping the scorer side-effect-free. The Step 2 test already passes the 4th arg correctly.

- [ ] **Step 5: Rewire `runT03` to delegate scoring**

Modify `/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts`. Keep `RunT03Result` and `runT03`'s external behavior identical. Remove the inlined scoring block and the now-unused local helpers (`renderModule`, `operationLogged`, `emptyCriteria`, `mustGet`, `toPosix`) that moved into `t03Criteria.ts`; keep `collectTsFiles`, `elapsed`. Replace the criteria-building region with:

```ts
import { evaluateT03Criteria, type T03Criteria } from "./t03Criteria";
// ... existing imports retained ...

// inside runT03, replacing the inlined criteria block:
    const checkTx = begin(db, "t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx);

    const criteria = evaluateT03Criteria(db, batch, srcRoot, {
      commitReturnedOk: commitResult.ok === true,
      validateAfterCommitClean: postCommitDiagnostics.length === 0,
      renameTxId: tx.id
    });

    return { commitOk: true, wallTimeMs: elapsed(started), criteria };
```

For the early-return failure path (commit failed), keep returning `commitOk: false` with an all-false criteria object. Replace the old `emptyCriteria()` call with an exported helper from `t03Criteria.ts` — add to `t03Criteria.ts`:

```ts
export function emptyT03Criteria(): T03Criteria {
  return {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    importRenamed: false,
    typeAnnotationRenamed: false,
    genericPromiseRenamed: false,
    namespaceImportRenamed: false,
    auditLiteralUntouched: false,
    auditLiteralOnlyRemainingUser: false,
    indexReExportRenamed: false,
    jsdocReferencesRenamed: false,
    operationRowAppended: false
  };
}
```
and import it in `t03.ts` for the commit-failure branch. Re-export `RunT03Result["criteria"]`'s type alias from `T03Criteria` so callers stay source-compatible (`RunT03Result["criteria"]` is structurally identical to `T03Criteria`).

- [ ] **Step 6: Run the new test and the existing T03 test**

Run: `pnpm --filter @strata/cli test`
Expected: PASS — both `t03Criteria.test.ts` and the unchanged `t03.test.ts` pass (existing CLI behavior unchanged).

- [ ] **Step 7: Full build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: every package builds (`tsc -b`) and all tests pass. (Vitest does not typecheck — the build must be independently green.)

- [ ] **Step 8: Append decision D1 to `decisions.md`**

Add at the top of the newest-first list in `/Users/toddhebebrand/Strata/decisions.md` (below the `<!-- New entries -->` marker line):

```markdown
## 2026-05-15 — T03 scoring extracted to a shared pure `evaluateT03Criteria`

**Context:** Phase 3 needs the agent path and the programmatic `cli t03` path to score against identical logic so the agent cannot be given a weaker or vacuous check. The scoring block was inlined inside `runT03`.

**Considered:** (a) duplicate the regex/operation checks in the agent test; (b) extract the post-commit scoring into a shared pure function both paths import.

**Decided:** (b). `packages/cli/src/commands/t03Criteria.ts` exports `evaluateT03Criteria(db, batch, srcRoot, input)` and `emptyT03Criteria()`. `runT03` keeps driving the rename + post-commit re-validate itself and passes `commitReturnedOk`/`validateAfterCommitClean`/`renameTxId` in; the regex/operation-row scoring moved verbatim.

**Why:** A shared pure scorer makes "the agent passed T03" mean exactly what "the programmatic path passed T03" means. The 4th `input` arg keeps the function pure (it does not re-drive commit) while letting the agent path feed in its own commit outcome.

**Design-doc impact:** none — refactor only; `RunT03Result` shape unchanged, existing `t03.test.ts` unchanged and green.

**Revisit when:** T03 grows additional criteria, or a third caller (Phase 4 harness) needs the scorer.
```

- [ ] **Operator commit boundary**

Implementer: ensure `pnpm -r build && pnpm -r test` is green, then stop. Operator commits:
```
git add packages/cli/src/commands/t03Criteria.ts packages/cli/src/commands/t03.ts packages/cli/tests/t03Criteria.test.ts decisions.md
git commit -m "refactor(cli): extract shared evaluateT03Criteria scorer (Phase 3 D1)"
```

---

## Task 1: Scaffold `packages/agent`

Create the package skeleton mirroring existing packages. No logic yet — just a buildable, testable empty package on the workspace.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/package.json`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tsconfig.json`
- Create: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/scaffold.test.ts`

- [ ] **Step 1: Write `package.json`**

Create `/Users/toddhebebrand/Strata/packages/agent/package.json`:
```json
{
  "name": "@strata/agent",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.2.118",
    "@strata/ingest": "workspace:*",
    "@strata/store": "workspace:*",
    "@strata/verify": "workspace:*",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.15.29",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

(Rationale: `@anthropic-ai/claude-agent-sdk` and `zod` are root devDeps today for the BS4 smoke; Phase 3 promotes them into `@strata/agent`'s own `dependencies` because the package genuinely ships against them. `@strata/render` is intentionally NOT a direct dep — the agent only reaches `render` transitively via `@strata/verify`/`@strata/store`'s `renderWithSourceMap` re-export usage in `t03Criteria`; the acceptance test imports the scorer from `@strata/cli`'s source path, not by re-rendering itself. See Task 9.)

- [ ] **Step 2: OPERATOR — install dependencies (one time)**

This is the only `pnpm install`. Implementer must NOT run this. Operator runs from `/Users/toddhebebrand/Strata`:
```bash
pnpm install
```
Expected: `@strata/agent` linked into the workspace; `pnpm-lock.yaml` updated. (`zod`/`@anthropic-ai/claude-agent-sdk` already resolvable from the root; this just wires the new workspace package.) After this completes, the implementer continues at Step 3.

- [ ] **Step 3: Write `tsconfig.json`**

Create `/Users/toddhebebrand/Strata/packages/agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src"],
  "references": [
    { "path": "../ingest" },
    { "path": "../store" },
    { "path": "../verify" }
  ]
}
```

(Note: the spec flags that `packages/cli/tsconfig.json` lists `ingest`/`render`/`store` but not `verify` despite depending on it. `@strata/agent` lists `verify` so project-references builds are correct. `render` is not referenced because `@strata/agent` does not import `@strata/render` directly.)

- [ ] **Step 4: Write the placeholder barrel**

Create `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
/**
 * @strata/agent — the Claude Agent SDK session that drives the Strata
 * structural substrate. Phase 3: agent-drives-T03.
 *
 * Real exports (tools, prompt, log, runAgentT03) land in later tasks.
 */
export const AGENT_PACKAGE = "@strata/agent" as const;
```

- [ ] **Step 5: Write the scaffold test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/scaffold.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE } from "../src/index";

describe("@strata/agent scaffold", () => {
  it("exports the package marker", () => {
    expect(AGENT_PACKAGE).toBe("@strata/agent");
  });
});
```

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: `@strata/agent` builds via `tsc -b` (its `dist/` appears) and its scaffold test passes; all other packages stay green.

- [ ] **Operator commit boundary**

Implementer: ensure `pnpm -r build && pnpm -r test` green, then stop. Operator commits:
```
git add packages/agent/package.json packages/agent/tsconfig.json packages/agent/src/index.ts packages/agent/tests/scaffold.test.ts pnpm-lock.yaml
git commit -m "feat(agent): scaffold @strata/agent package"
```

---

## Task 2: Zod schema fragments for the tool surface

Define the reusable Zod raw-shape fragments (`TxHandle`, `NodeId`, `Diagnostic[]`) once, matching `sdkSmoke.ts`'s proven shapes, so all eight tools share them.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/src/tools.ts` (schema region only this task)
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/tools.test.ts` (schema assertions only this task)

- [ ] **Step 1: Write the failing schema test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/tools.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  diagnosticSchema,
  nodeIdSchema,
  txHandleSchema
} from "../src/tools";

describe("strata tool schema fragments", () => {
  it("txHandleSchema parses a valid handle", () => {
    const parsed = txHandleSchema.parse({ id: "tx-1", actor: "agent-t03" });
    expect(parsed).toEqual({ id: "tx-1", actor: "agent-t03" });
  });

  it("txHandleSchema rejects an empty id", () => {
    expect(() => txHandleSchema.parse({ id: "", actor: "a" })).toThrow();
  });

  it("nodeIdSchema rejects empty string", () => {
    expect(() => nodeIdSchema.parse("")).toThrow();
  });

  it("diagnosticSchema parses a diagnostic with null nodeId", () => {
    const d = diagnosticSchema.parse({
      nodeId: null,
      modulePath: null,
      message: "x",
      code: 2304
    });
    expect(d.code).toBe(2304);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: FAIL with "Cannot find module '../src/tools'".

- [ ] **Step 3: Implement the schema fragments**

Create `/Users/toddhebebrand/Strata/packages/agent/src/tools.ts` (schema region; tool definitions added in Task 4):
```ts
import { z } from "zod/v4";

/** A stable Strata graph node ID (sha1-derived, 16 hex). */
export const nodeIdSchema = z
  .string()
  .min(1)
  .describe("Stable Strata graph node ID.");

/**
 * The handle returned by begin_transaction. The agent must hold this and
 * pass it back to rename_symbol / validate / commit_transaction /
 * rollback_transaction. Shape mirrors @strata/store's TxHandle
 * ({ id, actor }) and packages/cli/src/commands/sdkSmoke.ts.
 */
export const txHandleSchema = z
  .object({
    id: z.string().min(1).describe("Open transaction ID."),
    actor: z.string().min(1).describe("Actor that opened the transaction.")
  })
  .describe("Strata transaction handle from begin_transaction.");

/** A verify diagnostic, mirroring @strata/verify's Diagnostic. */
export const diagnosticSchema = z.object({
  nodeId: nodeIdSchema.nullable(),
  modulePath: z.string().nullable(),
  message: z.string(),
  code: z.number().int()
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: PASS.

- [ ] **Step 5: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/tools.ts packages/agent/tests/tools.test.ts
git commit -m "feat(agent): zod schema fragments for tool surface"
```

---

## Task 3: Add `readNode` / `read_node` export to `@strata/store`

The `read_node` tool needs a public store helper. `@strata/store` exposes `findNodeById` + `listChildren` but not a combined "node plus optional shallow children" read. Add it in `store` so `agent` does not reach into store internals.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/store/src/read_node.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/store/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/store/tests/readNode.test.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write the failing test**

Create `/Users/toddhebebrand/Strata/packages/store/tests/readNode.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { insertNodes, openDb, read_node, readNode } from "../src/index";

describe("readNode", () => {
  it("returns the node alone when includeChildren is false/omitted", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "m", kind: "Module", parentId: null, childIndex: null, payload: "x.ts" },
      { id: "s1", kind: "InterfaceDeclaration", parentId: "m", childIndex: 0, payload: "export interface User {}" }
    ]);
    const result = readNode(db, "s1");
    expect(result?.node.id).toBe("s1");
    expect(result?.children).toBeUndefined();
    db.close();
  });

  it("returns shallow children when includeChildren is true", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "m", kind: "Module", parentId: null, childIndex: null, payload: "x.ts" },
      { id: "s1", kind: "InterfaceDeclaration", parentId: "m", childIndex: 0, payload: "export interface User {}" },
      { id: "i1", kind: "Identifier", parentId: "s1", childIndex: 0, payload: JSON.stringify({ text: "User", offset: 17 }) }
    ]);
    const result = readNode(db, "s1", { includeChildren: true });
    expect(result?.children?.map((c) => c.id)).toEqual(["i1"]);
    db.close();
  });

  it("returns undefined for an unknown id", () => {
    const db = openDb(":memory:");
    expect(readNode(db, "missing")).toBeUndefined();
    db.close();
  });

  it("exposes the same function under the snake_case name", () => {
    expect(read_node).toBe(readNode);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- readNode`
Expected: FAIL with "read_node is not exported" / module resolution error.

- [ ] **Step 3: Implement `read_node.ts`**

Create `/Users/toddhebebrand/Strata/packages/store/src/read_node.ts`:
```ts
import { findNodeById, listChildren, type NodeRow } from "./nodes";
import type { Db } from "./schema";

export interface ReadNodeOptions {
  /** When true, include the node's direct children (one level only). */
  includeChildren?: boolean;
}

export interface ReadNodeResult {
  node: NodeRow;
  /** Present only when includeChildren is true. */
  children?: NodeRow[];
}

/**
 * Read one node by ID, optionally with its direct (one-level) children.
 * Thin composition of findNodeById + listChildren so consumers (the Phase 3
 * agent's read_node tool) do not reach into store internals.
 */
export function readNode(
  db: Db,
  id: string,
  options: ReadNodeOptions = {}
): ReadNodeResult | undefined {
  const node = findNodeById(db, id);
  if (!node) return undefined;
  if (!options.includeChildren) return { node };
  return { node, children: listChildren(db, id) };
}

export const read_node = readNode;
```

- [ ] **Step 4: Re-export from the store barrel**

Add to `/Users/toddhebebrand/Strata/packages/store/src/index.ts` (a new export line, e.g. after the `findNodeById` block):
```ts
export {
  readNode,
  read_node,
  type ReadNodeOptions,
  type ReadNodeResult
} from "./read_node";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- readNode`
Expected: PASS.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green (store rebuilds; downstream packages still resolve).

- [ ] **Step 7: Append decision D2 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — `read_node` added to @strata/store for the Phase 3 agent

**Context:** Phase 3's `read_node` tool needs "a node plus optional shallow children". `@strata/store` exposed `findNodeById` and `listChildren` separately; the agent must not reach into store internals.

**Considered:** (a) compose `findNodeById`+`listChildren` inside `packages/agent`; (b) add a public `readNode`/`read_node` to `@strata/store`.

**Decided:** (b). `packages/store/src/read_node.ts` exports `readNode(db, id, { includeChildren? })` (alias `read_node`) returning `{ node, children? }`.

**Why:** Keeps the dependency edge clean (`agent → store` public surface only) and matches the spec's note that this helper belongs in `store`, not in `agent`. Minimal: one level of children, no recursion (Open Question 1 — widen only if agent behavior shows it's needed).

**Design-doc impact:** none — additive public API on an existing package.

**Revisit when:** the agent's transcript shows it repeatedly needs deeper traversal than one child level (then it becomes a logged tool-widening decision per Open Question 1).
```

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/store/src/read_node.ts packages/store/src/index.ts packages/store/tests/readNode.test.ts decisions.md
git commit -m "feat(store): readNode helper for Phase 3 agent (D2)"
```

---

## Task 4: The eight Strata tool definitions over a shared context

Define all eight `tool(...)` definitions over one shared `{ db, actor }` session context, plus `createStrataToolServer`. Unit-test the handlers **directly, with no model and no API key** — this exercises the whole substrate spine through the tool layer and is the cheap early probe for BS-B (tool schema/loop shape) and BS-A (the spine *is* tool-drivable without a model).

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/tools.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/tests/tools.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`

- [ ] **Step 1: Write the failing handler-threading test**

Append to `/Users/toddhebebrand/Strata/packages/agent/tests/tools.test.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences, openDb } from "@strata/store";
import { createStrataTools, type StrataSessionContext } from "../src/tools";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

function parseText(result: { content: { type: string; text?: string }[] }) {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined)
    throw new Error("expected a single text content block");
  return JSON.parse(block.text);
}

describe("strata tools drive the spine through the shared context", () => {
  it("explore -> begin -> rename -> validate -> commit threads a TxHandle", async () => {
    const srcRoot = path.resolve(
      __dirname,
      "../../../examples/medium/src"
    );
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const ctx: StrataSessionContext = { db, actor: "tools-test" };
    const tools = createStrataTools(ctx);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const decls = parseText(
      await byName.get("find_declarations")!.handler(
        { name: "User", kind: "interface" },
        {}
      )
    );
    expect(decls.length).toBe(1);
    const declId: string = decls[0].id;

    const tx = parseText(
      await byName.get("begin_transaction")!.handler({}, {})
    );
    expect(typeof tx.id).toBe("string");

    const renameResult = parseText(
      await byName.get("rename_symbol")!.handler(
        { tx, declaration_id: declId, new_name: "Account" },
        {}
      )
    );
    expect(renameResult.ok).toBe(true);

    const diags = parseText(
      await byName.get("validate")!.handler({ tx }, {})
    );
    expect(Array.isArray(diags)).toBe(true);
    expect(diags.length).toBe(0);

    const commitResult = parseText(
      await byName.get("commit_transaction")!.handler({ tx }, {})
    );
    expect(commitResult.ok).toBe(true);

    db.close();
  });

  it("exposes exactly the eight tool names", () => {
    const db = openDb(":memory:");
    const tools = createStrataTools({ db, actor: "x" });
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "begin_transaction",
        "commit_transaction",
        "find_declarations",
        "get_references",
        "read_node",
        "rename_symbol",
        "rollback_transaction",
        "validate"
      ].sort()
    );
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: FAIL with "createStrataTools is not exported".

- [ ] **Step 3: Implement the eight tool definitions + server factory**

Append to `/Users/toddhebebrand/Strata/packages/agent/src/tools.ts`:
```ts
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import { ingestBatch } from "@strata/ingest"; // unused here; kept out — remove if linter flags
import {
  begin,
  find_declarations,
  get_references,
  read_node,
  rename_symbol,
  rollback,
  type Db,
  type DeclarationKind,
  type TxHandle
} from "@strata/store";
import { commit, validate } from "@strata/verify";

export interface StrataSessionContext {
  db: Db;
  actor: string;
}

/**
 * JSON-stringify a structured result into a single text content block.
 * The `type: "text" as const` is load-bearing: it matches the proven
 * `packages/cli/src/commands/sdkSmoke.ts` pattern that already compiles
 * against the SDK's `CallToolResult` handler return type. Without
 * `as const`, `type` widens to `string` and `tsc -b` rejects the handler.
 */
function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

const declarationKindSchema = z
  .enum(["interface", "type-alias", "class", "function", "variable"])
  .describe("Declaration kind to filter by.");

/**
 * Build the eight Strata tools bound to one shared session context. Every
 * handler closes over `ctx`, so a TxHandle returned by begin_transaction is
 * usable by later rename_symbol/validate/commit_transaction calls.
 */
export function createStrataTools(
  ctx: StrataSessionContext
): SdkMcpToolDefinition<any>[] {
  const findDeclarationsTool = tool(
    "find_declarations",
    "Find declaration nodes (interfaces, type aliases, classes, functions, variables) by name and/or kind. Read-only, no side effects. This is your entry point: locate the declaration you intend to operate on. Returns an array of { id, kind, payload } — the `id` is the stable node ID you pass to rename_symbol.",
    {
      name: z.string().optional().describe("Declaration name to match."),
      kind: declarationKindSchema.optional()
    },
    async (args: { name?: string; kind?: DeclarationKind }) =>
      textResult(
        find_declarations(ctx.db, { name: args.name, kind: args.kind }).map(
          (n) => ({ id: n.id, kind: n.kind, payload: n.payload })
        )
      )
  );

  const getReferencesTool = tool(
    "get_references",
    "List every reference edge pointing at a declaration node. Read-only. Use this to inspect the full reference set before mutating — references include type positions, JSDoc type tags, namespace-qualified uses, and re-exports. A string literal that merely spells the same word is NOT a reference and will not appear here.",
    { declaration_id: nodeIdSchema },
    async (args: { declaration_id: string }) =>
      textResult(get_references(ctx.db, args.declaration_id))
  );

  const readNodeTool = tool(
    "read_node",
    "Read one node by ID, optionally with its direct (one level) children. Read-only. Use it to inspect a declaration or reference before acting. Do not guess node IDs — obtain them from find_declarations or get_references.",
    {
      node_id: nodeIdSchema,
      include_children: z
        .boolean()
        .optional()
        .describe("Include the node's direct children (one level).")
    },
    async (args: { node_id: string; include_children?: boolean }) =>
      textResult(
        read_node(ctx.db, args.node_id, {
          includeChildren: args.include_children
        }) ?? null
      )
  );

  const beginTransactionTool = tool(
    "begin_transaction",
    "Open a transaction. Mutations require an open transaction. Returns a transaction handle { id, actor } — you MUST hold it and pass it to rename_symbol, validate, commit_transaction, and rollback_transaction. Never leave a transaction open: commit it or roll it back.",
    {},
    async () => textResult(begin(ctx.db, ctx.actor))
  );

  const renameSymbolTool = tool(
    "rename_symbol",
    "Rename a declaration and every reference to it (type positions, JSDoc type tags, namespace-qualified uses, type-only re-exports) in one structural operation. Requires an open transaction. Mutates the transaction overlay only — nothing is final until commit_transaction. Unrelated string literals are not references and are never touched.",
    {
      tx: txHandleSchema,
      declaration_id: nodeIdSchema,
      new_name: z.string().min(1).describe("The new identifier name.")
    },
    async (args: {
      tx: TxHandle;
      declaration_id: string;
      new_name: string;
    }) => {
      rename_symbol(ctx.db, args.tx, args.declaration_id, args.new_name);
      return textResult({ ok: true });
    }
  );

  const validateTool = tool(
    "validate",
    "Type-check the transaction's pending state and return diagnostics (each with the node ID it maps to). Returns [] when clean. Call this after a mutation and before commit_transaction. If diagnostics are returned, do NOT commit — inspect them, mutate further, or rollback_transaction and reassess.",
    { tx: txHandleSchema },
    async (args: { tx: TxHandle }) =>
      textResult(validate(ctx.db, args.tx))
  );

  const commitTransactionTool = tool(
    "commit_transaction",
    "Validate and finalize the transaction. Runs validation itself; if there are diagnostics it refuses to finalize and returns { ok: false, diagnostics }. On a clean validate it finalizes and returns { ok: true }. After this the transaction is closed.",
    { tx: txHandleSchema },
    async (args: { tx: TxHandle }) =>
      textResult(commit(ctx.db, args.tx))
  );

  const rollbackTransactionTool = tool(
    "rollback_transaction",
    "Discard all pending changes in the transaction and close it. Use this to recover from a failed validate before trying a different approach. After this the transaction handle is dead.",
    { tx: txHandleSchema },
    async (args: { tx: TxHandle }) => {
      rollback(ctx.db, args.tx);
      return textResult({ ok: true });
    }
  );

  return [
    findDeclarationsTool,
    getReferencesTool,
    readNodeTool,
    beginTransactionTool,
    renameSymbolTool,
    validateTool,
    commitTransactionTool,
    rollbackTransactionTool
  ];
}

export const STRATA_TOOL_NAMES = [
  "find_declarations",
  "get_references",
  "read_node",
  "begin_transaction",
  "rename_symbol",
  "validate",
  "commit_transaction",
  "rollback_transaction"
] as const;

/** The MCP server name. Tools are addressed as mcp__strata__<name>. */
export const STRATA_SERVER_NAME = "strata" as const;

/** Fully-qualified tool names as the model sees them. */
export const STRATA_QUALIFIED_TOOL_NAMES = STRATA_TOOL_NAMES.map(
  (n) => `mcp__${STRATA_SERVER_NAME}__${n}`
);

export function createStrataToolServer(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools: createStrataTools(ctx)
  });
}
```

Remove the stray `import { ingestBatch } from "@strata/ingest";` line — it is unused in `tools.ts` and `tsc -b` with `strict` will not error on an unused import, but keep the file clean: delete that import. (It is listed above only to flag that the test file, not `tools.ts`, uses `ingestBatch`.)

- [ ] **Step 4: Re-export from the agent barrel**

Replace `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
export const AGENT_PACKAGE = "@strata/agent" as const;
export {
  createStrataTools,
  createStrataToolServer,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  STRATA_TOOL_NAMES,
  type StrataSessionContext
} from "./tools";
```

- [ ] **Step 5: Run the handler tests (no model, no key)**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: PASS — the explore→begin→rename→validate→commit chain threads the `TxHandle` through the shared context and all assertions hold; eight tool names present.

**Bail-signal note (BS-B, cheap probe):** If the handlers cannot thread a `TxHandle` across calls through the shared `ctx` (e.g. `begin`/`rename_symbol`/`commit` don't compose because the overlay isn't keyed consistently, or the SDK's `tool(...)` typing rejects these Zod raw shapes), that is an early BS-B signal at the *tool layer* (BS4 only cleared the schema, not the loop). Surface it here rather than discovering it inside a live session in Task 10.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green. (`@strata/agent` `tsc -b` must compile the SDK `tool(...)` generic calls; a vitest pass alone is not done.)

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/tools.ts packages/agent/src/index.ts packages/agent/tests/tools.test.ts
git commit -m "feat(agent): eight Strata SDK tools over shared session context"
```

---

## Task 5: Minimal one-tool headless SDK session (BS-B probe)

Before building the full orchestrator, prove the SDK runs headless with **only** a custom in-process tool and `tools: []`, that built-ins do not leak into the `init` tool list, and that a single-yield async-generator prompt works. This is the explicit BS-B probe.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/sessionSmoke.test.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/src/session.ts` (probe helper this task; full orchestrator in Task 8)
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write the probe helper**

Create `/Users/toddhebebrand/Strata/packages/agent/src/session.ts`:
```ts
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";

/** A single-yield async generator carrying one user prompt. */
export async function* singlePrompt(
  text: string
): AsyncGenerator<SDKUserMessage, void> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text }
  } as SDKUserMessage;
}

export interface CollectedSession {
  /** The SDKSystemMessage.init tools list, if an init message was seen. */
  initTools?: string[];
  initMcpServers?: { name: string; status: string }[];
  /** Every message, in order, for assertions/replay. */
  messages: SDKMessage[];
}

/**
 * Drive a query() to completion, collecting messages and the init tool
 * list. Bounded by the caller's options (maxTurns / abortController).
 */
export async function collectSession(params: {
  prompt: string;
  options: Options;
}): Promise<CollectedSession> {
  const collected: CollectedSession = { messages: [] };
  for await (const message of query({
    prompt: singlePrompt(params.prompt),
    options: params.options
  })) {
    collected.messages.push(message);
    if (message.type === "system" && message.subtype === "init") {
      collected.initTools = message.tools;
      collected.initMcpServers = message.mcp_servers;
    }
  }
  return collected;
}
```

- [ ] **Step 2: Write the key-gated BS-B probe test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/sessionSmoke.test.ts`:
```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import { collectSession } from "../src/session";

const hasAuth =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

describe.skipIf(!hasAuth)("BS-B: headless one-tool SDK session", () => {
  it(
    "runs with tools:[] and only the custom tool appears in init",
    async () => {
      let pingCalled = false;
      const pingTool = tool(
        "ping",
        "Return pong. Call this exactly once, then stop.",
        {},
        async () => {
          pingCalled = true;
          return { content: [{ type: "text" as const, text: "pong" }] };
        }
      );
      const server = createSdkMcpServer({
        name: "probe",
        version: "0.0.0",
        tools: [pingTool]
      });

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 60_000);
      try {
        const session = await collectSession({
          prompt:
            "Call the ping tool exactly once and then stop. Do not do anything else.",
          options: {
            mcpServers: { probe: server },
            allowedTools: ["mcp__probe__ping"],
            tools: [],
            disallowedTools: [
              "Read",
              "Write",
              "Edit",
              "Bash",
              "Glob",
              "Grep",
              "WebFetch",
              "WebSearch"
            ],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 6,
            model: "claude-sonnet-4-6",
            abortController
          }
        });

        expect(session.initTools).toBeDefined();
        // No built-in file/bash tools leaked in.
        for (const banned of ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]) {
          expect(session.initTools).not.toContain(banned);
        }
        // The custom tool is present and usable.
        expect(session.initTools).toContain("mcp__probe__ping");
        expect(pingCalled).toBe(true);
        const result = session.messages.find((m) => m.type === "result");
        expect(result).toBeDefined();
      } finally {
        clearTimeout(timer);
        abortController.abort();
      }
    },
    90_000
  );
});
```

- [ ] **Step 3: Run the probe (key-free path first)**

Run: `pnpm --filter @strata/agent test -- sessionSmoke`
Expected (no key): the suite is **skipped** (`describe.skipIf`), reported as skipped not failed.

- [ ] **Step 4: OPERATOR-or-key-holder — run the probe with auth**

If `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) is available, run:
```bash
ANTHROPIC_API_KEY=… pnpm --filter @strata/agent test -- sessionSmoke
```
Expected: PASS — `init` tool list contains `mcp__probe__ping`, contains no `Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`, the tool fired, and a `result` message arrived.

**Bail-signal note (BS-B):** If `tools: []` is not honored (built-ins appear in `initTools`), or the in-process MCP tool is never invoked, or the single-yield async generator prompt is rejected/ignored, **STOP and surface BS-B**. Do not work around by shelling out, faking the loop, or relaxing `tools: []`. Per the spec's installed-types-vs-docs resolution, the single-yield async generator is the documented-safe prompt form; if the runtime *also* accepts a plain string, note it but keep the generator. Log the finding in Step 5.

- [ ] **Step 5: Append decision D3 to `decisions.md`**

If the probe passed (or was deferred because no key is available, in which case state that and that BS-B is provisionally cleared at the schema/loop-shape level by Task 4's handler test), add at the top of the newest-first list:
```markdown
## 2026-05-15 — Phase 3 SDK session integration cleared BS-B (one-tool headless probe)

**Context:** Phase 3 BS-B asks whether the SDK runs headless with only custom in-process tools and `tools: []`, and whether tool results compose with our transaction model. Task 4 cleared the loop at the handler layer (no model); this entry records the live session probe.

**Considered:** trust BS4 (schema-only) and build the full orchestrator directly; or probe a minimal one-tool session first.

**Decided:** probe-first. `packages/agent/tests/sessionSmoke.test.ts` runs a one-tool (`ping`) headless `query(...)` with `tools: []`, `allowedTools: ["mcp__probe__ping"]`, `bypassPermissions` + `allowDangerouslySkipPermissions`, single-yield async-generator prompt, `maxTurns`, `abortController`. <RESULT: "Passed — initTools contained mcp__probe__ping and no built-in file/bash tools; ping fired." OR "Deferred — no API key in this environment; BS-B cleared at the handler/loop-shape level by Task 4; live confirmation pending an operator run." OR "BS-B FIRED — <observed failure>; stopped per spec.">

**Why:** The session/loop is the part BS4 did not exercise. Probing one tool isolates "the SDK headless loop composes" from "our eight tools / system prompt are right" before the full orchestrator.

**Design-doc impact:** none — confirms the planned Phase 3 SDK direction.

**Revisit when:** an SDK upgrade changes `query`/`Options.tools`/MCP server handling, or the full Task 10 session reveals loop behavior the one-tool probe didn't.
```

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green; `sessionSmoke` skipped without a key.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/session.ts packages/agent/tests/sessionSmoke.test.ts decisions.md
git commit -m "feat(agent): one-tool headless SDK session probe (BS-B, D3)"
```

---

## Task 6: System prompt

Write the static worldview system prompt to the spec's § "System prompt outline" contract — 2000–4000 tokens, cacheable, **no T03 identifiers, no scripted tool sequence**.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/src/prompt.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/prompt.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`

- [ ] **Step 1: Write the failing prompt-contract test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { STRATA_SYSTEM_PROMPT } from "../src/prompt";

describe("STRATA_SYSTEM_PROMPT", () => {
  it("is a single static non-empty string", () => {
    expect(typeof STRATA_SYSTEM_PROMPT).toBe("string");
    expect(STRATA_SYSTEM_PROMPT.length).toBeGreaterThan(800);
  });

  it("is roughly 2000-4000 tokens (~4 chars/token heuristic)", () => {
    const approxTokens = STRATA_SYSTEM_PROMPT.length / 4;
    expect(approxTokens).toBeGreaterThan(1500);
    expect(approxTokens).toBeLessThan(5000);
  });

  it("covers the load-bearing worldview sections", () => {
    const p = STRATA_SYSTEM_PROMPT;
    expect(p).toMatch(/no filesystem|no files|not as files/i);
    expect(p).toMatch(/string literal/i);
    expect(p).toMatch(/transaction/i);
    expect(p).toMatch(/validate/i);
    expect(p).toMatch(/rollback/i);
    expect(p).toMatch(/explore/i);
    // names all eight tools
    for (const name of [
      "find_declarations",
      "get_references",
      "read_node",
      "begin_transaction",
      "rename_symbol",
      "validate",
      "commit_transaction",
      "rollback_transaction"
    ]) {
      expect(p).toContain(name);
    }
  });

  it("does NOT contain T03-specific identifiers or a scripted recipe", () => {
    const p = STRATA_SYSTEM_PROMPT;
    expect(p).not.toMatch(/\bUser\b/);
    expect(p).not.toMatch(/\bAccount\b/);
    expect(p).not.toMatch(/audit/i);
    // no "call X then call Y then call Z" hard script
    expect(p).not.toMatch(
      /call .*find_declarations.* then .* begin_transaction .* then .* rename_symbol/i
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- prompt`
Expected: FAIL with "Cannot find module '../src/prompt'".

- [ ] **Step 3: Implement `prompt.ts`**

Create `/Users/toddhebebrand/Strata/packages/agent/src/prompt.ts`. The eight section headings follow the spec § "System prompt outline" exactly. The text below is the initial draft to the contract; it is allowed to be iterated *as a worldview* during Task 10 (BS-A) but never degraded into a script:

```ts
/**
 * Static Strata worldview system prompt. Single string => prompt-cacheable
 * as-is. Contract: spec § "System prompt outline". No T03 identifiers, no
 * scripted tool sequence, no embedded acceptance criteria. Iterated during
 * implementation only as a worldview (BS-A), never as a recipe.
 */
export const STRATA_SYSTEM_PROMPT = `You operate on a TypeScript codebase that is represented as a graph of nodes, not as files. There is no filesystem. You cannot open, read, write, list, or grep files, and you have no shell. Every code element — declarations, references, statements, identifiers — is a node with a stable ID. You act only through the Strata tools described below. If you find yourself wanting to read a file or run a command, stop: that capability does not exist here. Work through the graph.

## The graph model

Each node has an ID, a kind, and a payload. Declarations (interfaces, type aliases, classes, functions, variables) own identifier children. A reference is an edge from a use-site to the declaration it resolves to. References include type-annotation positions, generic positions, JSDoc type tags, namespace-qualified uses, and type-only re-exports — the type system resolves all of these, so the graph knows about all of them.

Critically: a string literal whose text happens to spell the same word as a declaration is NOT a reference. It has no edge to the declaration and is never a candidate for a rename or any other reference-aware operation. The graph encodes meaning, not text. This is the central difference from text search: you never reason about character matches, only about resolved references.

## The transaction model

Mutations require an open transaction. The lifecycle is strictly: open a transaction, explore as needed, mutate, validate, then commit or roll back. A transaction must always be closed — either committed or rolled back. Never leave one open and never start a second while one is open. The commit step runs validation itself and refuses to finalize while there are diagnostics.

## Explore before you mutate

The query tools — find_declarations, get_references, read_node — are cheap and have no side effects. The mutation is a commitment. Before you change anything, locate the exact declaration you intend to operate on and inspect its references so you understand the scope of the change. Never guess a node ID; always obtain IDs from a query tool's output. Confirm you are operating on the right declaration before opening a transaction.

## Verify before you commit

After a mutation, call validate. It returns a list of diagnostics, each carrying the node ID it maps to; an empty list means the pending state type-checks. If validate returns diagnostics, do NOT commit. Read the diagnostics, decide whether a further mutation fixes them or whether the approach was wrong, and in the latter case roll the transaction back and reassess. Only commit after a clean validate.

## The tool surface

- find_declarations — locate declaration nodes by name and/or kind. Read-only. Your usual starting point.
- get_references — list every reference edge to a declaration. Read-only. Use it to understand scope before mutating.
- read_node — read one node (optionally its direct children). Read-only. Use it to inspect something a query returned.
- begin_transaction — open a transaction and get a handle. You must keep this handle and pass it to every subsequent mutation, validate, commit, and rollback call.
- rename_symbol — rename a declaration and all its references in one structural operation. Requires the transaction handle.
- validate — type-check the transaction's pending state; returns diagnostics or an empty list. Requires the transaction handle.
- commit_transaction — validate and finalize the transaction. Requires the transaction handle.
- rollback_transaction — discard the transaction's pending changes and close it. Requires the transaction handle.

The ordering dependency is real: you cannot mutate, validate, or commit without a transaction handle from begin_transaction, and you obtain the declaration ID you mutate from find_declarations (or get_references / read_node).

## A worked pattern

To rename a declaration: find the declaration so you have its node ID, look at its references so you understand what will change, open a transaction, perform the rename, validate the pending state, and — only if validation is clean — commit. If validation reports problems, roll back and reconsider rather than committing a broken state. This is a pattern for thinking about reference-aware changes, not a fixed recipe to replay blindly; adapt it to whatever the task in front of you actually asks for.

## Failure discipline

If validation keeps failing, prefer rolling back and reassessing over repeatedly poking at a broken transaction. Never fabricate a result or claim success you cannot demonstrate through the tools. If the task genuinely cannot be done with the tools you have, say so plainly and explain why — do not invent a filesystem, a shell, or a capability that is not here.`;
```

If the approximate-token assertion in Step 1 fails (too short/long), adjust prose length to land in range — do not delete a section to shrink, and do not add T03 specifics to lengthen.

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
export { STRATA_SYSTEM_PROMPT } from "./prompt";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/agent test -- prompt`
Expected: PASS — all contract assertions hold; no T03 identifiers; no scripted sequence.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/prompt.ts packages/agent/src/index.ts packages/agent/tests/prompt.test.ts
git commit -m "feat(agent): static Strata worldview system prompt"
```

---

## Task 7: Session log (JSON-lines)

Implement the session-log event types and an in-memory + file writer to the spec's § "Session logging format". Pure, model-free, fully unit-testable.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/src/log.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/log.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`

- [ ] **Step 1: Write the failing log test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/log.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionLog } from "../src/log";

describe("SessionLog", () => {
  it("collects events in memory and serializes one JSON object per line", () => {
    const log = new SessionLog();
    log.append({
      type: "session_start",
      ts: 1,
      model: "m",
      maxTurns: 25,
      task: "T03",
      actor: "agent-t03"
    });
    log.append({
      type: "tool_call",
      ts: 2,
      tool: "rename_symbol",
      args: { new_name: "X" },
      result_summary: "ok",
      ok: true,
      error: null,
      durationMs: 4,
      turn: 1
    });
    expect(log.events.length).toBe(2);
    const lines = log.toJsonl().trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).type).toBe("session_start");
    expect(JSON.parse(lines[1]!).tool).toBe("rename_symbol");
  });

  it("flushes to a file path when one is given", () => {
    const file = path.join(tmpdir(), `strata-log-${Date.now()}.jsonl`);
    const log = new SessionLog(file);
    log.append({ type: "session_start", ts: 1, model: "m", maxTurns: 1, task: "T03", actor: "a" });
    log.flush();
    const onDisk = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(onDisk[0]!).type).toBe("session_start");
  });

  it("summarizes a long tool result without storing the full text", () => {
    const log = new SessionLog();
    const long = "x".repeat(5000);
    const summary = log.summarizeResult(long);
    expect(summary.length).toBeLessThan(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- log`
Expected: FAIL with "Cannot find module '../src/log'".

- [ ] **Step 3: Implement `log.ts`**

Create `/Users/toddhebebrand/Strata/packages/agent/src/log.ts`:
```ts
import { appendFileSync, writeFileSync } from "node:fs";

export interface SessionStartEvent {
  type: "session_start";
  ts: number;
  model: string;
  maxTurns: number;
  task: "T03";
  actor: string;
}

export interface InitEvent {
  type: "init";
  ts: number;
  tools: string[];
  mcpServers: { name: string; status: string }[];
}

export interface ToolCallEvent {
  type: "tool_call";
  ts: number;
  tool: string;
  args: unknown;
  result_summary: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  turn: number;
}

export interface AssistantTextEvent {
  type: "assistant_text";
  ts: number;
  turn: number;
  text: string;
}

export interface ResultEvent {
  type: "result";
  ts: number;
  subtype: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  modelUsage: Record<string, unknown>;
  errors: string[];
}

export type SessionLogEvent =
  | SessionStartEvent
  | InitEvent
  | ToolCallEvent
  | AssistantTextEvent
  | ResultEvent;

const MAX_SUMMARY = 240;

export class SessionLog {
  readonly events: SessionLogEvent[] = [];

  constructor(private readonly filePath?: string) {
    if (filePath) writeFileSync(filePath, "");
  }

  append(event: SessionLogEvent): void {
    this.events.push(event);
    if (this.filePath) {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    }
  }

  /** Bounded stringification of a tool handler return, never the full text. */
  summarizeResult(value: unknown): string {
    let s: string;
    try {
      s = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      s = String(value);
    }
    return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY) + "…" : s;
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  /** Rewrite the whole file from memory (used when no incremental path). */
  flush(): void {
    if (this.filePath) writeFileSync(this.filePath, this.toJsonl());
  }
}
```

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
export {
  SessionLog,
  type SessionLogEvent,
  type ToolCallEvent,
  type ResultEvent,
  type InitEvent
} from "./log";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/agent test -- log`
Expected: PASS.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/log.ts packages/agent/src/index.ts packages/agent/tests/log.test.ts
git commit -m "feat(agent): JSON-lines session log"
```

---

## Task 8: `runAgentT03` orchestrator with live + replay message sources

Build the full orchestrator: ingest exactly as `t03.ts`, build the tool server + prompt, run `query(...)` with the locked options OR replay a recorded transcript, pair `tool_use`/`tool_use_result`, capture the `SDKResultMessage`, assert the runtime invariant guard, and return the db + parsed transcript + metrics so the acceptance test scores via `evaluateT03Criteria`.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/session.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`

- [ ] **Step 1: Write the failing replay-shape test (synthetic transcript, no model)**

This proves the replay path drives the *real tool handlers* from a transcript and yields a real store mutation — the determinism mechanism, validated without a key. Create `/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  find_declarations,
  insertNodes,
  insertReferences,
  openDb
} from "@strata/store";
import { describe, expect, it } from "vitest";
import { runAgentT03 } from "../src/session";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

/**
 * Build a synthetic transcript: the canonical T03 tool-call sequence,
 * expressed as the replay event shape runAgentT03 consumes. The declaration
 * ID is resolved from a throwaway ingest so the transcript is self-consistent
 * with the corpus the run will re-ingest.
 */
function syntheticTranscript(declId: string) {
  // The replay format: an ordered list of { tool, args } the orchestrator
  // re-executes against freshly-built handlers. Tx handle args use a
  // placeholder the orchestrator substitutes with the live begin result.
  return [
    { tool: "find_declarations", args: { name: "User", kind: "interface" } },
    { tool: "begin_transaction", args: {} },
    {
      tool: "rename_symbol",
      args: { tx: "$TX", declaration_id: declId, new_name: "Account" }
    },
    { tool: "validate", args: { tx: "$TX" } },
    { tool: "commit_transaction", args: { tx: "$TX" } }
  ];
}

describe("runAgentT03 replay mode (no model, no key)", () => {
  it("replays a synthetic transcript through real handlers and mutates the store", async () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    // Resolve the declaration ID deterministically from the same corpus.
    const probeDb = openDb(":memory:");
    const batch = ingestBatch(
      collect(path.join(corpusRoot, "src"))
    );
    insertNodes(probeDb, batch.allNodes);
    insertReferences(probeDb, batch.references);
    const declId = find_declarations(probeDb, {
      name: "User",
      kind: "interface"
    })[0]!.id;
    probeDb.close();

    const result = await runAgentT03({
      corpusRoot,
      model: "replay",
      maxTurns: 25,
      wallTimeMs: 60_000,
      replayTranscript: syntheticTranscript(declId)
    });

    expect(result.criteria).toBeDefined();
    for (const [key, value] of Object.entries(result.criteria)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
    expect(result.terminalReason).toBe("replay_complete");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- replay`
Expected: FAIL with "runAgentT03 is not exported".

- [ ] **Step 3: Implement `runAgentT03` (live + replay)**

Append to `/Users/toddhebebrand/Strata/packages/agent/src/session.ts`. The replay format is deliberately a list of `{ tool, args }` steps with a `"$TX"` placeholder that the orchestrator substitutes with the live `begin_transaction` handle — so replay drives the *real handlers* and the store outcome is a pure function of the tool-call sequence (the spec's determinism mechanism). The live path captures the model's tool-call sequence into that exact format so a recorded run is replayable.

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  insertNodes,
  insertReferences,
  openDb,
  rollback,
  type Db,
  type TxHandle
} from "@strata/store";
import { validate } from "@strata/verify";
import {
  evaluateT03Criteria,
  emptyT03Criteria,
  type T03Criteria
} from "@strata/cli/dist/commands/t03Criteria";
import { createStrataTools, type StrataSessionContext } from "./tools";
import { STRATA_SYSTEM_PROMPT } from "./prompt";
import {
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  createStrataToolServer
} from "./tools";
import { SessionLog } from "./log";

export interface ReplayStep {
  tool: string;
  args: unknown;
}

export interface RunAgentT03Params {
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  /** When set, drive handlers from this transcript instead of the model. */
  replayTranscript?: ReplayStep[];
  /** Optional JSON-lines log file path. */
  logPath?: string;
}

export type TerminalReason =
  | "success"
  | "replay_complete"
  | "error_max_turns"
  | "error_wall_time"
  | "error_during_execution"
  | "error_other";

export interface AgentT03Result {
  criteria: T03Criteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  /** The captured tool-call sequence, replayable as a fixture. */
  transcript: ReplayStep[];
}

const BANNED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit"
];

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

/** Substitute the "$TX" placeholder in replay args with the live handle. */
function substituteTx(args: unknown, tx: TxHandle | undefined): unknown {
  if (args === "$TX") return tx;
  if (Array.isArray(args)) return args.map((a) => substituteTx(a, tx));
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = substituteTx(v, tx);
    }
    return out;
  }
  return args;
}

export async function runAgentT03(
  params: RunAgentT03Params
): Promise<AgentT03Result> {
  const srcRoot = path.join(params.corpusRoot, "src");
  const batch = ingestBatch(collectTsFiles(srcRoot));
  const db = openDb(":memory:");
  const log = new SessionLog(params.logPath);
  const transcript: ReplayStep[] = [];
  let terminalReason: TerminalReason = "error_other";

  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const ctx: StrataSessionContext = { db, actor: "agent-t03" };
    const tools = createStrataTools(ctx);
    const byName = new Map(tools.map((t) => [t.name, t]));

    log.append({
      type: "session_start",
      ts: Date.now(),
      model: params.model,
      maxTurns: params.maxTurns,
      task: "T03",
      actor: "agent-t03"
    });

    // Track the live TxHandle for replay-placeholder substitution and for
    // the operation-row criterion.
    let liveTx: TxHandle | undefined;
    let lastCommitOk = false;

    async function runStep(
      tool: string,
      rawArgs: unknown,
      turn: number
    ): Promise<unknown> {
      const def = byName.get(tool);
      if (!def) throw new Error(`Unknown Strata tool: ${tool}`);
      const args = substituteTx(rawArgs, liveTx);
      const started = Date.now();
      let parsed: unknown;
      let ok = true;
      let error: string | null = null;
      try {
        const res = await def.handler(args as never, {});
        const block = res.content[0];
        parsed =
          block && block.type === "text"
            ? JSON.parse(block.text)
            : null;
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
        parsed = null;
      }
      if (tool === "begin_transaction" && parsed && ok) {
        liveTx = parsed as TxHandle;
      }
      if (tool === "commit_transaction" && ok) {
        lastCommitOk =
          !!parsed && (parsed as { ok?: boolean }).ok === true;
      }
      log.append({
        type: "tool_call",
        ts: Date.now(),
        tool,
        args: rawArgs,
        result_summary: log.summarizeResult(parsed),
        ok,
        error,
        durationMs: Date.now() - started,
        turn
      });
      transcript.push({ tool, args: rawArgs });
      return parsed;
    }

    if (params.replayTranscript) {
      // Deterministic replay: re-execute the recorded sequence.
      let turn = 0;
      for (const step of params.replayTranscript) {
        await runStep(step.tool, step.args, turn++);
      }
      terminalReason = "replay_complete";
    } else {
      terminalReason = await runLiveSession({
        params,
        db,
        ctx,
        byName,
        log,
        runStep,
        getLiveTx: () => liveTx
      });
    }

    // Post-commit re-validate on a throwaway tx (matches t03.ts).
    const checkTx = begin(db, "agent-t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx); // discard the throwaway check tx

    const criteria = liveTx
      ? evaluateT03Criteria(db, batch, srcRoot, {
          commitReturnedOk: lastCommitOk,
          validateAfterCommitClean: postCommitDiagnostics.length === 0,
          renameTxId: liveTx.id
        })
      : emptyT03Criteria();

    return { criteria, terminalReason, log, transcript };
  } finally {
    db.close();
  }
}
```

Then implement `runLiveSession` in the same file (the live `query(...)` driver). It builds the server, runs `query`, asserts the runtime invariant guard from the `init` message, pairs `tool_use` blocks with their following `tool_use_result`, drives `runStep` for each tool call so the substrate state and the transcript stay identical to replay, and reads the terminal `SDKResultMessage`:

```ts
import {
  query,
  type Options,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

const T03_PROMPT =
  'Rename the exported interface `User` (defined in `src/types/user.ts`) ' +
  "to `Account` everywhere it is referenced as a type, including type-only " +
  "re-exports and JSDoc. Leave unrelated string literals with the value " +
  '`"User"` (such as audit log discriminators) untouched. The full test ' +
  "suite must pass.";

async function runLiveSession(deps: {
  params: RunAgentT03Params;
  db: Db;
  ctx: StrataSessionContext;
  byName: Map<string, { handler: (a: never, e: unknown) => Promise<{ content: { type: string; text?: string }[] }> }>;
  log: SessionLog;
  runStep: (tool: string, args: unknown, turn: number) => Promise<unknown>;
  getLiveTx: () => TxHandle | undefined;
}): Promise<TerminalReason> {
  const { params, ctx, log } = deps;
  const server = createStrataToolServer(ctx);
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    params.wallTimeMs
  );

  const options: Options = {
    mcpServers: { [STRATA_SERVER_NAME]: server },
    allowedTools: [...STRATA_QUALIFIED_TOOL_NAMES],
    tools: [],
    disallowedTools: BANNED_BUILTINS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: STRATA_SYSTEM_PROMPT,
    model: params.model,
    maxTurns: params.maxTurns,
    abortController,
    stderr: (data: string) =>
      log.append({
        type: "assistant_text",
        ts: Date.now(),
        turn: -1,
        text: `[stderr] ${data}`.slice(0, 240)
      })
  };

  let terminal: TerminalReason = "error_other";
  let turn = 0;
  try {
    for await (const message of query({
      prompt: singlePrompt(T03_PROMPT),
      options
    }) as AsyncGenerator<SDKMessage, void>) {
      if (message.type === "system" && message.subtype === "init") {
        log.append({
          type: "init",
          ts: Date.now(),
          tools: message.tools,
          mcpServers: message.mcp_servers
        });
        // Runtime invariant guard (CLAUDE.md "no filesystem tools").
        for (const banned of BANNED_BUILTINS) {
          if (message.tools.includes(banned)) {
            throw new Error(
              `Runtime invariant violated: built-in tool ${banned} present in init tool list`
            );
          }
        }
        for (const q of STRATA_QUALIFIED_TOOL_NAMES) {
          if (!message.tools.includes(q)) {
            throw new Error(
              `Runtime invariant violated: expected Strata tool ${q} missing from init tool list`
            );
          }
        }
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            log.append({
              type: "assistant_text",
              ts: Date.now(),
              turn,
              text: String(block.text).slice(0, 240)
            });
          }
          if (block.type === "tool_use") {
            const toolName = String(block.name).replace(
              `mcp__${STRATA_SERVER_NAME}__`,
              ""
            );
            // Drive the real handler so substrate state == replay state.
            await deps.runStep(toolName, block.input, turn);
          }
        }
        turn += 1;
      }

      if (message.type === "result") {
        if (message.subtype === "success") terminal = "success";
        else if (message.subtype === "error_max_turns")
          terminal = "error_max_turns";
        else if (message.subtype === "error_during_execution")
          terminal = "error_during_execution";
        else terminal = "error_other";
        log.append({
          type: "result",
          ts: Date.now(),
          subtype: message.subtype,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          totalCostUsd: message.total_cost_usd,
          usage: {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
            cacheReadInputTokens:
              message.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens:
              message.usage.cache_creation_input_tokens ?? 0
          },
          modelUsage: message.modelUsage,
          errors:
            message.subtype === "success" ? [] : message.errors
        });
      }
    }
  } catch (e) {
    if (abortController.signal.aborted) terminal = "error_wall_time";
    log.append({
      type: "assistant_text",
      ts: Date.now(),
      turn: -1,
      text: `[session error] ${e instanceof Error ? e.message : String(e)}`.slice(
        0,
        240
      )
    });
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
  return terminal;
}
```

Implementer notes (load-bearing):
- **The live path drives the *same* `runStep` as replay.** When the model emits a `tool_use` block for `mcp__strata__rename_symbol`, the orchestrator executes the real handler via `runStep` and records the `{ tool, args }` into `transcript`. This is what makes a recorded run replayable: the store outcome is a pure function of the recorded `transcript`. The SDK's own MCP server *also* executes the tool (it must, to give the model a `tool_use_result`); both calls hit the same `ctx.db`. The `rename_symbol`/`begin` operations are idempotent w.r.t. a single logical sequence only if not double-applied — see the spec ambiguity note in the report; the **resolution adopted here**: register the in-process MCP server so the SDK invokes the handlers, and reconstruct `transcript` purely from the model's `tool_use` blocks (do NOT also call `runStep` in the live loop). Replace the `await deps.runStep(...)` call inside the `tool_use` branch with `transcript.push + log.append` only (no second handler execution); keep `runStep` as the replay-only executor. (This avoids double-applying mutations; the SDK MCP server is the single executor in the live path, the orchestrator is the single executor in the replay path.) **Adjust the code above accordingly when implementing: in `runLiveSession`'s `tool_use` branch, do not call `deps.runStep`; instead push `{ tool: toolName, args: block.input }` to the transcript and append a `tool_call` log event, and capture `liveTx`/`lastCommitOk` by parsing the *following* `SDKUserMessage.tool_use_result`.** The replay path remains the only place `runStep` executes handlers.
- The `@strata/cli/dist/commands/t03Criteria` import path: `@strata/agent` must depend on `@strata/cli` to import the scorer, OR the scorer must move to a package both can import. **Resolution: add `@strata/cli` as a `workspace:*` dependency of `@strata/agent`** and import from its built `dist`. This is acyclic (`agent → cli`, and `cli` does not import `agent`). Update `packages/agent/package.json` `dependencies` to add `"@strata/cli": "workspace:*"` and `packages/agent/tsconfig.json` `references` to add `{ "path": "../cli" }`. (The operator's one-time `pnpm install` in Task 1 predates this; the implementer adds the dep line and the operator re-runs `pnpm install` at this task's boundary — call this out in the boundary note.)
- **Deep-import resolution caveat (verified):** `packages/cli/package.json` has NO `exports` map (`main: dist/cli.js`, `types: dist/cli.d.ts`). Because there is no `exports` field, Node's package-exports gate does not block subpath imports, so `@strata/cli/dist/commands/t03Criteria` resolves to the real built file (`dist/commands/t03Criteria.{js,d.ts}` — `cli`'s tsconfig is `rootDir: src` / `outDir: dist`, so `src/commands/t03Criteria.ts` emits there). **Do NOT add an `exports` map to `@strata/cli`** — that would re-gate subpaths and break this deep import. Build order is guaranteed by the Task 8 Step 4 tsconfig project reference (`{ "path": "../cli" }`): `tsc -b` builds `@strata/cli` before `@strata/agent`. If the implementer prefers a cleaner edge instead of a deep import, the acceptable alternative is to re-export `evaluateT03Criteria`/`emptyT03Criteria`/`T03Criteria` from `@strata/cli`'s barrel (`packages/cli/src/cli.ts` is the entry; add a dedicated `packages/cli/src/index.ts` barrel and point `main`/`types` there) — but that is a larger change to `cli`; the deep import is the minimal, verified path and is the planned default.

- [ ] **Step 4: Add the `@strata/cli` dependency and reference**

Modify `/Users/toddhebebrand/Strata/packages/agent/package.json` — add to `dependencies`:
```json
"@strata/cli": "workspace:*"
```
Modify `/Users/toddhebebrand/Strata/packages/agent/tsconfig.json` — add to `references`:
```json
{ "path": "../cli" }
```

- [ ] **Step 5: OPERATOR — re-run install for the new workspace edge**

Implementer must NOT run this. Operator runs:
```bash
pnpm install
```
Expected: `@strata/cli` linked as a dependency of `@strata/agent`. Implementer continues at Step 6.

- [ ] **Step 6: Reconcile the live/replay double-execution per Step 3 notes**

Apply the Step 3 "Adjust the code above accordingly" instruction: in `runLiveSession`, the `tool_use` branch must NOT call `deps.runStep`. It must (a) push `{ tool: toolName, args: block.input }` to `transcript`, (b) append a `tool_call` log event, and (c) read the matching `tool_use_result` from the next `SDKUserMessage` to update `liveTx` (on `begin_transaction`) and `lastCommitOk` (on `commit_transaction`). The SDK's registered MCP server is the sole executor in the live path; `runStep` executes only in the replay path. Add a small helper to find the `tool_use_result` for a given `tool_use` id by scanning subsequent `SDKUserMessage`s (`message.type === "user"`, `message.tool_use_result`).

- [ ] **Step 7: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
export {
  runAgentT03,
  collectSession,
  singlePrompt,
  type RunAgentT03Params,
  type AgentT03Result,
  type ReplayStep,
  type TerminalReason
} from "./session";
```

- [ ] **Step 8: Run the replay test (no model, no key)**

Run: `pnpm --filter @strata/agent test -- replay`
Expected: PASS — the synthetic transcript replays through real handlers, mutates the in-memory store, and `evaluateT03Criteria` returns all 11 true; `terminalReason === "replay_complete"`.

**Bail-signal note (BS-B):** If the replay path cannot drive the real handlers to a correct store state (e.g. the `$TX` substitution can't thread the handle, or the scorer can't be imported across the package boundary), surface it — this is the determinism mechanism and a BS-B-adjacent integration risk. Do not fake the store mutation.

- [ ] **Step 9: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green. `@strata/agent` `tsc -b` must compile against `@strata/cli`'s declared types and the SDK message-union narrowing.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/session.ts packages/agent/src/index.ts packages/agent/package.json packages/agent/tsconfig.json packages/agent/tests/replay.test.ts pnpm-lock.yaml
git commit -m "feat(agent): runAgentT03 orchestrator with live + replay sources"
```

---

## Task 9: Replay-from-file plumbing and fixture loader

Add the ability to load a committed JSON-lines transcript fixture from disk and feed it to `runAgentT03`'s replay path, so the key-free CI test reads a real recorded run.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/session.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/fixtureLoader.test.ts`

- [ ] **Step 1: Write the failing fixture-loader test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/fixtureLoader.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptFixture } from "../src/session";

describe("loadTranscriptFixture", () => {
  it("parses a JSON-lines transcript of tool_call events into ReplayStep[]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strata-fix-"));
    const file = path.join(dir, "t.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_start", ts: 1, model: "m", maxTurns: 25, task: "T03", actor: "agent-t03" }),
        JSON.stringify({ type: "tool_call", ts: 2, tool: "find_declarations", args: { name: "User", kind: "interface" }, result_summary: "", ok: true, error: null, durationMs: 1, turn: 0 }),
        JSON.stringify({ type: "tool_call", ts: 3, tool: "begin_transaction", args: {}, result_summary: "", ok: true, error: null, durationMs: 1, turn: 0 }),
        JSON.stringify({ type: "tool_call", ts: 4, tool: "rename_symbol", args: { tx: "$TX", declaration_id: "abc", new_name: "Account" }, result_summary: "", ok: true, error: null, durationMs: 1, turn: 1 }),
        JSON.stringify({ type: "result", ts: 5, subtype: "success", numTurns: 2, durationMs: 1, durationApiMs: 1, totalCostUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, modelUsage: {}, errors: [] })
      ].join("\n") + "\n"
    );
    const steps = loadTranscriptFixture(file);
    expect(steps.map((s) => s.tool)).toEqual([
      "find_declarations",
      "begin_transaction",
      "rename_symbol"
    ]);
    expect(steps[2]!.args).toEqual({
      tx: "$TX",
      declaration_id: "abc",
      new_name: "Account"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- fixtureLoader`
Expected: FAIL with "loadTranscriptFixture is not exported".

- [ ] **Step 3: Implement `loadTranscriptFixture`**

Append to `/Users/toddhebebrand/Strata/packages/agent/src/session.ts`:
```ts
/**
 * Load a recorded JSON-lines session log and extract the ordered tool-call
 * sequence as ReplayStep[]. Only `tool_call` events contribute; the
 * declaration_id captured at record time is reused (the corpus is fixed),
 * and the "$TX" placeholder for transaction args is preserved so the
 * replay path re-threads a fresh live handle.
 */
export function loadTranscriptFixture(filePath: string): ReplayStep[] {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const steps: ReplayStep[] = [];
  for (const line of lines) {
    const ev = JSON.parse(line) as { type: string; tool?: string; args?: unknown };
    if (ev.type === "tool_call" && ev.tool) {
      steps.push({ tool: ev.tool, args: ev.args ?? {} });
    }
  }
  return steps;
}
```

Implementer note: the recorded live log's `tool_call` events store `args` as the model's raw tool input. For transaction-bearing calls the model passes back the *actual* `TxHandle` it received, not `"$TX"`. The fixture recorder (Task 11, Step 3) must rewrite transaction-handle args to `"$TX"` before committing the fixture so replay re-threads a fresh handle. State this requirement in Task 11.

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/agent/src/index.ts`:
```ts
export { loadTranscriptFixture } from "./session";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/agent test -- fixtureLoader`
Expected: PASS.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/src/session.ts packages/agent/src/index.ts packages/agent/tests/fixtureLoader.test.ts
git commit -m "feat(agent): JSON-lines transcript fixture loader for replay"
```

---

## Task 10: Live agent T03 acceptance test (BS-A) — key-gated

The hero test. Key-gated so `pnpm -r test` stays green without secrets. Asserts all 11 criteria via the shared scorer plus the runtime invariant guard. This is where BS-A and BS-C surface.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/agentT03.test.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write the key-gated live acceptance test**

Create `/Users/toddhebebrand/Strata/packages/agent/tests/agentT03.test.ts`:
```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentT03 } from "../src/index";

const hasAuth =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

describe.skipIf(!hasAuth)("agent drives T03 end-to-end (BS-A, live)", () => {
  it(
    "passes all 11 T03 criteria and the runtime invariant guard",
    async () => {
      const corpusRoot = path.resolve(
        __dirname,
        "../../../examples/medium"
      );
      const result = await runAgentT03({
        corpusRoot,
        model: "claude-sonnet-4-6",
        maxTurns: 25,
        wallTimeMs: 240_000
      });

      // Runtime invariant guard fired inside the orchestrator: if a
      // built-in file/bash tool had leaked, runAgentT03 would have thrown.
      expect(result.terminalReason).toBe("success");

      for (const [key, value] of Object.entries(result.criteria)) {
        expect(value, `criterion ${key} (terminal=${result.terminalReason})`).toBe(
          true
        );
      }

      // BS-C: cost/latency must be captured in the log regardless.
      const resultEvent = result.log.events.find(
        (e) => e.type === "result"
      );
      expect(resultEvent).toBeDefined();

      // Init guard event must show only Strata tools.
      const initEvent = result.log.events.find((e) => e.type === "init");
      expect(initEvent).toBeDefined();
    },
    300_000
  );
});
```

- [ ] **Step 2: Run the test key-free**

Run: `pnpm --filter @strata/agent test -- agentT03`
Expected (no key): suite **skipped**, not failed.

- [ ] **Step 3: OPERATOR-or-key-holder — run the live acceptance test**

With auth available, run:
```bash
ANTHROPIC_API_KEY=… pnpm --filter @strata/agent test -- agentT03
```
Expected: PASS — all 11 criteria true, `terminalReason === "success"`, `init` and `result` log events present.

**Bail-signal note (BS-A):** If, after a *bounded* number of worldview-only iterations on `prompt.ts` (the prompt may be iterated as a worldview, never as a script), the model cannot reliably form explore → `rename_symbol` → `validate` → `commit_transaction` — it keeps trying file tools despite none existing, cannot thread the `TxHandle`, commits without validating, or cannot recover from a failed `validate` via `rollback_transaction` — **STOP**. Do not hardcode the prompt into a tool recipe. The finding is "the substrate's tool surface is not yet agent-legible." Record it in Step 4 and stop. Capture BS-C (tokens/wall time from the `result` log event) regardless of outcome.

- [ ] **Step 4: Append the BS-A / BS-C observation to `decisions.md`**

Add at the top of the newest-first list (fill the bracketed result honestly from the run; if no key was available, state the live run is deferred to the operator and the replay fixture in Task 11 is the CI proof):
```markdown
## 2026-05-15 — Phase 3 agent drives T03 live: BS-A / BS-C observation

**Context:** Phase 3 Task 10 ran the headless agent against the verbatim T03 prompt with only the eight Strata tools and `tools: []`.

**Considered:** n/a — this is a bail-signal observation entry, not a design choice.

**Decided / Observed:** <"BS-A cleared: the worldview prompt (N iterations) produced explore → rename_symbol → validate → commit_transaction; all 11 criteria true; terminalReason=success." OR "BS-A FIRED: <what the model did instead>; stopped, did not script the prompt." OR "Deferred: no API key in this environment; live run is an operator action; CI proof is the Task 11 replay fixture."> BS-C: <tokens in/out, cacheRead/Creation, totalCostUsd, durationMs from the result log event, or "pending operator live run">.

**Why:** BS-A is the substrate-agent-fit signal; BS-C is a primary Phase 4 cost signal. Both are recorded from run one per the spec.

**Design-doc impact:** none.

**Revisit when:** the prompt is iterated again, the tool set is widened (Open Question 1), or Phase 4 benchmarking begins.
```

- [ ] **Step 5: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green; `agentT03` skipped without a key.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/agent/tests/agentT03.test.ts decisions.md
git commit -m "feat(agent): key-gated live T03 acceptance test (BS-A, BS-C)"
```

---

## Task 11: Record the transcript fixture and wire the deterministic replay CI test

Capture one successful live run's transcript into a committed fixture, then add the key-free replay test that reproduces all 11 criteria deterministically from it. This realizes the spec's determinism mechanism.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/agent/tests/fixtures/agent-t03-transcript.jsonl` (operator-recorded)
- Modify: `/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Add a fixture-recording entry point**

Append to `/Users/toddhebebrand/Strata/packages/agent/src/session.ts` a helper that records a live run's transcript with transaction-handle args normalized to `"$TX"` so replay re-threads a fresh handle:
```ts
/**
 * Normalize a captured transcript for fixture storage: replace any tx
 * argument that looks like a TxHandle ({ id, actor }) with the "$TX"
 * placeholder so the replay path re-threads a fresh live handle.
 */
export function normalizeTranscriptForFixture(
  steps: ReplayStep[]
): ReplayStep[] {
  function norm(value: unknown): unknown {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "id" in (value as Record<string, unknown>) &&
      "actor" in (value as Record<string, unknown>) &&
      Object.keys(value as Record<string, unknown>).length === 2
    ) {
      return "$TX";
    }
    if (Array.isArray(value)) return value.map(norm);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(
        value as Record<string, unknown>
      )) {
        out[k] = norm(v);
      }
      return out;
    }
    return value;
  }
  return steps.map((s) => ({ tool: s.tool, args: norm(s.args) }));
}
```
Re-export it from the barrel (`export { normalizeTranscriptForFixture } from "./session";`).

- [ ] **Step 2: Write the failing key-free replay-from-fixture test**

Append to `/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts`:
```ts
import { existsSync } from "node:fs";
import { loadTranscriptFixture } from "../src/index";

const FIXTURE = path.resolve(
  __dirname,
  "fixtures/agent-t03-transcript.jsonl"
);

describe.skipIf(!existsSync(FIXTURE))(
  "runAgentT03 replays the committed live fixture deterministically",
  () => {
    it("reproduces all 11 T03 criteria from the recorded transcript without a model", async () => {
      const corpusRoot = path.resolve(
        __dirname,
        "../../../examples/medium"
      );
      const steps = loadTranscriptFixture(FIXTURE);
      const result = await runAgentT03({
        corpusRoot,
        model: "replay",
        maxTurns: 25,
        wallTimeMs: 60_000,
        replayTranscript: steps
      });
      for (const [key, value] of Object.entries(result.criteria)) {
        expect(value, `criterion ${key}`).toBe(true);
      }
      expect(result.terminalReason).toBe("replay_complete");
    });
  }
);
```

(Note: `describe.skipIf(!existsSync(FIXTURE))` means this is skipped — not failed — until the operator records the fixture in Step 3. `pnpm -r test` stays green either way.)

- [ ] **Step 3: OPERATOR — record the fixture from a live run**

Implementer cannot do this (needs a key + git). Operator, with auth:
1. Run the live acceptance test (Task 10 Step 3) with `logPath` pointed at the fixture path, OR add a one-off script that calls `runAgentT03({ ..., logPath: <fixture path> })` and then post-processes the log: keep only `tool_call`-shaped lines, run them through `normalizeTranscriptForFixture` semantics (replace `{id,actor}` tx args with `"$TX"`), and write the resulting JSON-lines to `packages/agent/tests/fixtures/agent-t03-transcript.jsonl`.
2. Verify the recorded run had `terminalReason === "success"` and all 11 criteria true before trusting the fixture.
3. Commit the fixture.

- [ ] **Step 4: Implementer — confirm replay reproduces criteria**

Once the fixture exists (operator placed it), run:
```bash
pnpm --filter @strata/agent test -- replay
```
Expected: both the synthetic-transcript test (Task 8) and the fixture-replay test pass; the fixture replay yields all 11 criteria true and `replay_complete`.

**Bail-signal note (BS-B / determinism):** If the captured transcript cannot be cleanly replayed through the same tool handlers (e.g. the SDK couples replay to its own session store, or the recorded `tool_use` args can't be normalized to a re-threadable sequence), fall back to the spec's documented fallback: a key-gated live-only test with a small retry budget (up to 3 attempts, pass if any yields all 11 criteria), pinned `model`/`maxTurns`/`abortController`. Record that divergence in Step 5. Do NOT fake replay determinism.

- [ ] **Step 5: Append decision D4 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — Phase 3 acceptance determinism: recorded-transcript replay

**Context:** The agent T03 acceptance test calls a live model (nondeterministic) but CI must be deterministic and key-free.

**Considered:** (a) key-gated live-only with a retry budget; (b) record a live transcript and replay the tool-call sequence through the real handlers so the store outcome is a pure function of the sequence.

**Decided:** <"(b). One successful live run's tool-call sequence is recorded to packages/agent/tests/fixtures/agent-t03-transcript.jsonl with tx-handle args normalized to \"$TX\"; runAgentT03's replay path re-executes it through the real Strata handlers, re-threading a fresh transaction handle. The key-free CI test reproduces all 11 criteria from the fixture. Live run regenerates the fixture." OR "(a) fallback adopted because replay could not be threaded: <reason>; key-gated live-only with a 3-attempt budget.">

**Why:** Replay keeps CI deterministic without secrets while a real live run remains the source of truth (it regenerates the fixture). The store outcome is a pure function of the recorded tool-call sequence, so replay is a faithful substrate-outcome reproduction, not a mock.

**Design-doc impact:** none — implements spec § "Acceptance test" / Open Question 2.

**Revisit when:** the SDK changes how tool calls are surfaced, the T03 corpus changes (fixture must be re-recorded), or the fallback was taken and a deterministic path later becomes possible.
```

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green; fixture-replay test runs (if fixture committed) or skips (if not yet), never fails the suite.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits (including the recorded fixture if produced):
```
git add packages/agent/src/session.ts packages/agent/src/index.ts packages/agent/tests/replay.test.ts packages/agent/tests/fixtures/agent-t03-transcript.jsonl decisions.md
git commit -m "feat(agent): deterministic transcript-replay T03 acceptance (D4)"
```

---

## Task 12: Bail-signal sweep and Phase 3 verticalization decision

Consolidate the Phase 3 outcome: confirm which bail signals fired/cleared, record BS-C cost from the first live run, and log the Phase 3 verticalization decision (mirrors Phase 1's closing decision shape).

**Files:**
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Verify the full suite is green and review bail-signal status**

Run: `pnpm -r build && pnpm -r test`
Expected: all green (live + fixture tests skip without a key; replay/handler/scaffold/schema/prompt/log tests pass). Review: did BS-A or BS-B fire in Tasks 4/5/8/10/11? If either fired, the corresponding task already appended a "FIRED" entry and execution stopped there — this task is only reached if Phase 3 closed.

- [ ] **Step 2: Append decision D5 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — Phase 3 verticalizes on agent-drives-T03

**Context:** Phase 3 completed: @strata/agent wraps the existing store/verify spine as eight in-process SDK tools, a headless query() session with tools:[] drives the verbatim T03 prompt, and the agent-produced store state passes the 11 shared evaluateT03Criteria checks (via recorded-transcript replay for deterministic CI). The design doc's Phase 3 ("add a parameter" worked example, broader tool set, session logging) remains broader than this slice.

**Considered:** broaden to the full benchmark harness / more tools / Claude Code baseline now; or ship the single agent-drives-T03 vertical slice and broaden in Phase 3.5/4.

**Decided:** single vertical slice. The agent drives the proven rename_symbol spine through T03 with no filesystem tools; broadening (more tasks, more tools, baseline comparison) is Phase 3.5/4.

**Why:** Verticalizing isolates agent/SDK-integration risk from substrate risk — the substrate was already green for T03 (Phase 1), so any Phase 3 failure is cleanly an agent/SDK-loop failure. BS-B was probed before the full tool set; BS-A was tested with a worldview (not scripted) prompt; BS-C is captured for Phase 4.

**Design-doc impact:** none — strata-design.md § Phase 3 remains the target; this records the implemented first slice (parallels the 2026-05-15 "Phase 1 verticalizes around rename_symbol" entry).

**Revisit when:** Phase 3.5 adds a second tool/task and tests whether the same session/tool spine generalizes, or Phase 4 builds the baseline comparison.
```

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add decisions.md
git commit -m "docs: Phase 3 verticalization + bail-signal sweep (D5)"
```

---

## Task 13: Refresh `CLAUDE.md` tooling commands

Document the agent commands now that Phase 3 has shipped.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/CLAUDE.md`

- [ ] **Step 1: Append the agent commands to `CLAUDE.md` § "Tooling commands"**

In `/Users/toddhebebrand/Strata/CLAUDE.md`, under `## Tooling commands`, add (do not remove existing Phase 0/1 lines):

````markdown
**Phase 3 agent (key-free deterministic replay of T03):**
```bash
pnpm --filter @strata/agent test -- replay
```

**Phase 3 agent (live T03 run — requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN):**
```bash
ANTHROPIC_API_KEY=… pnpm --filter @strata/agent test -- agentT03
```

The agent has no filesystem/bash tools (`tools: []`); its only callable
tools are the eight `mcp__strata__*` structural tools. Replay mode reproduces
the T03 outcome deterministically from a committed transcript fixture and
needs no API key, so `pnpm -r test` stays green without secrets.
````

- [ ] **Step 2: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green (no code change; sanity check the doc commit doesn't accompany a broken tree).

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add CLAUDE.md
git commit -m "docs: CLAUDE.md Phase 3 agent commands"
```

---

## Self-review checklist (executed)

**1. Spec coverage.**
- § "Acceptance test" (11 criteria via shared scorer, runtime invariant guard, key-gating, replay determinism) → Tasks 0, 8, 10, 11.
- § "What it forces us to build" §1 (eight SDK tools over shared `{db,actor}`) → Tasks 2, 4.
- §2 (`runAgentT03` orchestrator: ingest-as-t03, server+prompt, locked `query` options, iterate, pair tool_use/tool_use_result, capture result, return db+transcript+metrics) → Task 8.
- §3 (system prompt to the outline contract) → Task 6.
- §4 (JSON-lines session logging) → Task 7.
- § "Package / file layout" (new `@strata/agent`, acyclic deps, tsconfig references) → Task 1 (+ `@strata/cli` edge added in Task 8 with rationale).
- § "System prompt outline" (8 sections, no T03 ids, no script) → Task 6 (test enforces both).
- § "Session logging format" (every event shape) → Task 7.
- § "SDK integration" exact signatures (`tool`, `createSdkMcpServer`, `query`, `Options.tools:[]`, `allowedTools`, `bypassPermissions`+`allowDangerouslySkipPermissions`, `maxTurns`, `abortController`, `stderr`, `SDKSystemMessage.init` guard, `SDKResultSuccess` usage capture) → Tasks 4, 5, 8 (signatures grounded against installed `sdk.d.ts`).
- § "Bail signals" BS-A/BS-B/BS-C → bail-signal map + Tasks 4, 5, 10, 11, 12.
- § "Open questions" Q1 (minimal tool set) → minimal three query tools shipped (Tasks 3, 4); widening is a logged decision (D2 revisit). Q2 (determinism) → Task 11 (D4) with the spec's fallback explicitly planned.
- § "Out of scope" — no broader harness, no baseline, no extra mutation/query tools, no streaming UI, no multi-task: confirmed absent from all tasks.
- `read_node` export added to `@strata/store` (spec note) → Task 3 (D2).
- Refactor `runT03` scoring to shared pure `evaluateT03Criteria`, existing `t03` command/test still pass → Task 0 (D1), enforced by re-running `t03.test.ts` unchanged.
- Operator-vs-implementer git/install split, BOTH `build` and `test` gate, public-API-only → preamble + every task boundary.

**2. Placeholder scan.** No "TODO/TBD/implement later/add appropriate". Every code step has complete code. The one deliberate ambiguity (live-path double-execution of handlers vs. SDK MCP server) is resolved *in the plan* with an explicit "adjust the code accordingly" instruction and a dedicated reconciliation step (Task 8 Step 6) — it is not left to implementer guesswork.

**3. Type consistency.** `StrataSessionContext` `{ db, actor }`, `TxHandle` `{ id, actor }` (matches `@strata/store`), `T03Criteria` (11 fields, identical to `RunT03Result["criteria"]`), `evaluateT03Criteria(db, batch, srcRoot, input)` 4-arg signature consistent across Tasks 0/8/10/11, `ReplayStep` `{ tool, args }` consistent across Tasks 8/9/11, tool names consistent (`STRATA_TOOL_NAMES`/`STRATA_QUALIFIED_TOOL_NAMES`) across Tasks 4/6/8, SDK message narrowing (`message.type === "system"|"assistant"|"result"|"user"`) grounded in installed `sdk.d.ts` (`SDKSystemMessage.tools/mcp_servers`, `SDKResultSuccess.usage/total_cost_usd/num_turns/duration_ms`, `SDKUserMessage.tool_use_result`).

---

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-05-15-phase3-agent-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Best fit for a 14-task plan with explicit bail signals and an operator-in-the-loop (git/install/live-key boundaries) — each task review is the natural place to check a bail signal and run the operator commit.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

Which approach?
