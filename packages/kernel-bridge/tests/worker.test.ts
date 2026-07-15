import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata/ingest";
import { describe, expect, it } from "vitest";
import {
  bridgeResponseSchema,
  type AnalyzeIntentRequest,
  type BuildValidateCandidateRequest
} from "../src/index";
import {
  MAX_DIAGNOSTIC_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_STDERR_BYTES
} from "../src/worker";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "..");
const workerPath = path.join(packageRoot, "dist", "worker.js");
const workerUrl = pathToFileURL(workerPath).href;
const corpusRoot = path.resolve(currentDir, "../../../examples/medium");
const sourceRoot = path.join(corpusRoot, "src");

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

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

function mediumSnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(
    ingestBatch(loadCorpus(sourceRoot)),
    parseCanonicalU64("7")
  );
}

function declarationId(snapshot: KernelSnapshotV1, pattern: RegExp): string {
  const matches = snapshot.nodes.filter(
    (node) => node.parentId !== null && pattern.test(node.payload)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

function analyzeRequest(snapshot = mediumSnapshot()): AnalyzeIntentRequest {
  return {
    protocolVersion: 1,
    requestId: "worker-analyze-request",
    kind: "analyzeIntent",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot,
    intent: {
      schemaVersion: 1,
      intentId: "worker-analyze-intent",
      changeSetId: "worker-analyze-change-set",
      baseGeneration: snapshot.generation,
      parameters: {
        type: "renameSymbol",
        declarationId: declarationId(snapshot, /export interface User\s*\{/),
        newName: "Account"
      }
    }
  };
}

function candidateRequest(snapshot = mediumSnapshot()): BuildValidateCandidateRequest {
  const changeSetId = "worker-candidate-change-set";
  return {
    protocolVersion: 1,
    requestId: "worker-candidate-request",
    kind: "buildValidateCandidate",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot,
    attemptId: "worker-candidate-attempt",
    scopeFingerprint:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    changeSet: {
      changeSetId,
      actor: "worker-test-agent",
      reasoning: "prove one-shot candidate dispatch",
      orderedIntents: [
        {
          schemaVersion: 1,
          intentId: "worker-candidate-intent",
          changeSetId,
          baseGeneration: snapshot.generation,
          parameters: {
            type: "renameSymbol",
            declarationId: declarationId(snapshot, /export interface User\s*\{/),
            newName: "Account"
          }
        }
      ]
    },
    validationProfile: {
      mode: "tscOnly",
      sourceRoot,
      corpusRoot,
      behavioralFixtures: [],
      strictSrcOnlyTscScope: true
    }
  };
}

async function runProcess(
  input: string | Buffer,
  evaluation?: string
): Promise<ProcessResult> {
  const args = evaluation
    ? ["--input-type=module", "--eval", evaluation]
    : [workerPath];
  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
  });
}

function parseSingleFrame(result: ProcessResult): any {
  expect(result.stdout.at(-1)).toBe(0x0a);
  const text = result.stdout.toString("utf8");
  expect(text.split("\n")).toHaveLength(2);
  return bridgeResponseSchema.parse(JSON.parse(text.slice(0, -1)));
}

function injectedWorker(handlerSource: string): string {
  return `
    import { runOneShotWorker } from ${JSON.stringify(workerUrl)};
    const handler = ${handlerSource};
    await runOneShotWorker({ analyzeIntent: handler, buildValidateCandidate: handler });
  `;
}

describe("bounded one-shot worker", () => {
  it("pins the protocol and operational byte limits", () => {
    expect(MAX_REQUEST_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_DIAGNOSTIC_BYTES).toBe(64 * 1024);
    expect(MAX_STDERR_BYTES).toBe(64 * 1024);
  });

  it("emits exactly one newline-terminated analyze success frame", async () => {
    const result = await runProcess(JSON.stringify(analyzeRequest()));

    expect(result.code).toBe(0);
    expect(result.stderr).toHaveLength(0);
    const response = parseSingleFrame(result);
    expect(response).toMatchObject({
      requestId: "worker-analyze-request",
      kind: "analyzeIntent",
      ok: true
    });
  }, 30_000);

  it("emits exactly one newline-terminated candidate success frame", async () => {
    const result = await runProcess(JSON.stringify(candidateRequest()));

    expect(result.code).toBe(0);
    expect(result.stderr).toHaveLength(0);
    const response = parseSingleFrame(result);
    expect(response).toMatchObject({
      requestId: "worker-candidate-request",
      kind: "buildValidateCandidate",
      ok: true
    });
  }, 60_000);

  it.each([
    ["malformed", '{"protocolVersion":1'],
    ["extra object", `${JSON.stringify(analyzeRequest())}\n{}`],
    ["non-object", "[]"],
    ["unknown field", JSON.stringify({ ...analyzeRequest(), unexpected: true })]
  ])("fails boundedly for %s input", async (_label, input) => {
    const result = await runProcess(input);

    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_BYTES);
    const response = parseSingleFrame(result);
    expect(response.ok).toBe(false);
    expect(response.error.stage).toBe("protocol");
  }, 30_000);

  it("rejects oversized input before JSON parsing", async () => {
    const result = await runProcess(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x7b));

    expect(result.code).toBe(0);
    const response = parseSingleFrame(result);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("requestTooLarge");
    expect(response.error.code).not.toBe("invalidJson");
  }, 30_000);

  it("converts a thrown handler error to one bounded protocol frame", async () => {
    const result = await runProcess(
      JSON.stringify(analyzeRequest()),
      injectedWorker(`() => { throw new Error("handler exploded"); }`)
    );

    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_BYTES);
    const response = parseSingleFrame(result);
    expect(response).toMatchObject({
      requestId: "worker-analyze-request",
      ok: false,
      error: { stage: "analyze", code: "handlerFailed" }
    });
    expect(JSON.stringify(response)).not.toContain("at ");
  }, 30_000);

  it("converts oversized success output to a bounded protocol error", async () => {
    const result = await runProcess(
      JSON.stringify(analyzeRequest()),
      injectedWorker(`() => ({ facts: {
        type: "renameSymbol",
        declarationId: "x".repeat(${MAX_RESPONSE_BYTES + 1}),
        declarationNameIdentifierId: "name",
        references: [],
        writableStatementIds: [],
        validationDependencyNodeIds: [],
        validationDependencyReferenceFromNodeIds: []
      } })`)
    );

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    const response = parseSingleFrame(result);
    expect(response).toMatchObject({
      ok: false,
      error: { stage: "protocol", code: "responseTooLarge" }
    });
  }, 30_000);

  it("normalizes and deterministically truncates combined diagnostics", async () => {
    const handler = `() => ({
      stage: "validate",
      code: "typescriptFailed",
      message: " validation  failed ",
      diagnostics: [
        { nodeId: "node-a", modulePath: " src/a.ts ", message: "A\\n" + "é".repeat(50000), code: 1 },
        { nodeId: "node-b", modulePath: "src/b.ts", message: "B " + "z".repeat(50000), code: 2 }
      ]
    })`;
    const first = await runProcess(
      JSON.stringify(analyzeRequest()),
      injectedWorker(handler)
    );
    const second = await runProcess(
      JSON.stringify(analyzeRequest()),
      injectedWorker(handler)
    );

    const firstResponse = parseSingleFrame(first);
    const secondResponse = parseSingleFrame(second);
    expect(firstResponse).toEqual(secondResponse);
    const diagnosticBytes = firstResponse.error.diagnostics.reduce(
      (total: number, diagnostic: any) =>
        total +
        Buffer.byteLength(diagnostic.modulePath ?? "", "utf8") +
        Buffer.byteLength(diagnostic.message, "utf8"),
      0
    );
    expect(diagnosticBytes).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    expect(firstResponse.error.diagnostics[0]).toMatchObject({
      modulePath: "src/a.ts",
      code: 1
    });
    expect(firstResponse.error.diagnostics[0].message).not.toMatch(/[\n\r]/);
  }, 30_000);

  it("bounds operational stderr for an oversized thrown error", async () => {
    const result = await runProcess(
      JSON.stringify(analyzeRequest()),
      injectedWorker(`() => { throw new Error("x".repeat(${MAX_STDERR_BYTES * 2})); }`)
    );

    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_BYTES);
    expect(parseSingleFrame(result).ok).toBe(false);
  }, 30_000);
});
