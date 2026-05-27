import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/runAgent";

function makeCorpus(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "strata-inject-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "hello.ts"),
    "export function hello(): string {\n  return 'hi';\n}\n"
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runAgent injects the module index by default", () => {
  it("logs a module_index_injected event with chars and lines", async () => {
    const { root, cleanup } = makeCorpus();
    try {
      let result;
      try {
        result = await runAgent({
          corpusRoot: root,
          prompt: "noop",
          model: "claude-sonnet-4-6",
          maxTurns: 1,
          wallTimeMs: 1
        });
      } catch {
        // Live SDK call will fail (no key / aborted); we only need to assert
        // that the index-injection log event landed BEFORE the SDK was hit.
      }
      // The session log is constructed inside runAgent; if runAgent threw
      // before logging, the test will still observably fail below.
      // Re-run in a way that captures the log even on failure: hit the
      // SessionLog via a fresh logPath.
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
      const jsonl = require("node:fs").readFileSync(logPath, "utf8") as string;
      const events = jsonl
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const injected = events.find(
        (e: { type: string }) => e.type === "module_index_injected"
      );
      expect(injected).toBeDefined();
      expect(injected.chars).toBeGreaterThan(0);
      expect(injected.lines).toBeGreaterThan(0);
      void result;
    } finally {
      cleanup();
    }
  });

  it("does not log module_index_injected when injectModuleIndex is false", async () => {
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
          logPath,
          injectModuleIndex: false
        });
      } catch {
        // expected
      }
      const jsonl = require("node:fs").readFileSync(logPath, "utf8") as string;
      const events = jsonl
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      const injected = events.find(
        (e: { type: string }) => e.type === "module_index_injected"
      );
      expect(injected).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
