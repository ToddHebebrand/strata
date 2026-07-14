import { nodeId, type NodeRow } from "@strata/store";
import ts from "typescript";
import { emitIdentifiers } from "./identifiers";

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

  const moduleNodeId = nodeId(modulePath, [], "Module");
  const module: NodeRow = {
    id: moduleNodeId,
    kind: "Module",
    parentId: null,
    childIndex: null,
    payload: modulePath
  };

  const children: NodeRow[] = [];

  sourceFile.statements.forEach((statement, index) => {
    const kind = ts.SyntaxKind[statement.kind];
    children.push({
      id: nodeId(modulePath, [index], kind),
      kind,
      parentId: moduleNodeId,
      childIndex: index,
      payload: statement.getFullText(sourceFile)
    });
    children.push(...emitIdentifiers(sourceFile, statement, modulePath, [index]));
  });

  const eofIndex = sourceFile.statements.length;
  children.push({
    id: nodeId(modulePath, [eofIndex], "EndOfFileTrivia"),
    kind: "EndOfFileTrivia",
    parentId: moduleNodeId,
    childIndex: eofIndex,
    payload: sourceFile.endOfFileToken.getFullText(sourceFile)
  });

  return { module, children };
}

export { emitIdentifiers } from "./identifiers";
export { ingestBatch, type IngestBatchInput, type IngestBatchResult } from "./batch";
export {
  toKernelSnapshot,
  type KernelNodeV1,
  type KernelReferenceV1,
  type KernelSnapshotV1
} from "./kernelSnapshot";
export type { NodeRow };
