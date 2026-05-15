import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeTranscriptForFixture,
  runAgentT03
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixturePath = path.join(
  packageRoot,
  "tests/fixtures/agent-t03-transcript.jsonl"
);

const hasAuth =
  Boolean(process.env.ANTHROPIC_API_KEY) ||
  Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

if (!hasAuth) {
  throw new Error(
    "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required to record the live fixture"
  );
}

const result = await runAgentT03({
  corpusRoot: path.join(repoRoot, "examples/medium"),
  model: process.env.STRATA_AGENT_MODEL ?? "claude-sonnet-4-6",
  maxTurns: Number(process.env.STRATA_AGENT_MAX_TURNS ?? 25),
  wallTimeMs: Number(process.env.STRATA_AGENT_WALL_TIME_MS ?? 240000)
});

const failed = Object.entries(result.criteria).filter(([, value]) => !value);
if (result.terminalReason !== "success" || failed.length > 0) {
  throw new Error(
    `Live run did not pass T03: terminal=${result.terminalReason}, failed=${failed
      .map(([key]) => key)
      .join(",")}`
  );
}

const normalized = normalizeTranscriptForFixture(result.transcript);
const resultEvent = result.log.events.find((event) => event.type === "result");
const lines = [
  JSON.stringify({
    type: "session_start",
    ts: Date.now(),
    model: process.env.STRATA_AGENT_MODEL ?? "claude-sonnet-4-6",
    maxTurns: Number(process.env.STRATA_AGENT_MAX_TURNS ?? 25),
    task: "T03",
    actor: "agent-t03"
  }),
  ...normalized.map((step, index) =>
    JSON.stringify({
      type: "tool_call",
      ts: Date.now(),
      tool: step.tool,
      args: step.args,
      result_summary: "recorded live run",
      ok: true,
      error: null,
      durationMs: 0,
      turn: index
    })
  )
];

if (resultEvent) {
  lines.push(JSON.stringify(resultEvent));
}

mkdirSync(path.dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, `${lines.join("\n")}\n`);
console.log(`Recorded ${normalized.length} tool calls to ${fixturePath}`);
