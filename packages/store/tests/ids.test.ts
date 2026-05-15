import { describe, expect, it } from "vitest";
import { nodeId } from "../src/ids";

describe("nodeId", () => {
  it("is deterministic across calls with the same inputs", () => {
    const a = nodeId("src/types/user.ts", [], "Module");
    const b = nodeId("src/types/user.ts", [], "Module");
    expect(a).toEqual(b);
  });

  it("differs when modulePath differs", () => {
    expect(nodeId("a.ts", [0], "Identifier")).not.toEqual(
      nodeId("b.ts", [0], "Identifier")
    );
  });

  it("differs when child path differs", () => {
    expect(nodeId("a.ts", [0, 1], "Identifier")).not.toEqual(
      nodeId("a.ts", [0, 2], "Identifier")
    );
  });

  it("differs when kind differs", () => {
    expect(nodeId("a.ts", [0], "Identifier")).not.toEqual(
      nodeId("a.ts", [0], "InterfaceDeclaration")
    );
  });

  it("is a 16-hex string", () => {
    expect(nodeId("a.ts", [0], "Identifier")).toMatch(/^[0-9a-f]{16}$/);
  });
});
