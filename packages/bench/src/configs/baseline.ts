import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  BASELINE_TOOLS,
  collectBaselineSession,
  countBaselineRetries,
  materializeCorpus,
  T03_PROMPT,
  TASK_PROMPTS,
  type MaterializeCorpusOptions
} from "@strata/agent";
import {
  readModuleMap,
  isSharedSuccess,
  scoreBaselineTask,
  scoreBaselineWorkingTree,
  type SharedCriteria
} from "../score";
import { tscNoEmitSrc, vitestRun, behavioralFixturesForTask } from "../quality";
import type { TrialMetrics } from "../metrics";
import type { TerminalReason } from "../metrics";
import type { BenchTaskId } from "../tasks";

export { BASELINE_TOOLS, materializeCorpus };
export type { MaterializeCorpusOptions };

function benchTerminalReason(reason: string): TerminalReason {
  return reason === "replay_complete"
    ? "error_other"
    : (reason as TerminalReason);
}

export interface ScoreBaselineTrialInput {
  srcRoot: string;
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}

/** Pure: ten shared criteria from the post-edit working tree. */
export function scoreBaselineTrial(
  input: ScoreBaselineTrialInput
): SharedCriteria {
  return scoreBaselineWorkingTree(input);
}

/**
 * The task text is the exact T03_PROMPT string used by the substrate, with
 * only the irreducible file-world context prepended.
 */
export function baselinePrompt(
  workingTreeRoot: string,
  prompt: string = T03_PROMPT
): string {
  return (
    `The TypeScript codebase is on disk at ${workingTreeRoot} ` +
    `(sources under ${path.join(workingTreeRoot, "src")}). ` +
    "You may read, edit, and run `tsc --noEmit` and the test suite freely.\n\n" +
    prompt
  );
}

export interface RunBaselineTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  keepArtifacts?: boolean;
  /** Injected so tests never call the SDK or run process probes. */
  validateWorkingTree?: (srcRoot: string) => Promise<{
    tscClean: boolean;
    vitestPassed: boolean;
    anyFileModified: boolean;
  }>;
}

export interface RunBaselineTaskTrialParams extends RunBaselineTrialParams {
  taskId?: BenchTaskId;
}

/**
 * One live baseline trial. This intentionally gives the baseline normal file
 * tools and a real writable temp tree, while excluding Strata tools and
 * ambient MCP/settings sources. examples/medium has no own deps or vitest
 * suite, so materialization is a recursive copy plus git init, with no install.
 */
export async function runBaselineTrial(
  params: RunBaselineTrialParams
): Promise<TrialMetrics> {
  return runBaselineTaskTrial("T03", params);
}

export async function runBaselineTaskTrial(
  taskId: BenchTaskId,
  params: RunBaselineTrialParams
): Promise<TrialMetrics> {
  const { root, srcRoot } = materializeCorpus(params.corpusRoot);
  const beforeModules = readModuleMap(srcRoot);
  const seedTestText =
    taskId === "T05"
      ? readFileSync(path.join(root, "tests", "dateRange.test.ts"), "utf8")
      : undefined;
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.wallTimeMs);

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
        prompt: baselinePrompt(root, TASK_PROMPTS[taskId]),
        options
      }),
      abortController.signal
    );
    const harnessWallTimeMs = Date.now() - startedAt;
    const probe = params.validateWorkingTree
      ? await params.validateWorkingTree(srcRoot)
      : await defaultValidateWorkingTree(root, srcRoot, beforeModules, behavioralFixturesForTask(taskId));
    const commitReturnedOk =
      session.terminalReason === "success" && probe.anyFileModified;
    const validateAfterCommitClean = probe.tscClean;
    const criteriaResult =
      taskId === "T03"
        ? {
            criteria: scoreBaselineWorkingTree({
              srcRoot,
              commitReturnedOk,
              validateAfterCommitClean
            }),
            success: false
          }
        : scoreBaselineTask({
            taskId,
            srcRoot,
            commitReturnedOk,
            validateAfterCommitClean,
            seedTestText,
            testFileText:
              taskId === "T05"
                ? readFileSync(
                    path.join(root, "tests", "dateRange.test.ts"),
                    "utf8"
                  )
                : undefined
          });
    const success =
      taskId === "T03"
        ? isSharedSuccess(criteriaResult.criteria as SharedCriteria)
        : criteriaResult.success;
    const result = session.result;

    return {
      config: "baseline",
      trial: params.trial,
      totalTokens:
        (result?.usage.inputTokens ?? 0) + (result?.usage.outputTokens ?? 0),
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      cacheReadInputTokens: result?.usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: result?.usage.cacheCreationInputTokens ?? 0,
      wallTimeMs: result?.durationMs ?? 0,
      harnessWallTimeMs,
      toolInvocations: session.toolInvocations,
      failuresRetries: countBaselineRetries(
        session.toolEvents.map((event) => ({
          tool: event.tool,
          path: event.path,
          command: event.command,
          exitCode: event.exitCode
        }))
      ),
      totalCostUsd: result?.totalCostUsd ?? 0,
      success,
      resultQuality: {
        tscClean: probe.tscClean,
        vitestPassed: probe.vitestPassed
      },
      terminalReason: benchTerminalReason(session.terminalReason),
      operationRowAppended: null
    };
  } finally {
    clearTimeout(timer);
    abortController.abort();
    if (!params.keepArtifacts) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

async function defaultValidateWorkingTree(
  treeRoot: string,
  srcRoot: string,
  beforeModules: Map<string, string>,
  fixtures: readonly string[]
): Promise<{
  tscClean: boolean;
  vitestPassed: boolean;
  anyFileModified: boolean;
}> {
  const afterModules = readModuleMap(srcRoot);
  const anyFileModified =
    beforeModules.size !== afterModules.size ||
    [...afterModules.entries()].some(
      ([key, text]) => beforeModules.get(key) !== text
    );
  const { tscClean } = tscNoEmitSrc(treeRoot);
  const { vitestPassed } = vitestRun(treeRoot, fixtures);
  return { tscClean, vitestPassed, anyFileModified };
}
