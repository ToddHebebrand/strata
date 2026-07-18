import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE } from "../src/index";

describe("@strata-code/agent scaffold", () => {
  it("exports the package marker", () => {
    expect(AGENT_PACKAGE).toBe("@strata-code/agent");
  });
});
