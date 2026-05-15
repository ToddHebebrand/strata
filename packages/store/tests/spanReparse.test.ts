import { describe, expect, it } from "vitest";
import { locateSpan } from "../src/spanReparse";

const WITH_RETURN =
  "\nexport function getRole(userId: string): string {\n  return 'admin';\n}\n";
const WITH_JSDOC =
  "\n/** role lookup */\nexport function getRole(userId: string): string {\n  return 'admin';\n}\n";
const NO_RETURN =
  "\nexport function ping(a: number) {\n  return a;\n}\n";

describe("locateSpan", () => {
  it("locates the parameter list (the NodeArray span, inside the parens)", () => {
    const span = locateSpan(WITH_RETURN, "params");
    expect(WITH_RETURN.slice(span.start, span.end)).toBe("userId: string");
  });

  it("locates spans in payload offsets even with leading trivia", () => {
    const span = locateSpan(WITH_JSDOC, "params");
    expect(WITH_JSDOC.slice(span.start, span.end)).toBe("userId: string");
    expect(span.start).toBe(WITH_JSDOC.indexOf("userId"));
  });

  it("locates an existing return-type annotation span", () => {
    const span = locateSpan(WITH_RETURN, "returnType");
    expect(WITH_RETURN.slice(span.start, span.end)).toBe("string");
  });

  it("returns a zero-width insertion span for an absent return type", () => {
    const span = locateSpan(NO_RETURN, "returnType");
    expect(span.start).toBe(span.end);
    expect(NO_RETURN.slice(span.start - 1, span.start + 1)).toBe(") ");
  });

  it("locates the body block span including its braces", () => {
    const span = locateSpan(WITH_RETURN, "body");
    expect(WITH_RETURN.slice(span.start, span.end)).toBe(
      "{\n  return 'admin';\n}"
    );
  });

  it("throws when the payload is not a single function declaration", () => {
    expect(() => locateSpan("\nconst x = 1;\n", "body")).toThrow(
      /not a function declaration/i
    );
  });
});
