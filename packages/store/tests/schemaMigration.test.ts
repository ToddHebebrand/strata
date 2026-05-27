import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import { begin } from "../src/transactions";

function tmpDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dbPath: path.join(dir, "strata.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

describe("openDb idempotent schema migrations", () => {
  it("adds triggering_prompt to an existing transactions table that lacks it", () => {
    const { dbPath, cleanup } = tmpDbPath("strata-migrate-tp-");
    try {
      const db1 = openDb(dbPath);
      try {
        // Simulate a pre-L3 DB by dropping and recreating without
        // triggering_prompt. The IF NOT EXISTS guard in openDb means a
        // subsequent re-open won't re-create the table, exercising the
        // ALTER path.
        db1.exec("DROP TABLE transactions");
        db1.exec(`
          CREATE TABLE transactions (
            tx_id        TEXT PRIMARY KEY,
            started_at   INTEGER NOT NULL,
            committed_at INTEGER,
            status       TEXT NOT NULL,
            actor        TEXT NOT NULL
          )
        `);
        db1.prepare(
          `INSERT INTO transactions (tx_id, started_at, status, actor)
           VALUES ('old-tx', 0, 'committed', 'pre-l3')`
        ).run();
        expect(columns(db1, "transactions")).not.toContain("triggering_prompt");
      } finally {
        db1.close();
      }

      const db2 = openDb(dbPath);
      try {
        expect(columns(db2, "transactions")).toContain("triggering_prompt");

        const old = db2
          .prepare(
            "SELECT triggering_prompt FROM transactions WHERE tx_id = 'old-tx'"
          )
          .get() as { triggering_prompt: string | null };
        expect(old.triggering_prompt).toBeNull();

        // New writes can populate it.
        const tx = begin(db2, "agent", "fresh-prompt");
        const row = db2
          .prepare(
            "SELECT triggering_prompt FROM transactions WHERE tx_id = ?"
          )
          .get(tx.id) as { triggering_prompt: string | null };
        expect(row.triggering_prompt).toBe("fresh-prompt");
      } finally {
        db2.close();
      }
    } finally {
      cleanup();
    }
  });

  it("renames commit_pattern_meta.pattern_text → pattern_json on an old DB", () => {
    const { dbPath, cleanup } = tmpDbPath("strata-migrate-pj-");
    try {
      const db1 = openDb(dbPath);
      try {
        db1.exec("DROP TABLE commit_pattern_meta");
        db1.exec(`
          CREATE TABLE commit_pattern_meta (
            tx_id        TEXT PRIMARY KEY,
            model        TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            embedded_at  INTEGER NOT NULL,
            pattern_text TEXT NOT NULL
          )
        `);
        db1.prepare(
          `INSERT INTO commit_pattern_meta
             (tx_id, model, content_hash, embedded_at, pattern_text)
           VALUES ('old-tx', 'model-x', 'hash-x', 0, 'Prompt: legacy')`
        ).run();
        expect(columns(db1, "commit_pattern_meta")).toContain("pattern_text");
        expect(columns(db1, "commit_pattern_meta")).not.toContain("pattern_json");
      } finally {
        db1.close();
      }

      const db2 = openDb(dbPath);
      try {
        expect(columns(db2, "commit_pattern_meta")).toContain("pattern_json");
        expect(columns(db2, "commit_pattern_meta")).not.toContain("pattern_text");

        const row = db2
          .prepare(
            "SELECT pattern_json FROM commit_pattern_meta WHERE tx_id = 'old-tx'"
          )
          .get() as { pattern_json: string };
        expect(row.pattern_json).toBe("Prompt: legacy");
      } finally {
        db2.close();
      }
    } finally {
      cleanup();
    }
  });

  it("re-opening an already-migrated DB is a no-op (idempotent)", () => {
    const { dbPath, cleanup } = tmpDbPath("strata-migrate-idem-");
    try {
      for (let i = 0; i < 3; i += 1) {
        const db = openDb(dbPath);
        try {
          expect(columns(db, "transactions")).toContain("triggering_prompt");
          expect(columns(db, "commit_pattern_meta")).toContain("pattern_json");
        } finally {
          db.close();
        }
      }
    } finally {
      cleanup();
    }
  });
});
