import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQualifiedTaskManifest } from "../src/tasks.js";
import { boundVerifierOutput, qualifyGenerationZero, verifyPhase6Tree } from "../src/verify.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
function copyCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), "strata-phase6-verify-"));
  temporary.push(root);
  cpSync(corpusRoot, root, { recursive: true });
  return root;
}
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("arm-neutral Phase-6 verifier", () => {
  it("proves generation zero for every exact registered packet configuration", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const reports = await qualifyGenerationZero({ treeRoot: corpusRoot, manifest });
    expect(reports.map((report) => report.packetId)).toEqual(["D", "M", "R", "S", "X", "G"]);
    for (const report of reports) {
      expect(report.green).toBe(true);
      expect(report.rootNames.every((name) => name.includes("/src/") && name.endsWith(".ts"))).toBe(true);
      expect(report.fixtureNames).toEqual(["phase6-invariant.mjs"]);
      expect(report.configurationDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 120_000);

  it("stops qualification when any generation-zero input, fixture, or boundary fact drifts", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const tree = copyCorpus();
    writeFileSync(join(tree, "tests/format.test.ts"), "// changed\n", "utf8");
    await expect(qualifyGenerationZero({ treeRoot: tree, manifest })).rejects.toThrow(/excluded historical input|frozen tree file/);
  });

  it("rejects configuration edits and unregistered files anywhere in the tree", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);

    const configEdit = copyCorpus();
    writeFileSync(
      join(configEdit, "tsconfig.json"),
      readFileSync(join(configEdit, "tsconfig.json"), "utf8").replace('"strict": true', '"strict": false'),
      "utf8"
    );
    await expect(verifyPhase6Tree({ treeRoot: configEdit, manifest, packetId: "D", generationZero: true }))
      .rejects.toThrow(/frozen tree file/);

    const packageEdit = copyCorpus();
    writeFileSync(join(packageEdit, "package.json"), "{}\n", "utf8");
    await expect(verifyPhase6Tree({ treeRoot: packageEdit, manifest, packetId: "D", generationZero: true }))
      .rejects.toThrow(/frozen tree file/);

    const strayFile = copyCorpus();
    writeFileSync(join(strayFile, "helper.mjs"), "export const cheat = true;\n", "utf8");
    await expect(verifyPhase6Tree({ treeRoot: strayFile, manifest, packetId: "D", generationZero: true }))
      .rejects.toThrow(/tree file listing/);

    const strayInSrc = copyCorpus();
    writeFileSync(join(strayInSrc, "src/extra.d.ts.bak"), "// stray\n", "utf8");
    await expect(verifyPhase6Tree({ treeRoot: strayInSrc, manifest, packetId: "D", generationZero: true }))
      .rejects.toThrow(/tree file listing|source root-name set/);

    const gitAndModules = copyCorpus();
    mkdirSync(join(gitAndModules, ".git"), { recursive: true });
    writeFileSync(join(gitAndModules, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
    mkdirSync(join(gitAndModules, "node_modules/x"), { recursive: true });
    writeFileSync(join(gitAndModules, "node_modules/x/index.js"), "module.exports = {};\n", "utf8");
    const report = await verifyPhase6Tree({ treeRoot: gitAndModules, manifest, packetId: "D", generationZero: true });
    expect(report.green).toBe(true);

    // A git WORKTREE has .git as a gitdir-pointer FILE, not a directory.
    // Live round 1 (2026-07-17, run-2026-07-17T04-40-47-222Z) stopped on
    // exactly this shape; it must verify green.
    const worktreeShaped = copyCorpus();
    writeFileSync(join(worktreeShaped, ".git"), "gitdir: /elsewhere/worktrees/integration\n", "utf8");
    const worktreeReport = await verifyPhase6Tree({ treeRoot: worktreeShaped, manifest, packetId: "S", generationZero: true });
    expect(worktreeReport.green).toBe(true);

    // Running the corpus's own install+test toolchain leaves exactly one
    // root lockfile (live round 3, run-2026-07-17T05-03-26-462Z stopped on
    // it); dependency-install exhaust must verify green while an edited
    // package.json still fails closed above.
    const installed = copyCorpus();
    writeFileSync(join(installed, ".git"), "gitdir: /elsewhere/worktrees/integration\n", "utf8");
    writeFileSync(join(installed, "package-lock.json"), '{"lockfileVersion": 3}\n', "utf8");
    const installedReport = await verifyPhase6Tree({ treeRoot: installed, manifest, packetId: "S", generationZero: true });
    expect(installedReport.green).toBe(true);
  }, 120_000);

  it("rejects noncanonical edits, unregistered source edits, and imprecise G defaults", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const historical = copyCorpus();
    writeFileSync(join(historical, "tests/dateRange.test.ts"), "// cheat\n", "utf8");
    await expect(verifyPhase6Tree({ treeRoot: historical, manifest, packetId: "D", generationZero: true })).rejects.toThrow(/excluded historical input/);

    const source = copyCorpus();
    writeFileSync(join(source, "src/lib/dateRange.ts"), `${readFileSync(join(source, "src/lib/dateRange.ts"), "utf8")}\n// cheat\n`, "utf8");
    await expect(verifyPhase6Tree({ treeRoot: source, manifest, packetId: "D", generationZero: false })).rejects.toThrow(/unexpected source change/);

    const wrongG = copyCorpus();
    const greet = join(wrongG, "src/users/greet.ts");
    writeFileSync(greet, readFileSync(greet, "utf8").replace("greet(user: User)", "greet(user: User, account: Account = null as never)"), "utf8");
    await expect(verifyPhase6Tree({ treeRoot: wrongG, manifest, packetId: "G", generationZero: false })).rejects.toThrow();

    const allowedFileCheat = copyCorpus();
    const user = join(allowedFileCheat, "src/types/user.ts");
    writeFileSync(user, readFileSync(user, "utf8").replace("email: string", "email: number"), "utf8");
    await expect(verifyPhase6Tree({ treeRoot: allowedFileCheat, manifest, packetId: "D", generationZero: false })).rejects.toThrow(/normalized delta/);

    const duplicateG = copyCorpus();
    const duplicateGreet = join(duplicateG, "src/users/greet.ts");
    writeFileSync(duplicateGreet, readFileSync(duplicateGreet, "utf8").replace("greet(user: User)", "greet(user: Account, account: Account = undefined as never, account: Account = undefined as never)"), "utf8");
    await expect(verifyPhase6Tree({ treeRoot: duplicateG, manifest, packetId: "G", generationZero: false })).rejects.toThrow();
  }, 60_000);

  it("accepts only the exact registered X final state", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const applyX = (root: string, defaultText: string): void => {
      const user = join(root, "src/types/user.ts");
      writeFileSync(user, readFileSync(user, "utf8").replace("function displayUser", "function formatUser"), "utf8");
      const serializer = join(root, "src/users/serializer.ts");
      writeFileSync(
        serializer,
        readFileSync(serializer, "utf8").replace(
          "serialize(user: UserTypes.User)",
          `serialize(user: UserTypes.User, displayLabel: string = ${defaultText})`
        ),
        "utf8"
      );
    };

    const exact = copyCorpus();
    applyX(exact, "UserTypes.formatUser(user)");
    const report = await verifyPhase6Tree({ treeRoot: exact, manifest, packetId: "X", generationZero: false });
    expect(report.green).toBe(true);

    const staleDefault = copyCorpus();
    applyX(staleDefault, "UserTypes.displayUser(user)");
    await expect(verifyPhase6Tree({ treeRoot: staleDefault, manifest, packetId: "X", generationZero: false })).rejects.toThrow();

    const duplicate = copyCorpus();
    applyX(duplicate, "UserTypes.formatUser(user), displayLabel: string = UserTypes.formatUser(user)");
    await expect(verifyPhase6Tree({ treeRoot: duplicate, manifest, packetId: "X", generationZero: false })).rejects.toThrow();

    const outsideStableId = copyCorpus();
    const user = join(outsideStableId, "src/types/user.ts");
    writeFileSync(user, readFileSync(user, "utf8").replace("function displayUser(user: User)", "function formatUser(user: User, displayLabel: string = user.email)"), "utf8");
    await expect(verifyPhase6Tree({ treeRoot: outsideStableId, manifest, packetId: "X", generationZero: false })).rejects.toThrow();
  }, 60_000);

  it("seals harness fixture digests and bounds captured output", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const drift = structuredClone(manifest);
    drift.packets.D.fixtureDigests["phase6-invariant.mjs"] = "0".repeat(64);
    await expect(verifyPhase6Tree({ treeRoot: corpusRoot, manifest: drift, packetId: "D", generationZero: true })).rejects.toThrow(/registration digest|fixture/);
    expect(Buffer.byteLength(boundVerifierOutput("x".repeat(100_000)))).toBeLessThanOrEqual(64 * 1024);
  });

  it("uses the identical source-only verifier for equivalent Strata and baseline trees", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const left = await verifyPhase6Tree({ treeRoot: corpusRoot, manifest, packetId: "D", generationZero: true, arm: "strata" });
    const right = await verifyPhase6Tree({ treeRoot: corpusRoot, manifest, packetId: "D", generationZero: true, arm: "baseline" });
    expect({
      packetId: left.packetId,
      rootNames: left.rootNames,
      compilerOptions: left.compilerOptions,
      fixtureNames: left.fixtureNames,
      fixtureDigests: left.fixtureDigests,
      sourceDigest: left.sourceDigest,
      finalTreeDigest: left.finalTreeDigest,
      configurationDigest: left.configurationDigest
    }).toEqual({
      packetId: right.packetId,
      rootNames: right.rootNames,
      compilerOptions: right.compilerOptions,
      fixtureNames: right.fixtureNames,
      fixtureDigests: right.fixtureDigests,
      sourceDigest: right.sourceDigest,
      finalTreeDigest: right.finalTreeDigest,
      configurationDigest: right.configurationDigest
    });
  }, 60_000);
});
