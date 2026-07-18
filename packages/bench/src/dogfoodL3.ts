import { unlinkSync } from "node:fs";
import path from "node:path";
import {
  fixturesForBenchTask,
  runAgent,
  type AgentResult,
  type SessionLogEvent
} from "@strata-code/agent";

export const L3_TASK_A_PROMPT =
  "Rename the exported interface `User` (defined in `src/types/user.ts`) to " +
  "`Account` everywhere it is referenced as a type, including type-only " +
  "re-exports and JSDoc. Leave unrelated string literals with the value " +
  '`"User"` (such as audit log discriminators) untouched. The full test ' +
  "suite must pass.";

export const L3_TASK_B_PROMPT =
  "Rename the exported interface `Clock` (defined in `src/types.ts`) to " +
  "`TimeSource` everywhere it is referenced as a type, including type-only " +
  "re-exports and JSDoc. Leave unrelated string literals untouched. The " +
  "full test suite must pass.";

export interface DogfoodL3ArmCost {
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

export interface DogfoodL3Arm {
  label: "A-cold" | "B-after-A";
  prompt: string;
  terminalReason: string;
  lastCommitOk: boolean;
  newOperationsCount: number;
  commitPatternEmbedded: boolean;
  pastTasksInjectedCount: number;
  cost: DogfoodL3ArmCost;
}

export interface DogfoodL3Result {
  corpusRoot: string;
  dbPath: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  armA: DogfoodL3Arm;
  armB: DogfoodL3Arm;
  ratio: { totalTokens: number; costUsd: number };
  acceptance: {
    bothCommitsOk: boolean;
    commitPatternEmbeddedInA: boolean;
    pastTasksInjectedInB: boolean;
    bCostBelowA: boolean;
  };
}

export interface RunDogfoodL3Params {
  corpusRoot: string;
  dbPath: string;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
}

function findResultEvent(
  events: readonly SessionLogEvent[]
): Extract<SessionLogEvent, { type: "result" }> | undefined {
  return events.find(
    (event): event is Extract<SessionLogEvent, { type: "result" }> =>
      event.type === "result"
  );
}

function findCommitPatternEmbedOk(
  events: readonly SessionLogEvent[]
): boolean {
  return events.some(
    (event): event is Extract<SessionLogEvent, { type: "commit_pattern_embed" }> =>
      event.type === "commit_pattern_embed" && event.ok === true
  );
}

function countPastTasksInjected(events: readonly SessionLogEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === "past_tasks_injected") {
      const count = (event as { count?: number }).count;
      total += typeof count === "number" ? count : 1;
    }
  }
  return total;
}

function costFromResult(result: AgentResult): DogfoodL3ArmCost {
  const resultEvent = findResultEvent(result.log.events);
  const usage = resultEvent?.usage;
  const toolCalls = result.log.events.filter(
    (event): event is Extract<SessionLogEvent, { type: "tool_call" }> =>
      event.type === "tool_call"
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

async function runArm(
  params: RunDogfoodL3Params,
  label: "A-cold" | "B-after-A",
  prompt: string,
  reset: boolean
): Promise<DogfoodL3Arm> {
  const result = await runAgent({
    corpusRoot: params.corpusRoot,
    prompt,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 40,
    wallTimeMs: params.wallTimeMs ?? 300_000,
    dbPath: params.dbPath,
    reset,
    behavioralFixtures: fixturesForBenchTask("T03"),
    actor: "dogfood-l3"
  });
  return {
    label,
    prompt,
    terminalReason: result.terminalReason,
    lastCommitOk: result.lastCommitOk,
    newOperationsCount: result.newOperationsCount,
    commitPatternEmbedded: findCommitPatternEmbedOk(result.log.events),
    pastTasksInjectedCount: countPastTasksInjected(result.log.events),
    cost: costFromResult(result)
  };
}

/**
 * L3.4 paired dogfood. Runs two similar-shape rename tasks on the same
 * persisted DB:
 *
 *   Arm A: User → Account (cold DB, no prior commit patterns)
 *   Arm B: Clock → TimeSource (same DB; L3 should retrieve A's pattern)
 *
 * Expectation: B's cost < A's cost, and `past_tasks_injected` fires in B.
 * Honest N=1 — a single paired comparison, not a bench round.
 */
export async function runDogfoodL3(
  params: RunDogfoodL3Params
): Promise<DogfoodL3Result> {
  const armA = await runArm(params, "A-cold", L3_TASK_A_PROMPT, true);
  const armB = await runArm(params, "B-after-A", L3_TASK_B_PROMPT, false);

  const ratioTokens =
    armA.cost.totalTokens > 0
      ? armB.cost.totalTokens / armA.cost.totalTokens
      : Number.NaN;
  const ratioCost =
    armA.cost.costUsd > 0 ? armB.cost.costUsd / armA.cost.costUsd : Number.NaN;

  return {
    corpusRoot: path.resolve(params.corpusRoot),
    dbPath: path.resolve(params.dbPath),
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 40,
    wallTimeMs: params.wallTimeMs ?? 300_000,
    armA,
    armB,
    ratio: { totalTokens: ratioTokens, costUsd: ratioCost },
    acceptance: {
      bothCommitsOk: armA.lastCommitOk && armB.lastCommitOk,
      commitPatternEmbeddedInA: armA.commitPatternEmbedded,
      pastTasksInjectedInB: armB.pastTasksInjectedCount > 0,
      bCostBelowA: Number.isFinite(ratioCost) && ratioCost < 1.0
    }
  };
}

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function fmtPct(ratio: number): string {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "n/a";
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function renderDogfoodL3Markdown(result: DogfoodL3Result): string {
  const lines: string[] = [];
  lines.push("# L3.4 dogfood — operation-log-as-memory paired comparison");
  lines.push("");
  lines.push(`- corpus: \`${result.corpusRoot}\``);
  lines.push(`- db: \`${result.dbPath}\``);
  lines.push(`- model: \`${result.model}\``);
  lines.push(
    `- bounds: maxTurns=${result.maxTurns}, wallTimeMs=${result.wallTimeMs}`
  );
  lines.push("");
  lines.push(
    `Arm A (cold DB): \`${result.armA.prompt.slice(0, 80).replace(/\n/g, " ")}…\``
  );
  lines.push(
    `Arm B (same DB after A): \`${result.armB.prompt.slice(0, 80).replace(/\n/g, " ")}…\``
  );
  lines.push("");
  lines.push("| Metric | Arm A (cold) | Arm B (post-A) | B / A |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Total tokens | ${fmt(result.armA.cost.totalTokens)} | ${fmt(result.armB.cost.totalTokens)} | ${fmtPct(result.ratio.totalTokens)} |`
  );
  lines.push(
    `| Cache read | ${fmt(result.armA.cost.cacheReadInputTokens)} | ${fmt(result.armB.cost.cacheReadInputTokens)} | — |`
  );
  lines.push(
    `| Cache creation | ${fmt(result.armA.cost.cacheCreationInputTokens)} | ${fmt(result.armB.cost.cacheCreationInputTokens)} | — |`
  );
  lines.push(
    `| Tool calls | ${fmt(result.armA.cost.toolCalls)} | ${fmt(result.armB.cost.toolCalls)} | — |`
  );
  lines.push(
    `| Turns | ${fmt(result.armA.cost.numTurns)} | ${fmt(result.armB.cost.numTurns)} | — |`
  );
  lines.push(
    `| Wall ms | ${fmt(result.armA.cost.wallMs)} | ${fmt(result.armB.cost.wallMs)} | — |`
  );
  lines.push(
    `| Cost USD | ${fmtUsd(result.armA.cost.costUsd)} | ${fmtUsd(result.armB.cost.costUsd)} | ${fmtPct(result.ratio.costUsd)} |`
  );
  lines.push("");
  lines.push("### L3 telemetry");
  lines.push("");
  lines.push(
    `- Arm A committed: \`${result.armA.terminalReason}\`, lastCommitOk=${result.armA.lastCommitOk}, ops=${result.armA.newOperationsCount}`
  );
  lines.push(
    `- Arm A commit-pattern embedded: **${result.acceptance.commitPatternEmbeddedInA}** (required for L3.4 to be meaningful)`
  );
  lines.push(
    `- Arm B committed: \`${result.armB.terminalReason}\`, lastCommitOk=${result.armB.lastCommitOk}, ops=${result.armB.newOperationsCount}`
  );
  lines.push(
    `- Arm B past-tasks injected (count of past patterns retrieved): **${result.armB.pastTasksInjectedCount}**`
  );
  lines.push("");
  lines.push("### Acceptance");
  lines.push("");
  lines.push(
    `- Both arms succeeded: ${result.acceptance.bothCommitsOk ? "PASS" : "FAIL"}`
  );
  lines.push(
    `- L3 wrote in Arm A (commit_pattern_embed ok=true): ${result.acceptance.commitPatternEmbeddedInA ? "PASS" : "FAIL — L3 didn't activate"}`
  );
  lines.push(
    `- L3 retrieved in Arm B (past_tasks_injected count > 0): ${result.acceptance.pastTasksInjectedInB ? "PASS" : "FAIL — L3 cold-start path or retrieval failed"}`
  );
  lines.push(
    `- **Cost compounding (B cost < A cost): ${result.acceptance.bCostBelowA ? "PASS" : "FAIL"}** (ratio ${fmtPct(result.ratio.costUsd)})`
  );
  lines.push("");
  lines.push(
    `Honest read: N=1, single paired trial. Two confounds to keep in mind: (1) Arm B's task is structurally smaller than A (Clock has fewer references than User), so part of any B<A gap is task-size, not L3 retrieval; (2) Arm B benefits from prompt-cache warmth from Arm A even without L3. The crisp positive signal is "past_tasks_injected fires AND B uses noticeably fewer tool calls than A" — the cost number alone is partly L3 and partly the two confounds.`
  );
  return `${lines.join("\n")}\n`;
}
