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
 * Natural-language task (no tool leak) used for BOTH arms. Moves the
 * `formatTimestamp` function from src/lib/format.ts into src/lib/dateRange.ts
 * and repoints every importer.
 *
 * This is a BULK-PROPAGATION task and — critically — one move_declaration v1 can
 * actually perform: in examples/medium, `formatTimestamp` is declared in
 * src/lib/format.ts and imported by 2 modules (src/server/events.ts and
 * src/ui/timeline.ts), both via PLAIN NAMED imports (`import { formatTimestamp }
 * from "../lib/format.ts"`), and it is NOT re-exported by the src/index.ts
 * barrel. It is self-contained (uses only the `Date` global). Moving the
 * declaration requires rewriting the import specifier in every importer so the
 * project still type-checks — exactly the rename-class leverage move_declaration
 * extends.
 *
 * (The original default — moving `User` from src/types/user.ts — was a v1
 * capability BOUNDARY, not a cost comparison: `User` has a namespace importer
 * (`import * as UserTypes` in src/users/serializer.ts) and a barrel re-export
 * (`export type { User } from "./types/user.ts"` in src/index.ts), both of which
 * move_declaration v1 provably refuses. Measuring that move would measure a
 * refusal, not bulk-propagation cost. See decisions.md.)
 */
export const MOVE_DOGFOOD_PROMPT =
  "Move the formatTimestamp function (and only that declaration) from " +
  "src/lib/format.ts into src/lib/dateRange.ts, and update every file that " +
  "imports it so the project still type-checks. Keep behavior identical.";

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
 * Identifies the symbol + source/target modules a move is verified against.
 * Defaults are keyed to MOVE_DOGFOOD_PROMPT (formatTimestamp: lib/format →
 * lib/dateRange) but are parameters so verifyMove isn't hardcoded when the
 * operator overrides the prompt. `sourceMatch`/`targetMatch` are path SUFFIXES
 * (POSIX, extension optional) matched against each corpus path; pick suffixes
 * specific enough to disambiguate (e.g. "lib/format" vs "lib/dateRange").
 */
export interface MoveTarget {
  symbol: string;
  /** Path suffix identifying the OLD source module (e.g. "types/user"). */
  sourceMatch: string;
  /** Path suffix identifying the NEW target module (e.g. "types.ts"). */
  targetMatch: string;
}

export const DEFAULT_MOVE_TARGET: MoveTarget = {
  symbol: "formatTimestamp",
  sourceMatch: "lib/format",
  targetMatch: "lib/dateRange"
};

export interface MoveVerification {
  /** Target module now declares the moved symbol. */
  movedToTarget: boolean;
  /** Source module no longer declares the moved symbol. */
  removedFromSource: boolean;
  /** No importer still imports the symbol from the OLD source path. */
  importersRepointed: boolean;
  /** The move actually happened: all three signals true. */
  performed: boolean;
}

export interface DogfoodMoveArm {
  arm: "substrate" | "baseline";
  terminalReason: string;
  /** tsc-clean signal: substrate=lastCommitOk; baseline=resultQuality.tscClean. */
  tscClean: boolean;
  /** vitest signal: substrate=n/a (tsc-only gate); baseline=vitestPassed. */
  vitestPassed: boolean | null;
  verification: MoveVerification | null;
  /** Overall quality floor for this arm: tsc-clean AND move performed. */
  qualityPass: boolean;
  cost: DogfoodArmCost;
}

export interface DogfoodMoveResult {
  corpusRoot: string;
  prompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  moveTarget: MoveTarget;
  armOrder: ["baseline", "substrate"];
  armBaseline: DogfoodMoveArm;
  armSubstrate: DogfoodMoveArm;
  /** substrate / baseline ratios (lower = substrate cheaper). */
  ratio: { costUsd: number; toolCalls: number; numTurns: number; wallMs: number };
  /** Both arms produced a valid, quality-passing move → comparison is conclusive. */
  bothQualityPass: boolean;
  /** Substrate cost USD <= baseline cost USD (only meaningful if bothQualityPass). */
  substrateCheaper: boolean;
}

export interface RunDogfoodMoveParams {
  corpusRoot: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  moveTarget?: MoveTarget;
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
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === symbol) return true;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === symbol) return true;
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === symbol) return true;
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === symbol) return true;
    if (ts.isEnumDeclaration(stmt) && stmt.name.text === symbol) return true;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === symbol) return true;
      }
    }
  }
  return false;
}

/**
 * True if `sf` imports `symbol` (named or via namespace) from a module
 * specifier whose path matches `sourceMatch` (suffix). Detects:
 *   import { User } from "../types/user"
 *   import { User as U } from "../types/user"
 *   import * as UserTypes from "../types/user"   (namespace re-export of symbol)
 */
function importsSymbolFrom(
  sf: ts.SourceFile,
  symbol: string,
  sourceMatch: string
): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    if (!pathEndsWith(spec.text, sourceMatch)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    // import * as NS from "...source..." — namespace pulls the whole module,
    // including `symbol`, from the old path.
    if (bindings && ts.isNamespaceImport(bindings)) return true;
    // import { ... User ... } from "...source..."
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        // propertyName is the original export name when aliased.
        const original = el.propertyName?.text ?? el.name.text;
        if (original === symbol) return true;
      }
    }
  }
  return false;
}

/**
 * Structurally verify a move across the resulting corpus (path → text).
 * The move is performed iff:
 *   (a) the moved symbol's declaration is GONE from the source module, AND
 *   (b) the moved symbol's declaration is PRESENT in the target module, AND
 *   (c) no importer still imports the symbol from the OLD source path.
 * Parses each file with the TypeScript compiler API for robustness.
 */
export function verifyMove(
  corpus: Map<string, string> | Record<string, string>,
  target: MoveTarget = DEFAULT_MOVE_TARGET
): MoveVerification {
  const entries: Array<[string, string]> =
    corpus instanceof Map ? [...corpus.entries()] : Object.entries(corpus);

  let movedToTarget = false;
  let removedFromSource = true; // true unless we find the decl still in source
  let sourceFound = false;
  let importersRepointed = true; // true unless some importer still points at source

  for (const [p, text] of entries) {
    const sf = ts.createSourceFile(
      normalizePath(p),
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const isSource = pathEndsWith(p, target.sourceMatch);
    const isTarget = pathEndsWith(p, target.targetMatch);

    if (isSource) {
      sourceFound = true;
      if (declaresSymbol(sf, target.symbol)) removedFromSource = false;
    }
    if (isTarget) {
      if (declaresSymbol(sf, target.symbol)) movedToTarget = true;
    }
    // Any module (including a stale source or target) that still imports the
    // symbol from the OLD path means importers weren't fully repointed.
    if (importsSymbolFrom(sf, target.symbol, target.sourceMatch)) {
      importersRepointed = false;
    }
  }

  // If the source module no longer exists at all, the declaration is by
  // definition gone from it.
  if (!sourceFound) removedFromSource = true;

  return {
    movedToTarget,
    removedFromSource,
    importersRepointed,
    performed: movedToTarget && removedFromSource && importersRepointed
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
  params: RunDogfoodMoveParams,
  prompt: string,
  target: MoveTarget
): Promise<DogfoodMoveArm> {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), "move-dogfood-sub-"));
  const dbPath = path.join(dbDir, "store.db");
  const result: AgentResult = await runAgent({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    behavioralFixtures: [], // tsc-only gate; symmetric with baseline (see markdown caveat)
    actor: "dogfood-move",
    dbPath,
    reset: true,
    injectModuleIndex: true
  });
  const corpus = result.dbPath ? renderCorpusFromDb(result.dbPath) : new Map();
  const verification = corpus.size > 0 ? verifyMove(corpus, target) : null;
  const tscClean = result.lastCommitOk;
  return {
    arm: "substrate",
    terminalReason: result.terminalReason,
    tscClean,
    vitestPassed: null,
    verification,
    qualityPass:
      result.terminalReason === "success" &&
      tscClean &&
      (verification?.performed ?? false),
    cost: costFromLog(result.log.events)
  };
}

async function runBaselineArm(
  params: RunDogfoodMoveParams,
  prompt: string,
  target: MoveTarget
): Promise<DogfoodMoveArm> {
  const result: BaselineResult = await runBaseline({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    keepTree: true
  });
  const corpus = result.tempTreeRoot
    ? readCorpusFromTree(result.tempTreeRoot)
    : new Map();
  const verification = corpus.size > 0 ? verifyMove(corpus, target) : null;
  return {
    arm: "baseline",
    terminalReason: result.terminalReason,
    tscClean: result.resultQuality.tscClean,
    vitestPassed: result.resultQuality.vitestPassed,
    verification,
    // Quality floor is tsc-clean + move-performed, SYMMETRIC with the substrate
    // arm's tsc-only gate. vitestPassed is informational only: examples/medium
    // ships a PRE-EXISTING failing test (the T05 half-open-interval fixture in
    // dateRange.test.ts), so full-suite vitest is not a clean gate and would
    // unfairly fail the baseline for a failure unrelated to the move.
    qualityPass:
      result.resultQuality.tscClean && (verification?.performed ?? false),
    cost: costFromLog(result.log.events)
  };
}

/**
 * move_declaration paired dogfood. Runs the same natural-language move task
 * through the file-tools BASELINE first, then the Strata SUBSTRATE (which has
 * move_declaration). Baseline-first so the substrate arm is the conservative
 * read on any prompt-cache warmth.
 *
 * This is the bulk-propagation validation: moving `formatTimestamp` requires
 * repointing every importer's specifier, the rename-class leverage
 * move_declaration extends.
 *
 * Honest N=1. Not a bench round. Per CLAUDE.md, do not generalize a single
 * paired trial into a "substrate wins/loses by N%" claim.
 */
export async function runDogfoodMove(
  params: RunDogfoodMoveParams
): Promise<DogfoodMoveResult> {
  const prompt = params.prompt ?? MOVE_DOGFOOD_PROMPT;
  const target = params.moveTarget ?? DEFAULT_MOVE_TARGET;
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
    moveTarget: target,
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
    substrateCheaper:
      bothQualityPass && armSubstrate.cost.costUsd <= armBaseline.cost.costUsd
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

export function renderDogfoodMoveMarkdown(result: DogfoodMoveResult): string {
  const b = result.armBaseline;
  const s = result.armSubstrate;
  const t = result.moveTarget;
  const lines: string[] = [];
  lines.push(`# move_declaration dogfood — substrate vs file-tools baseline`);
  lines.push("");
  lines.push(`- corpus: \`${result.corpusRoot}\``);
  lines.push(
    `- task: move \`${t.symbol}\` from \`${t.sourceMatch}\` into \`${t.targetMatch}\` + repoint every importer (bulk propagation)`
  );
  lines.push(`- prompt: "${result.prompt}"`);
  lines.push(
    `- model: \`${result.model}\`  bounds: maxTurns=${result.maxTurns}, wallMs=${result.wallTimeMs}`
  );
  lines.push(`- arm order: ${result.armOrder.join(" → ")} (baseline first)`);
  lines.push("");
  lines.push("| Metric | baseline (file tools) | substrate (move_declaration) | sub / base |");
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
  lines.push("## Quality floor (move actually performed + tsc-clean)");
  lines.push("");
  const armQuality = (a: DogfoodMoveArm): string => {
    const v = a.verification;
    return (
      `- **${a.arm}**: terminal=\`${a.terminalReason}\`, tscClean=${a.tscClean}, ` +
      `vitest=${a.vitestPassed === null ? "n/a (tsc-only gate)" : a.vitestPassed}, ` +
      `performed=${v?.performed ?? "unknown"} ` +
      `(movedToTarget=${v?.movedToTarget ?? "?"}, removedFromSource=${v?.removedFromSource ?? "?"}, importersRepointed=${v?.importersRepointed ?? "?"}) ` +
      `→ qualityPass=${a.qualityPass}`
    );
  };
  lines.push(armQuality(b));
  lines.push(armQuality(s));
  lines.push("");
  lines.push(
    `**Both arms quality-pass: ${result.bothQualityPass ? "YES — comparison is conclusive" : "NO — comparison inconclusive; investigate the failing arm"}.**`
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
    `- **N=1, single paired trial.** Not a bench round. Do not generalize to "move_declaration wins/loses by N%".`
  );
  lines.push(
    `- **Bulk-propagation task.** \`${t.symbol}\` is imported by multiple modules in examples/medium; moving the declaration forces every importer's specifier to be repointed. This is the rename-class leverage (per MEMORY: substrate's cost edge is bulk propagation over many refs), not a single-site edit.`
  );
  lines.push(
    `- **Behavior gate is tsc + structural move (symmetric).** vitest is informational only: examples/medium ships a PRE-EXISTING failing test (the T05 half-open-interval fixture in dateRange.test.ts), so the baseline's full-suite vitest=false is unrelated to the move and is NOT a quality failure. The substrate gate is tsc-only (empty behavioral fixtures); the baseline runs tsc + the corpus's (move-irrelevant) vitest suite. Asymmetry noted; immaterial here since no test depends on where \`${t.symbol}\` lives.`
  );
  return `${lines.join("\n")}\n`;
}
