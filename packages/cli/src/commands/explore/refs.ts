import {
  findNodeById,
  getReferences,
  modulePathOf,
  type Db
} from "@strata-code/store";
import {
  fail,
  firstLine,
  ok,
  okJson,
  printTable,
  type CommandResult
} from "./format";

interface RefRow {
  fromNodeId: string;
  kind: string;
  module: string;
  context: string;
}

/**
 * The reference graph is the capability files cannot offer — every resolved
 * use site of a declaration, with the module and enclosing statement context.
 */
export function runRefs(db: Db, nodeId: string, json: boolean): CommandResult {
  const declaration = findNodeById(db, nodeId);
  if (!declaration) {
    return fail(
      `no node with id \`${nodeId}\`; run \`strata find\`/\`strata modules\` to list ids`
    );
  }

  const rows: RefRow[] = getReferences(db, nodeId).map((reference) => {
    let module = "<unknown>";
    try {
      module = modulePathOf(db, reference.fromNodeId);
    } catch {
      // orphaned identifier — surface the edge anyway
    }
    const identifier = findNodeById(db, reference.fromNodeId);
    const statement = identifier?.parentId
      ? findNodeById(db, identifier.parentId)
      : undefined;
    return {
      fromNodeId: reference.fromNodeId,
      kind: reference.kind,
      module,
      context: statement ? firstLine(statement.payload) : ""
    };
  });

  if (json) return okJson(rows);
  if (rows.length === 0) {
    return ok(`no references to \`${nodeId}\``);
  }
  const byModule = new Set(rows.map((row) => row.module)).size;
  const table = printTable(
    ["ID", "KIND", "MODULE", "CONTEXT"],
    rows.map((row) => [row.fromNodeId, row.kind, row.module, row.context])
  );
  return ok(`${table}\n\n${rows.length} references across ${byModule} modules`);
}
