import { describe, expect, it } from "vitest";
import { ingest } from "@strata-code/ingest";
import { renderWithSourceMap } from "@strata-code/render";
import { openDb } from "../src/schema";
import { insertNodes, loadModule } from "../src/nodes";
import { begin, getOverlay } from "../src/transactions";
import { change_return_type } from "../src/changeReturnType";

function declId(db: ReturnType<typeof openDb>, moduleId: string): string {
  const decl = loadModule(db, moduleId).children.find(
    (child) => child.kind === "FunctionDeclaration"
  );
  if (!decl) {
    throw new Error("no function declaration");
  }
  return decl.id;
}

const SRC =
  "export function getRole(userId: string): string {\n" +
  "  return 'admin';\n}\n";

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

describe("change_return_type", () => {
  it("replaces an existing return-type annotation", () => {
    const ingested = ingest(SRC, "perm.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    change_return_type(
      db,
      tx,
      declId(db, ingested.module.id),
      '"admin" | "editor" | "viewer"'
    );

    expect(render(db, ingested.module.id, tx)).toContain(
      'getRole(userId: string): "admin" | "editor" | "viewer"'
    );
    const ops = getOverlay(tx).pendingOps;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("ChangeReturnType");
    db.close();
  });

  it("inserts an annotation when none exists", () => {
    const ingested = ingest(
      "export function ping(a: number) {\n  return a;\n}\n",
      "p.ts"
    );
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    change_return_type(db, tx, declId(db, ingested.module.id), "number");

    expect(render(db, ingested.module.id, tx)).toContain(
      "ping(a: number): number {"
    );
    db.close();
  });

  it("is a no-op for an identical type (no edit, no op row)", () => {
    const ingested = ingest(SRC, "perm.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    change_return_type(db, tx, declId(db, ingested.module.id), "string");

    expect(getOverlay(tx).textSpanMutations.size).toBe(0);
    expect(getOverlay(tx).pendingOps).toHaveLength(0);
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

    expect(() => change_return_type(db, tx, interfaceDecl.id, "number")).toThrow(
      /FunctionDeclaration/
    );
    db.close();
  });

  it("rejects a syntactically invalid type", () => {
    const ingested = ingest(SRC, "perm.ts");
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const tx = begin(db, "t");

    expect(() =>
      change_return_type(db, tx, declId(db, ingested.module.id), "<<<")
    ).toThrow(/invalid type/i);
    db.close();
  });
});
