import { listModuleExports, listModules, type Db } from "@strata/store";
import {
  fail,
  kindLabel,
  ok,
  okJson,
  printTable,
  type CommandResult
} from "./format";

/**
 * Resolve a module by path suffix (e.g. "store.ts" or "server/events.ts") so
 * a person needn't type the absolute ingest path. Ambiguity is an error that
 * lists the candidates.
 */
export function runExports(
  db: Db,
  moduleSuffix: string,
  json: boolean
): CommandResult {
  const matches = listModules(db).filter(
    (module) =>
      module.payload === moduleSuffix || module.payload.endsWith(moduleSuffix)
  );
  if (matches.length === 0) {
    return fail(
      `no module matching \`${moduleSuffix}\`; run \`strata modules <source>\` to list modules`
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `  ${m.payload}`).join("\n");
    return fail(
      `module suffix \`${moduleSuffix}\` is ambiguous; candidates:\n${candidates}`
    );
  }

  const moduleNode = matches[0]!;
  const exports = listModuleExports(db, moduleNode.id);
  if (json) return okJson(exports);
  if (exports.length === 0) {
    return ok(`no top-level declarations in ${moduleNode.payload}`);
  }
  return ok(
    printTable(
      ["ID", "KIND", "EXPORTED", "NAME"],
      exports.map((entry) => [
        entry.id,
        kindLabel(entry.kind),
        entry.isExported ? "yes" : "no",
        entry.name ?? "<unnamed>"
      ])
    )
  );
}
