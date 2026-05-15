import { describe, expect, it } from "vitest";
import { ingest } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";
import { openDb } from "../src/schema";
import { insertNodes, loadModule } from "../src/nodes";
import { begin, getOverlay } from "../src/transactions";
import { replace_body } from "../src/replaceBody";

const SRC =
  "export function isWithinRange(d: Date, s: Date, e: Date): boolean {\n" +
  "  return d >= s && d <= e;\n}\n";

function declId(db: ReturnType<typeof openDb>, moduleId: string): string {
  const decl = loadModule(db, moduleId).children.find(
    (child) => child.kind === "FunctionDeclaration"
  )!;
  return decl.id;
}

function render(
  db: ReturnType<typeof openDb>,
  moduleId: string,
  tx: ReturnType<typeof begin>
): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children, {
    identifierMutations: getOverlay(tx).identifierMutations,
    textSpanMutations: getOverlay(tx).textSpanMutations
  }).text;
}

describe("replace_body", () => {
  it("replaces the body block including braces", () => {
    const ingested = ingest(SRC, "dr.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    replace_body(
      db,
      tx,
      declId(db, ingested.module.id),
      "{\n  return d >= s && d < e;\n}"
    );

    const out = render(db, ingested.module.id, tx);
    expect(out).toContain("return d >= s && d < e;");
    expect(out).not.toContain("d <= e");
    const ops = getOverlay(tx).pendingOps;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("ReplaceBody");
    db.close();
  });

  it("is a no-op for an identical body (no edit, no op row)", () => {
    const ingested = ingest(SRC, "dr.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    replace_body(
      db,
      tx,
      declId(db, ingested.module.id),
      "{\n  return d >= s && d <= e;\n}"
    );

    expect(getOverlay(tx).textSpanMutations.size).toBe(0);
    expect(getOverlay(tx).pendingOps).toHaveLength(0);
    db.close();
  });

  it("rejects a syntactically invalid body", () => {
    const ingested = ingest(SRC, "dr.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    expect(() =>
      replace_body(db, tx, declId(db, ingested.module.id), "{ return (((; }")
    ).toThrow(/invalid body/i);
    db.close();
  });

  it("rejects a body that is not a brace block", () => {
    const ingested = ingest(SRC, "dr.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    expect(() =>
      replace_body(db, tx, declId(db, ingested.module.id), "return 1;")
    ).toThrow(/invalid body|block/i);
    db.close();
  });

  it("throws when the node is not a FunctionDeclaration", () => {
    const ingested = ingest("export interface X { value: number }\n", "x.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");
    const interfaceDecl = loadModule(db, ingested.module.id).children.find(
      (child) => child.kind === "InterfaceDeclaration"
    )!;

    expect(() =>
      replace_body(db, tx, interfaceDecl.id, "{ return 1; }")
    ).toThrow(/FunctionDeclaration/);
    db.close();
  });
});
