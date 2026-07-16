for await (const _chunk of process.stdin) { /* drain */ }
process.stdout.write('{"protocolVersion":1');
