import { describe, it, expect } from "vitest";
import { REGISTRY, getExperiment } from "../src/registry";

describe("registry", () => {
  it("maps ids to experiments and throws on unknown", () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
    expect(() => getExperiment("nope")).toThrow(/unknown experiment/i);
  });

  it("the temporary noop placeholder is REMOVED, not left alongside", () => {
    // Task 10 follow-up: the inline control noop must be GONE.
    expect(REGISTRY["noop"]).toBeUndefined();
    expect(() => getExperiment("noop")).toThrow(/unknown experiment/i);
  });

  it("resolves the real first experiment per-scope-add-parameter", () => {
    const exp = getExperiment("per-scope-add-parameter");
    expect(exp.id).toBe("per-scope-add-parameter");
    expect(exp.task).toBe("HD");
    // The substantive lever wires a tool-server factory override.
    expect(typeof exp.overrides.toolServerFactory).toBe("function");
  });

  it("resolves the inverted control canonical-control (no overrides, HD)", () => {
    const exp = getExperiment("canonical-control");
    expect(exp.id).toBe("canonical-control");
    expect(exp.task).toBe("HD");
    // The control deliberately has NO overrides — vanilla canonical tools.
    expect(exp.overrides.toolServerFactory).toBeUndefined();
    expect(exp.overrides.canUseTool).toBeUndefined();
  });
});
