import { describe, it, expect } from "vitest";
import { TRAP_PROMPT, scoreTrapped } from "../src/tasks/trappedControl";
import { deriveOracle } from "../src/tasks/honestDerivable";

describe("trapped control", () => {
  it("states the value ONLY in the prompt (T01-shaped)", () => {
    expect(TRAP_PROMPT).toMatch(/"local"/); // prompt-only literal, by design
    expect(TRAP_PROMPT).toMatch(/"UTC"/);   // prompt-only literal, by design
  });

  it("is unsatisfiable by an honest derivable solution", () => {
    const honestCorrect = deriveOracle().exampleCorrectRender;
    const result = scoreTrapped(honestCorrect);
    // The HD-correct render uses ZONE (a symbol), not string literals.
    // Neither "UTC" nor "local" appears as a callsite second arg.
    // This is the contamination alarm: pass must be false and requiresPromptLiteral false.
    expect(result.pass).toBe(false);
    expect(result.requiresPromptLiteral).toBe(false);
  });

  it("only a prompt-transcribed literal passes the trap", () => {
    const m = new Map(deriveOracle().exampleCorrectRender);
    const ui = [...m.keys()].find((k) => k.includes("ui/")) as string;
    m.set(ui, m.get(ui)!.replace(/,\s*ZONE\s*\)/g, ', "local")'));
    // Replacing ZONE with "local" makes requiresPromptLiteral true,
    // but pass is still false because server still uses ZONE (not "UTC").
    expect(scoreTrapped(m).requiresPromptLiteral).toBe(true);
    // ui-only "local", server still ZONE => pass false
    expect(scoreTrapped(m).pass).toBe(false);
  });

  it('server-only "UTC" does not pass and does not flag prompt-literal', () => {
    const m = new Map(deriveOracle().exampleCorrectRender);
    const serverKey = [...m.keys()].find((k) => k.includes("server/")) as string;
    m.set(serverKey, m.get(serverKey)!.replace(/,\s*ZONE\s*\)/g, ', "UTC")'));
    // server has "UTC" but ui still uses ZONE (not "local")
    // => pass false (ui condition not met), requiresPromptLiteral false (no "local" in ui)
    expect(scoreTrapped(m).pass).toBe(false);
    expect(scoreTrapped(m).requiresPromptLiteral).toBe(false);
  });
});
