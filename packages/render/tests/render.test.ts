import { describe, expect, it } from "vitest";
import { render } from "../src";
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
