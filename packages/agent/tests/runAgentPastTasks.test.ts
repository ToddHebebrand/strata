import {
  EMBEDDING_DIM,
  embedCommitPattern,
  openDb,
  startupRecoverOpenTransactions,
  begin,
  commitWithoutValidate,
  insertNodes,
  insertReferences,
  isVecAvailable,
  type EmbeddingProvider
} from "@strata/store";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/runAgent";

function makeCorpus(): { root: string; dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "strata-l3-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "user.ts"),
    "export interface User {\n  id: string;\n}\n"
  );
  const dbPath = path.join(root, "strata.db");
  return {
    root,
    dbPath,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

// Deterministic hash-token embedding: shared tokens between two texts push
// their vectors closer; same provider used in store/tests/commitPatterns.test.ts.
class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-l3-runagent-v1";
  readonly dim = EMBEDDING_DIM;
  calls = 0;
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      const tokens = t.toLowerCase().split(/\W+/).filter(Boolean);
      for (const token of tokens) {
        let h = 0;
        for (let i = 0; i < token.length; i += 1) {
          h = (h * 31 + token.charCodeAt(i)) >>> 0;
        }
        v[h % this.dim] += 1;
      }
      let mag = 0;
      for (let i = 0; i < this.dim; i += 1) mag += v[i]! * v[i]!;
      mag = Math.sqrt(mag);
      if (mag > 0) for (let i = 0; i < this.dim; i += 1) v[i]! /= mag;
      return v;
    });
  }
}

/**
 * Seed a persisted store as if a past session had successfully committed a
 * rename. This isolates the L3.3 retrieval-and-inject path from the live
 * commit gate; the L3.2 in-process pipeline (commit → embed) is already
 * exercised in store/tests/commitPatterns.test.ts.
 */
async function seedPastRenameCommit(
  dbPath: string,
  prompt: string,
  provider: EmbeddingProvider
): Promise<void> {
  const db = openDb(dbPath);
  try {
    startupRecoverOpenTransactions(db);
    insertNodes(db, [
      {
        id: "seed-mod",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "src/types/user.ts"
      },
      {
        id: "seed-decl",
        kind: "InterfaceDeclaration",
        parentId: "seed-mod",
        childIndex: 0,
        payload: "export interface User {\n}\n"
      },
      {
        id: "seed-ident",
        kind: "Identifier",
        parentId: "seed-decl",
        childIndex: null,
        payload: JSON.stringify({ text: "User", offset: 17 })
      }
    ]);
    insertReferences(db, []);
    const tx = begin(db, "seed-actor", prompt);
    db.prepare(
      `INSERT INTO operations
         (op_id, tx_id, kind, params_json, affected_node_ids_json, actor, ts, reasoning)
       VALUES (?, ?, 'RenameSymbol', ?, ?, ?, ?, NULL)`
    ).run(
      "seed-op",
      tx.id,
      JSON.stringify({ declaration_id: "seed-decl", new_name: "Account" }),
      JSON.stringify(["seed-ident"]),
      "seed-actor",
      Date.now()
    );
    commitWithoutValidate(db, tx);
    if (!isVecAvailable(db)) return;
    await embedCommitPattern(db, tx.id, provider);
  } finally {
    db.close();
  }
}

describe("runAgent Layer 3 — past tasks retrieval (L3.3)", () => {
  it("injects 'Past tasks like this one' on a similar second session", async () => {
    const { root, dbPath, cleanup } = makeCorpus();
    try {
      const provider = new HashEmbeddingProvider();
      // Probe vec availability without leaking a handle.
      {
        const probe = openDb(":memory:");
        const vec = isVecAvailable(probe);
        probe.close();
        if (!vec) return;
      }

      await seedPastRenameCommit(
        dbPath,
        "Rename the exported interface User to Account everywhere it is referenced",
        provider
      );

      const logPath = path.join(root, "session2.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt:
            "Rename the User interface to Account across the codebase",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          dbPath,
          logPath,
          embeddingProvider: provider
        });
      } catch {
        // Live SDK call will be aborted by the 1ms wall-time; we only need
        // the runAgent prologue (index + past-tasks injection) to have run.
      }

      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
      const injected = events.find((e) => e.type === "past_tasks_injected") as
        | { type: string; count: number; k: number }
        | undefined;
      expect(injected).toBeDefined();
      expect(injected!.count).toBeGreaterThan(0);
      expect(injected!.k).toBe(5);
    } finally {
      cleanup();
    }
  });

  it("logs past_tasks_failed when retrieveSimilarPastTasks throws (and not on cold start)", async () => {
    class FailQueryEmbedProvider implements EmbeddingProvider {
      readonly model = "mock-fail-query-v1";
      readonly dim = EMBEDDING_DIM;
      calls = 0;
      async embedBatch(texts: string[]): Promise<Float32Array[]> {
        this.calls += 1;
        // First call is declaration embedding during ingest — succeed.
        if (this.calls === 1) {
          return texts.map(() => {
            const v = new Float32Array(this.dim);
            v[0] = 1;
            return v;
          });
        }
        // Subsequent calls are the L3 query embed — fail so the catch fires.
        throw new Error("simulated query embed failure");
      }
    }

    const { root, dbPath, cleanup } = makeCorpus();
    try {
      {
        const probe = openDb(":memory:");
        const vec = isVecAvailable(probe);
        probe.close();
        if (!vec) return;
      }
      // Seed a past commit so commit_pattern_embeddings is non-empty and the
      // catch path (rather than the empty-table early-return) is reached.
      const seedProvider = new HashEmbeddingProvider();
      await seedPastRenameCommit(
        dbPath,
        "Rename User to Account",
        seedProvider
      );

      const provider = new FailQueryEmbedProvider();
      const logPath = path.join(root, "session-failquery.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt: "Rename Foo to Bar",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          dbPath,
          logPath,
          embeddingProvider: provider
        });
      } catch {
        // expected
      }
      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
      const failed = events.find((e) => e.type === "past_tasks_failed") as
        | { type: string; reason: string }
        | undefined;
      expect(failed).toBeDefined();
      expect(failed!.reason).toContain("simulated query embed failure");
      const injected = events.find((e) => e.type === "past_tasks_injected");
      expect(injected).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("cold start: no past_tasks_injected nor past_tasks_failed when commit_pattern_embeddings is empty", async () => {
    const { root, cleanup } = makeCorpus();
    try {
      const provider = new HashEmbeddingProvider();
      {
        const probe = openDb(":memory:");
        const vec = isVecAvailable(probe);
        probe.close();
        if (!vec) return;
      }
      const logPath = path.join(root, "session-cold.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt: "Rename something somewhere",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          logPath,
          embeddingProvider: provider
        });
      } catch {
        // expected wall-time abort
      }
      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string });
      const injected = events.find((e) => e.type === "past_tasks_injected");
      expect(injected).toBeUndefined();
      const failed = events.find((e) => e.type === "past_tasks_failed");
      expect(failed).toBeUndefined();
      // L1 still injects.
      const moduleIdx = events.find((e) => e.type === "module_index_injected");
      expect(moduleIdx).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
