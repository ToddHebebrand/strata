import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";
import {
  MAX_DEADLINE_MS,
  MAX_RESPONSE_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseResponseFrame,
  serializeRequestFrame,
  type declarationKindFilterSchema,
  type LocalServiceRequest,
  type LocalServiceResponse
} from "./protocol.js";

const MAX_SOCKET_PATH_BYTES = 96;
const MAX_CLIENT_ID_BYTES = 512;
const MAX_MUTATION_ATTEMPTS = 2;
export const DEFAULT_REQUEST_DEADLINE_MS = 300_000;

const utf8 = new TextEncoder();

function boundedUtf8(maxBytes: number) {
  return z.string().min(1).refine((value) => utf8.encode(value).byteLength <= maxBytes);
}

export const coordinationClientConfigSchema = z
  .object({
    socketPath: boundedUtf8(MAX_SOCKET_PATH_BYTES),
    clientId: boundedUtf8(MAX_CLIENT_ID_BYTES)
  })
  .strict();

export type CoordinationClientConfig = z.infer<typeof coordinationClientConfigSchema>;
export type CoordinationResult = Extract<LocalServiceResponse, { ok: true }>["result"];
export type CoordinationIntent = Extract<
  LocalServiceRequest["action"],
  { type: "add_intent" }
>["intent"];

export class CoordinationClientError extends Error {
  readonly name = "CoordinationClientError";

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

class TransportFailure extends Error {
  constructor(
    readonly kind: "connect" | "disconnect" | "timeout" | "protocol",
    message: string
  ) {
    super(message);
  }
}

function isMutating(action: LocalServiceRequest["action"]): boolean {
  return ![
    "hello",
    "inspect_nodes",
    "find_declarations",
    "read_events",
    "read_operation"
  ].includes(action.type);
}

function validateDeadline(deadlineMs: number): void {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    BigInt(deadlineMs) > MAX_DEADLINE_MS
  ) {
    throw new CoordinationClientError(
      "invalid_deadline",
      "coordination deadline must be a positive integer within the protocol bound"
    );
  }
}

function redact(value: unknown, secrets: readonly string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  const longestFirst = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of longestFirst) {
    message = message.split(secret).join("[redacted]");
  }
  return message;
}

function requestOnce(
  socketPath: string,
  frame: Uint8Array,
  remainingMs: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let connected = false;
    let settled = false;

    const finish = (value: Uint8Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (failure: TransportFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(failure);
    };
    const timer = setTimeout(() => {
      fail(
        new TransportFailure(
          "timeout",
          connected ? "request deadline exceeded" : "connect deadline exceeded"
        )
      );
    }, Math.max(1, remainingMs));

    socket.once("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_FRAME_BYTES) {
        fail(new TransportFailure("protocol", "response frame exceeds byte bound"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => {
      const response = Buffer.concat(chunks);
      if (response.length === 0 || response[response.length - 1] !== 0x0a) {
        fail(new TransportFailure("disconnect", "connection ended during response"));
      } else {
        finish(response);
      }
    });
    socket.once("error", (error) => {
      fail(
        new TransportFailure(
          connected ? "disconnect" : "connect",
          error.message
        )
      );
    });
    socket.once("close", () => {
      if (!settled) {
        const response = Buffer.concat(chunks);
        if (response.length > 0 && response[response.length - 1] === 0x0a) {
          finish(response);
        } else {
          fail(new TransportFailure("disconnect", "connection closed during response"));
        }
      }
    });
  });
}

/**
 * A deliberately unprivileged, one-request-per-connection Unix-socket client.
 * Its only retained values are the local endpoint and opaque actor identity.
 */
export class CoordinationClient {
  readonly #socketPath: string;
  readonly #clientId: string;

  constructor(config: CoordinationClientConfig) {
    const parsed = coordinationClientConfigSchema.parse(config);
    this.#socketPath = parsed.socketPath;
    this.#clientId = parsed.clientId;
  }

  async request(
    action: LocalServiceRequest["action"],
    deadlineMs: number,
    options?: { idempotencyKey?: string }
  ): Promise<CoordinationResult> {
    validateDeadline(deadlineMs);
    const mutating = isMutating(action);
    const requestId = randomUUID();
    const request: LocalServiceRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      clientId: this.#clientId,
      deadlineMs: String(deadlineMs),
      // A caller-supplied key is reused verbatim (the crash suite replays the
      // exact request identity to assert the cached journal response); the
      // default stays a fresh random key per top-level request() call, and
      // retries within one call keep reusing whichever key was chosen here.
      ...(mutating ? { idempotencyKey: options?.idempotencyKey ?? randomUUID() } : {}),
      action
    } as LocalServiceRequest;
    const frame = serializeRequestFrame(request);
    const expiresAt = Date.now() + deadlineMs;
    const attempts = mutating ? MAX_MUTATION_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        throw new CoordinationClientError("request_timeout", "coordination request timed out");
      }
      try {
        const response = parseResponseFrame(
          await requestOnce(this.#socketPath, frame, remaining)
        );
        if (response.requestId !== requestId) {
          throw new CoordinationClientError(
            "response_binding_mismatch",
            "coordination response does not match its request"
          );
        }
        if (!response.ok) {
          throw new CoordinationClientError(
            response.error.code,
            redact(response.error.message, [this.#socketPath, this.#clientId]),
            response.error.retryable
          );
        }
        return response.result;
      } catch (caught) {
        if (
          caught instanceof TransportFailure &&
          caught.kind === "disconnect" &&
          mutating &&
          attempt + 1 < attempts
        ) {
          continue;
        }
        if (caught instanceof CoordinationClientError) throw caught;
        const kind = caught instanceof TransportFailure ? caught.kind : "protocol";
        const code =
          kind === "timeout"
            ? "request_timeout"
            : kind === "connect"
              ? "connect_failed"
              : kind === "disconnect"
                ? "connection_lost"
                : "invalid_response";
        throw new CoordinationClientError(
          code,
          redact(caught, [this.#socketPath, this.#clientId])
        );
      }
    }
    throw new CoordinationClientError("connection_lost", "coordination connection was lost");
  }

  hello(deadlineMs = DEFAULT_REQUEST_DEADLINE_MS): Promise<CoordinationResult> {
    return this.request({ type: "hello" }, deadlineMs);
  }

  inspectNodes(
    nodeIds: string[],
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "inspect_nodes", nodeIds }, deadlineMs);
  }

  findDeclarations(
    name: string,
    kind?: z.infer<typeof declarationKindFilterSchema>,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "find_declarations", name, ...(kind ? { kind } : {}) }, deadlineMs);
  }

  beginChangeSet(
    reasoning: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "begin_change_set", reasoning }, deadlineMs);
  }

  addIntent(
    changeSetId: string,
    intent: CoordinationIntent,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "add_intent", changeSetId, intent }, deadlineMs);
  }

  submitChangeSet(
    changeSetId: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "submit_change_set", changeSetId }, deadlineMs);
  }

  advanceChangeSet(
    changeSetId: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "advance_change_set", changeSetId }, deadlineMs);
  }

  readEvents(
    afterSequence: string,
    limit: number,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "read_events", afterSequence, limit }, deadlineMs);
  }

  ackEvents(
    throughSequence: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "ack_events", throughSequence }, deadlineMs);
  }

  cancelChangeSet(
    changeSetId: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "cancel_change_set", changeSetId }, deadlineMs);
  }

  readOperation(
    operationId: string,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "read_operation", operationId }, deadlineMs);
  }
}

export function createCoordinationClient(
  config: CoordinationClientConfig
): CoordinationClient {
  return new CoordinationClient(config);
}
