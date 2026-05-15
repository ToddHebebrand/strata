import { describe, expect, it } from "vitest";
import { render, renderWithSourceMap } from "../src";
import type { NodeRow } from "@strata/store";

describe("render", () => {
  it("concatenates child payloads in child_index order", () => {
    const module: NodeRow = {
      id: "module-1",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "sample.ts"
    };

    const children: NodeRow[] = [
      {
        id: "stmt-2",
        kind: "FunctionDeclaration",
        parentId: "module-1",
        childIndex: 1,
        payload: "\nexport function value(): number { return answer; }\n"
      },
      {
        id: "stmt-1",
        kind: "VariableStatement",
        parentId: "module-1",
        childIndex: 0,
        payload: "const answer = 42;\n"
      }
    ];

    expect(render(module, children)).toBe(
      "const answer = 42;\n\nexport function value(): number { return answer; }\n"
    );
  });

  it("ignores non-renderable identifier children", () => {
    const module: NodeRow = {
      id: "module-1",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "sample.ts"
    };

    const children: NodeRow[] = [
      {
        id: "stmt-1",
        kind: "InterfaceDeclaration",
        parentId: "module-1",
        childIndex: 0,
        payload: "interface User {}\n"
      },
      {
        id: "id-1",
        kind: "Identifier",
        parentId: "stmt-1",
        childIndex: null,
        payload: JSON.stringify({ text: "User", offset: 10 })
      }
    ];

    expect(render(module, children)).toBe("interface User {}\n");
  });
});

describe("renderWithSourceMap", () => {
  const moduleNode: NodeRow = {
    id: "m",
    kind: "Module",
    parentId: null,
    childIndex: null,
    payload: "x.ts"
  };
  const stmt: NodeRow = {
    id: "s1",
    kind: "InterfaceDeclaration",
    parentId: "m",
    childIndex: 0,
    payload: "export interface User {}\n"
  };
  const userIdentifier: NodeRow = {
    id: "i1",
    kind: "Identifier",
    parentId: "s1",
    childIndex: null,
    payload: JSON.stringify({ text: "User", offset: 17 })
  };
  const eof: NodeRow = {
    id: "e1",
    kind: "EndOfFileTrivia",
    parentId: "m",
    childIndex: 1,
    payload: ""
  };

  it("returns canonical text with source map entries for renderable nodes", () => {
    const { text, sourceMap } = renderWithSourceMap(moduleNode, [
      stmt,
      userIdentifier,
      eof
    ]);

    expect(text).toEqual("export interface User {}\n");
    expect(sourceMap).toEqual([
      { renderedStart: 0, renderedEnd: 25, nodeId: "s1" },
      { renderedStart: 25, renderedEnd: 25, nodeId: "e1" }
    ]);
  });

  it("applies identifier-text mutations from the overlay before rendering", () => {
    const { text } = renderWithSourceMap(
      moduleNode,
      [stmt, userIdentifier, eof],
      {
        identifierMutations: new Map([["i1", { text: "Account" }]])
      }
    );

    expect(text).toEqual("export interface Account {}\n");
  });
});
