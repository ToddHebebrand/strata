// Pins the module-granular validation dependency circle (decisions.md
// 2026-07-16, operator-amended M). Two appended same-module functions with no
// shared references and no shared referencing statements still serialize:
// the successor queues at submit and returns needs_decision after the first
// publishes, because validationDependencies pins every node of the seed's
// module. The follow-on kernel iteration that narrows the circle to
// statement-level resources must flip these assertions deliberately
// (ready/ready, both publish, zero fresh decisions) as its acceptance test.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probeSameModulePair } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterAll(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("module-granular validation circle (current analyzer behavior)", () => {
  it("serializes even fully independent same-module siblings", async () => {
    const copy = mkdtempSync(join(tmpdir(), "strata-m-mechanism-"));
    temporary.push(copy);
    cpSync(corpusRoot, copy, { recursive: true });
    const file = join(copy, "src/lib/dateRange.ts");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\nexport function probeAlpha(): number {\n  return 1;\n}\n\nexport function probeBeta(): string {\n  return "beta";\n}\n`,
      "utf8"
    );
    const result = await probeSameModulePair(copy, "probeAlpha", "probeAlphaRenamed", "probeBeta", "probeBetaRenamed");
    expect(result.submitStates).toEqual(["ready", "queued"]);
    expect(result.firstState).toBe("published");
    expect(result.secondState).toBe("needs_decision");
  }, 120_000);
});
