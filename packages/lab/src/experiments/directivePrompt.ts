/**
 * A more DIRECTIVE honest-derivable prompt.
 *
 * Integrity: this still contains NO per-scope literal value ("UTC"/"local"
 * appear nowhere) — the per-callsite value remains code-derived from each
 * scope's config.ts. What it adds over HD_PROMPT is (1) the entry-point
 * file (analogous to T03's prompt naming `User` in `src/types/user.ts` —
 * naming the symbol/location is honest; naming the per-site answer is the
 * trap) and (2) explicit explore-then-act discipline, to test whether the
 * observed pure-exploration thrash (both control and variant hit their
 * budget in read-only calls, never reaching the act phase) is closable by
 * prompt directiveness — a lever the original research flagged as
 * "likely system-prompt-tunable" for the T05-class thrash but never
 * isolated and tested.
 */
export const HD_DIRECTIVE_PROMPT =
  "`formatTimestamp` is defined in `src/lib/format.ts`. Add a " +
  "`timezone: string` parameter after the existing `ts` parameter, " +
  "defaulting to the server scope's policy. Update every direct callsite " +
  "to pass the `ZONE` constant exported by that callsite's own " +
  "module-scope `config.ts` (import it if not already imported); a " +
  "callsite in a scope whose `config.ts` exports no `ZONE` takes the " +
  "default (omit the second argument). `times.map(formatTimestamp)` and " +
  "other higher-order references are NOT direct callsites — leave them " +
  "unchanged. Work efficiently: locate the declaration and its references " +
  "with a few queries, then make the whole change inside ONE transaction. " +
  "Do not exhaustively read unrelated nodes. The tests in " +
  "`tests/timezone.test.ts` must pass.";
