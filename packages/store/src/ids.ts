import { createHash } from "node:crypto";

/**
 * Deterministic node ID.
 *
 * `childIndexPath` is the path of childIndex values from the module root to
 * the node. Module nodes use `[]`.
 */
export function nodeId(
  modulePath: string,
  childIndexPath: readonly number[],
  kind: string
): string {
  const hash = createHash("sha1");
  hash.update(modulePath);
  hash.update("\0");
  hash.update(childIndexPath.join("."));
  hash.update("\0");
  hash.update(kind);
  return hash.digest("hex").slice(0, 16);
}
