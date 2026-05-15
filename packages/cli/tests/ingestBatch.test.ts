import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "@strata/store";
import { describe, expect, it } from "vitest";
import { runIngestBatch } from "../src/commands/ingestBatch";

describe("ingest-batch command", () => {
  it("ingests every .ts file in a directory tree and populates nodes and references", () => {
    const work = mkdtempSync(path.join(tmpdir(), "strata-batch-"));

    try {
      mkdirSync(path.join(work, "src/types"), { recursive: true });
      writeFileSync(
        path.join(work, "src/types/user.ts"),
        "export interface User { id: string; }\n"
      );
      writeFileSync(
        path.join(work, "src/main.ts"),
        [
          'import type { User } from "./types/user";',
          "export function f(u: User): User { return u; }",
          ""
        ].join("\n")
      );

      const dbPath = path.join(work, ".strata.db");
      const result = runIngestBatch({
        rootDir: path.join(work, "src"),
        dbPath
      });
      expect(result.ok).toBe(true);

      const db = openDb(dbPath);
      try {
        const moduleCount = db
          .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE kind = 'Module'`)
          .get() as { n: number };
        expect(moduleCount.n).toBe(2);

        const identifiers = db
          .prepare(`SELECT id, payload FROM nodes WHERE kind = 'Identifier'`)
          .all() as Array<{ id: string; payload: string }>;
        const userIds = identifiers.filter(
          (identifier) => JSON.parse(identifier.payload).text === "User"
        );
        expect(userIds.length).toBeGreaterThanOrEqual(4);

        const refCount = db
          .prepare(`SELECT COUNT(*) AS n FROM node_references`)
          .get() as { n: number };
        expect(refCount.n).toBeGreaterThanOrEqual(3);
      } finally {
        db.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
