import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { NodeRow } from "@strata/store";

export interface IngestResult {
  module: NodeRow;
  children: NodeRow[];
}

export function ingest(sourceText: string, modulePath: string): IngestResult {
  const sourceFile = ts.createSourceFile(
    modulePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const module: NodeRow = {
    id: newId(),
    kind: "Module",
    parentId: null,
    childIndex: null,
    payload: modulePath
  };

  const statementNodes = sourceFile.statements.map((statement, index): NodeRow => {
    return {
      id: newId(),
      kind: ts.SyntaxKind[statement.kind],
      parentId: module.id,
      childIndex: index,
      payload: statement.getFullText(sourceFile)
    };
  });

  const endOfFileTrivia: NodeRow = {
    id: newId(),
    kind: "EndOfFileTrivia",
    parentId: module.id,
    childIndex: sourceFile.statements.length,
    payload: sourceFile.endOfFileToken.getFullText(sourceFile)
  };

  const children = [...statementNodes, endOfFileTrivia];

  return { module, children };
}

function newId(): string {
  return randomUUID();
}

export type { NodeRow };
