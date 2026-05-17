import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, findNodeById } from "../src/nodes";
import { find_declarations } from "../src/queries";
import { insertReferences } from "../src/references";
import { openDb } from "../src/schema";
import { add_parameter } from "../src/addParameter";
import { begin, getOverlay } from "../src/transactions";

const FORMAT =
  "export function formatTimestamp(ts: number): string {\n" +
  "  return new Date(ts).toISOString();\n" +
  "}\n";
const SERVER =
  'import { formatTimestamp } from "./lib/format.ts";\n' +
  "export function logEvent(t: number): string {\n" +
  "  return formatTimestamp(t);\n" +
  "}\n";
const UI =
  'import { formatTimestamp } from "./lib/format.ts";\n' +
  "export function rows(times: number[]): string[] {\n" +
  "  return times.map(formatTimestamp);\n" +
  "}\n" +
  "export function aliased(t: number): string {\n" +
  "  const f = formatTimestamp;\n" +
  "  return f(t);\n" +
  "}\n";

function setup(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const decl = find_declarations(db, {
    name: "formatTimestamp",
    kind: "function"
  })[0]!;
  return { db, decl };
}

describe("add_parameter manifest", () => {
  it("reports the declaration signature before/after and each rewritten callsite", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    expect(m.declaration.id).toBe(decl.id);
    expect(m.declaration.beforeSignature).toContain(
      "formatTimestamp(ts: number): string"
    );
    expect(m.declaration.beforeSignature).not.toContain("toISOString");
    expect(m.declaration.afterSignature).toContain(
      'formatTimestamp(ts: number, timezone: string = "UTC"): string'
    );

    expect(m.callsitesRewritten).toHaveLength(1);
    const cs = m.callsitesRewritten[0]!;
    expect(cs.modulePath).toBe("server.ts");
    expect(cs.before).toContain("formatTimestamp(t)");
    expect(cs.after).toContain('formatTimestamp(t, "UTC")');
    db.close();
  });

  it("reports non-direct references as arity-risk sites, not rewrites", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "ui.ts", text: UI }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    expect(m.callsitesRewritten).toHaveLength(0);
    const reasons = m.arityRiskSites.map((s) => s.reason).sort();
    expect(reasons).toEqual(["aliased-value", "higher-order-value"]);
    for (const s of m.arityRiskSites) {
      expect(s.modulePath).toBe("ui.ts");
    }
    db.close();
  });

  it("zero callsites -> empty callsitesRewritten (nothing to hand-patch)", () => {
    const { db, decl } = setup([{ path: "lib/format.ts", text: FORMAT }]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');
    expect(m.callsitesRewritten).toEqual([]);
    expect(m.arityRiskSites).toEqual([]);
    db.close();
  });

  it("FAITHFULNESS: manifest exactly mirrors the queued overlay edits", () => {
    const { db, decl } = setup([
      { path: "lib/format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER }
    ]);
    const tx = begin(db, "t");
    const m = add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');
    const overlay = getOverlay(tx).textSpanMutations;

    const declEdits = overlay.get(decl.id)!;
    expect(declEdits).toHaveLength(1);
    const de = declEdits[0]!;
    const sig = m.declaration.beforeSignature;
    expect(m.declaration.afterSignature).toBe(
      sig.slice(0, de.start) + de.newText + sig.slice(de.end)
    );

    for (const cs of m.callsitesRewritten) {
      expect(cs.statementId).not.toBe(decl.id);
      const edits = overlay.get(cs.statementId)!;
      expect(edits).toHaveLength(1);
      const e = edits[0]!;
      const payload = findNodeById(db, cs.statementId)!.payload;
      expect(cs.before).toBe(payload);
      expect(cs.after).toBe(
        payload.slice(0, e.start) + e.newText + payload.slice(e.end)
      );
    }

    const manifestStmtIds = new Set(
      m.callsitesRewritten.map((c) => c.statementId)
    );
    for (const stmtId of overlay.keys()) {
      if (stmtId === decl.id) continue;
      expect(manifestStmtIds.has(stmtId)).toBe(true);
    }
    db.close();
  });
});
