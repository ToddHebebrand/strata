import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeCorpus,
  scoreBaselineTrial
} from "../src/configs/baseline";

describe("materializeCorpus", () => {
  it("recursively copies a synthetic corpus into a fresh temp tree", () => {
    const src = mkdtempSync(path.join(tmpdir(), "strata-src-"));
    mkdirSync(path.join(src, "src", "types"), { recursive: true });
    writeFileSync(
      path.join(src, "src", "types", "user.ts"),
      "export interface User {}\n"
    );
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "x", private: true })
    );

    const { root, srcRoot } = materializeCorpus(src, { initGit: false });
    expect(root).not.toBe(src);
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
    expect(
      readFileSync(path.join(srcRoot, "types", "user.ts"), "utf8")
    ).toContain("interface User");
  });
});

describe("scoreBaselineTrial", () => {
  it("reads post-edit files off the temp tree and scores the ten shared criteria", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "strata-bl-"));
    const srcRoot = path.join(tmp, "src");
    const write = (rel: string, text: string): void => {
      const dest = path.join(srcRoot, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    };

    write(
      "users/greet.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "/** @param {Account} user */\n" +
        "export function greet(user: Account): string { return `${user.name}`; }\n"
    );
    write(
      "users/legacy.ts",
      "/** @param {Account} u */\nexport function legacy(u: Account): void {}\n"
    );
    write(
      "users/list.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export function list(): Promise<Account[]> { return Promise.resolve([]); }\n"
    );
    write(
      "users/serializer.ts",
      'import type * as UserTypes from "../types/user.ts";\n' +
        "export function s(user: UserTypes.Account): string { return user.name; }\n"
    );
    write(
      "users/repo.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export interface Repo { save(user: Account): Promise<void>; }\n"
    );
    write("types/user.ts", "export interface Account { name: string; }\n");
    write(
      "server/audit.ts",
      'export function audit(kind: "User"): void { console.log("User", kind); }\n'
    );
    write("index.ts", 'export type { Account } from "./types/user.ts";\n');

    const criteria = scoreBaselineTrial({
      srcRoot,
      commitReturnedOk: true,
      validateAfterCommitClean: true
    });
    for (const [key, value] of Object.entries(criteria)) {
      expect(value, `shared criterion ${key}`).toBe(true);
    }
  });
});
