import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  find_declarations,
  insertNodes,
  insertReferences,
  openDb
} from "@strata/store";
import { describe, expect, it } from "vitest";
import { runRename } from "../src/commands/rename";

describe("rename command", () => {
  it("renames a declaration in an existing Strata database", () => {
    const work = mkdtempSync(path.join(tmpdir(), "strata-cli-rename-"));

    try {
      mkdirSync(path.join(work, "src/types"), { recursive: true });
      const userPath = path.join(work, "src/types/user.ts");
      const consumerPath = path.join(work, "src/consumer.ts");
      writeFileSync(userPath, "export interface User { id: string; }\n");
      writeFileSync(
        consumerPath,
        [
          'import type { User } from "./types/user";',
          "export function f(u: User): User { return u; }",
          ""
        ].join("\n")
      );

      const batch = ingestBatch(
        [userPath, consumerPath].map((filePath) => ({
          path: filePath,
          text: readFileSync(filePath, "utf8")
        }))
      );
      const dbPath = path.join(work, ".strata.db");
      const db = openDb(dbPath);
      let declarationId: string;
      try {
        insertNodes(db, batch.allNodes);
        insertReferences(db, batch.references);
        const declarations = find_declarations(db, {
          name: "User",
          kind: "interface"
        });
        expect(declarations).toHaveLength(1);
        declarationId = declarations[0]!.id;
      } finally {
        db.close();
      }

      const result = runRename({
        dbPath,
        declarationId,
        newName: "Account"
      });
      expect(result.ok).toBe(true);

      const verifyDb = openDb(dbPath);
      try {
        const payloads = verifyDb
          .prepare(`SELECT payload FROM nodes WHERE kind = 'Identifier'`)
          .all() as Array<{ payload: string }>;
        expect(
          payloads.some(
            (row) => (JSON.parse(row.payload) as { text: string }).text === "User"
          )
        ).toBe(false);
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
