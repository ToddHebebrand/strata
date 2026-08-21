import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CoordinationClient } from "@strata-code/coordination-client";
import { createQualifiedKernelSnapshot, type QualifiedTaskManifest } from "./tasks.js";

const packageRoot = resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "../..");

export interface RunningKernelService {
  child: ChildProcessByStdio<null, Readable, Readable>;
  socketPath: string;
  directory: string;
  auditPath: string;
  stop(stopOptions?: { preserveDirectory?: boolean }): Promise<void>;
}

/**
 * Spawn the production Rust daemon over a redb database seeded from a fresh
 * physical-path ingest of the corpus. The daemon is the sole authority;
 * callers receive only the socket endpoint.
 *
 * By default this uses a fresh tmpdir and always seeds generation 0. Passing
 * `options.directory` reuses (or creates) that directory instead: when a
 * `kernel.redb` already exists there, ingest/seed is skipped and the daemon
 * takes its recovery branch (it still receives `--snapshot` pointing at the
 * directory's `snapshot.json`, but ignores it on that branch) — this is the
 * parity/crash harness's restart-against-the-same-store path.
 */
export interface StartKernelServiceOptions {
  binaryPath?: string;
  bridgeWorkerPath?: string;
  env?: NodeJS.ProcessEnv;
  directory?: string;
  extraArgs?: string[];
  /**
   * Operator validation manifest (`--validation-manifest`). Supplying it puts
   * the daemon under the B-2 seed-green startup gate: it runs a full tsc (plus
   * the manifest's fixtures under vitest) against generation zero BEFORE it
   * prints its readiness line. Readiness therefore takes minutes, not
   * milliseconds — see {@link readinessTimeoutMsFor}.
   */
  validationManifestPath?: string;
  /** Explicit readiness budget; overrides the manifest-derived default. */
  readinessTimeoutMs?: number;
}

/** Readiness budget without a manifest — unchanged pre-B-2 behavior. */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
/**
 * Readiness budget for a manifest-gated daemon. Generous on purpose: the
 * seed-green baseline spawns a real tsc and (behaviorally) a real vitest over
 * the whole corpus before the socket binds, and the manifest's own per-step
 * budgets can legitimately total three minutes.
 */
export const GATED_READINESS_TIMEOUT_MS = 240_000;

/**
 * The readiness budget for a given start. An explicit override always wins;
 * otherwise a manifest — passed either as `validationManifestPath` or already
 * present in `extraArgs` — scales the budget, and everything else keeps the
 * historic 10s.
 */
export function readinessTimeoutMsFor(options?: StartKernelServiceOptions): number {
  if (options?.readinessTimeoutMs !== undefined) return options.readinessTimeoutMs;
  const gated =
    options?.validationManifestPath !== undefined ||
    (options?.extraArgs ?? []).includes("--validation-manifest");
  return gated ? GATED_READINESS_TIMEOUT_MS : DEFAULT_READINESS_TIMEOUT_MS;
}

export async function startKernelService(
  corpusRoot: string,
  options?: StartKernelServiceOptions
): Promise<RunningKernelService> {
  const binary = options?.binaryPath ?? join(repoRoot, "target/debug/strata-kernel-service");
  const bridgeWorker = options?.bridgeWorkerPath ?? join(repoRoot, "packages/kernel-bridge/dist/worker.js");
  const directory = options?.directory ?? mkdtempSync(join(tmpdir(), "strata-phase6-service-"));
  mkdirSync(directory, { recursive: true });
  const snapshotPath = join(directory, "snapshot.json");
  const auditPath = join(directory, "audit.jsonl");
  const dbPath = join(directory, "kernel.redb");
  if (!existsSync(dbPath)) {
    writeFileSync(snapshotPath, JSON.stringify(createQualifiedKernelSnapshot(corpusRoot)), "utf8");
  }
  const child = spawn(binary, [
    "serve", "--db", dbPath, "--snapshot", snapshotPath,
    "--bridge-worker", bridgeWorker,
    "--source-root", join(corpusRoot, "src"), "--corpus-root", corpusRoot,
    "--audit", auditPath, "--socket-token", randomUUID(),
    ...(options?.validationManifestPath === undefined
      ? []
      : ["--validation-manifest", options.validationManifestPath]),
    ...(options?.extraArgs ?? [])
  ], { cwd: repoRoot, env: options?.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const line = await new Promise<string>((resolveLine, reject) => {
    const reader = createInterface({ input: child.stdout });
    const readinessTimeoutMs = readinessTimeoutMsFor(options);
    const timer = setTimeout(
      () => reject(new Error(`service readiness timed out after ${readinessTimeoutMs}ms`)),
      readinessTimeoutMs
    );
    reader.once("line", (value) => { clearTimeout(timer); reader.close(); resolveLine(value); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${Buffer.concat(stderr)}`)); });
  });
  const ready = JSON.parse(line) as { socketPath: string };
  return {
    child,
    socketPath: ready.socketPath,
    directory,
    auditPath,
    async stop(stopOptions?: { preserveDirectory?: boolean }) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
      if (!stopOptions?.preserveDirectory) rmSync(directory, { recursive: true, force: true });
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
