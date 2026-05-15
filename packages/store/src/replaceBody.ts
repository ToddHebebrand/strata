import ts from "typescript";
import { findNodeById } from "./nodes";
import type { Db } from "./schema";
import { locateSpan } from "./spanReparse";
import {
  queuePendingOp,
  queueTextSpanEdit,
  type TxHandle
} from "./transactions";

function isValidBlock(bodyText: string): boolean {
  const prefix = "function __probe__() ";
  const sourceText = `${prefix}${bodyText}`;
  if (syntacticDiagnostics(sourceText).length > 0) {
    return false;
  }

  const sf = ts.createSourceFile(
    "__body__.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0])) {
    return false;
  }

  const body = sf.statements[0].body;
  return Boolean(
    body && ts.isBlock(body) && body.getEnd() === prefix.length + bodyText.length
  );
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

export function replace_body(
  db: Db,
  tx: TxHandle,
  functionId: string,
  newBody: string
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
  if (!isValidBlock(newBody)) {
    throw new Error(
      `Invalid body: must be a syntactically valid { ... } block: ${JSON.stringify(
        newBody.slice(0, 40)
      )}`
    );
  }

  const span = locateSpan(declaration.payload, "body");
  if (span.text === newBody) {
    return;
  }

  queueTextSpanEdit(tx, functionId, {
    start: span.start,
    end: span.end,
    oldText: span.text,
    newText: newBody
  });

  queuePendingOp(tx, {
    kind: "ReplaceBody",
    paramsJson: JSON.stringify({
      function_id: functionId,
      new_body_len: newBody.length
    }),
    affectedNodeIdsJson: JSON.stringify([functionId]),
    reasoning: null
  });
}

export const replaceBody = replace_body;
