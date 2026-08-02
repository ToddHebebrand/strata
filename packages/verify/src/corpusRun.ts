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
import { renderWithSourceMap } from "@strata-code/render";
import { loadModule, type Db } from "@strata-code/store";
import { boundedProcessRun } from "./boundedRun";

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

// When this package is npm-installed, repoRootFromHere() escapes into the
// consumer's node_modules directory and the repo-relative joins below point
// at paths that don't exist. The nearest enclosing node_modules is then the
// dependency root that can resolve vitest/@types for the gate's scratch tree.
function hostNodeModulesFromHere(): string | undefined {
  let dir = __dirname;
  while (true) {
    if (path.basename(dir) === "node_modules") {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function tscNoEmit(treeRoot: string): {
  tscClean: boolean;
  output: string;
} {
  const tsconfig = path.join(treeRoot, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return { tscClean: false, output: "tscNoEmit: no tsconfig.json" };
  }

  // Prefer the corpus's own typescript binary (if installed under its
  // node_modules) — module-resolution defaults differ across TS versions, so
  // running with the corpus's TS matches what the project author intended.
  // Fall back to Strata's TS for bench corpora that don't ship their own.
  const corpusTsc = path.join(
    treeRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc"
  );
  const tscBin = existsSync(corpusTsc)
    ? corpusTsc
    : require.resolve("typescript/bin/tsc");
  const repoTypeRoots = path.join(repoRootFromHere(), "node_modules", "@types");
  const hostNm = hostNodeModulesFromHere();
  const typeRoots =
    !existsSync(repoTypeRoots) && hostNm && existsSync(path.join(hostNm, "@types"))
      ? path.join(hostNm, "@types")
      : repoTypeRoots;
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
  const args = fixtures ? ["run", ...fixtures] : ["run"];
  const result = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: treeRoot,
    encoding: "utf8"
  });
  return {
    vitestPassed: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

export interface CorpusAcceptanceOptions {
  /**
   * When true (bench default), tsc step asserts the corpus tsconfig is
   * src-only — the 1.5-R bench-isolation invariant. When false (freeform
   * agent default), tsc respects whatever scope the project's tsconfig
   * declares, so real projects with tests in include still pass through.
   */
  strictSrcOnlyTscScope?: boolean;
}

/**
 * Materialize rendered src + the corpus's own tests/configs into a scratch
 * tree, then run the type-check and (optionally) the real test suite. This is
 * the single behavioral finish line shared by the agent commit gate and the
 * benchmark scorer.
 */
export function runCorpusAcceptance(
  renderedSrc: Map<string, string>,
  corpusRoot: string,
  fixtures?: readonly string[],
  options: CorpusAcceptanceOptions = {}
): CorpusAcceptanceResult {
  if (renderedSrc.size === 0) {
    return {
      tscClean: false,
      vitestPassed: false,
      failureOutput: "runCorpusAcceptance: no modules rendered"
    };
  }

  const strictSrcOnlyTscScope = options.strictSrcOnlyTscScope !== false;
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

    // The bench corpora use `tests/`; many real-world projects use `test/`.
    // Copy whichever exists so the gate's tsc and vitest see the test files
    // that the corpus tsconfig may include in scope.
    for (const dirName of ["tests", "test"]) {
      const fromDir = path.join(corpusRoot, dirName);
      if (existsSync(fromDir)) {
        cpSync(fromDir, path.join(outRoot, dirName), { recursive: true });
      }
    }

    // Prefer the corpus's own node_modules when present (the project's real
    // deps); fall back to the Strata repo's node_modules so the bench corpora
    // (which have no own deps) still resolve @types.
    const corpusNodeModules = path.join(corpusRoot, "node_modules");
    const repoNodeModules = path.join(repoRootFromHere(), "node_modules");
    const tmpNodeModules = path.join(outRoot, "node_modules");
    const hostNodeModules = hostNodeModulesFromHere();
    if (existsSync(corpusNodeModules)) {
      symlinkSync(corpusNodeModules, tmpNodeModules, "dir");
    } else if (existsSync(repoNodeModules)) {
      symlinkSync(repoNodeModules, tmpNodeModules, "dir");
    } else if (hostNodeModules && existsSync(hostNodeModules)) {
      symlinkSync(hostNodeModules, tmpNodeModules, "dir");
    }

    const tsc = strictSrcOnlyTscScope
      ? tscNoEmitSrc(outRoot)
      : tscNoEmit(outRoot);
    const vitest = vitestRun(outRoot, fixtures);
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

// ---------------------------------------------------------------------------
// Bounded (process-group) siblings — B-2 behavioral gate, Task 6.
//
// Everything above this line is the SYNC product path and stays byte-identical:
// `tscNoEmit` / `vitestRun` / `runCorpusAcceptance` are what the CLI, bench and
// agent commit gate call, and they keep `spawnSync`'s unbounded semantics.
//
// Below are async siblings used by the coordination worker, where an unbounded
// tsc or vitest would hold a claim past every deadline in the system. They run
// the SAME argv through `boundedProcessRun`, which spawns the child as its own
// process group and SIGKILLs the group on timeout — vitest forks pools of
// workers, and killing only the direct child would leave them running against
// the scratch tree. The argv derivation is deliberately duplicated rather than
// factored out of the sync functions: the constraint on this task is that the
// product path's bytes do not move.
// ---------------------------------------------------------------------------

export interface BoundedQualityResult {
  tscClean: boolean;
  output: string;
  timedOut: boolean;
}

export interface BoundedVitestResult {
  vitestPassed: boolean;
  output: string;
  timedOut: boolean;
}

export interface BoundedCorpusAcceptanceResult extends CorpusAcceptanceResult {
  /** The tsc step exhausted `tscTimeoutMs` and its process group was killed. */
  tscTimedOut: boolean;
  /** The vitest step exhausted `vitestTimeoutMs` and its group was killed. */
  vitestTimedOut: boolean;
}

/** The exact argv `tscNoEmit` runs, resolved without spawning anything. */
function tscArgv(treeRoot: string): string[] | undefined {
  const tsconfig = path.join(treeRoot, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return undefined;
  }
  const corpusTsc = path.join(
    treeRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc"
  );
  const tscBin = existsSync(corpusTsc)
    ? corpusTsc
    : require.resolve("typescript/bin/tsc");
  const repoTypeRoots = path.join(repoRootFromHere(), "node_modules", "@types");
  const hostNm = hostNodeModulesFromHere();
  const typeRoots =
    !existsSync(repoTypeRoots) && hostNm && existsSync(path.join(hostNm, "@types"))
      ? path.join(hostNm, "@types")
      : repoTypeRoots;
  return [tscBin, "--noEmit", "-p", tsconfig, "--typeRoots", typeRoots];
}

/** Async, process-group-bounded sibling of {@link tscNoEmit}. */
export async function boundedTscNoEmit(
  treeRoot: string,
  timeoutMs: number
): Promise<BoundedQualityResult> {
  const args = tscArgv(treeRoot);
  if (args === undefined) {
    return {
      tscClean: false,
      output: "tscNoEmit: no tsconfig.json",
      timedOut: false
    };
  }
  const run = await boundedProcessRun({
    command: process.execPath,
    args,
    cwd: treeRoot,
    timeoutMs
  });
  return {
    tscClean: !run.timedOut && run.status === 0,
    output: run.timedOut
      ? `tsc exceeded its ${timeoutMs}ms budget and its process group was killed\n` +
        `${run.stdout}${run.stderr}`
      : `${run.stdout}${run.stderr}`,
    timedOut: run.timedOut
  };
}

/** Async, process-group-bounded sibling of {@link vitestRun}. */
export async function boundedRunVitest(
  treeRoot: string,
  fixtures: readonly string[] | undefined,
  timeoutMs: number
): Promise<BoundedVitestResult> {
  if (fixtures !== undefined) {
    if (fixtures.length === 0) {
      return { vitestPassed: true, output: "", timedOut: false };
    }
    const missing = fixtures.filter((f) => !existsSync(path.join(treeRoot, f)));
    if (missing.length > 0) {
      return {
        vitestPassed: false,
        output: `vitestRun: scoped fixture(s) not found: ${missing.join(", ")}`,
        timedOut: false
      };
    }
  }

  if (!hasVitestFiles(treeRoot)) {
    return { vitestPassed: true, output: "", timedOut: false };
  }

  const vitestBin = require.resolve("vitest/vitest.mjs");
  const args = fixtures ? ["run", ...fixtures] : ["run"];
  const run = await boundedProcessRun({
    command: process.execPath,
    args: [vitestBin, ...args],
    cwd: treeRoot,
    timeoutMs
  });
  return {
    vitestPassed: !run.timedOut && run.status === 0,
    output: run.timedOut
      ? `vitest exceeded its ${timeoutMs}ms budget and its process group was killed\n` +
        `${run.stdout}${run.stderr}`
      : `${run.stdout}${run.stderr}`,
    timedOut: run.timedOut
  };
}

/** Materializes the acceptance scratch tree; the bounded path's own copy. */
function materializeAcceptanceTree(
  renderedSrc: Map<string, string>,
  corpusRoot: string,
  outRoot: string
): void {
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

  for (const dirName of ["tests", "test"]) {
    const fromDir = path.join(corpusRoot, dirName);
    if (existsSync(fromDir)) {
      cpSync(fromDir, path.join(outRoot, dirName), { recursive: true });
    }
  }

  const corpusNodeModules = path.join(corpusRoot, "node_modules");
  const repoNodeModules = path.join(repoRootFromHere(), "node_modules");
  const tmpNodeModules = path.join(outRoot, "node_modules");
  const hostNodeModules = hostNodeModulesFromHere();
  if (existsSync(corpusNodeModules)) {
    symlinkSync(corpusNodeModules, tmpNodeModules, "dir");
  } else if (existsSync(repoNodeModules)) {
    symlinkSync(repoNodeModules, tmpNodeModules, "dir");
  } else if (hostNodeModules && existsSync(hostNodeModules)) {
    symlinkSync(hostNodeModules, tmpNodeModules, "dir");
  }
}

export interface BoundedCorpusAcceptanceOptions extends CorpusAcceptanceOptions {
  tscTimeoutMs: number;
  vitestTimeoutMs: number;
}

/**
 * Async, per-step-bounded sibling of {@link runCorpusAcceptance}. A step that
 * exhausts its budget has its whole process group killed before this resolves,
 * and reports through `tscTimedOut` / `vitestTimedOut` — an OPERATIONAL outcome
 * upstream ("we could not finish judging"), never a candidate rejection.
 */
export async function runCorpusAcceptanceBounded(
  renderedSrc: Map<string, string>,
  corpusRoot: string,
  fixtures: readonly string[] | undefined,
  options: BoundedCorpusAcceptanceOptions
): Promise<BoundedCorpusAcceptanceResult> {
  if (renderedSrc.size === 0) {
    return {
      tscClean: false,
      vitestPassed: false,
      failureOutput: "runCorpusAcceptance: no modules rendered",
      tscTimedOut: false,
      vitestTimedOut: false
    };
  }

  const strictSrcOnlyTscScope = options.strictSrcOnlyTscScope !== false;
  const outRoot = mkdtempSync(path.join(tmpdir(), "strata-accept-"));
  try {
    materializeAcceptanceTree(renderedSrc, corpusRoot, outRoot);

    if (strictSrcOnlyTscScope) {
      assertSrcOnlyScope(outRoot);
    }
    const tsc = await boundedTscNoEmit(outRoot, options.tscTimeoutMs);
    // A timed-out tsc short-circuits: there is no point spending the vitest
    // budget on a tree we could not even type-check.
    const vitest = tsc.timedOut
      ? { vitestPassed: false, output: "", timedOut: false }
      : await boundedRunVitest(outRoot, fixtures, options.vitestTimeoutMs);
    const failureOutput =
      tsc.tscClean && vitest.vitestPassed
        ? ""
        : `--- tsc ---\n${tsc.output}\n--- vitest ---\n${vitest.output}`;
    return {
      tscClean: tsc.tscClean,
      vitestPassed: vitest.vitestPassed,
      failureOutput,
      tscTimedOut: tsc.timedOut,
      vitestTimedOut: vitest.timedOut
    };
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}
