import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  EMBEDDING_DIM,
  insertNodes,
  insertReferences,
  isVecAvailable,
  openDb,
  type EmbeddingProvider
} from "@strata/store";
import { describe, expect, it } from "vitest";
import { SessionLog } from "../src/log";
import { createStrataTools, type StrataSessionContext } from "../src/tools";

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

class GoodProvider implements EmbeddingProvider {
  readonly model = "mock-cp-good-v1";
  readonly dim = EMBEDDING_DIM;
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      v[t.length % this.dim] = 1;
      return v;
    });
  }
}

class FailingEmbedProvider implements EmbeddingProvider {
  readonly model = "mock-cp-fail-v1";
  readonly dim = EMBEDDING_DIM;
  calls = 0;
  async embedBatch(): Promise<Float32Array[]> {
    this.calls += 1;
    throw new Error("simulated commit-pattern embed failure");
  }
}

describe("commit_transaction emits commit_pattern_embed events", () => {
  it("ok: true on successful pattern embed", async () => {
    const srcRoot = path.resolve(__dirname, "../../../examples/medium/src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    if (!isVecAvailable(db)) {
      db.close();
      return;
    }
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const log = new SessionLog();
      const ctx: StrataSessionContext = {
        db,
        actor: "tools-test",
        embeddingProvider: new GoodProvider(),
        taskPrompt: "rename User to Account",
        log
      };
      const tools = createStrataTools(ctx);
      const byName = new Map(tools.map((t) => [t.name, t]));

      const decls = parseText(
        await byName.get("find_declarations")!.handler(
          { name: "User", kind: "interface" },
          {}
        )
      ) as { id: string }[];
      const tx = parseText(
        await byName.get("begin_transaction")!.handler({}, {})
      ) as { id: string; actor: string };
      await byName.get("rename_symbol")!.handler(
        { tx, declaration_id: decls[0]!.id, new_name: "Account" },
        {}
      );
      const result = parseText(
        await byName.get("commit_transaction")!.handler({ tx }, {})
      ) as { ok: boolean };
      expect(result.ok).toBe(true);

      const evt = log.events.find((e) => e.type === "commit_pattern_embed") as
        | { type: "commit_pattern_embed"; ok: boolean; txId: string; reason: string | null }
        | undefined;
      expect(evt).toBeDefined();
      expect(evt!.ok).toBe(true);
      expect(evt!.txId).toBe(tx.id);
      expect(evt!.reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it("ok: false with reason when embedCommitPattern throws", async () => {
    const srcRoot = path.resolve(__dirname, "../../../examples/medium/src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    if (!isVecAvailable(db)) {
      db.close();
      return;
    }
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const log = new SessionLog();
      const ctx: StrataSessionContext = {
        db,
        actor: "tools-test",
        embeddingProvider: new FailingEmbedProvider(),
        taskPrompt: "rename User to Account",
        log
      };
      const tools = createStrataTools(ctx);
      const byName = new Map(tools.map((t) => [t.name, t]));

      const decls = parseText(
        await byName.get("find_declarations")!.handler(
          { name: "User", kind: "interface" },
          {}
        )
      ) as { id: string }[];
      const tx = parseText(
        await byName.get("begin_transaction")!.handler({}, {})
      ) as { id: string; actor: string };
      await byName.get("rename_symbol")!.handler(
        { tx, declaration_id: decls[0]!.id, new_name: "Account" },
        {}
      );
      const result = parseText(
        await byName.get("commit_transaction")!.handler({ tx }, {})
      ) as { ok: boolean };
      // Commit itself still succeeds — the embed event captures the L3 failure.
      expect(result.ok).toBe(true);

      const evt = log.events.find((e) => e.type === "commit_pattern_embed") as
        | { type: "commit_pattern_embed"; ok: boolean; txId: string; reason: string | null }
        | undefined;
      expect(evt).toBeDefined();
      expect(evt!.ok).toBe(false);
      expect(evt!.txId).toBe(tx.id);
      expect(evt!.reason).toContain("simulated commit-pattern embed failure");
    } finally {
      db.close();
    }
  });
});
