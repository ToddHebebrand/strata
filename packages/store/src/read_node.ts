import { findNodeById, listChildren, type NodeRow } from "./nodes";
import type { Db } from "./schema";
import { listBodyStatements, type BodyStatement } from "./extractAnalysis";

export interface ReadNodeOptions {
  /** When true, include the node's direct children (one level only). */
  includeChildren?: boolean;
}

export interface ReadNodeResult {
  node: NodeRow;
  /** Present only when includeChildren is true. */
  children?: NodeRow[];
  /**
   * Present only for FunctionDeclaration nodes: the indexed top-level
   * statements of the function body, so callers can choose an extract_function
   * statement range without computing character offsets.
   */
  bodyStatements?: BodyStatement[];
}

export function readNode(
  db: Db,
  id: string,
  options: ReadNodeOptions = {}
): ReadNodeResult | undefined {
  const node = findNodeById(db, id);
  if (!node) return undefined;
  const result: ReadNodeResult = { node };
  if (options.includeChildren) result.children = listChildren(db, id);
  if (node.kind === "FunctionDeclaration") {
    result.bodyStatements = listBodyStatements(node.payload);
  }
  return result;
}

export const read_node = readNode;
