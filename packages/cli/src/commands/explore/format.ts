import {
  modulePathOf,
  resolveDeclarationNameIdentifier,
  type Db,
  type NodeRow
} from "@strata-code/store";

/** Uniform result shape for every explore command; the dispatcher prints it. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function ok(stdout: string): CommandResult {
  return { code: 0, stdout: ensureNewline(stdout), stderr: "" };
}

export function fail(message: string): CommandResult {
  return { code: 1, stdout: "", stderr: ensureNewline(message) };
}

export function okJson(value: unknown): CommandResult {
  return ok(JSON.stringify(value, null, 2));
}

function ensureNewline(text: string): string {
  if (text.length === 0) return text;
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Column-aligned plain-text table. The ID column comes first by convention. */
export function printTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => (row[col] ?? "").length))
  );
  return all
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}

/** Human-facing DeclarationKind labels for stored statement kinds. */
const STATEMENT_KIND_LABELS: Record<string, string> = {
  InterfaceDeclaration: "interface",
  TypeAliasDeclaration: "type-alias",
  ClassDeclaration: "class",
  FunctionDeclaration: "function",
  FirstStatement: "variable"
};

export function kindLabel(kind: string): string {
  return STATEMENT_KIND_LABELS[kind] ?? kind;
}

export interface NodeSummary {
  id: string;
  kind: string;
  name: string | null;
  module: string;
}

/** Resolve the display summary of a declaration row: id, kind, name, module. */
export function nodeSummary(db: Db, row: NodeRow): NodeSummary {
  let name: string | null = null;
  const nameIdent = resolveDeclarationNameIdentifier(db, row.id);
  if (nameIdent) {
    try {
      const parsed = JSON.parse(nameIdent.payload) as { text?: string };
      if (typeof parsed.text === "string") name = parsed.text;
    } catch {
      // payload not JSON — leave name null
    }
  }
  let module = "<unknown>";
  try {
    module = modulePathOf(db, row.id);
  } catch {
    // orphaned node — surface it anyway
  }
  return { id: row.id, kind: row.kind, name, module };
}

/**
 * First code line of a statement payload, trimmed for table context columns.
 * Leading line/block comments (JSDoc) are skipped so a documented statement
 * shows its code, not its comment opener.
 */
export function firstLine(payload: string, maxLength = 72): string {
  let text = payload.trimStart();
  for (;;) {
    if (text.startsWith("//")) {
      const nl = text.indexOf("\n");
      if (nl < 0) return "";
      text = text.slice(nl + 1).trimStart();
      continue;
    }
    if (text.startsWith("/*")) {
      const close = text.indexOf("*/", 2);
      if (close < 0) return "";
      text = text.slice(close + 2).trimStart();
      continue;
    }
    break;
  }
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}
