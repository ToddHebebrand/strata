import ts from "typescript";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { create_function } from "./createFunction";
import {
  queuePendingOp,
  queueTextSpanEdit,
  type TxHandle
} from "./transactions";
import {
  analyzeExtraction,
  type ExtractParam,
  type ExtractReturn
} from "./extractAnalysis";

export interface ExtractFunctionManifest {
  newNodeId: string;
  name: string;
  isAsync: boolean;
  params: ExtractParam[];
  returns: ExtractReturn[];
  callSiteText: string;
  newFunctionText: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Extract body statements [start..end] of a top-level FunctionDeclaration into
 * a new top-level function, replacing the span with a call. Auto-infers params,
 * returns, and async via analyzeExtraction (over caller-supplied rendered text);
 * computes the mechanical splice on the stored payload. Throws on structural
 * misuse or a semantic rejection (no overlay mutation in either case).
 */
export function extract_function(
  db: Db,
  tx: TxHandle,
  parentId: string,
  startIndex: number,
  endIndex: number,
  name: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): ExtractFunctionManifest {
  if (!IDENT.test(name)) {
    throw new Error(`extract_function: invalid identifier: ${JSON.stringify(name)}`);
  }
  const parent = findNodeById(db, parentId);
  if (!parent) throw new Error(`extract_function: parent not found: ${parentId}`);
  if (parent.kind !== "FunctionDeclaration") {
    throw new Error(`extract_function: parent ${parentId} is not a FunctionDeclaration (kind=${parent.kind})`);
  }
  if (parent.childIndex === null || parent.parentId === null) {
    throw new Error(`extract_function: parent ${parentId} is not a top-level declaration`);
  }
  const moduleId = parent.parentId;
  const modulePath = modulePathOf(db, parentId);

  // Name-collision check against existing top-level declarations in the module.
  for (const sibling of listChildren(db, moduleId)) {
    if (sibling.kind === "EndOfFileTrivia" || sibling.id === parentId) continue;
    const declName = topLevelDeclName(sibling.payload);
    if (declName === name) {
      throw new Error(`extract_function: a declaration named \`${name}\` already exists in this module`);
    }
  }

  // Semantic analysis over rendered text (the parent at its module child index).
  const analysis = analyzeExtraction(
    renderedByPath,
    options,
    modulePath,
    parent.childIndex,
    { start: startIndex, end: endIndex },
    name
  );
  if (!analysis.ok) throw new Error(analysis.reason);

  // Mechanical splice on the stored payload: locate the same statement range.
  const payloadSf = ts.createSourceFile(
    "__parent__.ts",
    parent.payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fn = payloadSf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) {
    throw new Error(`extract_function: parent payload is not a function declaration with a body`);
  }
  const bodyStmts = fn.body.statements;
  if (startIndex < 0 || endIndex >= bodyStmts.length || startIndex > endIndex) {
    throw new Error(
      `extract_function: statement range [${startIndex}, ${endIndex}] out of bounds (body has ${bodyStmts.length})`
    );
  }
  const spanStartOff = bodyStmts[startIndex]!.getStart(payloadSf);
  const spanEndOff = bodyStmts[endIndex]!.getEnd();
  const spanText = parent.payload.slice(spanStartOff, spanEndOff);

  // Build the new function text. Body = span text; append a return if needed.
  const sig = analysis.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  const returnLine =
    analysis.returns.length === 0
      ? ""
      : analysis.returns.length === 1
        ? `\n  return ${analysis.returns[0]!.name};`
        : `\n  return { ${analysis.returns.map((r) => r.name).join(", ")} };`;
  const newFunctionText =
    `${analysis.isAsync ? "async " : ""}function ${name}(${sig}): ${analysis.returnType} {\n` +
    `${spanText}${returnLine}\n}`;

  // Insert the new function (class-1 materialization at commit).
  const { newNodeId } = create_function(db, tx, moduleId, newFunctionText);

  // Queue the parent splice as a text-span edit on the overlay. The commit-time
  // class-2 pass re-derives the parent (rebuilds Identifier nodes, refreshes
  // reference edges) only for nodes present in overlay.textSpanMutations — a
  // direct DB UPDATE would skip that re-derivation entirely.
  queueTextSpanEdit(tx, parentId, {
    start: spanStartOff,
    end: spanEndOff,
    oldText: spanText,
    newText: analysis.callSiteText
  });

  queuePendingOp(tx, {
    kind: "ExtractFunction",
    paramsJson: JSON.stringify({
      parent_id: parentId,
      new_node_id: newNodeId,
      name,
      start_index: startIndex,
      end_index: endIndex,
      is_async: analysis.isAsync,
      param_count: analysis.params.length,
      return_count: analysis.returns.length
    }),
    affectedNodeIdsJson: JSON.stringify([newNodeId, parentId]),
    reasoning: null
  });

  return {
    newNodeId,
    name,
    isAsync: analysis.isAsync,
    params: analysis.params,
    returns: analysis.returns,
    callSiteText: analysis.callSiteText,
    newFunctionText
  };
}

/** Best-effort name of a top-level declaration payload (for collision checks). */
function topLevelDeclName(payload: string): string | undefined {
  const sf = ts.createSourceFile("__d__.ts", payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  if (!stmt) return undefined;
  if (
    (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
    stmt.name
  ) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name.text;
  }
  return undefined;
}

export const extractFunction = extract_function;
