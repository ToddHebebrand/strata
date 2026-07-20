import { analyzeIntent } from "./analyze";
import { buildValidateCandidate } from "./candidate";
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
  // The semantic decision — which frame is the response — is settled here,
  // exactly as before metrics existed. `finalResponse`/`frame` are the
  // bound-checked semantic result; metrics are only ever appended on top,
  // never allowed to change which semantic frame was chosen.
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

  await writeStdout(frame);
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
  runOneShotWorker().catch((error) => {
    process.exitCode = 1;
    writeOperationalError("workerFatal", error);
  });
}
