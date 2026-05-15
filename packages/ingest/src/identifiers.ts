import { nodeId, type NodeRow } from "@strata/store";
import ts from "typescript";

/**
 * Emits one Identifier node per `ts.Identifier` occurrence under a statement.
 * Offsets are relative to the statement's raw `getFullText()` payload.
 */
export function emitIdentifiers(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  modulePath: string,
  statementChildPath: readonly number[]
): NodeRow[] {
  const stmtStart = statement.getFullStart();
  const out: NodeRow[] = [];
  const statementKind = ts.SyntaxKind[statement.kind];
  const parentId = nodeId(modulePath, statementChildPath, statementKind);
  let identifierIndex = 0;

  // Pre-order DFS over getChildren (NOT forEachChild): getChildren includes
  // JSDoc nodes so JSDoc type references are addressable; forEachChild skips
  // them. See decisions.md 2026-05-15 BS1 entry. batch.ts mirrors this walk
  // exactly so identifier indices line up between ingest and resolution.
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const offset = node.getStart(sourceFile) - stmtStart;
      const text = node.text;
      const childPath = [...statementChildPath, identifierIndex];

      out.push({
        id: nodeId(modulePath, childPath, "Identifier"),
        kind: "Identifier",
        parentId,
        childIndex: null,
        payload: JSON.stringify({ text, offset })
      });
      identifierIndex += 1;
    }

    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  }

  visit(statement);
  return out;
}
