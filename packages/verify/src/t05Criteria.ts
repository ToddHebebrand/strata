import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T05Criteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  comparisonIsHalfOpen: boolean;
  noClosedIntervalRemains: boolean;
  testFileByteIdentical: boolean;
  operationRowAppended: boolean;
}

export type T05TextCriteria = Pick<
  T05Criteria,
  "comparisonIsHalfOpen" | "noClosedIntervalRemains" | "testFileByteIdentical"
>;

export const T05_TEST_KEY = "__test__/dateRange.test.ts";

export function evaluateT05TextCriteria(
  modules: Map<string, string>,
  seedTestText: string
): T05TextCriteria {
  const dateRange = mustGet(modules, "lib/dateRange.ts");
  return {
    comparisonIsHalfOpen:
      /date\s*>=\s*start\s*&&\s*date\s*<\s*end/.test(dateRange),
    noClosedIntervalRemains:
      !/date\s*<=\s*end/.test(dateRange) &&
      !/date\s*>=\s*start\s*&&\s*date\s*<=\s*end/.test(dateRange),
    testFileByteIdentical: modules.get(T05_TEST_KEY) === seedTestText
  };
}

export interface T05Batch {
  modules: { path: string; moduleId: string }[];
}

export interface T05CriteriaInput {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  txId: string;
  seedTestText: string;
}

interface OperationRow {
  tx_id: string;
  kind: string;
}

export function evaluateT05Criteria(
  db: Db,
  batch: T05Batch,
  srcRoot: string,
  input: T05CriteriaInput
): T05Criteria & { rendered: Map<string, string> } {
  const rendered = new Map<string, string>();
  for (const module of batch.modules) {
    rendered.set(
      toPosix(path.relative(srcRoot, module.path)),
      renderModule(db, module.moduleId)
    );
  }
  const scored = new Map(rendered);
  scored.set(T05_TEST_KEY, input.seedTestText);

  const text = evaluateT05TextCriteria(scored, input.seedTestText);
  const operations = db
    .prepare(`SELECT tx_id, kind FROM operations`)
    .all() as OperationRow[];

  return withRendered({
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operations.some(
      (operation) =>
        operation.tx_id === input.txId && operation.kind === "ReplaceBody"
    )
  }, rendered);
}

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
}

function withRendered<T extends object>(
  criteria: T,
  rendered: Map<string, string>
): T & { rendered: Map<string, string> } {
  Object.defineProperty(criteria, "rendered", {
    value: rendered,
    enumerable: false
  });
  return criteria as T & { rendered: Map<string, string> };
}

function mustGet(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing rendered module: ${key}`);
  }
  return value;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
