import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  runAgent,
  runBaseline,
  type AgentResult,
  type BaselineResult,
  type SessionLogEvent
} from "@strata/agent";
import { openDb, listModules, loadModule } from "@strata/store";
import { render } from "@strata/render";

/**
 * Natural-language task (no tool leak) used for BOTH arms. Inlines the
 * `formatTimestamp` function from src/lib/format.ts into every file that calls
 * it (replacing each call with the function's body), deletes the declaration,
 * and strips it from importers.
 *
 * CAPABILITY-BOUNDARY NOTE (honest framing — read decisions.md 2026-05-30):
 * In examples/medium, `formatTimestamp` is a single self-contained expression
 * body (`return new Date(ts).toISOString();`), AND it is imported by 2 modules
 * (src/server/events.ts and src/ui/timeline.ts) via plain named imports, AND it
 * is not barrel-re-exported. BUT src/ui/timeline.ts ALSO passes it as a `.map`
 * callback (`times.map(formatTimestamp)`) — a non-call VALUE use. inline_function
 * v1 provably REFUSES any function with a non-call reference (it cannot rewrite a
 * value/callback use into an inlined expression), so the substrate arm measures a
 * REFUSAL here, not bulk-propagation cost.
 *
 * The medium corpus contains no self-contained, single-expression function with
 * MULTIPLE direct-call sites and no disqualifying use (the other one-liner
 * exports are either dead code with 0 call sites, reference module-local/imported
 * symbols, are multi-statement, or are barrel-re-exported). So this default is a
 * capability-boundary demo, exactly as the move_declaration dogfood default
 * originally was. An operator with a richer corpus can override `--prompt` +
 * `DEFAULT_INLINE_TARGET` to measure the real bulk-propagation cost edge (inline
 * rewrites EVERY call site, so it is in the substrate's cost-win class when the
 * function is actually inlinable).
 */
export const INLINE_DOGFOOD_PROMPT =
  "Inline the formatTimestamp function from src/lib/format.ts into every file " +
  "that calls it (replace each call with the function's body), delete the " +
  "declaration, and update imports so the project still type-checks. Keep behavior identical.";

export interface DogfoodArmCost {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  wallMs: number;
  apiMs: number;
  numTurns: number;
  toolCalls: number;
  costUsd: number;
}

/**
 * Identifies the symbol + its declaring module an inline is verified against.
 * Defaults are keyed to INLINE_DOGFOOD_PROMPT (formatTimestamp in lib/format)
 * but are parameters so verifyInline isn't hardcoded when the operator overrides
 * the prompt. `sourceMatch` is a path SUFFIX (POSIX, extension optional) matched
 * against each corpus path.
 */
export interface InlineTarget {
  symbol: string;
  /** Path suffix identifying the module that DECLARES the symbol (e.g. "lib/format"). */
  sourceMatch: string;
}

export const DEFAULT_INLINE_TARGET: InlineTarget = {
  symbol: "formatTimestamp",
  sourceMatch: "lib/format"
};

export interface InlineVerification {
  /** Source module no longer declares the symbol (the declaration was removed). */
  declRemoved: boolean;
  /** No module still imports the symbol from the source path (importers stripped). */
  importsStripped: boolean;
  /** No module still contains a direct call `symbol(...)` (every call site was substituted). */
  callsReplaced: boolean;
  /** The inline actually happened: all three signals true. */
  performed: boolean;
}

export interface DogfoodInlineArm {
  arm: "substrate" | "baseline";
  terminalReason: string;
  /** tsc-clean signal: substrate=lastCommitOk; baseline=resultQuality.tscClean. */
  tscClean: boolean;
  /** vitest signal: substrate=n/a (tsc-only gate); baseline=vitestPassed. */
  vitestPassed: boolean | null;
  verification: InlineVerification | null;
  /** Overall quality floor for this arm: tsc-clean AND inline performed. */
  qualityPass: boolean;
  cost: DogfoodArmCost;
}

export interface DogfoodInlineResult {
  corpusRoot: string;
  prompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  inlineTarget: InlineTarget;
  armOrder: ["baseline", "substrate"];
  armBaseline: DogfoodInlineArm;
  armSubstrate: DogfoodInlineArm;
  /** substrate / baseline ratios (lower = substrate cheaper). */
  ratio: { costUsd: number; toolCalls: number; numTurns: number; wallMs: number };
  /** Both arms produced a valid, quality-passing inline → comparison is conclusive. */
  bothQualityPass: boolean;
  /** Substrate cost USD <= baseline cost USD (only meaningful if bothQualityPass). */
  substrateCheaper: boolean;
}

export interface RunDogfoodInlineParams {
  corpusRoot: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  inlineTarget?: InlineTarget;
}

function costFromLog(events: readonly SessionLogEvent[]): DogfoodArmCost {
  const resultEvent = events.find(
    (e): e is Extract<SessionLogEvent, { type: "result" }> => e.type === "result"
  );
  const usage = resultEvent?.usage;
  const toolCalls = events.filter(
    (e): e is Extract<SessionLogEvent, { type: "tool_call" }> => e.type === "tool_call"
  );
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    wallMs: resultEvent?.durationMs ?? 0,
    apiMs: resultEvent?.durationApiMs ?? 0,
    numTurns: resultEvent?.numTurns ?? 0,
    toolCalls: toolCalls.length,
    costUsd: resultEvent?.totalCostUsd ?? 0
  };
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Strip a trailing .ts/.tsx/.js extension for suffix-comparison robustness. */
function stripExt(p: string): string {
  return normalizePath(p).replace(/\.(tsx?|jsx?)$/, "");
}

function pathEndsWith(p: string, suffix: string): boolean {
  return stripExt(p).endsWith(stripExt(suffix));
}

/** True if `sf` has a top-level declaration named `symbol`. */
function declaresSymbol(sf: ts.SourceFile, symbol: string): boolean {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === symbol) return true;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === symbol) return true;
      }
    }
  }
  return false;
}

/** True if `sf` imports `symbol` (named) from a module specifier matching `sourceMatch`. */
function importsSymbolFrom(sf: ts.SourceFile, symbol: string, sourceMatch: string): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!pathEndsWith(spec.text, sourceMatch)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return true;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const original = el.propertyName?.text ?? el.name.text;
        if (original === symbol) return true;
      }
    }
  }
  return false;
}

/** True if `sf` contains a direct call `symbol(...)` (plain identifier callee). */
function hasDirectCall(sf: ts.SourceFile, symbol: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === symbol) {
      found = true;
      return;
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return found;
}

/**
 * Structurally verify an inline across the resulting corpus (path → text).
 * The inline is performed iff:
 *   (a) the symbol's declaration is GONE from its source module, AND
 *   (b) no module still imports the symbol from the source path, AND
 *   (c) no module still contains a direct call `symbol(...)` (every call site
 *       was substituted with the inlined body).
 * Parses each file with the TypeScript compiler API for robustness.
 */
export function verifyInline(
  corpus: Map<string, string> | Record<string, string>,
  target: InlineTarget = DEFAULT_INLINE_TARGET
): InlineVerification {
  const entries: Array<[string, string]> =
    corpus instanceof Map ? [...corpus.entries()] : Object.entries(corpus);

  let declRemoved = true; // true unless we find the decl still in source
  let sourceFound = false;
  let importsStripped = true; // true unless some module still imports from source
  let callsReplaced = true; // true unless some module still calls the symbol directly

  for (const [p, text] of entries) {
    const sf = ts.createSourceFile(normalizePath(p), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (pathEndsWith(p, target.sourceMatch)) {
      sourceFound = true;
      if (declaresSymbol(sf, target.symbol)) declRemoved = false;
    }
    if (importsSymbolFrom(sf, target.symbol, target.sourceMatch)) importsStripped = false;
    if (hasDirectCall(sf, target.symbol)) callsReplaced = false;
  }
  if (!sourceFound) declRemoved = true; // source module gone entirely → decl is gone

  return {
    declRemoved,
    importsStripped,
    callsReplaced,
    performed: declRemoved && importsStripped && callsReplaced
  };
}

/** Render every module from a persisted store into a path → text map. */
function renderCorpusFromDb(dbPath: string): Map<string, string> {
  const db = openDb(dbPath);
  const corpus = new Map<string, string>();
  try {
    for (const mod of listModules(db)) {
      const loaded = loadModule(db, mod.id);
      corpus.set(normalizePath(mod.payload), render(loaded.module, loaded.children));
    }
  } finally {
    db.close();
  }
  return corpus;
}

/** Read every *.ts file under a temp tree root into a path → text map. */
function readCorpusFromTree(root: string): Map<string, string> {
  const corpus = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        walk(full);
      } else if (/\.(tsx?)$/.test(entry)) {
        try {
          corpus.set(normalizePath(full), readFileSync(full, "utf8"));
        } catch {
          // skip unreadable files
        }
      }
    }
  };
  walk(root);
  return corpus;
}

async function runSubstrateArm(
  params: RunDogfoodInlineParams,
  prompt: string,
  target: InlineTarget
): Promise<DogfoodInlineArm> {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), "inline-dogfood-sub-"));
  const dbPath = path.join(dbDir, "store.db");
  const result: AgentResult = await runAgent({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    behavioralFixtures: [], // tsc-only gate; symmetric with baseline (see markdown caveat)
    actor: "dogfood-inline",
    dbPath,
    reset: true,
    injectModuleIndex: true
  });
  const corpus = result.dbPath ? renderCorpusFromDb(result.dbPath) : new Map();
  const verification = corpus.size > 0 ? verifyInline(corpus, target) : null;
  const tscClean = result.lastCommitOk;
  return {
    arm: "substrate",
    terminalReason: result.terminalReason,
    tscClean,
    vitestPassed: null,
    verification,
    qualityPass:
      result.terminalReason === "success" && tscClean && (verification?.performed ?? false),
    cost: costFromLog(result.log.events)
  };
}

async function runBaselineArm(
  params: RunDogfoodInlineParams,
  prompt: string,
  target: InlineTarget
): Promise<DogfoodInlineArm> {
  const result: BaselineResult = await runBaseline({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    keepTree: true
  });
  const corpus = result.tempTreeRoot ? readCorpusFromTree(result.tempTreeRoot) : new Map();
  const verification = corpus.size > 0 ? verifyInline(corpus, target) : null;
  return {
    arm: "baseline",
    terminalReason: result.terminalReason,
    tscClean: result.resultQuality.tscClean,
    vitestPassed: result.resultQuality.vitestPassed,
    verification,
    // Quality floor is tsc-clean + inline-performed, SYMMETRIC with the substrate
    // arm's tsc-only gate. vitestPassed is informational only: examples/medium
    // ships a PRE-EXISTING failing test (the T05 half-open-interval fixture in
    // dateRange.test.ts), so full-suite vitest is not a clean gate.
    qualityPass: result.resultQuality.tscClean && (verification?.performed ?? false),
    cost: costFromLog(result.log.events)
  };
}

/**
 * inline_function paired dogfood. Runs the same natural-language inline task
 * through the file-tools BASELINE first, then the Strata SUBSTRATE (which has
 * inline_function). Baseline-first so the substrate arm is the conservative read
 * on any prompt-cache warmth.
 *
 * Inline rewrites EVERY call site (bulk propagation → the substrate's cost-win
 * class) WHEN the function is inlinable. The default target (formatTimestamp) is
 * a capability boundary in examples/medium — see the INLINE_DOGFOOD_PROMPT note
 * — so the default substrate arm measures a refusal, not a cost edge. Override
 * `--prompt` + `inlineTarget` for a corpus with a cleanly inlinable function.
 *
 * Honest N=1. Not a bench round. Per CLAUDE.md, do not generalize a single
 * paired trial into a "substrate wins/loses by N%" claim.
 */
export async function runDogfoodInline(
  params: RunDogfoodInlineParams
): Promise<DogfoodInlineResult> {
  const prompt = params.prompt ?? INLINE_DOGFOOD_PROMPT;
  const target = params.inlineTarget ?? DEFAULT_INLINE_TARGET;
  const armBaseline = await runBaselineArm(params, prompt, target);
  const armSubstrate = await runSubstrateArm(params, prompt, target);

  const ratio = (a: number, b: number) => (b > 0 ? a / b : Number.NaN);
  const bothQualityPass = armBaseline.qualityPass && armSubstrate.qualityPass;

  return {
    corpusRoot: path.resolve(params.corpusRoot),
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    inlineTarget: target,
    armOrder: ["baseline", "substrate"],
    armBaseline,
    armSubstrate,
    ratio: {
      costUsd: ratio(armSubstrate.cost.costUsd, armBaseline.cost.costUsd),
      toolCalls: ratio(armSubstrate.cost.toolCalls, armBaseline.cost.toolCalls),
      numTurns: ratio(armSubstrate.cost.numTurns, armBaseline.cost.numTurns),
      wallMs: ratio(armSubstrate.cost.wallMs, armBaseline.cost.wallMs)
    },
    bothQualityPass,
    substrateCheaper: bothQualityPass && armSubstrate.cost.costUsd <= armBaseline.cost.costUsd
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function fmtPct(r: number): string {
  return Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : "n/a";
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function renderDogfoodInlineMarkdown(result: DogfoodInlineResult): string {
  const b = result.armBaseline;
  const s = result.armSubstrate;
  const t = result.inlineTarget;
  const lines: string[] = [];
  lines.push(`# inline_function dogfood — substrate vs file-tools baseline`);
  lines.push("");
  lines.push(`- corpus: \`${result.corpusRoot}\``);
  lines.push(
    `- task: inline \`${t.symbol}\` (declared in \`${t.sourceMatch}\`) into every call site + strip importers (bulk propagation)`
  );
  lines.push(`- prompt: "${result.prompt}"`);
  lines.push(
    `- model: \`${result.model}\`  bounds: maxTurns=${result.maxTurns}, wallMs=${result.wallTimeMs}`
  );
  lines.push(`- arm order: ${result.armOrder.join(" → ")} (baseline first)`);
  lines.push("");
  lines.push("| Metric | baseline (file tools) | substrate (inline_function) | sub / base |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| Cost USD | ${fmtUsd(b.cost.costUsd)} | ${fmtUsd(s.cost.costUsd)} | ${fmtPct(result.ratio.costUsd)} |`);
  lines.push(`| Tool calls | ${fmt(b.cost.toolCalls)} | ${fmt(s.cost.toolCalls)} | ${fmtPct(result.ratio.toolCalls)} |`);
  lines.push(`| Turns | ${fmt(b.cost.numTurns)} | ${fmt(s.cost.numTurns)} | ${fmtPct(result.ratio.numTurns)} |`);
  lines.push(`| Wall ms | ${fmt(b.cost.wallMs)} | ${fmt(s.cost.wallMs)} | ${fmtPct(result.ratio.wallMs)} |`);
  lines.push(`| Total tokens | ${fmt(b.cost.totalTokens)} | ${fmt(s.cost.totalTokens)} | — |`);
  lines.push(`| Input tokens | ${fmt(b.cost.inputTokens)} | ${fmt(s.cost.inputTokens)} | — |`);
  lines.push(`| Output tokens | ${fmt(b.cost.outputTokens)} | ${fmt(s.cost.outputTokens)} | — |`);
  lines.push(`| Cache read input | ${fmt(b.cost.cacheReadInputTokens)} | ${fmt(s.cost.cacheReadInputTokens)} | — |`);
  lines.push(`| Cache creation input | ${fmt(b.cost.cacheCreationInputTokens)} | ${fmt(s.cost.cacheCreationInputTokens)} | — |`);
  lines.push("");
  lines.push("## Quality floor (inline actually performed + tsc-clean)");
  lines.push("");
  const armQuality = (a: DogfoodInlineArm): string => {
    const v = a.verification;
    return (
      `- **${a.arm}**: terminal=\`${a.terminalReason}\`, tscClean=${a.tscClean}, ` +
      `vitest=${a.vitestPassed === null ? "n/a (tsc-only gate)" : a.vitestPassed}, ` +
      `performed=${v?.performed ?? "unknown"} ` +
      `(declRemoved=${v?.declRemoved ?? "?"}, importsStripped=${v?.importsStripped ?? "?"}, callsReplaced=${v?.callsReplaced ?? "?"}) ` +
      `→ qualityPass=${a.qualityPass}`
    );
  };
  lines.push(armQuality(b));
  lines.push(armQuality(s));
  lines.push("");
  lines.push(
    `**Both arms quality-pass: ${result.bothQualityPass ? "YES — comparison is conclusive" : "NO — comparison inconclusive; investigate the failing arm (the default target is a substrate capability boundary — see caveats)"}.**`
  );
  if (result.bothQualityPass) {
    lines.push("");
    lines.push(
      `**Cost (primary metric — cache pricing dominates, per decisions.md 2026-05-27): ` +
        `substrate ${fmtUsd(s.cost.costUsd)} vs baseline ${fmtUsd(b.cost.costUsd)} ` +
        `(${fmtPct(result.ratio.costUsd)}) → substrate ${result.substrateCheaper ? "CHEAPER" : "NOT cheaper"}.**`
    );
  }
  lines.push("");
  lines.push("## Honest caveats");
  lines.push(
    `- **N=1, single paired trial.** Not a bench round. Do not generalize to "inline_function wins/loses by N%".`
  );
  lines.push(
    `- **Bulk-propagation task (when inlinable).** Inlining \`${t.symbol}\` rewrites EVERY call site with the function's body and strips it from importers — the rename-class leverage (per MEMORY: the substrate's cost edge is bulk propagation over many refs), not a single-site edit.`
  );
  lines.push(
    `- **Default target is a substrate capability BOUNDARY in examples/medium.** \`formatTimestamp\` is passed as a \`.map\` callback in src/ui/timeline.ts (a non-call value use), which inline_function v1 provably refuses. So the default substrate arm measures a REFUSAL, not a cost edge. Override \`--prompt\` + inline target for a corpus with a cleanly inlinable, multi-call function. See decisions.md 2026-05-30.`
  );
  lines.push(
    `- **Behavior gate is tsc + structural inline (symmetric).** vitest is informational only: examples/medium ships a PRE-EXISTING failing test unrelated to the inline.`
  );
  return `${lines.join("\n")}\n`;
}
