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
  parseRequestFrame,
  serializeResponseFrame,
  type LocalServiceRequest,
  type LocalServiceResponse
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

async function unixServer(
  handler: (socket: Socket, request: LocalServiceRequest, connection: number) => void
): Promise<{
  socketPath: string;
  requests: LocalServiceRequest[];
  rawRequests: Buffer[];
}> {
  const root = mkdtempSync("/tmp/strata-lc-client-");
  roots.push(root);
  const socketPath = path.join(root, "service.sock");
  const requests: LocalServiceRequest[] = [];
  const rawRequests: Buffer[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    connections += 1;
    const chunks: Buffer[] = [];
    let handled = false;
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      if (handled || !raw.includes(0x0a)) return;
      handled = true;
      rawRequests.push(Buffer.from(raw));
      const request = parseRequestFrame(raw);
      requests.push(request);
      handler(socket, request, connections);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, requests, rawRequests };
}

function success(
  requestId: string,
  result: Extract<LocalServiceResponse, { ok: true }>["result"]
): Uint8Array {
  return serializeResponseFrame({
    protocolVersion: 1,
    requestId,
    ok: true,
    result
  });
}

describe("unprivileged coordination Unix-socket client", () => {
  it("uses one Unix connection and one bound request/response frame", async () => {
    const service = await unixServer((socket, request) => {
      socket.end(success(request.requestId, { type: "ready" }));
    });
    const client = createCoordinationClient({
      socketPath: service.socketPath,
      clientId: "client:alpha"
    });

    await expect(client.hello(1_000)).resolves.toEqual({ type: "ready" });
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      protocolVersion: 1,
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
    const service = await unixServer((socket, request) => {
      socket.end(
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
  });

  it("retries a mutation after a nonempty response is truncated before LF", async () => {
    const service = await unixServer((socket, request, connection) => {
      if (connection === 1) {
        socket.end(Buffer.from('{"protocolVersion":1,"requestId":"truncated"'));
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
      socket.end(success("request:wrong", { type: "ready" }));
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
    ["unknown response field", (requestId: string) => Buffer.from(`${JSON.stringify({ protocolVersion: 1, requestId, ok: true, result: { type: "ready", redbPath: "/secret" } })}\n`)],
    ["multiple response frames", (requestId: string) => Buffer.concat([success(requestId, { type: "ready" }), success(requestId, { type: "ready" })])],
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

  it("redacts sensitive string values from service and transport errors", async () => {
    const clientToken = "client-token-value-must-not-leak";
    const service = await unixServer((socket, request) => {
      socket.end(
        serializeResponseFrame({
          protocolVersion: 1,
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
          protocolVersion: 1,
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
});
