import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Strict, versioned artifact schemas. Every run directory is immutable after
 * finalization; ordering claims use monotonic offsets, not wall clocks.
 */

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const roleBoundsSchema = z
  .object({ maxTurns: z.number().int().positive(), wallTimeMs: z.number().int().positive(), maxBudgetUsd: z.number().positive() })
  .strict();

const scheduleEntrySchema = z
  .object({
    trialId: z.string().min(1),
    scenario: z.enum(["D", "M", "R", "S", "X", "G"]),
    repetition: z.number().int().positive(),
    armOrder: z.enum(["strata-first", "baseline-first"]),
    taskProcessMapping: z
      .object({ "agent-1": z.enum(["process-1", "process-2"]), "agent-2": z.enum(["process-1", "process-2"]) })
      .strict(),
    concurrentTaskRelease: z.literal(true)
  })
  .strict();

export const experimentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusVariant: z.literal("x-namespace-enriched-v1"),
    sourceDigest: digestSchema,
    graphDigest: digestSchema,
    taskRegistrationDigest: digestSchema,
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    provider: z.string().min(1),
    model: z.string().min(1),
    taskRoleBounds: roleBoundsSchema,
    integrationRoleBounds: roleBoundsSchema,
    teamWallMs: z.number().int().positive(),
    projectedMaxUsd: z.number().positive(),
    seed: z.string().min(1),
    schedule: z
      .object({
        seed: z.string().min(1),
        trialsPerScenario: z.number().int().positive(),
        scenarios: z.array(z.enum(["D", "M", "R", "S", "X", "G"])).length(6),
        entries: z.array(scheduleEntrySchema).min(6)
      })
      .strict(),
    typescriptRootNames: z.array(z.string().min(1)).min(1),
    compilerOptions: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])),
    fixtureAllowlists: z.record(z.string(), z.array(z.string().min(1))),
    fixtureDigests: z.record(z.string(), digestSchema),
    excludedInputs: z.record(z.string(), digestSchema),
    boundary: z.array(
      z
        .object({
          path: z.string().min(1),
          target: z.string().nullable(),
          classification: z.string().min(1),
          textualOccurrenceCount: z.number().int().nonnegative(),
          resolvedReferenceCount: z.number().int().nonnegative(),
          contentDigest: digestSchema,
          disposition: z.literal("frozen_excluded_historical")
        })
        .strict()
    ),
    packageVersions: z.record(z.string(), z.string()),
    machine: z.record(z.string(), z.string()),
    approval: z.object({ approvedBy: z.string().min(1), messageReference: z.string().min(1) }).strict()
  })
  .strict();

export const sessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    trialId: z.string().min(1),
    arm: z.enum(["strata", "baseline"]),
    role: z.enum(["task-1", "task-2", "integration"]),
    event: z.object({ type: z.string().min(1), detail: z.string().optional() }).strict()
  })
  .strict();

export const serviceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    clientId: z.string().min(1),
    action: z.string().min(1),
    tick: z.string().regex(/^\d+$/),
    state: z.string().min(1)
  })
  .strict();

export const kernelEventRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.string().regex(/^\d+$/),
    changeSetId: z.string().min(1),
    kind: z.string().min(1)
  })
  .strict();

export const gitEventRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string().min(1),
    kind: z.string().min(1),
    detail: z.string().optional()
  })
  .strict();

export const verificationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: z.enum(["D", "M", "R", "S", "X", "G"]),
    arm: z.enum(["strata", "baseline"]),
    green: z.boolean(),
    generationZero: z.boolean(),
    rootNames: z.array(z.string().min(1)).min(1),
    compilerOptions: z.record(z.string(), z.unknown()),
    fixtureNames: z.array(z.string().min(1)),
    fixtureDigests: z.record(z.string(), digestSchema),
    excludedInputs: z.record(z.string(), digestSchema),
    boundaryDispositions: z
      .array(
        z
          .object({
            path: z.string().min(1),
            target: z.string().nullable(),
            disposition: z.literal("frozen_excluded_historical")
          })
          .strict()
      )
      .min(1),
    sourceDigest: digestSchema,
    finalTreeDigest: digestSchema,
    configurationDigest: digestSchema
  })
  .strict();

export const teamRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string().min(1),
    arm: z.enum(["strata", "baseline"]),
    status: z.enum(["success", "failed"]),
    makespanMs: z.number().nonnegative(),
    totalAgentCostUsd: z.number().nonnegative(),
    failures: z.array(z.string()),
    timeouts: z.array(z.string())
  })
  .strict();

export const summaryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialsRecorded: z.number().int().nonnegative(),
    sessionsRecorded: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    failures: z.number().int().nonnegative(),
    generatedFrom: z.literal("finalized trial records")
  })
  .strict();

const APPEND_STREAMS = {
  sessions: sessionRecordSchema,
  service: serviceRecordSchema,
  "kernel-events": kernelEventRecordSchema,
  "git-events": gitEventRecordSchema
} as const;

export const tasksRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: z.enum(["D", "M", "R", "S", "X", "G"]),
    assignments: z
      .array(
        z
          .object({
            role: z.enum(["agent-1", "agent-2"]),
            taskBody: z.string().min(1),
            promptHashes: z.object({ strata: digestSchema, baseline: digestSchema }).strict()
          })
          .strict()
      )
      .length(2)
  })
  .strict();

export const canonicalAuditRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string().min(1),
    arm: z.enum(["strata", "baseline"]),
    finalGeneration: z.string().regex(/^\d+$/),
    operations: z.array(
      z
        .object({
          operationId: z.string().min(1),
          changeSetId: z.string().min(1),
          actor: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

const WRITE_STREAMS = {
  "experiment-manifest": experimentManifestSchema,
  verification: verificationRecordSchema,
  team: teamRecordSchema,
  tasks: tasksRecordSchema,
  "canonical-audit": canonicalAuditRecordSchema
} as const;

export interface ArtifactScope {
  trialId?: string;
  arm?: "strata" | "baseline";
  packetId?: string;
}

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

function scopedPath(stream: WriteStream, scope: ArtifactScope | undefined): string {
  const component = (value: string | undefined, name: string): string => {
    if (!value || !SAFE_PATH_COMPONENT.test(value)) {
      throw new Error(`artifact scope ${name} is required and must be a safe path component`);
    }
    return value;
  };
  if (stream === "experiment-manifest") return "experiment-manifest.json";
  if (stream === "tasks") return join("tasks", `${component(scope?.packetId, "packetId")}.json`);
  return join(
    "trials",
    component(scope?.trialId, "trialId"),
    component(scope?.arm, "arm"),
    `${stream}.json`
  );
}

export type AppendStream = keyof typeof APPEND_STREAMS;
export type WriteStream = keyof typeof WRITE_STREAMS;

export interface ArtifactClock {
  wallMs(): number;
  monoMs(): number;
}

const ALWAYS_REDACTED = [/sk-ant-[A-Za-z0-9_-]+/g, /\/tmp\/strata-lc\/[^\s"']+/g];

function redactValue(value: unknown, redactions: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of redactions) result = result.split(secret).join("[redacted]");
    for (const pattern of ALWAYS_REDACTED) result = result.replace(pattern, "[redacted]");
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redactions));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redactions)])
    );
  }
  return value;
}

export interface ArtifactRun {
  root: string;
  append(stream: AppendStream, record: unknown): void;
  write(stream: WriteStream, record: unknown, scope?: ArtifactScope): void;
  /** Raw evidence snapshot (e.g., a final tree file), write-once per path. */
  writeEvidence(scope: ArtifactScope, relativePath: string, content: string): void;
  finalize(summary: unknown): void;
}

export function createArtifactRun(params: {
  root: string;
  clock: ArtifactClock;
  redactions: readonly string[];
}): ArtifactRun {
  const root = resolve(params.root);
  if (existsSync(join(root, "finalized.json"))) {
    throw new Error(`refusing to overwrite a finalized run at ${root}`);
  }
  mkdirSync(root, { recursive: true });
  let finalized = false;

  const assertOpen = (): void => {
    if (finalized || existsSync(join(root, "finalized.json"))) {
      throw new Error("artifact run is finalized and immutable");
    }
  };

  const stamp = (record: unknown): Record<string, unknown> => ({
    ...(record as Record<string, unknown>),
    wallTimeIso: new Date(params.clock.wallMs()).toISOString(),
    monotonicMs: params.clock.monoMs()
  });

  return {
    root,
    append(stream, record): void {
      assertOpen();
      const validated = APPEND_STREAMS[stream].parse(record);
      const redacted = redactValue(stamp(validated), params.redactions);
      appendFileSync(join(root, `${stream}.jsonl`), `${JSON.stringify(redacted)}\n`, "utf8");
    },
    write(stream, record, scope): void {
      assertOpen();
      const relative = scopedPath(stream, scope);
      const path = join(root, relative);
      if (existsSync(path)) throw new Error(`artifact ${relative} is write-once`);
      const validated = WRITE_STREAMS[stream].parse(record);
      const redacted = redactValue(stamp(validated), params.redactions);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
    },
    writeEvidence(scope, relativePath, content): void {
      assertOpen();
      const trialId = scope.trialId ?? "";
      const arm = scope.arm ?? "";
      if (!SAFE_PATH_COMPONENT.test(trialId) || !SAFE_PATH_COMPONENT.test(arm)) {
        throw new Error("evidence scope requires safe trialId and arm components");
      }
      if (relativePath.split("/").some((part) => part === ".." || part === "" || part === ".")) {
        throw new Error(`evidence path ${relativePath} must be a clean relative path`);
      }
      const path = join(root, "trials", trialId, arm, "evidence", relativePath);
      if (existsSync(path)) throw new Error(`evidence ${relativePath} is write-once`);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, redactValue(content, params.redactions) as string, "utf8");
    },
    finalize(summary): void {
      assertOpen();
      const validated = summaryRecordSchema.parse(summary);
      writeFileSync(
        join(root, "summary.json"),
        `${JSON.stringify(redactValue(stamp(validated), params.redactions), null, 2)}\n`,
        "utf8"
      );
      const contentHashes: Record<string, string> = {};
      const visit = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const relative = `${prefix}${entry.name}`;
          if (entry.isDirectory()) visit(join(directory, entry.name), `${relative}/`);
          else if (relative !== "finalized.json") {
            contentHashes[relative] = createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex");
          }
        }
      };
      visit(root, "");
      writeFileSync(
        join(root, "finalized.json"),
        `${JSON.stringify({ schemaVersion: 1, contentHashes }, null, 2)}\n`,
        "utf8"
      );
      finalized = true;
    }
  };
}

/** Crash-safe JSONL read: complete lines parse; a truncated tail is reported, not lost. */
export function readArtifactStream(path: string): { records: unknown[]; partialTail: boolean } {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const trailing = lines.pop() ?? "";
  const records: unknown[] = [];
  let partialTail = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    records.push(JSON.parse(line));
  }
  if (trailing.trim().length > 0) partialTail = true;
  return { records, partialTail };
}
