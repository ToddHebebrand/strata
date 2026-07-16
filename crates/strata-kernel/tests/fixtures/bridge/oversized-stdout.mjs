for await (const _chunk of process.stdin) { /* drain */ }
process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
