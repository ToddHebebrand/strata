import {
  findDeclarationsInModule,
  listModules,
  type Db
} from "@strata-code/store";
import { ok, okJson, printTable, type CommandResult } from "./format";

export function runModules(db: Db, json: boolean): CommandResult {
  const rows = listModules(db)
    .map((module) => ({
      id: module.id,
      path: module.payload,
      declarations: findDeclarationsInModule(db, { moduleId: module.id }).length
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (json) return okJson(rows);
  if (rows.length === 0) return ok("no modules in this store");
  return ok(
    printTable(
      ["ID", "DECLS", "MODULE"],
      rows.map((row) => [row.id, String(row.declarations), row.path])
    )
  );
}
