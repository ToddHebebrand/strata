import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata-code/ingest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import { insertReferences } from "../src/references";
import { find_declarations } from "../src/queries";
import { resolveCallsites } from "../src/callsites";

const FORMAT =
  "export function formatTimestamp(ts: number): string {\n" +
  "  return new Date(ts).toISOString();\n}\n";
const SERVER =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function logEvent(t: number): string {\n" +
  "  return formatTimestamp(t);\n}\n" +
  "export function banner(t: number): string {\n" +
  "  return `at ${formatTimestamp(t)}`;\n}\n";
const UI =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function rows(times: number[]): string[] {\n" +
  "  return times.map(formatTimestamp);\n}\n" +
  "export function aliased(t: number): string {\n" +
  "  const f = formatTimestamp;\n" +
  "  return f(t);\n}\n";

describe("resolveCallsites (BS15-B probe)", () => {
  it("resolves direct + template-literal callsites and classifies HOF/aliased as non-argument sites", () => {
    const batch = ingestBatch([
      { path: "format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER },
      { path: "ui.ts", text: UI }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const decl = find_declarations(db, {
      name: "formatTimestamp",
      kind: "function"
    })[0];
    expect(decl).toBeDefined();

    const result = resolveCallsites(db, decl!.id);

    expect(result.callsites).toHaveLength(2);
    expect(result.nonCallReferences).toHaveLength(2);
    expect(result.unresolvedReferences).toHaveLength(0);
    expect(result.counts).toEqual({
      resolvedDirectCallsites: 2,
      arityRiskReferences: 2,
      unresolvedReferences: 0
    });

    for (const callsite of result.callsites) {
      expect(callsite.argListInsertOffset).toBeGreaterThan(0);
      expect(callsite.existingArgCount).toBe(1);
      expect(typeof callsite.statementId).toBe("string");
    }

    expect(result.nonCallReferences.map((ref) => ref.shape).sort()).toEqual([
      "aliased-value",
      "higher-order-value"
    ]);
    db.close();
  });

  it("returns zero callsites for a function with no references (declaration-only)", () => {
    const batch = ingestBatch([{ path: "f.ts", text: FORMAT }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const decl = find_declarations(db, {
      name: "formatTimestamp",
      kind: "function"
    })[0]!;

    const result = resolveCallsites(db, decl.id);

    expect(result.callsites).toHaveLength(0);
    expect(result.nonCallReferences).toHaveLength(0);
    expect(result.unresolvedReferences).toHaveLength(0);
    expect(result.counts).toEqual({
      resolvedDirectCallsites: 0,
      arityRiskReferences: 0,
      unresolvedReferences: 0
    });
    db.close();
  });
});
