import { defineConfig } from "vitest/config";

// These suites are heavyweight integration tests: several spawn the real Rust
// daemon plus Node bridge workers and run tsc repeatedly. Running test files
// concurrently makes them contend for CPU and time out nondeterministically,
// so files execute sequentially.
export default defineConfig({
  test: {
    fileParallelism: false
  }
});
