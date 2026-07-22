// Gate 3 (unkeyed noninferiority): shared test-only harness for driving the
// compiled Task-2 children (dist/gate3/{sqlite,kernel}-child.js) over
// stdin/stdout, exactly as gate3Child.test.ts's spawn/drive pattern (env,
// PATH, request-line write, ChildResult-line parse). Extracted here so
// gate3Schedule.test.ts (Task 3) can reuse it instead of reinventing it —
// not a .test.ts file itself, so vitest never collects it as a suite.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const mediumRoot = resolve(repoRoot, "examples/medium");
export const sqliteChildEntry = resolve(import.meta.dirname, "../dist/gate3/sqlite-child.js");
export const kernelChildEntry = resolve(import.meta.dirname, "../dist/gate3/kernel-child.js");

export const RENAME_TARGET = {
  modulePath: "src/types/user.ts",
  declarationName: "User",
  newName: "Account"
} as const;

export interface ChildResultLike {
  callerWallNs: number;
  childMaxRssBytes: number;
  published: true;
  lifecycle: string[];
}

export function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/** Spawn a compiled child, feed it one request line, and collect its ChildResult lines. Rejects on non-zero exit or timeout. */
export function runChild(entry: string, request: unknown, timeoutMs: number): Promise<ChildResultLike[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: credentialFreeEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const results: ChildResultLike[] = [];
    const stderrChunks: Buffer[] = [];
    let sawDone = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL");
        reject(new Error(`child ${entry} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.done === true) {
        sawDone = true;
        return;
      }
      results.push(parsed as unknown as ChildResultLike);
    });

    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => {
      settle(() => {
        if (code !== 0 || !sawDone) {
          reject(
            new Error(
              `child ${entry} exited ${code} (sawDone=${sawDone}): ${Buffer.concat(stderrChunks).toString("utf8")}`
            )
          );
          return;
        }
        resolvePromise(results);
      });
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}
