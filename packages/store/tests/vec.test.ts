import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, isVecAvailable, openDb } from "../src/schema";

function vecToBlob(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

describe("sqlite-vec integration (L2.1)", () => {
  it("openDb either reports vec available and can run vec_version(), or reports it unavailable", () => {
    const db = openDb(":memory:");
    try {
      const available = isVecAvailable(db);
      if (available) {
        const probe = db.prepare("SELECT vec_version() AS v").get() as {
          v: string;
        };
        expect(typeof probe.v).toBe("string");
      } else {
        expect(() => db.prepare("SELECT vec_version()").get()).toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("embedding_meta table exists even when vec is unavailable", () => {
    const db = openDb(":memory:");
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_meta'"
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("embedding_meta");
    } finally {
      db.close();
    }
  });

  it("node_embeddings round-trips a vector when vec is available", () => {
    const db = openDb(":memory:");
    try {
      if (!isVecAvailable(db)) {
        // Document the platform path: when vec isn't available, the virtual
        // table simply doesn't exist and Layer 2 is disabled.
        const row = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings'"
          )
          .get();
        expect(row).toBeUndefined();
        return;
      }

      const v1 = Array.from(
        { length: EMBEDDING_DIM },
        (_, i) => (i === 0 ? 1 : 0)
      );
      const v2 = Array.from(
        { length: EMBEDDING_DIM },
        (_, i) => (i === 1 ? 1 : 0)
      );
      db.prepare(
        "INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?)"
      ).run("alpha", vecToBlob(v1));
      db.prepare(
        "INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?)"
      ).run("beta", vecToBlob(v2));

      const rows = db
        .prepare(
          "SELECT node_id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 2"
        )
        .all(vecToBlob(v1)) as { node_id: string; distance: number }[];

      expect(rows[0]!.node_id).toBe("alpha");
      expect(rows[0]!.distance).toBeCloseTo(0, 4);
      expect(rows[1]!.node_id).toBe("beta");
    } finally {
      db.close();
    }
  });
});
