import { describe, expect, it } from "vitest";
import { spliceStatement, type IdentifierMutation } from "../src/splice";

describe("spliceStatement", () => {
  it("returns the original payload when no mutations are applied", () => {
    expect(spliceStatement("export interface User {}", [])).toEqual(
      "export interface User {}"
    );
  });

  it("applies a single splice at a known offset", () => {
    const payload = "export interface User {}";
    const result = spliceStatement(payload, [
      { offset: 17, oldText: "User", newText: "Account" }
    ]);
    expect(result).toEqual("export interface Account {}");
  });

  it("applies multiple splices in descending offset order", () => {
    const payload = "function f(u: User): User { return u; }";
    const mutations: IdentifierMutation[] = [
      { offset: 14, oldText: "User", newText: "Account" },
      { offset: 21, oldText: "User", newText: "Account" }
    ];
    expect(spliceStatement(payload, mutations)).toEqual(
      "function f(u: Account): Account { return u; }"
    );
  });

  it("throws if oldText does not match at the given offset", () => {
    expect(() =>
      spliceStatement("export interface User {}", [
        { offset: 17, oldText: "Account", newText: "User" }
      ])
    ).toThrow(/oldText mismatch/);
  });
});
