import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateBaseline,
  type BaselineVerdict,
  type BridgeErrorPayload,
  type ValidateBaselineRequest
} from "../src/index";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(currentDir, "../../../examples/medium");
const temporaryRoots: string[] = [];

function loadCorpus(root: string): { path: string; text: string }[] {
  const modules: { path: string; text: string }[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        modules.push({ path: absolutePath, text: readFileSync(absolutePath, "utf8") });
      }
    }
  }
  walk(root);
  return modules;
}

/**
 * A private copy of `examples/medium` plus the three baseline fixtures the
 * gate is exercised against. A stale vitest cache (node_modules/.vite) in the
 * shared corpus breaks a spawned run in a scratch copy, so node_modules is
 * never copied.
 */
function baselineMedium(): {
  corpusRoot: string;
  sourceRoot: string;
  snapshot: KernelSnapshotV1;
} {
  const root = mkdtempSync(path.join(tmpdir(), "strata-baseline-medium-"));
  temporaryRoots.push(root);
  cpSync(corpusRoot, root, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules"
  });
  writeFileSync(
    path.join(root, "tests", "baseline-green.test.ts"),
    'import { expect, it } from "vitest";\n' +
      'import { greet } from "../src/users/greet.ts";\n' +
      'it("pins the seed corpus behavior", () => {\n' +
      '  expect(greet({ id: "1", email: "seed@example.test" })).toBe("hello seed@example.test");\n' +
      "});\n"
  );
  writeFileSync(
    path.join(root, "tests", "baseline-red.test.ts"),
    'import { expect, it } from "vitest";\n' +
      'import { greet } from "../src/users/greet.ts";\n' +
      'it("asserts a property the seed corpus does not have", () => {\n' +
      '  expect(greet({ id: "1", email: "seed@example.test" })).toBe("SEED_BASELINE_IS_RED");\n' +
      "});\n"
  );
  writeFileSync(
    path.join(root, "tests", "baseline-hanging.test.ts"),
    'import { spawn } from "node:child_process";\n' +
      'import { it } from "vitest";\n' +
      'it("outlasts the baseline budget", async () => {\n' +
      '  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
      "  await new Promise((resolve) => setTimeout(resolve, 45_000));\n" +
      "}, 90_000);\n"
  );
  const src = path.join(root, "src");
  return {
    corpusRoot: root,
    sourceRoot: src,
    snapshot: toKernelSnapshot(ingestBatch(loadCorpus(src)), parseCanonicalU64("7"))
  };
}

function baselineRequest(
  fixture: { corpusRoot: string; sourceRoot: string; snapshot: KernelSnapshotV1 },
  behavioralFixtures: string[],
  vitestTimeoutMs = 120_000
): ValidateBaselineRequest {
  return {
    protocolVersion: 1,
    requestId: "baseline-request",
    kind: "validateBaseline",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: fixture.snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot: fixture.snapshot,
    validationProfile: {
      mode: "behavioral",
      sourceRoot: fixture.sourceRoot,
      corpusRoot: fixture.corpusRoot,
      behavioralFixtures,
      strictSrcOnlyTscScope: true,
      tscTimeoutMs: 120_000,
      vitestTimeoutMs
    }
  };
}

function expectVerdict(
  outcome: BaselineVerdict | BridgeErrorPayload
): BaselineVerdict {
  if (!("green" in outcome)) {
    throw new Error(`expected a baseline verdict, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectFailure(
  outcome: BaselineVerdict | BridgeErrorPayload
): BridgeErrorPayload {
  if ("green" in outcome) {
    throw new Error(`expected a baseline failure, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("seed-green baseline validation", () => {
  it("reports green for a type-clean corpus whose scoped fixture passes", async () => {
    const fixture = baselineMedium();

    const verdict = expectVerdict(
      await validateBaseline(
        baselineRequest(fixture, ["tests/baseline-green.test.ts"])
      )
    );

    expect(verdict.green).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
  }, 180_000);

  it("reports red with the vitest failure text when a scoped fixture fails", async () => {
    const fixture = baselineMedium();

    const verdict = expectVerdict(
      await validateBaseline(
        baselineRequest(fixture, ["tests/baseline-red.test.ts"])
      )
    );

    expect(verdict.green).toBe(false);
    expect(verdict.diagnostics.length).toBeGreaterThan(0);
    // The daemon prints only the LEADING diagnostic lines before it refuses to
    // serve, so the actionable text has to survive that prefix — assert
    // against the same eight lines the refusal surface shows.
    const leading = verdict.diagnostics
      .slice(0, 8)
      .map((entry) => entry.message)
      .join("\n");
    expect(leading).toContain("baseline-red.test.ts");
    expect(leading).toContain("SEED_BASELINE_IS_RED");
  }, 180_000);

  it("fails operationally with vitestTimedOut when a fixture outruns the budget", async () => {
    const fixture = baselineMedium();

    const error = expectFailure(
      await validateBaseline(
        baselineRequest(fixture, ["tests/baseline-hanging.test.ts"], 1_500)
      )
    );

    expect(error.stage).toBe("validate");
    expect(error.code).toBe("vitestTimedOut");
  }, 180_000);

  it("runs a tsc-only baseline with no fixtures and stays green", async () => {
    const fixture = baselineMedium();
    const request = baselineRequest(fixture, []);
    request.validationProfile = {
      mode: "tscOnly",
      sourceRoot: fixture.sourceRoot,
      corpusRoot: fixture.corpusRoot,
      behavioralFixtures: [],
      strictSrcOnlyTscScope: true,
      tscTimeoutMs: 120_000,
      vitestTimeoutMs: 120_000
    };

    const verdict = expectVerdict(await validateBaseline(request));

    expect(verdict.green).toBe(true);
  }, 180_000);

  it("reports red for a tsc-only baseline over a corpus with a type error", async () => {
    const fixture = baselineMedium();
    writeFileSync(
      path.join(fixture.sourceRoot, "users", "broken.ts"),
      "export const broken: number = 'not a number';\n"
    );
    const request = baselineRequest(fixture, []);
    request.snapshot = toKernelSnapshot(
      ingestBatch(loadCorpus(fixture.sourceRoot)),
      parseCanonicalU64("7")
    );
    request.binding = {
      ...request.binding,
      graphGeneration: request.snapshot.generation
    };
    request.validationProfile = {
      mode: "tscOnly",
      sourceRoot: fixture.sourceRoot,
      corpusRoot: fixture.corpusRoot,
      behavioralFixtures: [],
      strictSrcOnlyTscScope: true,
      tscTimeoutMs: 120_000,
      vitestTimeoutMs: 120_000
    };

    const verdict = expectVerdict(await validateBaseline(request));

    expect(verdict.green).toBe(false);
    const text = verdict.diagnostics.map((entry) => entry.message).join("\n");
    expect(text).toContain("broken.ts");
  }, 180_000);
});
