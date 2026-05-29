import { nodeId } from "./ids";
import { findNodeById, insertNodes, listChildren } from "./nodes";
import type { Db } from "./schema";
import {
  trackDeletedNodeForRestore,
  trackInsertedNode,
  type TxHandle
} from "./transactions";

/**
 * Append a child statement node to a module at the re-ingest-consistent index
 * (the EOF child's index = number of real statements N), shifting the
 * EndOfFileTrivia node to N+1 with a re-derived id. The node is inserted into
 * the table immediately (visible within the tx) and tracked for rollback.
 * `payload` is the EXACT stored text (caller normalizes any leading separator).
 * Returns the new node's id. Shared by create_function, add_import,
 * move_declaration. (decisions.md 2026-05-28 EOF fix.)
 */
export function appendChildStatement(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  kind: string,
  payload: string
): string {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) {
    throw new Error(`Module not found: ${moduleId}`);
  }
  if (moduleNode.kind !== "Module") {
    throw new Error(
      `Node ${moduleId} is not a Module (kind=${moduleNode.kind})`
    );
  }
  const existing = listChildren(db, moduleId);
  const eof = existing.find((child) => child.kind === "EndOfFileTrivia");
  // The new statement takes the EOF node's index (= number of real statements,
  // N), matching what a clean re-ingest of the rendered text produces. The EOF
  // node, if present, shifts to N+1. (decisions.md 2026-05-28 EOF fix.)
  const nextChildIndex = eof ? eof.childIndex! : existing.length;
  const newId = nodeId(moduleNode.payload, [nextChildIndex], kind);

  if (existing.some((child) => child.id === newId)) {
    throw new Error(
      `appendChildStatement: a node with derived ID ${newId} already exists at module ${moduleId} child_index ${nextChildIndex}`
    );
  }

  insertNodes(db, [
    {
      id: newId,
      kind,
      parentId: moduleId,
      childIndex: nextChildIndex,
      payload
    }
  ]);
  trackInsertedNode(tx, newId);

  if (eof) {
    const shiftedIndex = nextChildIndex + 1;
    const shiftedEofId = nodeId(
      moduleNode.payload,
      [shiftedIndex],
      "EndOfFileTrivia"
    );
    // Record the EOF row as-is so rollback restores it; then replace it with
    // a row at the shifted, re-ingest-consistent index/id.
    trackDeletedNodeForRestore(tx, eof);
    db.prepare(`DELETE FROM nodes WHERE id = ?`).run(eof.id);
    insertNodes(db, [
      {
        id: shiftedEofId,
        kind: "EndOfFileTrivia",
        parentId: moduleId,
        childIndex: shiftedIndex,
        payload: eof.payload
      }
    ]);
    trackInsertedNode(tx, shiftedEofId);
  }

  return newId;
}
