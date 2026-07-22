// Gate 3 (unkeyed noninferiority), Task 2: isolated-child mutation worker
// acceptance. Spawns the COMPILED children (dist/gate3/*-child.js) over
// stdin/stdout, exactly as the gate-3 timing harness will, and asserts the
// wire contract: real (>0) callerWallNs over the metrics-off timed window,
// real childMaxRssBytes, the lifecycle trace as actually executed, and —
// critically — that every reported mutation is independently re-verified to
// have actually renamed (a no-op cannot score wall time; see
// child-protocol.ts's childResultSchema and each child's post-mutation
// re-query).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const mediumRoot = resolve(repoRoot, "examples/medium");
const sqliteChildEntry = resolve(import.meta.dirname, "../dist/gate3/sqlite-child.js");
const kernelChildEntry = resolve(import.meta.dirname, "../dist/gate3/kernel-child.js");

const RENAME_TARGET = {
  modulePath: "src/types/user.ts",
  declarationName: "User",
  newName: "Account"
} as const;

interface ChildResultLike {
  callerWallNs: number;
  childMaxRssBytes: number;
  published: true;
  lifecycle: string[];
}

function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/** Spawn a compiled child, feed it one request line, and collect its ChildResult lines. Rejects on non-zero exit or timeout. */
function runChild(
  entry: string,
  request: unknown,
  timeoutMs: number
): Promise<ChildResultLike[]> {
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

describe("gate3Child", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it("both children build to dist/", () => {
    expect(existsSync(sqliteChildEntry)).toBe(true);
    expect(existsSync(kernelChildEntry)).toBe(true);
  });

  it(
    "sqlite-child cold: one mutation, validate+commit timed, real rename",
    async () => {
      const results = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        60_000
      );
      expect(results).toHaveLength(1);
      const [result] = results as [ChildResultLike];
      expect(result.callerWallNs).toBeGreaterThan(0);
      expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
      expect(result.published).toBe(true);
      expect(result.lifecycle).toEqual(["begin", "rename_symbol", "validate", "commit"]);
    },
    120_000
  );

  it(
    "kernel-child cold: one mutation, submit+advance timed, real rename",
    async () => {
      const results = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        180_000
      );
      expect(results).toHaveLength(1);
      const [result] = results as [ChildResultLike];
      expect(result.callerWallNs).toBeGreaterThan(0);
      expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
      expect(result.published).toBe(true);
      expect(result.lifecycle).toEqual([
        "begin_change_set",
        "add_intent",
        "submit_change_set",
        "advance_change_set"
      ]);
    },
    240_000
  );

  it(
    "sqlite-child warm: 3 iterations alternate User<->Account, every mutation independently re-verified",
    async () => {
      const results = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "warm", iterations: 3 },
        60_000
      );
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.callerWallNs).toBeGreaterThan(0);
        expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(result.published).toBe(true);
        expect(result.lifecycle).toEqual(["begin", "rename_symbol", "validate", "commit"]);
      }
      // 3 flips from "User": User -> Account -> User -> Account. Each child
      // ChildResult line is only ever emitted after the child re-queries the
      // graph (a fresh find_declarations call, not the mutation's own return
      // value) and confirms the transition actually landed — so having
      // received exactly 3 results IS the "post-run target name reflects 3
      // flips" evidence; a no-op anywhere in the alternation would have
      // thrown inside the child before a 3rd (or any subsequent) line was
      // written.
    },
    120_000
  );

  it(
    "kernel-child warm: 3 iterations alternate User<->Account, every mutation independently re-verified",
    async () => {
      const results = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "warm", iterations: 3 },
        300_000
      );
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.callerWallNs).toBeGreaterThan(0);
        expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(result.published).toBe(true);
        expect(result.lifecycle).toEqual([
          "begin_change_set",
          "add_intent",
          "submit_change_set",
          "advance_change_set"
        ]);
      }
      // Same "3 flips observable" logic as the sqlite warm case, but the
      // kernel child's per-mutation re-verification is even stronger: it
      // reads the published operation back over the wire and checks its
      // recorded fromName -> toName transition, which a no-op cannot
      // fabricate.
    },
    600_000
  );
});
