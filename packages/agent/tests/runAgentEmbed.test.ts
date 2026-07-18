import { EMBEDDING_DIM, type EmbeddingProvider } from "@strata-code/store";
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

function makeCorpus(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "strata-embed-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "hello.ts"),
    "export function hello(): string {\n  return 'hi';\n}\n"
  );
  writeFileSync(
    path.join(root, "src", "world.ts"),
    "export function world(): string {\n  return 'w';\n}\n"
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

class MockProvider implements EmbeddingProvider {
  readonly model = "mock-runagent-v1";
  readonly dim = EMBEDDING_DIM;
  calls = 0;
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      v[t.length % this.dim] = 1;
      return v;
    });
  }
}

describe("runAgent triggers embedding when a provider is supplied (L2.4)", () => {
  it("logs embeddings_built and calls the provider once during ingest", async () => {
    const { root, cleanup } = makeCorpus();
    try {
      const provider = new MockProvider();
      const logPath = path.join(root, "session.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt: "noop",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          logPath,
          embeddingProvider: provider
        });
      } catch {
        // Live SDK call will fail (no key/aborted); we only need to assert
        // the embeddings_built event landed before the SDK was hit.
      }
      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string });
      const evt = events.find((e) => e.type === "embeddings_built") as
        | { type: "embeddings_built"; embedded: number; skipped: number; model: string }
        | undefined;
      expect(evt).toBeDefined();
      expect(evt!.embedded).toBe(2);
      expect(evt!.skipped).toBe(0);
      expect(evt!.model).toBe("mock-runagent-v1");
      expect(provider.calls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("logs embeddings_failed when the provider throws on embedBatch", async () => {
    class ThrowingProvider implements EmbeddingProvider {
      readonly model = "mock-throwing-v1";
      readonly dim = EMBEDDING_DIM;
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error("simulated embed provider failure");
      }
    }
    const { root, cleanup } = makeCorpus();
    try {
      const logPath = path.join(root, "session-fail.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt: "noop",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          logPath,
          embeddingProvider: new ThrowingProvider()
        });
      } catch {
        // expected wall-time abort
      }
      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string; [k: string]: unknown });
      const failed = events.find((e) => e.type === "embeddings_failed") as
        | { type: string; reason: string; model: string }
        | undefined;
      expect(failed).toBeDefined();
      expect(failed!.model).toBe("mock-throwing-v1");
      expect(failed!.reason).toContain("simulated embed provider failure");
      const built = events.find((e) => e.type === "embeddings_built");
      expect(built).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("skips silently when no provider and no STRATA_EMBED_API_KEY", async () => {
    const prev = process.env.STRATA_EMBED_API_KEY;
    delete process.env.STRATA_EMBED_API_KEY;
    const { root, cleanup } = makeCorpus();
    try {
      const logPath = path.join(root, "session.jsonl");
      try {
        await runAgent({
          corpusRoot: root,
          prompt: "noop",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1,
          logPath
        });
      } catch {
        // expected
      }
      const events = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string });
      const evt = events.find((e) => e.type === "embeddings_built");
      expect(evt).toBeUndefined();
    } finally {
      cleanup();
      if (prev !== undefined) process.env.STRATA_EMBED_API_KEY = prev;
    }
  });
});
