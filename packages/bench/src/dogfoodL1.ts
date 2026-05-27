import path from "node:path";
import {
  fixturesForBenchTask,
  runAgent,
  T05_PROMPT,
  type AgentResult,
  type SessionLogEvent
} from "@strata/agent";

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

export interface DogfoodArm {
  label: "index-on" | "index-off";
  injectModuleIndex: boolean;
  terminalReason: string;
  lastCommitOk: boolean;
  newOperationsCount: number;
  moduleIndexChars: number;
  moduleIndexLines: number;
  cost: DogfoodArmCost;
}

export interface DogfoodL1Result {
  corpusRoot: string;
  prompt: string;
  taskId: "T05";
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  armOrder: ["index-off", "index-on"];
  armOff: DogfoodArm;
  armOn: DogfoodArm;
  ratio: { totalTokens: number; costUsd: number };
  /**
   * Primary acceptance is cost USD because Anthropic prices input, output,
   * cache-creation, and cache-read tokens at very different rates and
   * "total tokens" elides that. Tokens kept as a secondary signal — useful
   * for cross-pricing-era comparisons. See decisions.md 2026-05-27.
   */
  acceptance: {
    costUsdOnIsAtMost80PctOfOff: boolean;
    totalTokensOnIsAtMost80PctOfOff: boolean;
  };
}

export interface RunDogfoodL1Params {
  corpusRoot: string;
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

function findIndexEvent(
  events: readonly SessionLogEvent[]
): Extract<SessionLogEvent, { type: "module_index_injected" }> | undefined {
  return events.find(
    (event): event is Extract<SessionLogEvent, { type: "module_index_injected" }> =>
      event.type === "module_index_injected"
  );
}

function costFromResult(result: AgentResult): DogfoodArmCost {
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

async function runOneArm(
  params: RunDogfoodL1Params,
  injectModuleIndex: boolean
): Promise<DogfoodArm> {
  const result = await runAgent({
    corpusRoot: params.corpusRoot,
    prompt: T05_PROMPT,
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 40,
    wallTimeMs: params.wallTimeMs ?? 300_000,
    behavioralFixtures: fixturesForBenchTask("T05"),
    actor: "dogfood-l1",
    injectModuleIndex
  });

  const idxEvent = injectModuleIndex
    ? findIndexEvent(result.log.events)
    : undefined;

  return {
    label: injectModuleIndex ? "index-on" : "index-off",
    injectModuleIndex,
    terminalReason: result.terminalReason,
    lastCommitOk: result.lastCommitOk,
    newOperationsCount: result.newOperationsCount,
    moduleIndexChars: idxEvent?.chars ?? 0,
    moduleIndexLines: idxEvent?.lines ?? 0,
    cost: costFromResult(result)
  };
}

/**
 * L1.4 paired dogfood. Runs the freeform agent twice against the same corpus
 * on the T05 task: index-off first, then index-on. Order is deliberate — the
 * second run benefits from any prompt-cache warmth left by the first, so
 * running index-off first makes the index-on cost the conservative read.
 *
 * Honest N=1. Not a bench round. Single trial is noisy.
 */
export async function runDogfoodL1(
  params: RunDogfoodL1Params
): Promise<DogfoodL1Result> {
  const armOff = await runOneArm(params, false);
  const armOn = await runOneArm(params, true);

  const ratioTokens =
    armOff.cost.totalTokens > 0
      ? armOn.cost.totalTokens / armOff.cost.totalTokens
      : Number.NaN;
  const ratioCost =
    armOff.cost.costUsd > 0
      ? armOn.cost.costUsd / armOff.cost.costUsd
      : Number.NaN;

  return {
    corpusRoot: path.resolve(params.corpusRoot),
    prompt: T05_PROMPT,
    taskId: "T05",
    model: params.model ?? "claude-sonnet-4-6",
    maxTurns: params.maxTurns ?? 40,
    wallTimeMs: params.wallTimeMs ?? 300_000,
    armOrder: ["index-off", "index-on"],
    armOff,
    armOn,
    ratio: { totalTokens: ratioTokens, costUsd: ratioCost },
    acceptance: {
      costUsdOnIsAtMost80PctOfOff:
        Number.isFinite(ratioCost) && ratioCost <= 0.8,
      totalTokensOnIsAtMost80PctOfOff:
        Number.isFinite(ratioTokens) && ratioTokens <= 0.8
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

export function renderDogfoodMarkdown(result: DogfoodL1Result): string {
  const lines: string[] = [];
  lines.push(`# L1.4 dogfood — codebase-index paired comparison`);
  lines.push("");
  lines.push(`- corpus: \`${result.corpusRoot}\``);
  lines.push(`- task: ${result.taskId}`);
  lines.push(`- model: \`${result.model}\``);
  lines.push(
    `- bounds: maxTurns=${result.maxTurns}, wallTimeMs=${result.wallTimeMs}`
  );
  lines.push(`- arm order: ${result.armOrder.join(" → ")} (index-off first)`);
  lines.push(`- module index size (chars/lines): ${fmt(result.armOn.moduleIndexChars)} / ${fmt(result.armOn.moduleIndexLines)}`);
  lines.push("");
  lines.push("| Metric | index-off | index-on | on / off |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Total tokens | ${fmt(result.armOff.cost.totalTokens)} | ${fmt(result.armOn.cost.totalTokens)} | ${fmtPct(result.ratio.totalTokens)} |`
  );
  lines.push(
    `| Input tokens | ${fmt(result.armOff.cost.inputTokens)} | ${fmt(result.armOn.cost.inputTokens)} | — |`
  );
  lines.push(
    `| Output tokens | ${fmt(result.armOff.cost.outputTokens)} | ${fmt(result.armOn.cost.outputTokens)} | — |`
  );
  lines.push(
    `| Cache read input | ${fmt(result.armOff.cost.cacheReadInputTokens)} | ${fmt(result.armOn.cost.cacheReadInputTokens)} | — |`
  );
  lines.push(
    `| Cache creation input | ${fmt(result.armOff.cost.cacheCreationInputTokens)} | ${fmt(result.armOn.cost.cacheCreationInputTokens)} | — |`
  );
  lines.push(
    `| Tool calls | ${fmt(result.armOff.cost.toolCalls)} | ${fmt(result.armOn.cost.toolCalls)} | — |`
  );
  lines.push(
    `| Turns | ${fmt(result.armOff.cost.numTurns)} | ${fmt(result.armOn.cost.numTurns)} | — |`
  );
  lines.push(
    `| Wall ms | ${fmt(result.armOff.cost.wallMs)} | ${fmt(result.armOn.cost.wallMs)} | — |`
  );
  lines.push(
    `| Cost USD | ${fmtUsd(result.armOff.cost.costUsd)} | ${fmtUsd(result.armOn.cost.costUsd)} | ${fmtPct(result.ratio.costUsd)} |`
  );
  lines.push("");
  lines.push(`- terminal: off=\`${result.armOff.terminalReason}\` lastCommitOk=${result.armOff.lastCommitOk}; on=\`${result.armOn.terminalReason}\` lastCommitOk=${result.armOn.lastCommitOk}`);
  lines.push(`- operations appended: off=${result.armOff.newOperationsCount}; on=${result.armOn.newOperationsCount}`);
  lines.push("");
  lines.push(
    `**Primary acceptance (plan L1.4): index-on cost USD ≤ 80% of index-off cost USD — ${
      result.acceptance.costUsdOnIsAtMost80PctOfOff ? "PASS" : "FAIL"
    } (ratio ${fmtPct(result.ratio.costUsd)})**`
  );
  lines.push("");
  lines.push(
    `Secondary signal — total tokens ratio: ${fmtPct(result.ratio.totalTokens)} ` +
      `(${result.acceptance.totalTokensOnIsAtMost80PctOfOff ? "PASS" : "would FAIL the 80% threshold"}). ` +
      `Total tokens elides cache pricing — see decisions.md 2026-05-27 for why cost USD is the primary metric.`
  );
  lines.push("");
  lines.push(
    `Honest read: N=1, single paired trial. Per CLAUDE.md, do not generalize this to "L1 always saves N% tokens" — it is one data point on one task on one corpus.`
  );
  return `${lines.join("\n")}\n`;
}
