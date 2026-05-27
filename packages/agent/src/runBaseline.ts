import { rmSync } from "node:fs";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { tscNoEmit, vitestRun } from "@strata/verify";
import { SessionLog } from "./log";
import {
  BASELINE_TOOLS,
  collectBaselineSession,
  materializeCorpus,
  type BaselineToolEvent
} from "./baselineShared";
import type { TerminalReason } from "./session";

export interface RunBaselineParams {
  corpusRoot: string;
  prompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  /** Optional JSON-lines transcript log path. */
  logPath?: string;
  /** Preserve the temp working tree for operator inspection. */
  keepTree?: boolean;
}

export interface BaselineResult {
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: BaselineToolEvent[];
  tempTreeRoot?: string;
  resultQuality: {
    tscClean: boolean;
    vitestPassed: boolean;
    failureOutput: string;
  };
  toolInvocations: number;
}

function baselineFreeformPrompt(workingTreeRoot: string, prompt: string): string {
  return (
    `The TypeScript codebase is on disk at ${workingTreeRoot}. ` +
    "You may read, edit, and run `tsc --noEmit` and the test suite freely.\n\n" +
    prompt
  );
}

function appendBaselineSessionToLog(
  log: SessionLog,
  session: Awaited<ReturnType<typeof collectBaselineSession>>
): void {
  log.append({
    type: "init",
    ts: Date.now(),
    tools: session.initTools,
    mcpServers: []
  });

  session.toolEvents.forEach((event, index) => {
    const ok =
      event.tool !== "Bash" ||
      event.exitCode === undefined ||
      event.exitCode === 0;
    log.append({
      type: "tool_call",
      ts: Date.now(),
      tool: event.tool,
      args: {
        path: event.path,
        command: event.command
      },
      result_summary:
        event.exitCode === undefined ? "" : `exitCode=${event.exitCode}`,
      ok,
      error: ok ? null : `exitCode=${event.exitCode}`,
      durationMs: 0,
      turn: index + 1
    });
  });

  if (session.result) {
    log.append({
      type: "result",
      ts: Date.now(),
      subtype: session.result.subtype,
      numTurns: session.result.numTurns,
      durationMs: session.result.durationMs,
      durationApiMs: session.result.durationApiMs,
      totalCostUsd: session.result.totalCostUsd,
      usage: session.result.usage,
      modelUsage: {},
      errors: []
    });
  }
}

function buildFailureOutput(
  tsc: { output: string },
  vitest: { output: string }
): string {
  return `--- tsc ---\n${tsc.output}\n--- vitest ---\n${vitest.output}`;
}

export async function runBaseline(
  params: RunBaselineParams
): Promise<BaselineResult> {
  const { root } = materializeCorpus(params.corpusRoot);
  const log = new SessionLog(params.logPath);
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.wallTimeMs);

  log.append({
    type: "session_start",
    ts: startedAt,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    task: "freeform-baseline",
    actor: "baseline"
  });

  try {
    const options: Options = {
      cwd: root,
      tools: [...BASELINE_TOOLS],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: params.model,
      maxTurns: params.maxTurns,
      abortController,
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: []
    };

    const session = await collectBaselineSession(
      query({
        prompt: baselineFreeformPrompt(root, params.prompt),
        options
      }),
      abortController.signal
    );
    appendBaselineSessionToLog(log, session);

    const tsc = tscNoEmit(root);
    const vitest = vitestRun(root, undefined);
    const failureOutput =
      tsc.tscClean && vitest.vitestPassed
        ? ""
        : buildFailureOutput(tsc, vitest);

    return {
      terminalReason: session.terminalReason,
      log,
      transcript: session.toolEvents,
      tempTreeRoot: params.keepTree ? root : undefined,
      resultQuality: {
        tscClean: tsc.tscClean,
        vitestPassed: vitest.vitestPassed,
        failureOutput
      },
      toolInvocations: session.toolInvocations
    };
  } finally {
    clearTimeout(timer);
    abortController.abort();
    if (!params.keepTree) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
