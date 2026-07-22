// Gate 3 (unkeyed noninferiority), Task 8: the PRE-REGISTERED sizing/timeout
// constants, fixed from the Task-8 pilot BEFORE the dispositive runs and
// never tuned afterward to force a verdict (plan Step 1: "The pilot is NOT
// the gate; do not tune constants to force a verdict").
//
// Pilot observations (foreground, examples/medium, this machine — Homebrew
// node v26 / macOS arm64; see task-8-report.md for the raw run logs):
//   - cold, N=12, seed 20260722200: kernel p95 wall 2169.5ms, sqlite p95
//     476.6ms -> point ratio 4.552, bootstrap ucb 4.605 / lcb 4.499.
//   - warm, N=12, seed 20260722201: kernel p95 2110.5ms, sqlite p95 441.3ms
//     -> point ratio 4.782, ucb 6.253 / lcb 4.782.
//   - per-sample harness-process peak RSS on medium: kernel ~163 MB,
//     sqlite ~369 MB (warm); on the 1-copy baseline corpus: kernel ~163 MB,
//     sqlite ~305 MB.
//   - per-pair wall: cold ≈ 4.5s (kernel ~2-4s + sqlite ~0.5s),
//     warm ≈ 2.5s after the first-iteration warmup.
//
// These constants are consumed by the medium acceptance suite
// (`tests/gate3Noninferiority.test.ts`) and the operator big run
// (`src/gate3/run-big.ts`).

// ---------------------------------------------------------------------------
// Sample counts.
// ---------------------------------------------------------------------------

/**
 * Paired samples per mode on `examples/medium`. 12 pairs keeps the acceptance
 * suite fast (cold ≈ 12 × 4.5s ≈ 54s + warm ≈ 12 × 2.5s ≈ 30s ≈ 90s of timed
 * work, well under the CI-viable ~25-30 min ceiling) while giving the paired
 * bootstrap enough pairs (12) for a non-degenerate confidence interval. The
 * pilot's cold/warm CIs at N=12 were already tight (cold lcb 4.499, warm lcb
 * 4.782), so N=12 is not undersized for the medium signal.
 */
export const N_MEDIUM = 12;

/**
 * Paired samples per mode on the ~1012-module big1k corpus (operator run
 * only). Deliberately SMALLER than `N_MEDIUM`: each big1k sample validates
 * 1012 modules through `tsc` — the kernel arm spawns a bridge worker that
 * renders + type-checks the whole corpus, the sqlite arm runs two in-process
 * 1012-module `tsc` passes — so a single pair costs on the order of minutes,
 * not seconds. 8 pairs bounds each big1k mode to a low-tens-of-minutes
 * operator run while still yielding a usable bootstrap. NOT exercised in this
 * task (Task 9 operator run); pre-registered here so the operator run cannot
 * re-pick it to chase a verdict.
 */
export const N_BIG1K = 8;

/**
 * Paired samples per mode on the 1-copy baseline corpus, used only to source
 * the memory predicate's baseline peak-RSS (cold single mutations). Small: the
 * baseline exists to anchor `(big1k - baseline)/(medium - baseline)`, not to
 * produce a distribution.
 */
export const N_BASELINE = 3;

// ---------------------------------------------------------------------------
// Warm horizon + memory growth factor.
// ---------------------------------------------------------------------------

/**
 * Pre-registered ceiling on any warm run's `n` (both corpora). 32 leaves ample
 * headroom over `N_MEDIUM` (12) and `N_BIG1K` (8) while still being a finite,
 * auditable cap that `runWarm` refuses to exceed.
 */
export const WARM_HORIZON = 32;

/**
 * Memory growth factor for `memoryVerdict`: the big1k-vs-medium baseline-
 * adjusted RSS growth must stay within this multiple. Plan candidate value 4
 * (plan §"Memory predicate"; matches the Task-5 fixture's `GROWTH_FACTOR`).
 */
export const GROWTH_FACTOR = 4;

// ---------------------------------------------------------------------------
// Absolute big1k RSS caps (PROVISIONAL — see rationale).
// ---------------------------------------------------------------------------
//
// The plan requires the absolute caps be "set from the pilot, stated in the
// artifact". We do NOT have big1k RSS until the operator run, so these are
// derived from the pilot's medium harness-process peak RSS times a stated,
// deliberately conservative multiplier (8×): big1k has 46× the modules, but
// each harness process's RSS is dominated by a fixed Node/tsc (sqlite arm) or
// Node client (kernel arm) baseline plus a per-module increment, so an 8×
// ceiling over the medium peak comfortably accommodates 46× growth of the
// incremental component while still failing on a genuine unbounded leak. These
// are a coarse guard, not the primary predicate — the growth-adjusted ratio
// (`GROWTH_FACTOR`) is the sensitive test. They MUST be tightened once the
// operator's first big1k run yields real peak-RSS numbers (log a decision).
const MEDIUM_KERNEL_PEAK_RSS_BYTES = 164 * 1024 * 1024; // ~163 MB pilot observation, rounded up.
const MEDIUM_SQLITE_PEAK_RSS_BYTES = 369 * 1024 * 1024; // ~369 MB pilot observation.
const RSS_CAP_MULTIPLIER = 8;

/** Provisional absolute big1k RSS cap for the kernel arm (pilot medium peak × 8). */
export const KERNEL_1K_RSS_CAP = MEDIUM_KERNEL_PEAK_RSS_BYTES * RSS_CAP_MULTIPLIER;
/** Provisional absolute big1k RSS cap for the sqlite arm (pilot medium peak × 8). */
export const SQLITE_1K_RSS_CAP = MEDIUM_SQLITE_PEAK_RSS_BYTES * RSS_CAP_MULTIPLIER;

// ---------------------------------------------------------------------------
// Timeouts (generous for the big1k operator run's minutes-long samples).
// ---------------------------------------------------------------------------

/** Per-sample cold kernel-arm timeout. Medium cold kernel is ~2-4s; big1k adds a 1012-module worker validation — 5 min headroom. */
export const COLD_KERNEL_TIMEOUT_MS = 300_000;
/** Per-sample cold sqlite-arm timeout. Medium cold sqlite is ~0.5s; big1k adds two 1012-module in-process tsc passes — 3 min headroom. */
export const COLD_SQLITE_TIMEOUT_MS = 180_000;
/** Per-step warm timeout for both persistent children. Big1k steps are the costly ones — 5 min headroom. */
export const WARM_STEP_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Fixed schedule seeds (pre-registered; the realized AB/BA order is fully
// determined by these).
// ---------------------------------------------------------------------------

/** Seed for the medium cold schedule (acceptance suite + big run). */
export const GATE3_MEDIUM_COLD_SEED = 20260722200;
/** Seed for the medium warm schedule. */
export const GATE3_MEDIUM_WARM_SEED = 20260722201;
/** Seed for the medium baseline-RSS cold schedule. */
export const GATE3_MEDIUM_BASELINE_SEED = 20260722202;
/** Seed for the big1k cold schedule (operator run). */
export const GATE3_BIG1K_COLD_SEED = 20260722210;
/** Seed for the big1k warm schedule (operator run). */
export const GATE3_BIG1K_WARM_SEED = 20260722211;
/** Seed threaded into the bootstrap + provenance record for a run. */
export const GATE3_BOOTSTRAP_SEED = 20260722299;
