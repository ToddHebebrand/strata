import { SessionLog, type AgentT03Result } from "@strata/agent";
import { describe, expect, it } from "vitest";
import { extractSubstrateMetrics } from "../src/configs/substrate";

function syntheticResult(): AgentT03Result {
  const log = new SessionLog();
  log.append({
    type: "session_start",
    ts: 0,
    model: "claude-sonnet-4-6",
    maxTurns: 25,
    task: "T03",
    actor: "agent-t03"
  });
  log.append({
    type: "tool_call",
    ts: 1,
    tool: "find_declarations",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 2,
    turn: 0
  });
  log.append({
    type: "tool_call",
    ts: 2,
    tool: "begin_transaction",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 1,
    turn: 0
  });
  log.append({
    type: "tool_call",
    ts: 3,
    tool: "rename_symbol",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 3,
    turn: 1
  });
  log.append({
    type: "tool_call",
    ts: 4,
    tool: "validate",
    args: {},
    result_summary: "[]",
    ok: true,
    error: null,
    durationMs: 5,
    turn: 1
  });
  log.append({
    type: "tool_call",
    ts: 5,
    tool: "commit_transaction",
    args: {},
    result_summary: '{"ok":true}',
    ok: true,
    error: null,
    durationMs: 4,
    turn: 1
  });
  log.append({
    type: "result",
    ts: 6,
    subtype: "success",
    numTurns: 2,
    durationMs: 9000,
    durationApiMs: 8000,
    totalCostUsd: 0.31,
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 100
    },
    modelUsage: {},
    errors: []
  });

  return {
    criteria: {
      commitReturnedOk: true,
      validateAfterCommitClean: true,
      importRenamed: true,
      typeAnnotationRenamed: true,
      genericPromiseRenamed: true,
      namespaceImportRenamed: true,
      auditLiteralUntouched: true,
      auditLiteralOnlyRemainingUser: true,
      indexReExportRenamed: true,
      jsdocReferencesRenamed: true,
      operationRowAppended: true
    },
    terminalReason: "success",
    log,
    transcript: []
  };
}

describe("extractSubstrateMetrics", () => {
  it("derives TrialMetrics from a synthetic AgentT03Result", () => {
    const metrics = extractSubstrateMetrics({
      trial: 1,
      result: syntheticResult(),
      harnessWallTimeMs: 9100,
      resultQuality: { tscClean: true, vitestPassed: true }
    });

    expect(metrics.config).toBe("substrate");
    expect(metrics.trial).toBe(1);
    expect(metrics.totalTokens).toBe(1600);
    expect(metrics.inputTokens).toBe(1200);
    expect(metrics.cacheReadInputTokens).toBe(800);
    expect(metrics.wallTimeMs).toBe(9000);
    expect(metrics.harnessWallTimeMs).toBe(9100);
    expect(metrics.totalCostUsd).toBe(0.31);
    expect(metrics.toolInvocations).toBe(5);
    expect(metrics.failuresRetries).toBe(0);
    expect(metrics.success).toBe(true);
    expect(metrics.terminalReason).toBe("success");
    expect(metrics.operationRowAppended).toBe(true);
  });

  it("success is false when a shared criterion fails and excludes op row from the bar", () => {
    const failedShared = syntheticResult();
    failedShared.criteria.jsdocReferencesRenamed = false;
    const metrics = extractSubstrateMetrics({
      trial: 2,
      result: failedShared,
      harnessWallTimeMs: 1,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(metrics.success).toBe(false);

    const failedOpRow = syntheticResult();
    failedOpRow.criteria.operationRowAppended = false;
    const opRowMetrics = extractSubstrateMetrics({
      trial: 3,
      result: failedOpRow,
      harnessWallTimeMs: 1,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(opRowMetrics.success).toBe(true);
    expect(opRowMetrics.operationRowAppended).toBe(false);
  });

  it("maps replay_complete to error_other because replay is never a metric run", () => {
    const replay = syntheticResult();
    replay.terminalReason = "replay_complete";
    const metrics = extractSubstrateMetrics({
      trial: 4,
      result: replay,
      harnessWallTimeMs: 1,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(metrics.terminalReason).toBe("error_other");
  });
});
