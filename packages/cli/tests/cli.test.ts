import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

describe("strata cli", () => {
  it("round-trips the phase 0 sample", () => {
    const result = spawnSync(
      process.execPath,
      ["packages/cli/dist/cli.js", "roundtrip", "examples/phase0-sample.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(`${result.stdout}${result.stderr}`).toContain("Round-trip succeeded");
    expect(result.status).toBe(0);
  });
});
