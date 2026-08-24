import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ProtocolV1Adapter,
  ProtocolV2Adapter,
  readLockSampleArtifact,
  summarizeLockArtifact,
  summarizeNanoseconds
} from "../src/lock-hold-workload.js";

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function stubServer(version: 1 | 2): Promise<{ path: string; frames: any[] }> {
  const root = mkdtempSync(join(tmpdir(), "strata-lock-workload-"));
  roots.push(root);
  const path = join(root, "service.sock");
  const frames: any[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    let opened = version === 1;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const delimiter = buffer.indexOf(0x0a);
        if (delimiter === -1) return;
        const frame = JSON.parse(buffer.subarray(0, delimiter).toString("utf8"));
        buffer = Buffer.from(buffer.subarray(delimiter + 1));
        frames.push(frame);
        if (!opened) {
          opened = true;
          socket.write(`${JSON.stringify({
            protocolVersion: 2,
            type: "session_opened",
            serviceEpoch: "1",
            validationMode: "tscOnly",
            validationManifestDigest: null,
            actor: frame.actor,
            role: frame.role
          })}\n`);
          continue;
        }
        socket.write(`${JSON.stringify({
          protocolVersion: version,
          requestId: frame.requestId,
          ok: true,
          result: {
            type: "ready",
            validationMode: "tscOnly",
            validationManifestDigest: null
          }
        })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, frames };
}

it("drives a protocol-v1 request on one handshake-free socket", async () => {
  const service = await stubServer(1);
  const adapter = new ProtocolV1Adapter(service.path, "actor:v1");
  await adapter.request("request:v1", { type: "hello" });
  expect(service.frames).toEqual([
    expect.objectContaining({
      protocolVersion: 1,
      requestId: "request:v1",
      clientId: "actor:v1",
      action: { type: "hello" }
    })
  ]);
});

it("drives protocol-v2 requests behind one observation-session handshake", async () => {
  const service = await stubServer(2);
  const adapter = new ProtocolV2Adapter(service.path, "actor:v2");
  await adapter.request("request:v2:1", { type: "hello" });
  await adapter.request("request:v2:2", { type: "hello" });
  adapter.close();
  expect(service.frames).toHaveLength(3);
  expect(service.frames[0]).toMatchObject({
    protocolVersion: 2,
    type: "open_session",
    actor: "actor:v2",
    role: "observation",
    connectionGeneration: "1"
  });
  expect(service.frames.slice(1).map((frame) => frame.requestId)).toEqual([
    "request:v2:1",
    "request:v2:2"
  ]);
});

it("parses bounded samples and computes exact nearest-rank distributions", () => {
  const root = mkdtempSync(join(tmpdir(), "strata-lock-artifact-"));
  roots.push(root);
  const path = join(root, "samples.bin");
  const bytes = Buffer.alloc(64 + 3 * 24);
  bytes.write("STRATALK", 0, "ascii");
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(64, 12);
  bytes.writeBigUInt64LE(3n, 16);
  bytes.writeBigUInt64LE(24n, 24);
  bytes.writeBigUInt64LE(3n, 32);
  bytes.writeBigUInt64LE(0n, 40);
  bytes.writeBigUInt64LE(10n, 48);
  bytes.writeBigUInt64LE(50n, 56);
  for (const [index, sample] of [
    [1, 10, 100],
    [1, 20, 200],
    [2, 30, 300]
  ].entries()) {
    const offset = 64 + index * 24;
    bytes.writeUInt32LE(sample[0], offset);
    bytes.writeBigUInt64LE(BigInt(sample[1]), offset + 8);
    bytes.writeBigUInt64LE(BigInt(sample[2]), offset + 16);
  }
  writeFileSync(path, bytes);

  const artifact = readLockSampleArtifact(path);
  expect(artifact.noop).toEqual({ iterations: 10, totalNs: 50, meanNs: 5 });
  expect(summarizeLockArtifact(artifact)["session.protocol"]).toEqual({
    wait: { count: 2, totalNs: 30, meanNs: 15, maxNs: 20, p50Ns: 10, p95Ns: 20, p99Ns: 20 },
    hold: { count: 2, totalNs: 300, meanNs: 150, maxNs: 200, p50Ns: 100, p95Ns: 200, p99Ns: 200 }
  });
  expect(summarizeNanoseconds(Array.from({ length: 100 }, (_, index) => index + 1))).toMatchObject({
    count: 100,
    totalNs: 5050,
    p50Ns: 50,
    p95Ns: 95,
    p99Ns: 99,
    maxNs: 100
  });
});
