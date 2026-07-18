import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  list_module_exports,
  listModules,
  type Db,
  type ModuleExport
} from "@strata-code/store";

/**
 * Map TS-style declaration kinds (as stored on NodeRow.kind) to the short
 * labels the design doc uses in the codebase-shape index. FirstStatement is
 * the TS catch-all for top-level variable statements; in our store it's how
 * `const`/`let`/`var` show up after ingest. Picking "const" is a pragmatic
 * shorthand — the agent reads the actual declaration with read_node when it
 * needs the keyword.
 */
const KIND_LABELS: Record<string, string> = {
  FunctionDeclaration: "function",
  InterfaceDeclaration: "interface",
  TypeAliasDeclaration: "type",
  ClassDeclaration: "class",
  FirstStatement: "const"
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function formatExport(exp: ModuleExport): string | null {
  if (!exp.name) return null;
  const label = kindLabel(exp.kind);
  return exp.isExported
    ? `${label} ${exp.name} [exported]`
    : `${label} ${exp.name}`;
}

function moduleRelativePath(modulePayload: string, corpusRoot: string): string {
  const srcRoot = path.join(corpusRoot, "src");
  if (modulePayload.startsWith(`${srcRoot}${path.sep}`)) {
    const rel = path.relative(corpusRoot, modulePayload);
    return rel.split(path.sep).join("/");
  }
  if (modulePayload.startsWith(`${corpusRoot}${path.sep}`)) {
    const rel = path.relative(corpusRoot, modulePayload);
    return rel.split(path.sep).join("/");
  }
  return modulePayload.split(path.sep).join("/");
}

function listTestFiles(corpusRoot: string): string[] {
  const out: string[] = [];
  for (const dirName of ["tests", "test"]) {
    const dir = path.join(corpusRoot, dirName);
    if (!existsSync(dir)) continue;
    if (!statSync(dir).isDirectory()) continue;
    walkTestDir(dir, corpusRoot, out);
  }
  out.sort();
  return out;
}

function walkTestDir(
  dir: string,
  corpusRoot: string,
  out: string[]
): void {
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const stats = statSync(abs);
    if (stats.isDirectory()) {
      walkTestDir(abs, corpusRoot, out);
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".spec.ts")) {
      const rel = path.relative(corpusRoot, abs).split(path.sep).join("/");
      out.push(rel);
    }
  }
}

/**
 * Build a compact codebase-shape index for the agent's turn-1 context.
 *
 * - Lists every Module's top-level declarations with kind + name + export tag.
 * - Appends a tests/ section listing on-disk test files under tests/ or test/
 *   (these aren't in the node graph — the agent reaches them via
 *   read_test_file).
 *
 * Pure function: reads from db and from the filesystem under corpusRoot. No
 * mutations.
 */
export function buildModuleIndex(db: Db, corpusRoot: string): string {
  const modules = listModules(db)
    .map((m) => ({ module: m, rel: moduleRelativePath(m.payload, corpusRoot) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const lines: string[] = [];
  lines.push("Codebase shape (auto-generated at session start):");

  if (modules.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const { module, rel } of modules) {
      const exports = list_module_exports(db, module.id);
      const formatted: string[] = [];
      for (const exp of exports) {
        const text = formatExport(exp);
        if (text) formatted.push(text);
      }
      if (formatted.length === 0) {
        lines.push(`${rel}: (no top-level declarations)`);
      } else {
        lines.push(`${rel}: ${formatted.join(", ")}`);
      }
    }
  }

  lines.push("");
  lines.push("tests/ (not in graph, use read_test_file):");
  const testFiles = listTestFiles(corpusRoot);
  if (testFiles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const file of testFiles) {
      lines.push(`  ${file}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
