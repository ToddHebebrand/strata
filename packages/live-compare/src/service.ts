import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CoordinationClient } from "./client.js";
import { createQualifiedKernelSnapshot, type QualifiedTaskManifest } from "./tasks.js";

const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

export interface RunningKernelService {
  child: ChildProcessByStdio<null, Readable, Readable>;
  socketPath: string;
  directory: string;
  auditPath: string;
  stop(): Promise<void>;
}

/**
 * Spawn the production Rust daemon over a fresh redb database seeded from a
 * fresh physical-path ingest of the corpus. The daemon is the sole authority;
 * callers receive only the socket endpoint.
 */
export async function startKernelService(
  corpusRoot: string,
  options?: { binaryPath?: string; bridgeWorkerPath?: string; env?: NodeJS.ProcessEnv }
): Promise<RunningKernelService> {
  const binary = options?.binaryPath ?? join(repoRoot, "target/debug/strata-kernel-service");
  const bridgeWorker = options?.bridgeWorkerPath ?? join(repoRoot, "packages/kernel-bridge/dist/worker.js");
  const directory = mkdtempSync(join(tmpdir(), "strata-phase6-service-"));
  const snapshotPath = join(directory, "snapshot.json");
  const auditPath = join(directory, "audit.jsonl");
  writeFileSync(snapshotPath, JSON.stringify(createQualifiedKernelSnapshot(corpusRoot)), "utf8");
  const child = spawn(binary, [
    "serve", "--db", join(directory, "kernel.redb"), "--snapshot", snapshotPath,
    "--bridge-worker", bridgeWorker,
    "--source-root", join(corpusRoot, "src"), "--corpus-root", corpusRoot,
    "--audit", auditPath, "--socket-token", randomUUID()
  ], { cwd: repoRoot, env: options?.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const line = await new Promise<string>((resolveLine, reject) => {
    const reader = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error("service readiness timed out")), 10_000);
    reader.once("line", (value) => { clearTimeout(timer); reader.close(); resolveLine(value); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${Buffer.concat(stderr)}`)); });
  });
  const ready = JSON.parse(line) as { socketPath: string };
  return {
    child,
    socketPath: ready.socketPath,
    directory,
    auditPath,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Materialize the shared final tree: copy the registered corpus, inspect only
 * the operation-affected registered statements, and reconstruct every touched
 * module from updated payloads plus registered generation-zero payloads.
 */
export async function materializeFinalTree(
  client: CoordinationClient,
  corpusRoot: string,
  manifest: QualifiedTaskManifest,
  affectedNodeIds: readonly string[]
): Promise<string> {
  const output = mkdtempSync(join(tmpdir(), "strata-phase6-final-"));
  cpSync(corpusRoot, output, { recursive: true });
  const registered = new Set(Object.values(manifest.sourceFiles).flatMap((file) => file.statementIds));
  const ids = [...new Set(affectedNodeIds)].filter((id) => registered.has(id));
  const updated = new Map<string, string>();
  for (let index = 0; index < ids.length; index += 200) {
    const response = await client.request({ type: "inspect_nodes", nodeIds: ids.slice(index, index + 200) }, 120_000) as any;
    for (const node of response.nodes) updated.set(node.nodeId, node.payload);
  }
  for (const [path, file] of Object.entries(manifest.sourceFiles)) {
    if (!file.statementIds.some((id) => updated.has(id))) continue;
    writeFileSync(
      join(output, path),
      file.statementIds.map((id, index) => updated.get(id) ?? file.statementPayloads[index]!).join(""),
      "utf8"
    );
  }
  return output;
}
