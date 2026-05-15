import {
  runAgentTask,
  runAgentT03,
  type AgentTaskResult,
  type AgentT03Result,
  type SessionLogEvent
} from "@strata/agent";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countSubstrateRetries } from "../retry";
import { tscNoEmitSrc, vitestRun } from "../quality";
import type { TrialMetrics } from "../metrics";
import type { BenchTaskId } from "../tasks";

/** The ten shared criteria. operationRowAppended is substrate-only. */
const SHARED_KEYS = [
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
] as const;

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
  T03: SHARED_KEYS,
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

function findResultEvent(
  events: readonly SessionLogEvent[]
): Extract<SessionLogEvent, { type: "result" }> | undefined {
  return events.find(
    (event): event is Extract<SessionLogEvent, { type: "result" }> =>
      event.type === "result"
  );
}

export interface ExtractSubstrateInput {
  trial: number;
  result: AgentT03Result | AgentTaskResult;
  taskId?: BenchTaskId;
  harnessWallTimeMs: number;
  resultQuality: { tscClean: boolean; vitestPassed: boolean };
}

/**
 * Pure metric extraction from a real or synthetic AgentT03Result. This reads
 * the public @strata/agent log and criteria only; runAgentT03 itself is reused
 * as-is by runSubstrateTrial.
 */
export function extractSubstrateMetrics(
  input: ExtractSubstrateInput
): TrialMetrics {
  const { result } = input;
  const taskId = input.taskId ?? ("taskId" in result ? result.taskId : "T03");
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
    config: "substrate",
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

export interface RunSubstrateTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  logPath?: string;
  /** When true (and no explicit logPath), the session JSON-lines
   * transcript is written to a discoverable file under results/logs/
   * so the R3 timeout classification can read it. */
  keepArtifacts?: boolean;
  resultQuality?: (
    result: AgentT03Result | AgentTaskResult
  ) => Promise<{ tscClean: boolean; vitestPassed: boolean }>;
}

function repoRootFromHere(): string {
  return path.resolve(__dirname, "../../../..");
}

async function substrateQualityFromRendered(
  rendered: Map<string, string> | undefined,
  corpusRoot: string
): Promise<{ tscClean: boolean; vitestPassed: boolean }> {
  if (!rendered || rendered.size === 0) {
    return { tscClean: false, vitestPassed: false };
  }

  const outRoot = mkdtempSync(path.join(tmpdir(), "strata-rq-"));
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
    const { vitestPassed } = vitestRun(outRoot);
    return { tscClean, vitestPassed };
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}

/**
 * One live substrate trial. Replay is intentionally not exposed here because
 * replay fabricates the token and wall-time metrics this package measures.
 */
export async function runSubstrateTrial(
  params: RunSubstrateTrialParams
): Promise<TrialMetrics> {
  return runSubstrateTaskTrial("T03", params);
}

export async function runSubstrateTaskTrial(
  taskId: BenchTaskId,
  params: RunSubstrateTrialParams
): Promise<TrialMetrics> {
  const startedAt = Date.now();
  let effectiveLogPath = params.logPath;
  if (!effectiveLogPath && params.keepArtifacts) {
    const logsDir = path.join(repoRootFromHere(), "packages/bench/results/logs");
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    effectiveLogPath = path.join(
      logsDir,
      `${taskId}-substrate-trial${params.trial}-${stamp}.jsonl`
    );
  }
  const result =
    taskId === "T03"
      ? await runAgentT03({
          corpusRoot: params.corpusRoot,
          model: params.model,
          maxTurns: params.maxTurns,
          wallTimeMs: params.wallTimeMs,
          logPath: effectiveLogPath
        })
      : await runAgentTask({
          taskId,
          corpusRoot: params.corpusRoot,
          model: params.model,
          maxTurns: params.maxTurns,
          wallTimeMs: params.wallTimeMs,
          logPath: effectiveLogPath
        });
  const harnessWallTimeMs = Date.now() - startedAt;
  const resultQualityProbe =
    params.resultQuality ??
    ((_: AgentT03Result | AgentTaskResult) =>
      substrateQualityFromRendered(result.rendered, params.corpusRoot));
  const resultQuality = await resultQualityProbe(result);

  return extractSubstrateMetrics({
    trial: params.trial,
    result,
    taskId,
    harnessWallTimeMs,
    resultQuality
  });
}
