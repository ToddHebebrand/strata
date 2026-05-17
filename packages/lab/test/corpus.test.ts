import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const C = path.join(__dirname, "..", "corpus");

// Matches a function/const/let/var declaration of formatTimestamp (not a callsite).
const DECL = /(?:export\s+)?(?:function|const|let|var)\s+formatTimestamp[\s(<]/;

/**
 * Returns true only if the file content contains a genuine formatTimestamp(
 * callsite — i.e. at least one line that contains the string but is NOT the
 * declaration line.
 */
function hasFormatTimestampCallsite(content: string): boolean {
  return content
    .split("\n")
    .some((line) => line.includes("formatTimestamp(") && !DECL.test(line));
}

/**
 * Recursively collect all .ts files under `dir`.
 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("lab corpus", () => {
  it("has the two per-scope ZONE constants and no others", () => {
    // Presence checks.
    expect(fs.readFileSync(path.join(C, "src/server/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "UTC"/);
    expect(fs.readFileSync(path.join(C, "src/ui/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "local"/);

    // Exclusivity check: no other src file may export a ZONE constant.
    const zoneFiles = walkTs(path.join(C, "src"))
      .filter((p) => fs.readFileSync(p, "utf8").includes("export const ZONE"))
      .map((p) => path.relative(C, p));

    expect(zoneFiles.sort()).toEqual(
      ["src/server/config.ts", "src/ui/config.ts"].sort()
    );
  });

  it("does NOT contain the literal \"local\" anywhere except ui/config.ts", () => {
    const hits = walkTs(path.join(C, "src"))
      .filter((p) => fs.readFileSync(p, "utf8").includes('"local"'))
      .map((p) => path.relative(C, p));

    expect(hits).toEqual(["src/ui/config.ts"]);
  });

  it("has formatTimestamp( direct calls in all three HD branches: server, ui, and other", () => {
    const serverFiles: string[] = [];
    const uiFiles: string[] = [];
    const otherFiles: string[] = [];

    const serverRoot = path.join(C, "src/server") + path.sep;
    const uiRoot = path.join(C, "src/ui") + path.sep;

    for (const p of walkTs(path.join(C, "src"))) {
      const content = fs.readFileSync(p, "utf8");
      if (!hasFormatTimestampCallsite(content)) continue;

      const rel = path.relative(C, p);
      if (p.startsWith(serverRoot)) serverFiles.push(rel);
      else if (p.startsWith(uiRoot)) uiFiles.push(rel);
      else otherFiles.push(rel);
    }

    expect(serverFiles.length).toBeGreaterThanOrEqual(1);
    expect(uiFiles.length).toBeGreaterThanOrEqual(1);
    expect(otherFiles.length).toBeGreaterThanOrEqual(1);
  });
});
