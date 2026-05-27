import { describe, expect, it } from "vitest";
import {
  buildCommitPattern,
  embedCommitPattern,
  renderCommitPatternForEmbedding,
  retrieveSimilarPastTasks
} from "../src/commitPatterns";
import { insertNodes } from "../src/nodes";
import { insertReferences } from "../src/references";
import { rename_symbol } from "../src/rename";
import { EMBEDDING_DIM, isVecAvailable, openDb } from "../src/schema";
import {
  begin,
  commitWithoutValidate,
  type TxHandle
} from "../src/transactions";
import type { EmbeddingProvider } from "../src/embed";

const DIM = EMBEDDING_DIM;

// Deterministic provider: hash the input text into a few peaks. The same
// input always returns the same vector; similar inputs (sharing tokens) end
// up near each other in cosine space.
class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-commit-pattern-v1";
  readonly dim = DIM;
  calls = 0;
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((t) => embedText(t, this.dim));
  }
}

function embedText(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  // For each whitespace-split token, set a deterministic slot to 1. Tokens
  // that overlap between texts dominate cosine similarity.
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i += 1) {
      h = (h * 31 + token.charCodeAt(i)) >>> 0;
    }
    v[h % dim] += 1;
  }
  // L2-normalize so distance == cosine distance.
  let mag = 0;
  for (let i = 0; i < dim; i += 1) mag += v[i]! * v[i]!;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < dim; i += 1) v[i]! /= mag;
  }
  return v;
}

function seedRenameCorpus(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  insertNodes(db, [
    {
      id: "m1",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/types/user.ts"
    },
    {
      id: "iface-user",
      kind: "InterfaceDeclaration",
      parentId: "m1",
      childIndex: 0,
      payload: "export interface User {\n  id: string;\n}\n"
    },
    {
      id: "iface-user-id",
      kind: "Identifier",
      parentId: "iface-user",
      childIndex: null,
      payload: JSON.stringify({ text: "User", offset: 17 })
    },
    {
      id: "m2",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "src/types/account.ts"
    },
    {
      id: "iface-account",
      kind: "InterfaceDeclaration",
      parentId: "m2",
      childIndex: 0,
      payload: "export interface Account {\n  id: string;\n}\n"
    },
    {
      id: "iface-account-id",
      kind: "Identifier",
      parentId: "iface-account",
      childIndex: null,
      payload: JSON.stringify({ text: "Account", offset: 17 })
    }
  ]);
  insertReferences(db, []);
  return db;
}

function commitRename(
  db: ReturnType<typeof openDb>,
  prompt: string,
  declarationId: string,
  newName: string
): TxHandle {
  const tx = begin(db, "agent", prompt);
  rename_symbol(db, tx, declarationId, newName);
  commitWithoutValidate(db, tx);
  return tx;
}

describe("commit patterns (L3.2 + L3.3)", () => {
  it("builds a structured pattern with prompt, ops, modules, declarations", () => {
    const db = seedRenameCorpus();
    try {
      const tx = commitRename(
        db,
        "Rename the exported interface User to Account everywhere",
        "iface-user",
        "Account"
      );
      const pattern = buildCommitPattern(db, tx.id);
      expect(pattern.prompt).toBe(
        "Rename the exported interface User to Account everywhere"
      );
      expect(pattern.ops).toEqual(["RenameSymbol"]);
      expect(pattern.modules).toEqual(["src/types/user.ts"]);
      // The declaration name is the post-rename Identifier text.
      expect(pattern.declarations.some((n) => n === "Account" || n === "User")).toBe(
        true
      );
    } finally {
      db.close();
    }
  });

  it("renderCommitPatternForEmbedding pins the byte format", () => {
    const text = renderCommitPatternForEmbedding({
      prompt: "Rename User to Account",
      ops: ["RenameSymbol"],
      modules: ["src/types/user.ts"],
      declarations: ["Account"]
    });
    expect(text).toBe(
      "Prompt: Rename User to Account\n" +
        "Ops: RenameSymbol\n" +
        "Modules: src/types/user.ts\n" +
        "Declarations: Account"
    );
  });

  it("embedCommitPattern persists rows in commit_pattern_embeddings + commit_pattern_meta", async () => {
    const db = seedRenameCorpus();
    try {
      if (!isVecAvailable(db)) return;
      const provider = new HashEmbeddingProvider();
      const tx1 = commitRename(
        db,
        "Rename User to Account",
        "iface-user",
        "Account"
      );
      const tx2 = commitRename(
        db,
        "Rename Account to Profile",
        "iface-account",
        "Profile"
      );
      await embedCommitPattern(db, tx1.id, provider);
      await embedCommitPattern(db, tx2.id, provider);

      const vecCount = (
        db.prepare("SELECT count(*) AS c FROM commit_pattern_embeddings").get() as {
          c: number;
        }
      ).c;
      expect(vecCount).toBe(2);

      const metaRows = db
        .prepare(
          "SELECT tx_id, pattern_json FROM commit_pattern_meta ORDER BY tx_id"
        )
        .all() as { tx_id: string; pattern_json: string }[];
      expect(metaRows.length).toBe(2);
      for (const row of metaRows) {
        const parsed = JSON.parse(row.pattern_json) as {
          prompt: string;
          ops: string[];
        };
        expect(typeof parsed.prompt).toBe("string");
        expect(parsed.ops).toContain("RenameSymbol");
      }

      // Re-embedding is a no-op (same content hash, same model).
      await embedCommitPattern(db, tx1.id, provider);
      expect(provider.calls).toBe(2);
    } finally {
      db.close();
    }
  });

  it("retrieveSimilarPastTasks returns [] on cold start", async () => {
    const db = seedRenameCorpus();
    try {
      if (!isVecAvailable(db)) return;
      const provider = new HashEmbeddingProvider();
      const hits = await retrieveSimilarPastTasks(
        db,
        provider,
        "Rename something",
        5
      );
      expect(hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("round-trips a prompt containing commas and newlines without shredding", async () => {
    const db = seedRenameCorpus();
    try {
      if (!isVecAvailable(db)) return;
      const provider = new HashEmbeddingProvider();
      const prompt = "Rename a, b, and c\nto X";
      const tx = commitRename(db, prompt, "iface-user", "Account");
      await embedCommitPattern(db, tx.id, provider);

      const hits = await retrieveSimilarPastTasks(
        db,
        provider,
        "Rename a, b, and c\nto X",
        5
      );
      expect(hits.length).toBe(1);
      expect(hits[0]!.prompt).toBe(prompt);
    } finally {
      db.close();
    }
  });

  it("retrieveSimilarPastTasks ranks the closer pattern first (L3.3)", async () => {
    const db = seedRenameCorpus();
    try {
      if (!isVecAvailable(db)) return;
      const provider = new HashEmbeddingProvider();

      const txA = commitRename(
        db,
        "Rename the exported interface User to Account",
        "iface-user",
        "Account"
      );
      const txB = commitRename(
        db,
        "Change the return type of getRole to a literal union",
        "iface-account",
        "Profile"
      );
      await embedCommitPattern(db, txA.id, provider);
      await embedCommitPattern(db, txB.id, provider);

      const hits = await retrieveSimilarPastTasks(
        db,
        provider,
        "Rename the User interface to Account",
        5
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.txId).toBe(txA.id);
      expect(hits[0]!.prompt).toContain("Rename");
      expect(hits[0]!.ops).toContain("RenameSymbol");
      expect(hits[0]!.similarity).toBeGreaterThan(0);
      // Distance to the unrelated commit should rank lower (further away).
      if (hits.length > 1) {
        expect(hits[0]!.similarity).toBeGreaterThanOrEqual(hits[1]!.similarity);
      }
    } finally {
      db.close();
    }
  });
});
