import ts from "typescript";
import { appendChildStatement } from "./appendChildStatement";
import { findNodeById } from "./nodes";
import type { Db } from "./schema";
import { queuePendingOp, type TxHandle } from "./transactions";

function validateFunctionText(text: string): {
  parsed: ts.FunctionDeclaration;
} {
  const sf = ts.createSourceFile(
    "__create__.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sf.statements.length !== 1) {
    throw new Error(
      `create_function: function_text must be a single declaration; got ${sf.statements.length} statements`
    );
  }
  const stmt = sf.statements[0]!;
  if (!ts.isFunctionDeclaration(stmt)) {
    throw new Error(
      "create_function: function_text must be a FunctionDeclaration (e.g. `export function foo(...) { ... }`)"
    );
  }
  if (!stmt.name) {
    throw new Error("create_function: function declaration must have a name");
  }
  if (!stmt.body) {
    throw new Error(
      "create_function: function declaration must have a body (no `declare function`)"
    );
  }
  return { parsed: stmt };
}

export interface CreateFunctionResult {
  newNodeId: string;
  name: string;
}

/**
 * Append a new function declaration to a module. The function text is parsed
 * with the TypeScript API to ensure it's syntactically valid; references in
 * its body are NOT resolved structurally — the renderer emits the payload as
 * given and validate's tsc catches any unresolved imports or names.
 *
 * The new node is inserted into the store immediately (so validate() within
 * the same transaction sees it). On rollback the node is deleted.
 */
export function create_function(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  functionText: string
): CreateFunctionResult {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) {
    throw new Error(`Module not found: ${moduleId}`);
  }
  if (moduleNode.kind !== "Module") {
    throw new Error(
      `Node ${moduleId} is not a Module (kind=${moduleNode.kind})`
    );
  }
  const { parsed } = validateFunctionText(functionText);
  const name = parsed.name!.text;

  const normalized = functionText.startsWith("\n")
    ? functionText
    : `\n\n${functionText}`;
  const newId = appendChildStatement(
    db,
    tx,
    moduleId,
    "FunctionDeclaration",
    normalized
  );

  queuePendingOp(tx, {
    kind: "CreateFunction",
    paramsJson: JSON.stringify({
      module_id: moduleId,
      name,
      new_node_id: newId
    }),
    affectedNodeIdsJson: JSON.stringify([newId]),
    reasoning: null
  });

  return { newNodeId: newId, name };
}

export const createFunction = create_function;
