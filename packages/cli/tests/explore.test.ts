import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runExplore } from "../src/commands/explore";
import { runIngestBatch } from "../src/commands/ingestBatch";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");
const corpus = path.join(repoRoot, "examples", "medium");

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "strata-explore-"));
  tempDirs.push(dir);
  return path.join(dir, "corpus.db");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("strata explore commands (corpus-root ephemeral mode)", () => {
  it("modules lists ingested modules with ids and decl counts", async () => {
    const result = await runExplore(["modules", corpus]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lib/format.ts");
    // IDs are the join key between discovery and inspection commands.
    expect(result.stdout).toMatch(/[0-9a-f]{16}/);
  });

  it("ls is an alias for modules", async () => {
    const result = await runExplore(["ls", corpus]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("lib/format.ts");
  });

  it("exports resolves a module by path suffix and lists exports", async () => {
    const result = await runExplore(["exports", corpus, "lib/format.ts"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("formatTimestamp");
    expect(result.stdout).toMatch(/[0-9a-f]{16}/);
  });

  it("exports with an ambiguous suffix lists candidates and exits 1", async () => {
    const result = await runExplore(["exports", corpus, ".ts"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("lib/format.ts");
  });

  it("exports with a non-matching suffix exits 1 with a clear message", async () => {
    const result = await runExplore(["exports", corpus, "no-such-module.ts"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no module matching");
  });

  it("find locates a declaration by name with id, kind, and module", async () => {
    const result = await runExplore(["find", corpus, "User"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("User");
    expect(result.stdout).toContain("interface");
    expect(result.stdout).toMatch(/[0-9a-f]{16}/);
  });

  it("find --kind filters by declaration kind", async () => {
    const result = await runExplore(["find", corpus, "User", "--kind", "function"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no declarations");
  });

  it("find --json emits rows with id and kind", async () => {
    const result = await runExplore(["find", corpus, "User", "--json"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout) as { id: string; kind: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0]!.kind).toBe("InterfaceDeclaration");
  });

  it("show renders a found node's source text (the ID chain)", async () => {
    const found = await runExplore(["find", corpus, "User", "--json"]);
    const rows = JSON.parse(found.stdout) as { id: string }[];
    const result = await runExplore(["show", corpus, rows[0]!.id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("interface User");
  });

  it("show with an unknown id exits 1 and points at discovery commands", async () => {
    const result = await runExplore(["show", corpus, "deadbeef00000000"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no node with id");
    expect(result.stderr).toMatch(/find|modules/);
  });

  it("refs lists every reference to a declaration across modules", async () => {
    const found = await runExplore(["find", corpus, "User", "--json"]);
    const rows = JSON.parse(found.stdout) as { id: string }[];
    const result = await runExplore(["refs", corpus, rows[0]!.id]);
    expect(result.code).toBe(0);
    // User is referenced from multiple modules in examples/medium.
    const jsonResult = await runExplore(["refs", corpus, rows[0]!.id, "--json"]);
    const refs = JSON.parse(jsonResult.stdout) as {
      module: string;
      context: string;
    }[];
    expect(refs.length).toBeGreaterThanOrEqual(3);
    const modules = new Set(refs.map((r) => r.module));
    expect(modules.size).toBeGreaterThanOrEqual(2);
    // Context should show the first code line, not a JSDoc opener.
    for (const ref of refs) {
      expect(ref.context).not.toMatch(/^\/\*/);
    }
  });

  it("search degrades gracefully without embeddings", async () => {
    const result = await runExplore(["search", corpus, "date range helpers"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STRATA_EMBED_API_KEY");
    expect(result.stderr).toContain("strata embed");
  });

  it("a missing source path exits 1 with a clear error", async () => {
    const result = await runExplore(["modules", path.join(corpus, "nope-dir")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });
});

describe("strata explore dispatch (built cli)", () => {
  it("routes explore subcommands and groups help output", async () => {
    const { spawnSync } = await import("node:child_process");
    const cliJs = path.join(repoRoot, "packages/cli/dist/cli.js");

    const modules = spawnSync(
      process.execPath,
      [cliJs, "modules", corpus],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(modules.status).toBe(0);
    expect(modules.stdout).toContain("lib/format.ts");

    const help = spawnSync(process.execPath, [cliJs], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(help.status).toBe(1);
    const usage = `${help.stdout}${help.stderr}`;
    expect(usage).toContain("Explore");
    expect(usage).toContain("strata refs");
    expect(usage).toContain("strata agent");
  });
});

describe("strata explore commands (persisted db mode)", () => {
  it("resolves the same ids against a persisted db as against the corpus", async () => {
    const dbPath = tempDbPath();
    expect(runIngestBatch({ rootDir: corpus, dbPath }).ok).toBe(true);

    const fromCorpus = await runExplore(["find", corpus, "User", "--json"]);
    const fromDb = await runExplore(["find", dbPath, "User", "--json"]);
    const corpusRows = JSON.parse(fromCorpus.stdout) as { id: string }[];
    const dbRows = JSON.parse(fromDb.stdout) as { id: string }[];
    expect(dbRows.map((r) => r.id)).toEqual(corpusRows.map((r) => r.id));

    const show = await runExplore(["show", dbPath, dbRows[0]!.id]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("interface User");

    const modules = await runExplore(["modules", dbPath]);
    expect(modules.code).toBe(0);
    expect(modules.stdout).toContain("lib/format.ts");
  });
});
