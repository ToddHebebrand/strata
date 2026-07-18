import { describe, expect, it } from "vitest";
import { BENCH_PACKAGE } from "../src/index";

describe("@strata-code/bench scaffold", () => {
  it("exports the package marker", () => {
    expect(BENCH_PACKAGE).toBe("@strata-code/bench");
  });
});
