let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const response = JSON.stringify({
  protocolVersion: 1,
  requestId: request.requestId,
  kind: request.kind,
  binding: request.binding,
  ok: false,
  error: { stage: "protocol", code: "fixture", message: "first", diagnostics: [] }
});
process.stdout.write(response + "\n" + response + "\n");
