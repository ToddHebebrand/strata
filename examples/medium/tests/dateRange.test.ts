import { describe, expect, it } from "vitest";
import { isWithinRange } from "../src/lib/dateRange.ts";

const d = (iso: string) => new Date(iso);

describe("isWithinRange (T05 - half-open interval)", () => {
  it("includes the start instant", () => {
    expect(
      isWithinRange(d("2020-01-01"), d("2020-01-01"), d("2020-02-01"))
    ).toBe(true);
  });

  it("EXCLUDES the end instant (half-open [start, end))", () => {
    expect(
      isWithinRange(d("2020-02-01"), d("2020-01-01"), d("2020-02-01"))
    ).toBe(false);
  });

  it("includes an interior instant", () => {
    expect(
      isWithinRange(d("2020-01-15"), d("2020-01-01"), d("2020-02-01"))
    ).toBe(true);
  });
});
