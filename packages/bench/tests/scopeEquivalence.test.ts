import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateT01TextCriteria,
  evaluateT03TextCriteria,
  evaluateT05TextCriteria,
  evaluateT08TextCriteria,
  T05_TEST_KEY
} from "@strata-code/verify";
import { describe, expect, it } from "vitest";
import {
  assertSrcOnlyScope,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  tscNoEmitSrc
} from "../src/quality";
import {
  DEFAULT_PER_TASK_BUDGET,
  parseTaskBudget,
  resolveTaskBudget
} from "../src/runner";
import { readModuleMap, scoreTaskSharedCriteria } from "../src/score";
import type { BenchTaskId } from "../src/tasks";

const CORPUS = path.resolve(__dirname, "../../../examples/medium");
const TASKS: BenchTaskId[] = ["T01", "T03", "T05", "T08"];
const STATES = ["correct", "halfDone", "seed"] as const;

function correctMap(taskId: BenchTaskId): Map<string, string> {
  if (taskId === "T01") {
    return new Map([
      [
        "lib/format.ts",
        'export function formatTimestamp(ts: number, timezone: string = "UTC"): string {\n' +
          "  return new Date(ts).toISOString();\n}\n"
      ],
      [
        "server/events.ts",
        'import { formatTimestamp } from "../lib/format.ts";\n' +
          "export function logEvent(at: number, kind: string): string {\n" +
          '  return `${kind} @ ${formatTimestamp(at, "UTC")}`;\n}\n' +
          "export function eventLine(at: number): string {\n" +
          '  return formatTimestamp(at, "UTC");\n}\n'
      ],
      [
        "ui/timeline.ts",
        'import { formatTimestamp } from "../lib/format.ts";\n' +
          "export function timelineRows(times: number[]): string[] {\n" +
          "  return times.map(formatTimestamp);\n}\n" +
          "export function firstRow(times: number[]): string {\n" +
          '  return timelineRows(times)[0] ?? formatTimestamp(0, "local");\n}\n'
      ]
    ]);
  }

  if (taskId === "T05") {
    return new Map([
      [
        "lib/dateRange.ts",
        "export function isWithinRange(date: Date, start: Date, end: Date): boolean {\n" +
          "  return date >= start && date < end;\n}\n"
      ]
    ]);
  }

  if (taskId === "T08") {
    return new Map([
      [
        "lib/permissions.ts",
        'const ROLES: Record<string, "admin" | "editor"> = {\n' +
          '  u1: "admin",\n  u2: "editor"\n};\n\n' +
          'export function getRole(userId: string): "admin" | "editor" | "viewer" {\n' +
          '  return ROLES[userId] ?? "viewer";\n}\n\n' +
          "export function describeRole(userId: string): string {\n" +
          "  const role = getRole(userId);\n" +
          '  if (role === "admin") return "Administrator";\n' +
          '  if (role === "editor") return "Editor";\n' +
          '  return "Viewer";\n}\n'
      ]
    ]);
  }

  return new Map([
    [
      "users/greet.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "/**\n * Greet a user by name.\n * @param {Account} user\n */\n" +
        "export function greet(user: Account): string {\n" +
        "  return `hello ${user.email}`;\n}\n"
    ],
    [
      "users/legacy.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "/**\n * @param {Account} u\n * @returns {string}\n */\n" +
        "export function legacyId(u: Account): string {\n  return u.id;\n}\n"
    ],
    [
      "users/list.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export async function listUsers(load: () => Promise<Account[]>): Promise<Account[]> {\n" +
        "  return load();\n}\n"
    ],
    [
      "users/serializer.ts",
      'import * as UserTypes from "../types/user.ts";\n' +
        "export function serialize(user: UserTypes.Account): string {\n" +
        "  return JSON.stringify({ id: user.id, email: user.email });\n}\n"
    ],
    [
      "users/repo.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "export interface AccountRepo {\n" +
        "  byId(id: string): Promise<Account | undefined>;\n" +
        "  all(): Promise<Account[]>;\n" +
        "  save(user: Account): Promise<void>;\n}\n"
    ],
    ["types/user.ts", "export interface Account {\n  id: string;\n  email: string;\n}\n"],
    [
      "server/audit.ts",
      'export type AuditKind = "User" | "Session" | "Token";\n' +
        "export function userAudit(subjectId: string, ts: number): { kind: AuditKind; subjectId: string; ts: number } {\n" +
        '  return { kind: "User", subjectId, ts };\n}\n'
    ],
    ["index.ts", 'export type { Account } from "./types/user.ts";\n']
  ]);
}

function halfDoneMap(taskId: BenchTaskId): Map<string, string> {
  const map = new Map(correctMap(taskId));
  if (taskId === "T01") {
    map.set(
      "server/events.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        "export function logEvent(at: number, kind: string): string {\n" +
        "  return `${kind} @ ${formatTimestamp(at)}`;\n}\n" +
        "export function eventLine(at: number): string {\n" +
        "  return formatTimestamp(at);\n}\n"
    );
  } else if (taskId === "T05") {
    map.set(
      "lib/dateRange.ts",
      "export function isWithinRange(date: Date, start: Date, end: Date): boolean {\n" +
        "  return date >= start && date <= end;\n}\n"
    );
  } else if (taskId === "T08") {
    map.set(
      "lib/permissions.ts",
      'export function getRole(userId: string): "admin" | "editor" | "viewer" {\n' +
        '  return userId === "u1" ? "admin" : "viewer";\n}\n'
    );
  } else {
    map.set("index.ts", 'export type { User } from "./types/user.ts";\n');
  }
  return map;
}

function seedMap(taskId: BenchTaskId): Map<string, string> {
  if (taskId === "T01") {
    return new Map([
      [
        "lib/format.ts",
        "export function formatTimestamp(ts: number): string {\n" +
          "  return new Date(ts).toISOString();\n}\n"
      ],
      [
        "server/events.ts",
        'import { formatTimestamp } from "../lib/format.ts";\n' +
          "export function logEvent(at: number, kind: string): string {\n" +
          "  return `${kind} @ ${formatTimestamp(at)}`;\n}\n" +
          "export function eventLine(at: number): string {\n" +
          "  return formatTimestamp(at);\n}\n"
      ],
      [
        "ui/timeline.ts",
        'import { formatTimestamp } from "../lib/format.ts";\n' +
          "export function timelineRows(times: number[]): string[] {\n" +
          "  return times.map(formatTimestamp);\n}\n" +
          "export function firstRow(times: number[]): string {\n" +
          "  return timelineRows(times)[0] ?? formatTimestamp(0);\n}\n"
      ]
    ]);
  }

  if (taskId === "T05") return halfDoneMap("T05");
  if (taskId === "T08") {
    return new Map([
      [
        "lib/permissions.ts",
        'const ROLES: Record<string, string> = { u1: "admin", u2: "editor" };\n' +
          "export function getRole(userId: string): string {\n" +
          '  return ROLES[userId] ?? "viewer";\n}\n' +
          "export function describeRole(userId: string): string {\n" +
          "  const role = getRole(userId) as string;\n" +
          '  if (role === "admin") return "Administrator";\n' +
          '  if (role === "editor") return "Editor";\n' +
          '  return "Viewer";\n}\n'
      ]
    ]);
  }

  return new Map([
    [
      "users/greet.ts",
      'import type { User } from "../types/user.ts";\n' +
        "/**\n * Greet a user by name.\n * @param {User} user\n */\n" +
        "export function greet(user: User): string {\n" +
        "  return `hello ${user.email}`;\n}\n"
    ],
    [
      "users/legacy.ts",
      'import type { User } from "../types/user.ts";\n' +
        "/**\n * @param {User} u\n * @returns {string}\n */\n" +
        "export function legacyId(u: User): string {\n  return u.id;\n}\n"
    ],
    [
      "users/list.ts",
      'import type { User } from "../types/user.ts";\n' +
        "export async function listUsers(load: () => Promise<User[]>): Promise<User[]> {\n" +
        "  return load();\n}\n"
    ],
    [
      "users/serializer.ts",
      'import * as UserTypes from "../types/user.ts";\n' +
        "export function serialize(user: UserTypes.User): string {\n" +
        "  return JSON.stringify({ id: user.id, email: user.email });\n}\n"
    ],
    [
      "users/repo.ts",
      'import type { User } from "../types/user.ts";\n' +
        "export interface UserRepo {\n" +
        "  byId(id: string): Promise<User | undefined>;\n" +
        "  all(): Promise<User[]>;\n" +
        "  save(user: User): Promise<void>;\n}\n"
    ],
    ["types/user.ts", "export interface User {\n  id: string;\n  email: string;\n}\n"],
    [
      "server/audit.ts",
      'export type AuditKind = "User" | "Session" | "Token";\n' +
        "export function userAudit(subjectId: string, ts: number): { kind: AuditKind; subjectId: string; ts: number } {\n" +
        '  return { kind: "User", subjectId, ts };\n}\n'
    ],
    ["index.ts", 'export type { User } from "./types/user.ts";\n']
  ]);
}

function substrateTextCriteria(
  taskId: BenchTaskId,
  modules: Map<string, string>,
  seedTestText: string
): Record<string, boolean> {
  if (taskId === "T01") return { ...evaluateT01TextCriteria(modules) };
  if (taskId === "T03") return { ...evaluateT03TextCriteria(modules) };
  if (taskId === "T08") return { ...evaluateT08TextCriteria(modules) };
  const scored = new Map(modules);
  scored.set(T05_TEST_KEY, seedTestText);
  return { ...evaluateT05TextCriteria(scored, seedTestText) };
}

function materializeBaselineTree(map: Map<string, string>): {
  root: string;
  srcRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "strata-scope-"));
  const srcRoot = path.join(root, "src");
  for (const [rel, text] of map) {
    const dest = path.join(srcRoot, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  cpSync(path.join(CORPUS, "tsconfig.json"), path.join(root, "tsconfig.json"));
  cpSync(path.join(CORPUS, "tests"), path.join(root, "tests"), {
    recursive: true
  });
  return { root, srcRoot };
}

describe("scopeEquivalence (BS-R2 gate, no model, no key)", () => {
  for (const taskId of TASKS) {
    for (const state of STATES) {
      it(`${taskId} ${state}: substrate core == baseline core, byte-identical`, () => {
        const modules =
          state === "correct"
            ? correctMap(taskId)
            : state === "halfDone"
              ? halfDoneMap(taskId)
              : seedMap(taskId);
        const seedTestText =
          taskId === "T05"
            ? readFileSync(
                path.join(CORPUS, "tests", "dateRange.test.ts"),
                "utf8"
              )
            : "";

        const substrate = substrateTextCriteria(
          taskId,
          modules,
          seedTestText
        );
        const { root, srcRoot } = materializeBaselineTree(modules);
        try {
          const baselineFull = scoreTaskSharedCriteria(taskId, {
            modules: readModuleMap(srcRoot),
            commitReturnedOk: true,
            validateAfterCommitClean: true,
            seedTestText,
            testFileText: seedTestText
          });
          const baseline: Record<string, boolean> = {};
          for (const key of Object.keys(substrate)) {
            baseline[key] = baselineFull[key] as boolean;
          }
          expect(baseline).toEqual(substrate);

          assertSrcOnlyScope(root);
          expect(resolveCorpusTsconfigInclude(root)).toEqual(["src/**/*.ts"]);
          const rootNames = resolveTscProgramRootNames(root);
          expect(rootNames.every((name) => name.startsWith("src/"))).toBe(true);
          expect(rootNames.some((name) => name.includes("tests/"))).toBe(false);
          expect(existsSync(path.join(root, "tests"))).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  it("tscNoEmitSrc throws loudly if tests/ is reintroduced into include", () => {
    const { root } = materializeBaselineTree(seedMap("T01"));
    try {
      writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts", "tests/**/*.ts"] })
      );
      expect(() => tscNoEmitSrc(root)).toThrow(/src-only/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("per-task budget resolution (R3, no model, no key)", () => {
  it("uses artifact-derived defaults for T01/T05 and leaves T03/T08 global", () => {
    expect(DEFAULT_PER_TASK_BUDGET.T01).toEqual({
      maxTurns: 40,
      wallTimeMs: 420000
    });
    expect(DEFAULT_PER_TASK_BUDGET.T05).toEqual({
      maxTurns: 40,
      wallTimeMs: 300000
    });
    expect(DEFAULT_PER_TASK_BUDGET.T03).toBeUndefined();
    expect(DEFAULT_PER_TASK_BUDGET.T08).toBeUndefined();
    expect(
      resolveTaskBudget("T03", 25, 240000, DEFAULT_PER_TASK_BUDGET)
    ).toEqual({ maxTurns: 25, wallTimeMs: 240000 });
    expect(
      resolveTaskBudget("T08", 25, 240000, DEFAULT_PER_TASK_BUDGET)
    ).toEqual({ maxTurns: 25, wallTimeMs: 240000 });
    expect(
      resolveTaskBudget("T01", 25, 240000, DEFAULT_PER_TASK_BUDGET)
    ).toEqual({ maxTurns: 40, wallTimeMs: 420000 });
  });

  it("parses --task-budget and rejects unknown task ids", () => {
    expect(
      parseTaskBudget("T01:maxTurns=40,wallMs=420000;T05:maxTurns=40")
    ).toEqual({
      T01: { maxTurns: 40, wallTimeMs: 420000 },
      T05: { maxTurns: 40 }
    });
    expect(
      resolveTaskBudget("T01", 25, 240000, {
        T01: { maxTurns: 50, wallTimeMs: 500000 }
      })
    ).toEqual({ maxTurns: 50, wallTimeMs: 500000 });
    expect(() => parseTaskBudget("T99:maxTurns=40")).toThrow(/T99/);
  });
});
