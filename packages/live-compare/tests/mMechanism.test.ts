// Acceptance probe for the validation-circle narrowing (spec
// docs/superpowers/specs/2026-07-17-validation-circle-narrowing-design.md,
// flipping the 2026-07-16 module-granularity pin as that decision entry
// anticipated). Two appended same-module functions with no shared references
// and no shared referencing statements are byte-disjoint work: both submit
// ready, both publish with zero fresh decisions, and both publication orders
// converge to the same final graph digest. Every publication passed the
// service's tsc candidate gate, so `published` implies a green tree.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probeSameModulePair } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterAll(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("statement-granular validation circle", () => {
  it("publishes fully independent same-module siblings concurrently in both orders", async () => {
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
    for (const order of result.orders) {
      expect(order.submitStates).toEqual(["ready", "ready"]);
      expect(order.leaderState).toBe("published");
      expect(order.followerState).toBe("published");
      expect(order.freshDecisions).toBe(0);
      expect(Number(order.finalGeneration)).toBe(2);
    }
    expect(result.orders[0]!.finalGraphDigest).toBeTruthy();
    expect(result.orders[0]!.finalGraphDigest).toBe(result.orders[1]!.finalGraphDigest);
  }, 240_000);
});
