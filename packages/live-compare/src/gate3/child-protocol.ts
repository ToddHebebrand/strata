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
    iterations: z.number().int().positive()
  })
  .strict();
export type ChildRequest = z.infer<typeof childRequestSchema>;

/** One completed, independently-verified mutation. */
export const childResultSchema = z
  .object({
    /** Nanoseconds, `process.hrtime.bigint()` diff over ONLY the timed window. */
    callerWallNs: z.number().nonnegative(),
    /** `process.resourceUsage().maxRSS`, normalized to bytes. */
    childMaxRssBytes: z.number().nonnegative(),
    published: z.literal(true),
    /** The real call sequence, recorded as each wrapped call actually ran. */
    lifecycle: z.array(z.string().min(1)).min(1)
  })
  .strict();
export type ChildResult = z.infer<typeof childResultSchema>;

/** Terminal line: the child's plan is complete and it is about to exit 0. */
export const childDoneSchema = z.object({ done: z.literal(true) }).strict();
export type ChildDone = z.infer<typeof childDoneSchema>;

export const childMessageSchema = z.union([childResultSchema, childDoneSchema]);
export type ChildMessage = z.infer<typeof childMessageSchema>;

/** Read and parse the single request line off stdin. */
export async function readChildRequest(stdin: NodeJS.ReadableStream = process.stdin): Promise<ChildRequest> {
  const reader = createInterface({ input: stdin });
  const line = await new Promise<string>((resolveLine, reject) => {
    let resolved = false;
    reader.once("line", (value) => {
      resolved = true;
      reader.close();
      resolveLine(value);
    });
    reader.once("close", () => {
      if (!resolved) reject(new Error("readChildRequest: stdin closed before a request line arrived"));
    });
    stdin.once("error", reject);
  });
  return childRequestSchema.parse(JSON.parse(line));
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
