import { describe, expect, it } from "vitest";
import { collectBaselineSession } from "../src/session";

async function* fakeStream(): AsyncGenerator<unknown, void> {
  yield {
    type: "system",
    subtype: "init",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    mcp_servers: []
  };
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Edit",
          input: { file_path: "src/types/user.ts" }
        }
      ]
    }
  };
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [] },
    tool_use_result: [
      { type: "tool_result", tool_use_id: "tu_1", is_error: false }
    ]
  };
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }]
    }
  };
  yield {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 2,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5
    },
    modelUsage: {},
    is_error: false
  };
}

describe("collectBaselineSession (synthetic stream, no key)", () => {
  it("captures SDKResult metrics, terminalReason, and the tool-event list", async () => {
    const session = await collectBaselineSession(fakeStream());
    expect(session.terminalReason).toBe("success");
    expect(session.result).toBeDefined();
    expect(session.result?.totalCostUsd).toBe(0.42);
    expect(session.result?.numTurns).toBe(2);
    expect(session.result?.durationMs).toBe(1234);
    expect(session.result?.usage.inputTokens).toBe(100);
    expect(session.result?.usage.outputTokens).toBe(50);
    expect(session.result?.usage.cacheReadInputTokens).toBe(10);
    expect(session.toolEvents).toEqual([
      {
        tool: "Edit",
        path: "src/types/user.ts",
        command: undefined,
        exitCode: undefined
      }
    ]);
    expect(session.toolInvocations).toBe(1);
  });

  it("maps error_max_turns terminal subtype", async () => {
    async function* errStream(): AsyncGenerator<unknown, void> {
      yield {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 9,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        },
        modelUsage: {},
        is_error: true,
        errors: ["max turns"]
      };
    }
    const session = await collectBaselineSession(errStream());
    expect(session.terminalReason).toBe("error_max_turns");
  });

  it("a THROWN SDK max-turns error becomes error_max_turns, not a crash", async () => {
    // Installed SDK 0.2.118 THROWS max-turns rather than yielding the result
    // subtype above. Must not propagate (that crashed the whole round).
    async function* throwMaxTurns(): AsyncGenerator<unknown, void> {
      yield { type: "system", subtype: "init", tools: [] };
      throw new Error(
        "Claude Code returned an error result: Reached maximum number of turns (40)"
      );
    }
    const session = await collectBaselineSession(throwMaxTurns());
    expect(session.terminalReason).toBe("error_max_turns");
    expect(session.result).toBeUndefined();
  });

  it("a genuine thrown error still fails loud (propagates)", async () => {
    async function* throwReal(): AsyncGenerator<unknown, void> {
      yield { type: "system", subtype: "init", tools: [] };
      throw new Error("ECONNRESET socket hang up");
    }
    await expect(collectBaselineSession(throwReal())).rejects.toThrow(
      /ECONNRESET/
    );
  });

  it("an aborted (wall-time) throw becomes error_wall_time", async () => {
    async function* throwAborted(): AsyncGenerator<unknown, void> {
      yield { type: "system", subtype: "init", tools: [] };
      throw new Error("Reached maximum number of turns (40)");
    }
    const session = await collectBaselineSession(throwAborted(), {
      aborted: true
    });
    expect(session.terminalReason).toBe("error_wall_time");
  });
});
