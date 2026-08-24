import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HEADER_BYTES = 64;
const SAMPLE_BYTES = 24;
const MAGIC = "STRATALK";

export interface LockSample {
  lockId: number;
  waitNs: number;
  holdNs: number;
}

export interface DistributionSummary {
  count: number;
  totalNs: number;
  meanNs: number;
  maxNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
}

export interface LockSampleArtifact {
  capacity: number;
  dropped: number;
  noop: { iterations: number; totalNs: number; meanNs: number };
  samples: LockSample[];
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds JavaScript's safe range`);
  return number;
}

export function readLockSampleArtifact(path: string): LockSampleArtifact {
  const bytes = readFileSync(path);
  if (bytes.byteLength < HEADER_BYTES || bytes.subarray(0, 8).toString("ascii") !== MAGIC) {
    throw new Error("invalid lock sample artifact header");
  }
  if (bytes.readUInt32LE(8) !== 1 || bytes.readUInt32LE(12) !== HEADER_BYTES) {
    throw new Error("unsupported lock sample artifact version");
  }
  const capacity = safeNumber(bytes.readBigUInt64LE(16), "capacity");
  if (safeNumber(bytes.readBigUInt64LE(24), "sample size") !== SAMPLE_BYTES) {
    throw new Error("unsupported lock sample size");
  }
  if (bytes.byteLength !== HEADER_BYTES + capacity * SAMPLE_BYTES) {
    throw new Error("lock sample artifact length does not match its header");
  }
  const written = safeNumber(bytes.readBigUInt64LE(32), "sample count");
  const dropped = safeNumber(bytes.readBigUInt64LE(40), "dropped count");
  const noopIterations = safeNumber(bytes.readBigUInt64LE(48), "noop iterations");
  const noopTotalNs = safeNumber(bytes.readBigUInt64LE(56), "noop total");
  const count = Math.min(written, capacity);
  const samples: LockSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * SAMPLE_BYTES;
    samples.push({
      lockId: bytes.readUInt32LE(offset),
      waitNs: safeNumber(bytes.readBigUInt64LE(offset + 8), "wait sample"),
      holdNs: safeNumber(bytes.readBigUInt64LE(offset + 16), "hold sample")
    });
  }
  return {
    capacity,
    dropped,
    noop: {
      iterations: noopIterations,
      totalNs: noopTotalNs,
      meanNs: noopIterations === 0 ? 0 : noopTotalNs / noopIterations
    },
    samples
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

export function summarizeNanoseconds(values: readonly number[]): DistributionSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const totalNs = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    totalNs,
    meanNs: sorted.length === 0 ? 0 : totalNs / sorted.length,
    maxNs: sorted.at(-1) ?? 0,
    p50Ns: percentile(sorted, 0.5),
    p95Ns: percentile(sorted, 0.95),
    p99Ns: percentile(sorted, 0.99)
  };
}

export function summarizeLockArtifact(artifact: LockSampleArtifact) {
  const names = new Map([
    [1, "session.protocol"],
    [2, "session.journal"],
    [3, "session.audit"]
  ]);
  return Object.fromEntries(
    [...names].map(([lockId, name]) => {
      const samples = artifact.samples.filter((sample) => sample.lockId === lockId);
      return [
        name,
        {
          wait: summarizeNanoseconds(samples.map((sample) => sample.waitNs)),
          hold: summarizeNanoseconds(samples.map((sample) => sample.holdNs))
        }
      ];
    })
  );
}

type Action =
  | { type: "hello" }
  | { type: "list_modules"; limit: 64 }
  | { type: "find_declarations"; name: "User"; kind: "interface" }
  | { type: "read_events"; afterSequence: "0"; limit: 64 };

const ACTIONS: readonly Action[] = [
  { type: "hello" },
  { type: "list_modules", limit: 64 },
  { type: "find_declarations", name: "User", kind: "interface" },
  { type: "read_events", afterSequence: "0", limit: 64 }
];

function expectedResultType(action: Action): string {
  switch (action.type) {
    case "hello": return "ready";
    case "list_modules": return "modules";
    case "find_declarations": return "declarations";
    case "read_events": return "events";
  }
}

function readFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const delimiter = buffer.indexOf(0x0a);
      if (delimiter === -1) return;
      cleanup();
      resolve(buffer.subarray(0, delimiter + 1));
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error("socket ended before a complete frame")); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function connect(path: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function assertReply(frame: Buffer, protocolVersion: 1 | 2, requestId: string, action: Action): void {
  const reply = JSON.parse(frame.toString("utf8")) as Record<string, unknown>;
  if (
    reply.protocolVersion !== protocolVersion ||
    reply.requestId !== requestId ||
    reply.ok !== true ||
    typeof reply.result !== "object" ||
    reply.result === null ||
    (reply.result as Record<string, unknown>).type !== expectedResultType(action)
  ) {
    throw new Error(
      `invalid ${protocolVersion === 1 ? "v1" : "v2"} workload reply for ${action.type}: ${JSON.stringify(reply)}`
    );
  }
}

interface Adapter {
  request(requestId: string, action: Action): Promise<void>;
  close(): void;
}

export class ProtocolV1Adapter implements Adapter {
  constructor(private readonly socketPath: string, private readonly actor: string) {}

  async request(requestId: string, action: Action): Promise<void> {
    const socket = await connect(this.socketPath);
    socket.write(`${JSON.stringify({
      protocolVersion: 1,
      requestId,
      clientId: this.actor,
      deadlineMs: "120000",
      action
    })}\n`);
    try {
      assertReply(await readFrame(socket), 1, requestId, action);
    } finally {
      socket.destroy();
    }
  }

  close(): void {}
}

export class ProtocolV2Adapter implements Adapter {
  private socket: Socket | null = null;

  constructor(private readonly socketPath: string, private readonly actor: string) {}

  private async connected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = await connect(this.socketPath);
    socket.write(`${JSON.stringify({
      protocolVersion: 2,
      type: "open_session",
      actor: this.actor,
      role: "observation",
      clientInstance: `${this.actor}:lock-workload`,
      connectionGeneration: "1"
    })}\n`);
    const reply = JSON.parse((await readFrame(socket)).toString("utf8")) as Record<string, unknown>;
    if (
      reply.protocolVersion !== 2 ||
      reply.type !== "session_opened" ||
      reply.actor !== this.actor ||
      reply.role !== "observation"
    ) {
      socket.destroy();
      throw new Error("invalid v2 workload handshake reply");
    }
    this.socket = socket;
    return socket;
  }

  async request(requestId: string, action: Action): Promise<void> {
    const socket = await this.connected();
    socket.write(`${JSON.stringify({
      protocolVersion: 2,
      requestId,
      clientId: this.actor,
      deadlineMs: "120000",
      action
    })}\n`);
    assertReply(await readFrame(socket), 2, requestId, action);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

export async function runLockHoldWorkload(options: {
  socketPath: string;
  protocolVersion: 1 | 2;
  actors: number;
  samplePath?: string;
  warmupCycles?: number;
  recordedCycles?: number;
}): Promise<void> {
  const warmupCycles = options.warmupCycles ?? 10;
  const recordedCycles = options.recordedCycles ?? 50;
  if (warmupCycles > 0 && options.samplePath === undefined) {
    throw new Error("samplePath is required so warmup samples can be discarded");
  }
  const adapters = Array.from({ length: options.actors }, (_, index) => {
    const actor = `lock-workload:${index.toString().padStart(2, "0")}`;
    const adapter: Adapter = options.protocolVersion === 1
      ? new ProtocolV1Adapter(options.socketPath, actor)
      : new ProtocolV2Adapter(options.socketPath, actor);
    return { actor, adapter };
  });
  const runCycles = async (cycles: number, phase: "warm" | "record") => {
    await Promise.all(adapters.map(async ({ actor, adapter }) => {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (let actionIndex = 0; actionIndex < ACTIONS.length; actionIndex += 1) {
          await adapter.request(
            `${actor}:${phase}:${cycle}:${actionIndex}`,
            ACTIONS[actionIndex]!
          );
        }
      }
    }));
  };
  try {
    await runCycles(warmupCycles, "warm");
    if (options.samplePath !== undefined) {
      const file = openSync(options.samplePath, "r+");
      try {
        // No request is active at this barrier. Reset only the atomic claimed
        // and dropped counters; recorded slots overwrite the warmup payloads.
        writeSync(file, Buffer.alloc(16), 0, 16, 32);
      } finally {
        closeSync(file);
      }
    }
    await runCycles(recordedCycles, "record");
  } finally {
    for (const { adapter } of adapters) adapter.close();
  }
}

export async function measureLockHoldArm(options: {
  binary: string;
  repoRoot: string;
  corpusRoot: string;
  snapshotPath: string;
  bridgeWorkerPath: string;
  stateDirectory: string;
  protocolVersion: 1 | 2;
  actors: number;
}): Promise<LockSampleArtifact> {
  mkdirSync(options.stateDirectory, { recursive: true });
  const samplePath = join(options.stateDirectory, "lock-samples.bin");
  const child = spawn(options.binary, [
    "serve",
    "--db", join(options.stateDirectory, "kernel.redb"),
    "--snapshot", options.snapshotPath,
    "--bridge-worker", options.bridgeWorkerPath,
    "--source-root", join(options.corpusRoot, "src"),
    "--corpus-root", options.corpusRoot,
    "--audit", join(options.stateDirectory, "audit.jsonl"),
    "--socket-token", `d3b-lock-${randomUUID()}`,
    "--lock-samples", samplePath
  ], { cwd: options.repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const readiness = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => {
      lines.close();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`instrumented service exited ${code}: ${Buffer.concat(stderr)}`));
    });
  });
  if (typeof readiness.socketPath !== "string" || readiness.protocolVersion !== options.protocolVersion) {
    child.kill("SIGTERM");
    throw new Error("instrumented service returned incompatible readiness");
  }
  try {
    await runLockHoldWorkload({
      socketPath: readiness.socketPath,
      protocolVersion: options.protocolVersion,
      actors: options.actors,
      samplePath
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
  return readLockSampleArtifact(samplePath);
}
