import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../../render/src";
import { describe, expect, it } from "vitest";
import { ingest } from "../src";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

describe("ingest", () => {
  it("creates one module plus one child per top-level statement and EOF trivia", () => {
    const source = [
      "import { readFile } from 'node:fs/promises';",
      "",
      "interface User {",
      "  id: string;",
      "}",
      "",
      "export function getId(user: User): string {",
      "  return user.id;",
      "}",
      ""
    ].join("\n");

    const result = ingest(source, "sample.ts");
    const renderableChildren = result.children.filter((node) => node.kind !== "Identifier");

    expect(result.module.kind).toBe("Module");
    expect(result.module.parentId).toBeNull();
    expect(renderableChildren).toHaveLength(4);
    expect(renderableChildren.map((node) => node.kind)).toEqual([
      "ImportDeclaration",
      "InterfaceDeclaration",
      "FunctionDeclaration",
      "EndOfFileTrivia"
    ]);
    expect(renderableChildren.every((node) => node.parentId === result.module.id)).toBe(true);
    expect(result.children.some((node) => node.kind === "Identifier")).toBe(true);
  });

  it("preserves file-leading, statement, and EOF comments through render", () => {
    const fixturePath = path.join(currentDir, "fixtures", "with-comments.ts");
    const source = readFileSync(fixturePath, "utf8");
    const result = ingest(source, fixturePath);

    expect(render(result.module, result.children)).toBe(source);
  });
});
