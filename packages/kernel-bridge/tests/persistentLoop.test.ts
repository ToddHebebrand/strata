import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyzeIntentRequest } from "../src/index";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "..");
const workerPath = path.join(packageRoot, "dist", "worker.js");

/**
 * Test-side mirror of the Rust host's transport (persistent.rs): u32 LE
 * length-prefixed JSON frames over the worker's stdio, strictly one response
 * awaited per request.
 */
class FrameClient {
  private pending = Buffer.alloc(0);
  private readonly frames: Buffer[] = [];
  private readonly waiters: {
    resolve: (frame: Buffer) => void;
    reject: (error: Error) => void;
  }[] = [];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: Buffer[] = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE(0);
        if (this.pending.length < 4 + length) break;
        const frame = this.pending.subarray(4, 4 + length);
        this.pending = this.pending.subarray(4 + length);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(frame);
        else this.frames.push(frame);
      }
    });
    child.stdout.on("end", () => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error("worker stdout ended while awaiting a frame"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.exit = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([prefix, body]));
  }

  async nextResponse(): Promise<any> {
    const frame =
      this.frames.shift() ??
      (await new Promise<Buffer>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      }));
    return JSON.parse(frame.toString("utf8"));
  }

  /** One full request/response trip: no other frame may arrive in between. */
  async roundTrip(value: unknown): Promise<any> {
    expect(this.frames).toHaveLength(0);
    this.send(value);
    const response = await this.nextResponse();
    expect(this.frames).toHaveLength(0);
    return response;
  }
}

function spawnPersistentWorker(extraArgs: string[] = []): FrameClient {
  const child = spawn(process.execPath, [workerPath, "--persistent", ...extraArgs], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new FrameClient(child);
}

function tinySnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(
    ingestBatch([
      {
        path: "main.ts",
        text: 'export interface User {\n  id: string;\n}\n\nexport const current: User = { id: "u1" };\n'
      }
    ]),
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

function analyzeRequest(requestId: string): AnalyzeIntentRequest {
  const snapshot = tinySnapshot();
  return {
    protocolVersion: 1,
    requestId,
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
      intentId: `${requestId}-intent`,
      changeSetId: `${requestId}-change-set`,
      baseGeneration: snapshot.generation,
      parameters: {
        type: "renameSymbol",
        declarationId: declarationId(snapshot, /export interface User\s*\{/),
        newName: "Account"
      }
    }
  };
}

describe("persistent worker loop", () => {
  let client: FrameClient | undefined;

  afterEach(() => {
    client?.child.kill();
    client = undefined;
  });

  it(
    "serves correlated requests strictly serially, survives per-request errors, and acks shutdown",
    async () => {
      client = spawnPersistentWorker();

      // Two sequential correlated semantic requests: each response carries
      // its own requestId and arrives before the next request is sent.
      const first = await client.roundTrip(analyzeRequest("persistent-req-0"));
      expect(first).toMatchObject({
        requestId: "persistent-req-0",
        kind: "analyzeIntent",
        ok: true
      });
      const second = await client.roundTrip(analyzeRequest("persistent-req-1"));
      expect(second).toMatchObject({
        requestId: "persistent-req-1",
        kind: "analyzeIntent",
        ok: true
      });

      // sync is Task 6: a structured unsupported error, not a crash.
      const sync = await client.roundTrip({
        requestId: "persistent-req-2",
        kind: "sync",
        target: { generation: "8", digest: "d".repeat(64) }
      });
      expect(sync).toMatchObject({
        requestId: "persistent-req-2",
        kind: "error",
        code: "unsupported"
      });

      // Unknown kinds get an error frame with the same requestId.
      const unknown = await client.roundTrip({
        requestId: "persistent-req-3",
        kind: "definitely-not-a-frame-kind"
      });
      expect(unknown).toMatchObject({
        requestId: "persistent-req-3",
        kind: "error"
      });

      // A request the semantic schema rejects errors THAT request only; the
      // loop keeps serving (the next round-trip below succeeds).
      const invalid = await client.roundTrip({
        requestId: "persistent-req-4",
        kind: "analyzeIntent",
        unexpected: true
      });
      expect(invalid.requestId).toBe("persistent-req-4");
      expect(invalid.ok ?? false).toBe(false);

      const recovered = await client.roundTrip(analyzeRequest("persistent-req-5"));
      expect(recovered).toMatchObject({
        requestId: "persistent-req-5",
        ok: true
      });

      // shutdown: ack frame, then clean exit 0.
      const ack = await client.roundTrip({
        requestId: "persistent-req-6",
        kind: "shutdown"
      });
      expect(ack).toEqual({
        requestId: "persistent-req-6",
        kind: "shutdownAck"
      });
      const exit = await client.exit;
      expect(exit).toEqual({ code: 0, signal: null });
    },
    60_000
  );

  it("records per-request stage metrics when --emit-metrics is in argv", async () => {
    client = spawnPersistentWorker(["--emit-metrics"]);

    const first = await client.roundTrip(analyzeRequest("metrics-req-0"));
    const second = await client.roundTrip(analyzeRequest("metrics-req-1"));
    for (const response of [first, second]) {
      expect(response.ok).toBe(true);
      expect(response.metrics).toBeDefined();
      expect(response.metrics.totalNs).toBeGreaterThan(0);
    }

    client.send({ requestId: "metrics-req-2", kind: "shutdown" });
    await client.nextResponse();
    expect((await client.exit).code).toBe(0);
  }, 60_000);

  it("exits 0 on stdin EOF without a shutdown frame", async () => {
    client = spawnPersistentWorker();

    const response = await client.roundTrip(analyzeRequest("eof-req-0"));
    expect(response.requestId).toBe("eof-req-0");
    client.child.stdin.end();

    const exit = await client.exit;
    expect(exit).toEqual({ code: 0, signal: null });
  }, 60_000);
});
