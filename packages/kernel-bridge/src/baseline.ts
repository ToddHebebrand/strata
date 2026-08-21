import path from "node:path";
import {
  begin,
  rollback,
  type Db,
  type TxHandle
} from "@strata-code/store";
import { renderPendingModules, runCorpusAcceptanceBounded } from "@strata-code/verify";
import { errorPayload, normalizeDiagnostics, validateProfile } from "./candidate";
import { StageRecorder } from "./metrics";
import {
  type BridgeDiagnostic,
  type BridgeErrorPayload,
  type ValidateBaselineRequest,
  type ValidationProfile
} from "./protocol";
import { hydrateSnapshot } from "./snapshot";

/**
 * `tscOnly` per-step budgets when an operator manifest did not set them.
 * Mirrors the daemon's `manifest::DEFAULT_TSC_TIMEOUT_MS` /
 * `DEFAULT_VITEST_TIMEOUT_MS`; a `tscOnly` profile carries the keys only when
 * a manifest supplied them (the pre-B-2 five-key wire has neither).
 */
const DEFAULT_TSC_TIMEOUT_MS = 60_000;
const DEFAULT_VITEST_TIMEOUT_MS = 90_000;

/**
 * Upper bound on the diagnostic LINES a red baseline reports. The daemon
 * prints only the first few before refusing to serve; this bound exists so a
 * pathologically noisy tsc/vitest run cannot inflate one startup frame.
 */
const MAX_BASELINE_DIAGNOSTIC_LINES = 64;

/** The seed-green verdict: did the corpus AS PUBLISHED pass its own gate? */
export interface BaselineVerdict {
  green: boolean;
  diagnostics: BridgeDiagnostic[];
}

export type ValidateBaselineResult = BaselineVerdict | BridgeErrorPayload;

/**
 * Judges the corpus a snapshot describes against the session's validation
 * profile, WITHOUT applying any mutation (B-2 Task 7 seed-green gate).
 *
 * The pipeline is deliberately the candidate path's minus its mutate stage:
 * hydrate the snapshot into a scratch database, render every module through
 * the canonical renderer (the same bytes a candidate would be judged over),
 * then hand the rendered tree to Task 6's process-group-bounded acceptance
 * runner. A `tscOnly` profile runs tsc alone (no fixtures); a `behavioral`
 * profile additionally runs the manifest's scoped fixtures.
 *
 * A finished judgement — green or red — is a `BaselineVerdict`. A failure to
 * FINISH (bad profile, unhydratable snapshot, an exhausted per-step budget) is
 * a `BridgeErrorPayload` carrying Task 6's `tscTimedOut`/`vitestTimedOut`
 * codes, because "we could not judge the corpus" is operational, not a verdict.
 */
export async function validateBaseline(
  request: ValidateBaselineRequest,
  recorder?: StageRecorder
): Promise<ValidateBaselineResult> {
  const profileError = validateProfile(request.validationProfile, request.snapshot);
  if (profileError !== undefined) return profileError;

  let db: Db;
  try {
    db = recorder
      ? recorder.time("hydrate", () => hydrateSnapshot(request.snapshot))
      : hydrateSnapshot(request.snapshot);
  } catch (error) {
    return errorPayload("hydrate", "invalidSnapshot", error, []);
  }

  try {
    return await judgeHydratedBaseline(db, request.validationProfile, recorder);
  } catch (error) {
    return errorPayload("validate", "baselineFailed", error, []);
  } finally {
    db.close();
  }
}

async function judgeHydratedBaseline(
  db: Db,
  profile: ValidationProfile,
  recorder?: StageRecorder
): Promise<ValidateBaselineResult> {
  // A transaction handle is only the renderer's overlay carrier here; it stays
  // EMPTY (no intent is applied) and is rolled back unconditionally, so the
  // rendered text is exactly the published corpus.
  let tx: TxHandle | undefined;
  try {
    tx = begin(db, "strata:baseline", "seed-green startup gate");
    const { renderedFiles } = renderPendingModules(db, tx);
    const renderedSrc = new Map<string, string>();
    for (const [rawKey, text] of renderedFiles) {
      const relative = path
        .relative(profile.sourceRoot, path.resolve(profile.corpusRoot, rawKey))
        .replaceAll("\\", "/");
      renderedSrc.set(relative, text);
    }

    const fixtures =
      profile.mode === "behavioral" ? [...profile.behavioralFixtures] : [];
    const run = async () =>
      runCorpusAcceptanceBounded(renderedSrc, profile.corpusRoot, fixtures, {
        strictSrcOnlyTscScope: profile.strictSrcOnlyTscScope,
        tscTimeoutMs: profile.tscTimeoutMs ?? DEFAULT_TSC_TIMEOUT_MS,
        vitestTimeoutMs: profile.vitestTimeoutMs ?? DEFAULT_VITEST_TIMEOUT_MS
      });
    const result = recorder ? await recorder.timeAsync("validate", run) : await run();

    if (result.tscTimedOut || result.vitestTimedOut) {
      const step = result.tscTimedOut ? "tsc" : "vitest";
      return errorPayload(
        "validate",
        result.tscTimedOut ? "tscTimedOut" : "vitestTimedOut",
        new Error(
          `baseline ${step} validation exceeded its budget and its process ` +
            `group was killed`
        ),
        []
      );
    }
    if (result.tscClean && result.vitestPassed) {
      return { green: true, diagnostics: [] };
    }
    return { green: false, diagnostics: outputLines(result.failureOutput) };
  } finally {
    rollbackIfOpen(db, tx);
  }
}

/**
 * Turns the acceptance runner's combined tsc+vitest text into ordered
 * diagnostic lines. Line-per-diagnostic (rather than one giant blob) is what
 * lets the daemon print a handful of MEANINGFUL leading lines when it refuses
 * to serve, instead of one message truncated mid-banner.
 */
function outputLines(failureOutput: string): BridgeDiagnostic[] {
  const lines = failureOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_BASELINE_DIAGNOSTIC_LINES)
    .map((line) => ({
      nodeId: null,
      modulePath: null,
      message: line,
      code: 1
    }));
  return normalizeDiagnostics(
    lines.length > 0
      ? lines
      : [
          {
            nodeId: null,
            modulePath: null,
            message: "baseline validation failed without captured output",
            code: 1
          }
        ]
  );
}

function rollbackIfOpen(db: Db, tx: TxHandle | undefined): void {
  if (tx === undefined) return;
  try {
    rollback(db, tx);
  } catch {
    // The scratch database is discarded either way; a transaction that is
    // already closed has nothing left to unwind.
  }
}
