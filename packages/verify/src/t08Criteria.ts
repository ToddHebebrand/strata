import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T08Criteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  returnTypeIsLiteralUnion: boolean;
  noAsStringCastOnResult: boolean;
  callersTypecheckUnderNarrowType: boolean;
  operationRowAppended: boolean;
}

export type T08TextCriteria = Pick<
  T08Criteria,
  | "returnTypeIsLiteralUnion"
  | "noAsStringCastOnResult"
  | "callersTypecheckUnderNarrowType"
>;

export function evaluateT08TextCriteria(
  modules: Map<string, string>
): T08TextCriteria {
  const permissions = mustGet(modules, "lib/permissions.ts");
  return {
    returnTypeIsLiteralUnion:
      /function\s+getRole\s*\([^)]*\)\s*:\s*"admin"\s*\|\s*"editor"\s*\|\s*"viewer"/.test(
        permissions
      ),
    noAsStringCastOnResult:
      !/getRole\([^)]*\)\s*as\s+string\b/.test(permissions),
    callersTypecheckUnderNarrowType:
      /const\s+role\s*=\s*getRole\(\s*userId\s*\)\s*;/.test(permissions) &&
      /role\s*===\s*"admin"/.test(permissions) &&
      /role\s*===\s*"editor"/.test(permissions)
  };
}

export interface T08Batch {
  modules: { path: string; moduleId: string }[];
}

export interface T08CriteriaInput {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  txId: string;
}

interface OperationRow {
  tx_id: string;
  kind: string;
}

export function evaluateT08Criteria(
  db: Db,
  batch: T08Batch,
  srcRoot: string,
  input: T08CriteriaInput
): T08Criteria {
  const rendered = new Map<string, string>();
  for (const module of batch.modules) {
    rendered.set(
      toPosix(path.relative(srcRoot, module.path)),
      renderModule(db, module.moduleId)
    );
  }
  const text = evaluateT08TextCriteria(rendered);
  const operations = db
    .prepare(`SELECT tx_id, kind FROM operations`)
    .all() as OperationRow[];

  return {
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operations.some(
      (operation) =>
        operation.tx_id === input.txId && operation.kind === "ChangeReturnType"
    )
  };
}

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
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
