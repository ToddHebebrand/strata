// Gate 3 (unkeyed noninferiority), Task 1: replicated-corpus builder unit
// coverage. Pure filesystem + fixture assertions against tmpdirs — no
// daemon, no sockets. The full-scale preflight (Step 4, ~1012 modules) runs
// unconditionally: measured wall time is ~3s (build ~0.2s, tsc ~0.9s,
// snapshot serialize ~1.7s — see task-1 report), well within budget for the
// default suite, so it is not worth hiding behind an opt-in env var. It
// still gets the generous 300s per-test timeout the brief asked for as a
// safety margin against a slower machine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tscNoEmitSrc } from "@strata-code/verify";
import { buildCorpusInputs } from "../src/tasks.js";
import { createQualifiedKernelSnapshot } from "../src/tasks.js";
import {
  BASELINE_COPIES,
  BIG1K_COPIES,
  MEDIUM_SRC_MODULE_COUNT,
  buildReplicatedCorpus
} from "../src/gate3/corpus.js";

const MEDIUM_ROOT = resolve(__dirname, "../../../examples/medium");

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildReplicatedCorpus", () => {
  it("lays out copies under src/copyNN (not copyNN/src) and matches buildCorpusInputs's scan", () => {
    withTmpDir("gate3-corpus-layout-", (out) => {
      const result = buildReplicatedCorpus(MEDIUM_ROOT, out, 2);

      expect(existsSync(join(out, "src", "copy00"))).toBe(true);
      expect(existsSync(join(out, "src", "copy01"))).toBe(true);
      expect(existsSync(join(out, "copy00", "src"))).toBe(false);
      expect(existsSync(join(out, "copy01", "src"))).toBe(false);

      const inputs = buildCorpusInputs(result.corpusRoot);
      expect(inputs).toHaveLength(2 * MEDIUM_SRC_MODULE_COUNT);
      for (const input of inputs) {
        expect(input.path.startsWith("src/")).toBe(true);
        expect(input.path).not.toContain("..");
        expect(input.path).not.toContain("\\");
      }

      expect(result.moduleCount).toBe(2 * MEDIUM_SRC_MODULE_COUNT);
      expect(result.copies).toBe(2);

      const relPaths = new Set(inputs.map((i) => i.path));
      expect(relPaths.has(result.renameTarget.modulePath)).toBe(true);
      expect(result.renameTarget.declarationName).toBe("User");
      expect(result.renameTarget.newName).toBe("Account");
      const renameModuleText = inputs.find((i) => i.path === result.renameTarget.modulePath)!.text;
      expect(renameModuleText).toContain("interface User");

      const tsconfig = JSON.parse(readFileSync(join(result.corpusRoot, "tsconfig.json"), "utf8"));
      expect(tsconfig.include).toEqual(["src/**/*.ts"]);

      expect(existsSync(join(result.corpusRoot, "package.json"))).toBe(true);
    });
  });

  it("is deterministic: two builds produce identical digests", () => {
    withTmpDir("gate3-corpus-det-a-", (outA) =>
      withTmpDir("gate3-corpus-det-b-", (outB) => {
        const a = buildReplicatedCorpus(MEDIUM_ROOT, outA, 2);
        const b = buildReplicatedCorpus(MEDIUM_ROOT, outB, 2);

        expect(a.corpusDigest).toBe(b.corpusDigest);

        const inputsA = buildCorpusInputs(a.corpusRoot);
        const inputsB = buildCorpusInputs(b.corpusRoot);
        expect(inputsA.map((i) => i.path).sort()).toEqual(inputsB.map((i) => i.path).sort());
        const textByPathA = Object.fromEntries(inputsA.map((i) => [i.path, i.text]));
        const textByPathB = Object.fromEntries(inputsB.map((i) => [i.path, i.text]));
        expect(textByPathA).toEqual(textByPathB);
      })
    );
  });

  it("MEDIUM_SRC_MODULE_COUNT is derived by scanning examples/medium, not hard-coded", () => {
    expect(MEDIUM_SRC_MODULE_COUNT).toBe(buildCorpusInputs(MEDIUM_ROOT).length);
    expect(MEDIUM_SRC_MODULE_COUNT).toBeGreaterThan(0);
  });

  it("exposes the documented defaults", () => {
    expect(BIG1K_COPIES).toBe(46);
    expect(BASELINE_COPIES).toBe(1);
    expect(BIG1K_COPIES * MEDIUM_SRC_MODULE_COUNT).toBeGreaterThanOrEqual(1000);
  });

  it("baseline control (1 copy) builds and typechecks clean", () => {
    withTmpDir("gate3-corpus-baseline-", (out) => {
      const result = buildReplicatedCorpus(MEDIUM_ROOT, out, BASELINE_COPIES);
      expect(result.moduleCount).toBe(MEDIUM_SRC_MODULE_COUNT);

      const { tscClean, output } = tscNoEmitSrc(result.corpusRoot);
      expect(tscClean, output).toBe(true);
    });
  }, 60_000);
});

// Full-scale preflight: builds copies=BIG1K_COPIES (~1012 modules), runs
// tsc over the whole corpus, and serializes the kernel snapshot to check it
// stays under the bridge's 32 MiB max_request_bytes frame
// (crates/strata-kernel/src/bridge/process.rs:51).
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

describe("gate 3 full-scale preflight (BIG1K_COPIES)", () => {
  it(
    "1012-module corpus typechecks clean and the kernel snapshot fits the bridge frame",
    () => {
      withTmpDir("gate3-corpus-full-", (out) => {
        const buildStart = Date.now();
        const result = buildReplicatedCorpus(MEDIUM_ROOT, out, BIG1K_COPIES);
        const buildMs = Date.now() - buildStart;
        expect(result.moduleCount).toBe(BIG1K_COPIES * MEDIUM_SRC_MODULE_COUNT);

        const tscStart = Date.now();
        const { tscClean, output } = tscNoEmitSrc(result.corpusRoot);
        const tscMs = Date.now() - tscStart;
        // eslint-disable-next-line no-console
        console.log(
          `[gate3 preflight] moduleCount=${result.moduleCount} buildMs=${buildMs} tscMs=${tscMs} tscClean=${tscClean}`
        );
        expect(tscClean, output).toBe(true);

        const snapshotStart = Date.now();
        const snapshotBytes = Buffer.byteLength(
          JSON.stringify(createQualifiedKernelSnapshot(result.corpusRoot)),
          "utf8"
        );
        const snapshotMs = Date.now() - snapshotStart;
        // eslint-disable-next-line no-console
        console.log(
          `[gate3 preflight] snapshotBytes=${snapshotBytes} maxRequestBytes=${MAX_REQUEST_BYTES} snapshotMs=${snapshotMs}`
        );
        expect(snapshotBytes).toBeLessThan(MAX_REQUEST_BYTES);
      });
    },
    300_000
  );
});
