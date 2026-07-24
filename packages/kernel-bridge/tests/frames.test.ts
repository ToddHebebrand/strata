import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  readFrames,
  writeFrame
} from "../src/frames";

const SMALL_BOUND = 1024;

function frameBytes(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

async function collectFrames(
  stream: NodeJS.ReadableStream,
  maxFrameBytes: number
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for await (const frame of readFrames(stream, maxFrameBytes)) {
    frames.push(frame);
  }
  return frames;
}

describe("length-prefixed frame codec", () => {
  it("pins the bounds to the Rust host constants", () => {
    // MAX_REQUEST_FRAME_BYTES / MAX_RESPONSE_FRAME_BYTES in
    // crates/strata-kernel/src/bridge/process.rs.
    expect(MAX_REQUEST_FRAME_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_RESPONSE_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });

  it("round-trips written frames, including back-to-back frames", async () => {
    const stream = new PassThrough();
    const first = Buffer.from(JSON.stringify({ requestId: "p0", kind: "noop" }));
    const second = Buffer.from("second frame payload");
    await writeFrame(stream, first, SMALL_BOUND);
    await writeFrame(stream, second, SMALL_BOUND);
    stream.end();

    const frames = await collectFrames(stream, SMALL_BOUND);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.equals(first)).toBe(true);
    expect(frames[1]!.equals(second)).toBe(true);
  });

  it("round-trips a zero-length frame", async () => {
    const stream = new PassThrough();
    await writeFrame(stream, Buffer.alloc(0), SMALL_BOUND);
    stream.end();

    const frames = await collectFrames(stream, SMALL_BOUND);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(0);
  });

  it("reassembles a length prefix split across 1-byte chunks", async () => {
    const stream = new PassThrough();
    const payload = Buffer.from("prefix split one byte at a time");
    const encoded = frameBytes(payload);
    const collected = collectFrames(stream, SMALL_BOUND);
    for (const byte of encoded) {
      stream.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    stream.end();

    const frames = await collected;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.equals(payload)).toBe(true);
  });

  it("reassembles a payload split across chunks", async () => {
    const stream = new PassThrough();
    const payload = Buffer.from("a".repeat(64) + "b".repeat(64));
    const encoded = frameBytes(payload);
    const collected = collectFrames(stream, SMALL_BOUND);
    stream.write(encoded.subarray(0, 4)); // complete prefix
    await new Promise((resolve) => setImmediate(resolve));
    stream.write(encoded.subarray(4, 40)); // partial payload
    await new Promise((resolve) => setImmediate(resolve));
    stream.write(encoded.subarray(40));
    stream.end();

    const frames = await collected;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.equals(payload)).toBe(true);
  });

  it("throws when a length prefix exceeds the bound, without buffering the body", async () => {
    const stream = new PassThrough();
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(SMALL_BOUND + 1, 0);
    stream.write(prefix);
    stream.end();

    await expect(collectFrames(stream, SMALL_BOUND)).rejects.toThrow(
      /exceeds/
    );
  });

  it("throws when the stream ends inside a frame", async () => {
    const stream = new PassThrough();
    const encoded = frameBytes(Buffer.from("truncated"));
    stream.write(encoded.subarray(0, encoded.length - 2));
    stream.end();

    await expect(collectFrames(stream, SMALL_BOUND)).rejects.toThrow(
      /ended inside/
    );
  });

  it("throws on write overflow before writing anything", () => {
    const stream = new PassThrough();
    const oversized = Buffer.alloc(SMALL_BOUND + 1);

    expect(() => writeFrame(stream, oversized, SMALL_BOUND)).toThrow(/exceeds/);
    stream.end();
    expect(stream.read()).toBeNull();
  });
});
