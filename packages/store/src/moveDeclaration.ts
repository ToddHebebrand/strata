import ts from "typescript";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { appendChildStatement } from "./appendChildStatement";
import { resolveDeclarationNameIdentifier } from "./declarationName";
import {
  queuePendingOp,
  trackDeletedEdgeForRestore,
  trackDeletedNodeForRestore,
  type TxHandle
} from "./transactions";
import type { Reference } from "./references";
import { analyzeMove, type ImporterRewrite } from "./moveAnalysis";

export interface MoveDeclarationManifest {
  newDeclarationId: string;
  name: string;
  sourceModulePath: string;
  targetModulePath: string;
  importersRewritten: { modulePath: string; style: ImporterRewrite["style"] }[];
  sourceBackImportAdded: boolean;
}

/**
 * move_declaration apply — recreate-in-target + delete-from-source.
 *
 * The move mechanism: recreate the declaration in the target module (a new
 * target-derived ID via class-1 insertion through appendChildStatement), then
 * delete it from the source (the declaration node + its Identifier children +
 * their reference edges, all tracked for rollback). Returns the manifest
 * skeleton.
 *
 * The analyzeMove gate runs BEFORE any node insertion/deletion: on a rejected
 * move (non-self-contained, not exported, collision, …) this throws and leaves
 * the store untouched.
 *
 * Importer rewrites + the source back-import are Task 7 — NOT done here.
 * `importersRewritten` is reporting-only (derived from analysis) and
 * `sourceBackImportAdded` is always false for now.
 */
export function move_declaration(
  db: Db,
  tx: TxHandle,
  declarationId: string,
  targetModuleId: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): MoveDeclarationManifest {
  const decl = findNodeById(db, declarationId);
  if (!decl) throw new Error(`move_declaration: declaration not found: ${declarationId}`);
  if (decl.parentId === null || decl.childIndex === null) {
    throw new Error(`move_declaration: ${declarationId} is not a top-level declaration`);
  }
  const target = findNodeById(db, targetModuleId);
  if (!target || target.kind !== "Module") {
    throw new Error(`move_declaration: target ${targetModuleId} is not a Module`);
  }
  const sourceModulePath = modulePathOf(db, declarationId);
  const targetModulePath = target.payload;
  if (decl.parentId === targetModuleId) {
    throw new Error(`move_declaration: declaration already lives in the target module`);
  }

  const nameId = resolveDeclarationNameIdentifier(db, declarationId);
  if (!nameId) throw new Error(`move_declaration: declaration ${declarationId} has no name identifier`);
  const name = (JSON.parse(nameId.payload) as { text: string }).text;

  // Analyze BEFORE any mutation. analyzeMove throws-by-return: on rejection we
  // throw and the store is untouched (no insert, no delete).
  const analysis = analyzeMove(renderedByPath, options, {
    sourcePath: sourceModulePath,
    declChildIndex: decl.childIndex,
    name,
    targetPath: targetModulePath
  });
  if (!analysis.ok) throw new Error(analysis.reason);

  // Recreate in target (class-1 insertion). Use the STORED kind (decl.kind),
  // not analysis.declKind (the parsed ts.SyntaxKind name) — only the stored
  // kind matches a clean re-ingest of the rendered text. Keep a leading
  // blank-line separator so the rendered statement is visually separated.
  const normalized = decl.payload.startsWith("\n")
    ? decl.payload
    : `\n\n${decl.payload.replace(/^\s+/, "")}`;
  const newDeclarationId = appendChildStatement(db, tx, targetModuleId, decl.kind, normalized);

  // Delete from source: the declaration node + its Identifier children + their
  // reference edges. Track every deleted row for rollback restore.
  const idChildren = listChildren(db, declarationId).filter((c) => c.kind === "Identifier");
  const deletedIds = [...idChildren, decl].map((ch) => ch.id);

  // Capture every reference edge touching any node about to be deleted, in a
  // single query, BEFORE the delete — so rollback can re-insert them verbatim.
  // A single SELECT over the full id set (rather than per-node) naturally
  // de-duplicates edges whose BOTH endpoints are in the delete set (e.g. an
  // internal edge from one identifier to the decl name); a per-node capture
  // would double-count those.
  const placeholders = deletedIds.map(() => "?").join(", ");
  const capturedEdges = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references
       WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`
    )
    .all(...deletedIds, ...deletedIds) as Reference[];
  trackDeletedEdgeForRestore(tx, capturedEdges);

  const delEdges = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );
  const delNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);
  const drop = db.transaction(() => {
    for (const ch of [...idChildren, decl]) {
      trackDeletedNodeForRestore(tx, ch);
      delEdges.run(ch.id, ch.id);
      delNode.run(ch.id);
    }
  });
  drop();

  // Importer rewrites + back-import: Task 7. Manifest skeleton for now.
  queuePendingOp(tx, {
    kind: "MoveDeclaration",
    paramsJson: JSON.stringify({
      declaration_id: declarationId,
      new_node_id: newDeclarationId,
      name,
      source: sourceModulePath,
      target: targetModulePath,
      importer_count: analysis.importerRewrites.length
    }),
    affectedNodeIdsJson: JSON.stringify([newDeclarationId, declarationId]),
    reasoning: null
  });

  return {
    newDeclarationId,
    name,
    sourceModulePath,
    targetModulePath,
    importersRewritten: analysis.importerRewrites.map((r) => ({
      modulePath: r.importerPath,
      style: r.style
    })),
    sourceBackImportAdded: false
  };
}

export const moveDeclaration = move_declaration;
