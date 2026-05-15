import { describe, expect, it } from "vitest";
import { TASK_PROMPTS, T03_PROMPT } from "../src/session";

describe("TASK_PROMPTS", () => {
  it("carries the four task prompts from docs/benchmarks.md", () => {
    expect(TASK_PROMPTS.T01).toContain("timezone");
    expect(TASK_PROMPTS.T01).toContain('"UTC"');
    expect(TASK_PROMPTS.T03).toBe(T03_PROMPT);
    expect(TASK_PROMPTS.T05).toContain("dateRange.test.ts");
    expect(TASK_PROMPTS.T05).toContain("Do not modify the test file");
    expect(TASK_PROMPTS.T08).toContain('"admin" | "editor" | "viewer"');
  });

  it("contains no Strata-tool recipe", () => {
    for (const prompt of Object.values(TASK_PROMPTS)) {
      expect(prompt).not.toMatch(/begin_transaction|rename_symbol|add_parameter/);
    }
  });
});
