// Gate 3 (unkeyed noninferiority), Task 1: replicated-corpus builders.
//
// Later gate-3 timing harnesses need a corpus that is a lot bigger than the
// 22-module `examples/medium` (to get a measurable wall-clock signal) but
// structurally identical to it (so the same rename-class task still makes
// sense). This module produces that corpus by copying `examples/medium/src`
// verbatim into N sibling directories `src/copyNN/**` under an output root.
//
// Collision safety: every declaration in `examples/medium` (including
// `User` in `src/types/user.ts`) is module-scoped and every import inside
// `examples/medium/src` is relative (`./...`, `../...`) or a bare `node:`/
// `vitest` specifier (verified by grep — no bare package-name imports). So
// each `src/copyNN/` tree is self-contained: copies never reference each
// other, and replicated `User` declarations never collide.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildCorpusInputs } from "../tasks.js";

export interface ReplicatedCorpusRenameTarget {
  /** Corpus-relative POSIX path, e.g. "src/copy07/types/user.ts". */
  modulePath: string;
  declarationName: "User";
  newName: "Account";
}

export interface ReplicatedCorpus {
  /** Absolute path to the built corpus root (contains src/, tsconfig.json, package.json). */
  corpusRoot: string;
  /** copies * <medium src module count>. */
  moduleCount: number;
  copies: number;
  renameTarget: ReplicatedCorpusRenameTarget;
  /** sha256 over the sorted {relPath: sha256(text)} map. */
  corpusDigest: string;
}

/**
 * Number of `.ts` modules under `examples/medium/src`, derived by actually
 * scanning that tree through the same `buildCorpusInputs` scan the built
 * corpus is later re-scanned with (not a hard-coded literal) — so this
 * constant can never drift from the real source corpus.
 */
const packageRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const DEFAULT_SOURCE_CORPUS_ROOT = resolve(repoRoot, "examples", "medium");

export const MEDIUM_SRC_MODULE_COUNT = buildCorpusInputs(DEFAULT_SOURCE_CORPUS_ROOT).length;

/** ~1012 modules (46 * 22) — the gate-3 "big" corpus size. */
export const BIG1K_COPIES = 46;
/** 1 copy (22 modules) — the RSS/timing baseline control. */
export const BASELINE_COPIES = 1;

/** Preferred copy index for the fixed rename target, degraded to fit small `copies`. */
const PREFERRED_RENAME_COPY_INDEX = 7;

const RENAME_DECLARATION_MODULE_REL = "types/user.ts";
const RENAME_DECLARATION_NAME = "User";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function copyIndexName(index: number, totalCopies: number): string {
  const width = Math.max(2, String(totalCopies - 1).length);
  return `copy${String(index).padStart(width, "0")}`;
}

/**
 * Builds `copies` self-contained replicas of `sourceCorpusRoot/src` under
 * `outDir/src/copyNN/**` (zero-padded `NN`), plus a root `tsconfig.json`
 * (cloning the source corpus's compiler options with
 * `include: ["src/**\/*.ts"]`) and a minimal `package.json` — the exact
 * layout `buildCorpusInputs` (tasks.ts) scans.
 */
export function buildReplicatedCorpus(
  sourceCorpusRoot: string,
  outDir: string,
  copies: number
): ReplicatedCorpus {
  if (!Number.isInteger(copies) || copies < 1) {
    throw new Error(`buildReplicatedCorpus: copies must be a positive integer, got ${copies}`);
  }

  const resolvedSource = resolve(sourceCorpusRoot);
  const resolvedOut = resolve(outDir);
  const sourceInputs = buildCorpusInputs(resolvedSource);
  if (sourceInputs.length === 0) {
    throw new Error(`buildReplicatedCorpus: no source modules found under ${resolvedSource}/src`);
  }

  mkdirSync(resolvedOut, { recursive: true });

  const digestByRelPath: Record<string, string> = {};
  let renameModulePath: string | undefined;

  for (let copyIndex = 0; copyIndex < copies; copyIndex++) {
    const copyName = copyIndexName(copyIndex, copies);
    for (const input of sourceInputs) {
      // input.path is corpus-relative and always starts with "src/"
      // (buildCorpusInputs scans <corpusRoot>/src).
      const withinSrc = input.path.slice("src/".length);
      const destRelPath = `src/${copyName}/${withinSrc}`;
      const destAbsPath = join(resolvedOut, ...destRelPath.split("/"));
      mkdirSync(dirname(destAbsPath), { recursive: true });
      writeFileSync(destAbsPath, input.text, "utf8");
      digestByRelPath[destRelPath] = sha256Hex(input.text);

      if (withinSrc === RENAME_DECLARATION_MODULE_REL) {
        const preferredCopyName = copyIndexName(
          Math.min(copies - 1, PREFERRED_RENAME_COPY_INDEX),
          copies
        );
        if (copyName === preferredCopyName) {
          renameModulePath = destRelPath;
        }
      }
    }
  }

  if (renameModulePath === undefined) {
    throw new Error(
      `buildReplicatedCorpus: source corpus at ${resolvedSource} has no ${RENAME_DECLARATION_MODULE_REL} ` +
        `(expected to find "interface ${RENAME_DECLARATION_NAME}" there)`
    );
  }

  writeFileSync(join(resolvedOut, "tsconfig.json"), buildTsconfigJson(resolvedSource), "utf8");
  writeFileSync(join(resolvedOut, "package.json"), buildPackageJson(), "utf8");

  const corpusDigest = sha256Hex(
    JSON.stringify(
      Object.keys(digestByRelPath)
        .sort()
        .map((relPath) => [relPath, digestByRelPath[relPath]])
    )
  );

  return {
    corpusRoot: resolvedOut,
    moduleCount: copies * sourceInputs.length,
    copies,
    renameTarget: {
      modulePath: renameModulePath,
      declarationName: RENAME_DECLARATION_NAME,
      newName: "Account"
    },
    corpusDigest
  };
}

function buildTsconfigJson(sourceCorpusRoot: string): string {
  const sourceTsconfigPath = join(sourceCorpusRoot, "tsconfig.json");
  if (!existsSync(sourceTsconfigPath)) {
    throw new Error(`buildReplicatedCorpus: source corpus is missing tsconfig.json at ${sourceTsconfigPath}`);
  }
  const sourceTsconfig = JSON.parse(readFileSync(sourceTsconfigPath, "utf8")) as {
    compilerOptions?: Record<string, unknown>;
  };
  return JSON.stringify(
    {
      compilerOptions: sourceTsconfig.compilerOptions ?? {},
      include: ["src/**/*.ts"]
    },
    null,
    2
  );
}

function buildPackageJson(): string {
  return JSON.stringify(
    {
      name: "@strata-examples/gate3-replicated-corpus",
      version: "0.0.0",
      private: true,
      type: "module"
    },
    null,
    2
  );
}
