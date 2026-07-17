import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    await expect(qualifyGenerationZero({ treeRoot: tree, manifest })).rejects.toThrow(/excluded historical input/);
  });

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
  }, 15_000);
});
