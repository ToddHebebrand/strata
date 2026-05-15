import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestBatch } from "../src/batch";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function loadFixtureModules(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        out.push({
          path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }

  walk(root);
  return out;
}

describe("ingestBatch", () => {
  it("resolves every `User` identifier in the fixture back to the declaration", () => {
    const root = path.resolve(currentDir, "fixtures/batch-rename");
    const modules = loadFixtureModules(root);
    const result = ingestBatch(modules);

    const userIdentifiers = result.allNodes.filter(
      (node) => node.kind === "Identifier" && JSON.parse(node.payload).text === "User"
    );
    expect(userIdentifiers.length).toBeGreaterThanOrEqual(6);

    const declarations = userIdentifiers.filter((identifier) => {
      const parent = result.allNodes.find((node) => node.id === identifier.parentId);
      return parent?.kind === "InterfaceDeclaration";
    });
    expect(declarations).toHaveLength(1);
    const declarationId = declarations[0]!.id;

    const referenceIdentifierIds = userIdentifiers
      .filter((identifier) => identifier.id !== declarationId)
      .map((identifier) => identifier.id);

    for (const referenceId of referenceIdentifierIds) {
      const reference = result.references.find((item) => item.fromNodeId === referenceId);
      expect(reference, `expected resolution for ${referenceId}`).toBeDefined();
      expect(reference!.toNodeId).toEqual(declarationId);
    }
  });

  it("resolves the JSDoc @param {User} identifier (BS1 probe)", () => {
    const root = path.resolve(currentDir, "fixtures/batch-rename");
    const modules = loadFixtureModules(root);
    const result = ingestBatch(modules);

    const userIdentifiers = result.allNodes.filter(
      (node) => node.kind === "Identifier" && JSON.parse(node.payload).text === "User"
    );

    // The single declaration occurrence: parented to the InterfaceDeclaration
    // in types/user.ts. A declaration has no outgoing self-reference by design.
    const declaration = userIdentifiers.find((identifier) => {
      const parent = result.allNodes.find((node) => node.id === identifier.parentId);
      return parent?.kind === "InterfaceDeclaration";
    });
    expect(declaration).toBeDefined();
    const declarationId = declaration!.id;

    // Every *reference-position* User identifier — import, JSDoc `@param {User}`,
    // value-position type annotation, `User[]` alias, and the type-only
    // re-export — must resolve to that one declaration. The JSDoc case is the
    // BS1 concern: it only reaches the resolver via getChildren traversal.
    const references = userIdentifiers.filter(
      (identifier) => identifier.id !== declarationId
    );
    expect(references.length).toBeGreaterThanOrEqual(5);

    for (const reference of references) {
      const resolved = result.references.find(
        (item) => item.fromNodeId === reference.id
      );
      const offset = JSON.parse(reference.payload).offset;
      expect(
        resolved,
        `User identifier at offset ${offset} (${reference.id}) did not resolve`
      ).toBeDefined();
      expect(resolved!.toNodeId).toEqual(declarationId);
    }

    // Belt-and-braces: at least one resolved reference lives inside a JSDoc
    // comment. consumer.ts's `@param {User}` sits in the FunctionDeclaration's
    // leading trivia, so a resolved User identifier under a FunctionDeclaration
    // whose offset precedes the `function` keyword is the JSDoc occurrence.
    const jsdocResolved = references.some((reference) => {
      const parent = result.allNodes.find((node) => node.id === reference.parentId);
      return (
        parent?.kind === "FunctionDeclaration" &&
        result.references.some((item) => item.fromNodeId === reference.id)
      );
    });
    expect(jsdocResolved, "no resolved User reference under a FunctionDeclaration").toBe(
      true
    );
  });
});
