# Task-Scoped Behavioral Commit Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the behavioral commit gate run only the active task's own behavioral fixture(s), so a correct task change commits in one transaction with no unrelated collateral (fixes BG-4).

**Architecture:** An authoritative `TASK_BEHAVIORAL_FIXTURES` map + fail-loud `behavioralFixturesForTask(taskId)` resolver lives in `@strata/verify`. `vitestRun`/`runCorpusAcceptance` gain an **additive** optional `fixtures` parameter (`undefined` ⇒ today's whole-suite behaviour, so every key-free caller is byte-unchanged; `[]` ⇒ skip vitest, tsc-only; non-empty ⇒ run only those files). `AcceptanceContext` carries the **already-resolved** `behavioralFixtures` list (callers resolve via `behavioralFixturesForTask`); both the live commit gate and the bench scorer resolve through that one function, so gate == scorer by construction.

**Spec-wording refinement (logged in Task 8):** the spec says "`commitWithBehavioralGate` resolves `behavioralFixturesForTask(ctx.taskId)`". This plan instead has the **callers** resolve and pass the list via `AcceptanceContext.behavioralFixtures`. Same single authority, same gate==scorer guarantee, but it decouples the `@strata/verify` gate from task identity and keeps the gate unit-testable with arbitrary fixture lists. This is a deliberate, intent-preserving refinement and is recorded in `decisions.md` in Task 8 per the project's build-time-divergence discipline.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, TS Compiler API. `@strata/verify` owns the corpus runner; `@strata/agent` and `@strata/bench` are callers.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/verify/src/taskBehavioralFixtures.ts` | Single source of truth: task id → behavioral fixture list; fail-loud resolver | **Create** |
| `packages/verify/tests/taskBehavioralFixtures.test.ts` | Unit tests for the map + resolver | **Create** |
| `packages/verify/src/index.ts` | Public exports of `@strata/verify` | Modify (add export block) |
| `packages/verify/src/corpusRun.ts` | `vitestRun`, `runCorpusAcceptance` — add additive `fixtures?` | Modify |
| `packages/verify/tests/corpusRun.test.ts` | Add scoped `vitestRun`/`runCorpusAcceptance` tests | Modify (append) |
| `packages/verify/src/validate.ts` | `AcceptanceContext`, `commitWithBehavioralGate` | Modify |
| `packages/verify/tests/behavioralGate.test.ts` | Existing 2 gate tests + new tsc-only gate test | Modify |
| `packages/agent/src/session.ts` | Construct `AcceptanceContext` for live runs | Modify (1 import, 1 object) |
| `packages/bench/src/quality.ts` | Thin re-export from `@strata/verify` | Modify (add 1 name) |
| `packages/bench/src/configs/substrate.ts` | Substrate scorer `vitestPassed` sub-metric | Modify |
| `packages/bench/src/configs/baseline.ts` | Baseline scorer `vitestPassed` analog | Modify |
| `decisions.md` | Build-time divergence log | Modify (Task 8) |

No corpus restructuring. No new fixtures for T03/T08 (spec Non-goals).

---

## Task 1: Authoritative fixture map + fail-loud resolver

**Files:**
- Create: `packages/verify/src/taskBehavioralFixtures.ts`
- Create: `packages/verify/tests/taskBehavioralFixtures.test.ts`
- Modify: `packages/verify/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/verify/tests/taskBehavioralFixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TASK_BEHAVIORAL_FIXTURES,
  behavioralFixturesForTask
} from "../src/index";

describe("behavioralFixturesForTask", () => {
  it("maps T01 and T05 to their own fixture, T03/T08 to none", () => {
    expect(behavioralFixturesForTask("T01")).toEqual(["tests/format.test.ts"]);
    expect(behavioralFixturesForTask("T05")).toEqual([
      "tests/dateRange.test.ts"
    ]);
    expect(behavioralFixturesForTask("T03")).toEqual([]);
    expect(behavioralFixturesForTask("T08")).toEqual([]);
  });

  it("is fail-loud on an unknown task id (never silently whole-suite/empty)", () => {
    expect(() => behavioralFixturesForTask("T99")).toThrow(/unknown task id/i);
  });

  it("exposes the map as the single source of truth", () => {
    expect(Object.keys(TASK_BEHAVIORAL_FIXTURES).sort()).toEqual([
      "T01",
      "T03",
      "T05",
      "T08"
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- taskBehavioralFixtures`
Expected: FAIL — `behavioralFixturesForTask`/`TASK_BEHAVIORAL_FIXTURES` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `packages/verify/src/taskBehavioralFixtures.ts`:

```ts
/**
 * Single source of truth: which behavioral fixture(s) a benchmark task's
 * commit gate / scorer must run. The gate runs ONLY these (an empty list =>
 * tsc-only, nothing behavioral to assert). This replaces the previous
 * whole-suite scope that made the shared multi-task corpus unsatisfiable
 * per-task (decisions.md 2026-05-16, BG-4).
 *
 * T03 (rename) and T08 (change_return_type) have no behavioral-only failure
 * mode — tsc + text criteria fully constrain them — so they map to []. Only
 * T01 and T05 ship a real behavioral fixture.
 */
export const TASK_BEHAVIORAL_FIXTURES: Record<string, readonly string[]> = {
  T01: ["tests/format.test.ts"],
  T03: [],
  T05: ["tests/dateRange.test.ts"],
  T08: []
};

/**
 * Resolve a task's behavioral fixture list. Fail-loud on an unknown id: a
 * new task MUST register here deliberately and is never silently treated as
 * whole-suite or as empty (that silent default is exactly the BG-4 defect).
 */
export function behavioralFixturesForTask(
  taskId: string
): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(TASK_BEHAVIORAL_FIXTURES, taskId)) {
    throw new Error(
      `behavioralFixturesForTask: unknown task id: ${taskId}`
    );
  }
  return TASK_BEHAVIORAL_FIXTURES[taskId];
}
```

Append to `packages/verify/src/index.ts` (after the last export block, new line 53+):

```ts
export {
  TASK_BEHAVIORAL_FIXTURES,
  behavioralFixturesForTask
} from "./taskBehavioralFixtures";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/verify test -- taskBehavioralFixtures`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/taskBehavioralFixtures.ts packages/verify/tests/taskBehavioralFixtures.test.ts packages/verify/src/index.ts
git commit -m "feat(verify): authoritative task->behavioral-fixture map (fail-loud)"
```

---

## Task 2: Additive scoped `vitestRun`

**Files:**
- Modify: `packages/verify/src/corpusRun.ts:163-180` (`vitestRun`)
- Test: `packages/verify/tests/corpusRun.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/verify/tests/corpusRun.test.ts` (inside the file, add imports `mkdtempSync, mkdirSync, writeFileSync, rmSync` from `node:fs`, `tmpdir` from `node:os`, `path`, and `vitestRun` from `../src/index` if not already imported — check the existing import block first and reuse it):

```ts
describe("vitestRun scoping (additive)", () => {
  function tmpTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), "strata-vrun-"));
    mkdirSync(path.join(root, "tests"), { recursive: true });
    writeFileSync(
      path.join(root, "vitest.config.ts"),
      'import { defineConfig } from "vitest/config";\n' +
        'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
    );
    writeFileSync(
      path.join(root, "tests", "pass.test.ts"),
      'import { expect, it } from "vitest";\nit("p", () => expect(1).toBe(1));\n'
    );
    writeFileSync(
      path.join(root, "tests", "fail.test.ts"),
      'import { expect, it } from "vitest";\nit("f", () => expect(1).toBe(2));\n'
    );
    return root;
  }

  it("empty fixture list skips vitest entirely (tsc-only task)", () => {
    const root = tmpTree();
    try {
      // fail.test.ts is red, but [] means 'no behavioral assertion'.
      expect(vitestRun(root, []).vitestPassed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs only the named fixture, ignoring an unrelated red file", () => {
    const root = tmpTree();
    try {
      expect(vitestRun(root, ["tests/pass.test.ts"]).vitestPassed).toBe(true);
      expect(vitestRun(root, ["tests/fail.test.ts"]).vitestPassed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is fail-loud (not silent green) when a named fixture is missing", () => {
    const root = tmpTree();
    try {
      const r = vitestRun(root, ["tests/nope.test.ts"]);
      expect(r.vitestPassed).toBe(false);
      expect(r.output).toMatch(/not found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("undefined fixtures preserves whole-suite behaviour (BG-3)", () => {
    const root = tmpTree();
    try {
      // whole suite includes fail.test.ts -> red, exactly as today.
      expect(vitestRun(root).vitestPassed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- corpusRun`
Expected: FAIL — `vitestRun` ignores the 2nd arg; the empty-list and missing-fixture cases fail.

- [ ] **Step 3: Write minimal implementation**

Replace `vitestRun` in `packages/verify/src/corpusRun.ts` (currently lines 163-180) with:

```ts
export function vitestRun(
  treeRoot: string,
  fixtures?: readonly string[]
): {
  vitestPassed: boolean;
  output: string;
} {
  if (fixtures !== undefined) {
    if (fixtures.length === 0) {
      return { vitestPassed: true, output: "" };
    }
    const missing = fixtures.filter(
      (f) => !existsSync(path.join(treeRoot, f))
    );
    if (missing.length > 0) {
      return {
        vitestPassed: false,
        output: `vitestRun: scoped fixture(s) not found: ${missing.join(", ")}`
      };
    }
  }

  if (!hasVitestFiles(treeRoot)) {
    return { vitestPassed: true, output: "" };
  }

  const vitestBin = require.resolve("vitest/vitest.mjs");
  const args =
    fixtures && fixtures.length > 0 ? ["run", ...fixtures] : ["run"];
  const result = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: treeRoot,
    encoding: "utf8"
  });
  return {
    vitestPassed: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}
```

(`existsSync` and `path` are already imported at the top of `corpusRun.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/verify test -- corpusRun`
Expected: PASS — new scoping block green; pre-existing `corpusRun.test.ts` tests still green (they call `vitestRun(root)` / `runCorpusAcceptance(...)` with no fixtures arg → `undefined` → unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/corpusRun.ts packages/verify/tests/corpusRun.test.ts
git commit -m "feat(verify): additive scoped vitestRun (undefined=whole-suite, []=skip)"
```

---

## Task 3: Thread `fixtures` through `runCorpusAcceptance`

**Files:**
- Modify: `packages/verify/src/corpusRun.ts:188-241` (`runCorpusAcceptance`)
- Test: `packages/verify/tests/corpusRun.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/verify/tests/corpusRun.test.ts`:

```ts
describe("runCorpusAcceptance scoping", () => {
  it("[] => vitest skipped, tsc-only; an unrelated seed red does NOT block", () => {
    const root = mkdtempSync(path.join(tmpdir(), "strata-acc-"));
    try {
      mkdirSync(path.join(root, "tests"), { recursive: true });
      writeFileSync(
        path.join(root, "vitest.config.ts"),
        'import { defineConfig } from "vitest/config";\n' +
          'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
      );
      writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true
          },
          include: ["src/**/*.ts"]
        })
      );
      writeFileSync(
        path.join(root, "tests", "other.test.ts"),
        'import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(2));\n'
      );
      const rendered = new Map<string, string>([
        ["a.ts", "export const a: number = 1;\n"]
      ]);
      const r = runCorpusAcceptance(rendered, root, []);
      expect(r.tscClean).toBe(true);
      expect(r.vitestPassed).toBe(true); // the BG-4 mechanism is gone
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

(Ensure `runCorpusAcceptance` is in the `../src/index` import in this test file; reuse the existing import block.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- corpusRun`
Expected: FAIL — `runCorpusAcceptance` has no 3rd param; it runs the whole suite, `other.test.ts` is red, `vitestPassed` is `false`.

- [ ] **Step 3: Write minimal implementation**

In `packages/verify/src/corpusRun.ts`, change the `runCorpusAcceptance` signature and its single `vitestRun` call:

Signature (currently lines 188-191):

```ts
export function runCorpusAcceptance(
  renderedSrc: Map<string, string>,
  corpusRoot: string,
  fixtures?: readonly string[]
): CorpusAcceptanceResult {
```

The call (currently `const vitest = vitestRun(outRoot);`, ~line 228):

```ts
    const vitest = vitestRun(outRoot, fixtures);
```

Nothing else in the function changes (`undefined` ⇒ identical to today).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/verify test -- corpusRun`
Expected: PASS — new test green; all pre-existing `corpusRun.test.ts` tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/corpusRun.ts packages/verify/tests/corpusRun.test.ts
git commit -m "feat(verify): runCorpusAcceptance accepts optional scoped fixtures"
```

---

## Task 4: `AcceptanceContext.behavioralFixtures` + gate uses it

**Files:**
- Modify: `packages/verify/src/validate.ts:111-114` (`AcceptanceContext`), `:146` (the `runCorpusAcceptance` call)
- Modify: `packages/verify/tests/behavioralGate.test.ts` (2 existing constructions + 1 new test)

- [ ] **Step 1: Write the failing test**

In `packages/verify/tests/behavioralGate.test.ts`, (a) add `behavioralFixtures: ["tests/a.test.ts"]` to **both** existing `commitWithBehavioralGate(db, tx, { corpusRoot: root, srcRoot })` calls (lines 70-73 and 100-103), making each:

```ts
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot,
      behavioralFixtures: ["tests/a.test.ts"]
    });
```

(b) Append a new test proving the tsc-only ([]) path commits even with a red corpus test present:

```ts
  it("[] behavioralFixtures: tsc-only commit ignores an unrelated red test", () => {
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("NOPE"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const gSource =
      'export function greet(n: string): string { return "hi " + n; }\n';
    writeFileSync(path.join(srcRoot, "g.ts"), gSource);
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: gSource }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot,
      behavioralFixtures: []
    });
    expect(result.ok).toBe(true); // BG-4 mechanism gone at the gate level
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- behavioralGate`
Expected: FAIL — TS error: object literal may only specify known properties / `behavioralFixtures` missing on `AcceptanceContext` (compile-level), and the new `[]` test fails.

- [ ] **Step 3: Write minimal implementation**

In `packages/verify/src/validate.ts`, change `AcceptanceContext` (lines 111-114):

```ts
export interface AcceptanceContext {
  corpusRoot: string;
  srcRoot: string;
  /**
   * The task's resolved behavioral fixture list (callers resolve via
   * behavioralFixturesForTask). [] => tsc-only. Never undefined here: a
   * live gate is always task-scoped (decisions.md 2026-05-16 / BG-4).
   */
  behavioralFixtures: readonly string[];
}
```

And the `runCorpusAcceptance` call (line 146):

```ts
  const result = runCorpusAcceptance(
    renderedSrc,
    acceptance.corpusRoot,
    acceptance.behavioralFixtures
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @strata/verify test -- behavioralGate`
Expected: PASS — both original tests pass scoped to `tests/a.test.ts`; the new `[]` test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/tests/behavioralGate.test.ts
git commit -m "feat(verify): AcceptanceContext carries resolved behavioralFixtures; gate scopes by it"
```

---

## Task 5: Plumb resolved fixtures in the agent session (live gate)

**Files:**
- Modify: `packages/agent/src/session.ts:19-30` (import), `:279-281` (acceptance object)

- [ ] **Step 1: Write the failing test**

Run the agent build to surface the missing required field (this is the failing check; the agent gate is exercised key-free via replay, which sets `acceptance: undefined`, so the compile is the gate here):

Run: `pnpm --filter @strata/agent build`
Expected: FAIL — TS2741: property `behavioralFixtures` is missing in the `AcceptanceContext` object at `session.ts:281`.

- [ ] **Step 2: Confirm the failure is the expected one**

Confirm the error names `behavioralFixtures` and `session.ts` ~line 281. If any other error appears, stop and diagnose.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent/src/session.ts`, add `behavioralFixturesForTask` to the existing `@strata/verify` import (lines 19-30 — add the name to the import list):

```ts
import {
  emptyT03Criteria,
  evaluateT01Criteria,
  evaluateT03Criteria,
  evaluateT05Criteria,
  evaluateT08Criteria,
  validate,
  behavioralFixturesForTask,
  type T01Criteria,
  type T03Criteria,
  type T05Criteria,
  type T08Criteria
} from "@strata/verify";
```

Change the acceptance construction (lines 279-281) — `params.taskId` is in scope in `runAgentForPrompt`:

```ts
      acceptance: runParams.replayTranscript
        ? undefined
        : {
            corpusRoot: runParams.corpusRoot,
            srcRoot,
            behavioralFixtures: behavioralFixturesForTask(params.taskId)
          }
```

- [ ] **Step 4: Run build + key-free agent tests to verify**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: build clean; tests = 24 passing / 2 skipped (unchanged — replay path still uses `acceptance: undefined`, so behaviour is byte-identical key-free).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/session.ts
git commit -m "feat(agent): live commit gate resolves task-scoped behavioralFixtures"
```

---

## Task 6: Plumb resolved fixtures in the substrate scorer sub-metric

**Files:**
- Modify: `packages/bench/src/quality.ts:8-19` (re-export), `packages/bench/src/configs/substrate.ts:20` (import), `:158-198` (`substrateQualityFromRendered`), `:247` (call site)

- [ ] **Step 1: Write the failing test**

Run the bench build to surface the signature mismatch after the implementation is staged; first add the re-export so the import resolves. Begin by adding `behavioralFixturesForTask` to `packages/bench/src/quality.ts`'s export list (lines 8-19):

```ts
export {
  renderStoreToDir,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  assertSrcOnlyScope,
  tscNoEmit,
  tscNoEmitSrc,
  vitestRun,
  runCorpusAcceptance,
  behavioralFixturesForTask,
  type QualityResult,
  type CorpusAcceptanceResult
} from "@strata/verify";
```

Run: `pnpm --filter @strata/bench build`
Expected: PASS (re-export only; no consumer yet).

- [ ] **Step 2: Make the scorer scope-aware (the change under test)**

In `packages/bench/src/configs/substrate.ts` line 20, extend the import:

```ts
import { tscNoEmitSrc, vitestRun, behavioralFixturesForTask } from "../quality";
```

Change `substrateQualityFromRendered` (line 158) signature and its `vitestRun` call (~line 193):

```ts
async function substrateQualityFromRendered(
  rendered: Map<string, string> | undefined,
  corpusRoot: string,
  fixtures: readonly string[]
): Promise<{ tscClean: boolean; vitestPassed: boolean }> {
```

```ts
    const { tscClean } = tscNoEmitSrc(outRoot);
    const { vitestPassed } = vitestRun(outRoot, fixtures);
    return { tscClean, vitestPassed };
```

Change the call site (line ~247, inside `runSubstrateTaskTrial` where `taskId` is in scope):

```ts
    ((_: AgentT03Result | AgentTaskResult) =>
      substrateQualityFromRendered(
        result.rendered,
        params.corpusRoot,
        behavioralFixturesForTask(taskId)
      ));
```

- [ ] **Step 3: Run build to verify it passes**

Run: `pnpm --filter @strata/bench build`
Expected: PASS — `substrateQualityFromRendered` now requires the fixture list and the single caller supplies the task-resolved list (gate == scorer: identical `behavioralFixturesForTask` authority as Task 5).

- [ ] **Step 4: Run bench key-free tests**

Run: `pnpm --filter @strata/bench test`
Expected: 48 passing (unchanged — these use injected fake runners; `substrateQualityFromRendered` is the live-only path and is not exercised key-free).

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/quality.ts packages/bench/src/configs/substrate.ts
git commit -m "feat(bench): substrate scorer uses task-scoped fixtures (gate==scorer)"
```

---

## Task 7: Plumb resolved fixtures in the baseline scorer analog

**Files:**
- Modify: `packages/bench/src/configs/baseline.ts:23` (import), `:250-268` (`defaultValidateWorkingTree`), its call site

- [ ] **Step 1: Locate the call site**

Run: `grep -n "defaultValidateWorkingTree\|runBaselineTaskTrial\|behavioralFixturesForTask\|from \"../quality\"" packages/bench/src/configs/baseline.ts`
Expected: shows the `defaultValidateWorkingTree(` definition (~line 251), its single invocation inside `runBaselineTaskTrial` (where `taskId` is in scope), and the `../quality` import line (~23).

- [ ] **Step 2: Write the failing check**

Make `defaultValidateWorkingTree` scope-aware so the build fails until the caller supplies the list. Edit `packages/bench/src/configs/baseline.ts`:

Import (line 23):

```ts
import { tscNoEmitSrc, vitestRun, behavioralFixturesForTask } from "../quality";
```

`defaultValidateWorkingTree` (lines 251-268) — add the parameter and use it:

```ts
async function defaultValidateWorkingTree(
  treeRoot: string,
  srcRoot: string,
  beforeModules: Map<string, string>,
  fixtures: readonly string[]
): Promise<{
  tscClean: boolean;
  vitestPassed: boolean;
  anyFileModified: boolean;
}> {
  const afterModules = readModuleMap(srcRoot);
  const anyFileModified =
    beforeModules.size !== afterModules.size ||
    [...afterModules.entries()].some(
      ([key, text]) => beforeModules.get(key) !== text
    );
  const { tscClean } = tscNoEmitSrc(treeRoot);
  const { vitestPassed } = vitestRun(treeRoot, fixtures);
  return { tscClean, vitestPassed, anyFileModified };
}
```

- [ ] **Step 3: Update the call site**

At the single `defaultValidateWorkingTree(` invocation found in Step 1 (inside `runBaselineTaskTrial`, `taskId` in scope), add the resolved list as the 4th argument:

```ts
  defaultValidateWorkingTree(
    treeRoot,
    srcRoot,
    beforeModules,
    behavioralFixturesForTask(taskId)
  )
```

(Match the existing argument names actually used at that call site — if a variable other than `treeRoot`/`srcRoot`/`beforeModules` is passed today, keep those and only append `behavioralFixturesForTask(taskId)` as the new final argument.)

- [ ] **Step 4: Run build + bench tests**

Run: `pnpm --filter @strata/bench build && pnpm --filter @strata/bench test`
Expected: build clean; 48 passing (baseline quality analog is live-only; key-free injected runners unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/configs/baseline.ts
git commit -m "feat(bench): baseline scorer analog uses task-scoped fixtures (gate==scorer)"
```

---

## Task 8: Full key-free regression + log the build-time refinement

**Files:**
- Modify: `decisions.md` (newest-first entry)

- [ ] **Step 1: Clean build everything**

Run: `pnpm -r build`
Expected: all 8 packages build clean (no TS errors).

- [ ] **Step 2: Full key-free suite (BG-3 regression net)**

Run: `pnpm -r test 2>&1 | grep -E "Tests +[0-9]"`
Expected, per package: store 50, render 13, ingest 6, **verify 28 + the new tests from Tasks 1–4** (taskBehavioralFixtures: 3; corpusRun additions: 5; behavioralGate: +1 → verify ≈ 37), cli 7, agent 24 (+2 skipped), bench 48. **Zero pre-existing test moves** — the only deltas are new `@strata/verify` tests. If any pre-existing count drops or any non-verify package changes, **STOP** — that is a BG-3 violation; diagnose before continuing.

- [ ] **Step 3: Confirm no key-free caller passes `fixtures`**

Run: `grep -rn "runCorpusAcceptance(\|vitestRun(" packages --include=*.ts | grep -v node_modules | grep -v dist`
Expected: every call in `tests/` and the key-free paths uses the no-fixtures form (`undefined`) **except** the new Task 2/3 scoping tests and the live callers wired in Tasks 4–7. Eyeball that no pre-existing key-free caller was given a 2nd/3rd arg. This is the explicit BG-3 proof.

- [ ] **Step 4: Log the build-time refinement in decisions.md**

Insert immediately below the `<!-- New entries go below this line, newest first. -->` marker in `decisions.md` (above the BG-4 entry):

```markdown
## 2026-05-16 — Gate-scope build: AcceptanceContext carries the resolved fixture list, not taskId

**Context:** Implementing the task-scoped gate (spec `docs/superpowers/specs/2026-05-16-gate-scope-redesign-design.md`). The spec's prose says `commitWithBehavioralGate` resolves `behavioralFixturesForTask(ctx.taskId)`.

**Considered:** (a) literal spec — `AcceptanceContext` carries `taskId`, the verify gate calls the resolver; (b) callers resolve and pass `AcceptanceContext.behavioralFixtures: readonly string[]`.

**Decided:** (b). The single authority (`behavioralFixturesForTask` in `@strata/verify`) and the gate==scorer guarantee are unchanged — both the live gate (session.ts) and the bench scorer (substrate/baseline) resolve through that one function. Carrying the resolved list keeps the verify gate decoupled from benchmark task identity and lets the gate unit tests exercise arbitrary fixture lists (`["tests/a.test.ts"]`, `[]`) directly.

**Why:** Same intent and invariants as the spec; strictly better seam (testability + no task-vocabulary coupling in the gate). Recorded because it diverges from the spec's literal wording per the project's build-time-divergence discipline.

**Design-doc impact:** none to architecture; refines the spec's internal call-site only. Spec intent (single authority, fail-loud, additive scoping, gate==scorer) fully preserved.

**Revisit when:** a non-bench caller needs the gate and cannot resolve a fixture list itself.
```

- [ ] **Step 5: Commit**

```bash
git add decisions.md
git commit -m "docs(decisions): record AcceptanceContext seam refinement (resolved list vs taskId)"
```

---

## Out of plan scope (operator, after this plan is green)

The pre-committed bail signals **GS-1..GS-4** (spec § Testing) are evaluated by the **operator** from a keyed re-run, *not* in this plan's build/test loop:

```
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts
```

This plan's terminal state is: all 8 packages build clean and the full key-free suite is green with only additive `@strata/verify` tests (BG-3 intact). The keyed round and its `decisions.md` finding entry are a separate, operator-gated step.

---

## Self-Review

**Spec coverage:**
- Authoritative map in `@strata/verify`, fail-loud → Task 1. ✓
- Additive `undefined`⇒whole-suite (BG-3) → Tasks 2/3, proven Task 8 Step 3. ✓
- `[]`⇒skip vitest tsc-only → Task 2 (`vitestRun`), Task 4 (gate level). ✓
- Non-empty ⇒ only those files → Task 2. ✓
- Task identity plumbed bench→agent→verify → Tasks 5 (agent), 6 (substrate), 7 (baseline). ✓
- gate == scorer one shared computation → same `behavioralFixturesForTask` authority in Tasks 5/6/7. ✓
- Error handling: unknown id throws (Task 1), missing fixture not silent green (Task 2). ✓
- T03 carries `"T03"` → `runSubstrateTrial`/`runBaselineTrial` delegate to `*TaskTrial("T03", …)` (verified in substrate.ts:208 / baseline.ts:138), so `taskId` is `"T03"` at the call sites in Tasks 6/7; agent T03 path sets `taskId:"T03"` (session.ts:408) → Task 5 resolves `[]`. ✓
- Key-free suite stays green, only verify additions → Task 8. ✓
- GS-1..GS-4 are operator-round signals, explicitly out of the build loop → "Out of plan scope". ✓

**Placeholder scan:** No TBD/TODO. Every code step has complete code. Task 7 Step 3 intentionally instructs matching the real call-site argument names (the one site is located in Step 1) — this is a precise instruction, not a placeholder, because the surrounding variable names are confirmed (`treeRoot`/`srcRoot`/`beforeModules` per baseline.ts:251-268).

**Type consistency:** `behavioralFixturesForTask(taskId: string): readonly string[]` (Task 1) is consumed identically in Tasks 5/6/7; `fixtures?: readonly string[]` is the same optional type across `vitestRun` (Task 2) and `runCorpusAcceptance` (Task 3); `AcceptanceContext.behavioralFixtures: readonly string[]` (Task 4) matches what session.ts passes (Task 5). `substrateQualityFromRendered`'s new `fixtures: readonly string[]` and `defaultValidateWorkingTree`'s new `fixtures: readonly string[]` are consistent. No naming drift.
