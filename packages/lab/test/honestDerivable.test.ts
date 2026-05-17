import { describe, it, expect } from "vitest";
import {
  HD_PROMPT,
  deriveOracle,
  scoreHonestDerivable
} from "../src/tasks/honestDerivable";

describe("HD task", () => {
  it("prompt names no per-scope literal value", () => {
    expect(HD_PROMPT).not.toMatch(/"UTC"|"local"/);
    expect(HD_PROMPT).toMatch(/ZONE/);
  });

  it("oracle is computed from the corpus, not hardcoded", () => {
    const oracle = deriveOracle();
    expect(oracle.scopes.server).toBe("ZONE");
    expect(oracle.scopes.ui).toBe("ZONE");
    expect(oracle.scopes.other).toBeUndefined();
  });

  it("a correct rendered tree scores pass; a literal-injected one fails", () => {
    const correct = deriveOracle().exampleCorrectRender;
    expect(scoreHonestDerivable(correct).pass).toBe(true);
    const cheated = new Map(correct);
    const ui = [...cheated.keys()].find((k) => k.includes("ui/")) as string;
    cheated.set(ui, cheated.get(ui)!.replace(/,\s*ZONE\s*\)/g, ', "local")'));
    expect(scoreHonestDerivable(cheated).pass).toBe(false);
  });
});
