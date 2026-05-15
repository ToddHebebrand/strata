import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

interface T03Batch {
  modules: { path: string; moduleId: string }[];
}

export interface QualityResult {
  tscClean: boolean;
  vitestPassed: boolean;
}

/** Render committed store modules to a scratch tree that mirrors corpus src/. */
export function renderStoreToDir(
  db: Db,
  batch: T03Batch,
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

export function tscNoEmit(treeRoot: string): { tscClean: boolean } {
  const tsconfig = path.join(treeRoot, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return { tscClean: false };
  }

  const tscBin = require.resolve("typescript/bin/tsc");
  const typeRoots = path.join(repoRootFromHere(), "node_modules", "@types");
  const result = spawnSync(
    process.execPath,
    [tscBin, "--noEmit", "-p", tsconfig, "--typeRoots", typeRoots],
    { cwd: treeRoot, encoding: "utf8" }
  );
  return { tscClean: result.status === 0 };
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

export function tscNoEmitSrc(treeRoot: string): { tscClean: boolean } {
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

export function vitestRun(treeRoot: string): { vitestPassed: boolean } {
  if (!hasVitestFiles(treeRoot)) {
    return { vitestPassed: true };
  }

  const vitestBin = require.resolve("vitest/vitest.mjs");
  const result = spawnSync(process.execPath, [vitestBin, "run"], {
    cwd: treeRoot,
    encoding: "utf8"
  });
  return { vitestPassed: result.status === 0 };
}
