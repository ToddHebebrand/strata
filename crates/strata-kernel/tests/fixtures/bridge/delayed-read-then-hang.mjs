setTimeout(() => {
  process.stdin.on("data", () => {});
  process.stdin.resume();
}, 700);

setTimeout(() => process.exit(0), 10_000);
