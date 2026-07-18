import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  find_declarations,
  insertNodes,
  insertReferences,
  openDb
} from "@strata-code/store";
import { describe, expect, it } from "vitest";
import {
  loadTranscriptFixture,
  normalizeTranscriptForFixture,
  runAgentT03,
  type ReplayStep
} from "../src/session";

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

function syntheticTranscript(declarationId: string): ReplayStep[] {
  return [
    { tool: "find_declarations", args: { name: "User", kind: "interface" } },
    { tool: "get_references", args: { declaration_id: declarationId } },
    { tool: "begin_transaction", args: {} },
    {
      tool: "rename_symbol",
      args: { tx: "$TX", declaration_id: declarationId, new_name: "Account" }
    },
    { tool: "validate", args: { tx: "$TX" } },
    { tool: "commit_transaction", args: { tx: "$TX" } }
  ];
}

function resolveUserDeclarationId(corpusRoot: string): string {
  const db = openDb(":memory:");
  try {
    const batch = ingestBatch(collect(path.join(corpusRoot, "src")));
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const declarations = find_declarations(db, {
      name: "User",
      kind: "interface"
    });
    expect(declarations.length).toBe(1);
    return declarations[0]!.id;
  } finally {
    db.close();
  }
}

describe("runAgentT03 replay mode (no model, no key)", () => {
  it("replays a synthetic transcript through real handlers and mutates the store", async () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const declarationId = resolveUserDeclarationId(corpusRoot);

    const result = await runAgentT03({
      corpusRoot,
      model: "replay",
      maxTurns: 25,
      wallTimeMs: 60_000,
      replayTranscript: syntheticTranscript(declarationId)
    });

    for (const [key, value] of Object.entries(result.criteria)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
    expect(result.terminalReason).toBe("replay_complete");
  });
});

const FIXTURE = path.resolve(
  __dirname,
  "fixtures/agent-t03-transcript.jsonl"
);

describe("normalizeTranscriptForFixture", () => {
  it("replaces captured TxHandle values with the replay placeholder", () => {
    const normalized = normalizeTranscriptForFixture([
      {
        tool: "validate",
        args: { tx: { id: "tx-1", actor: "agent-t03" } }
      }
    ]);
    expect(normalized).toEqual([{ tool: "validate", args: { tx: "$TX" } }]);
  });
});

describe.skipIf(!existsSync(FIXTURE))(
  "runAgentT03 replays the committed transcript fixture deterministically",
  () => {
    it("reproduces all 11 T03 criteria from the fixture without a model", async () => {
      const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
      const steps = loadTranscriptFixture(FIXTURE);
      const result = await runAgentT03({
        corpusRoot,
        model: "replay",
        maxTurns: 25,
        wallTimeMs: 60_000,
        replayTranscript: steps
      });

      for (const [key, value] of Object.entries(result.criteria)) {
        expect(value, `criterion ${key}`).toBe(true);
      }
      expect(result.terminalReason).toBe("replay_complete");
    });
  }
);
