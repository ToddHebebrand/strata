/**
 * Unit tests for resolveDeclarationNameIdentifier.
 *
 * These tests exercise the helper directly against a known-shape DB,
 * independently of find_declarations. The integration-level JSDoc test is in
 * jsdocDeclarations.test.ts.
 */

import { describe, expect, it } from "vitest";
import { ingest } from "@strata/ingest";
import { insertNodes } from "../src/nodes";
import { openDb } from "../src/schema";
import { resolveDeclarationNameIdentifier } from "../src/declarationName";
import { find_declarations } from "../src/queries";

function seedFromSource(path: string, text: string) {
  const result = ingest(text, path);
  const db = openDb(":memory:");
  insertNodes(db, [result.module, ...result.children]);
  return { db, result };
}

describe("resolveDeclarationNameIdentifier", () => {
  it("returns undefined for an unknown declaration id", () => {
    const db = openDb(":memory:");
    expect(resolveDeclarationNameIdentifier(db, "nonexistent")).toBeUndefined();
    db.close();
  });

  it("resolves a plain FunctionDeclaration (no JSDoc)", () => {
    const { db } = seedFromSource(
      "fn.ts",
      "export function greet(name: string): string {\n  return name;\n}\n"
    );
    const decls = find_declarations(db, { name: "greet", kind: "function" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("greet");
    db.close();
  });

  it("resolves a JSDoc'd FunctionDeclaration (the core bug case)", () => {
    const src =
      "/**\n * @param {string} value\n */\n" +
      "export function parse(value: string): string {\n  return value;\n}\n";
    const { db } = seedFromSource("parser.ts", src);
    const decls = find_declarations(db, { kind: "function" });
    const parseDecl = decls.find((d) => {
      const r = resolveDeclarationNameIdentifier(db, d.id);
      if (!r) return false;
      const p = JSON.parse(r.payload) as { text: string };
      return p.text === "parse";
    });
    expect(parseDecl).toBeDefined();

    const nameIdent = resolveDeclarationNameIdentifier(db, parseDecl!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("parse");
    db.close();
  });

  it("resolves an InterfaceDeclaration", () => {
    const { db } = seedFromSource("types.ts", "export interface User { id: string; }\n");
    const decls = find_declarations(db, { name: "User", kind: "interface" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("User");
    db.close();
  });

  it("resolves a TypeAliasDeclaration", () => {
    const { db } = seedFromSource("types.ts", "export type Id = string;\n");
    const decls = find_declarations(db, { name: "Id", kind: "type-alias" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("Id");
    db.close();
  });

  it("resolves a VariableStatement (export const) — FirstStatement kind", () => {
    const { db } = seedFromSource(
      "config.ts",
      'export const DEFAULT_TIMEOUT = 5000;\n'
    );
    // Use no-kind filter since kind is "variable" / FirstStatement
    const decls = find_declarations(db, { name: "DEFAULT_TIMEOUT", kind: "variable" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("DEFAULT_TIMEOUT");
    db.close();
  });

  it("resolves a JSDoc'd InterfaceDeclaration", () => {
    const src =
      "/** A user record. */\nexport interface User {\n  id: string;\n}\n";
    const { db } = seedFromSource("types.ts", src);
    const decls = find_declarations(db, { kind: "interface" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("User");
    db.close();
  });

  it("resolves a multi-tag JSDoc'd function", () => {
    const src =
      "/**\n * @param a first arg\n * @param b second arg\n * @returns sum\n */\n" +
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const { db } = seedFromSource("math.ts", src);
    const decls = find_declarations(db, { kind: "function" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("add");
    db.close();
  });

  it("resolves a JSDoc'd ClassDeclaration with @typeParam", () => {
    const src =
      "/**\n * @typeParam T - element type\n */\n" +
      "export class Box<T> {\n  constructor(public value: T) {}\n}\n";
    const { db } = seedFromSource("box.ts", src);
    const decls = find_declarations(db, { name: "Box", kind: "class" });
    expect(decls).toHaveLength(1);
    const nameIdent = resolveDeclarationNameIdentifier(db, decls[0]!.id);
    expect(nameIdent).toBeDefined();
    const parsed = JSON.parse(nameIdent!.payload) as { text: string };
    expect(parsed.text).toBe("Box");
    db.close();
  });

  it("returns undefined for a destructured-const VariableStatement", () => {
    const src = "export const { a, b } = { a: 1, b: 2 };\n";
    const { db } = seedFromSource("destructured.ts", src);
    const decls = find_declarations(db, { kind: "variable" });
    expect(decls).toHaveLength(1);
    expect(resolveDeclarationNameIdentifier(db, decls[0]!.id)).toBeUndefined();
    db.close();
  });
});
