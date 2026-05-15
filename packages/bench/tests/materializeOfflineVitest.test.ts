import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeCorpus } from "../src/configs/baseline";

const CORPUS = path.resolve(__dirname, "../../../examples/medium");

describe("materializeCorpus offline vitest (BS15-D mechanism)", () => {
  it("symlinks node_modules so vitest resolves with no registry", () => {
    const { root } = materializeCorpus(CORPUS, { initGit: false });
    try {
      const nm = path.join(root, "node_modules");
      expect(existsSync(nm)).toBe(true);
      expect(lstatSync(nm).isSymbolicLink() || lstatSync(nm).isDirectory()).toBe(
        true
      );
      expect(existsSync(path.join(nm, "vitest"))).toBe(true);
      expect(existsSync(path.join(nm, "typescript"))).toBe(true);
      expect(existsSync(path.join(root, "vitest.config.ts"))).toBe(true);
      expect(existsSync(path.join(root, "tests", "dateRange.test.ts"))).toBe(
        true
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the corpus vitest suite from the temp tree offline", () => {
    const { root } = materializeCorpus(CORPUS, { initGit: false });
    try {
      const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
      const result = spawnSync(process.execPath, [vitestBin, "run"], {
        cwd: root,
        encoding: "utf8"
      });
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "EXCLUDES the end instant"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
