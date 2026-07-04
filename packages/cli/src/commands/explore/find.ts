import { findDeclarations, type Db, type DeclarationKind } from "@strata/store";
import {
  fail,
  kindLabel,
  nodeSummary,
  ok,
  okJson,
  printTable,
  type CommandResult
} from "./format";

const DECLARATION_KINDS: DeclarationKind[] = [
  "interface",
  "type-alias",
  "class",
  "function",
  "variable"
];

export function runFind(
  db: Db,
  name: string,
  kind: string | undefined,
  json: boolean
): CommandResult {
  if (kind !== undefined && !DECLARATION_KINDS.includes(kind as DeclarationKind)) {
    return fail(
      `unknown --kind \`${kind}\`; expected one of: ${DECLARATION_KINDS.join(", ")}`
    );
  }
  const rows = findDeclarations(db, {
    name,
    kind: kind as DeclarationKind | undefined
  });
  const summaries = rows.map((row) => nodeSummary(db, row));

  if (json) return okJson(summaries);
  if (summaries.length === 0) {
    return ok(`no declarations matching \`${name}\``);
  }
  return ok(
    printTable(
      ["ID", "KIND", "NAME", "MODULE"],
      summaries.map((summary) => [
        summary.id,
        kindLabel(summary.kind),
        summary.name ?? "<unnamed>",
        summary.module
      ])
    )
  );
}
