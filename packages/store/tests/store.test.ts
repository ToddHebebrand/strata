import { describe, expect, it } from "vitest";
import { insertNodes, listModules, loadModule, openDb, type NodeRow } from "../src";

describe("store", () => {
  it("round-trips nodes through sqlite", () => {
    const db = openDb(":memory:");
    const nodes: NodeRow[] = [
      {
        id: "module-1",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "example.ts"
      },
      {
        id: "stmt-1",
        kind: "VariableStatement",
        parentId: "module-1",
        childIndex: 0,
        payload: "const value = 1;\n"
      },
      {
        id: "stmt-2",
        kind: "FunctionDeclaration",
        parentId: "module-1",
        childIndex: 1,
        payload: "export function read(): number { return value; }\n"
      }
    ];

    insertNodes(db, nodes);

    expect(listModules(db)).toEqual([nodes[0]]);
    expect(loadModule(db, "module-1")).toEqual({
      module: nodes[0],
      children: [nodes[1], nodes[2]]
    });
  });
});
