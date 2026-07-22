// Gate 3 (unkeyed noninferiority), Task 7: provenance collection.
//
// Every impure collector (git subprocess, rustc subprocess, filesystem
// hashing, os introspection) lives here, isolated from report.ts's pure
// assembly/verdict-resolution logic — so `gate3Report.unit.test.ts` can
// build `Provenance` fixtures directly (or mock this module's exports)
// without ever touching git/rustc/the filesystem, while a single real
// `collectProvenance()` smoke test elsewhere exercises the genuine
// collectors cheaply and in the foreground.
//
// `timestamp` is ALWAYS supplied by the caller — nothing in this module
// calls `Date.now()`/`new Date()`, so `collectProvenance()`'s own output is
// deterministic given a fixed repo/binary/environment state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { kernelServiceBinary } from "../gate1.js";

const packageRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

/**
 * `{ headSha, dirty, harnessDigest, daemonBinarySha, os, cpu, nodeVersion,
 * rustVersion, scheduleSeed?, timestamp? }` — everything a committed gate-3
 * artifact must bind itself to (plan Global Constraints, "Provenance-bound
 * artifacts"). `scheduleSeed`/`timestamp` are optional because
 * `collectProvenance` itself knows neither — both are run-specific and
 * threaded in by the caller.
 */
export interface Provenance {
  headSha: string;
  dirty: boolean;
  harnessDigest: string;
  daemonBinarySha: string;
  os: string;
  cpu: string;
  nodeVersion: string;
  rustVersion: string;
  scheduleSeed?: number;
  timestamp?: string;
  /**
   * Task 8 (Task-7 review obligation 1): the metrics mode of this run, made
   * explicit in the committed artifact. Always `"timing:off;characterization:on"`
   * for a real gate-3 run — the noninferiority ratio is measured metrics-OFF on
   * both arms (B1), and the separate kernel-server characterization is the only
   * metrics-ON leg. Optional so hand-built `Provenance` unit fixtures that
   * predate this field keep compiling and `toEqual`-comparing unchanged.
   */
  metricsMode?: string;
}

/** The canonical metrics-mode string for a real gate-3 run (timing metrics-off both arms; characterization metrics-on). */
export const GATE3_METRICS_MODE = "timing:off;characterization:on";

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function posix(value: string): string {
  return value.split(sep).join("/");
}

/** Every regular file under `root`, sorted by posix-relative path (deterministic regardless of `readdirSync` order). */
function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  visit(root);
  return result.sort((left, right) => posix(relative(root, left)).localeCompare(posix(relative(root, right))));
}

/**
 * sha256 over the sorted `{relPath: sha256(contents)}` map of every file
 * under the compiled `dist/gate3/**` — the actual harness bundle this
 * measurement run executes. Throws if the directory is missing (build the
 * package first) rather than silently hashing nothing.
 */
export function harnessDigest(distGate3Dir: string = resolve(packageRoot, "dist", "gate3")): string {
  if (!existsSync(distGate3Dir)) {
    throw new Error(
      `harnessDigest: ${distGate3Dir} does not exist — build the package first ` +
        `(pnpm --filter @strata-code/live-compare build)`
    );
  }
  const digestByRelPath: Record<string, string> = {};
  for (const absolute of filesBelow(distGate3Dir)) {
    digestByRelPath[posix(relative(distGate3Dir, absolute))] = sha256Hex(readFileSync(absolute));
  }
  return sha256Hex(
    JSON.stringify(
      Object.keys(digestByRelPath)
        .sort()
        .map((relPath) => [relPath, digestByRelPath[relPath]])
    )
  );
}

/** sha256 of the `strata-kernel-service` binary the kernel arm actually ran against this measurement run. */
export function daemonBinarySha(binaryPath: string = kernelServiceBinary()): string {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `daemonBinarySha: ${binaryPath} does not exist — build the daemon first (cargo build -p strata-kernel)`
    );
  }
  return sha256Hex(readFileSync(binaryPath));
}

function gitHeadSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** `true` iff `git status --porcelain` reports any change (untracked, modified, or staged). */
function gitDirty(): boolean {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
}

function rustcVersion(): string {
  return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
}

function cpuModel(): string {
  const first = cpus()[0];
  return first ? first.model : "unknown";
}

export interface CollectProvenanceOptions {
  /** The balanced-schedule seed this measurement run used — threaded through, never guessed. */
  scheduleSeed?: number;
  /** Injected by the caller — this module never calls `Date.now()`/`new Date()` itself. */
  timestamp?: string;
  /** Metrics mode string for the run; defaults to `GATE3_METRICS_MODE`. */
  metricsMode?: string;
}

/**
 * Collects the full provenance record for one gate-3 measurement run: real
 * git HEAD sha + dirty flag, the built harness's own content digest, the
 * daemon binary's digest, OS/CPU, and Node/Rust versions. Entirely impure
 * (subprocess + filesystem reads) by design — kept out of report.ts so the
 * report-assembly and verdict-resolution functions stay pure and
 * fixture-testable.
 */
export function collectProvenance(options: CollectProvenanceOptions = {}): Provenance {
  return {
    headSha: gitHeadSha(),
    dirty: gitDirty(),
    harnessDigest: harnessDigest(),
    daemonBinarySha: daemonBinarySha(),
    os: `${platform()} ${release()}`,
    cpu: cpuModel(),
    nodeVersion: process.version,
    rustVersion: rustcVersion(),
    scheduleSeed: options.scheduleSeed,
    timestamp: options.timestamp,
    metricsMode: options.metricsMode ?? GATE3_METRICS_MODE
  };
}
