import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const C = path.join(__dirname, "..", "corpus");

describe("lab corpus", () => {
  it("has the two per-scope ZONE constants and no others", () => {
    expect(fs.readFileSync(path.join(C, "src/server/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "UTC"/);
    expect(fs.readFileSync(path.join(C, "src/ui/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "local"/);
  });

  it("does NOT contain the literal \"local\" anywhere except ui/config.ts", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes('"local"'))
          hits.push(path.relative(C, p));
      }
    };
    walk(path.join(C, "src"));
    expect(hits).toEqual(["src/ui/config.ts"]);
  });

  it("has formatTimestamp( direct calls in all three HD branches: server, ui, and other", () => {
    const serverFiles: string[] = [];
    const uiFiles: string[] = [];
    const otherFiles: string[] = [];

    const serverRoot = path.join(C, "src/server") + path.sep;
    const uiRoot = path.join(C, "src/ui") + path.sep;

    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes("formatTimestamp(")) {
          if (p.startsWith(serverRoot)) serverFiles.push(path.relative(C, p));
          else if (p.startsWith(uiRoot)) uiFiles.push(path.relative(C, p));
          else otherFiles.push(path.relative(C, p));
        }
      }
    };
    walk(path.join(C, "src"));

    expect(serverFiles.length).toBeGreaterThanOrEqual(1);
    expect(uiFiles.length).toBeGreaterThanOrEqual(1);
    expect(otherFiles.length).toBeGreaterThanOrEqual(1);
  });
});
