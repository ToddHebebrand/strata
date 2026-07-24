import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parseCanonicalU64 } from "@strata-code/ingest";

/**
 * Canonical sync digest for daemon↔worker mirror attestation (bridge
 * persistence slice, Task 2). Must stay byte-identical with
 * `crates/strata-kernel/src/sync_digest.rs`: both sides assemble the encoded
 * byte string with an EXPLICIT writer (never by serializing a whole object,
 * which would couple the encoding to serializer key order) and are pinned to
 * the shared vectors at
 * `crates/strata-kernel/tests/fixtures/sync-digest-vectors.json` plus the
 * randomized cross-language differential corpus.
 *
 * Sync attestation only — the kernel's `GraphGeneration::digest` is a
 * different encoding and stays untouched.
 */

export interface MirrorNode {
  id: string;
  kind: string;
  parentId: string | null;
  childIndex: number | null;
  payload: string;
}

export interface MirrorReference {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
}

/**
 * Byte-wise comparison of the UTF-8 encodings. Deliberately NOT
 * `localeCompare` (locale-dependent) and NOT UTF-16 code-unit `<` — for
 * astral characters the surrogate range (0xD800+) sorts below e.g. U+FF61 in
 * code units but above it in UTF-8 bytes, and Rust sorts by UTF-8 bytes.
 */
function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The ONLY place the standard serializer participates: escaping one string
 * value. `JSON.stringify` and `serde_json` both emit RFC 8259 minimal
 * escaping on valid Unicode strings (proven by the shared hostile vectors).
 */
function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * childIndex crosses the boundary as an i64 in Rust; on this side it must be
 * a safe integer so `String()` produces the same plain decimal — anything
 * else (fractional, ±Infinity, NaN, beyond 2^53-1) would silently misencode.
 */
function childIndexLiteral(childIndex: number | null): string {
  if (childIndex === null) {
    return "null";
  }
  if (!Number.isSafeInteger(childIndex)) {
    throw new TypeError(`childIndex must be a safe integer, got ${childIndex}`);
  }
  return String(childIndex);
}

/**
 * Lowercase-hex SHA-256 over the canonical encoding
 * `{"schema":1,"generation":"<decimal-u64>","nodes":[...],"references":[...]}`:
 * nodes sorted by id (UTF-8 byte-wise), each as
 * `[id,kind,parentId|null,childIndex|null,payload]`; references sorted by
 * (fromNodeId, toNodeId) byte-wise, each as `[fromNodeId,toNodeId,kind]`;
 * no whitespace anywhere. Inputs may arrive in any order; sorting here is
 * part of the contract. Generation is validated as a canonical decimal u64
 * string (same validation as `canonicalU64Schema`) and embedded verbatim so
 * values beyond 2^53-1 never round-trip through a JS number.
 */
export function canonicalSyncDigest(
  generation: string,
  nodes: MirrorNode[],
  references: MirrorReference[]
): string {
  parseCanonicalU64(generation);
  const sortedNodes = [...nodes].sort((a, b) => compareUtf8Bytes(a.id, b.id));
  const sortedReferences = [...references].sort(
    (a, b) =>
      compareUtf8Bytes(a.fromNodeId, b.fromNodeId) ||
      compareUtf8Bytes(a.toNodeId, b.toNodeId)
  );

  const parts: string[] = ['{"schema":1,"generation":"', generation, '","nodes":['];
  sortedNodes.forEach((node, index) => {
    if (index > 0) {
      parts.push(",");
    }
    parts.push(
      "[",
      jsonStringLiteral(node.id),
      ",",
      jsonStringLiteral(node.kind),
      ",",
      node.parentId === null ? "null" : jsonStringLiteral(node.parentId),
      ",",
      childIndexLiteral(node.childIndex),
      ",",
      jsonStringLiteral(node.payload),
      "]"
    );
  });
  parts.push('],"references":[');
  sortedReferences.forEach((reference, index) => {
    if (index > 0) {
      parts.push(",");
    }
    parts.push(
      "[",
      jsonStringLiteral(reference.fromNodeId),
      ",",
      jsonStringLiteral(reference.toNodeId),
      ",",
      jsonStringLiteral(reference.kind),
      "]"
    );
  });
  parts.push("]}");

  return createHash("sha256")
    .update(Buffer.from(parts.join(""), "utf8"))
    .digest("hex");
}
