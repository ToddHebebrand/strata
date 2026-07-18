/**
 * preloadedCanonical — lab variant testing whether a corpus-map prompt
 * preload reduces name-fishing / discovery cost.
 *
 * NON-AUTHORITATIVE — this is a sandbox experiment to surface a token-cost
 * comparison cheaply (the bench-layer enriched-substrate experiment requires
 * env-var-only auth which the sandbox session cannot supply). Hypothesis
 * sourced from the 2026-05-26 cross-task bench: substrate loses 3-8x on
 * read-heavy tasks (T05/T08) due to find_declarations({}) fishing and name
 * guessing. Pre-injecting a corpus map should collapse the discovery phase.
 *
 * Setup: canonical (vanilla) Strata tools, no overrides. HD task. Prompt is
 * prefixed with a generated corpus map (modules + exports + test imports) of
 * the lab corpus, then the canonical HD prompt. Comparison: existing
 * canonical-control experiment (no prefix). Token delta is the signal.
 *
 * What this DOES NOT test: the bench's canonical T05/T08 path. Lab corpus
 * has different shape (HD-task-tuned with ZONE consts); the token-savings
 * RATIO should generalize but absolute numbers will differ.
 */

import { ingestBatch } from "@strata-code/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  listChildren,
  listModules,
  type Db,
  type NodeRow
} from "@strata-code/store";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { LabExperiment } from "../experiment";
import { HD_PROMPT } from "../tasks/honestDerivable";
import { buildEquippedToolServer } from "./equippedToolServer";

interface ExportEntry {
  kind: string;
  name: string;
}

interface ImportSummary {
  names: string[];
  from: string;
}

function stripLeadingComments(payload: string): string {
  let s = payload.trimStart();
  // Strip any number of leading block comments (JSDoc) and line comments.
  for (;;) {
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end < 0) return s;
      s = s.slice(end + 2).trimStart();
      continue;
    }
    if (s.startsWith("//")) {
      const end = s.indexOf("\n");
      if (end < 0) return "";
      s = s.slice(end + 1).trimStart();
      continue;
    }
    return s;
  }
}

function isExported(payload: string): boolean {
  const body = stripLeadingComments(payload);
  return /^export\b/.test(body);
}

function classifyDecl(nodeKind: string, payload: string): string | undefined {
  if (nodeKind === "FunctionDeclaration") return "function";
  if (nodeKind === "ClassDeclaration") return "class";
  if (nodeKind === "InterfaceDeclaration") return "interface";
  if (nodeKind === "TypeAliasDeclaration") return "type";
  if (nodeKind === "EnumDeclaration") return "enum";
  if (nodeKind === "FirstStatement" || nodeKind === "VariableStatement") {
    if (/\bconst\s+/.test(payload)) return "const";
    if (/\blet\s+/.test(payload)) return "let";
    if (/\bvar\s+/.test(payload)) return "var";
    return "var";
  }
  return undefined;
}

function extractDeclName(payload: string): string | undefined {
  const body = stripLeadingComments(payload).replace(/^export\s+/, "");
  const varMatch = body.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (varMatch) return varMatch[1];
  const declMatch = body.match(
    /^(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
  );
  if (declMatch) return declMatch[1];
  return undefined;
}

function collectExports(children: NodeRow[]): ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const child of children) {
    const payload = child.payload ?? "";
    if (!isExported(payload)) continue;
    const kind = classifyDecl(child.kind, payload);
    if (!kind) continue;
    const name = extractDeclName(payload);
    if (!name) continue;
    out.push({ kind, name });
  }
  return out;
}

function parseImport(payload: string): ImportSummary | undefined {
  const fromMatch = payload.match(/from\s+["']([^"']+)["']/);
  if (!fromMatch) return undefined;
  const from = fromMatch[1]!;
  const namedMatch = payload.match(/\{\s*([^}]+)\s*\}/);
  if (namedMatch) {
    const names = namedMatch[1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((s) => s.length > 0);
    return { names, from };
  }
  const defaultMatch = payload.match(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)/);
  if (defaultMatch) {
    return { names: [defaultMatch[1]!], from };
  }
  return undefined;
}

function collectImports(children: NodeRow[]): ImportSummary[] {
  const out: ImportSummary[] = [];
  for (const child of children) {
    if (child.kind !== "ImportDeclaration") continue;
    const parsed = parseImport(child.payload ?? "");
    if (parsed) out.push(parsed);
  }
  return out;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (full.endsWith(".ts")) {
        out.push({ path: full, text: readFileSync(full, "utf8") });
      }
    }
  }
  walk(rootDir);
  return out;
}

/**
 * Two prefix shapes:
 *   "kinded" (v1): "src/server/config.ts: exports const ZONE, function foo"
 *     The agent sees declaration kinds and is tempted to query with
 *     {name, kind:"variable"}, which currently triggers the FirstStatement
 *     bug in @strata-code/store/queries.ts:22 (kind:"variable" → SQL filter
 *     "VariableStatement" but ingest emits "FirstStatement"). The N=1 opus
 *     run measured this as a 250% increase in empty queries — the agent
 *     retries the same kind-filtered query that the substrate can't surface.
 *
 *   "kindless" (v2): "src/server/config.ts: exports ZONE, foo"
 *     Names only, no declaration kinds. The agent is steered toward
 *     find_declarations({name}) (no kind filter) which works correctly even
 *     for const decls. Sidesteps the FirstStatement bug at the prefix layer
 *     without requiring a canonical fix.
 */
type PrefixShape = "kinded" | "kindless";

function buildCorpusPrefix(
  db: Db,
  corpusRoot: string,
  shape: PrefixShape = "kinded"
): string {
  const modules = listModules(db);
  const srcLines: string[] = [];
  const testLines: string[] = [];

  for (const module of modules) {
    const relFromCorpus = toPosix(path.relative(corpusRoot, module.payload));
    const isTest =
      relFromCorpus.startsWith("tests/") || relFromCorpus.includes("/tests/");
    const children = listChildren(db, module.id);
    const exports = collectExports(children);
    const imports = collectImports(children);
    if (isTest) {
      const importsStr =
        imports.length === 0
          ? ""
          : ` (imports: ${imports.map((i) => `${i.names.join(", ")} from "${i.from}"`).join("; ")})`;
      testLines.push(`- ${relFromCorpus}${importsStr}`);
    } else {
      const exportsStr =
        exports.length === 0
          ? "(no exports)"
          : shape === "kindless"
            ? exports.map((e) => e.name).join(", ")
            : exports.map((e) => `${e.kind} ${e.name}`).join(", ");
      srcLines.push(`- ${relFromCorpus}: exports ${exportsStr}`);
    }
  }

  srcLines.sort();
  testLines.sort();

  const sections: string[] = ["# Codebase map (auto-generated)\n"];
  if (srcLines.length > 0) {
    sections.push("Modules:");
    sections.push(...srcLines);
    sections.push("");
  }
  if (testLines.length > 0) {
    sections.push("Test files (entry points for understanding behavior):");
    sections.push(...testLines);
    sections.push("");
  }
  sections.push(
    "Use find_declarations / get_references / read_node to inspect specific declarations. " +
      "Use the map above to know WHAT exists; use the tools to learn WHAT IT DOES."
  );
  return sections.join("\n");
}

/**
 * Build the HD prompt with a corpus-map prefix derived from the lab corpus.
 * Cached: the prefix is computed at module-load time so the experiment's
 * `prompt` field is a plain string (LabExperiment doesn't accept a factory).
 *
 * Why this is safe at module-load: the lab corpus is checked into the repo
 * and doesn't change between runs; the prefix is deterministic. If the
 * corpus is ever modified, restart the lab CLI to regenerate.
 */
function buildPreloadedPrompt(shape: PrefixShape = "kinded"): string {
  const corpusRoot = path.resolve(__dirname, "..", "..", "corpus");
  const srcRoot = path.join(corpusRoot, "src");
  const inputs = collectTsFiles(srcRoot);
  const testsRoot = path.join(corpusRoot, "tests");
  if (existsSync(testsRoot)) {
    inputs.push(...collectTsFiles(testsRoot));
  }
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const prefix = buildCorpusPrefix(db, corpusRoot, shape);
  return `${prefix}\n\n---\n\n${HD_PROMPT}`;
}

/**
 * preloaded-canonical — canonical tools, HD task, with corpus-map prefix
 * injected into the prompt. Compare against canonical-control (no prefix).
 * Token delta = the corpus-preload signal.
 */
export const preloadedCanonical: LabExperiment = {
  id: "preloaded-canonical",
  hypothesis:
    "Pre-injecting a corpus-map prefix collapses the agent's discovery " +
    "phase (no more find_declarations({}) fishing or name guessing). " +
    "Expect fewer tool calls + lower token count vs canonical-control " +
    "even though both use the same canonical tools and the same HD task.",
  task: "HD",
  overrides: {
    prompt: buildPreloadedPrompt("kinded")
  }
};

/**
 * preloaded-canonical-v2 — kindless prefix shape. Same map as v1 but
 * declaration kinds are omitted, so each entry is just "moduleName: exports
 * name1, name2, ...". Sidesteps the canonical FirstStatement-vs-variable
 * find_declarations bug (queries.ts:22) by not steering the agent toward
 * find_declarations({name, kind:"variable"}) which the substrate can't
 * surface for const decls.
 *
 * Sandbox hypothesis: opus's preload-induced retry loop (N=1 measurement:
 * preload +52% calls / +250% empty queries vs control) was caused by the
 * canonical kind-mapping bug, NOT by capability difference. If v2 closes
 * that gap, the design conclusion is "corpus-preload IS a cross-model win
 * once the kind-info is decoupled from the broken canonical filter."
 */
export const preloadedCanonicalV2: LabExperiment = {
  id: "preloaded-canonical-v2",
  hypothesis:
    "Kindless preload (names only, no declaration kinds) sidesteps the " +
    "find_declarations({kind:\"variable\"}) → FirstStatement canonical bug " +
    "without requiring a canonical fix. If opus's preload regression was " +
    "bug-induced, v2 should restore preload-positivity for opus.",
  task: "HD",
  overrides: {
    prompt: buildPreloadedPrompt("kindless")
  }
};

/**
 * preloaded-bugfixed — canonical tools but with find_declarations PATCHED
 * via the lab's equipped tool server (bug-fix wrapper; same tool NAMES, no
 * canonical change). Tests whether opus's preload-regression resolves when
 * find_declarations({kind:"variable"}) actually returns const decls.
 *
 * If opus + preload + bugfix-wrapper < opus + bugfix-wrapper alone, the
 * preload's value generalizes once the bug is fixed → empirical validation
 * that the 2-line canonical fix is load-bearing for cross-model preload
 * positivity.
 *
 * Existing experiments use buildEquippedToolServer with variant:true (which
 * also replaces add_parameter with the per-scope variant). Here we use
 * variant:false to isolate the find_declarations bugfix from the per-scope
 * add_parameter change.
 */
export const preloadedBugfixed: LabExperiment = {
  id: "preloaded-bugfixed",
  hypothesis:
    "If the canonical kind-mapping bug is fixed at the tool-handler layer " +
    "(via buildEquippedToolServer's find_declarations wrapper), the preload " +
    "should be cross-model positive — including on opus, which v1/v2 made " +
    "regressive due to bug-induced kind-cycling.",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildEquippedToolServer(ctx, { variant: false }),
    prompt: buildPreloadedPrompt("kinded")
  }
};

/**
 * bugfixed-only — same bug-fix tool wrapper as preloadedBugfixed but
 * WITHOUT the corpus prefix. Pure control for preloadedBugfixed: isolates
 * the preload's contribution from the bug-fix's contribution.
 */
export const bugfixedOnly: LabExperiment = {
  id: "bugfixed-only",
  hypothesis:
    "Bug-fix wrapper alone, no preload. Control for preloaded-bugfixed; the " +
    "delta between the two isolates the preload's contribution from the " +
    "bug-fix's contribution.",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildEquippedToolServer(ctx, { variant: false })
  }
};
