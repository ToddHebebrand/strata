import ts from "typescript";
import { findNodeById } from "./nodes";
import { getReferencesByTo } from "./references";
import type { Db } from "./schema";
import { resolveDeclarationNameIdentifier } from "./declarationName";

export interface Callsite {
  referenceNodeId: string;
  statementId: string;
  argListInsertOffset: number;
  argumentInsertionOffsets: number[];
  existingArgCount: number;
}

export interface NonCallReference {
  statementId: string;
  shape: "higher-order-value" | "aliased-value" | "value-position";
}

export interface UnresolvedReference {
  referenceNodeId: string;
  reason: "missing-reference-node" | "missing-statement" | "identifier-not-found";
}

export interface CallsiteResolutionCounts {
  resolvedDirectCallsites: number;
  arityRiskReferences: number;
  unresolvedReferences: number;
}

export interface CallsiteResolution {
  callsites: Callsite[];
  nonCallReferences: NonCallReference[];
  unresolvedReferences: UnresolvedReference[];
  counts: CallsiteResolutionCounts;
}

export function resolveCallsites(
  db: Db,
  functionId: string
): CallsiteResolution {
  const declaration = findNodeById(db, functionId);
  if (!declaration) {
    throw new Error(`Declaration not found: ${functionId}`);
  }
  // Use resolveDeclarationNameIdentifier to find the correct name Identifier,
  // not the first/lowest-offset child. For JSDoc'd declarations the first
  // Identifier child is a @param tag word; resolving by payload parse picks
  // the actual declaration name.
  const declIdentifier = resolveDeclarationNameIdentifier(db, functionId);
  if (!declIdentifier) {
    throw new Error(`Declaration ${functionId} has no identifier child`);
  }

  const callsites: Callsite[] = [];
  const nonCallReferences: NonCallReference[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];

  for (const reference of getReferencesByTo(db, declIdentifier.id)) {
    const refNode = findNodeById(db, reference.fromNodeId);
    if (!refNode) {
      unresolvedReferences.push({
        referenceNodeId: reference.fromNodeId,
        reason: "missing-reference-node"
      });
      continue;
    }
    if (!refNode.parentId) {
      unresolvedReferences.push({
        referenceNodeId: reference.fromNodeId,
        reason: "missing-statement"
      });
      continue;
    }

    const statement = findNodeById(db, refNode.parentId);
    if (!statement) {
      unresolvedReferences.push({
        referenceNodeId: reference.fromNodeId,
        reason: "missing-statement"
      });
      continue;
    }

    if (statement.kind === "ImportDeclaration") {
      continue;
    }

    const refPayload = JSON.parse(refNode.payload) as {
      text: string;
      offset: number;
    };
    const sf = ts.createSourceFile(
      "__callsites__.ts",
      statement.payload,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const identifier = findIdentifierAtOffset(sf, refPayload.offset, refPayload.text);
    if (!identifier) {
      unresolvedReferences.push({
        referenceNodeId: reference.fromNodeId,
        reason: "identifier-not-found"
      });
      continue;
    }

    const call = enclosingCallWhoseCalleeIs(identifier);
    if (call) {
      const argumentInsertionOffsets = argumentInsertOffsets(call, sf);
      callsites.push({
        referenceNodeId: reference.fromNodeId,
        statementId: statement.id,
        argListInsertOffset:
          argumentInsertionOffsets[argumentInsertionOffsets.length - 1]!,
        argumentInsertionOffsets,
        existingArgCount: call.arguments.length
      });
      continue;
    }

    nonCallReferences.push({
      statementId: statement.id,
      shape: classifyNonCallReference(identifier)
    });
  }

  return {
    callsites,
    nonCallReferences,
    unresolvedReferences,
    counts: {
      resolvedDirectCallsites: callsites.length,
      arityRiskReferences: nonCallReferences.length,
      unresolvedReferences: unresolvedReferences.length
    }
  };
}

function findIdentifierAtOffset(
  sf: ts.SourceFile,
  offset: number,
  text: string
): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === text &&
      node.getStart(sf) === offset
    ) {
      found = node;
      return;
    }
    for (const child of node.getChildren(sf)) {
      visit(child);
    }
  }

  visit(sf);
  return found;
}

function enclosingCallWhoseCalleeIs(
  identifier: ts.Identifier
): ts.CallExpression | undefined {
  let callee: ts.Node = identifier;
  let node: ts.Node | undefined = identifier.parent;

  while (node) {
    if (ts.isParenthesizedExpression(node) && node.expression === callee) {
      callee = node;
      node = node.parent;
      continue;
    }
    if (ts.isCallExpression(node)) {
      return node.expression === callee ? node : undefined;
    }
    return undefined;
  }

  return undefined;
}

function argumentInsertOffsets(
  call: ts.CallExpression,
  sf: ts.SourceFile
): number[] {
  if (call.arguments.length === 0) {
    return [findToken(call, sf, ts.SyntaxKind.OpenParenToken).getEnd()];
  }

  return [
    call.arguments[0]!.getStart(sf),
    ...call.arguments.map((argument) => argument.getEnd())
  ];
}

function classifyNonCallReference(
  identifier: ts.Identifier
): NonCallReference["shape"] {
  if (ts.isCallExpression(identifier.parent)) {
    return "higher-order-value";
  }
  if (
    ts.isVariableDeclaration(identifier.parent) &&
    identifier.parent.initializer === identifier
  ) {
    return "aliased-value";
  }
  return "value-position";
}

function findToken(
  parent: ts.Node,
  sf: ts.SourceFile,
  kind: ts.SyntaxKind
): ts.Node {
  for (const child of parent.getChildren(sf)) {
    if (child.kind === kind) {
      return child;
    }
  }
  throw new Error(`token ${ts.SyntaxKind[kind]} not found`);
}
