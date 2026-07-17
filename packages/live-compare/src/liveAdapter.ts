import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createArtifactRun } from "./artifacts.js";
import { runCoordinationAgent } from "./agent.js";
import {
  REGISTERED_INTEGRATION_ROLE_BOUNDS,
  REGISTERED_TASK_ROLE_BOUNDS,
  runBaselineTrial,
  type BaselineSessionOutcome,
  type BaselineSessionRequest
} from "./baseline.js";
import { createCoordinationClient } from "./client.js";
import type { LiveAdapter } from "./cli.js";
import { runComparisonRound, type ArmExecutionResult } from "./orchestrator.js";
import {
  computeTeamAccounting,
  type RoundPlan,
  type TeamSessionRecord
} from "./runner.js";
import type { ScheduledTrial } from "./schedule.js";
import { materializeFinalTree, startKernelService } from "./service.js";
import {
  REGISTERED_SYSTEM_PROMPTS,
  baselineTaskPrompt,
  createQualifiedTaskManifest,
  strataTaskPrompt,
  type QualifiedTaskManifest
} from "./tasks.js";
import { verifyPhase6Tree } from "./verify.js";

const packageRoot = resolve(__dirname, "..");

const BASELINE_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "Bash"
] as const;

export interface LiveAdapterOptions {
  model: string;
  corpusRoot?: string;
  resultsRoot?: string;
}

interface SessionUsageSummary {
  numTurns: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiDurationMs: number;
  toolCalls: number;
  terminal: string;
  failures: string[];
}

function usageNumber(usage: unknown, key: string): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 0;
}

/** Run one baseline SDK session with normal file tools confined by cwd. */
async function runBaselineSdkSession(params: {
  model: string;
  request: BaselineSessionRequest;
  systemPrompt: string;
}): Promise<BaselineSessionOutcome & SessionUsageSummary & { repairEdits: number; errors: string[] }> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.request.bounds.wallTimeMs);
  const options: Options = {
    cwd: params.request.worktreePath,
    strictMcpConfig: true,
    settingSources: [],
    allowedTools: [...BASELINE_ALLOWED_TOOLS],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: params.systemPrompt,
    model: params.model,
    maxTurns: params.request.bounds.maxTurns,
    maxBudgetUsd: params.request.bounds.maxBudgetUsd,
    abortController
  };
  let toolCalls = 0;
  let result: SDKMessage | undefined;
  try {
    for await (const message of query({ prompt: params.request.prompt, options })) {
      if (message.type === "assistant") {
        const content = (message as { message?: { content?: { type?: string }[] } }).message?.content ?? [];
        toolCalls += content.filter((block) => block.type === "tool_use").length;
      }
      if (message.type === "result") result = message;
    }
  } finally {
    clearTimeout(timer);
  }
  const usage = (result as { usage?: unknown } | undefined)?.usage;
  const subtype = (result as { subtype?: string } | undefined)?.subtype ?? "missing_result";
  return {
    numTurns: usageNumber(result, "num_turns"),
    durationMs: usageNumber(result, "duration_ms"),
    totalCostUsd: usageNumber(result, "total_cost_usd"),
    inputTokens: usageNumber(usage, "input_tokens"),
    outputTokens: usageNumber(usage, "output_tokens"),
    cacheReadInputTokens: usageNumber(usage, "cache_read_input_tokens"),
    cacheCreationInputTokens: usageNumber(usage, "cache_creation_input_tokens"),
    apiDurationMs: usageNumber(result, "duration_api_ms"),
    toolCalls,
    toolEvents: toolCalls,
    repairEdits: 0,
    terminal: subtype,
    failures: subtype === "success" ? [] : [subtype === "error_max_budget_usd" ? "max_budget" : "agent_process_crash"],
    errors: subtype === "success" ? [] : [subtype]
  };
}

function changedEvidence(
  manifest: QualifiedTaskManifest,
  treeRoot: string
): Record<string, string> {
  const evidence: Record<string, string> = {};
  for (const [path, file] of Object.entries(manifest.sourceFiles)) {
    const actual = readFileSync(join(treeRoot, path), "utf8");
    if (actual !== file.text) evidence[`final-tree/${path}`] = actual;
  }
  return evidence;
}

/**
 * Production composition for one approved live round. Constructing the
 * adapter performs no network call; sessions start only when the returned
 * adapter runs under the validated approval.
 */
export function createLiveAdapter(options: LiveAdapterOptions): LiveAdapter {
  const corpusRoot = options.corpusRoot ?? resolve(packageRoot, "../../examples/medium");

  return async (plan: RoundPlan): Promise<void> => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const resultsRoot =
      options.resultsRoot ??
      join(packageRoot, "results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const artifacts = createArtifactRun({
      root: resultsRoot,
      clock: { wallMs: () => Date.now(), monoMs: () => performance.now() },
      redactions: []
    });

    const executeStrataArm = async (entry: ScheduledTrial): Promise<ArmExecutionResult> => {
      const service = await startKernelService(corpusRoot);
      let finalTree: string | undefined;
      try {
        const assignments = manifest.packets[entry.scenario].assignments;
        const started = performance.now();
        const outcomes = await Promise.all(
          assignments.map(async (assignment, index) => {
            const sessionStart = performance.now();
            const output = await runCoordinationAgent({
              socketPath: service.socketPath,
              clientId: `phase6:${entry.trialId}:${assignment.role}`,
              prompt: strataTaskPrompt(assignment),
              systemPrompt: REGISTERED_SYSTEM_PROMPTS.strata,
              model: options.model,
              maxTurns: REGISTERED_TASK_ROLE_BOUNDS.maxTurns,
              wallTimeMs: REGISTERED_TASK_ROLE_BOUNDS.wallTimeMs,
              maxBudgetUsd: REGISTERED_TASK_ROLE_BOUNDS.maxBudgetUsd,
              queryFn: query
            });
            const resultEntry = output.log.find((item) => item.type === "result") as
              | Extract<(typeof output.log)[number], { type: "result" }>
              | undefined;
            const record: TeamSessionRecord = {
              sessionId: `session:${entry.trialId}:strata:${assignment.role}`,
              role: index === 0 ? "task-1" : "task-2",
              startedMonoMs: sessionStart - started,
              endedMonoMs: performance.now() - started,
              numTurns: resultEntry?.numTurns ?? 0,
              totalCostUsd: resultEntry?.totalCostUsd ?? 0,
              inputTokens: resultEntry?.usage.inputTokens ?? 0,
              outputTokens: resultEntry?.usage.outputTokens ?? 0,
              cacheReadInputTokens: resultEntry?.usage.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: resultEntry?.usage.cacheCreationInputTokens ?? 0,
              apiDurationMs: resultEntry?.durationApiMs ?? 0,
              toolCalls: output.transcript.filter((step) => step.type === "tool_use").length,
              terminal: output.terminalReason,
              failures: output.terminalReason === "success" ? [] : ["agent_process_crash"]
            };
            return record;
          })
        );

        const harnessClient = createCoordinationClient({
          socketPath: service.socketPath,
          clientId: `phase6:${entry.trialId}:harness`
        });
        const eventsResponse = (await harnessClient.request(
          { type: "read_events", afterSequence: "0", limit: 256 },
          120_000
        )) as { events: { kind: string; operationId: string | null; changeSetId: string; affectedNodeIds: string[]; publicationDigest: string | null }[] };
        const events = eventsResponse.events;
        const affected = events.flatMap((event) => event.affectedNodeIds);
        finalTree = await materializeFinalTree(harnessClient, corpusRoot, manifest, affected);
        let verificationGreen = true;
        let verification: Record<string, unknown> | null = null;
        try {
          const report = await verifyPhase6Tree({
            treeRoot: finalTree,
            manifest,
            packetId: entry.scenario,
            generationZero: false,
            arm: "strata"
          });
          verification = {
            schemaVersion: 1,
            packetId: entry.scenario,
            arm: "strata",
            green: report.green,
            generationZero: false,
            rootNames: report.rootNames.map((name) => name.replace(`${finalTree}/`, "")),
            compilerOptions: report.compilerOptions,
            fixtureNames: report.fixtureNames,
            fixtureDigests: report.fixtureDigests,
            excludedInputs: manifest.excludedInputs,
            boundaryDispositions: manifest.boundary.map(({ path, target, disposition }) => ({ path, target, disposition })),
            sourceDigest: report.sourceDigest,
            finalTreeDigest: report.finalTreeDigest,
            configurationDigest: report.configurationDigest
          };
        } catch {
          verificationGreen = false;
        }
        const publications = events.filter((event) => event.kind === "intent_committed");
        const accounting = computeTeamAccounting({
          arm: "strata",
          teamWallMs: 900_000,
          sessions: outcomes,
          verificationEndedMonoMs: performance.now() - started,
          verification: { green: verificationGreen },
          kernelEventKinds: events.map((event) => event.kind),
          coordination: {
            freshDecisions: events.filter((event) => event.kind === "intent_cancelled").length,
            requeues: 0,
            scopeExpansions: events.filter((event) => event.kind === "scope_expanded").length,
            publicationGenerations: publications.length
          }
        });
        return {
          accounting,
          verification,
          canonicalAudit: {
            schemaVersion: 1,
            trialId: entry.trialId,
            arm: "strata",
            finalGeneration: String(publications.length),
            operations: publications
              .filter((event) => event.operationId !== null)
              .map((event) => ({
                operationId: event.operationId!,
                changeSetId: event.changeSetId,
                actor: `phase6:${entry.trialId}`
              }))
          },
          evidence: finalTree ? changedEvidence(manifest, finalTree) : {}
        };
      } finally {
        if (finalTree) rmSync(finalTree, { recursive: true, force: true });
        await service.stop();
      }
    };

    const executeBaselineArm = async (entry: ScheduledTrial): Promise<ArmExecutionResult> => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "strata-live-baseline-"));
      const started = performance.now();
      const sessions: TeamSessionRecord[] = [];
      const trial = await runBaselineTrial({
        corpusRoot,
        workspaceRoot,
        manifest,
        packetId: entry.scenario,
        bounds: {
          task: { ...REGISTERED_TASK_ROLE_BOUNDS },
          integration: { ...REGISTERED_INTEGRATION_ROLE_BOUNDS }
        },
        sessionRunner: async (request) => {
          const sessionStart = performance.now();
          const outcome = await runBaselineSdkSession({
            model: options.model,
            request,
            systemPrompt:
              request.role === "integration"
                ? REGISTERED_SYSTEM_PROMPTS.baselineIntegration
                : REGISTERED_SYSTEM_PROMPTS.baselineTask
          });
          sessions.push({
            sessionId: `session:${entry.trialId}:baseline:${request.role}`,
            role: request.role,
            startedMonoMs: sessionStart - started,
            endedMonoMs: performance.now() - started,
            numTurns: outcome.numTurns,
            totalCostUsd: outcome.totalCostUsd,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            cacheReadInputTokens: outcome.cacheReadInputTokens,
            cacheCreationInputTokens: outcome.cacheCreationInputTokens,
            apiDurationMs: outcome.apiDurationMs,
            toolCalls: outcome.toolCalls,
            terminal: outcome.terminal,
            failures: outcome.failures
          });
          return outcome;
        }
      });
      let verificationGreen = true;
      let verification: Record<string, unknown> | null = null;
      try {
        const report = await verifyPhase6Tree({
          treeRoot: trial.integrationWorktree,
          manifest,
          packetId: entry.scenario,
          generationZero: false,
          arm: "baseline"
        });
        verification = {
          schemaVersion: 1,
          packetId: entry.scenario,
          arm: "baseline",
          green: report.green,
          generationZero: false,
          rootNames: report.rootNames.map((name) => name.replace(`${trial.integrationWorktree}/`, "")),
          compilerOptions: report.compilerOptions,
          fixtureNames: report.fixtureNames,
          fixtureDigests: report.fixtureDigests,
          excludedInputs: manifest.excludedInputs,
          boundaryDispositions: manifest.boundary.map(({ path, target, disposition }) => ({ path, target, disposition })),
          sourceDigest: report.sourceDigest,
          finalTreeDigest: report.finalTreeDigest,
          configurationDigest: report.configurationDigest
        };
      } catch {
        verificationGreen = false;
      }
      const accounting = computeTeamAccounting({
        arm: "baseline",
        teamWallMs: 900_000,
        sessions,
        verificationEndedMonoMs: performance.now() - started,
        verification: { green: verificationGreen },
        kernelEventKinds: [],
        integration: {
          mergeConflicts: 0,
          repairEdits: trial.totals.repairEdits,
          changedPaths: trial.captures.filter((capture) => capture.changed).length
        }
      });
      const evidence = changedEvidence(manifest, trial.integrationWorktree);
      trial.finalize();
      trial.cleanup();
      rmSync(workspaceRoot, { recursive: true, force: true });
      return { accounting, verification, evidence };
    };

    const outcome = await runComparisonRound({
      plan,
      artifacts,
      executeStrataArm,
      executeBaselineArm
    });
    process.stdout.write(
      `live round complete: ${outcome.completedTrials} trials, USD ${outcome.totalCostUsd.toFixed(2)}, ` +
        `${outcome.failures} failed arms${outcome.stopped ? `, stopped: ${outcome.stopped}` : ""}\n`
    );
  };
}
