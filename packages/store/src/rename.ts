import { findNodeById } from "./nodes";
import { getReferencesByTo } from "./references";
import type { Db } from "./schema";
import {
  queueIdentifierUpdate,
  queuePendingOp,
  type TxHandle
} from "./transactions";
import { resolveDeclarationNameIdentifier } from "./declarationName";

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// NOTE: const decls are persisted as "FirstStatement" by ingest (TS SyntaxKind
// alias for VariableStatement, value 244). Symmetric with queries.ts mapping
// so `find_declarations({kind:"variable"})` → `rename_symbol` is a valid path
// for exported consts. See 2026-05-26 Codex review.
const DECLARATION_KINDS = new Set([
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "FirstStatement"
]);

export function rename_symbol(
  db: Db,
  tx: TxHandle,
  declarationId: string,
  newName: string
): void {
  if (!IDENT_PATTERN.test(newName)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(newName)}`);
  }

  const declaration = findNodeById(db, declarationId);
  if (!declaration) {
    throw new Error(`Declaration not found: ${declarationId}`);
  }
  if (!DECLARATION_KINDS.has(declaration.kind)) {
    throw new Error(
      `Node ${declarationId} is not a declaration (kind=${declaration.kind})`
    );
  }

  // Use resolveDeclarationNameIdentifier to find the correct name Identifier,
  // not the first/lowest-offset child. For JSDoc'd declarations the first
  // Identifier child is a @param tag word; resolving by payload parse picks
  // the actual declaration name.
  const declarationIdentifier = resolveDeclarationNameIdentifier(db, declarationId);
  if (!declarationIdentifier) {
    throw new Error(`Declaration ${declarationId} has no identifier child`);
  }

  const declarationPayload = JSON.parse(declarationIdentifier.payload) as {
    text: string;
  };
  if (declarationPayload.text === newName) {
    return;
  }

  const references = getReferencesByTo(db, declarationIdentifier.id);
  const affected = [
    declarationIdentifier.id,
    ...references.map((reference) => reference.fromNodeId)
  ];

  for (const identifierId of affected) {
    queueIdentifierUpdate(tx, identifierId, newName);
  }

  queuePendingOp(tx, {
    kind: "RenameSymbol",
    paramsJson: JSON.stringify({
      declaration_id: declarationId,
      old_name: declarationPayload.text,
      new_name: newName
    }),
    affectedNodeIdsJson: JSON.stringify(affected),
    reasoning: null
  });
}

export const renameSymbol = rename_symbol;
