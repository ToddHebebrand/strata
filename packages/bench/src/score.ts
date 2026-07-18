import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  evaluateT01TextCriteria,
  evaluateT03TextCriteria,
  evaluateT05TextCriteria,
  evaluateT08TextCriteria,
  T05_TEST_KEY,
  type T03TextCriteria
} from "@strata-code/verify";
import type { BenchTaskId } from "./tasks";

/**
 * The TEN shared criteria judged identically for both configs: the nine
 * text-derived criteria from evaluateT03TextCriteria plus the symmetric
 * commitReturnedOk / validateAfterCommitClean pair. operationRowAppended is
 * a substrate-only sub-metric and is not part of this shared bar.
 */
export interface SharedCriteria extends T03TextCriteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}

/**
 * Read post-edit TypeScript text off a working tree's src/ root into a Map
 * keyed by POSIX path relative to that root. This is the baseline analog of
 * the substrate rendering committed modules to final source text.
 */
export function readModuleMap(srcRoot: string): Map<string, string> {
  const map = new Map<string, string>();

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        map.set(
          path.relative(srcRoot, abs).replaceAll("\\", "/"),
          readFileSync(abs, "utf8")
        );
      }
    }
  }

  walk(srcRoot);
  return map;
}

export interface ScoreInput {
  /** modulePath (POSIX, relative to src/) -> final source text. */
  modules: Map<string, string>;
  /** Baseline analog of "commit returned ok" (spec § symmetric pair). */
  commitReturnedOk: boolean;
  /** Baseline analog of "post-change tsc --noEmit clean". */
  validateAfterCommitClean: boolean;
}

export function scoreSharedCriteria(input: ScoreInput): SharedCriteria {
  const text = evaluateT03TextCriteria(input.modules);
  return {
    ...text,
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true
  };
}

export function isSharedSuccess(criteria: SharedCriteria): boolean {
  return Object.values(criteria).every((value) => value === true);
}

export function scoreBaselineWorkingTree(input: {
  srcRoot: string;
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}): SharedCriteria {
  return scoreSharedCriteria({
    modules: readModuleMap(input.srcRoot),
    commitReturnedOk: input.commitReturnedOk,
    validateAfterCommitClean: input.validateAfterCommitClean
  });
}

export type TaskSharedCriteria = Record<string, boolean>;

export function scoreTaskSharedCriteria(
  taskId: BenchTaskId,
  input: ScoreInput & { seedTestText?: string; testFileText?: string }
): TaskSharedCriteria {
  let text: Record<string, boolean>;
  if (taskId === "T01") {
    text = { ...evaluateT01TextCriteria(input.modules) };
  } else if (taskId === "T03") {
    text = { ...evaluateT03TextCriteria(input.modules) };
  } else if (taskId === "T05") {
    const modules = new Map(input.modules);
    modules.set(T05_TEST_KEY, input.testFileText ?? "");
    text = {
      ...evaluateT05TextCriteria(modules, input.seedTestText ?? "")
    };
  } else {
    text = { ...evaluateT08TextCriteria(input.modules) };
  }

  return {
    ...text,
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true
  };
}

export function isTaskSharedSuccess(criteria: TaskSharedCriteria): boolean {
  return Object.values(criteria).every((value) => value === true);
}

export function scoreBaselineTask(input: {
  taskId: BenchTaskId;
  srcRoot: string;
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  seedTestText?: string;
  testFileText?: string;
}): { criteria: TaskSharedCriteria; success: boolean } {
  const criteria = scoreTaskSharedCriteria(input.taskId, {
    modules: readModuleMap(input.srcRoot),
    commitReturnedOk: input.commitReturnedOk,
    validateAfterCommitClean: input.validateAfterCommitClean,
    seedTestText: input.seedTestText,
    testFileText: input.testFileText
  });
  return { criteria, success: isTaskSharedSuccess(criteria) };
}
