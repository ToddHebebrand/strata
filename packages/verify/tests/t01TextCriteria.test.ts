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
import { evaluateT01Criteria, evaluateT01TextCriteria } from "../src/index";

const SRC_ROOT = path.resolve("/corpus/src");

function correctModules(): Map<string, string> {
  return new Map<string, string>([
    [
      "lib/format.ts",
      'export function formatTimestamp(ts: number, timezone: string = "UTC"): string {\n' +
        "  return new Date(ts).toLocaleString(\"en-US\", {\n" +
        '    timeZone: timezone === "local" ? undefined : timezone\n' +
        "  });\n" +
        "}\n"
    ],
    [
      "server/events.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        "export function logEvent(at: number, kind: string): string {\n" +
        '  return `${kind} @ ${formatTimestamp(at, "UTC")}`;\n' +
        "}\n" +
        "export function eventLine(at: number): string {\n" +
        '  return formatTimestamp(at, "UTC");\n' +
        "}\n"
    ],
    [
      "ui/timeline.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        "export function timelineRows(times: number[]): string[] {\n" +
        "  return times.map(formatTimestamp);\n" +
        "}\n" +
        "export function firstRow(times: number[]): string {\n" +
        '  return timelineRows(times)[0] ?? formatTimestamp(0, "local");\n' +
        "}\n"
    ]
  ]);
}

describe("evaluateT01TextCriteria", () => {
  it("all text criteria true for a correct add_parameter result", () => {
    const criteria = evaluateT01TextCriteria(correctModules());
    for (const [key, value] of Object.entries(criteria)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
  });

  it("fails when the new parameter is missing from the signature", () => {
    const modules = correctModules();
    modules.set(
      "lib/format.ts",
      "export function formatTimestamp(ts: number): string {\n" +
        "  return new Date(ts).toISOString();\n" +
        "}\n"
    );
    expect(evaluateT01TextCriteria(modules).signatureHasTimezone).toBe(false);
  });

  it("fails when a server callsite did not pass UTC", () => {
    const modules = correctModules();
    modules.set(
      "server/events.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        "export function logEvent(at: number, kind: string): string {\n" +
        "  return `${kind} @ ${formatTimestamp(at)}`;\n" +
        "}\n" +
        "export function eventLine(at: number): string {\n" +
        "  return formatTimestamp(at);\n" +
        "}\n"
    );
    expect(evaluateT01TextCriteria(modules).serverCallsitesUtc).toBe(false);
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
      kind: "AddParameter",
      paramsJson: "{}",
      affectedNodeIdsJson: "[]",
      reasoning: null
    });
    commitWithoutValidate(db, tx);

    const substrate = evaluateT01Criteria(db, batch, SRC_ROOT, {
      commitReturnedOk: true,
      validateAfterCommitClean: true,
      txId: tx.id
    });
    expect({
      signatureHasTimezone: substrate.signatureHasTimezone,
      defaultIsUtcString: substrate.defaultIsUtcString,
      serverCallsitesUtc: substrate.serverCallsitesUtc,
      uiCallsitesLocalOrDefault: substrate.uiCallsitesLocalOrDefault,
      hofCallsiteNotMisedited: substrate.hofCallsiteNotMisedited
    }).toEqual(evaluateT01TextCriteria(fileForm));
    expect(substrate.operationRowAppended).toBe(true);
    db.close();
  });
});
