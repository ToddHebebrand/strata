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

/**
 * The text of the `describeRole` caller only (declaration through end of
 * module). `callersTypecheckUnderNarrowType` is about how the *caller*
 * consumes the narrowed return type, so it must be scoped to the caller:
 * a coincidental `role === "admin"` inside `getRole`'s own body must not
 * satisfy it (the pre-2026-05-16 whole-module scan did, a false positive),
 * and the equally type-safe `switch (role) { case "admin": }` form must be
 * accepted, not just `if (role === "admin")` (the whole-module scan
 * rejected it, a false negative — see decisions.md 2026-05-16 T08 entry).
 */
function describeRoleRegion(permissions: string): string {
  const i = permissions.search(/function\s+describeRole\b/);
  return i === -1 ? "" : permissions.slice(i);
}

export function evaluateT08TextCriteria(
  modules: Map<string, string>
): T08TextCriteria {
  const permissions = mustGet(modules, "lib/permissions.ts");
  const caller = describeRoleRegion(permissions);
  const bindsNarrowedResultWithoutCast =
    /const\s+role\s*=\s*getRole\(\s*userId\s*\)\s*;/.test(caller) &&
    !/getRole\([^)]*\)\s*as\s+\w/.test(caller);
  const discriminates = (member: string): boolean =>
    new RegExp(`role\\s*===\\s*"${member}"`).test(caller) ||
    new RegExp(`case\\s+"${member}"\\s*:`).test(caller);
  return {
    returnTypeIsLiteralUnion:
      /function\s+getRole\s*\([^)]*\)\s*:\s*"admin"\s*\|\s*"editor"\s*\|\s*"viewer"/.test(
        permissions
      ),
    noAsStringCastOnResult:
      !/getRole\([^)]*\)\s*as\s+string\b/.test(permissions),
    callersTypecheckUnderNarrowType:
      bindsNarrowedResultWithoutCast &&
      discriminates("admin") &&
      discriminates("editor")
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
): T08Criteria & { rendered: Map<string, string> } {
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

  return withRendered({
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operations.some(
      (operation) =>
        operation.tx_id === input.txId && operation.kind === "ChangeReturnType"
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
