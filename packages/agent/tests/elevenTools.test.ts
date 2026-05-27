import { openDb } from "@strata/store";
import { describe, expect, it } from "vitest";
import { STRATA_SYSTEM_PROMPT } from "../src/prompt";
import {
  createStrataTools,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_TOOL_NAMES
} from "../src/tools";

describe("agent surface (17 tools after L2 semantic_search)", () => {
  it("registers exactly seventeen tools including the discovery, semantic-search, and mutation surfaces", () => {
    const db = openDb(":memory:");
    try {
      const tools = createStrataTools({ db, actor: "t" });
      expect(tools).toHaveLength(17);
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain("add_import");
      expect(names).toContain("add_parameter");
      expect(names).toContain("change_return_type");
      expect(names).toContain("create_function");
      expect(names).toContain("find_declarations_in_module");
      expect(names).toContain("list_module_exports");
      expect(names).toContain("read_test_file");
      expect(names).toContain("replace_body");
      expect(names).toContain("semantic_search");
    } finally {
      db.close();
    }
  });

  it("includes the new tools in the hermetic guard lists", () => {
    for (const name of [
      "add_import",
      "add_parameter",
      "change_return_type",
      "create_function",
      "find_declarations_in_module",
      "list_module_exports",
      "read_test_file",
      "replace_body",
      "semantic_search"
    ]) {
      expect(STRATA_TOOL_NAMES).toContain(name);
      expect(STRATA_QUALIFIED_TOOL_NAMES).toContain(`mcp__strata__${name}`);
    }
    expect(STRATA_TOOL_NAMES).toHaveLength(17);
  });

  it("prompt describes each mutation and choosing the right mutation", () => {
    expect(STRATA_SYSTEM_PROMPT).toContain("add_import");
    expect(STRATA_SYSTEM_PROMPT).toContain("add_parameter");
    expect(STRATA_SYSTEM_PROMPT).toContain("change_return_type");
    expect(STRATA_SYSTEM_PROMPT).toContain("create_function");
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
