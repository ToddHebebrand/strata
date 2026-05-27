import { describe, expect, it } from "vitest";
import {
  buildDeclarationEmbeddingText,
  embedDeclarations,
  type EmbeddingProvider
} from "../src/embed";
import { insertNodes } from "../src/nodes";
import { insertReferences } from "../src/references";
import { EMBEDDING_DIM, isVecAvailable, openDb } from "../src/schema";

const DIM = EMBEDDING_DIM;

function seed(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  insertNodes(db, [
    {
      id: "m1",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/a.ts"
    },
    {
      id: "f1",
      kind: "FunctionDeclaration",
      parentId: "m1",
      childIndex: 0,
      payload: "export function alpha(): number {\n  return 1;\n}\n"
    },
    {
      id: "f1-id",
      kind: "Identifier",
      parentId: "f1",
      childIndex: null,
      payload: JSON.stringify({ text: "alpha", offset: 16 })
    },
    {
      id: "f2",
      kind: "FunctionDeclaration",
      parentId: "m1",
      childIndex: 1,
      payload: "export function beta(): string { return 'b'; }\n"
    },
    {
      id: "f2-id",
      kind: "Identifier",
      parentId: "f2",
      childIndex: null,
      payload: JSON.stringify({ text: "beta", offset: 16 })
    },
    {
      id: "m2",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/b.ts"
    },
    {
      id: "f3",
      kind: "FunctionDeclaration",
      parentId: "m2",
      childIndex: 0,
      payload: "export function gamma(x: number): number { return x + 1; }\n"
    },
    {
      id: "f3-id",
      kind: "Identifier",
      parentId: "f3",
      childIndex: null,
      payload: JSON.stringify({ text: "gamma", offset: 16 })
    },
    // A caller of alpha so refCount > 0 for f1.
    {
      id: "ref-of-alpha",
      kind: "Identifier",
      parentId: "f3",
      childIndex: null,
      payload: JSON.stringify({ text: "alpha", offset: 50 })
    }
  ]);
  insertReferences(db, [
    { fromNodeId: "ref-of-alpha", toNodeId: "f1-id", kind: "value" }
  ]);
  return db;
}

class MockProvider implements EmbeddingProvider {
  readonly model = "mock-embedding-v1";
  readonly dim = DIM;
  calls = 0;
  inputs: string[][] = [];
  /** Maps a deterministic substring → (slot, value) so we can place a peak. */
  constructor(
    private readonly peaks: { token: string; slot: number; weight: number }[]
  ) {}
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    this.inputs.push([...texts]);
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      // Baseline: tiny stable noise from char codes so all vectors differ.
      for (let i = 0; i < Math.min(t.length, this.dim); i += 1) {
        v[i] = ((t.charCodeAt(i) % 17) - 8) * 0.0001;
      }
      for (const peak of this.peaks) {
        if (t.includes(peak.token)) v[peak.slot] = peak.weight;
      }
      return v;
    });
  }
}

describe("embed pipeline (L2.2)", () => {
  it("builds an embedding text with structural context (not naked code)", () => {
    const db = seed();
    try {
      const text = buildDeclarationEmbeddingText(db, "f1");
      expect(text).toContain("module: src/a.ts");
      expect(text).toContain("kind: FunctionDeclaration");
      expect(text).toContain("name: alpha");
      expect(text).toContain("references: 1");
      expect(text).toContain("signature:");
    } finally {
      db.close();
    }
  });

  it("embeds + persists + skips unchanged content", async () => {
    const db = seed();
    try {
      if (!isVecAvailable(db)) return;
      const provider = new MockProvider([]);
      const first = await embedDeclarations(db, ["f1", "f2", "f3"], provider);
      expect(first).toEqual({ embedded: 3, skipped: 0 });
      expect(provider.calls).toBe(1);
      expect(provider.inputs[0]!.length).toBe(3);

      const metaCount = (
        db.prepare("SELECT count(*) AS c FROM embedding_meta").get() as {
          c: number;
        }
      ).c;
      expect(metaCount).toBe(3);
      const vecCount = (
        db.prepare("SELECT count(*) AS c FROM node_embeddings").get() as {
          c: number;
        }
      ).c;
      expect(vecCount).toBe(3);

      const second = await embedDeclarations(db, ["f1", "f2", "f3"], provider);
      expect(second).toEqual({ embedded: 0, skipped: 3 });
      // Provider not called again because everything was up-to-date.
      expect(provider.calls).toBe(1);
    } finally {
      db.close();
    }
  });

  it("re-embeds when the model identifier changes", async () => {
    const db = seed();
    try {
      if (!isVecAvailable(db)) return;
      const p1 = new MockProvider([]);
      await embedDeclarations(db, ["f1"], p1);
      class OtherProvider extends MockProvider {
        readonly model = "mock-embedding-v2";
      }
      const p2 = new OtherProvider([]);
      const result = await embedDeclarations(db, ["f1"], p2);
      expect(result.embedded).toBe(1);
      expect(result.skipped).toBe(0);
    } finally {
      db.close();
    }
  });
});
