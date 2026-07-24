import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parseCanonicalU64 } from "@strata-code/ingest";
import type { Db } from "@strata-code/store";

/**
 * Full logical mirror fingerprint (bridge-persistence slice, Task 7 — the
 * `MirrorFingerprint` of the plan's Shared vocabulary).
 *
 * SHA-256 (lowercase hex) over a canonical dump of ALL mutable tables in the
 * worker's `:memory:` mirror database plus the results of
 * `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, so both logical
 * divergence AND structural corruption change the fingerprint. Strictly
 * stronger than the `MirrorState` sync digest (which covers only
 * nodes/references): candidate execution also writes `transactions` and
 * `operations` rows, and savepoint rollback must restore those too.
 *
 * Coverage is asserted at runtime against `sqlite_master`: every table must
 * be classified — dumped (named in {@link DUMPED_TABLES} or matching a vec0
 * shadow prefix) or intentionally excluded ({@link EXCLUDED_TABLES}, each
 * with a reason) — and an unclassified table THROWS, so a future store
 * schema addition fails loudly here instead of silently escaping the
 * candidate-isolation assertion.
 *
 * Determinism (stated, load-bearing): tables are dumped in byte-wise
 * UTF-8-sorted name order; rows are dumped `ORDER BY rowid` (every table in
 * the store schema is a rowid table — verified empirically; a WITHOUT ROWID
 * table added later would throw on the `rowid` reference, which is the loud
 * failure we want, prompting an explicit classification); columns follow the
 * declared `PRAGMA table_info` order. Values are type-tagged so TEXT can
 * never collide with INTEGER/REAL/BLOB encodings.
 */

/** Tables whose rows are part of the logical mirror state — dumped in full. */
const DUMPED_TABLES: ReadonlySet<string> = new Set([
  "nodes",
  "node_references",
  "transactions",
  "operations",
  "embedding_meta",
  "commit_pattern_meta",
  // AUTOINCREMENT bookkeeping (created by the sqlite-vec shadow tables).
  // Dumped so sequence-counter drift cannot escape the fingerprint.
  "sqlite_sequence"
]);

/**
 * Intentionally-excluded tables — each with the reason it is sound to skip.
 * Every exclusion must be a table that stores NO rows of its own.
 */
const EXCLUDED_TABLES: ReadonlyMap<string, string> = new Map([
  [
    "node_embeddings",
    "vec0 virtual-table module entry: it owns no storage pages of its own — " +
      "all persisted embedding state lives in its shadow tables " +
      "(node_embeddings_*), which ARE dumped via the shadow prefix rule."
  ],
  [
    "commit_pattern_embeddings",
    "vec0 virtual-table module entry: same as node_embeddings — storage " +
      "lives in the dumped commit_pattern_embeddings_* shadow tables."
  ]
]);

/**
 * sqlite-vec vec0 shadow tables (`<name>_chunks`, `_info`, `_rowids`,
 * `_vector_chunks00`, …). Their exact names are an implementation detail of
 * the loaded sqlite-vec version, so they are matched by prefix; they are
 * plain rowid tables holding the actual embedding bytes and are DUMPED.
 */
const VEC_SHADOW_PREFIXES = ["node_embeddings_", "commit_pattern_embeddings_"] as const;

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isDumpedTable(name: string): boolean {
  return (
    DUMPED_TABLES.has(name) ||
    VEC_SHADOW_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Type-tagged canonical encoding of one SQLite value, appended to `parts`:
 * `null`, `["s",<json string>]`, `["n","<decimal>"]` (INTEGER/REAL via
 * JavaScript's shortest-round-trip `String()`; better-sqlite3 returns plain
 * numbers here — a `bigint` from safe-integer mode would also land in "n"),
 * `["b","<hex>"]` for BLOBs. Tagging makes TEXT `"12"` and INTEGER `12`
 * distinct inputs by construction.
 */
function appendValue(parts: string[], value: unknown): void {
  if (value === null || value === undefined) {
    parts.push("null");
  } else if (typeof value === "string") {
    parts.push('["s",', JSON.stringify(value), "]");
  } else if (typeof value === "number" || typeof value === "bigint") {
    parts.push('["n","', String(value), '"]');
  } else if (Buffer.isBuffer(value)) {
    parts.push('["b","', value.toString("hex"), '"]');
  } else {
    throw new TypeError(
      `mirror fingerprint cannot encode a ${typeof value} column value`
    );
  }
}

function appendRows(parts: string[], rows: unknown[][]): void {
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) parts.push(",");
    parts.push("[");
    row.forEach((value, valueIndex) => {
      if (valueIndex > 0) parts.push(",");
      appendValue(parts, value);
    });
    parts.push("]");
  });
}

/**
 * The full logical fingerprint of the mirror database at `generation`.
 * Recomputed from the actual database content on every call — never cached.
 * Two calls with no intervening logical change (e.g. before and after a
 * fully rolled-back savepoint) MUST return the same value; a difference is
 * the Task-7 poison condition.
 */
export function mirrorFingerprint(db: Db, generation: string): string {
  parseCanonicalU64(generation);

  const names = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort(compareUtf8Bytes);

  const parts: string[] = ['{"schema":1,"generation":"', generation, '","tables":['];
  let dumped = 0;
  for (const name of names) {
    if (EXCLUDED_TABLES.has(name)) continue;
    if (!isDumpedTable(name)) {
      throw new Error(
        `mirror fingerprint coverage violation: table ${JSON.stringify(name)} ` +
          "is neither dumped nor on the exclusion allowlist — classify it in " +
          "mirror-fingerprint.ts before it can silently escape candidate isolation"
      );
    }
    const columns = (
      db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
    ).map((column) => column.name);
    const columnList = columns.map((column) => `"${column}"`).join(", ");
    // ORDER BY rowid: deterministic and stated. Savepoint rollback restores
    // exact pages, so rowids (and therefore row order) are restored too.
    const rows = db
      .prepare(`SELECT ${columnList} FROM "${name}" ORDER BY rowid`)
      .raw()
      .all() as unknown[][];
    if (dumped > 0) parts.push(",");
    dumped += 1;
    parts.push("[", JSON.stringify(name), ',[');
    appendRows(parts, rows);
    parts.push("]]");
  }

  // Corruption detectors, part of the fingerprint input by requirement: a
  // structurally corrupted mirror changes the fingerprint AND is readable
  // from these rows when diagnosing a poison.
  parts.push('],"integrityCheck":[');
  appendRows(parts, db.prepare("PRAGMA integrity_check").raw().all() as unknown[][]);
  parts.push('],"foreignKeyCheck":[');
  appendRows(parts, db.prepare("PRAGMA foreign_key_check").raw().all() as unknown[][]);
  parts.push("]}");

  return createHash("sha256").update(Buffer.from(parts.join(""), "utf8")).digest("hex");
}
