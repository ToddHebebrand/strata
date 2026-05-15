import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { emitIdentifiers } from "../src/identifiers";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDir, "fixtures/identifiers.ts");
const fixtureText = readFileSync(fixturePath, "utf8");

function parse(): ts.SourceFile {
  return ts.createSourceFile(
    "fixtures/identifiers.ts",
    fixtureText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

describe("emitIdentifiers", () => {
  it("emits one Identifier node per identifier occurrence inside a statement", () => {
    const sourceFile = parse();
    const interfaceStatement = sourceFile.statements[0];
    if (!interfaceStatement) {
      throw new Error("fixture missing first statement");
    }

    const stmtPayload = interfaceStatement.getFullText(sourceFile);
    const ids = emitIdentifiers(
      sourceFile,
      interfaceStatement,
      "fixtures/identifiers.ts",
      [0]
    );

    const texts = ids.map((node) => JSON.parse(node.payload).text);
    expect(texts).toContain("User");
    expect(texts).toContain("id");

    for (const node of ids) {
      const { text, offset } = JSON.parse(node.payload);
      expect(stmtPayload.slice(offset, offset + text.length)).toEqual(text);
    }
  });

  it("emits identifiers for function declaration with parameter type and JSDoc", () => {
    const sourceFile = parse();
    const fnStatement = sourceFile.statements[1];
    if (!fnStatement) {
      throw new Error("fixture missing second statement");
    }

    const ids = emitIdentifiers(sourceFile, fnStatement, "fixtures/identifiers.ts", [1]);

    const texts = ids.map((node) => JSON.parse(node.payload).text);
    expect(texts).toContain("greet");
    expect(texts).toContain("user");
    expect(texts).toContain("User");
  });
});
