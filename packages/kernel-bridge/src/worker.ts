import { analyzeIntent } from "./analyze";
import { buildValidateCandidate } from "./candidate";
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
  analyzeIntent: (request: AnalyzeIntentRequest) => ReturnType<typeof analyzeIntent>;
  buildValidateCandidate: (
    request: BuildValidateCandidateRequest
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
    await emitResponse(response, undefined);
    writeOperationalError(code, error);
    return;
  }

  try {
    const response = dispatch(request, handlers);
    await emitResponse(response, request);
  } catch (error) {
    const response = requestErrorResponse(
      request,
      request.kind === "analyzeIntent" ? "analyze" : "mutate",
      failureCode(error, "handlerFailed"),
      error,
      []
    );
    await emitResponse(response, request);
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

function dispatch(request: BridgeRequest, handlers: WorkerHandlers): BridgeResponse {
  if (request.kind === "analyzeIntent") {
    const result = handlers.analyzeIntent(request);
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

  const result = handlers.buildValidateCandidate(request);
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
  request: BridgeRequest | undefined
): Promise<void> {
  let frame = serializeFrame(response);
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) {
    const bounded = request === undefined
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
    frame = serializeFrame(bounded);
  }
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) {
    throw new Error("bounded protocol response exceeds response limit");
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
  let remaining = MAX_DIAGNOSTIC_BYTES;
  for (const diagnostic of canonical) {
    if (remaining <= 0) break;
    const modulePath = diagnostic.modulePath === null
      ? null
      : truncateUtf8(diagnostic.modulePath, remaining);
    remaining -= Buffer.byteLength(modulePath ?? "", "utf8");
    const message = truncateUtf8(diagnostic.message, remaining);
    remaining -= Buffer.byteLength(message, "utf8");
    normalized.push({ ...diagnostic, modulePath, message });
  }
  return normalized;
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
