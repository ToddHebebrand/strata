import { findNodeById, type NodeRow } from "./nodes";
import type { Db } from "./schema";
import { resolveDeclarationNameIdentifier } from "./declarationName";

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
 * they're exported. Cheap discovery primitive — one SQL query plus one
 * resolveDeclarationNameIdentifier call per row (O(N_decls) payload parses;
 * acceptable for now — a persisted name column can optimize later if needed).
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
  // Name resolution is via resolveDeclarationNameIdentifier — see declarationName.ts.
  // O(N_decls) payload parses; acceptable for now — a persisted name column
  // can optimize later if needed.
  const rows = db
    .prepare(
      `
        SELECT d.id AS id, d.kind AS kind, d.payload AS payload
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
  }[];

  return rows.map((row) => {
    let name: string | null = null;
    const nameIdent = resolveDeclarationNameIdentifier(db, row.id);
    if (nameIdent) {
      try {
        const parsed = JSON.parse(nameIdent.payload) as { text?: string };
        if (typeof parsed.text === "string") name = parsed.text;
      } catch {
        // payload not JSON — leave name as null
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      name,
      isExported: isExportedPayload(row.payload)
    };
  });
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
 * When a name filter is present: O(N_decls) payload parses via
 * resolveDeclarationNameIdentifier; acceptable for now — a persisted name
 * column can optimize later if needed.
 */
export function find_declarations_in_module(
  db: Db,
  input: FindInModuleInput
): NodeRow[] {
  const kindList: string[] = input.kind ? [input.kind] : [...DISCOVERY_KINDS];
  const kindPlaceholders = kindList.map(() => "?").join(", ");

  if (input.name) {
    // Fetch all candidates by kind, then filter in JS using
    // resolveDeclarationNameIdentifier. This avoids the broken
    // "lowest-offset Identifier child" SQL subquery which returns JSDoc @param
    // tag words instead of the actual declaration name for JSDoc'd declarations.
    const candidates = db
      .prepare(
        `
          SELECT d.id, d.kind, d.parent_id, d.child_index, d.payload
          FROM nodes d
          WHERE d.parent_id = ?
            AND d.kind IN (${kindPlaceholders})
        `
      )
      .all(input.moduleId, ...kindList) as {
      id: string;
      kind: string;
      parent_id: string | null;
      child_index: number | null;
      payload: string;
    }[];

    return candidates
      .filter((row) => {
        const nameIdent = resolveDeclarationNameIdentifier(db, row.id);
        if (!nameIdent) return false;
        try {
          const parsed = JSON.parse(nameIdent.payload) as { text?: string };
          return parsed.text === input.name;
        } catch {
          return false;
        }
      })
      .map((row) => ({
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
