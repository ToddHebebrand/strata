import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  commitWithoutValidate,
  insertNodes,
  openDb,
  queuePendingOp
} from "@strata/store";
import { evaluateT08Criteria, evaluateT08TextCriteria } from "../src/index";

const SRC_ROOT = path.resolve("/corpus/src");

function correctModules(): Map<string, string> {
  return new Map<string, string>([
    [
      "lib/permissions.ts",
      'const ROLES: Record<string, "admin" | "editor" | "viewer"> = {\n' +
        '  u1: "admin",\n' +
        '  u2: "editor"\n' +
        "};\n\n" +
        'export function getRole(userId: string): "admin" | "editor" | "viewer" {\n' +
        '  return ROLES[userId] ?? "viewer";\n' +
        "}\n\n" +
        "export function describeRole(userId: string): string {\n" +
        "  const role = getRole(userId);\n" +
        '  if (role === "admin") return "Administrator";\n' +
        '  if (role === "editor") return "Editor";\n' +
        '  return "Viewer";\n' +
        "}\n"
    ]
  ]);
}

describe("evaluateT08TextCriteria", () => {
  it("all text criteria true for a correct change_return_type result", () => {
    const criteria = evaluateT08TextCriteria(correctModules());
    for (const [key, value] of Object.entries(criteria)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
  });

  it("fails when getRole still returns plain string", () => {
    const modules = correctModules();
    modules.set(
      "lib/permissions.ts",
      "export function getRole(userId: string): string {\n" +
        '  return "admin";\n' +
        "}\n"
    );
    expect(evaluateT08TextCriteria(modules).returnTypeIsLiteralUnion).toBe(
      false
    );
  });

  it("fails when an as string cast on getRole's result remains", () => {
    const modules = correctModules();
    modules.set(
      "lib/permissions.ts",
      modules
        .get("lib/permissions.ts")!
        .replace("const role = getRole(userId);", "const role = getRole(userId) as string;")
    );
    expect(evaluateT08TextCriteria(modules).noAsStringCastOnResult).toBe(false);
  });

  it("accepts a switch-form caller (intent: any type-safe consumption, not just if-chains)", () => {
    // Behaviorally identical to correctModules() but describeRole uses an
    // exhaustive `switch (role)` instead of `if (role === ...)`. This is the
    // T08 N=3 trial-1 shape: tsc-clean, vitest-passing, committed, correct.
    const modules = new Map<string, string>([
      [
        "lib/permissions.ts",
        'const ROLES: Record<string, "admin" | "editor" | "viewer"> = {\n' +
          '  u1: "admin",\n  u2: "editor"\n};\n\n' +
          'export function getRole(userId: string): "admin" | "editor" | "viewer" {\n' +
          "  const raw = ROLES[userId];\n" +
          '  if (raw === "admin" || raw === "editor") return raw;\n' +
          '  return "viewer";\n}\n\n' +
          "export function describeRole(userId: string): string {\n" +
          "  const role = getRole(userId);\n" +
          "  switch (role) {\n" +
          '    case "admin":  return "Administrator";\n' +
          '    case "editor": return "Editor";\n' +
          '    default:       return "Viewer";\n' +
          "  }\n}\n"
      ]
    ]);
    expect(
      evaluateT08TextCriteria(modules).callersTypecheckUnderNarrowType
    ).toBe(true);
  });

  it("is NOT satisfied by a coincidental role === match outside describeRole", () => {
    // describeRole binds cleanly but does NOT discriminate the narrowed
    // union at all (just returns it); getRole's body coincidentally contains
    // `role === "admin"` / `role === "editor"`. The OLD whole-module scan
    // returns true off getRole's body — a false positive. The criterion
    // must target the CALLER: this must be false.
    const modules = new Map<string, string>([
      [
        "lib/permissions.ts",
        'const ROLES: Record<string, "admin" | "editor" | "viewer"> = {\n' +
          '  u1: "admin",\n  u2: "editor"\n};\n\n' +
          'export function getRole(userId: string): "admin" | "editor" | "viewer" {\n' +
          "  const role = ROLES[userId];\n" +
          '  if (role === "admin" || role === "editor") return role;\n' +
          '  return "viewer";\n}\n\n' +
          "export function describeRole(userId: string): string {\n" +
          "  const role = getRole(userId);\n" +
          "  return role;\n}\n"
      ]
    ]);
    expect(
      evaluateT08TextCriteria(modules).callersTypecheckUnderNarrowType
    ).toBe(false);
  });

  it("BS15-C: identical booleans across file text and rendered store text", () => {
    const fileForm = correctModules();
    const inputs = [...fileForm.entries()].map(([rel, text]) => ({
      path: path.join(SRC_ROOT, rel),
      text
    }));
    const batch = ingestBatch(inputs);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const tx = begin(db, "test");
    queuePendingOp(tx, {
      kind: "ChangeReturnType",
      paramsJson: "{}",
      affectedNodeIdsJson: "[]",
      reasoning: null
    });
    commitWithoutValidate(db, tx);

    const substrate = evaluateT08Criteria(db, batch, SRC_ROOT, {
      commitReturnedOk: true,
      validateAfterCommitClean: true,
      txId: tx.id
    });
    expect({
      returnTypeIsLiteralUnion: substrate.returnTypeIsLiteralUnion,
      noAsStringCastOnResult: substrate.noAsStringCastOnResult,
      callersTypecheckUnderNarrowType: substrate.callersTypecheckUnderNarrowType
    }).toEqual(evaluateT08TextCriteria(fileForm));
    expect(substrate.operationRowAppended).toBe(true);
    db.close();
  });
});
