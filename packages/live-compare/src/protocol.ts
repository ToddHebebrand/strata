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
const MAX_DECLARATION_MATCHES = 64;
const MAX_OPERATION_INTENTS = 16;
const MAX_MODULE_PAGE_ITEMS = 64;
const MAX_MODULE_DECLARATION_PAGE_ITEMS = 64;
const MAX_REFERENCE_PAGE_ITEMS = 256;
const MAX_MODULE_PATH_BYTES = 512;
/** Maximum bytes one `read_validation_fixture` call may request, matching the Rust wire. */
export const MAX_FIXTURE_CHUNK_BYTES = 8_192;
/** Maximum registered fixtures one `validation_fixtures` result may carry. */
export const MAX_VALIDATION_FIXTURES = 64;
/** Padded base64 of MAX_FIXTURE_CHUNK_BYTES bytes: ceil(8192 / 3) * 4. */
const MAX_FIXTURE_CHUNK_BASE64_CHARS = 10_924;
const U64_MAX = 18_446_744_073_709_551_615n;

const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function utf8Length(value: string): number {
  return utf8.encode(value).byteLength;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedString(maxBytes: number, allowEmpty = false) {
  return z.string().superRefine((value, context) => {
    if (!allowEmpty && value.length === 0) {
      context.addIssue({ code: "custom", message: "string must not be empty" });
    }
    if (utf8Length(value) > maxBytes) {
      context.addIssue({ code: "custom", message: `string exceeds ${maxBytes} UTF-8 bytes` });
    }
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: "custom", message: "string contains an unpaired UTF-16 surrogate" });
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

export const declarationKindFilterSchema = z.enum([
  "interface",
  "type-alias",
  "class",
  "function",
  "variable"
]);

export const discoveryStatementKindSchema = z.enum([
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "FirstStatement"
]);

const modulePathSchema = z.string().superRefine((value, context) => {
  if (value.length === 0) context.addIssue({ code: "custom", message: "module path must not be empty" });
  if (utf8Length(value) > MAX_MODULE_PATH_BYTES) {
    context.addIssue({ code: "custom", message: `module path exceeds ${MAX_MODULE_PATH_BYTES} UTF-8 bytes` });
  }
  if (value.startsWith("/") || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "module path must be corpus-relative POSIX" });
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "module path contains an invalid segment" });
  }
});

export const requestActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }).strict(),
  z
    .object({
      type: z.literal("inspect_nodes"),
      nodeIds: z.array(opaqueIdSchema).min(1).max(MAX_ARRAY_ITEMS)
    })
    .strict(),
  z
    .object({
      type: z.literal("find_declarations"),
      name: boundedString(MAX_ID_BYTES),
      kind: declarationKindFilterSchema.optional(),
      moduleId: opaqueIdSchema.optional(),
      afterNodeId: opaqueIdSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("list_modules"),
      afterModuleId: opaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(MAX_MODULE_PAGE_ITEMS)
    })
    .strict(),
  z
    .object({
      type: z.literal("list_module_declarations"),
      moduleId: opaqueIdSchema,
      afterNodeId: opaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(MAX_MODULE_DECLARATION_PAGE_ITEMS)
    })
    .strict(),
  z
    .object({
      type: z.literal("get_references"),
      nodeId: opaqueIdSchema,
      afterReferenceKey: opaqueIdSchema.optional(),
      limit: z.number().int().min(1).max(MAX_REFERENCE_PAGE_ITEMS)
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
  z.object({ type: z.literal("cancel_change_set"), changeSetId: opaqueIdSchema }).strict(),
  z.object({ type: z.literal("read_operation"), operationId: opaqueIdSchema }).strict(),
  // Read-only behavioral-fixture discovery (B-2 Task 10). Never mutating: no
  // idempotency key is carried, and the daemon rejects one that is.
  z.object({ type: z.literal("list_validation_fixtures") }).strict(),
  z
    .object({
      type: z.literal("read_validation_fixture"),
      fixtureId: digestSchema,
      offset: canonicalU64Schema,
      length: z.number().int().min(1).max(MAX_FIXTURE_CHUNK_BYTES)
    })
    .strict()
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
    nodeId: opaqueIdSchema.nullable(),
    modulePath: modulePathSchema.optional()
  })
  .strict();

/**
 * Standard padded base64. MAY be empty: a read at or past EOF returns the
 * terminal empty chunk rather than an error.
 */
const fixtureContentBase64Schema = z
  .string()
  .max(MAX_FIXTURE_CHUNK_BASE64_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const validationFixtureSummarySchema = z
  .object({
    fixtureId: digestSchema,
    path: modulePathSchema,
    bytes: canonicalU64Schema
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

const declarationSummarySchema = z
  .object({
    nodeId: opaqueIdSchema,
    kind: declarationKindFilterSchema,
    name: z.string().min(1),
    moduleId: opaqueIdSchema
  })
  .strict();

const renamedSymbolSchema = z
  .object({
    nodeId: opaqueIdSchema,
    previousName: boundedString(MAX_ID_BYTES),
    currentName: boundedString(MAX_ID_BYTES)
  })
  .strict();

const operationRenameTransitionSchema = z
  .object({
    nodeId: opaqueIdSchema,
    fromName: boundedString(MAX_ID_BYTES),
    toName: boundedString(MAX_ID_BYTES)
  })
  .strict();

const operationIntentSummarySchema = z
  .object({
    kind: boundedString(MAX_ID_BYTES),
    parametersJson: boundedString(MAX_TEXT_BYTES)
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
    kind: z.enum([
      "intent_queued",
      "intent_ready",
      "intent_needs_decision",
      "intent_committed",
      "intent_cancelled",
      "intent_failed",
      "lease_expired",
      "scope_expanded"
    ]),
    state: changeSetStateSchema,
    operationId: opaqueIdSchema.nullable(),
    affectedNodeIds: z.array(opaqueIdSchema).max(MAX_ARRAY_ITEMS),
    diagnostics: z.array(diagnosticSchema).max(MAX_DIAGNOSTICS),
    publicationDigest: digestSchema.nullable()
  })
  .strict();

export const responseResultSchema = z.discriminatedUnion("type", [
  // `hello`. Both validation-identity fields are REQUIRED (B-2 Task 7): a
  // client reads the daemon's validation regime off its first response
  // instead of inferring it from a missing key. The digest is NULLABLE, not
  // optional — `null` means "no operator manifest", a different claim from
  // "this field was not sent".
  z
    .object({
      type: z.literal("ready"),
      validationMode: z.enum(["tscOnly", "behavioral"]),
      validationManifestDigest: digestSchema.nullable()
    })
    .strict(),
  z
    .object({
      type: z.literal("nodes"),
      graphGeneration: canonicalU64Schema,
      nodes: z.array(inspectedNodeSchema).max(MAX_ARRAY_ITEMS)
    })
    .strict(),
  z
    .object({
      type: z.literal("declarations"),
      graphGeneration: canonicalU64Schema,
      declarations: z.array(declarationSummarySchema).max(MAX_DECLARATION_MATCHES),
      hasMore: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal("modules"),
      graphGeneration: canonicalU64Schema,
      modules: z
        .array(
          z
            .object({
              moduleId: opaqueIdSchema,
              path: modulePathSchema,
              declarationCount: z.number().int().min(0)
            })
            .strict()
        )
        .max(MAX_MODULE_PAGE_ITEMS),
      hasMore: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal("module_declarations"),
      graphGeneration: canonicalU64Schema,
      declarations: z
        .array(
          z
            .object({
              nodeId: opaqueIdSchema,
              name: boundedString(MAX_ID_BYTES).nullable(),
              kind: discoveryStatementKindSchema,
              exported: z.boolean()
            })
            .strict()
        )
        .max(MAX_MODULE_DECLARATION_PAGE_ITEMS),
      hasMore: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal("references"),
      graphGeneration: canonicalU64Schema,
      references: z
        .array(
          z
            .object({
              fromNodeId: opaqueIdSchema,
              kind: boundedString(MAX_ID_BYTES),
              moduleId: opaqueIdSchema
            })
            .strict()
        )
        .max(MAX_REFERENCE_PAGE_ITEMS),
      hasMore: z.boolean()
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
      publicationDigest: digestSchema.nullable(),
      /**
       * Net renamed-symbol transitions committed after this change set's base
       * analysis. Non-empty only on needs_decision, where a fresh decision may
       * have to rewrite intent content that names a renamed symbol.
       */
      renamedSymbols: z.array(renamedSymbolSchema).max(MAX_ARRAY_ITEMS)
    })
    .strict(),
  z.object({ type: z.literal("events"), events: z.array(eventSchema).max(MAX_ARRAY_ITEMS) }).strict(),
  z.object({ type: z.literal("events_acked"), throughSequence: canonicalU64Schema }).strict(),
  z
    .object({ type: z.literal("cancelled"), changeSetId: opaqueIdSchema, state: z.literal("cancelled") })
    .strict(),
  z
    .object({
      type: z.literal("operation"),
      graphGeneration: canonicalU64Schema,
      operationId: opaqueIdSchema,
      changeSetId: opaqueIdSchema,
      actor: opaqueIdSchema,
      kind: boundedString(MAX_ID_BYTES),
      reasoning: reasoningSchema,
      affectedNodeIds: z.array(opaqueIdSchema).max(MAX_ARRAY_ITEMS),
      renames: z.array(operationRenameTransitionSchema).max(MAX_ARRAY_ITEMS),
      intents: z.array(operationIntentSummarySchema).max(MAX_OPERATION_INTENTS),
      publicationDigest: digestSchema
    })
    .strict(),
  // Behavioral fixture manifest (B-2 Task 10). `validationManifestDigest` is
  // REQUIRED but NULLABLE, exactly as on `ready`: `null` means "no operator
  // manifest", a different claim from "this field was not sent". Under
  // tsc-only validation the fixture list is empty.
  z
    .object({
      type: z.literal("validation_fixtures"),
      validationMode: z.enum(["tscOnly", "behavioral"]),
      validationManifestDigest: digestSchema.nullable(),
      fixtures: z.array(validationFixtureSummarySchema).max(MAX_VALIDATION_FIXTURES)
    })
    .strict(),
  z
    .object({
      type: z.literal("validation_fixture_chunk"),
      fixtureId: digestSchema,
      offset: canonicalU64Schema,
      contentBase64: fixtureContentBase64Schema,
      eof: z.boolean()
    })
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
    opaqueIdSchema.parse(changeSetIdValue);
    opaqueIdSchema.parse(clientId);
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

function validateStrictRawJson(text: string): void {
  let index = 0;

  const fail = (message: string): never => {
    throw new Error(`invalid strict JSON representation at offset ${index}: ${message}`);
  };

  const skipWhitespace = (): void => {
    while (
      text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\r" ||
      text[index] === "\n"
    ) {
      index += 1;
    }
  };

  const parseString = (): string => {
    const start = index;
    if (text[index] !== '"') {
      return fail("expected string");
    }
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        const value = JSON.parse(text.slice(start, index)) as string;
        if (hasUnpairedSurrogate(value)) {
          return fail("string contains an unpaired UTF-16 surrogate");
        }
        return value;
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) {
          return fail("unterminated escape sequence");
        }
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
            return fail("invalid Unicode escape");
          }
          index += 5;
        } else {
          index += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        return fail("unescaped control character in string");
      }
      index += 1;
    }
    return fail("unterminated string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) {
          return fail(`duplicate object key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") {
          return fail("expected colon after object key");
        }
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          return fail("expected comma or object terminator");
        }
        index += 1;
        skipWhitespace();
      }
      return fail("unterminated object");
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          return fail("expected comma or array terminator");
        }
        index += 1;
      }
      return fail("unterminated array");
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
    if (number === undefined) {
      return fail("expected JSON value");
    }
    if (!/^(0|[1-9][0-9]*)$/.test(number)) {
      return fail("numbers must use canonical unsigned decimal integer syntax");
    }
    index += number.length;
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) {
    fail("trailing content after JSON value");
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
  validateStrictRawJson(text);
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
