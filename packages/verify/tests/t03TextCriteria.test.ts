import { describe, expect, it } from "vitest";
import { evaluateT03TextCriteria } from "../src/index";

/**
 * A fully-correct post-rename module set (User -> Account everywhere it is a
 * type; the audit.ts "User" string literal untouched). Keys are POSIX paths
 * relative to the corpus src/ root, exactly as both adapters key them.
 */
function correctModules(): Map<string, string> {
  return new Map<string, string>([
    [
      "users/greet.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "/** @param {Account} user */\n" +
        "export function greet(user: Account): string {\n" +
        "  return `hi ${user.name}`;\n}\n"
    ],
    [
      "users/legacy.ts",
      "/** @param {Account} u */\nexport function legacy(u: Account): void {}\n"
    ],
    [
      "users/list.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export function list(): Promise<Account[]> { return Promise.resolve([]); }\n"
    ],
    [
      "users/serializer.ts",
      'import * as UserTypes from "../types/user.ts";\n' +
        "export function ser(user: UserTypes.Account): string { return user.name; }\n"
    ],
    [
      "users/repo.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export interface Repo { save(user: Account): Promise<void>; }\n"
    ],
    ["types/user.ts", "export interface Account { name: string; }\n"],
    [
      "server/audit.ts",
      'export function audit(kind: "User"): void { console.log("User", kind); }\n'
    ],
    ["index.ts", 'export type { Account } from "./types/user.ts";\n']
  ]);
}

describe("evaluateT03TextCriteria", () => {
  it("returns all nine text criteria true for a fully-correct rename", () => {
    const c = evaluateT03TextCriteria(correctModules());
    for (const [key, value] of Object.entries(c)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
  });

  it("fails when the audit literal was clobbered to Account", () => {
    const m = correctModules();
    m.set(
      "server/audit.ts",
      'export function audit(kind: "Account"): void { console.log("Account", kind); }\n'
    );
    const c = evaluateT03TextCriteria(m);
    expect(c.auditLiteralUntouched).toBe(false);
    expect(c.auditLiteralOnlyRemainingUser).toBe(false);
  });

  it("fails when a type position was left as User (half-rename)", () => {
    const m = correctModules();
    m.set(
      "users/list.ts",
      'import type { User } from "../types/user.ts";\n' +
        "export function list(): Promise<User[]> { return Promise.resolve([]); }\n"
    );
    const c = evaluateT03TextCriteria(m);
    expect(c.genericPromiseRenamed).toBe(false);
  });
});
