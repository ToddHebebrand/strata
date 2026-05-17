import { describe, expect, it } from "vitest";
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
