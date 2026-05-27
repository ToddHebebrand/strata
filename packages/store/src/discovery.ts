import { findNodeById, type NodeRow } from "./nodes";
import type { Db } from "./schema";

/**
 * Top-level statement kinds that count as "declarations" for discovery.
 * Mirrors the set find_declarations uses, but resolved here so callers
 * (list_module_exports, find_declarations_in_module) can stay independent
 * of queries.ts's name-filter join logic.
 */
const DISCOVERY_KINDS = [
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "FirstStatement"
] as const;

export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number];

export interface ModuleExport {
  id: string;
  kind: string;
  name: string | null;
  isExported: boolean;
}

/**
 * Detect whether a top-level statement's persisted payload begins with the
 * `export` keyword (after optional leading whitespace and line/block
 * comments). Cheap text check that avoids a TS re-parse on every call.
 */
function isExportedPayload(payload: string): boolean {
  let i = 0;
  while (i < payload.length) {
    const ch = payload[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (payload.startsWith("//", i)) {
      const nl = payload.indexOf("\n", i);
      if (nl < 0) return false;
      i = nl + 1;
      continue;
    }
    if (payload.startsWith("/*", i)) {
      const close = payload.indexOf("*/", i + 2);
      if (close < 0) return false;
      i = close + 2;
      continue;
    }
    return payload.startsWith("export", i);
  }
  return false;
}

/**
 * List the top-level declarations of a module with their names and whether
 * they're exported. Cheap discovery primitive — one SQL query plus a join
 * to the declaration's name Identifier child.
 */
export function list_module_exports(
  db: Db,
  moduleId: string
): ModuleExport[] {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) {
    throw new Error(`Module not found: ${moduleId}`);
  }
  if (moduleNode.kind !== "Module") {
    throw new Error(
      `Node ${moduleId} is not a Module (kind=${moduleNode.kind})`
    );
  }

  const placeholders = DISCOVERY_KINDS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          d.id AS id,
          d.kind AS kind,
          d.payload AS payload,
          (
            SELECT CASE
              WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.text')
              ELSE NULL
            END
            FROM nodes i
            WHERE i.parent_id = d.id AND i.kind = 'Identifier'
            ORDER BY CAST(
              CASE
                WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.offset')
                ELSE NULL
              END AS INTEGER
            ) ASC, i.id ASC
            LIMIT 1
          ) AS name
        FROM nodes d
        WHERE d.parent_id = ?
          AND d.kind IN (${placeholders})
        ORDER BY d.child_index ASC
      `
    )
    .all(moduleId, ...DISCOVERY_KINDS) as {
    id: string;
    kind: string;
    payload: string;
    name: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    isExported: isExportedPayload(row.payload)
  }));
}

export interface FindInModuleInput {
  moduleId: string;
  name?: string;
  kind?: DiscoveryKind;
}

/**
 * Module-scoped variant of find_declarations. Saves the agent from a
 * codebase-wide fish when it already knows which module the declaration
 * belongs to (e.g., from list_module_exports or an upfront module index).
 */
export function find_declarations_in_module(
  db: Db,
  input: FindInModuleInput
): NodeRow[] {
  const kindList: string[] = input.kind ? [input.kind] : [...DISCOVERY_KINDS];
  const kindPlaceholders = kindList.map(() => "?").join(", ");

  if (input.name) {
    const rows = db
      .prepare(
        `
          SELECT d.id, d.kind, d.parent_id, d.child_index, d.payload
          FROM nodes d
          WHERE d.parent_id = ?
            AND d.kind IN (${kindPlaceholders})
            AND (
              SELECT CASE
                WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.text')
                ELSE NULL
              END
              FROM nodes i
              WHERE i.parent_id = d.id AND i.kind = 'Identifier'
              ORDER BY CAST(
                CASE
                  WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.offset')
                  ELSE NULL
                END AS INTEGER
              ) ASC, i.id ASC
              LIMIT 1
            ) = ?
        `
      )
      .all(input.moduleId, ...kindList, input.name) as {
      id: string;
      kind: string;
      parent_id: string | null;
      child_index: number | null;
      payload: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      parentId: row.parent_id,
      childIndex: row.child_index,
      payload: row.payload
    }));
  }

  const rows = db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE parent_id = ?
          AND kind IN (${kindPlaceholders})
        ORDER BY child_index ASC
      `
    )
    .all(input.moduleId, ...kindList) as {
    id: string;
    kind: string;
    parent_id: string | null;
    child_index: number | null;
    payload: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    childIndex: row.child_index,
    payload: row.payload
  }));
}

export const listModuleExports = list_module_exports;
export const findDeclarationsInModule = find_declarations_in_module;
