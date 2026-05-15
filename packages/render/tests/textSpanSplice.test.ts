import { describe, expect, it } from "vitest";
import { spliceStatement, type TextSpanEdit } from "../src/splice";

describe("spliceStatement (generalized text-span edits)", () => {
  it("applies a single replacement span", () => {
    const edits: TextSpanEdit[] = [
      { start: 7, end: 11, oldText: "User", newText: "Account" }
    ];
    expect(spliceStatement("export User done", edits)).toBe(
      "export Account done"
    );
  });

  it("applies multiple spans by descending offset without interference", () => {
    const payload = "function f(a: number): string { return ''; }";
    const edits: TextSpanEdit[] = [
      { start: 20, end: 20, oldText: "", newText: ", tz: string" },
      { start: 23, end: 29, oldText: "string", newText: "Role" }
    ];
    const out = spliceStatement(payload, edits);
    expect(out).toBe(
      "function f(a: number, tz: string): Role { return ''; }"
    );
  });

  it("supports a pure insertion (zero-width span, empty oldText)", () => {
    const edits: TextSpanEdit[] = [
      { start: 5, end: 5, oldText: "", newText: "X" }
    ];
    expect(spliceStatement("abcdefg", edits)).toBe("abcdeXfg");
  });

  it("throws on oldText mismatch (the safety check is preserved)", () => {
    const edits: TextSpanEdit[] = [
      { start: 0, end: 3, oldText: "zzz", newText: "qqq" }
    ];
    expect(() => spliceStatement("abcdef", edits)).toThrow(/oldText mismatch/);
  });

  it("is a no-op for an empty edit list", () => {
    expect(spliceStatement("unchanged", [])).toBe("unchanged");
  });
});
