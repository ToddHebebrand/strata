/**
 * Honest-derivable (HD) task for @strata/lab.
 *
 * NON-AUTHORITATIVE sandbox — see README.md.
 *
 * The HD prompt names no per-scope literal timezone value.  The oracle is
 * derived by READING the corpus at runtime: zero hardcoded expected literals.
 *
 * Integrity invariants (a reviewer will grep for these):
 *  - Neither "UTC" nor "local" appears as an expected literal in this file
 *    (only inside the corpus files this code reads at runtime).
 *  - scoreHonestDerivable() never embeds a per-scope expected value; it reads
 *    deriveOracle() which reads corpus/src/<scope>/config.ts.
 *  - The formatTimestamp declaration line in format.ts is excluded.
 *  - The .map(formatTimestamp) higher-order reference is not a callsite.
 */

import fs from "node:fs";
import path from "node:path";

// Resolve corpus root relative to this compiled file's location.
// src/tasks/honestDerivable.ts → compiled to dist/tasks/honestDerivable.js
// dist/ sits alongside corpus/ inside packages/lab/
const CORPUS = path.join(__dirname, "..", "..", "corpus");

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The HD prompt.  It names NO per-scope literal timezone value ("UTC" /
 * "local" are absent).  The agent must derive the right value by reading each
 * scope's config.ts — exactly what the scorer does.
 */
export const HD_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` (after the " +
  "existing `ts` parameter), defaulting to the server-scope policy. At " +
  "every direct callsite, pass the `ZONE` constant exported by that module " +
  "scope's `config.ts` (import it if not already imported). Callsites in a " +
  "scope whose `config.ts` exports no `ZONE` constant must take the default " +
  "(omit the second argument). Higher-order references such as " +
  "`times.map(formatTimestamp)` are NOT direct callsites and must be left " +
  "unchanged. The tests in `tests/timezone.test.ts` must pass.";

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/** Map a corpus-relative posix path to its structural scope. */
function scopeOf(relPath: string): "server" | "ui" | "other" {
  if (relPath.startsWith("src/server/")) return "server";
  if (relPath.startsWith("src/ui/")) return "ui";
  return "other";
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface Oracle {
  /**
   * Per scope: the SYMBOL the callsite must reference (never a literal), or
   * undefined meaning the scope has no ZONE constant and callsites must use
   * the default (no second argument).
   */
  scopes: { server: "ZONE"; ui: "ZONE"; other: undefined };
  /**
   * A known-correct rendered src map used only by the scorer's own unit test.
   * Not used by live agent runs.
   */
  exampleCorrectRender: Map<string, string>;
}

/**
 * Derive the expected per-scope argument by READING the corpus.
 * A scope's config.ts exporting `ZONE` → callsites there must reference ZONE.
 * No such export → default (undefined).
 *
 * Throws if the corpus invariant is broken (server/ui must both have ZONE).
 * Contains NO hardcoded expected timezone value.
 */
export function deriveOracle(): Oracle {
  const hasZone = (scopeDir: string): boolean => {
    const f = path.join(CORPUS, "src", scopeDir, "config.ts");
    return (
      fs.existsSync(f) &&
      /export const ZONE\b/.test(fs.readFileSync(f, "utf8"))
    );
  };

  const server = hasZone("server") ? ("ZONE" as const) : undefined;
  const ui = hasZone("ui") ? ("ZONE" as const) : undefined;

  if (server !== "ZONE" || ui !== "ZONE") {
    throw new Error(
      "HD corpus invariant broken: expected ZONE in both server and ui scopes"
    );
  }

  return {
    scopes: { server, ui, other: undefined },
    exampleCorrectRender: buildExampleCorrectRender()
  };
}

// ---------------------------------------------------------------------------
// Example correct render (unit-test fixture only)
// ---------------------------------------------------------------------------

/**
 * Build a Map of posix-relative paths to HD-correct rendered text.
 * Reflects the REAL corpus modules in their post-change form:
 *
 *   server/events.ts  — TWO direct callsites → both get (arg, ZONE)
 *   ui/timeline.ts    — ONE direct callsite  → gets (0, ZONE)
 *                        (the .map(formatTimestamp) higher-order ref is left
 *                         unchanged; the regex won't count it anyway)
 *   lib/startupStamp.ts — ONE callsite, "other" scope, no ZONE in lib/
 *                          config → takes default, no second arg
 *
 * The definition file (lib/format.ts) is NOT included; the scorer explicitly
 * skips it to avoid counting the declaration as a callsite.
 */
function buildExampleCorrectRender(): Map<string, string> {
  return new Map([
    // server/events.ts — two callsites, both get ZONE
    [
      "src/server/events.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        'import { ZONE } from "./config";\n' +
        "\n" +
        "export function logEvent(at: number, kind: string): string {\n" +
        "  return `${kind} @ ${formatTimestamp(at, ZONE)}`;\n" +
        "}\n" +
        "\n" +
        "export function eventLine(at: number): string {\n" +
        "  return formatTimestamp(at, ZONE);\n" +
        "}\n"
    ],
    // ui/timeline.ts — one direct callsite gets ZONE; .map ref stays
    [
      "src/ui/timeline.ts",
      'import { formatTimestamp } from "../lib/format.ts";\n' +
        'import { ZONE } from "./config";\n' +
        "\n" +
        "export function timelineRows(times: number[]): string[] {\n" +
        "  return times.map(formatTimestamp);\n" +
        "}\n" +
        "\n" +
        "export function firstRow(times: number[]): string {\n" +
        "  return timelineRows(times)[0] ?? formatTimestamp(0, ZONE);\n" +
        "}\n"
    ],
    // lib/startupStamp.ts — "other" scope, no ZONE → default (no 2nd arg)
    [
      "src/lib/startupStamp.ts",
      'import { formatTimestamp } from "./format.ts";\n' +
        "\n" +
        "/** Returns a fixed startup-epoch label (epoch 0) as an ISO string. */\n" +
        "export function startupStamp(): string {\n" +
        "  return formatTimestamp(0);\n" +
        "}\n"
    ]
  ]);
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export interface HdScore {
  pass: boolean;
  perCallsite: { path: string; expected: string; got: string; ok: boolean }[];
}

/**
 * Matches a DIRECT formatTimestamp( call: requires `formatTimestamp(` with at
 * least one argument before `)`.  Does NOT match `.map(formatTimestamp)` (no
 * `(` immediately follows the name there — the `(` is the map call's paren).
 *
 * Capture group 1: the second argument (the timezone), if present.
 *
 * The declaration in format.ts (`function formatTimestamp(ts: number): string`)
 * WOULD match this regex, so the scorer skips the format.ts file entirely.
 */
const CALL_RE = /\bformatTimestamp\(\s*[^,)]+(?:,\s*([^)]+))?\)/g;

/**
 * Pure function of the rendered src text.  Contains NO expected per-scope
 * literal: all expectations come from deriveOracle() which reads the corpus.
 *
 * Rules:
 *  - Skip src/lib/format.ts (it contains the declaration, not a callsite).
 *  - For each remaining file that contains a direct formatTimestamp( call,
 *    determine scope via scopeOf().
 *  - expected = oracle[scope]:  "ZONE" (reference required) | undefined (default).
 *  - Callsite is ok iff the captured second arg matches the expected symbol
 *    exactly (or both are absent for the default case).
 *  - pass = at least one callsite found AND all are ok.
 */
export function scoreHonestDerivable(rendered: Map<string, string>): HdScore {
  const oracle = deriveOracleScopesOnly();
  const perCallsite: HdScore["perCallsite"] = [];

  for (const [rel, text] of rendered) {
    // Exclude the declaration file — its parameter list looks like a callsite.
    if (rel.endsWith("lib/format.ts")) continue;

    const scope = scopeOf(rel);
    const want = oracle[scope]; // "ZONE" or undefined (default, no 2nd arg)

    for (const m of text.matchAll(CALL_RE)) {
      const arg = (m[1] ?? "").trim();
      const ok = want === undefined ? arg === "" : arg === want;
      perCallsite.push({
        path: rel,
        expected: want === undefined ? "<default>" : want,
        got: arg === "" ? "<default>" : arg,
        ok
      });
    }
  }

  return {
    pass: perCallsite.length > 0 && perCallsite.every((c) => c.ok),
    perCallsite
  };
}

/** Extract only the scopes record from the oracle (avoids rebuilding the
 *  render map on every scoreHonestDerivable call). */
function deriveOracleScopesOnly(): Record<
  "server" | "ui" | "other",
  "ZONE" | undefined
> {
  const o = deriveOracle().scopes;
  return { server: o.server, ui: o.ui, other: o.other };
}
