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
