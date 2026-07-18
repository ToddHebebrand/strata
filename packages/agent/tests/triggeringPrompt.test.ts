import {
  insertNodes,
  insertReferences,
  openDb,
  type Db
} from "@strata-code/store";
import { describe, expect, it } from "vitest";
import {
  createStrataTools,
  type StrataSessionContext
} from "../src/tools";

interface ToolDef {
  name: string;
  handler: (
    args: unknown,
    extra: unknown
  ) => Promise<{ content: { type: string; text?: string }[] }>;
}

function parseToolResult(result: {
  content: { type: string; text?: string }[];
}): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) return null;
  return JSON.parse(block.text);
}

function seed(db: Db): void {
  insertNodes(db, [
    {
      id: "mod",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/a.ts"
    },
    {
      id: "decl",
      kind: "InterfaceDeclaration",
      parentId: "mod",
      childIndex: 0,
      payload: "export interface User {}\n"
    },
    {
      id: "ident",
      kind: "Identifier",
      parentId: "decl",
      childIndex: null,
      payload: JSON.stringify({ text: "User", offset: 17 })
    }
  ]);
  insertReferences(db, []);
}

describe("begin_transaction threads ctx.taskPrompt into transactions row (L3.1)", () => {
  it("records the session's taskPrompt on the transactions row", async () => {
    const db = openDb(":memory:");
    try {
      seed(db);
      const ctx: StrataSessionContext = {
        db,
        actor: "test-agent",
        taskPrompt: "rename Foo to Bar"
      };
      const tools = createStrataTools(ctx) as unknown as ToolDef[];
      const beginTool = tools.find((t) => t.name === "begin_transaction");
      expect(beginTool).toBeDefined();
      const handle = parseToolResult(await beginTool!.handler({}, {})) as {
        id: string;
        actor: string;
      };
      expect(typeof handle.id).toBe("string");
      expect(handle.actor).toBe("test-agent");

      const row = db
        .prepare(
          "SELECT actor, triggering_prompt FROM transactions WHERE tx_id = ?"
        )
        .get(handle.id) as {
        actor: string;
        triggering_prompt: string | null;
      };
      expect(row.actor).toBe("test-agent");
      expect(row.triggering_prompt).toBe("rename Foo to Bar");
    } finally {
      db.close();
    }
  });

  it("stores NULL when no taskPrompt is bound to the session", async () => {
    const db = openDb(":memory:");
    try {
      seed(db);
      const ctx: StrataSessionContext = {
        db,
        actor: "test-agent"
      };
      const tools = createStrataTools(ctx) as unknown as ToolDef[];
      const beginTool = tools.find((t) => t.name === "begin_transaction")!;
      const handle = parseToolResult(await beginTool.handler({}, {})) as {
        id: string;
      };
      const row = db
        .prepare("SELECT triggering_prompt FROM transactions WHERE tx_id = ?")
        .get(handle.id) as { triggering_prompt: string | null };
      expect(row.triggering_prompt).toBeNull();
    } finally {
      db.close();
    }
  });
});
