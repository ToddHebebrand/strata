// The coordination client's public surface. Deliberately an explicit named
// list rather than `export *`: this list IS the contract an embedder depends
// on, and it should change only on purpose.

export {
  ALL_ACTION_TYPES,
  DEFAULT_PROTOCOL_CONTEXT_CAPACITY,
  LocalServiceProtocolContext,
  MAX_DEADLINE_MS,
  MAX_FIXTURE_CHUNK_BYTES,
  MAX_OPERATION_INTENTS,
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  MAX_VALIDATION_FIXTURES,
  PROTOCOL_VERSION,
  canonicalU64Schema,
  declarationKindFilterSchema,
  discoveryStatementKindSchema,
  intentSchema,
  isMutatingAction,
  parseRequestFrame,
  parseResponseFrame,
  requestActionSchema,
  requestSchema,
  responseResultSchema,
  responseSchema,
  serializeRequestFrame,
  serializeResponseFrame
} from "./protocol.js";
export type { LocalServiceRequest, LocalServiceResponse } from "./protocol.js";

export {
  CoordinationClient,
  CoordinationClientError,
  DEFAULT_REQUEST_DEADLINE_MS,
  coordinationClientConfigSchema,
  createCoordinationClient
} from "./client.js";
export type {
  CoordinationClientConfig,
  CoordinationIntent,
  CoordinationResult
} from "./client.js";
