import {
  runAgentT03,
  type AgentT03Result,
  type SessionLogEvent
} from "@strata/agent";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countSubstrateRetries } from "../retry";
import { renderStoreToDir, tscNoEmit, vitestRun } from "../quality";
import type { TrialMetrics } from "../metrics";

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
  result: AgentT03Result;
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
    success: SHARED_KEYS.every((key) => result.criteria[key] === true),
    resultQuality: input.resultQuality,
    terminalReason:
      result.terminalReason === "replay_complete"
        ? "error_other"
        : result.terminalReason,
    operationRowAppended: result.criteria.operationRowAppended
  };
}

export interface RunSubstrateTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  logPath?: string;
  resultQuality?: (
    result: AgentT03Result
  ) => Promise<{ tscClean: boolean; vitestPassed: boolean }>;
}

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(rootDir);
  return out;
}

/**
 * Default substrate resultQuality. runAgentT03 closes its in-memory DB before
 * returning, so this re-derives the deterministic programmatic T03 rename and
 * renders it to a temp tree. This is not the success path; success is still
 * the ten shared criteria from the agent run.
 */
export function defaultSubstrateResultQuality(
  corpusRoot: string
): () => Promise<{ tscClean: boolean; vitestPassed: boolean }> {
  return async () => {
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collectTsFiles(srcRoot));
    const db = openDb(":memory:");

    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decl = find_declarations(db, {
        name: "User",
        kind: "interface"
      })[0];
      if (!decl) {
        return { tscClean: false, vitestPassed: false };
      }
      const tx = begin(db, "bench-result-quality");
      rename_symbol(db, tx, decl.id, "Account");
      if (!commit(db, tx).ok) {
        return { tscClean: false, vitestPassed: false };
      }
      const outRoot = mkdtempSync(path.join(tmpdir(), "strata-rq-"));
      renderStoreToDir(db, batch, srcRoot, outRoot, corpusRoot);
      const { tscClean } = tscNoEmit(outRoot);
      const { vitestPassed } = vitestRun(outRoot);
      return { tscClean, vitestPassed };
    } finally {
      db.close();
    }
  };
}

/**
 * One live substrate trial. Replay is intentionally not exposed here because
 * replay fabricates the token and wall-time metrics this package measures.
 */
export async function runSubstrateTrial(
  params: RunSubstrateTrialParams
): Promise<TrialMetrics> {
  const startedAt = Date.now();
  const result = await runAgentT03({
    corpusRoot: params.corpusRoot,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    logPath: params.logPath
  });
  const harnessWallTimeMs = Date.now() - startedAt;
  const resultQualityProbe =
    params.resultQuality ??
    ((_: AgentT03Result) => defaultSubstrateResultQuality(params.corpusRoot)());
  const resultQuality = await resultQualityProbe(result);

  return extractSubstrateMetrics({
    trial: params.trial,
    result,
    harnessWallTimeMs,
    resultQuality
  });
}
