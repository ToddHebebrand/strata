import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  queueIdentifierUpdate,
  queuePendingOp,
  rollback
} from "@strata/store";
import { render } from "@strata/render";
import { describe, expect, it } from "vitest";
import { commit, validate } from "../src/validate";

interface Corpus {
  dbPath: string;
  cleanup: () => void;
  userDeclIdentifierId: string;
}

function setupCorpus(): Corpus {
  const work = mkdtempSync(path.join(tmpdir(), "strata-validate-"));
  const typesPath = path.join(work, "src/types/user.ts");
  const consumerPath = path.join(work, "src/consumer.ts");
  mkdirSync(path.dirname(typesPath), { recursive: true });

  const userText = "export interface User { id: string; }\n";
  const consumerText = [
    'import type { User } from "./types/user";',
    "export function f(u: User): User { return u; }",
    ""
  ].join("\n");
  writeFileSync(typesPath, userText);
  writeFileSync(consumerPath, consumerText);

  const batch = ingestBatch([
    { path: typesPath, text: userText },
    { path: consumerPath, text: consumerText }
  ]);
  const dbPath = path.join(work, ".strata.db");
  const db = openDb(dbPath);
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);

  const declaration = batch.allNodes.find((node) => {
    if (node.kind !== "Identifier") {
      return false;
    }
    const payload = JSON.parse(node.payload) as { text: string };
    if (payload.text !== "User") {
      return false;
    }
    const parent = batch.allNodes.find((candidate) => candidate.id === node.parentId);
    return parent?.kind === "InterfaceDeclaration";
  });
  if (!declaration) {
    throw new Error("setup failed: missing User declaration identifier");
  }
  db.close();

  return {
    dbPath,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
    userDeclIdentifierId: declaration.id
  };
}

function referenceIds(dbPath: string, declarationId: string): string[] {
  const db = openDb(dbPath);
  try {
    return (
      db
        .prepare(`SELECT from_node_id FROM node_references WHERE to_node_id = ?`)
        .all(declarationId) as Array<{ from_node_id: string }>
    ).map((row) => row.from_node_id);
  } finally {
    db.close();
  }
}

describe("validate", () => {
  it("returns [] when the transaction has no mutations", () => {
    const { dbPath, cleanup } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      expect(validate(db, tx)).toEqual([]);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("returns [] when an interface is renamed consistently across references", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      queueIdentifierUpdate(tx, userDeclIdentifierId, "Account");
      for (const id of referenceIds(dbPath, userDeclIdentifierId)) {
        queueIdentifierUpdate(tx, id, "Account");
      }

      expect(validate(db, tx)).toEqual([]);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });

  it("returns diagnostics with mapped node IDs when references are left dangling", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const tx = begin(db, "test");
      queueIdentifierUpdate(tx, userDeclIdentifierId, "Account");

      const diagnostics = validate(db, tx);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.some((diagnostic) => diagnostic.nodeId !== null)).toBe(true);
      rollback(db, tx);
      db.close();
    } finally {
      cleanup();
    }
  });
});

describe("commit", () => {
  it("commits clean transactions and leaves dirty transactions open", () => {
    const { dbPath, cleanup, userDeclIdentifierId } = setupCorpus();
    try {
      const db = openDb(dbPath);
      const refs = referenceIds(dbPath, userDeclIdentifierId);

      const clean = begin(db, "test");
      queueIdentifierUpdate(clean, userDeclIdentifierId, "Account");
      for (const id of refs) {
        queueIdentifierUpdate(clean, id, "Account");
      }
      queuePendingOp(clean, {
        kind: "RenameSymbol",
        paramsJson: JSON.stringify({ new_name: "Account" }),
        affectedNodeIdsJson: JSON.stringify([userDeclIdentifierId, ...refs]),
        reasoning: null
      });

      expect(commit(db, clean)).toEqual({ ok: true });
      const modules = db
        .prepare(`SELECT id FROM nodes WHERE kind = 'Module' ORDER BY payload ASC`)
        .all() as Array<{ id: string }>;
      const rendered = modules
        .map((module) => {
          const loaded = loadModule(db, module.id);
          return render(loaded.module, loaded.children);
        })
        .join("\n");
      expect(rendered).toContain("interface Account");
      expect(rendered).not.toContain("interface User");

      const dirty = begin(db, "test");
      queueIdentifierUpdate(dirty, userDeclIdentifierId, "Profile");
      const result = commit(db, dirty);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.length).toBeGreaterThan(0);
      }
      const status = db
        .prepare("SELECT status FROM transactions WHERE tx_id = ?")
        .get(dirty.id) as { status: string };
      expect(status.status).toEqual("open");
      rollback(db, dirty);
      db.close();
    } finally {
      cleanup();
    }
  });
});
