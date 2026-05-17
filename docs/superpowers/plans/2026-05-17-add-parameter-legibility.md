# `add_parameter` Legibility Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@strata/store`'s `add_parameter` return an itemized `AddParameterManifest` of exactly the edits it made, and have the agent tool surface it as structured data instead of bare `{ ok: true }`.

**Architecture:** Purely additive return value. `add_parameter` already computes every manifest field internally and discards it; we collect and return it. The agent `add_parameter` tool spreads the manifest into its result. No `@strata/store` transaction/overlay semantics change, no collision-error change, **no tool-description change** (description-tuning is the falsified lever, held constant as a deliberate control so the keyed validation isolates the manifest as the single changed variable).

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, TypeScript Compiler API. Spec: `docs/superpowers/specs/2026-05-17-add-parameter-legibility-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/store/src/nodes.ts` | Node row access; add `modulePathOf` (walk ancestors to the `kind:"Module"` node, return its payload = module path) | Modify (add + export one function) |
| `packages/store/src/addParameter.ts` | `add_parameter`: define manifest types, return `AddParameterManifest` instead of `void` | Modify |
| `packages/store/src/index.ts` | Public exports of `@strata/store` | Modify (export manifest types + `modulePathOf`) |
| `packages/store/tests/nodes.test.ts` | `modulePathOf` unit test | Modify or Create (see Task 1) |
| `packages/store/tests/addParameterManifest.test.ts` | Manifest correctness + faithfulness invariant + zero-callsite edge | **Create** |
| `packages/agent/src/tools.ts` | `add_parameter` tool surfaces the manifest in its result | Modify (one handler; description untouched) |
| `packages/agent/tests/tools.test.ts` | `add_parameter` tool result carries manifest fields | Modify (append one test) |

The pre-registered keyed validation (AP-1..AP-4) is **out of this plan's scope** — it is a separate operator round, frozen in its own pre-reg commit before the round. This plan's terminal state is: full build clean + key-free suite green with only `@strata/store` and `@strata/agent` gaining tests (BG-3).

---

## Task 1: `modulePathOf` helper in `@strata/store`

**Files:**
- Modify: `packages/store/src/nodes.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/nodes.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `packages/store/tests/nodes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { insertNodes } from "../src/nodes";
import { find_declarations } from "../src/queries";
import { openDb } from "../src/schema";
import { modulePathOf } from "../src/nodes";

describe("modulePathOf", () => {
  it("returns the module path for a declaration and a nested statement", () => {
    const batch = ingestBatch([
      {
        path: "lib/format.ts",
        text:
          "export function formatTimestamp(ts: number): string {\n" +
          "  return new Date(ts).toISOString();\n" +
          "}\n"
      }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const decl = find_declarations(db, {
      name: "formatTimestamp",
      kind: "function"
    })[0]!;
    expect(modulePathOf(db, decl.id)).toBe("lib/format.ts");
    db.close();
  });

  it("throws a clear error for an unknown node id", () => {
    const db = openDb(":memory:");
    expect(() => modulePathOf(db, "nonexistent")).toThrow(/modulePathOf/i);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- nodes`
Expected: FAIL — `modulePathOf` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/nodes.ts`, add this function (place it after `findNodeById`; it uses the already-present `findNodeById`):

```ts
/**
 * Walk a node's parent chain to its enclosing `kind:"Module"` node and
 * return that module's payload, which is the POSIX module path (modules
 * are roots; their payload is the path — see ingest `nodeId(modulePath,
 * [], "Module")`). Used by the add_parameter manifest so the agent sees
 * which module each rewritten callsite is in.
 */
export function modulePathOf(db: Db, nodeId: string): string {
  let current = findNodeById(db, nodeId);
  if (!current) {
    throw new Error(`modulePathOf: node not found: ${nodeId}`);
  }
  const seen = new Set<string>();
  while (current.kind !== "Module") {
    if (current.parentId === null || seen.has(current.id)) {
      throw new Error(
        `modulePathOf: no Module ancestor for node ${nodeId}`
      );
    }
    seen.add(current.id);
    const parent = findNodeById(db, current.parentId);
    if (!parent) {
      throw new Error(
        `modulePathOf: dangling parent ${current.parentId} for ${current.id}`
      );
    }
    current = parent;
  }
  return current.payload;
}
```

In `packages/store/src/index.ts`, add `modulePathOf` to the existing `./nodes` export. Find the block that exports from `"./nodes"` and add `modulePathOf` to its name list (do not reorder existing names). If `nodes` symbols are exported via `export { ... } from "./nodes";`, add `modulePathOf` to that list; if there is no such block, add `export { modulePathOf } from "./nodes";` after the existing node-related exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- nodes`
Expected: PASS (2 tests). Then `pnpm --filter @strata/store test` — all pre-existing store tests still green (purely additive).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/nodes.ts packages/store/src/index.ts packages/store/tests/nodes.test.ts
git commit -m "feat(store): modulePathOf — resolve a node's module path"
```

---

## Task 2: `add_parameter` returns `AddParameterManifest`

**Files:**
- Modify: `packages/store/src/addParameter.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/tests/addParameterManifest.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/store/tests/addParameterManifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, findNodeById } from "../src/nodes";
import { find_declarations } from "../src/queries";
import { insertReferences } from "../src/references";
import { openDb } from "../src/schema";
import { add_parameter } from "../src/addParameter";
import { begin, getOverlay } from "../src/transactions";

const FORMAT =
  "export function formatTimestamp(ts: number): string {\n" +
  "  return new Date(ts).toISOString();\n" +
  "}\n";
const SERVER =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function logEvent(t: number): string {\n" +
  "  return formatTimestamp(t);\n" +
  "}\n";
const UI =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function rows(times: number[]): string[] {\n" +
  "  return times.map(formatTimestamp);\n" +
  "}\n" +
  "export function aliased(t: number): string {\n" +
  "  const f = formatTimestamp;\n" +
  "  return f(t);\n" +
  "}\n";

function setup(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const decl = find_declarations(db, {
    name: "formatTimestamp",
    kind: "function"
  })[0]!;
  return { batch, db, decl };
}

describe("add_parameter manifest", () => {
  it("reports the declaration signature before/after and each rewritten callsite", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    expect(m.declaration.id).toBe(decl.id);
    expect(m.declaration.beforeSignature).toContain(
      "formatTimestamp(ts: number): string"
    );
    expect(m.declaration.beforeSignature).not.toContain("toISOString");
    expect(m.declaration.afterSignature).toContain(
      'formatTimestamp(ts: number, timezone: string = "UTC"): string'
    );

    expect(m.callsitesRewritten).toHaveLength(1);
    const cs = m.callsitesRewritten[0]!;
    expect(cs.modulePath).toBe("server.ts");
    expect(cs.before).toContain("formatTimestamp(t)");
    expect(cs.after).toContain('formatTimestamp(t, "UTC")');
    db.close();
  });

  it("reports non-direct references as arity-risk sites, not rewrites", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "ui.ts", text: UI }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    // `times.map(formatTimestamp)` (higher-order) and `const f =
    // formatTimestamp` (aliased) are NOT direct calls -> arity-risk, not
    // rewritten.
    expect(m.callsitesRewritten).toHaveLength(0);
    const reasons = m.arityRiskSites.map((s) => s.reason).sort();
    expect(reasons).toEqual(["aliased-value", "higher-order-value"]);
    for (const s of m.arityRiskSites) {
      expect(s.modulePath).toBe("ui.ts");
    }
    db.close();
  });

  it("zero callsites -> empty callsitesRewritten (nothing to hand-patch)", () => {
    const { db, decl } = setup([{ path: "lib/format.ts", text: FORMAT }]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');
    expect(m.callsitesRewritten).toEqual([]);
    expect(m.arityRiskSites).toEqual([]);
    db.close();
  });

  it("FAITHFULNESS: manifest exactly mirrors the queued overlay edits", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');
    const overlay = getOverlay(tx).textSpanMutations;

    // (a) declaration: afterSignature == beforeSignature with the queued
    //     declaration edit applied (pins the signature slice math).
    const declEdits = overlay.get(decl.id)!;
    expect(declEdits).toHaveLength(1);
    const de = declEdits[0]!;
    const sig = m.declaration.beforeSignature;
    expect(m.declaration.afterSignature).toBe(
      sig.slice(0, de.start) + de.newText + sig.slice(de.end)
    );

    // (b) every rewritten callsite corresponds to exactly one real queued
    //     edit on a non-declaration statement, with after == applied.
    for (const cs of m.callsitesRewritten) {
      expect(cs.statementId).not.toBe(decl.id);
      const edits = overlay.get(cs.statementId)!;
      expect(edits).toHaveLength(1);
      const e = edits[0]!;
      const payload = findNodeById(db, cs.statementId)!.payload;
      expect(cs.before).toBe(payload);
      expect(cs.after).toBe(
        payload.slice(0, e.start) + e.newText + payload.slice(e.end)
      );
    }

    // (c) and vice versa: every queued non-declaration statement edit is
    //     represented in callsitesRewritten (no silent edits).
    const manifestStmtIds = new Set(
      m.callsitesRewritten.map((c) => c.statementId)
    );
    for (const stmtId of overlay.keys()) {
      if (stmtId === decl.id) continue;
      expect(manifestStmtIds.has(stmtId)).toBe(true);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/store test -- addParameterManifest`
Expected: FAIL — `add_parameter` returns `void`; `m.declaration` is a TypeScript/runtime error (property of undefined).

- [ ] **Step 3: Write minimal implementation**

In `packages/store/src/addParameter.ts`:

(a) Add the import for `modulePathOf` and `findNodeById` (note `findNodeById` is already imported; add `modulePathOf`):

Change the existing import line `import { findNodeById } from "./nodes";` to:

```ts
import { findNodeById, modulePathOf } from "./nodes";
```

(b) Add the manifest types (place above `export function add_parameter`):

```ts
export interface AddParameterCallsiteEdit {
  modulePath: string;
  statementId: string;
  before: string;
  after: string;
}

export interface AddParameterArityRiskSite {
  modulePath: string;
  statementId: string;
  reason: string;
}

export interface AddParameterManifest {
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: AddParameterCallsiteEdit[];
  arityRiskSites: AddParameterArityRiskSite[];
}
```

(c) Change the signature `): void {` to `): AddParameterManifest {`.

(d) Replace the callsite loop and the trailing `queuePendingOp(...)` block (current lines ~136–178, from `const { callsites } = resolveCallsites(db, functionId);` through the end of the function) with:

```ts
  const resolution = resolveCallsites(db, functionId);
  const slotValue = defaultValue ?? "undefined";
  const affected = new Set<string>([functionId]);
  const callsitesRewritten: AddParameterCallsiteEdit[] = [];

  for (const callsite of resolution.callsites) {
    const callPosition = Math.max(
      0,
      Math.min(clamped, callsite.existingArgCount)
    );
    const start = callsite.argumentInsertionOffsets[callPosition];
    if (start === undefined) {
      throw new Error(
        `add_parameter: no callsite insertion offset for position ${callPosition}`
      );
    }
    const newText =
      callsite.existingArgCount === 0
        ? slotValue
        : callPosition === 0
          ? `${slotValue}, `
          : `, ${slotValue}`;

    queueTextSpanEdit(tx, callsite.statementId, {
      start,
      end: start,
      oldText: "",
      newText
    });
    affected.add(callsite.statementId);

    const stmt = findNodeById(db, callsite.statementId);
    if (!stmt) {
      throw new Error(
        `add_parameter: callsite statement not found: ${callsite.statementId}`
      );
    }
    callsitesRewritten.push({
      modulePath: modulePathOf(db, callsite.statementId),
      statementId: callsite.statementId,
      before: stmt.payload,
      after:
        stmt.payload.slice(0, start) + newText + stmt.payload.slice(start)
    });
  }

  queuePendingOp(tx, {
    kind: "AddParameter",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      type,
      position: clamped,
      has_default: defaultValue !== undefined
    }),
    affectedNodeIdsJson: JSON.stringify([...affected]),
    reasoning: null
  });

  const bodyStart = fn.body ? fn.body.getStart(sf) : declaration.payload.length;
  const beforeSignature = declaration.payload.slice(0, bodyStart);
  const afterSignature =
    beforeSignature.slice(0, declarationEdit.start) +
    declarationEdit.newText +
    beforeSignature.slice(declarationEdit.end);

  return {
    declaration: {
      id: functionId,
      beforeSignature,
      afterSignature
    },
    callsitesRewritten,
    arityRiskSites: resolution.nonCallReferences.map((r) => ({
      modulePath: modulePathOf(db, r.statementId),
      statementId: r.statementId,
      reason: r.shape
    }))
  };
```

(`fn`, `sf`, `declaration`, `declarationEdit`, `clamped` are all already in scope from the unchanged earlier part of the function. `declarationEdit` is queued before the body via `parameterInsertionEdit`, so `declarationEdit.start`/`end` are < `bodyStart`, making the `beforeSignature`-relative slice exact — the FAITHFULNESS test pins this.)

In `packages/store/src/index.ts`, extend the existing `export { add_parameter, addParameter } from "./addParameter";` line to also export the types:

```ts
export {
  add_parameter,
  addParameter,
  type AddParameterManifest,
  type AddParameterCallsiteEdit,
  type AddParameterArityRiskSite
} from "./addParameter";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/store test -- addParameterManifest`
Expected: PASS (4 tests).
Run: `pnpm --filter @strata/store build && pnpm --filter @strata/store test`
Expected: build clean; ALL store tests green (the pre-existing `addParameter.test.ts` still passes — its assertions read the overlay/render and ignore the now-returned value; the return-type change `void → AddParameterManifest` is backward-compatible for callers that discard it).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/addParameter.ts packages/store/src/index.ts packages/store/tests/addParameterManifest.test.ts
git commit -m "feat(store): add_parameter returns an itemized AddParameterManifest"
```

---

## Task 3: agent `add_parameter` tool surfaces the manifest

**Files:**
- Modify: `packages/agent/src/tools.ts` (the `addParameterTool` handler only — description unchanged)
- Test: `packages/agent/tests/tools.test.ts` (append one test)

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/tests/tools.test.ts`, inside the existing `describe("strata tools drive the spine through the shared context", ...)` block (reuse the file's existing `parseText` helper and imports; add `begin`-style setup mirroring other tests in that file). Add:

```ts
  it("add_parameter result carries the manifest, not a bare ok", () => {
    const batch = ingestBatch([
      {
        path: "lib/format.ts",
        text:
          "export function formatTimestamp(ts: number): string {\n" +
          "  return new Date(ts).toISOString();\n" +
          "}\n"
      },
      {
        path: "server.ts",
        text:
          'import { formatTimestamp } from "./format.ts";\n' +
          "export function logEvent(t: number): string {\n" +
          "  return formatTimestamp(t);\n" +
          "}\n"
      }
    ]);
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const tools = createStrataTools({ db, actor: "x" });
      const byName = new Map(tools.map((t) => [t.name, t]));

      const begun = parseText(
        await byName.get("begin_transaction")!.handler({}, undefined)
      ) as { id: string; actor: string };

      const decls = parseText(
        await byName.get("find_declarations")!.handler(
          { name: "formatTimestamp", kind: "function" },
          undefined
        )
      ) as { id: string }[];

      const result = parseText(
        await byName.get("add_parameter")!.handler(
          {
            tx: begun,
            function_id: decls[0]!.id,
            name: "timezone",
            type: "string",
            position: 1,
            default: '"UTC"'
          },
          undefined
        )
      ) as {
        ok: boolean;
        declaration: { afterSignature: string };
        callsitesRewritten: { modulePath: string; after: string }[];
        arityRiskSites: unknown[];
      };

      expect(result.ok).toBe(true);
      expect(result.declaration.afterSignature).toContain(
        'timezone: string = "UTC"'
      );
      expect(result.callsitesRewritten[0]!.modulePath).toBe("server.ts");
      expect(result.callsitesRewritten[0]!.after).toContain(
        'formatTimestamp(t, "UTC")'
      );
      expect(Array.isArray(result.arityRiskSites)).toBe(true);
    } finally {
      db.close();
    }
  });
```

If `ingestBatch`, `insertNodes`, `insertReferences`, `openDb` are not already imported in `tools.test.ts`, add them to the existing imports (the file already imports from `@strata/store` and `@strata/ingest` per its header — extend those import lists, do not duplicate). Match the file's actual handler-invocation convention: inspect how other tests in this file call a tool (e.g. the rename/commit tests around the `eleven tool names` test) and mirror exactly that invocation form (`.handler(args, extra)` vs `.callback`), adjusting the calls above to match the real shape used elsewhere in the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: FAIL — `add_parameter` result is `{ ok: true }`; `result.declaration` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/tools.ts`, in the `addParameterTool` handler ONLY, change:

```ts
    async (args) => {
      add_parameter(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.name,
        args.type,
        args.position,
        args.default
      );
      return textResult({ ok: true });
    }
```

to:

```ts
    async (args) => {
      const manifest = add_parameter(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.name,
        args.type,
        args.position,
        args.default
      );
      return textResult({ ok: true, ...manifest });
    }
```

**Do not change the `add_parameter` tool description string or any other tool.** (Description-tuning is the falsified lever, held constant as the control.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/agent test -- tools`
Expected: PASS.
Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: build clean; `@strata/agent` tests green; the 2 key-gated tests still skipped (replay/key-free determinism unchanged — the tool result is richer but replay does not assert `add_parameter` result body).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/tests/tools.test.ts
git commit -m "feat(agent): add_parameter tool surfaces the manifest (description unchanged)"
```

---

## Task 4: BG-3 regression net + backward-compat verification

**Files:** none modified (verification + final commit only)

- [ ] **Step 1: Clean build everything**

Run: `pnpm -r build`
Expected: all 8 packages build clean, zero TS errors. If anything fails, STOP and report BLOCKED with the error (the `void → AddParameterManifest` change is backward-compatible; a failure here means an unexpected caller typed against `void`).

- [ ] **Step 2: Backward-compat caller check**

Run: `grep -rn "add_parameter(\|addParameter(" packages --include=*.ts | grep -v node_modules | grep -v /dist/ | grep -v tests/`
Expected: every non-test caller invokes `add_parameter(...)`/`addParameter(...)` as a statement (return value discarded) OR is the agent tool from Task 3 (which now consumes it). Confirm no caller assigns the result to a `: void`-typed binding or otherwise depends on the old `void` return. Summarize what you found.

- [ ] **Step 3: Full key-free suite (BG-3)**

Run: `pnpm -r test 2>&1 | grep -E "test:\s+Tests +[0-9]"`
Expected, vs the pre-branch baseline (`main`: store 50, render 13, ingest 6, verify 42, cli 7, agent 30 + 2 skipped, bench 48): **only `@strata/store` and `@strata/agent` counts increase** (store gains Task 1 + Task 2 tests; agent gains Task 3's one test, still 2 skipped). render/ingest/verify/cli/bench **byte-identical**. Zero failures anywhere. If any other package count changes or anything fails, STOP and report BLOCKED — that is a BG-3 violation; do not "fix" pre-existing tests.

- [ ] **Step 4: Commit (no-op if Tasks 1–3 already committed cleanly)**

The work was committed per task. Confirm a clean tree:

```bash
git status --porcelain
```

Expected: empty (all changes committed in Tasks 1–3). If anything is uncommitted, stage and commit it with an accurate message describing exactly what it is.

---

## Out of plan scope (operator, after this plan is green)

The pre-registered keyed validation **AP-1..AP-4** (spec § Testing) is evaluated by the **operator** from a keyed re-run, frozen tamper-evidently in a separate pre-reg commit *before* the round:

```
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T03 --keep-artifacts
```

This plan's terminal state is: all 8 packages build clean and the full key-free suite is green with only `@strata/store` and `@strata/agent` gaining tests (BG-3 intact). The keyed round and its `decisions.md` finding entry are a separate, operator-gated step.

---

## Self-Review

**Spec coverage:**
- `add_parameter` returns `AddParameterManifest` (declaration before/after, callsitesRewritten, arityRiskSites) → Task 2. ✓
- Manifest sourced from already-computed data, additive, no semantics change → Task 2 Step 3 (reuses existing `declarationEdit`, `resolution.callsites`, `resolution.nonCallReferences`; only adds collection + `return`). ✓
- `modulePath` per callsite/arity-risk site → Task 1 (`modulePathOf`) consumed in Task 2. ✓
- Agent tool surfaces manifest as structured data, no directive prose, **no description change** → Task 3 (handler-only change; explicit "do not change description"). ✓
- Faithfulness invariant (manifest ⇔ queued overlay edits; afterSignature == beforeSignature+edit) → Task 2 Step 1 test "FAITHFULNESS". ✓
- Edges: zero callsites → `[]`; higher-order/aliased → arityRiskSites not rewrites → Task 2 tests. ✓
- BG-3: only store + agent gain tests, all else byte-identical, build clean → Task 4. ✓
- Keyed AP-1..AP-4 explicitly out of plan scope → "Out of plan scope" section. ✓

**Placeholder scan:** No TBD/TODO. Every code step has complete code. Task 3 Step 1 instructs mirroring the file's real handler-invocation form — this is a precise instruction (the convention is confirmed to exist via the file's existing `eleven tool names` / rename / commit tests), not a placeholder, because the test logic and assertions are fully specified; only the `.handler(...)` vs `.callback(...)` spelling is matched to the file.

**Type consistency:** `AddParameterManifest`/`AddParameterCallsiteEdit`/`AddParameterArityRiskSite` defined in Task 2 and consumed unchanged in Task 3's test and `index.ts` export. `modulePathOf(db, nodeId): string` defined Task 1, called identically in Task 2. `resolution.callsites` / `resolution.nonCallReferences` match the verified `CallsiteResolution` shape (`Callsite.statementId`, `NonCallReference.{statementId,shape}`). `declarationEdit`/`fn`/`sf`/`clamped` are pre-existing in-scope names reused, not redefined. No drift.
