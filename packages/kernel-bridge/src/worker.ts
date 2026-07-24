import { analyzeIntent } from "./analyze";
import { buildValidateCandidate } from "./candidate";
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
  type BridgeDiagnostic,
  type BridgeErrorPayload,
  type BridgeRequest,
  type BridgeResponse,
  type BuildValidateCandidateRequest
} from "./protocol";

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
    await emitResponse(response, request, recorder);
  } catch (error) {
    const response = requestErrorResponse(
      request,
      request.kind === "analyzeIntent" ? "analyze" : "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await emitResponse(response, request, recorder);
    writeOperationalError(response.error.code, error);
  }
}

/**
 * Persistent mode (bridge-persistence slice, Task 4): a strictly serial
 * request loop over the u32-LE length-prefixed frame transport the Rust host
 * (`bridge/persistent.rs`) speaks — the worker-side mirror of the host's
 * single-flight discipline. One frame is read, exactly one response frame
 * carrying the request's `requestId` is written, and only then is the next
 * frame read.
 *
 * Semantic kinds (`analyzeIntent` / `buildValidateCandidate`) route through
 * the SAME `dispatch` the one-shot path uses, with a fresh per-request
 * `StageRecorder` under the same `--emit-metrics` opt-in — so `workerRun`
 * metrics stay per-trip comparable across the two transports. `sync` is the
 * mirror-sync task's (Task 6): until it lands, a structured
 * `{kind:"error", code:"unsupported"}` frame — never a crash. `shutdown`
 * is acked then exits 0; stdin EOF (the host's clean-shutdown contract) also
 * exits 0. A failure inside one request answers THAT request with an error
 * frame and keeps serving; process exit stays reserved for unrecoverable
 * transport states (oversized/truncated inbound frame → the fatal handler).
 */
export async function runPersistentWorker(
  handlers: WorkerHandlers = defaultHandlers
): Promise<void> {
  const emitMetrics = process.argv.includes("--emit-metrics");
  for await (const body of readFrames(process.stdin, MAX_REQUEST_FRAME_BYTES)) {
    const shutdown = await servePersistentFrame(body, handlers, emitMetrics);
    if (shutdown) {
      // The ack write above has been handed to the OS pipe; exiting here
      // honors "respond, then exit 0" without waiting on open stdin.
      process.exit(0);
    }
  }
}

/** Serves one inbound frame; returns true only for an acked `shutdown`. */
async function servePersistentFrame(
  body: Buffer,
  handlers: WorkerHandlers,
  emitMetrics: boolean
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
  if (kind === "sync") {
    await writeLoopErrorFrame(
      requestId,
      "unsupported",
      new Error("sync frames are not supported until mirror sync lands (Task 6)")
    );
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
    await writePersistentResponse(response, request, recorder);
  } catch (error) {
    const response = requestErrorResponse(
      request,
      request.kind === "analyzeIntent" ? "analyze" : "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await writePersistentResponse(response, request, recorder);
    writeOperationalError(response.error.code, error);
  }
  return false;
}

/**
 * Frames a semantic response for the persistent transport. The body is the
 * exact newline-terminated string the one-shot path would write (bound
 * already enforced inside), so the length-prefixed write can never overflow.
 */
async function writePersistentResponse(
  response: BridgeResponse,
  request: BridgeRequest,
  recorder?: StageRecorder
): Promise<void> {
  await writeFrame(
    process.stdout,
    Buffer.from(boundedResponseFrame(response, request, recorder), "utf8"),
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
  request: BridgeRequest | undefined,
  recorder?: StageRecorder
): Promise<void> {
  await writeStdout(boundedResponseFrame(response, request, recorder));
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
  request: BridgeRequest | undefined,
  recorder?: StageRecorder
): string {
  let finalResponse = response;
  let frame = serializeFrame(finalResponse);
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) {
    finalResponse = request === undefined
      ? fallbackErrorResponse(
          "responseTooLarge",
          new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        )
      : requestErrorResponse(
          request,
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
  return bridgeResponseSchema.parse({
    protocolVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    binding:
      request.kind === "buildValidateCandidate"
        ? candidateBinding(request)
        : request.binding,
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
