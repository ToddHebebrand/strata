import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T01Criteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  signatureHasTimezone: boolean;
  defaultIsUtcString: boolean;
  serverCallsitesUtc: boolean;
  uiCallsitesLocalOrDefault: boolean;
  hofCallsiteNotMisedited: boolean;
  operationRowAppended: boolean;
}

export type T01TextCriteria = Pick<
  T01Criteria,
  | "signatureHasTimezone"
  | "defaultIsUtcString"
  | "serverCallsitesUtc"
  | "uiCallsitesLocalOrDefault"
  | "hofCallsiteNotMisedited"
>;

export function evaluateT01TextCriteria(
  modules: Map<string, string>
): T01TextCriteria {
  const format = mustGet(modules, "lib/format.ts");
  const server = mustGet(modules, "server/events.ts");
  const ui = mustGet(modules, "ui/timeline.ts");

  return {
    signatureHasTimezone:
      /function\s+formatTimestamp\s*\(\s*ts\s*:\s*number\s*,\s*timezone\s*:\s*string/.test(
        format
      ),
    defaultIsUtcString: /timezone\s*:\s*string\s*=\s*"UTC"/.test(format),
    serverCallsitesUtc:
      allFormatCallsHaveSecondArg(server, '"UTC"') &&
      countFormatCalls(server) >= 2,
    uiCallsitesLocalOrDefault:
      /formatTimestamp\(\s*0\s*,\s*"local"\s*\)/.test(ui),
    hofCallsiteNotMisedited: /\.map\(\s*formatTimestamp\s*\)/.test(ui)
  };
}

export interface T01Batch {
  modules: { path: string; moduleId: string }[];
}

export interface T01CriteriaInput {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  txId: string;
}

interface OperationRow {
  tx_id: string;
  kind: string;
}

export function evaluateT01Criteria(
  db: Db,
  batch: T01Batch,
  srcRoot: string,
  input: T01CriteriaInput
): T01Criteria & { rendered: Map<string, string> } {
  const rendered = renderedModules(db, batch, srcRoot);
  const text = evaluateT01TextCriteria(rendered);
  const operations = db
    .prepare(`SELECT tx_id, kind FROM operations`)
    .all() as OperationRow[];

  return withRendered({
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operations.some(
      (operation) =>
        operation.tx_id === input.txId && operation.kind === "AddParameter"
    )
  }, rendered);
}

function renderedModules(
  db: Db,
  batch: T01Batch,
  srcRoot: string
): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const module of batch.modules) {
    rendered.set(toPosix(path.relative(srcRoot, module.path)), renderModule(db, module.moduleId));
  }
  return rendered;
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

function allFormatCallsHaveSecondArg(text: string, expected: string): boolean {
  const calls = text.match(/formatTimestamp\(([^)]*)\)/g) ?? [];
  return (
    calls.length > 0 &&
    calls.every((call) => {
      const args = call.slice(call.indexOf("(") + 1, -1).split(",");
      return args[1]?.trim() === expected;
    })
  );
}

function countFormatCalls(text: string): number {
  return text.match(/formatTimestamp\(/g)?.length ?? 0;
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
