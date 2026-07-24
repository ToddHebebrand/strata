import { analyzeIntent, analyzeIntentInDb } from "./analyze";
import {
  buildValidateCandidate,
  buildValidateCandidateOnMirror,
  corruptingMirrorPipelineForTests
} from "./candidate";
import {
  MAX_REQUEST_FRAME_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  readFrames,
  writeFrame
} from "./frames";
import { StageRecorder } from "./metrics";
import {
  bridgeRequestSchema,
  bridgeResponseSchema,
  type AnalyzeIntentRequest,
  type BridgeBinding,
  type BridgeDiagnostic,
  type BridgeErrorPayload,
  type BridgeKind,
  type BridgeRequest,
  type BridgeResponse,
  type BuildValidateCandidateRequest
} from "./protocol";
import {
  MirrorState,
  hydrateFrameSchema,
  mirrorAnalyzeRequestSchema,
  mirrorCandidateRequestSchema,
  syncFrameSchema,
  type MirrorAnalyzeRequest,
  type MirrorCandidateRequest,
  type SyncOutcome
} from "./sync";

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;

const MAX_ERROR_MESSAGE_BYTES = 1_000;
const FALLBACK_DIGEST = "0".repeat(64);

export interface WorkerHandlers {
  analyzeIntent: (
    request: AnalyzeIntentRequest,
    recorder?: StageRecorder
  ) => ReturnType<typeof analyzeIntent>;
  buildValidateCandidate: (
    request: BuildValidateCandidateRequest,
    recorder?: StageRecorder
  ) => ReturnType<typeof buildValidateCandidate>;
}

const defaultHandlers: WorkerHandlers = {
  analyzeIntent,
  buildValidateCandidate
};

class RequestTooLargeError extends Error {}

class WorkerFailure extends Error {
  constructor(readonly code: string, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

export async function runOneShotWorker(
  handlers: WorkerHandlers = defaultHandlers
): Promise<void> {
  // Strictly opt-in: absent this literal argv flag, no recorder is
  // constructed and no `process.resourceUsage()` call happens, so a
  // metrics-off worker's responses are byte-identical to before this feature
  // existed. A later bridge task appends the flag when it wants metrics.
  const emitMetrics = process.argv.includes("--emit-metrics");
  const recorder = emitMetrics ? new StageRecorder() : undefined;

  let request: BridgeRequest | undefined;
  try {
    const raw = await readBoundedInput();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw protocolFailure("invalidJson", error);
    }
    try {
      request = bridgeRequestSchema.parse(value);
    } catch (error) {
      throw protocolFailure("invalidRequest", error);
    }
  } catch (error) {
    const code = error instanceof RequestTooLargeError
      ? "requestTooLarge"
      : failureCode(error, "invalidRequest");
    const response = fallbackErrorResponse(code, error);
    await emitResponse(response, undefined, recorder);
    writeOperationalError(code, error);
    return;
  }

  try {
    const response = dispatch(request, handlers, recorder);
    await emitResponse(response, responseIdentityOf(request), recorder);
  } catch (error) {
    const response = requestErrorResponse(
      request,
      request.kind === "analyzeIntent" ? "analyze" : "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await emitResponse(response, responseIdentityOf(request), recorder);
    writeOperationalError(response.error.code, error);
  }
}

/**
 * Persistent mode (bridge-persistence slice, Tasks 4+6): a strictly serial
 * request loop over the u32-LE length-prefixed frame transport the Rust host
 * (`bridge/persistent.rs`) speaks — the worker-side mirror of the host's
 * single-flight discipline. One frame is read, exactly one response frame
 * carrying the request's `requestId` is written, and only then is the next
 * frame read.
 *
 * The loop owns ONE long-lived `:memory:` mirror database ([`MirrorState`],
 * sync.ts) kept exact by the daemon's attested, published-only sync frames:
 * `hydrate` replaces it, `sync` applies ordered published deltas
 * transactionally, and the mirror semantic kinds serve WITHOUT any in-band
 * snapshot (the worker refuses when its attested identity does not match
 * the frame's): `analyzeIntentMirror` analyzes the mirror directly, and
 * `buildValidateCandidateMirror` (Task 7) runs the unchanged candidate
 * pipeline on the mirror under savepoint-rollback isolation asserted by the
 * full logical fingerprint — a divergence poisons the whole worker
 * (`mirrorPoisoned` on every subsequent request) so the host respawns it.
 * Snapshot-carrying semantic kinds (`analyzeIntent` /
 * `buildValidateCandidate`) still route through the SAME `dispatch` the
 * one-shot path uses over their own throwaway scratch databases — the
 * host's fallback path. Per-request `StageRecorder` under the same
 * `--emit-metrics` opt-in keeps `workerRun` metrics per-trip comparable
 * across transports. `shutdown` is acked then exits 0; stdin EOF (the
 * host's clean-shutdown contract) also exits 0. A failure inside one
 * request answers THAT request and keeps serving; process exit stays
 * reserved for unrecoverable transport states.
 */
export async function runPersistentWorker(
  handlers: WorkerHandlers = defaultHandlers
): Promise<void> {
  const emitMetrics = process.argv.includes("--emit-metrics");
  const mirror = new MirrorState();
  try {
    for await (const body of readFrames(process.stdin, MAX_REQUEST_FRAME_BYTES)) {
      const shutdown = await servePersistentFrame(body, handlers, emitMetrics, mirror);
      if (shutdown) {
        // The ack write above has been handed to the OS pipe; exiting here
        // honors "respond, then exit 0" without waiting on open stdin.
        mirror.close();
        process.exit(0);
      }
    }
  } finally {
    mirror.close();
  }
}

/** Serves one inbound frame; returns true only for an acked `shutdown`. */
async function servePersistentFrame(
  body: Buffer,
  handlers: WorkerHandlers,
  emitMetrics: boolean,
  mirror: MirrorState
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    // No parseable requestId exists; the host treats the mismatch as its
    // poison signal, which is the correct outcome for a mangled frame.
    await writeLoopErrorFrame("unbound-request", "invalidJson", error);
    return false;
  }
  const frame =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const requestId =
    typeof frame.requestId === "string" && frame.requestId.length > 0
      ? frame.requestId
      : "unbound-request";
  const kind = typeof frame.kind === "string" ? frame.kind : "";

  if (kind === "shutdown") {
    await writePersistentFrame({ requestId, kind: "shutdownAck" });
    return true;
  }
  // Task-7 poison latch: after a candidate-isolation divergence the mirror
  // can never be trusted again in this process. EVERY request except a clean
  // shutdown is refused with the distinct `mirrorPoisoned` code — the host
  // treats it as a poison signal (kill + reap + lazy respawn + full
  // rehydrate); this branch exists so even a host that somehow keeps talking
  // to a poisoned worker can never read stale mirror state.
  const poisonDetail = mirror.poisonedDetail();
  if (poisonDetail !== null) {
    await writeLoopErrorFrame(requestId, "mirrorPoisoned", new Error(poisonDetail));
    return false;
  }
  if (kind === "hydrate" || kind === "sync") {
    let outcome: SyncOutcome;
    try {
      outcome =
        kind === "hydrate"
          ? mirror.handleHydrate(hydrateFrameSchema.parse(value))
          : mirror.handleSync(syncFrameSchema.parse(value));
    } catch (error) {
      // A schema-invalid sync frame from our own daemon is a protocol bug;
      // the error frame makes the host poison (kill + rehydrate), which is
      // the correct fail-closed outcome.
      await writeLoopErrorFrame(requestId, "invalidSyncFrame", error);
      return false;
    }
    await writePersistentFrame({ requestId, ...outcome });
    return false;
  }
  if (kind === "analyzeIntentMirror") {
    await serveMirrorAnalyze(value, requestId, emitMetrics, mirror);
    return false;
  }
  if (kind === "buildValidateCandidateMirror") {
    await serveMirrorCandidate(value, requestId, emitMetrics, mirror);
    return false;
  }
  if (kind !== "analyzeIntent" && kind !== "buildValidateCandidate") {
    await writeLoopErrorFrame(
      requestId,
      "unknownKind",
      new Error(`unknown frame kind ${JSON.stringify(kind)}`)
    );
    return false;
  }

  // Per-request recorder, exactly as the one-shot path constructs one per
  // process: absent the opt-in flag no recorder exists at all. Anchored to
  // "now" (this request's frame is in hand) rather than the recorder's
  // process-start default so `totalNs` is THIS trip's serve duration —
  // per-trip comparable with one-shot records, not cumulative uptime.
  const recorder = emitMetrics ? new StageRecorder(process.hrtime.bigint()) : undefined;
  let request: BridgeRequest;
  try {
    request = bridgeRequestSchema.parse(value);
  } catch (error) {
    await writeLoopErrorFrame(requestId, "invalidRequest", error);
    return false;
  }
  try {
    const response = dispatch(request, handlers, recorder);
    await writePersistentResponse(response, responseIdentityOf(request), recorder);
  } catch (error) {
    const response = requestErrorResponse(
      request,
      request.kind === "analyzeIntent" ? "analyze" : "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await writePersistentResponse(response, responseIdentityOf(request), recorder);
    writeOperationalError(response.error.code, error);
  }
  return false;
}

/**
 * Serves one `analyzeIntentMirror` frame against the persistent mirror
 * (Task 6): no snapshot, no hydration — the request's graph identity must
 * equal the mirror's attested identity, else the worker refuses and the
 * host falls back one-shot. Success/error responses are byte-shaped exactly
 * like snapshot-served analyzeIntent responses (same schema, same binding
 * echo), so the daemon-side validation path is shared.
 */
async function serveMirrorAnalyze(
  value: unknown,
  requestId: string,
  emitMetrics: boolean,
  mirror: MirrorState
): Promise<void> {
  const recorder = emitMetrics ? new StageRecorder(process.hrtime.bigint()) : undefined;
  let request: MirrorAnalyzeRequest;
  try {
    request = mirrorAnalyzeRequestSchema.parse(value);
  } catch (error) {
    await writeLoopErrorFrame(requestId, "invalidRequest", error);
    return;
  }
  const db = mirror.databaseFor(request.identity);
  if (db === null) {
    await writePersistentFrame({
      requestId: request.requestId,
      kind: "refuse",
      reason: mirror.mismatchReason(request.identity),
      have: mirror.attested()
    });
    return;
  }
  const identity = analyzeResponseIdentity(request.requestId, request.binding);
  try {
    const result = recorder
      ? recorder.time("analyze", () => analyzeIntentInDb(db, request.intent))
      : analyzeIntentInDb(db, request.intent);
    const response =
      "facts" in result
        ? bridgeResponseSchema.parse({
            protocolVersion: 1,
            requestId: request.requestId,
            kind: "analyzeIntent",
            binding: request.binding,
            ok: true,
            result
          })
        : errorResponseFor(identity, result.stage, result.code, result.message, result.diagnostics);
    await writePersistentResponse(response, identity, recorder);
  } catch (error) {
    const response = errorResponseFor(
      identity,
      "analyze",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await writePersistentResponse(response, identity, recorder);
    writeOperationalError(response.error.code, error);
  }
}

/**
 * Serves one `buildValidateCandidateMirror` frame against the persistent
 * mirror (Task 7): no snapshot, no hydration — the request's graph identity
 * must equal the mirror's attested identity, else the worker refuses exactly
 * as `analyzeIntentMirror` does. The EXISTING candidate pipeline runs inside
 * `buildValidateCandidateOnMirror`'s savepoint bracket; success/error
 * responses are byte-shaped exactly like snapshot-served candidate responses
 * (same schema, same binding echo). A fingerprint divergence marks the
 * WHOLE worker poisoned and answers with the distinct `mirrorPoisoned`
 * error code so the host kills + respawns + rehydrates.
 *
 * `STRATA_TEST_MIRROR_CANDIDATE_CORRUPT=1` is the poison-state test seam
 * (plan review Minor 2): it swaps in a pipeline that commits a corruption
 * behind the savepoint, which the post-fingerprint MUST catch.
 */
async function serveMirrorCandidate(
  value: unknown,
  requestId: string,
  emitMetrics: boolean,
  mirror: MirrorState
): Promise<void> {
  const recorder = emitMetrics ? new StageRecorder(process.hrtime.bigint()) : undefined;
  let request: MirrorCandidateRequest;
  try {
    request = mirrorCandidateRequestSchema.parse(value);
  } catch (error) {
    await writeLoopErrorFrame(requestId, "invalidRequest", error);
    return;
  }
  const db = mirror.databaseFor(request.identity);
  if (db === null) {
    await writePersistentFrame({
      requestId: request.requestId,
      kind: "refuse",
      reason: mirror.mismatchReason(request.identity),
      have: mirror.attested()
    });
    return;
  }
  const identity: ResponseIdentity = {
    requestId: request.requestId,
    kind: "buildValidateCandidate",
    binding: {
      ...request.binding,
      attemptId: request.attemptId,
      scopeFingerprint: request.scopeFingerprint
    }
  };
  const pipeline =
    process.env.STRATA_TEST_MIRROR_CANDIDATE_CORRUPT === "1"
      ? corruptingMirrorPipelineForTests
      : undefined;
  try {
    const outcome = buildValidateCandidateOnMirror(request, db, recorder, pipeline);
    if (outcome.kind === "poisoned") {
      mirror.markPoisoned(outcome.detail);
      await writeLoopErrorFrame(request.requestId, "mirrorPoisoned", new Error(outcome.detail));
      return;
    }
    const result = outcome.result;
    const response =
      "delta" in result
        ? bridgeResponseSchema.parse({
            protocolVersion: 1,
            requestId: request.requestId,
            kind: "buildValidateCandidate",
            binding: identity.binding,
            ok: true,
            result
          })
        : errorResponseFor(identity, result.stage, result.code, result.message, result.diagnostics);
    await writePersistentResponse(response, identity, recorder);
  } catch (error) {
    const response = errorResponseFor(
      identity,
      "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await writePersistentResponse(response, identity, recorder);
    writeOperationalError(response.error.code, error);
  }
}

/**
 * The identity a response is bound to: the request's id/kind plus the exact
 * binding echo the response schema requires. Extracted so mirror-served
 * requests (which have no full `BridgeRequest`) share one error/bounding
 * path with snapshot-served requests.
 */
interface ResponseIdentity {
  requestId: string;
  kind: BridgeKind;
  binding: BridgeBinding | ReturnType<typeof candidateBinding>;
}

function responseIdentityOf(request: BridgeRequest): ResponseIdentity {
  return {
    requestId: request.requestId,
    kind: request.kind,
    binding:
      request.kind === "buildValidateCandidate"
        ? candidateBinding(request)
        : request.binding
  };
}

function analyzeResponseIdentity(
  requestId: string,
  binding: BridgeBinding
): ResponseIdentity {
  return { requestId, kind: "analyzeIntent", binding };
}

/**
 * Frames a semantic response for the persistent transport. The body is the
 * exact newline-terminated string the one-shot path would write (bound
 * already enforced inside), so the length-prefixed write can never overflow.
 */
async function writePersistentResponse(
  response: BridgeResponse,
  identity: ResponseIdentity,
  recorder?: StageRecorder
): Promise<void> {
  await writeFrame(
    process.stdout,
    Buffer.from(boundedResponseFrame(response, identity, recorder), "utf8"),
    MAX_RESPONSE_FRAME_BYTES
  );
}

/**
 * Loop-level error frame for requests that never reached a semantic handler
 * (mangled JSON, unsupported/unknown kinds, schema-rejected requests):
 * `{requestId, kind:"error", code, message}` with the same message bounding
 * as bridge error payloads. Also mirrors the one-shot path's bounded
 * operational stderr line.
 */
async function writeLoopErrorFrame(
  requestId: string,
  code: string,
  error: unknown
): Promise<void> {
  await writePersistentFrame({
    requestId,
    kind: "error",
    code,
    message: truncateUtf8(
      normalizeText(error instanceof Error ? error.message : String(error)),
      MAX_ERROR_MESSAGE_BYTES
    )
  });
  writeOperationalError(code, error);
}

async function writePersistentFrame(value: unknown): Promise<void> {
  await writeFrame(
    process.stdout,
    Buffer.from(JSON.stringify(value), "utf8"),
    MAX_RESPONSE_FRAME_BYTES
  );
}

async function readBoundedInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }
  if (tooLarge) {
    throw new RequestTooLargeError(
      `request exceeds ${MAX_REQUEST_BYTES} bytes`
    );
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function dispatch(
  request: BridgeRequest,
  handlers: WorkerHandlers,
  recorder?: StageRecorder
): BridgeResponse {
  if (request.kind === "analyzeIntent") {
    const result = handlers.analyzeIntent(request, recorder);
    const response = "facts" in result
      ? {
          protocolVersion: 1 as const,
          requestId: request.requestId,
          kind: request.kind,
          binding: request.binding,
          ok: true as const,
          result
        }
      : requestErrorResponse(
          request,
          result.stage,
          result.code,
          result.message,
          result.diagnostics
        );
    return bridgeResponseSchema.parse(response);
  }

  const result = handlers.buildValidateCandidate(request, recorder);
  const response = "delta" in result
    ? {
        protocolVersion: 1 as const,
        requestId: request.requestId,
        kind: request.kind,
        binding: candidateBinding(request),
        ok: true as const,
        result
      }
    : requestErrorResponse(
        request,
        result.stage,
        result.code,
        result.message,
        result.diagnostics
      );
  return bridgeResponseSchema.parse(response);
}

async function emitResponse(
  response: BridgeResponse,
  identity: ResponseIdentity | undefined,
  recorder?: StageRecorder
): Promise<void> {
  await writeStdout(boundedResponseFrame(response, identity, recorder));
}

/**
 * Settles the semantic decision — which frame is the response — exactly as
 * before metrics existed: `finalResponse`/`frame` are the bound-checked
 * semantic result; metrics are only ever appended on top, never allowed to
 * change which semantic frame was chosen. Shared verbatim by the one-shot
 * path (which writes the string raw) and the persistent loop (which wraps
 * the identical bytes in a length prefix), so both transports carry
 * byte-identical response bodies.
 */
function boundedResponseFrame(
  response: BridgeResponse,
  identity: ResponseIdentity | undefined,
  recorder?: StageRecorder
): string {
  let finalResponse = response;
  let frame = serializeFrame(finalResponse);
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) {
    finalResponse = identity === undefined
      ? fallbackErrorResponse(
          "responseTooLarge",
          new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        )
      : errorResponseFor(
          identity,
          "protocol",
          "responseTooLarge",
          `response exceeds ${MAX_RESPONSE_BYTES} bytes`,
          []
        );
    frame = serializeFrame(finalResponse);
  }
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) {
    throw new Error("bounded protocol response exceeds response limit");
  }

  if (recorder !== undefined) {
    const withMetrics = serializeFrame({
      ...finalResponse,
      metrics: recorder.finish()
    });
    if (Buffer.byteLength(withMetrics) <= MAX_RESPONSE_BYTES) {
      frame = withMetrics;
    }
  }

  return frame;
}

function serializeFrame(response: BridgeResponse): string {
  return `${JSON.stringify(bridgeResponseSchema.parse(response))}\n`;
}

function requestErrorResponse(
  request: BridgeRequest,
  stage: BridgeErrorPayload["stage"],
  code: string,
  error: unknown,
  diagnostics: readonly BridgeDiagnostic[]
): Extract<BridgeResponse, { ok: false }> {
  return errorResponseFor(responseIdentityOf(request), stage, code, error, diagnostics);
}

function errorResponseFor(
  identity: ResponseIdentity,
  stage: BridgeErrorPayload["stage"],
  code: string,
  error: unknown,
  diagnostics: readonly BridgeDiagnostic[]
): Extract<BridgeResponse, { ok: false }> {
  return bridgeResponseSchema.parse({
    protocolVersion: 1,
    requestId: identity.requestId,
    kind: identity.kind,
    binding: identity.binding,
    ok: false,
    error: normalizeError(stage, code, error, diagnostics)
  }) as Extract<BridgeResponse, { ok: false }>;
}

function fallbackErrorResponse(
  code: string,
  error: unknown
): Extract<BridgeResponse, { ok: false }> {
  return bridgeResponseSchema.parse({
    protocolVersion: 1,
    requestId: "unbound-request",
    kind: "analyzeIntent",
    binding: {
      serviceEpoch: "0",
      graphGeneration: "0",
      graphDigest: FALLBACK_DIGEST
    },
    ok: false,
    error: normalizeError("protocol", code, error, [])
  }) as Extract<BridgeResponse, { ok: false }>;
}

function candidateBinding(request: BuildValidateCandidateRequest) {
  return {
    ...request.binding,
    attemptId: request.attemptId,
    scopeFingerprint: request.scopeFingerprint
  };
}

function normalizeError(
  stage: BridgeErrorPayload["stage"],
  code: string,
  error: unknown,
  diagnostics: readonly BridgeDiagnostic[]
): BridgeErrorPayload {
  return {
    stage,
    code,
    message: truncateUtf8(
      normalizeText(error instanceof Error ? error.message : String(error)),
      MAX_ERROR_MESSAGE_BYTES
    ),
    diagnostics: normalizeDiagnostics(diagnostics)
  };
}

function normalizeDiagnostics(
  diagnostics: readonly BridgeDiagnostic[]
): BridgeDiagnostic[] {
  const canonical = diagnostics
    .map((diagnostic) => ({
      nodeId: diagnostic.nodeId,
      modulePath:
        diagnostic.modulePath === null
          ? null
          : normalizeText(diagnostic.modulePath),
      message: normalizeText(diagnostic.message),
      code: diagnostic.code
    }))
    .sort(
      (left, right) =>
        compareText(left.nodeId ?? "", right.nodeId ?? "") ||
        compareText(left.modulePath ?? "", right.modulePath ?? "") ||
        left.code - right.code ||
        compareText(left.message, right.message)
  );

  const normalized: BridgeDiagnostic[] = [];
  let serializedBytes = serializedJsonBytes(normalized);
  for (const diagnostic of canonical) {
    const separatorBytes = normalized.length === 0 ? 0 : 1;
    const availableBytes =
      MAX_DIAGNOSTIC_BYTES - serializedBytes - separatorBytes;
    if (availableBytes <= 0) break;

    const minimal: BridgeDiagnostic = {
      ...diagnostic,
      modulePath: diagnostic.modulePath === null ? null : "",
      message: ""
    };
    if (serializedJsonBytes(minimal) > availableBytes) break;

    const modulePath = diagnostic.modulePath === null
      ? null
      : truncateToJsonBudget(
          diagnostic.modulePath,
          availableBytes,
          (value) => ({ ...minimal, modulePath: value })
        );
    const withoutMessage = { ...minimal, modulePath };
    const message = truncateToJsonBudget(
      diagnostic.message,
      availableBytes,
      (value) => ({ ...withoutMessage, message: value })
    );
    const bounded = { ...withoutMessage, message };
    const boundedBytes = serializedJsonBytes(bounded);
    normalized.push(bounded);
    serializedBytes += separatorBytes + boundedBytes;
  }
  if (serializedJsonBytes(normalized) > MAX_DIAGNOSTIC_BYTES) {
    throw new Error("normalized diagnostics exceed diagnostic limit");
  }
  return normalized;
}

function truncateToJsonBudget<T>(
  value: string,
  maxBytes: number,
  build: (value: string) => T
): string {
  if (serializedJsonBytes(build(value)) <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = codePointSafePrefix(value, middle);
    if (serializedJsonBytes(build(candidate)) <= maxBytes) {
      if (candidate.length > best.length) best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function codePointSafePrefix(value: string, end: number): string {
  let safeEnd = end;
  if (
    safeEnd > 0 &&
    safeEnd < value.length &&
    value.charCodeAt(safeEnd - 1) >= 0xd800 &&
    value.charCodeAt(safeEnd - 1) <= 0xdbff &&
    value.charCodeAt(safeEnd) >= 0xdc00 &&
    value.charCodeAt(safeEnd) <= 0xdfff
  ) {
    safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Back up to the previous complete UTF-8 code point.
    }
  }
  return "";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function protocolFailure(code: string, error: unknown): Error {
  return new WorkerFailure(code, error);
}

function failureCode(error: unknown, fallback: string): string {
  return error instanceof WorkerFailure ? error.code : fallback;
}

function writeOperationalError(code: string, error: unknown): void {
  const message = normalizeText(
    error instanceof Error ? error.message : String(error)
  );
  const line = truncateUtf8(`${code}: ${message}\n`, MAX_STDERR_BYTES);
  process.stderr.write(line);
}

async function writeStdout(frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

if (require.main === module) {
  // `--persistent` selects the serial frame loop; otherwise the entry is
  // exactly the one-shot worker it has always been.
  const runWorker = process.argv.includes("--persistent")
    ? runPersistentWorker
    : runOneShotWorker;
  runWorker().catch((error) => {
    process.exitCode = 1;
    writeOperationalError("workerFatal", error);
  });
}
