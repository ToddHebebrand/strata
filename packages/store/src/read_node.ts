import { findNodeById, listChildren, type NodeRow } from "./nodes";
import type { Db } from "./schema";

export interface ReadNodeOptions {
  /** When true, include the node's direct children (one level only). */
  includeChildren?: boolean;
}

export interface ReadNodeResult {
  node: NodeRow;
  /** Present only when includeChildren is true. */
  children?: NodeRow[];
}

/**
 * Read one node by ID, optionally with its direct (one-level) children.
 * Thin composition of findNodeById + listChildren so consumers do not reach
 * into store internals.
 */
export function readNode(
  db: Db,
  id: string,
  options: ReadNodeOptions = {}
): ReadNodeResult | undefined {
  const node = findNodeById(db, id);
  if (!node) return undefined;
  if (!options.includeChildren) return { node };
  return { node, children: listChildren(db, id) };
}

export const read_node = readNode;
