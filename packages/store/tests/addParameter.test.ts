import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata-code/ingest";
import { renderWithSourceMap } from "@strata-code/render";
import { insertNodes, loadModule } from "../src/nodes";
import { find_declarations } from "../src/queries";
import { insertReferences } from "../src/references";
import { openDb } from "../src/schema";
import { add_parameter } from "../src/addParameter";
import { begin, getOverlay } from "../src/transactions";

const FORMAT =
  "export function formatTimestamp(ts: number, includeMs: boolean): string {\n" +
  "  return new Date(ts).toISOString() + String(includeMs);\n" +
  "}\n";
const SERVER =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function logEvent(t: number): string {\n" +
  "  return formatTimestamp(t, true);\n" +
  "}\n" +
  "export function banner(t: number): string {\n" +
  "  return `at ${formatTimestamp(t, false)}`;\n" +
  "}\n";
const UI =
  'import { formatTimestamp } from "./format.ts";\n' +
  "export function rows(times: number[]): string[] {\n" +
  "  return times.map(formatTimestamp);\n" +
  "}\n" +
  "export function aliased(t: number): string {\n" +
  "  const f = formatTimestamp;\n" +
  "  return f(t, true);\n" +
  "}\n";

function renderAll(
  db: ReturnType<typeof openDb>,
  modules: { path: string; moduleId: string }[],
  tx: ReturnType<typeof begin>
): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const module of modules) {
    const loaded = loadModule(db, module.moduleId);
    rendered.set(
      module.path,
      renderWithSourceMap(loaded.module, loaded.children, {
        identifierMutations: getOverlay(tx).identifierMutations,
        textSpanMutations: getOverlay(tx).textSpanMutations
      }).text
    );
  }
  return rendered;
}

function setup(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const decl = find_declarations(db, {
    name: "formatTimestamp",
    kind: "function"
  })[0];
  if (!decl) {
    throw new Error("missing formatTimestamp declaration");
  }
  return { batch, db, decl };
}

describe("add_parameter", () => {
  it("adds the parameter to the declaration and each direct callsite at the requested position", () => {
    const { batch, db, decl } = setup([
      { path: "format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER }
    ]);
    const tx = begin(db, "t");

    add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    const rendered = renderAll(db, batch.modules, tx);
    expect(rendered.get("format.ts")).toContain(
      'formatTimestamp(ts: number, timezone: string = "UTC", includeMs: boolean)'
    );
    expect(rendered.get("server.ts")).toContain(
      'formatTimestamp(t, "UTC", true)'
    );
    expect(rendered.get("server.ts")).toContain(
      'formatTimestamp(t, "UTC", false)'
    );

    const ops = getOverlay(tx).pendingOps;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("AddParameter");
    const affected = JSON.parse(ops[0]!.affectedNodeIdsJson) as string[];
    expect(affected).toHaveLength(3);
    db.close();
  });

  it("leaves HOF and aliased arity-risk references untouched instead of mis-editing them", () => {
    const { batch, db, decl } = setup([
      { path: "format.ts", text: FORMAT },
      { path: "server.ts", text: SERVER },
      { path: "ui.ts", text: UI }
    ]);
    const tx = begin(db, "t");

    add_parameter(db, tx, decl.id, "timezone", "string", 1, '"UTC"');

    const rendered = renderAll(db, batch.modules, tx);
    expect(rendered.get("ui.ts")).toContain("times.map(formatTimestamp)");
    expect(rendered.get("ui.ts")).toContain("const f = formatTimestamp;");
    expect(rendered.get("ui.ts")).toContain("return f(t, true);");
    expect(rendered.get("ui.ts")).not.toContain('map(formatTimestamp, "UTC")');
    expect(rendered.get("ui.ts")).not.toContain('const f = "UTC"');
    db.close();
  });

  it("supports declaration-only edits when there are zero callsites", () => {
    const { batch, db, decl } = setup([{ path: "format.ts", text: FORMAT }]);
    const tx = begin(db, "t");

    add_parameter(db, tx, decl.id, "timezone", "string", 2);

    const rendered = renderAll(db, batch.modules, tx);
    expect(rendered.get("format.ts")).toContain(
      "ts: number, includeMs: boolean, timezone: string"
    );
    expect(getOverlay(tx).pendingOps).toHaveLength(1);
    db.close();
  });

  it("throws on invalid inputs", () => {
    const { db, decl } = setup([{ path: "format.ts", text: FORMAT }]);
    const tx = begin(db, "t");

    expect(() =>
      add_parameter(db, tx, decl.id, "1bad", "string", 1)
    ).toThrow(/identifier/i);
    expect(() =>
      add_parameter(db, tx, decl.id, "tz", "<<<", 1)
    ).toThrow(/type/i);
    expect(() =>
      add_parameter(db, tx, decl.id, "tz", "string", 1, "}")
    ).toThrow(/default/i);
    db.close();
  });

  it("throws when the target node is not a FunctionDeclaration", () => {
    const batch = ingestBatch([{ path: "types.ts", text: "export interface X {}\n" }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const iface = find_declarations(db, {
      name: "X",
      kind: "interface"
    })[0]!;
    const tx = begin(db, "t");

    expect(() => add_parameter(db, tx, iface.id, "tz", "string", 0)).toThrow(
      /FunctionDeclaration/
    );
    db.close();
  });
});
