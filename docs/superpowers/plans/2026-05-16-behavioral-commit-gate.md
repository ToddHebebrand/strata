# Behavioral Commit Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's commit gate refuse a change that compiles but fails the corpus test suite, by unifying the agent gate and the bench scorer onto one shared runner in `@strata/verify`.

**Architecture:** Relocate the on-disk render+tsc+vitest runner from `@strata/bench` down into `@strata/verify` (acyclic: `bench → agent → verify`). Add `runCorpusAcceptance` (materialize rendered src + corpus tests, run `tscNoEmitSrc` + `vitestRun`, capture output) and `commitWithBehavioralGate` (validate-as-today, then behavioral acceptance, then finalize). Wire the agent's `commit_transaction` tool to the gate for live runs only; replay/key-free paths keep the unchanged tsc-only `commit()`.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, TypeScript Compiler API, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/specs/2026-05-16-behavioral-commit-gate-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/verify/src/corpusRun.ts` (create) | Relocated runners (`renderStoreToDir`, `tscNoEmit`, `tscNoEmitSrc`, `assertSrcOnlyScope`, `resolveCorpusTsconfigInclude`, `resolveTscProgramRootNames`, `vitestRun`, `QualityResult`) + new `runCorpusAcceptance`. Subprocess output now captured. |
| `packages/verify/src/validate.ts` (modify) | Extract `renderPendingModules` (behavior-preserving), add `commitWithBehavioralGate` + `GatedCommitResult`. `validate()`/`commit()` signatures and behavior unchanged. |
| `packages/verify/src/index.ts` (modify) | Export the new surface. |
| `packages/bench/src/quality.ts` (replace body) | Thin re-export from `@strata/verify`. No bench behavior change; `../quality` / `./quality` import sites untouched. |
| `packages/agent/src/tools.ts` (modify) | `StrataSessionContext.acceptance?`; `commit_transaction` branches to the gate when present; truthful tool description. |
| `packages/agent/src/session.ts` (modify) | Thread `{ corpusRoot, srcRoot }` into ctx as `acceptance` for non-replay runs only. |
| `packages/verify/tests/corpusRun.test.ts` (create) | Key-free unit tests for `runCorpusAcceptance`. |
| `packages/verify/tests/behavioralGate.test.ts` (create) | Key-free unit tests for `commitWithBehavioralGate`. |
| `packages/verify/tests/renderPendingModules.test.ts` (create) | Proves the `validate()` extraction is behavior-preserving. |
| `decisions.md` (modify) | Newest-first entry: runner relocation + behavioral-gate divergence. |

**Important invariants (do not violate):**
- `commit(db, tx)` keeps its exact current signature and tsc-only behavior. The 170 key-free tests must pass **unchanged** — do not edit existing test files.
- The relocation must be byte-for-byte behavior-preserving for `@strata/bench` (bail signal **BG-3**).
- T03 behavior is the regression guard (**BG-4**) — no task changes T03.

---

## Task 1: Relocate the corpus runner into `@strata/verify` with output capture

**Files:**
- Create: `packages/verify/src/corpusRun.ts`
- Create: `packages/verify/tests/corpusRun.test.ts`
- Modify: `packages/verify/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/verify/tests/corpusRun.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCorpusAcceptance } from "../src/index";

const created: string[] = [];

function makeCorpus(): string {
  const root = mkdtempSync(path.join(tmpdir(), "strata-corpustest-"));
  created.push(root);
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
    path.join(root, "package.json"),
    JSON.stringify({ name: "corpus-fixture", private: true })
  );
  writeFileSync(
    path.join(root, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n' +
      'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
  );
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "tests", "sum.test.ts"),
    'import { describe, expect, it } from "vitest";\n' +
      'import { sum } from "../src/sum";\n' +
      'describe("sum", () => { it("adds", () => { expect(sum(2, 3)).toBe(5); }); });\n'
  );
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("runCorpusAcceptance", () => {
  it("passes when rendered src makes the corpus tests green", () => {
    const root = makeCorpus();
    const rendered = new Map<string, string>([
      ["sum.ts", "export function sum(a: number, b: number): number { return a + b; }"]
    ]);
    const result = runCorpusAcceptance(rendered, root);
    expect(result.tscClean).toBe(true);
    expect(result.vitestPassed).toBe(true);
  });

  it("fails (tests red) and captures output when behavior is wrong", () => {
    const root = makeCorpus();
    const rendered = new Map<string, string>([
      ["sum.ts", "export function sum(a: number, b: number): number { return a - b; }"]
    ]);
    const result = runCorpusAcceptance(rendered, root);
    expect(result.vitestPassed).toBe(false);
    expect(result.failureOutput.length).toBeGreaterThan(0);
  });

  it("fails closed on an empty render", () => {
    const root = makeCorpus();
    const result = runCorpusAcceptance(new Map(), root);
    expect(result.tscClean).toBe(false);
    expect(result.vitestPassed).toBe(false);
    expect(result.failureOutput).toContain("no modules rendered");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- corpusRun`
Expected: FAIL — `runCorpusAcceptance` is not exported from `../src/index`.

- [ ] **Step 3: Create `packages/verify/src/corpusRun.ts`**

This is the verbatim relocation of `packages/bench/src/quality.ts` plus an `output` field on the subprocess returns and the new `runCorpusAcceptance`. Write exactly:

```typescript
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

interface RenderBatch {
  modules: { path: string; moduleId: string }[];
}

export interface QualityResult {
  tscClean: boolean;
  vitestPassed: boolean;
}

export interface CorpusAcceptanceResult {
  tscClean: boolean;
  vitestPassed: boolean;
  /** Captured tsc + vitest stdout/stderr, for the agent and the operator log. */
  failureOutput: string;
}

/** Render committed store modules to a scratch tree that mirrors corpus src/. */
export function renderStoreToDir(
  db: Db,
  batch: RenderBatch,
  srcRoot: string,
  outRoot: string,
  corpusRoot: string
): string {
  const outSrc = path.join(outRoot, "src");
  for (const module of batch.modules) {
    const rel = path.relative(srcRoot, module.path).replaceAll("\\", "/");
    const loaded = loadModule(db, module.moduleId);
    const text = renderWithSourceMap(loaded.module, loaded.children).text;
    const dest = path.join(outSrc, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }

  for (const file of ["tsconfig.json", "package.json"]) {
    const src = path.join(corpusRoot, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(outRoot, file));
    }
  }

  return outSrc;
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, "../../..");
}

export function tscNoEmit(treeRoot: string): {
  tscClean: boolean;
  output: string;
} {
  const tsconfig = path.join(treeRoot, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return { tscClean: false, output: "tscNoEmit: no tsconfig.json" };
  }

  const tscBin = require.resolve("typescript/bin/tsc");
  const typeRoots = path.join(repoRootFromHere(), "node_modules", "@types");
  const result = spawnSync(
    process.execPath,
    [tscBin, "--noEmit", "-p", tsconfig, "--typeRoots", typeRoots],
    { cwd: treeRoot, encoding: "utf8" }
  );
  return {
    tscClean: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

export function resolveCorpusTsconfigInclude(treeRoot: string): string[] {
  const tsconfigPath = path.join(treeRoot, "tsconfig.json");
  const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    include?: string[];
  };
  return parsed.include ?? [];
}

export function resolveTscProgramRootNames(treeRoot: string): string[] {
  const tsconfigPath = path.join(treeRoot, "tsconfig.json");
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(read.error.messageText, "\n")
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, treeRoot);
  return parsed.fileNames
    .map((fileName) => path.relative(treeRoot, fileName).replaceAll("\\", "/"))
    .sort();
}

export function assertSrcOnlyScope(treeRoot: string): void {
  const include = resolveCorpusTsconfigInclude(treeRoot);
  const hasTests = include.some((glob) => glob.includes("tests/"));
  const rootNames = resolveTscProgramRootNames(treeRoot);
  const hasTestRoot = rootNames.some(
    (rootName) => rootName.startsWith("tests/") || rootName.includes("/tests/")
  );
  const isSrcOnly =
    include.length > 0 &&
    include.every((glob) => glob.startsWith("src/")) &&
    !hasTests &&
    !hasTestRoot;
  if (!isSrcOnly) {
    throw new Error(
      `tscNoEmitSrc requires a src-only tsconfig include; got ` +
        `${JSON.stringify(include)} with rootNames ` +
        `${JSON.stringify(rootNames)}. tests/** must be excluded from the ` +
        `typecheck scope.`
    );
  }
}

export function tscNoEmitSrc(treeRoot: string): {
  tscClean: boolean;
  output: string;
} {
  assertSrcOnlyScope(treeRoot);
  return tscNoEmit(treeRoot);
}

function hasVitestFiles(treeRoot: string): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (entry === "node_modules" || entry === ".git") {
          continue;
        }
        if (walk(abs)) {
          return true;
        }
      } else if (/\.(test|spec)\.tsx?$/.test(entry)) {
        return true;
      }
    }
    return false;
  }
  return walk(treeRoot);
}

export function vitestRun(treeRoot: string): {
  vitestPassed: boolean;
  output: string;
} {
  if (!hasVitestFiles(treeRoot)) {
    return { vitestPassed: true, output: "" };
  }

  const vitestBin = require.resolve("vitest/vitest.mjs");
  const result = spawnSync(process.execPath, [vitestBin, "run"], {
    cwd: treeRoot,
    encoding: "utf8"
  });
  return {
    vitestPassed: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

/**
 * Materialize rendered src + the corpus's own tests/configs into a scratch
 * tree, then run the src-scoped type-check and the real test suite. This is
 * the single behavioral finish line shared by the agent commit gate and the
 * benchmark scorer.
 */
export function runCorpusAcceptance(
  renderedSrc: Map<string, string>,
  corpusRoot: string
): CorpusAcceptanceResult {
  if (renderedSrc.size === 0) {
    return {
      tscClean: false,
      vitestPassed: false,
      failureOutput: "runCorpusAcceptance: no modules rendered"
    };
  }

  const outRoot = mkdtempSync(path.join(tmpdir(), "strata-accept-"));
  try {
    const outSrc = path.join(outRoot, "src");
    for (const [rel, text] of renderedSrc) {
      const dest = path.join(outSrc, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }

    for (const file of ["tsconfig.json", "package.json", "vitest.config.ts"]) {
      const from = path.join(corpusRoot, file);
      if (existsSync(from)) {
        cpSync(from, path.join(outRoot, file));
      }
    }

    const seedTests = path.join(corpusRoot, "tests");
    if (existsSync(seedTests)) {
      cpSync(seedTests, path.join(outRoot, "tests"), { recursive: true });
    }

    const repoNodeModules = path.join(repoRootFromHere(), "node_modules");
    const tmpNodeModules = path.join(outRoot, "node_modules");
    if (existsSync(repoNodeModules)) {
      symlinkSync(repoNodeModules, tmpNodeModules, "dir");
    }

    const tsc = tscNoEmitSrc(outRoot);
    const vitest = vitestRun(outRoot);
    const failureOutput =
      tsc.tscClean && vitest.vitestPassed
        ? ""
        : `--- tsc ---\n${tsc.output}\n--- vitest ---\n${vitest.output}`;
    return {
      tscClean: tsc.tscClean,
      vitestPassed: vitest.vitestPassed,
      failureOutput
    };
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Export the new surface from `packages/verify/src/index.ts`**

Add at the end of the file:

```typescript
export {
  renderStoreToDir,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  assertSrcOnlyScope,
  tscNoEmit,
  tscNoEmitSrc,
  vitestRun,
  runCorpusAcceptance,
  type QualityResult,
  type CorpusAcceptanceResult
} from "./corpusRun";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/verify build && pnpm --filter @strata/verify test -- corpusRun`
Expected: PASS — 3 passing in `corpusRun.test.ts`. (The "tests red" case spawns a real vitest run; allow a few seconds.)

- [ ] **Step 6: Commit**

```bash
git add packages/verify/src/corpusRun.ts packages/verify/src/index.ts packages/verify/tests/corpusRun.test.ts
git commit -m "feat(verify): relocate corpus runner + add runCorpusAcceptance

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Make `@strata/bench` consume the relocated runner (behavior-preserving)

**Files:**
- Modify: `packages/bench/src/quality.ts` (replace entire body with a re-export)

- [ ] **Step 1: Replace the body of `packages/bench/src/quality.ts`**

Replace the entire file contents with:

```typescript
/**
 * The corpus runner was lowered into @strata/verify so the agent commit gate
 * and this benchmark scorer share one finish line by construction (see
 * docs/specs/2026-05-16-behavioral-commit-gate-design.md and the matching
 * decisions.md entry). This module is a thin re-export to keep every existing
 * `../quality` / `./quality` import site and bench behavior unchanged.
 */
export {
  renderStoreToDir,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  assertSrcOnlyScope,
  tscNoEmit,
  tscNoEmitSrc,
  vitestRun,
  runCorpusAcceptance,
  type QualityResult,
  type CorpusAcceptanceResult
} from "@strata/verify";
```

- [ ] **Step 2: Build and run the full bench suite to verify behavior is preserved**

Run: `pnpm --filter @strata/verify build && pnpm --filter @strata/bench build && pnpm --filter @strata/bench test`
Expected: PASS — every existing `@strata/bench` test green, unchanged count. (Bench scorer now resolves `tscNoEmitSrc`/`vitestRun` through the re-export; destructuring `{ tscClean }` / `{ vitestPassed }` still works because the extra `output` field is additive.)

> **BG-3 bail signal:** if any bench test changes outcome or count, STOP. The relocation must be behavior-preserving. Diagnose; do not "fix" the scorer.

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/quality.ts
git commit -m "refactor(bench): consume relocated corpus runner from @strata/verify

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract `renderPendingModules` from `validate()` (behavior-preserving)

**Files:**
- Modify: `packages/verify/src/validate.ts`
- Create: `packages/verify/tests/renderPendingModules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/verify/tests/renderPendingModules.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { begin, insertNodes, insertReferences, openDb } from "@strata/store";
import { renderPendingModules } from "../src/validate";

describe("renderPendingModules", () => {
  it("returns one rendered entry per module at the pending tx state", () => {
    const batch = ingestBatch([
      { path: "/c/src/a.ts", text: "export const a: number = 1;\n" }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const { renderedFiles, sourceMaps } = renderPendingModules(db, tx);
    expect(renderedFiles.size).toBe(1);
    expect(sourceMaps.size).toBe(1);
    const text = [...renderedFiles.values()][0] as string;
    expect(text).toContain("const a: number = 1");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- renderPendingModules`
Expected: FAIL — `renderPendingModules` is not exported from `../src/validate`.

- [ ] **Step 3: Refactor `validate()` to delegate to a new exported `renderPendingModules`**

In `packages/verify/src/validate.ts`, replace the body of `validate()` (currently lines ~25–85) so the module-render loop becomes a reusable function. The new code:

```typescript
export function renderPendingModules(
  db: Db,
  tx: TxHandle
): {
  renderedFiles: Map<string, string>;
  sourceMaps: Map<string, SourceMapEntry[]>;
} {
  const overlay = getOverlay(tx);
  const renderedFiles = new Map<string, string>();
  const sourceMaps = new Map<string, SourceMapEntry[]>();

  for (const module of listModules(db)) {
    const loaded = loadModuleForRender(db, module.id);
    const { text, sourceMap } = renderWithSourceMap(
      loaded.module,
      loaded.children,
      {
        identifierMutations: overlay.identifierMutations,
        textSpanMutations: overlay.textSpanMutations
      }
    );
    renderedFiles.set(normalizeFileName(module.payload), text);
    sourceMaps.set(normalizeFileName(module.payload), sourceMap);
  }

  return { renderedFiles, sourceMaps };
}

export function validate(db: Db, tx: TxHandle): Diagnostic[] {
  const { renderedFiles, sourceMaps } = renderPendingModules(db, tx);

  const options = loadCompilerOptions([...renderedFiles.keys()]);
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) =>
    renderedFiles.has(normalizeFileName(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    renderedFiles.get(normalizeFileName(fileName)) ?? ts.sys.readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile
  ) => {
    const rendered = renderedFiles.get(normalizeFileName(fileName));
    if (rendered !== undefined) {
      return ts.createSourceFile(
        fileName,
        rendered,
        languageVersionOrOptions,
        true,
        ts.ScriptKind.TS
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    );
  };

  const program = ts.createProgram({
    rootNames: [...renderedFiles.keys()],
    options,
    host
  });

  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => mapDiagnostic(diagnostic, sourceMaps));
}
```

Leave `commit()`, `materializeStatementPayloads`, and every other function in the file unchanged.

- [ ] **Step 4: Run tests to verify the extraction is behavior-preserving**

Run: `pnpm --filter @strata/verify build && pnpm --filter @strata/verify test`
Expected: PASS — the new `renderPendingModules` test passes AND every pre-existing `@strata/verify` test (`validate.test.ts`, `t0*Criteria.test.ts`, `textSpanMaterialize.test.ts`) passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/tests/renderPendingModules.test.ts
git commit -m "refactor(verify): extract renderPendingModules from validate (no behavior change)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `commitWithBehavioralGate`

**Files:**
- Modify: `packages/verify/src/validate.ts`
- Modify: `packages/verify/src/index.ts`
- Create: `packages/verify/tests/behavioralGate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/verify/tests/behavioralGate.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { begin, insertNodes, insertReferences, openDb } from "@strata/store";
import { commitWithBehavioralGate } from "../src/index";

const created: string[] = [];

function makeCorpus(testBody: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "strata-bgate-"));
  created.push(root);
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
    path.join(root, "package.json"),
    JSON.stringify({ name: "bgate-fixture", private: true })
  );
  writeFileSync(
    path.join(root, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n' +
      'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
  );
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "tests", "a.test.ts"), testBody);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("commitWithBehavioralGate", () => {
  it("refuses to finalize when the corpus tests fail, returning testFailures", () => {
    // Seed src that the corpus test will reject (test wants greet to return "hi X").
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("hi x"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: 'export function greet(n: string): string { return "bye " + n; }\n' }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot
    });
    expect(result.ok).toBe(false);
    if (result.ok === false && "testFailures" in result) {
      expect(result.testFailures.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected testFailures failure shape");
    }
    db.close();
  });

  it("finalizes when tsc is clean and the corpus tests pass", () => {
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("hi x"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: 'export function greet(n: string): string { return "hi " + n; }\n' }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot
    });
    expect(result.ok).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- behavioralGate`
Expected: FAIL — `commitWithBehavioralGate` is not exported.

- [ ] **Step 3: Add `commitWithBehavioralGate` + `GatedCommitResult` to `packages/verify/src/validate.ts`**

Add this import near the top of `validate.ts` (with the other imports):

```typescript
import { runCorpusAcceptance } from "./corpusRun";
```

Add these to `validate.ts` (after `commit()`):

```typescript
export interface AcceptanceContext {
  corpusRoot: string;
  srcRoot: string;
}

export type GatedCommitResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] }
  | { ok: false; testFailures: string };

/**
 * Commit gate that finalizes only when the transaction both type-checks
 * (as commit() requires today) AND the corpus's real test suite passes.
 * A compiles-but-behaviorally-wrong change is refused with the failing
 * test output, handed back the same way type diagnostics are.
 */
export function commitWithBehavioralGate(
  db: Db,
  tx: TxHandle,
  acceptance: AcceptanceContext
): GatedCommitResult {
  const diagnostics = validate(db, tx);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const { renderedFiles } = renderPendingModules(db, tx);
  const renderedSrc = new Map<string, string>();
  for (const [absPath, text] of renderedFiles) {
    const rel = path
      .relative(acceptance.srcRoot, absPath)
      .replaceAll("\\", "/");
    renderedSrc.set(rel, text);
  }

  const result = runCorpusAcceptance(renderedSrc, acceptance.corpusRoot);
  if (!result.tscClean || !result.vitestPassed) {
    return { ok: false, testFailures: result.failureOutput };
  }

  materializeStatementPayloads(db, tx);
  commitWithoutValidate(db, tx);
  return { ok: true };
}
```

- [ ] **Step 4: Export it from `packages/verify/src/index.ts`**

Change the first line of `packages/verify/src/index.ts` from:

```typescript
export { commit, validate, type CommitResult, type Diagnostic } from "./validate";
```

to:

```typescript
export {
  commit,
  validate,
  renderPendingModules,
  commitWithBehavioralGate,
  type CommitResult,
  type Diagnostic,
  type AcceptanceContext,
  type GatedCommitResult
} from "./validate";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @strata/verify build && pnpm --filter @strata/verify test`
Expected: PASS — `behavioralGate.test.ts` (2 passing) plus all prior `@strata/verify` tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/verify/src/validate.ts packages/verify/src/index.ts packages/verify/tests/behavioralGate.test.ts
git commit -m "feat(verify): add commitWithBehavioralGate (tests must pass, not just tsc)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the agent gate (live runs only; replay/key-free unchanged)

**Files:**
- Modify: `packages/agent/src/tools.ts`
- Modify: `packages/agent/src/session.ts`

- [ ] **Step 1: Add `acceptance` to the session context and branch the commit tool in `packages/agent/src/tools.ts`**

Change the import on line 21 from:

```typescript
import { commit, validate } from "@strata/verify";
```

to:

```typescript
import {
  commit,
  commitWithBehavioralGate,
  validate,
  type AcceptanceContext
} from "@strata/verify";
```

Change the `StrataSessionContext` interface (lines ~51–54) from:

```typescript
export interface StrataSessionContext {
  db: Db;
  actor: string;
}
```

to:

```typescript
export interface StrataSessionContext {
  db: Db;
  actor: string;
  /**
   * When set, commit_transaction enforces the behavioral gate (corpus tests
   * must pass, not just tsc). Left undefined for replay/key-free runs so the
   * deterministic tsc-only commit() path is preserved.
   */
  acceptance?: AcceptanceContext;
}
```

Replace the `commitTransactionTool` definition (lines ~215–220) with:

```typescript
  const commitTransactionTool = tool(
    "commit_transaction",
    "Finalize the transaction. It finalizes ONLY if the transaction both type-checks AND the project's real test suite passes. If the type-checker reports errors it returns { ok: false, diagnostics }. If the code type-checks but the tests fail it returns { ok: false, testFailures } with the failing test output - the change is NOT finalized; fix the behavior and try again. On a clean type-check with passing tests it finalizes and returns { ok: true }. Type-clean is not done; the tests passing is done.",
    { tx: txHandleSchema },
    async (args) =>
      textResult(
        ctx.acceptance
          ? commitWithBehavioralGate(ctx.db, args.tx as TxHandle, ctx.acceptance)
          : commit(ctx.db, args.tx as TxHandle)
      )
  );
```

- [ ] **Step 2: Thread `acceptance` into the context for non-replay runs in `packages/agent/src/session.ts`**

In `runAgentForPrompt`, replace line 274:

```typescript
    const ctx: StrataSessionContext = { db, actor: params.actor };
```

with:

```typescript
    const ctx: StrataSessionContext = {
      db,
      actor: params.actor,
      // Replay/key-free runs keep the deterministic tsc-only commit() path;
      // only live (model-driven) runs enforce the behavioral gate.
      acceptance: runParams.replayTranscript
        ? undefined
        : { corpusRoot: runParams.corpusRoot, srcRoot }
    };
```

(`srcRoot` is already in scope at line 263: `const srcRoot = path.join(runParams.corpusRoot, "src");`.)

- [ ] **Step 3: Run the full agent suite to verify replay/key-free is unchanged**

Run: `pnpm --filter @strata/verify build && pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS — every existing `@strata/agent` test green, unchanged. The replay path sets `acceptance: undefined`, so `commit_transaction` still calls the tsc-only `commit()` — replay determinism and the transcript fixture are unaffected.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/tools.ts packages/agent/src/session.ts
git commit -m "feat(agent): commit_transaction enforces behavioral gate on live runs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Record the decision

**Files:**
- Modify: `decisions.md`

- [ ] **Step 1: Prepend a newest-first entry**

Insert immediately below the `<!-- New entries go below this line, newest first. -->` line in `decisions.md`:

```markdown
## 2026-05-16 — Behavioral commit gate: corpus runner lowered into @strata/verify; agent gate == scorer

**Context:** RESULTS.md named the next research lever — gate agent commit on behavioral task-acceptance, not just tsc-clean (underlies T08 and post-prompt T01). Spec: `docs/specs/2026-05-16-behavioral-commit-gate-design.md`.

**Considered:** (a) new `run_tests` agent tool the loop must call; (b) hard-gate inside the commit path reusing the existing validate-before-commit machinery; (c) both.

**Decided:** (b). The on-disk render+tsc+vitest runner (`renderStoreToDir`, `tsc*`, `vitestRun`, scope guards, `QualityResult`) moved from `@strata/bench` down into `@strata/verify` (`corpusRun.ts`); `@strata/bench/src/quality.ts` is now a thin re-export. New `runCorpusAcceptance` (captures subprocess output) and `commitWithBehavioralGate` (validate-as-today → corpus acceptance → finalize). The agent's `commit_transaction` calls the gate only for live runs (`acceptance` undefined in replay), so the 170 key-free tests and replay determinism are unchanged.

**Why:** Acyclic (`bench → agent → verify`); the agent finish line and the scorer finish line become one function by construction, removing the diagnosed confident-wrong commit. Additive: `commit()`/`validate()` signatures and behavior untouched.

**Design-doc impact:** none to architecture; sharpens strata-design.md's "validate before commit" gate — necessary but not sufficient; behavioral acceptance is now the agent's finish line for live runs.

**Revisit when:** the operator's keyed re-run (T01/T05/T08 with T03 as the regression guard) reports its finding — recorded as a new newest-first entry whatever the outcome, including "gate works but T05 still thrashes", per the spec's bail signals BG-1..BG-4.
```

- [ ] **Step 2: Commit**

```bash
git add decisions.md
git commit -m "docs(decisions): record behavioral commit gate + runner relocation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Whole-repo green gate

**Files:** none (verification only)

- [ ] **Step 1: Build and test the entire monorepo**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS — all packages build; **170 passing, 2 key-gated skipped** plus the new `@strata/verify` tests from Tasks 1/3/4 (`corpusRun`, `renderPendingModules`, `behavioralGate`). No pre-existing test is modified or fails. If the count of pre-existing passing tests dropped, STOP and diagnose (a behavior-preserving relocation cannot reduce it).

- [ ] **Step 2: Sanity-check the Phase 0/1 CLI paths still work key-free**

Run: `node packages/cli/dist/cli.js t03 ./examples/medium`
Expected: the T03 acceptance prints its programmatic pass exactly as before (the CLI uses tsc-only `commit()`; it is unaffected — this is the **BG-4** T03 regression guard at the substrate level).

- [ ] **Step 3: Final no-op confirmation commit (only if any build artifacts/lockfile changed)**

```bash
git status --porcelain
# If only intended source files are listed and already committed, nothing to do.
# Do NOT commit dist/ or node_modules; they are gitignored.
```

---

## Operator follow-on (NOT part of the buildable plan)

The real proof is a keyed benchmark re-run — an operator action exactly like every prior round, requiring `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03
```

N=1 validation first; N=3 only if the pattern warrants (validation-before-distribution discipline unchanged). Record the finding in `decisions.md` as a new newest-first entry **whatever it is** — gate works / T05 still thrashes / T01 self-collides / gate flaky or slow — honoring bail signals **BG-1..BG-4** from the spec. A diagnosed honest result is the deliverable; a green number is not required.

---

## Self-Review

**Spec coverage:**
- One shared runner lowered into verify → Task 1 + Task 2. ✓
- `runCorpusAcceptance` with captured output → Task 1. ✓
- Render the *pending* tx state (extract from `validate`) → Task 3. ✓
- `commitWithBehavioralGate`, additive, `commit()` untouched → Task 4. ✓
- Agent wiring, live-only, replay/key-free preserved → Task 5. ✓
- Bail signals BG-1..BG-4 → BG-3 in Task 2, BG-4 in Task 7, BG-1/BG-2 are operator-round (Operator follow-on). ✓
- `decisions.md` discipline → Task 6. ✓
- Key-free regression net (170 unchanged) → Task 5 Step 3 + Task 7 Step 1. ✓
- Keyed re-run is operator follow-on, finding logged → Operator follow-on section. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `CorpusAcceptanceResult { tscClean, vitestPassed, failureOutput }` defined in Task 1, consumed identically in Task 4. `GatedCommitResult`/`AcceptanceContext` defined in Task 4, imported by name in Task 5. `renderPendingModules` return shape `{ renderedFiles, sourceMaps }` defined in Task 3, consumed in Task 4. `tscNoEmit`/`vitestRun` gain an additive `output` field; bench destructures only `{ tscClean }`/`{ vitestPassed }` (Task 2 note). ✓
