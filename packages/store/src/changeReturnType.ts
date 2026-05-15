import ts from "typescript";
import { findNodeById } from "./nodes";
import type { Db } from "./schema";
import { locateSpan } from "./spanReparse";
import {
  queuePendingOp,
  queueTextSpanEdit,
  type TxHandle
} from "./transactions";

function isValidType(typeText: string): boolean {
  const sourceText = `let __x__: ${typeText};`;
  if (syntacticDiagnostics(sourceText).length > 0) {
    return false;
  }

  const sf = ts.createSourceFile(
    "__type__.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sf.statements.length !== 1 || !ts.isVariableStatement(sf.statements[0])) {
    return false;
  }

  const decl = sf.statements[0].declarationList.declarations[0];
  return Boolean(decl?.type && decl.type.getText(sf) === typeText.trim());
}

function syntacticDiagnostics(sourceText: string): readonly ts.Diagnostic[] {
  const fileName = "__probe__.ts";
  const options: ts.CompilerOptions = {
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName
      ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
      : undefined;
  host.readFile = (name) => (name === fileName ? sourceText : undefined);
  host.fileExists = (name) => name === fileName;
  host.writeFile = () => undefined;

  const program = ts.createProgram([fileName], options, host);
  const sf = program.getSourceFile(fileName);
  return sf ? program.getSyntacticDiagnostics(sf) : [];
}

export function change_return_type(
  db: Db,
  tx: TxHandle,
  functionId: string,
  newType: string
): void {
  const declaration = findNodeById(db, functionId);
  if (!declaration) {
    throw new Error(`Declaration not found: ${functionId}`);
  }
  if (declaration.kind !== "FunctionDeclaration") {
    throw new Error(
      `Node ${functionId} is not a FunctionDeclaration (kind=${declaration.kind})`
    );
  }
  if (!isValidType(newType)) {
    throw new Error(`Invalid type annotation: ${JSON.stringify(newType)}`);
  }

  const span = locateSpan(declaration.payload, "returnType");
  const oldType = span.text;
  if (oldType === newType) {
    return;
  }

  queueTextSpanEdit(tx, functionId, {
    start: span.start,
    end: span.end,
    oldText: oldType,
    newText: span.start === span.end ? `: ${newType}` : newType
  });

  queuePendingOp(tx, {
    kind: "ChangeReturnType",
    paramsJson: JSON.stringify({
      function_id: functionId,
      old_type: oldType,
      new_type: newType
    }),
    affectedNodeIdsJson: JSON.stringify([functionId]),
    reasoning: null
  });
}

export const changeReturnType = change_return_type;
