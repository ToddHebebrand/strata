let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const binding = request.kind === "buildValidateCandidate"
  ? { ...request.binding, attemptId: request.attemptId, scopeFingerprint: request.scopeFingerprint }
  : request.binding;
process.stdout.write(JSON.stringify({
  protocolVersion: 1,
  requestId: request.requestId,
  kind: request.kind,
  binding,
  ok: false,
  error: { stage: "protocol", code: "fixture", message: "fixture response", diagnostics: [] }
}) + "\n");
