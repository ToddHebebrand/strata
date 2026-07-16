import {
  createSdkMcpServer,
  type Options,
  type SDKResultMessage
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  runHermeticSession,
  type HermeticQuery
} from "../src/hermeticSession";
import { classifySessionError } from "../src/session";

describe("classifySessionError", () => {
  it("maps the SDK max-turns throw to error_max_turns and does NOT rethrow", () => {
    // Installed @anthropic-ai/claude-agent-sdk@0.2.118 signals the maxTurns
    // bound by THROWING this, not by yielding a result{subtype:error_max_turns}.
    const caught = new Error(
      "Claude Code returned an error result: Reached maximum number of turns (40)"
    );
    expect(classifySessionError(caught, false)).toEqual({
      terminal: "error_max_turns",
      rethrow: false
    });
  });

  it("detects max-turns regardless of the turn count / casing", () => {
    expect(
      classifySessionError(new Error("reached MAXIMUM number of TURNS (25)"), false)
        .terminal
    ).toBe("error_max_turns");
  });

  it("a wall-time abort stays error_wall_time and is swallowed", () => {
    // aborted === true → wall-time, regardless of the thrown message.
    expect(
      classifySessionError(new Error("aborted"), true)
    ).toEqual({ terminal: "error_wall_time", rethrow: false });
  });

  it("an abort wins even if the message looks like max-turns", () => {
    expect(
      classifySessionError(
        new Error("Reached maximum number of turns (40)"),
        true
      )
    ).toEqual({ terminal: "error_wall_time", rethrow: false });
  });

  it("a genuine unexpected error still fails loud (error_other, rethrow)", () => {
    expect(
      classifySessionError(new Error("ECONNRESET socket hang up"), false)
    ).toEqual({ terminal: "error_other", rethrow: true });
  });

  it("handles non-Error throws without crashing", () => {
    expect(classifySessionError("boom", false)).toEqual({
      terminal: "error_other",
      rethrow: true
    });
  });
});

describe("query budget terminal classification", () => {
  it("returns max_budget, preserves SDK cost/usage, and never retries", async () => {
    const budgetResult = {
      type: "result",
      subtype: "error_max_budget_usd",
      duration_ms: 120,
      duration_api_ms: 100,
      is_error: true,
      num_turns: 3,
      stop_reason: null,
      total_cost_usd: 0.51,
      usage: {
        input_tokens: 101,
        output_tokens: 33,
        cache_creation_input_tokens: 17,
        cache_read_input_tokens: 29,
        server_tool_use: null,
        service_tier: "standard"
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["Maximum budget reached"],
      uuid: "00000000-0000-4000-8000-000000000021",
      session_id: "session-budget"
    } as SDKResultMessage;
    const server = createSdkMcpServer({
      name: "budget-probe",
      version: "0.0.0",
      tools: []
    });
    let calls = 0;
    let options: Options | undefined;
    const queryFn: HermeticQuery = (input) => {
      calls += 1;
      options = input.options;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          claude_code_version: "test",
          cwd: "/tmp/session-budget",
          tools: ["mcp__budget-probe__run"],
          mcp_servers: [{ name: "budget-probe", status: "connected" }],
          model: "test-model",
          permissionMode: "bypassPermissions",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          uuid: "00000000-0000-4000-8000-000000000020",
          session_id: "session-budget"
        } as const;
        yield budgetResult;
      })();
    };

    const output = await runHermeticSession({
      prompt: "Run the bounded task.",
      systemPrompt: "Use only the bounded tool.",
      serverName: "budget-probe",
      server,
      allowedTools: ["mcp__budget-probe__run"],
      bannedBuiltins: ["Read", "Write", "Bash", "LSP"],
      model: "test-model",
      maxTurns: 5,
      wallTimeMs: 2_000,
      maxBudgetUsd: 0.5,
      queryFn
    });

    expect(calls).toBe(1);
    expect(options?.maxBudgetUsd).toBe(0.5);
    expect(output.terminalReason).toBe("max_budget");
    expect(output.result).toBe(budgetResult);
    expect(output.result?.total_cost_usd).toBe(0.51);
    expect(output.result?.usage).toEqual(budgetResult.usage);
  });
});
