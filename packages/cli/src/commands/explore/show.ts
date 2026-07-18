import { modulePathOf, readNode, type Db } from "@strata-code/store";
import { fail, ok, okJson, type CommandResult } from "./format";

const UNKNOWN_ID_HINT =
  "run `strata find`/`strata modules` to list ids";

export function runShow(db: Db, nodeId: string, json: boolean): CommandResult {
  const result = readNode(db, nodeId, { includeChildren: true });
  if (!result) {
    return fail(`no node with id \`${nodeId}\`; ${UNKNOWN_ID_HINT}`);
  }

  let module = "<unknown>";
  try {
    module = modulePathOf(db, nodeId);
  } catch {
    // orphaned node — show it anyway
  }

  if (json) return okJson({ ...result, module });

  const lines: string[] = [
    `id:     ${result.node.id}`,
    `kind:   ${result.node.kind}`,
    `module: ${module}`,
    ""
  ];
  lines.push(result.node.payload);
  if (result.children && result.children.length > 0) {
    const byKind = new Map<string, number>();
    for (const child of result.children) {
      byKind.set(child.kind, (byKind.get(child.kind) ?? 0) + 1);
    }
    const summary = [...byKind.entries()]
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    lines.push("", `children: ${result.children.length} (${summary})`);
  }
  if (result.bodyStatements && result.bodyStatements.length > 0) {
    lines.push("", "body statements:");
    for (const statement of result.bodyStatements) {
      lines.push(`  [${statement.index}] ${firstLineOf(statement.text)}`);
    }
  }
  return ok(lines.join("\n"));
}

function firstLineOf(text: string): string {
  return text.trimStart().split("\n", 1)[0] ?? "";
}
