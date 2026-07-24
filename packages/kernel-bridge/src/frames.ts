/**
 * Length-prefixed frame codec for the persistent bridge transport
 * (bridge-persistence slice, Task 4).
 *
 * Wire format — byte-for-byte the Rust host's (`bridge/persistent.rs`):
 * a u32 little-endian byte length, then exactly that many bytes of JSON.
 * Bounds stay asymmetric exactly as the one-shot path: the reader enforces
 * the request bound on worker-inbound frames, the writer the response bound
 * on worker-outbound frames. An oversized length prefix is a protocol
 * violation, not a recoverable frame: the reader throws without ever
 * buffering the body (mirroring the host reader's poison-on-oversize), and
 * the writer throws BEFORE writing anything, so a partial frame can never
 * reach the stream.
 */

/** Mirrors `MAX_REQUEST_FRAME_BYTES` in `crates/strata-kernel/src/bridge/process.rs`. */
export const MAX_REQUEST_FRAME_BYTES = 32 * 1024 * 1024;
/** Mirrors `MAX_RESPONSE_FRAME_BYTES` in `crates/strata-kernel/src/bridge/process.rs`. */
export const MAX_RESPONSE_FRAME_BYTES = 16 * 1024 * 1024;

const PREFIX_BYTES = 4;

/**
 * Yields one Buffer per complete frame, reassembling frames whose length
 * prefix or payload arrive split across arbitrary chunk boundaries. Ends
 * cleanly when the stream ends on a frame boundary (the worker's
 * shutdown-by-stdin-EOF contract); throws on an oversized length prefix or
 * on a stream that ends mid-frame.
 */
export async function* readFrames(
  stream: NodeJS.ReadableStream,
  maxFrameBytes: number
): AsyncGenerator<Buffer, void, undefined> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
    while (pending.length >= PREFIX_BYTES) {
      const length = pending.readUInt32LE(0);
      if (length > maxFrameBytes) {
        throw new Error(
          `frame length prefix of ${length} bytes exceeds the ${maxFrameBytes}-byte bound`
        );
      }
      if (pending.length < PREFIX_BYTES + length) break;
      // Copy the frame out so yielded buffers never alias the shared
      // `pending` accumulator the next concat would mutate around.
      const frame = Buffer.from(
        pending.subarray(PREFIX_BYTES, PREFIX_BYTES + length)
      );
      pending = pending.subarray(PREFIX_BYTES + length);
      yield frame;
    }
  }
  if (pending.length > 0) {
    throw new Error(
      `stream ended inside a frame (${pending.length} trailing bytes)`
    );
  }
}

/**
 * Writes one frame (prefix + payload) as a single buffer. Throws
 * synchronously on overflow before anything reaches the stream; otherwise
 * resolves when the stream has accepted the write.
 */
export function writeFrame(
  stream: NodeJS.WritableStream,
  payload: Buffer,
  maxFrameBytes: number
): Promise<void> {
  if (payload.length > maxFrameBytes) {
    throw new Error(
      `frame payload of ${payload.length} bytes exceeds the ${maxFrameBytes}-byte bound`
    );
  }
  const framed = Buffer.allocUnsafe(PREFIX_BYTES + payload.length);
  framed.writeUInt32LE(payload.length, 0);
  payload.copy(framed, PREFIX_BYTES);
  return new Promise((resolve, reject) => {
    stream.write(framed, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
