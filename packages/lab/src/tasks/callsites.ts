/**
 * Shared callsite-detection primitives for the lab measurement instrument.
 * honestDerivable.ts (HD scorer) and trappedControl.ts (contamination
 * alarm) MUST classify the same rendered text as the same callsites, or
 * the alarm can silently break. Keep that guarantee here, by construction,
 * not by documentation discipline across copies.
 */

/** Matches a formatTimestamp DECLARATION line (function/const/let/var) —
 *  NOT a callsite. Byte-identical to the regex previously triplicated. */
export const DECL =
  /(?:export\s+)?(?:function|const|let|var)\s+formatTimestamp[\s(<]/;

/**
 * Matches a direct `formatTimestamp(` call. Capture group 1 = the second
 * argument text if present. Does NOT match `.map(formatTimestamp)` (no
 * `(` immediately after the name). KNOWN LIMIT: the first-arg matcher
 * `[^,)]+` stops at a nested `(`, so a first argument that is itself a
 * call (e.g. `formatTimestamp(getTime(), ZONE)`) mis-parses the second
 * arg — not present in the corpus; the HD/trap prompts keep the first arg
 * unchanged; documented and accepted.
 */
export const CALL_RE = /\bformatTimestamp\(\s*[^,)]+(?:,\s*([^)]+))?\)/g;

/** Map a corpus-relative POSIX path key to its structural scope.
 *  Caller MUST pass posix-relative keys with no leading "./". */
export function scopeOf(relPath: string): "server" | "ui" | "other" {
  if (relPath.startsWith("src/server/")) return "server";
  if (relPath.startsWith("src/ui/")) return "ui";
  return "other";
}
