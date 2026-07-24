import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalSyncDigest,
  type MirrorNode,
  type MirrorReference
} from "../src/sync-digest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

// The SAME fixture file the Rust unit tests pin via include_str! — one source
// of truth for the cross-language byte-identity contract.
const vectorsPath = path.resolve(
  currentDir,
  "../../../crates/strata-kernel/tests/fixtures/sync-digest-vectors.json"
);

// Written by the Rust randomized differential test, so the Rust side must run
// first: `cargo test -p strata-kernel sync_digest` and then
// `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge test`.
const differentialPath = path.resolve(
  currentDir,
  "../../../target/sync-digest-differential.json"
);

interface DigestVector {
  name: string;
  generation: string;
  nodes: MirrorNode[];
  references: MirrorReference[];
  expectedDigest: string | null;
}

function loadVectors(filePath: string): DigestVector[] {
  return JSON.parse(readFileSync(filePath, "utf8")) as DigestVector[];
}

function assertVectors(vectors: DigestVector[]): void {
  for (const vector of vectors) {
    expect(
      vector.expectedDigest,
      `vector ${vector.name} must carry a pinned lowercase-hex SHA-256 ` +
        "(regenerate once with REGEN_SYNC_DIGEST_VECTORS=1 cargo test -p strata-kernel sync_digest)"
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      canonicalSyncDigest(vector.generation, vector.nodes, vector.references),
      `vector ${vector.name}`
    ).toBe(vector.expectedDigest);
  }
}

describe("canonical sync digest", () => {
  it("reproduces every pinned Rust fixture digest byte-identically", () => {
    const vectors = loadVectors(vectorsPath);
    expect(vectors.length).toBeGreaterThanOrEqual(9);
    assertVectors(vectors);
  });

  it("is independent of input order (canonical byte-wise UTF-8 sorting)", () => {
    const vectors = loadVectors(vectorsPath);
    for (const vector of vectors) {
      expect(
        canonicalSyncDigest(
          vector.generation,
          [...vector.nodes].reverse(),
          [...vector.references].reverse()
        ),
        `vector ${vector.name}`
      ).toBe(vector.expectedDigest);
    }
  });

  it("sorts by UTF-8 bytes, where UTF-16 code-unit order would diverge", () => {
    // U+FF61 (EF BD A1) sorts before U+10000 (F0 90 80 80) in UTF-8 bytes,
    // but its UTF-16 code unit 0xFF61 sorts AFTER the surrogate 0xD800: a
    // naive `<` comparison or localeCompare would produce a different digest.
    const node = (id: string): MirrorNode => ({
      id,
      kind: "Identifier",
      parentId: null,
      childIndex: null,
      payload: id
    });
    const utf8First = canonicalSyncDigest("1", [node("｡"), node("\u{10000}")], []);
    const utf16First = canonicalSyncDigest("1", [node("\u{10000}"), node("｡")], []);
    expect(utf8First).toBe(utf16First);
  });

  it("rejects non-canonical generations instead of hashing them", () => {
    for (const generation of ["", "01", "-1", "1.0", "18446744073709551616"]) {
      expect(() => canonicalSyncDigest(generation, [], [])).toThrow(
        /canonical unsigned 64-bit/
      );
    }
  });

  it("rejects unsafe childIndex values instead of misencoding them", () => {
    const node: MirrorNode = {
      id: "n",
      kind: "Identifier",
      parentId: null,
      childIndex: 9007199254740992,
      payload: ""
    };
    expect(() => canonicalSyncDigest("1", [node], [])).toThrow(/safe integer/);
    expect(() =>
      canonicalSyncDigest("1", [{ ...node, childIndex: 0.5 }], [])
    ).toThrow(/safe integer/);
  });

  const differentialAvailable = existsSync(differentialPath);

  it.skipIf(!differentialAvailable)(
    "reproduces every randomized Rust-generated differential digest " +
      "(requires `cargo test -p strata-kernel sync_digest` to have run first)",
    () => {
      const vectors = loadVectors(differentialPath);
      expect(vectors.length).toBeGreaterThanOrEqual(50);
      assertVectors(vectors);
    }
  );

  it.runIf(!differentialAvailable)(
    "differential corpus absent — skipped; run `cargo test -p strata-kernel sync_digest` " +
      "before this suite to enable the cross-language randomized check",
    () => {
      expect(differentialAvailable).toBe(false);
    }
  );
});
