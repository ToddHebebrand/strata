// Gate 3 (unkeyed noninferiority), Task 2: the isolated-child wire protocol.
//
// Each child (sqlite-child.ts, kernel-child.ts) is a compiled entrypoint
// driven over stdin/stdout as newline-delimited JSON: the parent writes ONE
// request line, the child streams zero or more `ChildResult` lines (one per
// completed, independently-verified mutation) and then a terminal
// `{ done: true }` line before exiting 0. A non-zero exit with no terminal
// line means the child failed before completing its plan — the parent's
// stderr capture carries the diagnostic.
//
// This intentionally stays a thin, symmetric schema: both arms (SQLite
// validate+commit, kernel submit+advance) report the same shape so the
// gate-3 timing harness can treat them identically.
import { createInterface } from "node:readline";
import { z } from "zod";

export const renameTargetSchema = z
  .object({
    /** Corpus-relative POSIX path, e.g. "src/types/user.ts". */
    modulePath: z.string().min(1),
    declarationName: z.string().min(1),
    newName: z.string().min(1)
  })
  .strict();
export type ChildRenameTarget = z.infer<typeof renameTargetSchema>;

export const childRequestSchema = z
  .object({
    corpusRoot: z.string().min(1),
    target: renameTargetSchema,
    mode: z.enum(["cold", "warm"]),
    /** Ignored (forced to 1) in "cold" mode; the iteration count in "warm" mode. */
    iterations: z.number().int().positive(),
    /**
     * Task 4 addition, additive and backward-compatible: only meaningful
     * when `mode === "warm"`. When true, the child does NOT auto-loop
     * through `iterations` eagerly; instead it awaits one `ChildStepRequest`
     * line per iteration before computing and reporting that iteration's
     * mutation. This is what lets a persistent-warm-child driver keep two
     * long-lived children (one per arm) in per-iteration lockstep instead of
     * letting both arms race each other's timed windows concurrently.
     * Omitted (or false), the child behaves exactly as it always has —
     * existing one-shot batch callers (Task 2/3 tests) are unaffected.
     */
    stepped: z.boolean().optional()
  })
  .strict();
export type ChildRequest = z.infer<typeof childRequestSchema>;

/**
 * Task 4 addition: one per-iteration continuation signal, sent by the parent
 * only when the initiating `ChildRequest.stepped` was true. The child reads
 * exactly one of these before computing each iteration's mutation.
 */
export const childStepRequestSchema = z.object({ step: z.literal(true) }).strict();
export type ChildStepRequest = z.infer<typeof childStepRequestSchema>;

/** One completed, independently-verified mutation. */
export const childResultSchema = z
  .object({
    /** Nanoseconds, `process.hrtime.bigint()` diff over ONLY the timed window. */
    callerWallNs: z.number().nonnegative(),
    /** `process.resourceUsage().maxRSS`, normalized to bytes. */
    childMaxRssBytes: z.number().nonnegative(),
    published: z.literal(true),
    /** The real call sequence, recorded as each wrapped call actually ran. */
    lifecycle: z.array(z.string().min(1)).min(1),
    /**
     * Task 4 addition: this child process's own `process.pid`. Lets a
     * cold-mode driver prove each sample came from a genuinely fresh
     * process (distinct PIDs), and a warm-mode driver prove the opposite
     * (one PID reused across all its iterations).
     */
    childPid: z.number().int().positive()
  })
  .strict();
export type ChildResult = z.infer<typeof childResultSchema>;

/** Terminal line: the child's plan is complete and it is about to exit 0. */
export const childDoneSchema = z.object({ done: z.literal(true) }).strict();
export type ChildDone = z.infer<typeof childDoneSchema>;

export const childMessageSchema = z.union([childResultSchema, childDoneSchema]);
export type ChildMessage = z.infer<typeof childMessageSchema>;

/**
 * A persistent, closable source of newline-delimited lines off a stream.
 * Task 4 addition: unlike the old one-shot `readChildRequest`, this stays
 * open across multiple reads so a `stepped` warm child can read its initial
 * `ChildRequest` and then N subsequent `ChildStepRequest` lines off the
 * SAME underlying `readline.Interface` — reopening a second interface on
 * the same stream risks losing already-buffered bytes the first interface
 * read ahead but never emitted.
 */
export interface ChildLineSource {
  /** Resolves with the next line, or rejects if the stream ends before one arrives. */
  nextLine(): Promise<string>;
  /** Detaches the underlying `readline.Interface` (and pauses its input) so nothing keeps the process's event loop alive on its account. */
  close(): void;
}

export function openChildLineSource(stdin: NodeJS.ReadableStream = process.stdin): ChildLineSource {
  const reader = createInterface({ input: stdin });
  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let closed = false;

  reader.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  });
  reader.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!.reject(new Error("openChildLineSource: stdin closed before a line arrived"));
    }
  });

  return {
    nextLine(): Promise<string> {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (closed) return Promise.reject(new Error("openChildLineSource: stdin closed before a line arrived"));
      return new Promise((resolveLine, reject) => {
        waiters.push({ resolve: resolveLine, reject });
      });
    },
    close(): void {
      reader.close();
    }
  };
}

/** Read and parse one request line off `source`. */
export async function readChildRequest(source: ChildLineSource): Promise<ChildRequest> {
  const line = await source.nextLine();
  return childRequestSchema.parse(JSON.parse(line));
}

/** Read and parse one step-continuation line off `source` (only used in `stepped` warm mode). */
export async function readChildStepRequest(source: ChildLineSource): Promise<ChildStepRequest> {
  const line = await source.nextLine();
  return childStepRequestSchema.parse(JSON.parse(line));
}

/** Write one newline-delimited JSON message to stdout. */
export function writeChildMessage(
  message: ChildResult | ChildDone,
  stdout: NodeJS.WritableStream = process.stdout
): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

/** `process.resourceUsage().maxRSS` normalized to bytes for the current process. */
export function childMaxRssBytes(): number {
  // Empirically verified on this repo's Homebrew-node macOS/arm64 build
  // (node v26.3.0): `process.resourceUsage().maxRSS` reports KIBIBYTES, not
  // bytes, matching Linux getrusage semantics despite the Node docs' blanket
  // "expressed in bytes" claim (cross-checked against the documented-bytes
  // `process.memoryUsage().rss`, which tracks it at ~1024x). If a future
  // platform/Node build genuinely reports bytes, this will over-report by
  // 1024x — re-verify empirically before trusting a divergent reading.
  return process.resourceUsage().maxRSS * 1024;
}
