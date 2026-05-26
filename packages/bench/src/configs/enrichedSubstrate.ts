/**
 * Enriched substrate trial runner — sandbox-first experiment to test whether
 * the substrate's T05/T08 cost penalty is "the agent doesn't know what's
 * here" (name-fishing) or something deeper.
 *
 * NON-AUTHORITATIVE — this is a bench-layer experiment that DOES NOT modify
 * @strata/agent. It routes through the canonical hermetic loop unchanged.
 * The single intervention: PREFIX the task prompt with a generated corpus map
 * (modules, exports, key imports). The tool surface is byte-identical to the
 * canonical 11 Strata tools — no new tool names, no hermetic-guard change.
 *
 * Hypothesis: the substrate's T05/T08 token overhead (8.4x on T05, 3.0x on
 * T08 vs file-tools baseline per phase15-four-task-2026-05-26 bench) comes
 * largely from the agent fishing — `find_declarations({})` with empty args,
 * then guessing names from the prompt. Pre-injecting a corpus map should
 * collapse the discovery phase to lookups against the map. If the gap
 * closes, the design implication is that the canonical agent should ship
 * with a corpus-map preload built in. If it doesn't, the bottleneck is
 * deeper (per-node-granularity read model) and needs richer tools.
 *
 * Seam: this routes through `runAgentLab` (which already accepts an
 * arbitrary prompt + scorer + emptyCriteria), borrowing the lab seam for
 * the bench's canonical tasks. The toolServerFactory is left at its default
 * so the canonical `createStrataToolServer` runs — no tool surface change.
 *
 * Sandbox discipline: does NOT touch @strata/agent, @strata/store,
 * @strata/render, @strata/verify, examples/. Lives in packages/bench.
 */

import { ingestBatch } from "@strata/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  listChildren,
  listModules,
  type Db,
  type NodeRow
} from "@strata/store";
import {
  evaluateT01Criteria,
  evaluateT05Criteria,
  evaluateT08Criteria
} from "@strata/verify";
import {
  runAgentLab,
  TASK_PROMPTS,
  type AgentLabResult,
  type SessionLogEvent,
  type LabCriteria
} from "@strata/agent";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countSubstrateRetries } from "../retry";
import { tscNoEmitSrc, vitestRun, behavioralFixturesForTask } from "../quality";
import type { TrialMetrics } from "../metrics";
import type { BenchTaskId } from "../tasks";

// ---------------------------------------------------------------------------
// buildCorpusPrefix
//
// Generate a compact text summary of the codebase from the ingested graph.
// Format:
//   # Codebase map (auto-generated)
//   Modules:
//   - src/types/user.ts: exports interface User, type UserRole
//   - src/server/events.ts: exports function logEvent, function eventLine
//   ...
//   Test files (entry points for understanding behavior):
//   - tests/dateRange.test.ts (imports: formatDateRange from "../src/dateRange")
//   ...
//
//   Use find_declarations / get_references / read_node to inspect specific
//   declarations.
//
// Target: under ~600 tokens. Honest: the agent reads exports + identifier
// names + import declarations only — no body text, no inference about what
// anything DOES. That information remains discoverable via the existing
// tools; the prefix just tells the agent WHAT EXISTS, not WHAT IT MEANS.
// ---------------------------------------------------------------------------

interface ExportEntry {
  kind: string;
  name: string;
}

interface ImportSummary {
  names: string[];
  from: string;
}

function buildCorpusPrefix(db: Db, srcRoot: string, corpusRoot: string): string {
  const modules = listModules(db);
  const srcLines: string[] = [];
  const testLines: string[] = [];

  for (const module of modules) {
    const absPath = module.payload;
    const relFromCorpus = toPosix(path.relative(corpusRoot, absPath));
    const isTest = relFromCorpus.startsWith("tests/") || relFromCorpus.includes("/tests/");

    const children = listChildren(db, module.id);
    const exports = collectExports(children);
    const imports = collectImports(children);

    if (isTest) {
      const importsStr = imports.length === 0
        ? ""
        : ` (imports: ${imports.map(formatImport).join("; ")})`;
      testLines.push(`- ${relFromCorpus}${importsStr}`);
    } else {
      const exportsStr = exports.length === 0
        ? "(no exports)"
        : exports.map((e) => `${e.kind} ${e.name}`).join(", ");
      srcLines.push(`- ${relFromCorpus}: exports ${exportsStr}`);
    }
  }

  // Sort for stability across runs.
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
 * Extract export entries from a module's direct children. We look for
 * children whose payload starts with the `export` keyword (the heuristic
 * the rest of the codebase uses too — see e.g. find_declarations queries).
 * Returns a small list of { kind, name } for the map.
 */
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

function stripLeadingComments(payload: string): string {
  let s = payload.trimStart();
  // Strip any number of leading block comments (JSDoc) and line comments.
  // The ingest payload for `export const X` often starts with the JSDoc
  // attached to the statement, NOT with the `export` keyword — so a naive
  // regex on payload misses the export. Strip comments to get to the body.
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
  return /^export\b/.test(stripLeadingComments(payload));
}

function classifyDecl(nodeKind: string, payload: string): string | undefined {
  if (nodeKind === "FunctionDeclaration") return "function";
  if (nodeKind === "ClassDeclaration") return "class";
  if (nodeKind === "InterfaceDeclaration") return "interface";
  if (nodeKind === "TypeAliasDeclaration") return "type";
  if (nodeKind === "EnumDeclaration") return "enum";
  // Variable statements / FirstStatement (alias of VariableStatement in TS
  // SyntaxKind). Inspect payload to distinguish const/let/var.
  if (nodeKind === "FirstStatement" || nodeKind === "VariableStatement") {
    if (/\bconst\s+/.test(payload)) return "const";
    if (/\blet\s+/.test(payload)) return "let";
    if (/\bvar\s+/.test(payload)) return "var";
    return "var";
  }
  return undefined;
}

/**
 * Pull the declared name from the payload. Crude but adequate: we look for
 * the first identifier after the keyword. For variable statements we look
 * after `const|let|var`. For other decls we look after the kind keyword.
 */
function extractDeclName(payload: string): string | undefined {
  const body = stripLeadingComments(payload).replace(/^export\s+/, "");
  const varMatch = body.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (varMatch) return varMatch[1];
  const declMatch = body.match(
    /^(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
  );
  if (declMatch) return declMatch[1];
  const defaultMatch = body.match(
    /^default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/
  );
  if (defaultMatch) return defaultMatch[1];
  return undefined;
}

function collectImports(children: NodeRow[]): ImportSummary[] {
  const out: ImportSummary[] = [];
  for (const child of children) {
    if (child.kind !== "ImportDeclaration") continue;
    const payload = child.payload ?? "";
    const parsed = parseImport(payload);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseImport(payload: string): ImportSummary | undefined {
  // Match `import { a, b } from "X"` or `import X from "Y"` or `import * as X from "Y"`.
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

function formatImport(imp: ImportSummary): string {
  return `${imp.names.join(", ")} from "${imp.from}"`;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// Corpus collector — mirrors what @strata/agent's runAgentForPrompt does
// internally, so the prefix we generate sees the same module set as the
// agent will see when its own ingest runs.
// ---------------------------------------------------------------------------

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
 * Build a corpus prefix from the corpusRoot. Ingests the corpus into a
 * throwaway DB, generates the prefix text, then returns it. The agent's own
 * runAgentLab will re-ingest the same files for its own session — that's
 * the seam's natural shape (cheap; ingest takes ms on this corpus size).
 *
 * Exported for direct test/inspection.
 */
export function buildCorpusPrefixFromRoot(corpusRoot: string): string {
  const srcRoot = path.join(corpusRoot, "src");
  const inputs = collectTsFiles(srcRoot);
  // Include test files in the prefix (they're entry points), but they
  // typically live under <corpusRoot>/tests not <srcRoot>/. Add separately.
  const testsRoot = path.join(corpusRoot, "tests");
  if (existsSync(testsRoot)) {
    inputs.push(...collectTsFiles(testsRoot));
  }
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return buildCorpusPrefix(db, srcRoot, corpusRoot);
}

// ---------------------------------------------------------------------------
// runEnrichedSubstrateTrial — main entry point.
//
// For T05/T08 (the read-heavy tasks the bench showed substrate losing on):
//   1. Build the corpus map prefix.
//   2. Call runAgentLab with prompt = <prefix>\n\n<canonical task prompt>.
//   3. Use the canonical T05/T08 scorer from @strata/verify.
//   4. Extract TrialMetrics in the same shape as the existing
//      runSubstrateTaskTrial so the report harness can consume both.
//
// T03 is included for sanity (the prefix shouldn't hurt T03 — if it does,
// that's a finding). T01 included for completeness.
// ---------------------------------------------------------------------------

export interface RunEnrichedSubstrateTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  logPath?: string;
  keepArtifacts?: boolean;
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, "../../../..");
}

function emptyTaskLabCriteria(taskId: BenchTaskId): LabCriteria & {
  [key: string]: boolean;
} {
  // Mirrors @strata/agent's internal emptyTaskCriteria (which is not
  // exported). The scorer overwrites these fields; defaults must be false
  // so a non-passing run reports failure cleanly. LabCriteria requires
  // commitReturnedOk / validateAfterCommitClean / operationRowAppended /
  // labOk; everything else is the task-specific extension keyed by name.
  const base = {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    operationRowAppended: false,
    labOk: false
  };
  if (taskId === "T01") {
    return {
      ...base,
      signatureHasTimezone: false,
      defaultIsUtcString: false,
      serverCallsitesUtc: false,
      uiCallsitesLocalOrDefault: false,
      hofCallsiteNotMisedited: false
    };
  }
  if (taskId === "T05") {
    return {
      ...base,
      comparisonIsHalfOpen: false,
      noClosedIntervalRemains: false,
      testFileByteIdentical: false
    };
  }
  if (taskId === "T08") {
    return {
      ...base,
      returnTypeIsLiteralUnion: false,
      noAsStringCastOnResult: false,
      callersTypecheckUnderNarrowType: false
    };
  }
  // T03 — minimal; existing T03 path doesn't run through this experiment
  // but we keep the shape consistent.
  return base;
}

const SHARED_KEYS_BY_TASK: Record<BenchTaskId, readonly string[]> = {
  T01: [
    "commitReturnedOk",
    "validateAfterCommitClean",
    "signatureHasTimezone",
    "defaultIsUtcString",
    "serverCallsitesUtc",
    "uiCallsitesLocalOrDefault",
    "hofCallsiteNotMisedited"
  ],
  T03: [
    "commitReturnedOk",
    "validateAfterCommitClean",
    "importRenamed",
    "typeAnnotationRenamed",
    "genericPromiseRenamed",
    "namespaceImportRenamed",
    "auditLiteralUntouched",
    "auditLiteralOnlyRemainingUser",
    "indexReExportRenamed",
    "jsdocReferencesRenamed"
  ],
  T05: [
    "commitReturnedOk",
    "validateAfterCommitClean",
    "comparisonIsHalfOpen",
    "noClosedIntervalRemains",
    "testFileByteIdentical"
  ],
  T08: [
    "commitReturnedOk",
    "validateAfterCommitClean",
    "returnTypeIsLiteralUnion",
    "noAsStringCastOnResult",
    "callersTypecheckUnderNarrowType"
  ]
};

async function substrateQualityFromRendered(
  rendered: Map<string, string> | undefined,
  corpusRoot: string,
  fixtures: readonly string[]
): Promise<{ tscClean: boolean; vitestPassed: boolean }> {
  if (!rendered || rendered.size === 0) {
    return { tscClean: false, vitestPassed: false };
  }

  const outRoot = mkdtempSync(path.join(tmpdir(), "strata-enriched-rq-"));
  try {
    const outSrc = path.join(outRoot, "src");
    for (const [rel, text] of rendered) {
      const dest = path.join(outSrc, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }

    for (const file of ["tsconfig.json", "package.json", "vitest.config.ts"]) {
      const from = path.join(corpusRoot, file);
      if (existsSync(from)) {
        cpSync(from, path.join(outRoot, file));
      }
    }

    const seedTests = path.join(corpusRoot, "tests");
    if (existsSync(seedTests)) {
      cpSync(seedTests, path.join(outRoot, "tests"), { recursive: true });
    }

    const repoNodeModules = path.join(repoRootFromHere(), "node_modules");
    const tmpNodeModules = path.join(outRoot, "node_modules");
    if (existsSync(repoNodeModules)) {
      symlinkSync(repoNodeModules, tmpNodeModules, "dir");
    }

    const { tscClean } = tscNoEmitSrc(outRoot);
    const { vitestPassed } = vitestRun(outRoot, fixtures);
    return { tscClean, vitestPassed };
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}

export async function runEnrichedSubstrateTrial(
  taskId: BenchTaskId,
  params: RunEnrichedSubstrateTrialParams
): Promise<TrialMetrics> {
  const startedAt = Date.now();

  let effectiveLogPath = params.logPath;
  if (!effectiveLogPath && params.keepArtifacts) {
    const logsDir = path.join(repoRootFromHere(), "packages/bench/results/logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    effectiveLogPath = path.join(
      logsDir,
      `${taskId}-enriched-substrate-trial${params.trial}-${stamp}.jsonl`
    );
  }

  // Generate the corpus prefix from the same corpus the agent will ingest.
  const prefix = buildCorpusPrefixFromRoot(params.corpusRoot);
  const canonicalPrompt = TASK_PROMPTS[taskId];
  const prompt = `${prefix}\n\n---\n\n${canonicalPrompt}`;

  // T05 needs the seed test text for its scorer (same as runAgentTask).
  const seedTestText =
    taskId === "T05"
      ? readFileSync(
          path.join(params.corpusRoot, "tests", "dateRange.test.ts"),
          "utf8"
        )
      : undefined;

  const result: AgentLabResult = await runAgentLab({
    corpusRoot: params.corpusRoot,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    logPath: effectiveLogPath,
    actor: `enriched-substrate-${taskId.toLowerCase()}`,
    prompt,
    acceptance: {
      corpusRoot: params.corpusRoot,
      srcRoot: path.join(params.corpusRoot, "src"),
      behavioralFixtures: behavioralFixturesForTask(taskId)
    },
    emptyCriteria: () => emptyTaskLabCriteria(taskId),
    score: (db, batch, srcRoot, input) => {
      // Route to the canonical scorer for the task. The scorers return
      // criteria PLUS a `rendered` Map. We PRESERVE `rendered` in the
      // returned object so runAgentLab's loop can hand it back to us for the
      // post-commit resultQuality probe (tsc + vitest on a temp tree). The
      // `as unknown as LabCriteria` cast bypasses LabCriteria's
      // [key: string]: boolean index signature so the rendered Map can
      // ride along. Initial implementation stripped `rendered` to satisfy
      // the type signature, which silently broke resultQuality (the
      // tsc/vitest probe got `rendered=undefined` and returned 0/0). Bug
      // caught after 2026-05-26 T05/T08 enriched-substrate bench showed
      // `tsc clean 0/2` despite `Success 2/2`.
      if (taskId === "T01") {
        const scored = evaluateT01Criteria(db, batch, srcRoot, {
          commitReturnedOk: input.commitReturnedOk,
          validateAfterCommitClean: input.validateAfterCommitClean,
          txId: input.txId
        });
        const labOk = SHARED_KEYS_BY_TASK.T01.every(
          (k) => (scored as unknown as Record<string, boolean>)[k] === true
        );
        return { ...scored, labOk } as unknown as LabCriteria & {
          [key: string]: boolean;
        };
      }
      if (taskId === "T05") {
        const scored = evaluateT05Criteria(db, batch, srcRoot, {
          commitReturnedOk: input.commitReturnedOk,
          validateAfterCommitClean: input.validateAfterCommitClean,
          txId: input.txId,
          seedTestText: seedTestText ?? ""
        });
        const labOk = SHARED_KEYS_BY_TASK.T05.every(
          (k) => (scored as unknown as Record<string, boolean>)[k] === true
        );
        return { ...scored, labOk } as unknown as LabCriteria & {
          [key: string]: boolean;
        };
      }
      if (taskId === "T08") {
        const scored = evaluateT08Criteria(db, batch, srcRoot, {
          commitReturnedOk: input.commitReturnedOk,
          validateAfterCommitClean: input.validateAfterCommitClean,
          txId: input.txId
        });
        const labOk = SHARED_KEYS_BY_TASK.T08.every(
          (k) => (scored as unknown as Record<string, boolean>)[k] === true
        );
        return { ...scored, labOk } as unknown as LabCriteria & {
          [key: string]: boolean;
        };
      }
      throw new Error(`enriched substrate: T03 not supported through this path`);
    }
  });

  const harnessWallTimeMs = Date.now() - startedAt;

  // Behavioral quality probe — same as runSubstrateTaskTrial does.
  const resultQuality = await substrateQualityFromRendered(
    result.rendered,
    params.corpusRoot,
    behavioralFixturesForTask(taskId)
  );

  return extractEnrichedMetrics({
    trial: params.trial,
    result,
    taskId,
    harnessWallTimeMs,
    resultQuality
  });
}

// ---------------------------------------------------------------------------
// extractEnrichedMetrics — adapter from AgentLabResult to TrialMetrics.
// Mirrors substrate.ts's extractSubstrateMetrics; the only diff is the
// criteria-shape extraction (LabCriteria has the task-specific extra keys).
// ---------------------------------------------------------------------------

interface ExtractInput {
  trial: number;
  result: AgentLabResult;
  taskId: BenchTaskId;
  harnessWallTimeMs: number;
  resultQuality: { tscClean: boolean; vitestPassed: boolean };
}

function findResultEvent(
  events: readonly SessionLogEvent[]
): Extract<SessionLogEvent, { type: "result" }> | undefined {
  return events.find(
    (event): event is Extract<SessionLogEvent, { type: "result" }> =>
      event.type === "result"
  );
}

function extractEnrichedMetrics(input: ExtractInput): TrialMetrics {
  const { result, taskId } = input;
  const criteria = result.criteria as unknown as Record<string, boolean>;
  const resultEvent = findResultEvent(result.log.events);
  const usage = resultEvent?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  const toolCalls = result.log.events.filter(
    (event): event is Extract<SessionLogEvent, { type: "tool_call" }> =>
      event.type === "tool_call"
  );
  const retryEvents = toolCalls.map((call) => ({
    tool: call.tool,
    ok: call.ok,
    returnedDiagnostics:
      call.tool === "validate" && call.result_summary !== "[]",
    commitOk:
      call.tool === "commit_transaction"
        ? call.result_summary.includes('"ok":true')
        : undefined
  }));

  return {
    config: "substrate", // marked substrate so the report harness aggregates with substrate
    trial: input.trial,
    totalTokens: usage.inputTokens + usage.outputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    wallTimeMs: resultEvent?.durationMs ?? 0,
    harnessWallTimeMs: input.harnessWallTimeMs,
    toolInvocations: toolCalls.length,
    failuresRetries: countSubstrateRetries(retryEvents),
    totalCostUsd: resultEvent?.totalCostUsd ?? 0,
    success: SHARED_KEYS_BY_TASK[taskId].every((key) => criteria[key] === true),
    resultQuality: input.resultQuality,
    terminalReason:
      result.terminalReason === "replay_complete"
        ? "error_other"
        : result.terminalReason,
    operationRowAppended: criteria.operationRowAppended === true
  };
}
