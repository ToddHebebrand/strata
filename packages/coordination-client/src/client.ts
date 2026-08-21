import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import {
  MAX_DEADLINE_MS,
  MAX_RESPONSE_FRAME_BYTES,
  PROTOCOL_VERSION,
  isMutatingAction,
  laneForAction,
  parseResponseFrame,
  parseSessionReplyFrame,
  serializeOpenSessionFrame,
  serializeRequestFrame,
  type declarationKindFilterSchema,
  type LocalServiceRequest,
  type LocalServiceResponse,
  type SessionRole
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
    /**
     * `unsent` is distinct from `timeout` on purpose: it is the ONE kind that
     * guarantees no bytes reached the daemon, so nothing durable can have
     * happened. The retry contract leans on that guarantee.
     */
    readonly kind: "connect" | "disconnect" | "timeout" | "protocol" | "unsent",
    message: string
  ) {
    super(message);
  }
}

function isMutating(action: LocalServiceRequest["action"]): boolean {
  return isMutatingAction(action.type);
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

/**
 * One persistent, serial connection for one lane.
 *
 * Three properties matter here and none of them are free:
 *
 * 1. **Strictly one outstanding frame.** Every exchange goes through `#tail`,
 *    a promise chain, so a second `send` on the same lane is not written until
 *    the first response has arrived. This is NOT defensive coding against a
 *    hypothetical caller: `createCoordinationToolServer` hands one client to
 *    all fifteen MCP tool handlers, and the agent SDK may emit several tool
 *    calls in a single assistant message. The SDK ships minified, so its
 *    dispatch ordering cannot be read from source -- which is precisely why
 *    the queue lives here rather than being assumed of the SDK.
 *
 * 2. **Queue wait is not free time.** A request waiting behind another counts
 *    that wait against its ORIGINAL wall-clock deadline, and one whose
 *    deadline expires while queued fails UNSENT rather than being written
 *    late. "Unsent" is load-bearing for the retry contract.
 *
 * 3. **Per-FRAME byte accounting.** The bound is checked against bytes since
 *    the last delimiter, not bytes since connect, so a long-lived session is
 *    not eventually killed by the sum of its own successful responses.
 */
class LaneConnection {
  readonly #socketPath: string;
  readonly #actor: string;
  readonly #clientInstance: string;
  readonly #role: SessionRole;

  #socket: Socket | null = null;
  /** Monotonic per lane, and never reused: it is what the daemon's ownership
   * rule compares to decide a reconnect from the same instance supersedes its
   * predecessor. */
  #generation = 0n;
  /** Bytes received since the last frame delimiter -- see property 3 above. */
  #buffer: Buffer = Buffer.alloc(0);
  #waiter: {
    resolve: (frame: Uint8Array) => void;
    reject: (failure: TransportFailure) => void;
  } | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    socketPath: string,
    actor: string,
    clientInstance: string,
    role: SessionRole
  ) {
    this.#socketPath = socketPath;
    this.#actor = actor;
    this.#clientInstance = clientInstance;
    this.#role = role;
  }

  /** Queues one request/response exchange behind any already in flight. */
  send(frame: Uint8Array, expiresAt: number): Promise<Uint8Array> {
    const exchange = this.#tail.then(
      () => this.#exchange(frame, expiresAt),
      () => this.#exchange(frame, expiresAt)
    );
    // The tail must never reject, or one failed request would poison every
    // request queued behind it.
    this.#tail = exchange.catch(() => undefined);
    return exchange;
  }

  /** Idempotent. Safe to call twice, and safe to call with nothing open. */
  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#failWaiter(new TransportFailure("disconnect", "client closed the connection"));
    socket?.destroy();
  }

  async #exchange(frame: Uint8Array, expiresAt: number): Promise<Uint8Array> {
    if (this.#closed) {
      throw new TransportFailure("unsent", "client is closed");
    }
    if (Date.now() >= expiresAt) {
      // Never written. The retry contract treats this as a clean miss.
      throw new TransportFailure("unsent", "deadline expired while queued");
    }
    const socket = await this.#connected(expiresAt);
    socket.write(frame);
    return await this.#awaitFrame(expiresAt, "request deadline exceeded");
  }

  /** Lazily connects and handshakes; reuses a live socket. */
  async #connected(expiresAt: number): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return this.#socket;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const pending = createConnection({ path: this.#socketPath });
      const timer = setTimeout(() => {
        pending.destroy();
        reject(new TransportFailure("timeout", "connect deadline exceeded"));
      }, Math.max(1, expiresAt - Date.now()));
      pending.once("connect", () => {
        clearTimeout(timer);
        resolve(pending);
      });
      pending.once("error", (error) => {
        clearTimeout(timer);
        reject(new TransportFailure("connect", error.message));
      });
    });

    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) =>
      this.#drop(new TransportFailure("disconnect", error.message))
    );
    // A peer FIN retires the connection even though the socket is only
    // half-closed. Without this the next request would be written into a
    // socket the daemon has already stopped reading, turning a clean reconnect
    // into a spurious ambiguous-disconnect retry.
    socket.on("end", () =>
      this.#drop(new TransportFailure("disconnect", "connection ended"))
    );
    socket.on("close", () =>
      this.#drop(new TransportFailure("disconnect", "connection closed"))
    );

    this.#generation += 1n;
    socket.write(
      serializeOpenSessionFrame({
        protocolVersion: PROTOCOL_VERSION,
        type: "open_session",
        actor: this.#actor,
        role: this.#role,
        clientInstance: this.#clientInstance,
        connectionGeneration: String(this.#generation)
      })
    );

    const reply = parseSessionReplyFrame(
      await this.#awaitFrame(expiresAt, "handshake deadline exceeded")
    );
    if (reply.type === "session_rejected") {
      this.#drop(new TransportFailure("disconnect", "handshake rejected"));
      throw new CoordinationClientError(
        reply.error.code,
        reply.error.message,
        reply.error.retryable
      );
    }
    // The daemon echoes the identity it bound. A mismatch means this
    // connection is not the session we asked for, which is not something to
    // paper over by proceeding.
    if (reply.actor !== this.#actor || reply.role !== this.#role) {
      this.#drop(new TransportFailure("protocol", "handshake bound a different identity"));
      throw new CoordinationClientError(
        "session_identity_mismatch",
        "daemon bound a different actor or lane than the handshake requested"
      );
    }
    return socket;
  }

  #awaitFrame(expiresAt: number, timeoutMessage: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#drop(new TransportFailure("timeout", timeoutMessage)),
        Math.max(1, expiresAt - Date.now())
      );
      this.#waiter = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (failure) => {
          clearTimeout(timer);
          reject(failure);
        }
      };
    });
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const delimiter = this.#buffer.indexOf(0x0a);
      if (delimiter === -1) {
        // Bytes since the last delimiter, so the bound is per frame.
        if (this.#buffer.byteLength > MAX_RESPONSE_FRAME_BYTES) {
          this.#drop(new TransportFailure("protocol", "response frame exceeds byte bound"));
        }
        return;
      }
      const frame = this.#buffer.subarray(0, delimiter + 1);
      this.#buffer = Buffer.from(this.#buffer.subarray(delimiter + 1));
      if (frame.byteLength > MAX_RESPONSE_FRAME_BYTES) {
        this.#drop(new TransportFailure("protocol", "response frame exceeds byte bound"));
        return;
      }
      const waiter = this.#waiter;
      if (!waiter) {
        // Nothing asked for this. A daemon that volunteers frames is not one
        // whose ordering we can still reason about.
        this.#drop(new TransportFailure("protocol", "unsolicited response frame"));
        return;
      }
      this.#waiter = null;
      waiter.resolve(frame);
    }
  }

  /** Tears the connection down and fails whatever was waiting on it. */
  #drop(failure: TransportFailure): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#buffer = Buffer.alloc(0);
    this.#failWaiter(failure);
    socket?.destroy();
  }

  #failWaiter(failure: TransportFailure): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(failure);
  }
}

/**
 * A deliberately unprivileged Unix-socket client holding one persistent
 * session per lane.
 *
 * Identity is established once per connection by the handshake rather than
 * asserted per request: `clientId` still travels on every request frame, but
 * as a consistency check the daemon rejects on mismatch, not as the thing that
 * establishes who the caller is.
 */
export class CoordinationClient {
  readonly #socketPath: string;
  readonly #clientId: string;
  /** Stable across BOTH lanes for this client's lifetime -- it is what tells
   * the daemon a reconnect is the same process rather than a duplicate. */
  readonly #clientInstance: string;
  readonly #lanes = new Map<SessionRole, LaneConnection>();
  #closed = false;

  constructor(config: CoordinationClientConfig) {
    const parsed = coordinationClientConfigSchema.parse(config);
    this.#socketPath = parsed.socketPath;
    this.#clientId = parsed.clientId;
    this.#clientInstance = randomUUID();
  }

  #lane(role: SessionRole): LaneConnection {
    if (this.#closed) {
      // Without this, `close()` clearing the lane map would let the very next
      // request quietly build a fresh lane -- a closed client that reconnects
      // is worse than one that refuses, because the caller believes it
      // released the daemon's admission permit.
      throw new CoordinationClientError(
        "client_closed",
        "coordination client has been closed"
      );
    }
    let lane = this.#lanes.get(role);
    if (!lane) {
      lane = new LaneConnection(this.#socketPath, this.#clientId, this.#clientInstance, role);
      this.#lanes.set(role, lane);
    }
    return lane;
  }

  /**
   * Releases both lane sockets. Idempotent, and safe on a client that never
   * connected. Callers that own a client for the length of a session must call
   * this in a `finally`: a persistent socket left referenced keeps Node alive
   * AND holds one of the daemon's admission permits.
   */
  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes.values()) lane.close();
    this.#lanes.clear();
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
    const lane = this.#lane(laneForAction(action.type));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        throw new CoordinationClientError("request_timeout", "coordination request timed out");
      }
      try {
        const response = parseResponseFrame(await lane.send(frame, expiresAt));
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
          kind === "timeout" || kind === "unsent"
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
    options?: {
      kind?: z.infer<typeof declarationKindFilterSchema>;
      moduleId?: string;
      afterNodeId?: string;
    },
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request(
      {
        type: "find_declarations",
        name,
        ...(options?.kind ? { kind: options.kind } : {}),
        ...(options?.moduleId ? { moduleId: options.moduleId } : {}),
        ...(options?.afterNodeId ? { afterNodeId: options.afterNodeId } : {})
      },
      deadlineMs
    );
  }

  listModules(
    options?: { afterModuleId?: string },
    limit = 64,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request(
      {
        type: "list_modules",
        ...(options?.afterModuleId ? { afterModuleId: options.afterModuleId } : {}),
        limit
      },
      deadlineMs
    );
  }

  listModuleDeclarations(
    moduleId: string,
    options?: { afterNodeId?: string },
    limit = 64,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request(
      {
        type: "list_module_declarations",
        moduleId,
        ...(options?.afterNodeId ? { afterNodeId: options.afterNodeId } : {}),
        limit
      },
      deadlineMs
    );
  }

  getReferences(
    nodeId: string,
    options?: { afterReferenceKey?: string },
    limit = 256,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request(
      {
        type: "get_references",
        nodeId,
        ...(options?.afterReferenceKey ? { afterReferenceKey: options.afterReferenceKey } : {}),
        limit
      },
      deadlineMs
    );
  }

  listValidationFixtures(
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "list_validation_fixtures" }, deadlineMs);
  }

  readValidationFixture(
    fixtureId: string,
    offset: string,
    length: number,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request(
      { type: "read_validation_fixture", fixtureId, offset, length },
      deadlineMs
    );
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
