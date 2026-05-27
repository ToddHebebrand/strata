import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences, openDb } from "@strata/store";
import { describe, expect, it } from "vitest";
import {
  createStrataTools,
  diagnosticSchema,
  nodeIdSchema,
  txHandleSchema,
  type StrataSessionContext
} from "../src/tools";

describe("strata tool schema fragments", () => {
  it("txHandleSchema parses a valid handle", () => {
    const parsed = txHandleSchema.parse({ id: "tx-1", actor: "agent-t03" });
    expect(parsed).toEqual({ id: "tx-1", actor: "agent-t03" });
  });

  it("txHandleSchema rejects an empty id", () => {
    expect(() => txHandleSchema.parse({ id: "", actor: "a" })).toThrow();
  });

  it("nodeIdSchema rejects empty string", () => {
    expect(() => nodeIdSchema.parse("")).toThrow();
  });

  it("diagnosticSchema parses a diagnostic with null nodeId", () => {
    const d = diagnosticSchema.parse({
      nodeId: null,
      modulePath: null,
      message: "x",
      code: 2304
    });
    expect(d.code).toBe(2304);
  });
});

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(rootDir);
  return out;
}

function parseText(result: { content: { type: string; text?: string }[] }) {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a single text content block");
  }
  return JSON.parse(block.text) as unknown;
}

describe("strata tools drive the spine through the shared context", () => {
  it("explore -> begin -> rename -> validate -> commit threads a TxHandle", async () => {
    const srcRoot = path.resolve(__dirname, "../../../examples/medium/src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    try {
      const ctx: StrataSessionContext = { db, actor: "tools-test" };
      const tools = createStrataTools(ctx);
      const byName = new Map(tools.map((t) => [t.name, t]));

      const decls = parseText(
        await byName.get("find_declarations")!.handler(
          { name: "User", kind: "interface" },
          {}
        )
      ) as { id: string }[];
      expect(decls.length).toBe(1);
      const declId = decls[0]!.id;

      const tx = parseText(
        await byName.get("begin_transaction")!.handler({}, {})
      );
      expect(tx).toMatchObject({ actor: "tools-test" });

      const renameResult = parseText(
        await byName.get("rename_symbol")!.handler(
          { tx, declaration_id: declId, new_name: "Account" },
          {}
        )
      );
      expect(renameResult).toEqual({ ok: true });

      const diags = parseText(
        await byName.get("validate")!.handler({ tx }, {})
      );
      expect(diags).toEqual([]);

      const commitResult = parseText(
        await byName.get("commit_transaction")!.handler({ tx }, {})
      );
      expect(commitResult).toEqual({ ok: true });
    } finally {
      db.close();
    }
  });

  it("add_parameter result carries the manifest, not a bare ok", async () => {
    const batch = ingestBatch([
      {
        path: "lib/format.ts",
        text:
          "export function formatTimestamp(ts: number): string {\n" +
          "  return new Date(ts).toISOString();\n" +
          "}\n"
      },
      {
        path: "server.ts",
        text:
          'import { formatTimestamp } from "./lib/format.ts";\n' +
          "export function logEvent(t: number): string {\n" +
          "  return formatTimestamp(t);\n" +
          "}\n"
      }
    ]);
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const tools = createStrataTools({ db, actor: "x" });
      const byName = new Map(tools.map((t) => [t.name, t]));

      const begun = parseText(
        await byName.get("begin_transaction")!.handler({}, {})
      ) as {
        id: string;
        actor: string;
      };
      const decls = parseText(
        await byName.get("find_declarations")!.handler(
          { name: "formatTimestamp", kind: "function" },
          {}
        )
      ) as { id: string }[];
      const result = parseText(
        await byName.get("add_parameter")!.handler(
          {
            tx: begun,
            function_id: decls[0]!.id,
            name: "timezone",
            type: "string",
            position: 1,
            default: '"UTC"'
          },
          {}
        )
      ) as {
        ok: boolean;
        declaration: { afterSignature: string };
        callsitesRewritten: { modulePath: string; after: string }[];
        arityRiskSites: unknown[];
      };

      expect(result.ok).toBe(true);
      expect(result.declaration.afterSignature).toContain(
        'timezone: string = "UTC"'
      );
      expect(result.callsitesRewritten[0]!.modulePath).toBe("server.ts");
      expect(result.callsitesRewritten[0]!.after).toContain(
        'formatTimestamp(t, "UTC")'
      );
      expect(result.arityRiskSites).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("exposes exactly the sixteen tool names", () => {
    const db = openDb(":memory:");
    try {
      const tools = createStrataTools({ db, actor: "x" });
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "add_import",
          "add_parameter",
          "begin_transaction",
          "change_return_type",
          "commit_transaction",
          "create_function",
          "find_declarations",
          "find_declarations_in_module",
          "get_references",
          "list_module_exports",
          "read_node",
          "read_test_file",
          "rename_symbol",
          "replace_body",
          "rollback_transaction",
          "validate"
        ].sort()
      );
    } finally {
      db.close();
    }
  });
});
