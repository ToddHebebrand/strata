import { openDb } from "@strata/store";
import { describe, expect, it } from "vitest";
import { STRATA_SYSTEM_PROMPT } from "../src/prompt";
import {
  createStrataTools,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_TOOL_NAMES
} from "../src/tools";

describe("agent surface 8 -> 11", () => {
  it("registers exactly eleven tools including the three new mutations", () => {
    const db = openDb(":memory:");
    try {
      const tools = createStrataTools({ db, actor: "t" });
      expect(tools).toHaveLength(11);
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain("add_parameter");
      expect(names).toContain("change_return_type");
      expect(names).toContain("replace_body");
    } finally {
      db.close();
    }
  });

  it("includes the three new tools in the hermetic guard lists", () => {
    for (const name of [
      "add_parameter",
      "change_return_type",
      "replace_body"
    ]) {
      expect(STRATA_TOOL_NAMES).toContain(name);
      expect(STRATA_QUALIFIED_TOOL_NAMES).toContain(`mcp__strata__${name}`);
    }
    expect(STRATA_TOOL_NAMES).toHaveLength(11);
  });

  it("prompt describes each new tool and choosing the right mutation", () => {
    expect(STRATA_SYSTEM_PROMPT).toContain("add_parameter");
    expect(STRATA_SYSTEM_PROMPT).toContain("change_return_type");
    expect(STRATA_SYSTEM_PROMPT).toContain("replace_body");
    expect(STRATA_SYSTEM_PROMPT.toLowerCase()).toContain(
      "choosing the right"
    );
  });

  it("prompt has no benchmark-specific recipe", () => {
    expect(STRATA_SYSTEM_PROMPT).not.toMatch(
      /formatTimestamp|getRole|isWithinRange|dateRange|"UTC"|T01|T05|T08/
    );
  });
});
