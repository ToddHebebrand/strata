import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import { describe, expect, it } from "vitest";

describe("stable IDs across re-ingest", () => {
  it("keeps operation-affected identifier IDs stable after rename render and re-ingest", () => {
    const work = mkdtempSync(path.join(tmpdir(), "strata-ids-"));

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

      const inputs1 = [userPath, consumerPath].map((filePath) => ({
        path: filePath,
        text: readFileSync(filePath, "utf8")
      }));
      const batch1 = ingestBatch(inputs1);
      const db = openDb(":memory:");
      insertNodes(db, batch1.allNodes);
      insertReferences(db, batch1.references);

      const declarations = find_declarations(db, {
        name: "User",
        kind: "interface"
      });
      expect(declarations).toHaveLength(1);
      const declarationId1 = declarations[0]!.id;
      const declarationIdentifierId1 = childIdentifierId(
        batch1.allNodes,
        declarationId1,
        "User"
      );

      const tx = begin(db, "ids-test");
      rename_symbol(db, tx, declarationId1, "Account");
      expect(commit(db, tx)).toEqual({ ok: true });

      const op = db
        .prepare(
          `SELECT affected_node_ids_json FROM operations WHERE kind = 'RenameSymbol'`
        )
        .get() as { affected_node_ids_json: string };
      const affectedIds = JSON.parse(op.affected_node_ids_json) as string[];
      expect(affectedIds).toContain(declarationIdentifierId1);

      for (const module of batch1.modules) {
        const loaded = loadModule(db, module.moduleId);
        const { text } = renderWithSourceMap(loaded.module, loaded.children);
        writeFileSync(module.path, text);
      }

      const inputs2 = [userPath, consumerPath].map((filePath) => ({
        path: filePath,
        text: readFileSync(filePath, "utf8")
      }));
      const batch2 = ingestBatch(inputs2);
      const declarations2 = batch2.allNodes.filter(
        (node) => node.kind === "InterfaceDeclaration"
      );
      expect(declarations2).toHaveLength(1);
      expect(declarations2[0]!.id).toEqual(declarationId1);

      const identifiers2 = new Map(
        batch2.allNodes
          .filter((node) => node.kind === "Identifier")
          .map((node) => [
            node.id,
            (JSON.parse(node.payload) as { text: string }).text
          ])
      );
      for (const affectedId of affectedIds) {
        expect(identifiers2.get(affectedId)).toEqual("Account");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

function childIdentifierId(
  nodes: Array<{ id: string; kind: string; parentId: string | null; payload: string }>,
  parentId: string,
  text: string
): string {
  const found = nodes.find((node) => {
    if (node.kind !== "Identifier" || node.parentId !== parentId) {
      return false;
    }
    return (JSON.parse(node.payload) as { text: string }).text === text;
  });
  if (!found) {
    throw new Error(`Missing identifier ${text} under ${parentId}`);
  }
  return found.id;
}
