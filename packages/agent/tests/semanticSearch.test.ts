import {
  embedDeclarations,
  EMBEDDING_DIM,
  insertNodes,
  insertReferences,
  isVecAvailable,
  openDb,
  type EmbeddingProvider
} from "@strata/store";
import { describe, expect, it } from "vitest";
import { createStrataTools } from "../src/tools";

/**
 * Deterministic mock provider. Each input gets a vector with a distinctive
 * peak at a position determined by a token in the text. Two inputs that share
 * the same token end up close in space.
 */
class TokenPeakProvider implements EmbeddingProvider {
  readonly model = "mock-peak-v1";
  readonly dim = EMBEDDING_DIM;
  constructor(private readonly tokens: { token: string; slot: number }[]) {}
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const { token, slot } of this.tokens) {
        if (t.includes(token)) v[slot] = 1.0;
      }
      return v;
    });
  }
}

function seedThreeDecls() {
  const db = openDb(":memory:");
  insertNodes(db, [
    {
      id: "m",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/util.ts"
    },
    {
      id: "f-plain",
      kind: "FunctionDeclaration",
      parentId: "m",
      childIndex: 0,
      payload: "export function isPlainObject(x: unknown): boolean { return Object.prototype.toString.call(x) === '[object Object]'; }\n"
    },
    {
      id: "f-plain-id",
      kind: "Identifier",
      parentId: "f-plain",
      childIndex: null,
      payload: JSON.stringify({ text: "isPlainObject", offset: 16 })
    },
    {
      id: "f-add",
      kind: "FunctionDeclaration",
      parentId: "m",
      childIndex: 1,
      payload: "export function add(a: number, b: number): number { return a + b; }\n"
    },
    {
      id: "f-add-id",
      kind: "Identifier",
      parentId: "f-add",
      childIndex: null,
      payload: JSON.stringify({ text: "add", offset: 16 })
    },
    {
      id: "f-format",
      kind: "FunctionDeclaration",
      parentId: "m",
      childIndex: 2,
      payload: "export function formatTimestamp(ts: number): string { return new Date(ts).toISOString(); }\n"
    },
    {
      id: "f-format-id",
      kind: "Identifier",
      parentId: "f-format",
      childIndex: null,
      payload: JSON.stringify({ text: "formatTimestamp", offset: 16 })
    }
  ]);
  insertReferences(db, []);
  return db;
}

describe("semantic_search agent tool", () => {
  it("returns an unavailable error when no provider is configured", async () => {
    const db = openDb(":memory:");
    try {
      const tools = createStrataTools({ db, actor: "t" });
      const tool = tools.find((t) => t.name === "semantic_search");
      expect(tool).toBeDefined();
      const result = await (tool!.handler as (
        args: unknown,
        extra: unknown
      ) => Promise<{ content: { type: string; text?: string }[] }>)(
        { query: "anything" },
        {}
      );
      const parsed = JSON.parse(result.content[0]!.text!);
      expect(parsed.error).toMatch(/semantic_search unavailable/);
    } finally {
      db.close();
    }
  });

  it("seeds three declarations and finds the queried one in top-3", async () => {
    const db = seedThreeDecls();
    try {
      if (!isVecAvailable(db)) return;
      // Embed declarations with a provider whose vectors differ by name.
      const declProvider = new TokenPeakProvider([
        { token: "isPlainObject", slot: 10 },
        { token: "formatTimestamp", slot: 20 },
        { token: "add", slot: 30 }
      ]);
      await embedDeclarations(db, ["f-plain", "f-add", "f-format"], declProvider);

      // The query-time provider only knows the query's terms; engineer it so
      // a "plain object check" query peaks at slot 10 (where isPlainObject
      // lives).
      const queryProvider = new TokenPeakProvider([
        { token: "plain object", slot: 10 }
      ]);
      const tools = createStrataTools({
        db,
        actor: "t",
        embeddingProvider: queryProvider
      });
      const tool = tools.find((t) => t.name === "semantic_search")!;

      const result = await (tool.handler as (
        args: unknown,
        extra: unknown
      ) => Promise<{ content: { type: string; text?: string }[] }>)(
        { query: "plain object check", k: 3 },
        {}
      );
      const hits = JSON.parse(result.content[0]!.text!);
      expect(Array.isArray(hits)).toBe(true);
      const top3Ids = hits.slice(0, 3).map((h: { id: string }) => h.id);
      expect(top3Ids).toContain("f-plain");
      // The closest hit should be isPlainObject.
      expect(hits[0]!.id).toBe("f-plain");
      expect(hits[0]!.name).toBe("isPlainObject");
      expect(hits[0]!.modulePath).toBe("src/util.ts");
      expect(typeof hits[0]!.distance).toBe("number");
    } finally {
      db.close();
    }
  });
});
