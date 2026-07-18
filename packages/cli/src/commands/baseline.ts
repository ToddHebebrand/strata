import path from "node:path";
import { runBaseline, type BaselineResult } from "@strata-code/agent";

export interface RunBaselineCliInput {
  corpusRoot: string;
  prompt: string;
  keepTree?: boolean;
  printTranscript?: boolean;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  logPath?: string;
}

export async function runBaselineCommand(
  input: RunBaselineCliInput
): Promise<BaselineResult> {
  const result = await runBaseline({
    corpusRoot: path.resolve(input.corpusRoot),
    prompt: input.prompt,
    model: input.model ?? "claude-sonnet-4-6",
    maxTurns: input.maxTurns ?? 40,
    wallTimeMs: input.wallTimeMs ?? 600_000,
    keepTree: input.keepTree === true,
    logPath: input.logPath ? path.resolve(input.logPath) : undefined
  });

  if (input.printTranscript) {
    for (const event of result.log.events) {
      if (event.type === "tool_call") {
        const target =
          typeof event.args === "object" && event.args !== null
            ? JSON.stringify(event.args)
            : "";
        process.stdout.write(
          `  ${event.ok ? "OK" : "ERR"} ${event.tool} ${target}\n`
        );
      }
    }
    process.stdout.write("\n");
  }

  return result;
}
