import { mkdtempSync, readFileSync } from "node:fs";
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
 * Natural-language task (no tool leak) used for BOTH arms. Extracts the inline
 * token-parsing loop in parseArgs (examples/medium/src/flags.ts) into a helper.
 * Verified deterministically (extract_function auto-infers the 3-param void
 * signature with by-reference mutation semantics, commit gate clean) before
 * any keyed run.
 */
export const EXTRACT_DOGFOOD_PROMPT =
  "In src/flags.ts, the parseArgs function parses argument tokens with an " +
  "inline for-loop. Extract that token-parsing loop into a separate, " +
  "well-named helper function in the same file and call it from parseArgs. " +
  "Keep behavior identical.";

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

export interface FlagsVerification {
  /** Top-level function declaration names in the resulting flags.ts. */
  topLevelFunctionNames: string[];
  /** Whether parseArgs's body still contains an inline loop (not extracted). */
  parseArgsHasInlineLoop: boolean;
  /** parseArgs was found in the resulting module at all. */
  parseArgsFound: boolean;
  /**
   * Structural signal that an extraction happened: parseArgs exists, no longer
   * holds the inline loop, and a new top-level function appeared (original
   * flags.ts has exactly 2: parseArgs, numberOption).
   */
  extractionPerformed: boolean;
}

export interface DogfoodExtractArm {
  arm: "substrate" | "baseline";
  terminalReason: string;
  /** tsc-clean signal: substrate=lastCommitOk; baseline=resultQuality.tscClean. */
  tscClean: boolean;
  /** vitest signal: substrate=n/a (tsc-only gate); baseline=vitestPassed. */
  vitestPassed: boolean | null;
  /** Resulting flags.ts text (rendered from db / read from temp tree), or null. */
  flagsText: string | null;
  verification: FlagsVerification | null;
  /** Overall quality floor for this arm: tsc-clean AND extraction performed. */
  qualityPass: boolean;
  cost: DogfoodArmCost;
}

export interface DogfoodExtractResult {
  corpusRoot: string;
  prompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  armOrder: ["baseline", "substrate"];
  armBaseline: DogfoodExtractArm;
  armSubstrate: DogfoodExtractArm;
  /** substrate / baseline ratios (lower = substrate cheaper). */
  ratio: { costUsd: number; toolCalls: number; numTurns: number; wallMs: number };
  /** Both arms produced a valid, quality-passing extraction → comparison is conclusive. */
  bothQualityPass: boolean;
  /** Substrate cost USD <= baseline cost USD (only meaningful if bothQualityPass). */
  substrateCheaper: boolean;
}

export interface RunDogfoodExtractParams {
  corpusRoot: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
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

/** Parse a flags.ts text and structurally check whether the loop was extracted. */
export function verifyFlags(text: string): FlagsVerification {
  const sf = ts.createSourceFile(
    "flags.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fnNames: string[] = [];
  let parseArgsFound = false;
  let parseArgsHasInlineLoop = false;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      fnNames.push(stmt.name.text);
      if (stmt.name.text === "parseArgs" && stmt.body) {
        parseArgsFound = true;
        parseArgsHasInlineLoop = stmt.body.statements.some(
          (s) =>
            ts.isForStatement(s) ||
            ts.isForOfStatement(s) ||
            ts.isForInStatement(s) ||
            ts.isWhileStatement(s) ||
            ts.isDoStatement(s)
        );
      }
    }
  }
  return {
    topLevelFunctionNames: fnNames,
    parseArgsHasInlineLoop,
    parseArgsFound,
    extractionPerformed:
      parseArgsFound && !parseArgsHasInlineLoop && fnNames.length >= 3
  };
}

/** Render the flags.ts module from a persisted store, or null if not found. */
function renderFlagsFromDb(dbPath: string): string | null {
  const db = openDb(dbPath);
  try {
    const mod = listModules(db).find((m) =>
      m.payload.replaceAll("\\", "/").endsWith("flags.ts")
    );
    if (!mod) return null;
    const loaded = loadModule(db, mod.id);
    return render(loaded.module, loaded.children);
  } finally {
    db.close();
  }
}

async function runSubstrateArm(
  params: RunDogfoodExtractParams,
  prompt: string
): Promise<DogfoodExtractArm> {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), "extract-dogfood-sub-"));
  const dbPath = path.join(dbDir, "store.db");
  const result: AgentResult = await runAgent({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    behavioralFixtures: [], // tsc-only gate; medium has no parseArgs test (see markdown caveat)
    actor: "dogfood-extract",
    dbPath,
    reset: true,
    injectModuleIndex: true
  });
  const flagsText = result.dbPath ? renderFlagsFromDb(result.dbPath) : null;
  const verification = flagsText ? verifyFlags(flagsText) : null;
  const tscClean = result.lastCommitOk;
  return {
    arm: "substrate",
    terminalReason: result.terminalReason,
    tscClean,
    vitestPassed: null,
    flagsText,
    verification,
    qualityPass:
      result.terminalReason === "success" &&
      tscClean &&
      (verification?.extractionPerformed ?? false),
    cost: costFromLog(result.log.events)
  };
}

async function runBaselineArm(
  params: RunDogfoodExtractParams,
  prompt: string
): Promise<DogfoodExtractArm> {
  const result: BaselineResult = await runBaseline({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
    keepTree: true
  });
  let flagsText: string | null = null;
  if (result.tempTreeRoot) {
    const flagsPath = path.join(result.tempTreeRoot, "src", "flags.ts");
    try {
      flagsText = readFileSync(flagsPath, "utf8");
    } catch {
      flagsText = null;
    }
  }
  const verification = flagsText ? verifyFlags(flagsText) : null;
  return {
    arm: "baseline",
    terminalReason: result.terminalReason,
    tscClean: result.resultQuality.tscClean,
    vitestPassed: result.resultQuality.vitestPassed,
    flagsText,
    verification,
    // Quality floor is tsc-clean + extraction-performed, SYMMETRIC with the
    // substrate arm's tsc-only gate. vitestPassed is informational only: a
    // corpus may ship a pre-existing failing test (e.g. examples/medium's T05
    // half-open-interval fixture), so full-suite vitest is not a clean gate and
    // would unfairly fail the baseline for a failure unrelated to the task.
    qualityPass:
      result.resultQuality.tscClean && (verification?.extractionPerformed ?? false),
    cost: costFromLog(result.log.events)
  };
}

/**
 * extract_function paired dogfood. Runs the same natural-language extraction
 * task through the file-tools BASELINE first, then the Strata SUBSTRATE
 * (which has extract_function). Baseline-first so the substrate arm is the
 * conservative read on any prompt-cache warmth.
 *
 * Honest N=1. Not a bench round. Per CLAUDE.md, do not generalize a single
 * paired trial into a "substrate wins/loses by N%" claim.
 */
export async function runDogfoodExtract(
  params: RunDogfoodExtractParams
): Promise<DogfoodExtractResult> {
  const prompt = params.prompt ?? EXTRACT_DOGFOOD_PROMPT;
  const armBaseline = await runBaselineArm(params, prompt);
  const armSubstrate = await runSubstrateArm(params, prompt);

  const ratio = (a: number, b: number) => (b > 0 ? a / b : Number.NaN);
  const bothQualityPass = armBaseline.qualityPass && armSubstrate.qualityPass;

  return {
    corpusRoot: path.resolve(params.corpusRoot),
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 25,
    wallTimeMs: params.wallTimeMs ?? 240_000,
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

export function renderDogfoodExtractMarkdown(result: DogfoodExtractResult): string {
  const b = result.armBaseline;
  const s = result.armSubstrate;
  const lines: string[] = [];
  lines.push(`# extract_function dogfood — substrate vs file-tools baseline`);
  lines.push("");
  lines.push(`- corpus: \`${result.corpusRoot}\``);
  lines.push(`- task: extract the parseArgs token-parsing loop (src/flags.ts) into a helper`);
  lines.push(`- prompt: "${result.prompt}"`);
  lines.push(`- model: \`${result.model}\`  bounds: maxTurns=${result.maxTurns}, wallMs=${result.wallTimeMs}`);
  lines.push(`- arm order: ${result.armOrder.join(" → ")} (baseline first)`);
  lines.push("");
  lines.push("| Metric | baseline (file tools) | substrate (extract_function) | sub / base |");
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
  lines.push("## Quality floor (extraction actually performed + tsc-clean)");
  lines.push("");
  const armQuality = (a: DogfoodExtractArm): string => {
    const v = a.verification;
    return (
      `- **${a.arm}**: terminal=\`${a.terminalReason}\`, tscClean=${a.tscClean}, ` +
      `vitest=${a.vitestPassed === null ? "n/a (tsc-only gate)" : a.vitestPassed}, ` +
      `extractionPerformed=${v?.extractionPerformed ?? "unknown"} ` +
      `(functions: [${v?.topLevelFunctionNames.join(", ") ?? "?"}], parseArgs inline-loop: ${v?.parseArgsHasInlineLoop ?? "?"}) ` +
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
    `- **N=1, single paired trial.** Not a bench round. Do not generalize to "extract_function wins/loses by N%".`
  );
  lines.push(
    `- **Behavior not test-gated for this task.** examples/medium has no test covering parseArgs, so vitest is not a behavior check here on either arm. The quality floor is tsc-clean + structural extraction (symmetric across arms). Note: examples/medium also ships a PRE-EXISTING failing test (the T05 half-open-interval fixture in dateRange.test.ts), so the baseline's full-suite vitest=false is unrelated to the extraction and is reported as informational only, not a quality failure. extract_function guarantees semantic preservation for accepted spans by construction (hazard rejections + validate); the baseline's preservation rests on the agent + tsc.`
  );
  lines.push(
    `- **Single-site refactor.** extract is one site; file tools may match or beat it on tool count. The substrate's distinctive value is that the extracted function is immediately graph-traceable for follow-on ops (rename/add_parameter/find callers) — not necessarily this single edit.`
  );
  lines.push(
    `- **Substrate gate is tsc-only** (empty behavioral fixtures); baseline runs tsc + the corpus's (parseArgs-irrelevant) vitest suite. Asymmetry noted; immaterial here since no test covers parseArgs.`
  );
  return `${lines.join("\n")}\n`;
}
