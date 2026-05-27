import path from "node:path";
import { runAgent, type AgentResult } from "@strata/agent";

export interface RunAgentCliInput {
  corpusRoot: string;
  prompt: string;
  dbPath?: string;
  reset?: boolean;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  logPath?: string;
  /**
   * When true, prints assistant text and tool calls to stdout as they happen
   * (read from the log on completion since the SDK only surfaces them at the
   * end of the stream — see runLiveSession).
   */
  printTranscript?: boolean;
  /**
   * When false, suppress the auto-injected codebase-shape index that
   * normally lands as the agent's turn-1 context. Defaults to true. Use
   * `--no-index` on the CLI for paired with/without measurement.
   */
  injectModuleIndex?: boolean;
}

export async function runAgentCommand(
  input: RunAgentCliInput
): Promise<AgentResult> {
  const result = await runAgent({
    corpusRoot: path.resolve(input.corpusRoot),
    prompt: input.prompt,
    model: input.model ?? "claude-sonnet-4-6",
    maxTurns: input.maxTurns ?? 40,
    wallTimeMs: input.wallTimeMs ?? 600_000,
    dbPath: input.dbPath ? path.resolve(input.dbPath) : undefined,
    reset: input.reset === true,
    logPath: input.logPath ? path.resolve(input.logPath) : undefined,
    actor: "strata-cli",
    injectModuleIndex: input.injectModuleIndex !== false
  });

  if (input.printTranscript) {
    for (const event of result.log.events) {
      if (event.type === "assistant_text") {
        process.stdout.write(`\n[${event.turn}] ${event.text}\n`);
      } else if (event.type === "tool_call") {
        process.stdout.write(
          `  ${event.ok ? "✓" : "✗"} ${event.tool} ${event.durationMs}ms` +
            (event.error ? ` ERROR=${event.error}` : "") +
            "\n"
        );
      }
    }
    process.stdout.write("\n");
  }

  return result;
}
