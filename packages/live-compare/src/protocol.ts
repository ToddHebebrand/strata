import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_REQUEST_FRAME_BYTES = 64 * 1024;
export const MAX_RESPONSE_FRAME_BYTES = 256 * 1024;
export const MAX_DEADLINE_MS = 300_000n;
export const DEFAULT_PROTOCOL_CONTEXT_CAPACITY = 1_024;

const MAX_ID_BYTES = 512;
const MAX_REASONING_BYTES = 4_096;
const MAX_TEXT_BYTES = 16_384;
const MAX_ARRAY_ITEMS = 256;
const MAX_DIAGNOSTICS = 64;
const MAX_EVENT_LIMIT = 256;
const U64_MAX = 18_446_744_073_709_551_615n;

const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function utf8Length(value: string): number {
  return utf8.encode(value).byteLength;
}

function boundedString(maxBytes: number, allowEmpty = false) {
  return z.string().superRefine((value, context) => {
    if (!allowEmpty && value.length === 0) {
      context.addIssue({ code: "custom", message: "string must not be empty" });
    }
    if (utf8Length(value) > maxBytes) {
      context.addIssue({ code: "custom", message: `string exceeds ${maxBytes} UTF-8 bytes` });
    }
  });
}

const opaqueIdSchema = boundedString(MAX_ID_BYTES);
const textSchema = boundedString(MAX_TEXT_BYTES, true);
const reasoningSchema = boundedString(MAX_REASONING_BYTES, true);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const canonicalU64Schema = z.string().superRefine((value, context) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    context.addIssue({ code: "custom", message: "expected a canonical unsigned 64-bit decimal string" });
    return;
  }
  if (BigInt(value) > U64_MAX) {
    context.addIssue({ code: "custom", message: "unsigned 64-bit decimal string is out of range" });
  }
});

const deadlineSchema = canonicalU64Schema.superRefine((value, context) => {
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const deadline = BigInt(value);
    if (deadline === 0n || deadline > MAX_DEADLINE_MS) {
      context.addIssue({ code: "custom", message: "deadlineMs is outside the supported bound" });
    }
  }
});

const renameIntentSchema = z
  .object({
    type: z.literal("rename_symbol"),
    declarationId: opaqueIdSchema,
    newName: boundedString(MAX_ID_BYTES)
  })
  .strict();

const addParameterIntentSchema = z
  .object({
    type: z.literal("add_parameter"),
    functionId: opaqueIdSchema,
    name: boundedString(MAX_ID_BYTES),
    typeText: textSchema,
    position: z.number().int().min(0).max(0xffff_ffff),
    value: textSchema
  })
  .strict();

export const intentSchema = z.discriminatedUnion("type", [
  renameIntentSchema,
  addParameterIntentSchema
]);

export const requestActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }).strict(),
  z
    .object({
      type: z.literal("inspect_nodes"),
      nodeIds: z.array(opaqueIdSchema).min(1).max(MAX_ARRAY_ITEMS)
    })
    .strict(),
  z.object({ type: z.literal("begin_change_set"), reasoning: reasoningSchema }).strict(),
  z
    .object({
      type: z.literal("add_intent"),
      changeSetId: opaqueIdSchema,
      intent: intentSchema
    })
    .strict(),
  z.object({ type: z.literal("submit_change_set"), changeSetId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("advance_change_set"), changeSetId: opaqueIdSchema }).strict(),
  z
    .object({
      type: z.literal("read_events"),
      afterSequence: canonicalU64Schema,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT)
    })
    .strict(),
  z.object({ type: z.literal("ack_events"), throughSequence: canonicalU64Schema }).strict(),
  z.object({ type: z.literal("cancel_change_set"), changeSetId: opaqueIdSchema }).strict()
]);

const MUTATING_ACTIONS = new Set([
  "begin_change_set",
  "add_intent",
  "submit_change_set",
  "advance_change_set",
  "ack_events",
  "cancel_change_set"
]);

export const requestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: opaqueIdSchema,
    clientId: opaqueIdSchema,
    deadlineMs: deadlineSchema,
    idempotencyKey: opaqueIdSchema.optional(),
    action: requestActionSchema
  })
  .strict()
  .superRefine((request, context) => {
    const mutating = MUTATING_ACTIONS.has(request.action.type);
    if (mutating && request.idempotencyKey === undefined) {
      context.addIssue({ code: "custom", path: ["idempotencyKey"], message: "mutating actions require an idempotency key" });
    }
    if (!mutating && request.idempotencyKey !== undefined) {
      context.addIssue({ code: "custom", path: ["idempotencyKey"], message: "read-only actions must not carry an idempotency key" });
    }
  });

const diagnosticSchema = z
  .object({
    code: boundedString(MAX_ID_BYTES),
    message: textSchema,
    nodeId: opaqueIdSchema.nullable()
  })
  .strict();

const relationshipSchema = z
  .object({ kind: boundedString(MAX_ID_BYTES), nodeId: opaqueIdSchema })
  .strict();

const inspectedNodeSchema = z
  .object({
    nodeId: opaqueIdSchema,
    kind: boundedString(MAX_ID_BYTES),
    payload: textSchema,
    relationships: z.array(relationshipSchema).max(MAX_ARRAY_ITEMS)
  })
  .strict();

const changeSetStateSchema = z.enum([
  "draft",
  "analyzing",
  "queued",
  "ready",
  "claimed",
  "published",
  "needs_decision",
  "validation_failed",
  "cancelled",
  "failed"
]);

const ticketStateSchema = z.enum([
  "queued",
  "ready",
  "claimed",
  "completed",
  "needs_decision",
  "failed",
  "cancelled"
]);

const eventSchema = z
  .object({
    sequence: canonicalU64Schema,
    changeSetId: opaqueIdSchema,
    state: changeSetStateSchema,
    operationId: opaqueIdSchema.nullable(),
    affectedNodeIds: z.array(opaqueIdSchema).max(MAX_ARRAY_ITEMS),
    diagnostics: z.array(diagnosticSchema).max(MAX_DIAGNOSTICS),
    publicationDigest: digestSchema.nullable()
  })
  .strict();

export const responseResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("nodes"),
      graphGeneration: canonicalU64Schema,
      nodes: z.array(inspectedNodeSchema).max(MAX_ARRAY_ITEMS)
    })
    .strict(),
  z
    .object({
      type: z.literal("change_set"),
      changeSetId: opaqueIdSchema,
      state: changeSetStateSchema,
      ticketState: ticketStateSchema.nullable(),
      graphGeneration: canonicalU64Schema,
      operationId: opaqueIdSchema.nullable(),
      affectedNodeIds: z.array(opaqueIdSchema).max(MAX_ARRAY_ITEMS),
      diagnostics: z.array(diagnosticSchema).max(MAX_DIAGNOSTICS),
      publicationDigest: digestSchema.nullable()
    })
    .strict(),
  z.object({ type: z.literal("events"), events: z.array(eventSchema).max(MAX_ARRAY_ITEMS) }).strict(),
  z.object({ type: z.literal("events_acked"), throughSequence: canonicalU64Schema }).strict(),
  z
    .object({ type: z.literal("cancelled"), changeSetId: opaqueIdSchema, state: z.literal("cancelled") })
    .strict()
]);

const successResponseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: opaqueIdSchema,
    ok: z.literal(true),
    result: responseResultSchema
  })
  .strict();

const errorResponseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: opaqueIdSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: boundedString(MAX_ID_BYTES),
        message: textSchema,
        retryable: z.boolean(),
        diagnostics: z.array(diagnosticSchema).max(MAX_DIAGNOSTICS)
      })
      .strict()
  })
  .strict();

export const responseSchema = z.union([successResponseSchema, errorResponseSchema]);

export type LocalServiceRequest = z.infer<typeof requestSchema>;
export type LocalServiceResponse = z.infer<typeof responseSchema>;

function changeSetId(request: LocalServiceRequest): string | undefined {
  switch (request.action.type) {
    case "add_intent":
    case "submit_change_set":
    case "advance_change_set":
    case "cancel_change_set":
      return request.action.changeSetId;
    default:
      return undefined;
  }
}

export class LocalServiceProtocolContext {
  readonly #requests = new Map<string, string>();
  readonly #owners = new Map<string, string>();

  constructor(
    readonly requestCapacity = DEFAULT_PROTOCOL_CONTEXT_CAPACITY,
    readonly changeSetCapacity = DEFAULT_PROTOCOL_CONTEXT_CAPACITY
  ) {
    if (!Number.isSafeInteger(requestCapacity) || requestCapacity < 1) {
      throw new Error("request context capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(changeSetCapacity) || changeSetCapacity < 1) {
      throw new Error("change-set context capacity must be a positive safe integer");
    }
  }

  recordChangeSetOwner(changeSetIdValue: string, clientId: string): void {
    const existing = this.#owners.get(changeSetIdValue);
    if (existing !== undefined && existing !== clientId) {
      throw new Error("change set belongs to a different client");
    }
    if (existing === undefined && this.#owners.size >= this.changeSetCapacity) {
      throw new Error("change-set validation context capacity exceeded");
    }
    this.#owners.set(changeSetIdValue, clientId);
  }

  validate(request: LocalServiceRequest): void {
    const ownedChangeSet = changeSetId(request);
    if (ownedChangeSet !== undefined) {
      const owner = this.#owners.get(ownedChangeSet);
      if (owner !== undefined && owner !== request.clientId) {
        throw new Error("change set belongs to a different client");
      }
    }

    const body = JSON.stringify(request);
    const previous = this.#requests.get(request.requestId);
    if (previous !== undefined && previous !== body) {
      throw new Error("request ID was already used with a different body");
    }
    if (previous === undefined && this.#requests.size >= this.requestCapacity) {
      throw new Error("request validation context capacity exceeded");
    }
    this.#requests.set(request.requestId, body);
  }
}

function decodeFrame(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength > maxBytes) {
    throw new Error(`frame exceeds ${maxBytes} byte bound`);
  }
  if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error("frame must contain one non-empty JSON object terminated by LF");
  }
  if (bytes.subarray(0, -1).includes(0x0a)) {
    throw new Error("connection contains multiple frames");
  }
  const text = fatalUtf8.decode(bytes.subarray(0, -1));
  if (text.length === 0) {
    throw new Error("frame payload must not be empty");
  }
  return JSON.parse(text) as unknown;
}

function encodeFrame(value: unknown, maxBytes: number): Uint8Array {
  const bytes = utf8.encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`frame exceeds ${maxBytes} byte bound`);
  }
  return bytes;
}

export function parseRequestFrame(
  bytes: Uint8Array,
  context?: LocalServiceProtocolContext
): LocalServiceRequest {
  const request = requestSchema.parse(decodeFrame(bytes, MAX_REQUEST_FRAME_BYTES));
  context?.validate(request);
  return request;
}

export function parseResponseFrame(bytes: Uint8Array): LocalServiceResponse {
  return responseSchema.parse(decodeFrame(bytes, MAX_RESPONSE_FRAME_BYTES));
}

export function serializeRequestFrame(request: LocalServiceRequest): Uint8Array {
  return encodeFrame(requestSchema.parse(request), MAX_REQUEST_FRAME_BYTES);
}

export function serializeResponseFrame(response: LocalServiceResponse): Uint8Array {
  return encodeFrame(responseSchema.parse(response), MAX_RESPONSE_FRAME_BYTES);
}
