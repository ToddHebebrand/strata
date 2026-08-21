import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinationClientError,
  createCoordinationClient
} from "../src/client";
import {
  MAX_RESPONSE_FRAME_BYTES,
  parseOpenSessionFrame,
  parseRequestFrame,
  serializeResponseFrame,
  serializeSessionReplyFrame,
  type LocalServiceRequest,
  type LocalServiceResponse,
  type OpenSession
} from "../src/protocol";

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A PERSISTENT, handshake-aware fake daemon.
 *
 * The v1 fake was one-frame-per-connection: it concatenated everything it
 * received, dispatched once, and never looked again. That shape cannot express
 * anything D-2 needs to prove -- a second request on the same socket, a
 * response split across chunk boundaries, or a handshake at all -- so it is
 * replaced rather than extended.
 *
 * `options.handshake` lets a test take over the first frame (to reject it, to
 * stall, or to answer something deliberately wrong). Returning `false` means
 * "I answered it myself"; the default replies `session_opened`.
 */
async function unixServer(
  handler: (socket: Socket, request: LocalServiceRequest, connection: number) => void,
  options?: {
    handshake?: (socket: Socket, open: OpenSession, connection: number) => boolean;
  }
): Promise<{
  socketPath: string;
  requests: LocalServiceRequest[];
  rawRequests: Buffer[];
  handshakes: OpenSession[];
  connections: () => number;
}> {
  const root = mkdtempSync("/tmp/strata-lc-client-");
  roots.push(root);
  const socketPath = path.join(root, "service.sock");
  const requests: LocalServiceRequest[] = [];
  const rawRequests: Buffer[] = [];
  const handshakes: OpenSession[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    connections += 1;
    const connection = connections;
    let buffer = Buffer.alloc(0);
    let opened = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const delimiter = buffer.indexOf(0x0a);
        if (delimiter === -1) return;
        const frame = Buffer.from(buffer.subarray(0, delimiter + 1));
        buffer = Buffer.from(buffer.subarray(delimiter + 1));
        if (!opened) {
          opened = true;
          const open = parseOpenSessionFrame(frame);
          handshakes.push(open);
          const replied = options?.handshake?.(socket, open, connection) ?? true;
          if (replied) {
            socket.write(
              serializeSessionReplyFrame({
                protocolVersion: 2,
                type: "session_opened",
                serviceEpoch: "1",
                validationMode: "tscOnly",
                validationManifestDigest: null,
                actor: open.actor,
                role: open.role
              })
            );
          }
          continue;
        }
        rawRequests.push(frame);
        const request = parseRequestFrame(frame);
        requests.push(request);
        handler(socket, request, connection);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, requests, rawRequests, handshakes, connections: () => connections };
}

function success(
  requestId: string,
  result: Extract<LocalServiceResponse, { ok: true }>["result"]
): Uint8Array {
  return serializeResponseFrame({
    protocolVersion: 2,
    requestId,
    ok: true,
    result
  });
}

/**
 * The `hello` result a no-manifest daemon returns (B-2 Task 7): both identity
 * fields are present, and the digest is an explicit `null` rather than an
 * omitted key.
 */
const READY_RESULT = {
  type: "ready",
  validationMode: "tscOnly",
  validationManifestDigest: null
} as const;

describe("unprivileged coordination Unix-socket client", () => {
  it("uses one Unix connection and one bound request/response frame", async () => {
    const service = await unixServer((socket, request) => {
      socket.end(success(request.requestId, READY_RESULT));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.hello(1_000)).resolves.toEqual(READY_RESULT);
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      protocolVersion: 2,
      clientId: "client:alpha",
      deadlineMs: "1000",
      action: { type: "hello" }
    });
    expect(service.requests[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
  });

  it("retries a disconnected mutation once with the exact request ID and idempotency key", async () => {
    const service = await unixServer((socket, request, connection) => {
      if (connection === 1) {
        socket.destroy();
        return;
      }
      socket.end(
        success(request.requestId, {
          type: "change_set",
          changeSetId: "change:1",
          state: "draft",
          ticketState: null,
          graphGeneration: "0",
          operationId: null,
          affectedNodeIds: [],
          diagnostics: [],
          publicationDigest: null,
          renamedSymbols: []
        })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.beginChangeSet("rename the target", 1_000)).resolves.toMatchObject({
      type: "change_set",
      changeSetId: "change:1"
    });
    expect(service.requests).toHaveLength(2);
    expect(service.requests[0]!.requestId).toBe(service.requests[1]!.requestId);
    expect(service.requests[0]!.idempotencyKey).toBe(
      service.requests[1]!.idempotencyKey
    );
    expect(service.requests[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.rawRequests).toHaveLength(2);
    expect(service.rawRequests[0]!.equals(service.rawRequests[1]!)).toBe(true);
  });

  it("honors an explicit idempotencyKey override across replayed requests", async () => {
    // `write`, not `end`: a v2 daemon keeps the session open after answering,
    // so this fake must too. Closing per response would model the v1 wire and
    // would test reconnect behavior instead of the replay identity.
    const service = await unixServer((socket, request) => {
      socket.write(
        success(request.requestId, {
          type: "change_set",
          changeSetId: "change:replay",
          state: "draft",
          ticketState: null,
          graphGeneration: "0",
          operationId: null,
          affectedNodeIds: [],
          diagnostics: [],
          publicationDigest: null,
          renamedSymbols: []
        })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:replay"
    });

    const first = await client.request(
      { type: "begin_change_set", reasoning: "replay the exact request identity" },
      1_000,
      { idempotencyKey: "fixed-crash-replay-key" }
    );
    const second = await client.request(
      { type: "begin_change_set", reasoning: "replay the exact request identity" },
      1_000,
      { idempotencyKey: "fixed-crash-replay-key" }
    );

    expect(service.requests).toHaveLength(2);
    expect(service.requests[0]!.idempotencyKey).toBe("fixed-crash-replay-key");
    expect(service.requests[1]!.idempotencyKey).toBe("fixed-crash-replay-key");
    expect(service.requests[0]!.requestId).not.toBe(service.requests[1]!.requestId);
    expect(second).toEqual(first);
    // Both requests rode ONE connection and ONE handshake -- the persistent
    // transport's whole point.
    expect(service.connections()).toBe(1);
    expect(service.handshakes).toHaveLength(1);
    client.close();
  });

  it("retries a mutation after a nonempty response is truncated before LF", async () => {
    const service = await unixServer((socket, request, connection) => {
      if (connection === 1) {
        socket.end(Buffer.from('{"protocolVersion":2,"requestId":"truncated"'));
        return;
      }
      socket.end(
        success(request.requestId, {
          type: "change_set",
          changeSetId: "change:partial",
          state: "draft",
          ticketState: null,
          graphGeneration: "0",
          operationId: null,
          affectedNodeIds: [],
          diagnostics: [],
          publicationDigest: null,
          renamedSymbols: []
        })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:partial"
    });

    await expect(client.beginChangeSet("retry truncated response", 1_000)).resolves.toMatchObject({
      type: "change_set",
      changeSetId: "change:partial"
    });
    expect(service.rawRequests).toHaveLength(2);
    expect(service.rawRequests[0]!.equals(service.rawRequests[1]!)).toBe(true);
  });

  it("does not retry a read after an ambiguous disconnect", async () => {
    const service = await unixServer((socket) => socket.destroy());
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.inspectNodes(["node:1"], 250)).rejects.toThrow(
      CoordinationClientError
    );
    expect(service.requests).toHaveLength(1);
  });

  it("enforces the request deadline when a Unix peer never responds", async () => {
    const service = await unixServer(() => undefined);
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });
    const started = Date.now();

    await expect(client.hello(35)).rejects.toMatchObject({ code: "request_timeout" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("bounds failed Unix connects and never attempts TCP", async () => {
    const root = mkdtempSync("/tmp/strata-lc-missing-");
    roots.push(root);
    const missing = path.join(root, "sensitive-socket.sock");
    const client = createCoordinationClient({
      socketPath: missing,
      clientId: "opaque-client-token"
    });
    const started = Date.now();

    const error = await client.hello(30).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoordinationClientError);
    expect(Date.now() - started).toBeLessThan(500);
    expect(String(error)).not.toContain(missing);
    expect(String(error)).not.toContain("opaque-client-token");
  });

  it("rejects a response bound to a different request ID before exposing its result", async () => {
    const service = await unixServer((socket) => {
      socket.end(success("request:wrong", READY_RESULT));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.hello(500)).rejects.toMatchObject({
      code: "response_binding_mismatch"
    });
  });

  it.each([
    ["unknown response field", (requestId: string) => Buffer.from(`${JSON.stringify({ protocolVersion: 2, requestId, ok: true, result: { ...READY_RESULT, redbPath: "/secret" } })}\n`)],
    ["missing validation identity", (requestId: string) => Buffer.from(`${JSON.stringify({ protocolVersion: 2, requestId, ok: true, result: { type: "ready" } })}\n`)],
    ["oversized response", () => Buffer.alloc(MAX_RESPONSE_FRAME_BYTES + 1, 0x78)]
  ])("fails closed on %s", async (_name, response) => {
    const service = await unixServer((socket, request) => {
      socket.end(response(request.requestId));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.hello(500)).rejects.toBeInstanceOf(CoordinationClientError);
  });

  // REPLACES the v1 "multiple response frames fails closed" case, which
  // contradicted the very contract it was meant to protect: under v1 a
  // connection carried exactly one frame, so two frames in one chunk were
  // garbage. Under v2 the reader must SPLIT frames -- that is the whole point
  // of the persistent transport -- so the honest contract is narrower: the
  // first frame answers the outstanding request, and a second unsolicited
  // frame is a protocol violation that kills the connection WITHOUT
  // retroactively corrupting the request that was already answered.
  it("answers from the first frame and drops the connection on an unsolicited second", async () => {
    const service = await unixServer((socket, request) => {
      socket.write(
        Buffer.concat([
          success(request.requestId, READY_RESULT),
          success(request.requestId, READY_RESULT)
        ])
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.hello(500)).resolves.toEqual(READY_RESULT);
    // The unsolicited frame tore the session down, so the next call has to
    // open a second connection rather than reuse a socket we distrust.
    await expect(client.hello(500)).resolves.toEqual(READY_RESULT);
    expect(service.connections()).toBe(2);
    client.close();
  });

  it("redacts sensitive string values from service and transport errors", async () => {
    const clientToken = "client-token-value-must-not-leak";
    const service = await unixServer((socket, request) => {
      socket.end(
        serializeResponseFrame({
          protocolVersion: 2,
          requestId: request.requestId,
          ok: false,
          error: {
            code: "request_failed",
            message: `failed for ${clientToken} through ${service.socketPath}`,
            retryable: false,
            diagnostics: []
          }
        })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: clientToken
    });

    const error = await client.hello(500).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(clientToken);
    expect(String(error)).not.toContain(service.socketPath);
    expect(String(error)).toContain("[redacted]");
  });

  it("redacts overlapping secrets longest-first without leaking a client-token suffix", async () => {
    const service = await unixServer((socket, request) => {
      const overlappingClientToken = `${service.socketPath}-client-token-suffix`;
      socket.end(
        serializeResponseFrame({
          protocolVersion: 2,
          requestId: request.requestId,
          ok: false,
          error: {
            code: "request_failed",
            message: `failed for ${overlappingClientToken}`,
            retryable: false,
            diagnostics: []
          }
        })
      );
    });
    const overlappingClientToken = `${service.socketPath}-client-token-suffix`;
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: overlappingClientToken
    });

    const error = await client.hello(500).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(overlappingClientToken);
    expect(String(error)).not.toContain(service.socketPath);
    expect(String(error)).not.toContain("client-token-suffix");
    expect(String(error)).toContain("[redacted]");
  });

  it.each(["redbPath", "bridgeConfig", "workerPath", "canonicalPath", "tcpPort"])(
    "rejects extra authority or transport config field %s",
    (field) => {
      expect(() =>
        createCoordinationClient({
          socketPath: "/tmp/strata-lc/example.sock",
          clientId: "client:alpha",
          [field]: "forbidden"
        } as never)
      ).toThrow();
    }
  );

  describe("paged discovery wrappers", () => {
    it("serializes a bare findDeclarations call with no options and no idempotencyKey", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "declarations",
            graphGeneration: "0",
            declarations: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.findDeclarations("User", undefined, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "find_declarations",
        name: "User"
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("EXACT-serializes a scoped findDeclarations call carrying moduleId and afterNodeId on the wire", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "declarations",
            graphGeneration: "0",
            declarations: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.findDeclarations(
        "User",
        { kind: "interface", moduleId: "module:1", afterNodeId: "node:9" },
        1_000
      );

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "find_declarations",
        name: "User",
        kind: "interface",
        moduleId: "module:1",
        afterNodeId: "node:9"
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes listModules with omitted afterModuleId absent from the wire and no idempotencyKey", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "modules",
            graphGeneration: "0",
            modules: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.listModules(undefined, 32, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "list_modules",
        limit: 32
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes listModules with afterModuleId present and defaults limit to 64", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "modules",
            graphGeneration: "0",
            modules: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.listModules({ afterModuleId: "module:5" }, undefined, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "list_modules",
        afterModuleId: "module:5",
        limit: 64
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes listModuleDeclarations with omitted afterNodeId absent from the wire and default limit 64", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "module_declarations",
            graphGeneration: "0",
            declarations: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.listModuleDeclarations("module:1", undefined, undefined, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "list_module_declarations",
        moduleId: "module:1",
        limit: 64
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes listModuleDeclarations with afterNodeId and a custom limit", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "module_declarations",
            graphGeneration: "0",
            declarations: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.listModuleDeclarations("module:1", { afterNodeId: "node:7" }, 10, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "list_module_declarations",
        moduleId: "module:1",
        afterNodeId: "node:7",
        limit: 10
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes getReferences with omitted afterReferenceKey absent from the wire and default limit 256", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "references",
            graphGeneration: "0",
            references: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.getReferences("node:1", undefined, undefined, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "get_references",
        nodeId: "node:1",
        limit: 256
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("serializes getReferences with afterReferenceKey and a custom limit", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "references",
            graphGeneration: "0",
            references: [],
            hasMore: false
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await client.getReferences("node:1", { afterReferenceKey: "ref:3" }, 50, 1_000);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "get_references",
        nodeId: "node:1",
        afterReferenceKey: "ref:3",
        limit: 50
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("does not retry any of the new paged discovery reads after an ambiguous disconnect", async () => {
      const service = await unixServer((socket) => socket.destroy());
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await expect(client.listModules(undefined, 64, 250)).rejects.toThrow(
        CoordinationClientError
      );
      expect(service.requests).toHaveLength(1);
    });
  });

  describe("validation-fixture reads", () => {
    const FIXTURE_ID = "b".repeat(64);

    it("EXACT-serializes listValidationFixtures as a read-only action with no idempotencyKey", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "validation_fixtures",
            validationMode: "behavioral",
            validationManifestDigest: FIXTURE_ID,
            fixtures: [
              { fixtureId: FIXTURE_ID, path: "tests/greet.test.ts", bytes: "120" }
            ]
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await expect(client.listValidationFixtures(1_000)).resolves.toMatchObject({
        type: "validation_fixtures",
        validationMode: "behavioral"
      });
      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({ type: "list_validation_fixtures" });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("EXACT-serializes readValidationFixture with the canonical-u64 offset string and no idempotencyKey", async () => {
      const service = await unixServer((socket, request) => {
        socket.end(
          success(request.requestId, {
            type: "validation_fixture_chunk",
            fixtureId: FIXTURE_ID,
            offset: "0",
            contentBase64: "Zm9vYmFy",
            eof: true
          })
        );
      });
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await expect(
        client.readValidationFixture(FIXTURE_ID, "0", 64, 1_000)
      ).resolves.toEqual({
        type: "validation_fixture_chunk",
        fixtureId: FIXTURE_ID,
        offset: "0",
        contentBase64: "Zm9vYmFy",
        eof: true
      });
      expect(service.requests).toHaveLength(1);
      expect(service.requests[0]!.action).toEqual({
        type: "read_validation_fixture",
        fixtureId: FIXTURE_ID,
        offset: "0",
        length: 64
      });
      expect(service.requests[0]).not.toHaveProperty("idempotencyKey");
    });

    it("does not retry either validation-fixture read after an ambiguous disconnect", async () => {
      const service = await unixServer((socket) => socket.destroy());
      const client = createCoordinationClient({
        socketPath: service.socketPath,
        clientId: "client:alpha"
      });

      await expect(client.listValidationFixtures(250)).rejects.toThrow(
        CoordinationClientError
      );
      expect(service.requests).toHaveLength(1);

      await expect(
        client.readValidationFixture(FIXTURE_ID, "0", 64, 250)
      ).rejects.toThrow(CoordinationClientError);
      expect(service.requests).toHaveLength(2);
    });
  });
});

describe("protocol v2 sessions", () => {
  it("opens one lane per role and reuses each across requests", async () => {
    const service = await unixServer((socket, request) => {
      socket.write(
        request.action.type === "hello"
          ? success(request.requestId, READY_RESULT)
          : success(request.requestId, {
              type: "change_set",
              changeSetId: "change:lane",
              state: "draft",
              ticketState: null,
              graphGeneration: "0",
              operationId: null,
              affectedNodeIds: [],
              diagnostics: [],
              publicationDigest: null,
              renamedSymbols: []
            })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:lanes"
    });

    await client.hello(1_000);
    await client.beginChangeSet("open the work lane", 1_000);
    await client.hello(1_000);
    await client.beginChangeSet("reuse the work lane", 1_000);

    // Four requests, two connections: one per lane, each handshaken once.
    expect(service.connections()).toBe(2);
    expect(service.handshakes.map((open) => open.role).sort()).toEqual([
      "observation",
      "work"
    ]);
    // Both lanes are the SAME client instance -- that is what lets the daemon
    // tell a reconnect apart from a duplicate process.
    expect(new Set(service.handshakes.map((open) => open.clientInstance)).size).toBe(1);
    expect(service.handshakes.every((open) => open.actor === "client:lanes")).toBe(true);
    expect(service.handshakes.every((open) => open.connectionGeneration === "1")).toBe(true);
    client.close();
  });

  // The correction that overturned the plan's own verified claim. One client
  // is shared across all fifteen MCP tool handlers and the agent SDK may emit
  // several tool calls per assistant message, so concurrent same-lane calls
  // are reachable in the live path even though no harness code writes them.
  it("does not write a second same-lane request until the first response arrives", async () => {
    const arrivals: number[] = [];
    let inFlight = 0;
    let overlapped = false;
    const service = await unixServer((socket, request) => {
      arrivals.push(Date.now());
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      setTimeout(() => {
        inFlight -= 1;
        socket.write(success(request.requestId, READY_RESULT));
      }, 60);
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:serial"
    });

    // Issued together, deliberately not awaited in sequence.
    await Promise.all([client.hello(2_000), client.hello(2_000), client.hello(2_000)]);

    expect(overlapped).toBe(false);
    expect(service.requests).toHaveLength(3);
    expect(service.connections()).toBe(1);
    // Serialization is observable in the arrival gaps, not just in a counter.
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThanOrEqual(50);
    expect(arrivals[2]! - arrivals[1]!).toBeGreaterThanOrEqual(50);
    client.close();
  });

  it("runs the work and observation lanes concurrently", async () => {
    let helloSeen: (() => void) | undefined;
    const helloArrived = new Promise<void>((resolve) => {
      helloSeen = resolve;
    });
    const service = await unixServer((socket, request) => {
      if (request.action.type === "begin_change_set") {
        // Hold the work lane open until an observation request has landed --
        // if the lanes shared one connection, this would deadlock.
        void helloArrived.then(() =>
          socket.write(
            success(request.requestId, {
              type: "change_set",
              changeSetId: "change:concurrent",
              state: "draft",
              ticketState: null,
              graphGeneration: "0",
              operationId: null,
              affectedNodeIds: [],
              diagnostics: [],
              publicationDigest: null,
              renamedSymbols: []
            })
          )
        );
        return;
      }
      socket.write(success(request.requestId, READY_RESULT));
      helloSeen?.();
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:concurrent"
    });

    const work = client.beginChangeSet("hold the work lane", 2_000);
    const observation = client.hello(2_000);

    await expect(observation).resolves.toEqual(READY_RESULT);
    await expect(work).resolves.toMatchObject({ changeSetId: "change:concurrent" });
    client.close();
  });

  it("assembles a response split across chunk boundaries", async () => {
    const service = await unixServer((socket, request) => {
      const frame = Buffer.from(success(request.requestId, READY_RESULT));
      // One byte at a time is the pathological case the v1 reader could not
      // express, because it only ever looked for a whole-buffer terminator.
      for (const byte of frame) socket.write(Buffer.from([byte]));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:split"
    });

    await expect(client.hello(2_000)).resolves.toEqual(READY_RESULT);
    client.close();
  });

  it("bounds bytes PER FRAME rather than per connection", async () => {
    // Each response is legal on its own; their sum on one connection is far
    // over the frame bound. A cumulative counter -- which is what v1 had --
    // would kill this session partway through.
    const filler = "n".repeat(400);
    const service = await unixServer((socket, request) => {
      socket.write(
        success(request.requestId, {
          type: "nodes",
          graphGeneration: "1",
          nodes: Array.from({ length: 200 }, (_unused, index) => ({
            nodeId: `node:${index}`,
            kind: "FunctionDeclaration",
            payload: `${filler}${index}`,
            relationships: []
          }))
        })
      );
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:frames"
    });

    let total = 0;
    for (let call = 0; call < 6; call += 1) {
      const result = await client.inspectNodes(["node:0"], 2_000);
      total += JSON.stringify(result).length;
    }
    expect(total).toBeGreaterThan(MAX_RESPONSE_FRAME_BYTES);
    expect(service.connections()).toBe(1);
    client.close();
  });

  it("fails a queued request UNSENT when its own deadline expires while waiting", async () => {
    const service = await unixServer(() => undefined);
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:queued"
    });

    // The first request occupies the lane for its full deadline; the second
    // has a shorter deadline that expires entirely inside that wait.
    const first = client.hello(400);
    const second = client.hello(120);

    await expect(first).rejects.toMatchObject({ code: "request_timeout" });
    await expect(second).rejects.toMatchObject({ code: "request_timeout" });
    // The point: queue wait counts against the ORIGINAL deadline, and an
    // expired queued request is never written. The daemon saw exactly one.
    expect(service.requests).toHaveLength(1);
    client.close();
  });

  // The other fail-fast direction: a v2 client reaching a v1 daemon. A v1
  // daemon cannot parse the handshake, answers with a v1 error response, and
  // closes. The client must surface that promptly rather than wait for EOF.
  it("fails fast against a v1 daemon that cannot parse the handshake", async () => {
    const service = await unixServer(() => undefined, {
      handshake: (socket) => {
        socket.end(
          Buffer.from(
            `${JSON.stringify({
              protocolVersion: 1,
              requestId: "",
              ok: false,
              error: {
                code: "invalid_request",
                message: "invalid local-service request JSON",
                retryable: false,
                diagnostics: []
              }
            })}\n`
          )
        );
        return false;
      }
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:v1-daemon"
    });

    const started = Date.now();
    await expect(client.hello(30_000)).rejects.toBeInstanceOf(CoordinationClientError);
    expect(Date.now() - started).toBeLessThan(2_000);
    client.close();
  });

  it("surfaces a session_rejected handshake as its own error code", async () => {
    const service = await unixServer(() => undefined, {
      handshake: (socket) => {
        socket.write(
          serializeSessionReplyFrame({
            protocolVersion: 2,
            type: "session_rejected",
            error: {
              code: "lane_conflict",
              message: "another instance owns this actor",
              retryable: false,
              diagnostics: []
            }
          })
        );
        return false;
      }
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:rejected"
    });

    await expect(client.hello(2_000)).rejects.toMatchObject({ code: "lane_conflict" });
    expect(service.requests).toHaveLength(0);
    client.close();
  });

  it("refuses a handshake that binds a different identity than it asked for", async () => {
    const service = await unixServer(() => undefined, {
      handshake: (socket, open) => {
        socket.write(
          serializeSessionReplyFrame({
            protocolVersion: 2,
            type: "session_opened",
            serviceEpoch: "1",
            validationMode: "tscOnly",
            validationManifestDigest: null,
            actor: "client:somebody-else",
            role: open.role
          })
        );
        return false;
      }
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:identity"
    });

    await expect(client.hello(2_000)).rejects.toMatchObject({
      code: "session_identity_mismatch"
    });
    client.close();
  });

  it("has a close() that is safe twice and safe with nothing open", async () => {
    const service = await unixServer((socket, request) => {
      socket.write(success(request.requestId, READY_RESULT));
    });

    const untouched = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:never-connected"
    });
    expect(() => untouched.close()).not.toThrow();
    expect(() => untouched.close()).not.toThrow();

    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:closed"
    });
    await client.hello(1_000);
    expect(() => client.close()).not.toThrow();
    expect(() => client.close()).not.toThrow();
    // A closed client refuses further work rather than silently reconnecting.
    await expect(client.hello(1_000)).rejects.toBeInstanceOf(CoordinationClientError);
  });

  it("reconnects with a higher connection generation after the lane drops", async () => {
    const service = await unixServer((socket, request, connection) => {
      if (connection === 1) {
        socket.destroy();
        return;
      }
      socket.write(success(request.requestId, READY_RESULT));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:generation"
    });

    await expect(client.hello(1_000)).rejects.toBeInstanceOf(CoordinationClientError);
    await expect(client.hello(1_000)).resolves.toEqual(READY_RESULT);

    expect(service.handshakes.map((open) => open.connectionGeneration)).toEqual(["1", "2"]);
    // Same process, so the instance identity is stable across the reconnect.
    expect(new Set(service.handshakes.map((open) => open.clientInstance)).size).toBe(1);
    client.close();
  });
});
