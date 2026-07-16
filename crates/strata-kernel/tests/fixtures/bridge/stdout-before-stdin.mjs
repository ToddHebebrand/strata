import fs from "node:fs";
fs.writeSync(1, Buffer.alloc(1024 * 1024, 0x20));
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  protocolVersion: 1,
  requestId: request.requestId,
  kind: request.kind,
  binding: request.binding,
  ok: false,
  error: { stage: "protocol", code: "fixture", message: "drained", diagnostics: [] }
}) + "\n");
