import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptFixture } from "../src/session";

describe("loadTranscriptFixture", () => {
  it("parses a JSON-lines transcript of tool_call events into ReplayStep[]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strata-fix-"));
    const file = path.join(dir, "t.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_start",
          ts: 1,
          model: "m",
          maxTurns: 25,
          task: "T03",
          actor: "agent-t03"
        }),
        JSON.stringify({
          type: "tool_call",
          ts: 2,
          tool: "find_declarations",
          args: { name: "User", kind: "interface" },
          result_summary: "",
          ok: true,
          error: null,
          durationMs: 1,
          turn: 0
        }),
        JSON.stringify({
          type: "tool_call",
          ts: 3,
          tool: "begin_transaction",
          args: {},
          result_summary: "",
          ok: true,
          error: null,
          durationMs: 1,
          turn: 0
        }),
        JSON.stringify({
          type: "tool_call",
          ts: 4,
          tool: "rename_symbol",
          args: { tx: "$TX", declaration_id: "abc", new_name: "Account" },
          result_summary: "",
          ok: true,
          error: null,
          durationMs: 1,
          turn: 1
        }),
        JSON.stringify({
          type: "result",
          ts: 5,
          subtype: "success",
          numTurns: 2,
          durationMs: 1,
          durationApiMs: 1,
          totalCostUsd: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0
          },
          modelUsage: {},
          errors: []
        })
      ].join("\n") + "\n"
    );

    const steps = loadTranscriptFixture(file);
    expect(steps.map((step) => step.tool)).toEqual([
      "find_declarations",
      "begin_transaction",
      "rename_symbol"
    ]);
    expect(steps[2]!.args).toEqual({
      tx: "$TX",
      declaration_id: "abc",
      new_name: "Account"
    });
  });
});
