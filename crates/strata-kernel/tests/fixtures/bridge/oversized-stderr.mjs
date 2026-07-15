for await (const _chunk of process.stdin) { /* drain */ }
process.stderr.write(Buffer.alloc(64 * 1024 + 1, 0x78));
