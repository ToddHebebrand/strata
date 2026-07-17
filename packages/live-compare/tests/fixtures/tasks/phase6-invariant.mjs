import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the registered source projection is present and bounded", () => {
  const root = process.env.PHASE6_TREE;
  expect(root).toBeTruthy();
  const source = readFileSync(join(root, "src/lib/dateRange.ts"), "utf8");
  expect(source).toContain("export function isWithinRange");
  expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
});
