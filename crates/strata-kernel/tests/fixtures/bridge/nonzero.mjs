for await (const _chunk of process.stdin) { /* drain */ }
process.stderr.write("boom\n");
process.exitCode = 7;
