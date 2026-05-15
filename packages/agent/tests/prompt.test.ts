import { describe, expect, it } from "vitest";
import { STRATA_SYSTEM_PROMPT } from "../src/prompt";

describe("STRATA_SYSTEM_PROMPT", () => {
  it("is a single static non-empty string", () => {
    expect(typeof STRATA_SYSTEM_PROMPT).toBe("string");
    expect(STRATA_SYSTEM_PROMPT.length).toBeGreaterThan(800);
  });

  it("is roughly 2000-4000 tokens by a coarse character heuristic", () => {
    const approxTokens = STRATA_SYSTEM_PROMPT.length / 4;
    expect(approxTokens).toBeGreaterThan(1500);
    expect(approxTokens).toBeLessThan(5000);
  });

  it("covers the load-bearing worldview sections", () => {
    const p = STRATA_SYSTEM_PROMPT;
    expect(p).toMatch(/no filesystem|no files|not as files/i);
    expect(p).toMatch(/string literal/i);
    expect(p).toMatch(/transaction/i);
    expect(p).toMatch(/validate/i);
    expect(p).toMatch(/rollback/i);
    expect(p).toMatch(/explore/i);
    for (const name of [
      "find_declarations",
      "get_references",
      "read_node",
      "begin_transaction",
      "rename_symbol",
      "validate",
      "commit_transaction",
      "rollback_transaction"
    ]) {
      expect(p).toContain(name);
    }
  });

  it("does not contain benchmark-specific identifiers or a scripted recipe", () => {
    const p = STRATA_SYSTEM_PROMPT;
    expect(p).not.toMatch(/\bUser\b/);
    expect(p).not.toMatch(/\bAccount\b/);
    expect(p).not.toMatch(/audit/i);
    expect(p).not.toMatch(
      /call .*find_declarations.* then .* begin_transaction .* then .* rename_symbol/i
    );
  });
});
