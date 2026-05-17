/**
 * Trapped control (graduation-only contamination alarm) for @strata/lab.
 *
 * NON-AUTHORITATIVE sandbox — see README.md.
 *
 * A deliberate T01-shaped trap: the per-scope timezone value is stated ONLY
 * in TRAP_PROMPT (prompt-only literals "UTC" and "local"), nowhere derivable
 * from the corpus.  scoreTrapped() requires those exact prompt-only literals,
 * so it is structurally unsatisfiable by an honest (code-derived) method —
 * exactly the verified 2026-05-17 finding, reproduced as the sandbox's
 * contamination alarm.
 *
 * Integrity invariants (a reviewer will grep for these):
 *  - "UTC" and "local" appear in TRAP_PROMPT by DESIGN (unlike HD_PROMPT).
 *  - An HD-correct render (callsites use ZONE symbol, not string literals)
 *    must yield scoreTrapped(...).pass === false AND
 *    scoreTrapped(...).requiresPromptLiteral === false.  If either is true
 *    the instrument is broken.
 *  - Callsite detection is consistent with honestDerivable.ts: same DECL
 *    exclusion, same CALL_RE pattern, same .map(formatTimestamp) exclusion
 *    (CALL_RE requires `formatTimestamp(` so `.map(formatTimestamp)` is
 *    excluded automatically).
 *  - DECL and CALL_RE are replicated here (not re-exported from
 *    honestDerivable.ts) because that module does not export them.  Both
 *    are identical to their counterparts there — single conceptual rule,
 *    two copies, documented here for future readers.
 *
 * Run ONLY at graduation.
 */

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The trapped prompt.  It NAMES the per-scope literal timezone value
 * ("UTC" for server, "local" for ui) by DESIGN — these values are absent
 * from the corpus and can only come from transcribing this prompt.
 *
 * This is the fundamental difference from HD_PROMPT (which names no literal).
 */
export const TRAP_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` after `ts`, " +
  'default `"UTC"`. Callsites under `src/server/` must pass `"UTC"`; ' +
  'callsites under `src/ui/` must pass `"local"`. All other callsites ' +
  "take the default.";

// ---------------------------------------------------------------------------
// Score interface
// ---------------------------------------------------------------------------

export interface TrapScore {
  pass: boolean;
  /**
   * True if any src/ui/-scoped callsite carries the prompt-only literal
   * "local" as its second argument.  A method that produces
   * requiresPromptLiteral=true has transcribed the prompt literal — the
   * only path toward pass=true (since "local" is absent from the corpus).
   */
  requiresPromptLiteral: boolean;
}

// ---------------------------------------------------------------------------
// Callsite helpers (replicated from honestDerivable.ts — identical rule)
// ---------------------------------------------------------------------------

/**
 * Matches a function/const/let/var declaration of formatTimestamp (not a
 * callsite).  Identical to the DECL constant in honestDerivable.ts and
 * corpus.test.ts — single conceptual source of truth.
 *
 * NOTE: replicated here because honestDerivable.ts does not export it.
 */
const DECL = /(?:export\s+)?(?:function|const|let|var)\s+formatTimestamp[\s(<]/;

/**
 * Matches a DIRECT formatTimestamp( call: requires `formatTimestamp(` with
 * at least one argument before `)`.  Does NOT match `.map(formatTimestamp)`
 * (no `(` immediately follows the name there — the `(` is the map call's
 * paren, not formatTimestamp's).
 *
 * Capture group 1: the second argument (the timezone), if present.
 *
 * First-arg matcher `[^,)]+` is deliberately first-arg-agnostic: it matches
 * any single non-comma, non-paren token — both `at` (real server form) and
 * `0` (real ui/lib form).  This is the key fix vs. the plan's placeholder
 * regex which would have hardcoded `0` and silently missed server callsites.
 *
 * NOTE: replicated from honestDerivable.ts; both must stay identical.
 */
const CALL_RE = /\bformatTimestamp\(\s*[^,)]+(?:,\s*([^)]+))?\)/g;

/** Map a corpus-relative posix path to its structural scope. */
function scopeOf(relPath: string): "server" | "ui" | "other" {
  if (relPath.startsWith("src/server/")) return "server";
  if (relPath.startsWith("src/ui/")) return "ui";
  return "other";
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Pure function of the rendered src text.  Embeds the prompt-only literals
 * "UTC" (server) and "local" (ui) as REQUIRED values — this is the trap.
 *
 * Rules:
 *  - For each file, iterate lines.  Only process lines that contain
 *    `formatTimestamp(` AND do NOT match DECL (excludes the declaration in
 *    format.ts by content, not by path — robust if callsites are added).
 *  - `.map(formatTimestamp)` is excluded because CALL_RE requires `(` to
 *    immediately follow the name.
 *  - For each matching line, run CALL_RE to extract the second arg.
 *  - pass = at least one src/server/ callsite whose second arg is exactly
 *    `"UTC"` AND at least one src/ui/ callsite whose second arg is exactly
 *    `"local"`.
 *  - requiresPromptLiteral = at least one src/ui/ callsite whose second arg
 *    is exactly `"local"`.
 *
 * HD-correct render uses ZONE (a symbol) as the second arg — neither literal
 * matches → pass=false, requiresPromptLiteral=false.  Alarm intact.
 */
export function scoreTrapped(rendered: Map<string, string>): TrapScore {
  let serverHasUTC = false;
  let uiHasLocal = false;

  for (const [rel, text] of rendered) {
    const scope = scopeOf(rel);
    // Only server and ui scopes carry the prompt-literal requirement.
    if (scope !== "server" && scope !== "ui") continue;

    for (const line of text.split("\n")) {
      if (!line.includes("formatTimestamp(")) continue;
      if (DECL.test(line)) continue;

      for (const m of line.matchAll(new RegExp(CALL_RE.source, "g"))) {
        const arg = (m[1] ?? "").trim();
        if (scope === "server" && arg === '"UTC"') serverHasUTC = true;
        if (scope === "ui" && arg === '"local"') uiHasLocal = true;
      }
    }
  }

  return {
    pass: serverHasUTC && uiHasLocal,
    requiresPromptLiteral: uiHasLocal
  };
}
