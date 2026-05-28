import ts from "typescript";
import { nodeId } from "./ids";
import { findNodeById, insertNodes, listChildren } from "./nodes";
import type { Db } from "./schema";
import {
  queuePendingOp,
  trackDeletedNodeForRestore,
  trackInsertedNode,
  type TxHandle
} from "./transactions";

function validateImportText(text: string): {
  parsed: ts.ImportDeclaration;
} {
  const sf = ts.createSourceFile(
    "__import__.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sf.statements.length !== 1) {
    throw new Error(
      `add_import: import_text must be a single import statement; got ${sf.statements.length} statements`
    );
  }
  const stmt = sf.statements[0]!;
  if (!ts.isImportDeclaration(stmt)) {
    throw new Error(
      "add_import: import_text must be an ImportDeclaration (e.g. `import { foo } from \"./bar\"`)"
    );
  }
  return { parsed: stmt };
}

export interface AddImportResult {
  newNodeId: string;
}

/**
 * Append a new import declaration to a module. The new node is inserted
 * at the END of the module's children (TypeScript is order-insensitive for
 * value imports; tooling that wants imports-at-top can sort separately).
 *
 * The node is inserted into the store immediately so validate() within the
 * same transaction sees it; rollback deletes it.
 */
export function add_import(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  importText: string
): AddImportResult {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) {
    throw new Error(`Module not found: ${moduleId}`);
  }
  if (moduleNode.kind !== "Module") {
    throw new Error(
      `Node ${moduleId} is not a Module (kind=${moduleNode.kind})`
    );
  }
  validateImportText(importText);

  const existing = listChildren(db, moduleId);
  const eof = existing.find((child) => child.kind === "EndOfFileTrivia");
  // The new statement takes the EOF node's index (= number of real statements,
  // N), matching what a clean re-ingest of the rendered text produces. The EOF
  // node, if present, shifts to N+1. (decisions.md 2026-05-28 EOF fix.)
  const nextChildIndex = eof ? eof.childIndex! : existing.length;
  const newId = nodeId(
    moduleNode.payload,
    [nextChildIndex],
    "ImportDeclaration"
  );

  if (existing.some((child) => child.id === newId)) {
    throw new Error(
      `add_import: a node with derived ID ${newId} already exists at module ${moduleId} child_index ${nextChildIndex}`
    );
  }

  const normalized = importText.startsWith("\n") ? importText : `\n${importText}`;

  insertNodes(db, [
    {
      id: newId,
      kind: "ImportDeclaration",
      parentId: moduleId,
      childIndex: nextChildIndex,
      payload: normalized
    }
  ]);
  trackInsertedNode(tx, newId);

  if (eof) {
    const shiftedIndex = nextChildIndex + 1;
    const shiftedEofId = nodeId(moduleNode.payload, [shiftedIndex], "EndOfFileTrivia");
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

  queuePendingOp(tx, {
    kind: "AddImport",
    paramsJson: JSON.stringify({
      module_id: moduleId,
      new_node_id: newId
    }),
    affectedNodeIdsJson: JSON.stringify([newId]),
    reasoning: null
  });

  return { newNodeId: newId };
}

export const addImport = add_import;
