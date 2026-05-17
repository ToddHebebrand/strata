import { describe, it, expect } from "vitest";
import { LAB_IS_NON_AUTHORITATIVE } from "../src/index";

describe("lab scaffold", () => {
  it("declares itself non-authoritative", () => {
    expect(LAB_IS_NON_AUTHORITATIVE).toBe(true);
  });
});
