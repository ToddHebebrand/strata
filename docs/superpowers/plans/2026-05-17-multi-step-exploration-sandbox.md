# Multi-step Exploration Sandbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@strata/lab` — a non-authoritative, cents-per-run sandbox to iterate on multi-step refactor methods against an honest code-derivable task, isolated from the published artifact, with a one-way graduation path back into the rigid keyed framework.

**Architecture:** A new pnpm workspace package depends on canonical `@strata/{store,agent,render,verify}` and drives the *real* agent loop through one additive, default-preserving seam in `@strata/agent` (landed first, separately reviewed, with its own `decisions.md` entry). The sandbox supplies its own derived corpus copy, an honest-derivable (HD) task with a zero-literal oracle scorer, a graduation-only trapped control, an experiment registry, and a thin cheap N=1 live runner. Canonical packages stay byte-identical after the seam lands.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, `tsc -b` project references, `@anthropic-ai/claude-agent-sdk` (already a dep), the existing in-process Strata MCP tool server.

---

## Spec

Source spec: `docs/superpowers/specs/2026-05-17-multi-step-exploration-sandbox-design.md`. Read it before starting.

## File Structure

**Phase 1 — the seam (only sanctioned canonical touch):**
- Modify: `packages/agent/src/session.ts` — lift `acceptance` computation to callers; widen `runAgentForPrompt` generic bound; add optional `toolServerFactory`/`canUseTool`; export `runAgentLab`.
- Modify: `packages/agent/src/index.ts` — export `runAgentLab`, `RunAgentLabParams`, `AgentLabResult`, `StrataSessionContext`.
- Test: `packages/agent/test/labSeam.test.ts` — new key-free behavior tests for the seam.
- Doc: append a `decisions.md` newest-first infra entry.

**Phase 2 — lab package scaffold + isolation fences:**
- Create: `packages/lab/package.json`, `packages/lab/tsconfig.json`, `packages/lab/vitest.config.ts`, `packages/lab/README.md`, `packages/lab/LAB-NOTES.md`, `packages/lab/.gitignore`.
- Modify: `packages/bench/tsconfig.json` is NOT touched; root nothing touched.

**Phase 3 — measurement instrument:**
- Create: `packages/lab/corpus/**` (derived copy of `examples/medium` + 3 named additive edits).
- Create: `packages/lab/src/tasks/honestDerivable.ts` (prompt + zero-literal oracle scorer).
- Create: `packages/lab/src/tasks/trappedControl.ts` (prompt-only-literal clone + its scorer).
- Test: `packages/lab/test/honestDerivable.test.ts`, `packages/lab/test/trappedControl.test.ts`.

**Phase 4 — experiment interface + registry + runner:**
- Create: `packages/lab/src/experiment.ts` (the `LabExperiment` type + `runExperiment`).
- Create: `packages/lab/src/registry.ts`.
- Create: `packages/lab/src/run.ts` (`lab run <id>` CLI).
- Create: `packages/lab/src/seam.ts` (thin re-export of the canonical injection point).
- Test: `packages/lab/test/experiment.test.ts`.

**Phase 5 — first experiment (per-scope `add_parameter`) + mechanics test:**
- Create: `packages/lab/src/experiments/perScopeAddParameter.ts`.
- Test: `packages/lab/test/perScopeAddParameter.test.ts` (deterministic, model-free).

---

## Phase 1 — The seam (sanctioned canonical touch, landed and frozen first)

> This is the ONLY canonical-package change in the whole effort. Its gate: every pre-existing canonical test unchanged and green; default behavior byte-identical; no scoring/replay path altered. It gets its own `decisions.md` entry.

### Task 1: Lift `acceptance` computation to callers (behavior-preserving refactor)

**Files:**
- Modify: `packages/agent/src/session.ts`
- Test: `packages/agent/test/labSeam.test.ts`

- [ ] **Step 1: Read the current code**

Read `packages/agent/src/session.ts` lines 249–300 and 408–477. Confirm `runAgentForPrompt` currently computes `acceptance` internally at lines ~280–287 from `runParams.replayTranscript` and `behavioralFixturesForTask(params.taskId)`, and that `runAgentT03`/`runAgentTask` call it with `taskId`.

- [ ] **Step 2: Write the failing test**

Create `packages/agent/test/labSeam.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runAgentT03 } from "../src/index";
import path from "node:path";

// Behavior-preservation guard: T03 replay through the refactored
// runAgentForPrompt is byte-identical to before (uses the committed
// real transcript fixture the canonical suite already relies on).
describe("seam: acceptance lifted to callers preserves T03 replay", () => {
  it("T03 replay still scores all criteria true", async () => {
    const fixture = path.join(
      __dirname,
      "fixtures",
      "t03-replay.jsonl"
    );
    const { loadTranscriptFixture } = await import("../src/index");
    const result = await runAgentT03({
      corpusRoot: path.join(__dirname, "..", "..", "..", "examples", "medium"),
      model: "replay",
      maxTurns: 1,
      wallTimeMs: 60000,
      replayTranscript: loadTranscriptFixture(fixture)
    });
    expect(result.criteria.commitReturnedOk).toBe(true);
    expect(result.criteria.operationRowAppended).toBe(true);
  });
});
```

If the existing canonical suite already has an equivalent T03 replay test, depend on that instead of duplicating the fixture path — locate it with `grep -rn "loadTranscriptFixture\|t03-replay" packages/agent/test` and reuse its corpusRoot/fixture resolution verbatim. The point of this step is a red test only if the refactor breaks T03 replay.

- [ ] **Step 3: Run it to confirm the baseline is green BEFORE refactor**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test -- labSeam`
Expected: PASS (this asserts the pre-refactor behavior so any regression in Step 4 turns it red).

- [ ] **Step 4: Refactor — move `acceptance` to callers**

In `packages/agent/src/session.ts`:

(a) Change the `runAgentForPrompt` params type to take a pre-resolved `acceptance` and a `taskLabel` string instead of deriving them:

```typescript
async function runAgentForPrompt<
  C extends {
    commitReturnedOk: boolean;
    validateAfterCommitClean: boolean;
    operationRowAppended: boolean;
  }
>(params: {
  runParams: RunAgentT03Params;
  taskLabel: string;
  acceptance: AcceptanceContext | undefined;
  actor: string;
  prompt: string;
  emptyCriteria: () => C;
  scoreFromCommitted: ScoreFromCommitted<C>;
}): Promise<{
  criteria: C;
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  rendered?: Map<string, string>;
}> {
```

(b) Replace the internal `acceptance` block (the `const ctx: StrataSessionContext = { db, actor: params.actor, acceptance: runParams.replayTranscript ? undefined : { ... } }`) with:

```typescript
    const ctx: StrataSessionContext = {
      db,
      actor: params.actor,
      acceptance: params.acceptance
    };
```

(c) In the `log.append({ type: "session_start", ... })` call replace `task: params.taskId` with `task: params.taskLabel`.

(d) In `runAgentT03`, compute acceptance exactly as the old internal code did and pass it:

```typescript
export async function runAgentT03(
  params: RunAgentT03Params
): Promise<AgentT03Result> {
  return runAgentForPrompt({
    runParams: params,
    taskLabel: "T03",
    acceptance: params.replayTranscript
      ? undefined
      : {
          corpusRoot: params.corpusRoot,
          srcRoot: path.join(params.corpusRoot, "src"),
          behavioralFixtures: behavioralFixturesForTask("T03")
        },
    actor: "agent-t03",
    prompt: T03_PROMPT,
    emptyCriteria: emptyT03Criteria,
    scoreFromCommitted: (db, batch, srcRoot, input) =>
      evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: input.commitReturnedOk,
        validateAfterCommitClean: input.validateAfterCommitClean,
        renameTxId: input.txId
      })
  });
}
```

(e) In `runAgentTask`'s `runAgentForPrompt` call, replace `taskId,` with `taskLabel: taskId,` and add the same `acceptance:` expression using `behavioralFixturesForTask(taskId)`:

```typescript
    runParams: params,
    taskLabel: taskId,
    acceptance: params.replayTranscript
      ? undefined
      : {
          corpusRoot: params.corpusRoot,
          srcRoot: path.join(params.corpusRoot, "src"),
          behavioralFixtures: behavioralFixturesForTask(taskId)
        },
    actor,
```

- [ ] **Step 5: Run the full canonical agent suite**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS, with the **same passing/skipped counts as before the change** (record the pre-change count from `git stash && pnpm --filter @strata/agent test` if unsure). Any count change ⇒ the refactor was not behavior-preserving; fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/session.ts packages/agent/test/labSeam.test.ts
git commit -m "refactor(agent): lift acceptance computation to callers (seam prep, behavior-identical)"
```

### Task 2: Add the optional injection points + `runAgentLab`

**Files:**
- Modify: `packages/agent/src/session.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/labSeam.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent/test/labSeam.test.ts`:

```typescript
import { runAgentLab } from "../src/index";

describe("seam: runAgentLab drives the real loop with overrides", () => {
  it("is exported and accepts a tool-server factory + generic scorer", async () => {
    expect(typeof runAgentLab).toBe("function");
    // Replay path: no model, deterministic. A no-op transcript yields
    // empty criteria via the caller-supplied emptyCriteria/score.
    const result = await runAgentLab({
      corpusRoot: require("node:path").join(
        __dirname, "..", "..", "..", "examples", "medium"
      ),
      model: "replay",
      maxTurns: 1,
      wallTimeMs: 60000,
      actor: "lab-test",
      prompt: "noop",
      replayTranscript: [],
      acceptance: undefined,
      emptyCriteria: () => ({
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        operationRowAppended: false,
        labOk: false
      }),
      score: () => ({
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        operationRowAppended: false,
        labOk: false
      })
    });
    expect(result.criteria.labOk).toBe(false);
    expect(result.terminalReason).toBe("replay_complete");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @strata/agent test -- labSeam`
Expected: FAIL — `runAgentLab` is not exported.

- [ ] **Step 3: Add optional injection fields to `RunAgentT03Params`**

In `packages/agent/src/session.ts`, extend the interface (keep existing fields):

```typescript
export interface RunAgentT03Params {
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  replayTranscript?: ReplayStep[];
  logPath?: string;
  /**
   * LAB-ONLY, additive. Absent ⇒ byte-identical canonical behavior.
   * Replace the in-process Strata tool server with a variant (same tool
   * NAMES only — net-new names would trip the hermetic guard and are out
   * of seam scope).
   */
  toolServerFactory?: (
    ctx: StrataSessionContext
  ) => ReturnType<typeof createStrataToolServer>;
  /** LAB-ONLY, additive. SDK loop-level gate passthrough. */
  canUseTool?: Options["canUseTool"];
}
```

Ensure `StrataSessionContext` and `Options` are imported at the top of `session.ts` (StrataSessionContext from `./tools`, `Options` from `@anthropic-ai/claude-agent-sdk` — both are already referenced in the file; add to the existing import lists if not already present).

- [ ] **Step 4: Use the injection points in `runLiveSession`**

In `runLiveSession`, replace `const server = createStrataToolServer(ctx);` with:

```typescript
  const server = (deps.params.toolServerFactory ?? createStrataToolServer)(ctx);
```

In the `const options: Options = { ... }` object, add after `maxTurns: params.maxTurns,`:

```typescript
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
```

(Spread-when-present keeps the options object byte-identical when the lab fields are absent.)

- [ ] **Step 5: Add `runAgentLab` + its types**

Add to `packages/agent/src/session.ts`:

```typescript
export interface RunAgentLabParams extends RunAgentT03Params {
  actor: string;
  prompt: string;
  acceptance: AcceptanceContext | undefined;
  emptyCriteria: () => LabCriteria;
  score: ScoreFromCommitted<LabCriteria>;
}

export interface LabCriteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  operationRowAppended: boolean;
  [extra: string]: boolean;
}

export interface AgentLabResult {
  criteria: LabCriteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  transcript: ReplayStep[];
  rendered?: Map<string, string>;
}

export async function runAgentLab(
  params: RunAgentLabParams
): Promise<AgentLabResult> {
  const { actor, prompt, acceptance, emptyCriteria, score, ...runParams } =
    params;
  const out = await runAgentForPrompt<LabCriteria>({
    runParams,
    taskLabel: `lab:${actor}`,
    acceptance,
    actor,
    prompt,
    emptyCriteria,
    scoreFromCommitted: score
  });
  return {
    criteria: out.criteria,
    terminalReason: out.terminalReason,
    log: out.log,
    transcript: out.transcript,
    rendered: out.rendered
  };
}
```

- [ ] **Step 6: Export from the package index**

In `packages/agent/src/index.ts` add to the exports:

```typescript
export {
  runAgentLab,
  type RunAgentLabParams,
  type AgentLabResult,
  type LabCriteria
} from "./session";
export { type StrataSessionContext } from "./tools";
```

(If `loadTranscriptFixture` is not already exported from `./session` via index, add it too — the Task 1 test imports it from the index.)

- [ ] **Step 7: Run the seam tests + full canonical suite**

Run: `pnpm --filter @strata/agent build && pnpm --filter @strata/agent test`
Expected: PASS. The `labSeam` tests pass; **all pre-existing tests keep their prior pass/skip counts** (the seam gate).

- [ ] **Step 8: Run the whole canonical workspace to prove byte-identical behavior**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS with the **same canonical counts as `main`** (the README/RESULTS reproducibility number is unchanged because no behavior changed and `@strata/lab` does not exist yet).

- [ ] **Step 9: Commit**

```bash
git add packages/agent/src/session.ts packages/agent/src/index.ts packages/agent/test/labSeam.test.ts
git commit -m "feat(agent): additive lab seam — toolServerFactory/canUseTool + runAgentLab (default byte-identical)"
```

### Task 3: Log the seam decision

**Files:**
- Modify: `decisions.md`

- [ ] **Step 1: Prepend a newest-first entry**

Add at the top of `decisions.md` (immediately under the format header block, above the current newest entry) a dated entry titled e.g. `## 2026-05-17 — Lab seam landed: one additive, default-preserving session injection point (toolServerFactory/canUseTool/runAgentLab); canonical byte-identical`. It must state: what changed, that it is the sole sanctioned canonical touch for the exploration-sandbox effort, the gate (existing canonical tests unchanged/green, `pnpm -r test` count unchanged), that scoring/replay paths are untouched, and "Revisit when: a graduated method needs net-new tool names (hermetic guard generalization — its own entry)."

- [ ] **Step 2: Commit**

```bash
git add decisions.md
git commit -m "docs(decisions): record the additive lab seam (sole sanctioned canonical touch)"
```

---

## Phase 2 — Lab package scaffold + isolation fences

### Task 4: Scaffold `@strata/lab` with mechanically-checkable fences

**Files:**
- Create: `packages/lab/package.json`, `packages/lab/tsconfig.json`, `packages/lab/vitest.config.ts`, `packages/lab/README.md`, `packages/lab/LAB-NOTES.md`, `packages/lab/.gitignore`, `packages/lab/src/index.ts`, `packages/lab/test/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lab/test/scaffold.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { LAB_IS_NON_AUTHORITATIVE } from "../src/index";

describe("lab scaffold", () => {
  it("declares itself non-authoritative", () => {
    expect(LAB_IS_NON_AUTHORITATIVE).toBe(true);
  });
});
```

- [ ] **Step 2: Create `packages/lab/package.json`**

```json
{
  "name": "@strata/lab",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "echo '[@strata/lab] NON-AUTHORITATIVE sandbox. Run: pnpm --filter @strata/lab test:lab'",
    "test:lab": "vitest run",
    "lab": "node dist/run.js"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.2.118",
    "@strata/agent": "workspace:*",
    "@strata/ingest": "workspace:*",
    "@strata/render": "workspace:*",
    "@strata/store": "workspace:*",
    "@strata/verify": "workspace:*",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.15.29",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

> **Fence rationale (normative):** the recursive `test` script is a deliberate echo no-op, so `pnpm -r test` (the published reproducibility command) runs **zero** lab tests and the canonical count is provably unchanged. Lab tests run only via the explicit `pnpm --filter @strata/lab test:lab`. This diverges from the spec's wording (`pnpm --filter @strata/lab test`) for a strictly stronger fence; note it in `LAB-NOTES.md`.

- [ ] **Step 3: Create `packages/lab/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src"],
  "references": [
    { "path": "../agent" },
    { "path": "../verify" },
    { "path": "../ingest" },
    { "path": "../render" },
    { "path": "../store" }
  ]
}
```

- [ ] **Step 4: Create `packages/lab/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
```

- [ ] **Step 5: Create `packages/lab/src/index.ts`**

```typescript
/**
 * @strata/lab — NON-AUTHORITATIVE exploration sandbox.
 * Nothing here is a claim. See README.md and the spec.
 */
export const LAB_IS_NON_AUTHORITATIVE = true as const;
```

- [ ] **Step 6: Create `packages/lab/README.md`**

```markdown
# @strata/lab — NON-AUTHORITATIVE SANDBOX

**Nothing here is a claim.** Results do NOT feed RESULTS.md / decisions.md /
strata-design.md. A method leaves here only by GRADUATING into the rigid
keyed framework (pre-registered, N>=3, file baseline, transcript
classification, T03 regression guard) — see the spec
`docs/superpowers/specs/2026-05-17-multi-step-exploration-sandbox-design.md`.

Run an experiment: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab lab <experiment-id>`
Run lab tests:     `pnpm --filter @strata/lab test:lab`

The canonical `pnpm -r test` count intentionally excludes this package.
```

- [ ] **Step 7: Create `packages/lab/LAB-NOTES.md`**

```markdown
# Lab notes (append-only, NON-AUTHORITATIVE journal)

NOT decisions.md. Freeform exploration log. Nothing here is a claim.

- 2026-05-17: scaffold created. Fence divergence from spec wording: recursive
  `test` is a no-op echo; real lab tests run via `test:lab` so `pnpm -r test`
  is provably unchanged.
```

- [ ] **Step 8: Create `packages/lab/.gitignore`**

```
results/
*.log
.lab-scratch/
```

- [ ] **Step 9: Build and run lab tests**

Run: `pnpm install && pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab`
Expected: PASS (scaffold test green).

- [ ] **Step 10: Prove the canonical fence holds**

Run: `pnpm -r test`
Expected: PASS, and the lab line shows the echo no-op (no lab tests counted). Confirm the canonical pass/skip totals equal `main`'s.

- [ ] **Step 11: Commit**

```bash
git add packages/lab pnpm-lock.yaml
git commit -m "feat(lab): scaffold @strata/lab with non-authoritative fences (excluded from pnpm -r test)"
```

---

## Phase 3 — Measurement instrument

### Task 5: Create the derived lab corpus

**Files:**
- Create: `packages/lab/corpus/**` (copy of `examples/medium`) + 3 named additive edits
- Test: `packages/lab/test/corpus.test.ts`

- [ ] **Step 1: Copy the corpus**

```bash
mkdir -p packages/lab/corpus
cp -R examples/medium/. packages/lab/corpus/
rm -rf packages/lab/corpus/node_modules
```

Verify `examples/medium` is byte-identical afterward: `git status --porcelain examples/` must be empty.

- [ ] **Step 2: Add the per-scope constants (additive edits)**

Create `packages/lab/corpus/src/server/config.ts`:

```typescript
/** Server-scope timezone policy. The HD task derives the per-callsite
 *  argument from THIS exported constant — never from the prompt. */
export const ZONE = "UTC";
```

Create `packages/lab/corpus/src/ui/config.ts`:

```typescript
/** UI-scope timezone policy. */
export const ZONE = "local";
```

(No `config.ts` is added under any other scope, so callsites outside
`src/server/` and `src/ui/` must take the default — a third, derivable
branch.)

- [ ] **Step 3: Add the behavioral test**

Create `packages/lab/corpus/tests/timezone.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatTimestamp } from "../src/lib/format";

// Behavioral fail-before: until `timezone` is added with a "UTC" default
// and threaded, this asserts the post-change contract.
describe("formatTimestamp timezone", () => {
  it("defaults to UTC and honors an explicit zone", () => {
    expect(formatTimestamp(0)).toContain("UTC");
    expect(formatTimestamp(0, "local")).toContain("local");
  });
});
```

If `examples/medium`'s `formatTimestamp` lives elsewhere than `src/lib/format.ts`, adjust the import to its real path (find with `grep -rn "function formatTimestamp" packages/lab/corpus/src`). Keep the assertions; they encode the derivable contract.

- [ ] **Step 4: Write the corpus sanity test**

Create `packages/lab/test/corpus.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const C = path.join(__dirname, "..", "corpus");

describe("lab corpus", () => {
  it("has the two per-scope ZONE constants and no others", () => {
    expect(fs.readFileSync(path.join(C, "src/server/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "UTC"/);
    expect(fs.readFileSync(path.join(C, "src/ui/config.ts"), "utf8"))
      .toMatch(/export const ZONE = "local"/);
  });

  it("does NOT contain the literal \"local\" anywhere except ui/config.ts", () => {
    // The HD task's value is structurally present, not prompt-only.
    // (Contrast with T01, whose scorer needs a prompt-only literal.)
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && fs.readFileSync(p, "utf8").includes('"local"'))
          hits.push(path.relative(C, p));
      }
    };
    walk(path.join(C, "src"));
    expect(hits).toEqual(["src/ui/config.ts"]);
  });
});
```

- [ ] **Step 5: Run the corpus tests**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- corpus`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/lab/corpus packages/lab/test/corpus.test.ts
git commit -m "feat(lab): derived corpus copy + per-scope ZONE constants (derivable, not prompt-only)"
```

### Task 6: Honest-derivable task — prompt + zero-literal oracle scorer

**Files:**
- Create: `packages/lab/src/tasks/honestDerivable.ts`
- Test: `packages/lab/test/honestDerivable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lab/test/honestDerivable.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  HD_PROMPT,
  deriveOracle,
  scoreHonestDerivable
} from "../src/tasks/honestDerivable";

describe("HD task", () => {
  it("prompt names no per-scope literal value", () => {
    // The prompt must NOT spell "UTC"/"local" — the value is in the code.
    expect(HD_PROMPT).not.toMatch(/"UTC"|"local"/);
    expect(HD_PROMPT).toMatch(/ZONE/);
  });

  it("oracle is computed from the corpus, not hardcoded", () => {
    const oracle = deriveOracle(); // reads packages/lab/corpus
    // server callsites -> server/config ZONE; ui -> ui/config ZONE;
    // others -> default (no second arg).
    expect(oracle.scopes.server).toBe("ZONE"); // a reference, not a literal
    expect(oracle.scopes.ui).toBe("ZONE");
    expect(oracle.scopes.other).toBeUndefined();
  });

  it("a correct rendered tree scores pass; a literal-injected one fails", () => {
    const correct = deriveOracle().exampleCorrectRender;
    expect(scoreHonestDerivable(correct).pass).toBe(true);
    const cheated = new Map(correct);
    // Inject the prompt-style literal instead of the ZONE reference:
    const ui = [...cheated.keys()].find((k) => k.includes("ui/")) as string;
    cheated.set(ui, cheated.get(ui)!.replace(/,\s*ZONE\s*\)/g, ', "local")'));
    expect(scoreHonestDerivable(cheated).pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @strata/lab test:lab -- honestDerivable`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the HD task**

Create `packages/lab/src/tasks/honestDerivable.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

const CORPUS = path.join(__dirname, "..", "..", "corpus");

/** No per-scope literal appears here — the value lives in the code. */
export const HD_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` (after the " +
  "existing `ts` parameter), defaulting to the server-scope policy. At " +
  "every callsite, pass the `ZONE` constant exported by that module " +
  "scope's `config.ts` (import it). Callsites in a scope that exports no " +
  "`ZONE` must take the default. The tests in `tests/timezone.test.ts` " +
  "must pass.";

export interface Oracle {
  /** Per scope: the SYMBOL the callsite must reference (never a literal),
   *  or undefined ⇒ default (no second argument). */
  scopes: { server: "ZONE"; ui: "ZONE"; other: undefined };
  /** A known-correct rendered src map, derived for the scorer's self-test. */
  exampleCorrectRender: Map<string, string>;
}

function scopeOf(relPath: string): "server" | "ui" | "other" {
  if (relPath.startsWith("src/server/")) return "server";
  if (relPath.startsWith("src/ui/")) return "ui";
  return "other";
}

/** Derive the expected per-scope argument by READING the corpus:
 *  a scope's config.ts exporting `ZONE` ⇒ callsites there reference ZONE;
 *  no such export ⇒ default. Zero hardcoded expected values. */
export function deriveOracle(): Oracle {
  const hasZone = (scopeDir: string): boolean => {
    const f = path.join(CORPUS, "src", scopeDir, "config.ts");
    return (
      fs.existsSync(f) && /export const ZONE\b/.test(fs.readFileSync(f, "utf8"))
    );
  };
  const server = hasZone("server") ? ("ZONE" as const) : undefined;
  const ui = hasZone("ui") ? ("ZONE" as const) : undefined;
  if (server !== "ZONE" || ui !== "ZONE") {
    throw new Error("HD corpus invariant broken: expected ZONE in both scopes");
  }
  return {
    scopes: { server, ui, other: undefined },
    exampleCorrectRender: buildExampleCorrectRender()
  };
}

/** A minimal correct rendering used only by the scorer's own unit test
 *  (NOT by live runs). Live runs score the agent's real rendered store. */
function buildExampleCorrectRender(): Map<string, string> {
  return new Map([
    [
      "src/server/events.ts",
      'import { ZONE } from "./config";\nformatTimestamp(0, ZONE);\n'
    ],
    [
      "src/ui/timeline.ts",
      'import { ZONE } from "./config";\nformatTimestamp(0, ZONE);\n'
    ],
    ["src/index.ts", "formatTimestamp(0);\n"]
  ]);
}

export interface HdScore {
  pass: boolean;
  perCallsite: { path: string; expected: string; got: string; ok: boolean }[];
}

const CALL_RE = /formatTimestamp\(\s*[^,)]+(?:,\s*([^)]+))?\)/g;

/** Pure function of the rendered src text. Contains NO expected literal:
 *  the expectation per callsite is the code-derived oracle. */
export function scoreHonestDerivable(
  rendered: Map<string, string>
): HdScore {
  const oracle = deriveOracleScopesOnly();
  const perCallsite: HdScore["perCallsite"] = [];
  for (const [rel, text] of rendered) {
    const scope = scopeOf(rel);
    const want = oracle[scope]; // "ZONE" symbol or undefined (default)
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
  return { pass: perCallsite.length > 0 && perCallsite.every((c) => c.ok), perCallsite };
}

function deriveOracleScopesOnly(): Record<
  "server" | "ui" | "other",
  "ZONE" | undefined
> {
  const o = deriveOracle().scopes;
  return { server: o.server, ui: o.ui, other: o.other };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- honestDerivable`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lab/src/tasks/honestDerivable.ts packages/lab/test/honestDerivable.test.ts
git commit -m "feat(lab): honest-derivable task + zero-literal oracle scorer"
```

### Task 7: Trapped control (graduation-only integrity discriminator)

**Files:**
- Create: `packages/lab/src/tasks/trappedControl.ts`
- Test: `packages/lab/test/trappedControl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lab/test/trappedControl.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TRAP_PROMPT, scoreTrapped } from "../src/tasks/trappedControl";
import { deriveOracle } from "../src/tasks/honestDerivable";

describe("trapped control", () => {
  it("states the value ONLY in the prompt (T01-shaped)", () => {
    expect(TRAP_PROMPT).toMatch(/"local"/); // prompt-only literal, by design
  });

  it("is unsatisfiable by an honest derivable solution", () => {
    // The HD-correct render (references ZONE) must FAIL the trap, because
    // the trap scorer requires the prompt-only literal. This is the
    // built-in contamination alarm.
    const honestCorrect = deriveOracle().exampleCorrectRender;
    expect(scoreTrapped(honestCorrect).pass).toBe(false);
  });

  it("only a prompt-transcribed literal passes the trap", () => {
    const m = new Map(deriveOracle().exampleCorrectRender);
    const ui = [...m.keys()].find((k) => k.includes("ui/")) as string;
    m.set(ui, m.get(ui)!.replace(/,\s*ZONE\s*\)/g, ', "local")'));
    // Still not fully passing (server side needs "UTC" literal too) — the
    // point is the alarm: passing requires transcribing the prompt.
    expect(scoreTrapped(m).requiresPromptLiteral).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @strata/lab test:lab -- trappedControl`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the trapped control**

Create `packages/lab/src/tasks/trappedControl.ts`:

```typescript
/** A deliberate T01-shaped trap: the per-scope value is stated ONLY here,
 *  nowhere in the corpus. Its scorer requires that prompt-only literal,
 *  so it is structurally unsatisfiable by an honest (code-derived)
 *  method — exactly the verified 2026-05-17 finding, reproduced as the
 *  sandbox's contamination alarm. Run ONLY at graduation. */
export const TRAP_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` after `ts`, " +
  'default `"UTC"`. Callsites under `src/server/` must pass `"UTC"`; ' +
  'callsites under `src/ui/` must pass `"local"`. All other callsites ' +
  "take the default.";

export interface TrapScore {
  pass: boolean;
  /** True if the ONLY way the given render could pass is by transcribing
   *  the prompt literal (i.e. the literal appears at a ui callsite). */
  requiresPromptLiteral: boolean;
}

const UI_CALL = /formatTimestamp\(\s*0\s*,\s*"local"\s*\)/;
const SERVER_CALL = /formatTimestamp\(\s*0\s*,\s*"UTC"\s*\)/;

export function scoreTrapped(rendered: Map<string, string>): TrapScore {
  let ui = false;
  let server = false;
  for (const [rel, text] of rendered) {
    if (rel.includes("ui/") && UI_CALL.test(text)) ui = true;
    if (rel.includes("server/") && SERVER_CALL.test(text)) server = true;
  }
  return { pass: ui && server, requiresPromptLiteral: ui };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- trappedControl`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lab/src/tasks/trappedControl.ts packages/lab/test/trappedControl.test.ts
git commit -m "feat(lab): graduation-only trapped control (contamination alarm)"
```

---

## Phase 4 — Experiment interface + registry + runner

### Task 8: Experiment type + `runExperiment` + seam re-export

**Files:**
- Create: `packages/lab/src/seam.ts`, `packages/lab/src/experiment.ts`
- Test: `packages/lab/test/experiment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lab/test/experiment.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { LabExperiment } from "../src/experiment";
import { makeLabScorer } from "../src/experiment";

describe("experiment interface", () => {
  it("makeLabScorer adapts the HD oracle into a LabCriteria scorer", () => {
    const score = makeLabScorer("HD");
    // Empty rendered map ⇒ no callsites ⇒ fail, but shape is correct.
    const c = score(
      undefined as any,
      undefined as any,
      "",
      { commitReturnedOk: false, validateAfterCommitClean: false, txId: "t" } as any
    );
    expect(c).toHaveProperty("labOk");
    expect(c).toHaveProperty("commitReturnedOk");
  });

  it("a LabExperiment is a self-contained unit", () => {
    const exp: LabExperiment = {
      id: "noop",
      hypothesis: "control: canonical tools, expect HD fail (no per-scope expressiveness)",
      task: "HD",
      overrides: {}
    };
    expect(exp.task).toBe("HD");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @strata/lab test:lab -- experiment`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create the seam re-export**

Create `packages/lab/src/seam.ts`:

```typescript
/** Single import point for the canonical, additive lab seam. */
export {
  runAgentLab,
  type RunAgentLabParams,
  type AgentLabResult,
  type LabCriteria,
  type StrataSessionContext
} from "@strata/agent";
```

- [ ] **Step 4: Implement the experiment module**

Create `packages/lab/src/experiment.ts`:

```typescript
import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";
import type { LabCriteria, RunAgentLabParams } from "./seam";
import { scoreHonestDerivable } from "./tasks/honestDerivable";
import { scoreTrapped } from "./tasks/trappedControl";

export interface LabExperiment {
  /** kebab id; also the registry key and CLI argument. */
  id: string;
  /** one line: what this tests and the expected tell. */
  hypothesis: string;
  /** HD for the cheap inner loop; trap only at graduation. */
  task: "HD" | "trap";
  overrides: {
    toolServerFactory?: RunAgentLabParams["toolServerFactory"];
    canUseTool?: RunAgentLabParams["canUseTool"];
    /** rarely used; the sandbox is for tool/loop changes, not prompt tuning. */
    prompt?: string;
  };
}

/**
 * Render the committed store to a POSIX-keyed src map, then apply the
 * task's pure scorer. Mirrors how the canonical verify criteria render
 * (renderWithSourceMap over loaded modules); kept structurally identical
 * so a graduated method's numbers stay comparable.
 */
export function makeLabScorer(
  task: "HD" | "trap"
): RunAgentLabParams["score"] {
  return (db: Db, _batch, srcRoot: string, input): LabCriteria => {
    const rendered = renderCommittedSrc(db, srcRoot);
    const verdict =
      task === "HD" ? scoreHonestDerivable(rendered) : scoreTrapped(rendered);
    return {
      commitReturnedOk: input.commitReturnedOk,
      validateAfterCommitClean: input.validateAfterCommitClean,
      operationRowAppended: input.commitReturnedOk,
      labOk: verdict.pass
    };
  };
}

function renderCommittedSrc(db: Db, srcRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  // loadModule/renderWithSourceMap usage MUST match the canonical verify
  // criteria pattern. Before implementing, read packages/verify/src/
  // t03Criteria.ts evaluateT03TextCriteria for the exact module-iteration
  // + POSIX-relativization idiom and replicate it here verbatim (do not
  // invent a second rendering path — comparability depends on this).
  void loadModule;
  void renderWithSourceMap;
  void srcRoot;
  void db;
  return out;
}
```

> **Implementer note (not a placeholder):** `renderCommittedSrc` must be a
> faithful copy of the module-iteration + render + POSIX-relativization
> already used in `packages/verify/src/t03Criteria.ts`
> (`evaluateT03TextCriteria`). Open that file, copy the exact idiom, and
> fill the function body so the lab renders identically to the canonical
> scorer. This is required for graduated-result comparability and is an
> explicit step, not "TODO".

- [ ] **Step 5: Fill `renderCommittedSrc` from the canonical pattern**

Read `packages/verify/src/t03Criteria.ts`. Replicate its committed-module
rendering loop inside `renderCommittedSrc` (same `loadModule` enumeration,
same `renderWithSourceMap`, same `path.relative(srcRoot, ...)` →
POSIX-key normalization). Remove the `void` placeholders.

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- experiment`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/lab/src/seam.ts packages/lab/src/experiment.ts packages/lab/test/experiment.test.ts
git commit -m "feat(lab): LabExperiment interface + canonical-faithful scorer adapter"
```

### Task 9: Registry + cheap `lab run` CLI

**Files:**
- Create: `packages/lab/src/registry.ts`, `packages/lab/src/run.ts`
- Test: `packages/lab/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lab/test/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { REGISTRY, getExperiment } from "../src/registry";

describe("registry", () => {
  it("maps ids to experiments and throws on unknown", () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
    expect(() => getExperiment("nope")).toThrow(/unknown experiment/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @strata/lab test:lab -- registry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `packages/lab/src/registry.ts`:

```typescript
import type { LabExperiment } from "./experiment";
import { perScopeAddParameter } from "./experiments/perScopeAddParameter";

export const REGISTRY: Record<string, LabExperiment> = {
  [perScopeAddParameter.id]: perScopeAddParameter
};

export function getExperiment(id: string): LabExperiment {
  const exp = REGISTRY[id];
  if (!exp) {
    throw new Error(
      `Unknown experiment "${id}". Known: ${Object.keys(REGISTRY).join(", ") || "(none)"}`
    );
  }
  return exp;
}
```

(If Task 10 is not yet done, temporarily register a `{ id: "noop", hypothesis: "control", task: "HD", overrides: {} }` inline so this task is self-contained and green; replace with the real import in Task 10.)

- [ ] **Step 4: Implement the runner**

Create `packages/lab/src/run.ts`:

```typescript
import path from "node:path";
import { runAgentLab } from "./seam";
import { getExperiment } from "./registry";
import { makeLabScorer } from "./experiment";
import { HD_PROMPT } from "./tasks/honestDerivable";
import { TRAP_PROMPT } from "./tasks/trappedControl";

const CORPUS = path.join(__dirname, "..", "corpus");

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: lab <experiment-id> [--model m] [--max-turns n]");
    process.exit(2);
  }
  const exp = getExperiment(id);
  const model = argVal("--model") ?? "claude-sonnet-4-6";
  const maxTurns = Number(argVal("--max-turns") ?? 25);
  const prompt =
    exp.overrides.prompt ?? (exp.task === "HD" ? HD_PROMPT : TRAP_PROMPT);

  console.log(
    `[lab] ${exp.id} | task=${exp.task} | model=${model} | maxTurns=${maxTurns}`
  );
  console.log(`[lab] hypothesis: ${exp.hypothesis}`);
  console.log(`[lab] NON-AUTHORITATIVE — not a claim. HD-only inner loop.`);

  const score = makeLabScorer(exp.task);
  const result = await runAgentLab({
    corpusRoot: CORPUS,
    model,
    maxTurns,
    wallTimeMs: 240000,
    actor: `lab-${exp.id}`,
    prompt,
    acceptance: undefined, // tsc-only commit path; HD scorer is the verdict
    toolServerFactory: exp.overrides.toolServerFactory,
    canUseTool: exp.overrides.canUseTool,
    emptyCriteria: () => ({
      commitReturnedOk: false,
      validateAfterCommitClean: false,
      operationRowAppended: false,
      labOk: false
    }),
    score
  });

  for (const step of result.transcript) {
    console.log(`  · ${step.tool} ${JSON.stringify(step.args).slice(0, 160)}`);
  }
  console.log(
    `[lab] terminal=${result.terminalReason} labOk=${result.criteria.labOk} ` +
      `commitOk=${result.criteria.commitReturnedOk}`
  );
  console.log(
    result.criteria.labOk
      ? `[lab] PASS on ${exp.task}. If task=HD: next, run the trapped control before any graduation.`
      : `[lab] FAIL on ${exp.task}. Tweak the variant and re-run.`
  );
}

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((e) => {
  console.error("[lab] crashed:", e);
  process.exit(1);
});
```

- [ ] **Step 5: Run the registry test + typecheck the runner**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- registry`
Expected: PASS, and `dist/run.js` exists (build succeeded).

- [ ] **Step 6: Commit**

```bash
git add packages/lab/src/registry.ts packages/lab/src/run.ts packages/lab/test/registry.test.ts
git commit -m "feat(lab): experiment registry + cents-per-run lab CLI (N=1, transcript to stdout)"
```

---

## Phase 5 — First experiment: per-scope `add_parameter`

### Task 10: Variant `add_parameter` tool server + mechanics test + experiment

**Files:**
- Create: `packages/lab/src/experiments/perScopeAddParameter.ts`
- Test: `packages/lab/test/perScopeAddParameter.test.ts`

- [ ] **Step 1: Read the canonical tool server + addParameter store op**

Read `packages/agent/src/tools.ts` (`createStrataToolServer`, `createStrataTools`, the `add_parameter` tool at lines ~152–180) and `grep -rn "addParameter\|queueTextSpanEdit" packages/store/src` to find the store entry points. The variant reuses the SAME tool name `add_parameter` (net-new names would trip the hermetic guard — out of seam scope), but its handler accepts an extra optional `per_scope` map and applies the scope-appropriate argument per resolved callsite.

- [ ] **Step 2: Write the deterministic, model-free mechanics test**

Create `packages/lab/test/perScopeAddParameter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildVariantToolServer } from "../src/experiments/perScopeAddParameter";
import { openDb } from "@strata/store";

// Model-FREE: drive the variant tool directly over an in-memory store
// built from the lab corpus and assert the overlay differentiates by
// scope WITHOUT a second replace_body edit (the diagnosed T01 collision).
describe("per-scope add_parameter mechanics", () => {
  it("inserts ZONE at server+ui callsites and default elsewhere, one op", () => {
    const db = openDb(":memory:");
    // Ingest the lab corpus into db using the same ingest path the runner
    // uses (copy the ingest+insert idiom from packages/agent/src/session.ts
    // runAgentForPrompt lines ~264-273: ingestBatch(collectTsFiles(srcRoot)),
    // insertNodes, insertReferences). Then:
    const server = buildVariantToolServer({ db, actor: "test" });
    // call begin_transaction, then the variant add_parameter with a
    // per_scope policy { "src/server/": "ZONE-from-./config",
    // "src/ui/": "ZONE-from-./config" }, then validate.
    // Assert: zero `oldText mismatch`; each callsite has the scope arg;
    // exactly ONE operation-log row (no replace_body).
    expect(typeof server).toBe("object");
  });
});
```

> Fill the test body using the ingest/insert idiom from
> `packages/agent/src/session.ts` `runAgentForPrompt` (the
> `ingestBatch(collectTsFiles(srcRoot))` → `insertNodes` →
> `insertReferences` sequence) against `packages/lab/corpus/src`. The
> assertions (one op-log row, no `oldText mismatch`, per-scope arg
> present) are the mechanics contract — keep them.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @strata/lab test:lab -- perScopeAddParameter`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the variant tool server + experiment**

Create `packages/lab/src/experiments/perScopeAddParameter.ts`:

```typescript
import {
  createSdkMcpServer,
  tool
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { StrataSessionContext } from "../seam";
import type { LabExperiment } from "../experiment";

/**
 * Variant tool server: canonical Strata tools EXCEPT `add_parameter`,
 * which is replaced (same NAME) with a per-scope-expressive variant.
 * It accepts an optional `per_scope` policy mapping a module-path prefix
 * to an argument expression (e.g. an imported `ZONE`), so the agent
 * expresses the per-callsite differentiation as ONE structural op —
 * removing the need for the colliding hand-`replace_body` that the four
 * falsified levers all traced back to.
 *
 * Build by composing the canonical tool list (import createStrataTools
 * from @strata/agent — already exported), dropping the canonical
 * add_parameter definition, and appending this variant. Wrap with
 * createSdkMcpServer using the canonical STRATA_SERVER_NAME so the
 * hermetic init guard (assertOnlyStrataTools) still passes (same names).
 */
export function buildVariantToolServer(ctx: StrataSessionContext) {
  // Implementation steps (each concrete, no TBD):
  // 1. const { createStrataTools, STRATA_SERVER_NAME } = require("@strata/agent")
  //    — or import; confirm both are exported (STRATA_SERVER_NAME is in
  //    packages/agent/src/tools.ts; export it from the index if missing —
  //    that index export is itself a tiny additive seam-adjacent change,
  //    allowed under the Phase-1 entry's umbrella, re-run the canonical
  //    suite + note in LAB-NOTES.md).
  // 2. const base = createStrataTools(ctx).filter(t => t.name !== "add_parameter")
  // 3. const variant = tool("add_parameter", <canonical description + one
  //    sentence on per_scope>, { ...canonical add_parameter schema,
  //    per_scope: z.record(z.string()).optional() }, async (args) => {
  //      apply the canonical addParameter store op, then for each resolved
  //      callsite choose the per_scope expression whose key prefixes the
  //      callsite's module path (longest-prefix wins), else the default.
  //      Reuse the canonical store addParameter entry point; do NOT add a
  //      second text-span edit. })
  // 4. return createSdkMcpServer({ name: STRATA_SERVER_NAME,
  //      tools: [...base, variant] })
  throw new Error("implement per step comments using canonical building blocks");
}

export const perScopeAddParameter: LabExperiment = {
  id: "per-scope-add-parameter",
  hypothesis:
    "Per-scope add_parameter expressiveness lets the agent differentiate " +
    "callsites in ONE structural op; expect HD PASS and no oldText-mismatch " +
    "thrash (the four-falsified-levers root cause).",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildVariantToolServer(ctx)
  }
};
```

- [ ] **Step 5: Implement `buildVariantToolServer` per the numbered comments**

Replace the `throw` with the real composition described in the four
numbered comments, using the canonical `createStrataTools` /
`STRATA_SERVER_NAME` building blocks and the canonical store
`add_parameter` op. The variant adds NO new tool name and NO second
text-span edit. If `STRATA_SERVER_NAME` / `createStrataTools` are not
exported from `@strata/agent`'s index, add those two re-exports (additive,
re-run `pnpm -r test` to confirm canonical counts unchanged, and append a
line to `LAB-NOTES.md` — this stays under the Phase-1 seam entry's scope
since it is export-only, no behavior change).

- [ ] **Step 6: Run the mechanics test**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab -- perScopeAddParameter`
Expected: PASS — the variant differentiates by scope in one op, zero `oldText mismatch`, exactly one operation-log row.

- [ ] **Step 7: Update the registry to import the real experiment**

If Task 9 used an inline `noop` placeholder, replace it: `registry.ts` imports `perScopeAddParameter` from `./experiments/perScopeAddParameter` and registers it under its `id`.

- [ ] **Step 8: Run the whole lab suite + prove canonical fence still holds**

Run: `pnpm --filter @strata/lab build && pnpm --filter @strata/lab test:lab`
Expected: all lab tests PASS.

Run: `pnpm -r test`
Expected: canonical counts identical to `main` (lab still excluded via the no-op recursive `test`).

Run: `git diff --stat main -- packages/store packages/render packages/verify`
Expected: empty (canonical store/render/verify byte-identical; only `packages/agent` changed, and only via the reviewed Phase-1 seam).

- [ ] **Step 9: Commit**

```bash
git add packages/lab
git commit -m "feat(lab): first experiment — per-scope add_parameter variant + model-free mechanics test"
```

- [ ] **Step 10: Append a lab-notes entry**

Add to `packages/lab/LAB-NOTES.md`: date, the experiment id, the hypothesis, and "ready for the cheap live inner loop: `pnpm --filter @strata/lab lab per-scope-add-parameter` (operator-run, ~cents, NOT a claim)."

```bash
git add packages/lab/LAB-NOTES.md
git commit -m "docs(lab): note per-scope-add-parameter ready for the cheap inner loop"
```

---

## Operator step (NOT a plan task — explicitly outside automated execution)

The cheap live inner loop is operator-run and key-bearing, so it is **not** a
checkbox here (mirrors how the canonical keyed rounds are operator-only):

```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/lab build && \
  pnpm --filter @strata/lab lab per-scope-add-parameter --model claude-sonnet-4-6
```

Read the stdout transcript + `labOk`. Iterate the variant, re-run. Only when
HD passes reproducibly AND the trapped control still fails does the method
enter the **existing rigid pipeline unchanged** (spec → TDD into the canonical
package → Codex review per CLAUDE.md → pre-registered keyed N≥3 with T03 as
the regression guard → newest-first `decisions.md` entry). Sandbox output is
never itself a claim.

---

## Self-Review

**Spec coverage:**
- `packages/lab/` non-authoritative package + fences → Tasks 4 (scaffold + no-op recursive `test` fence), 8/9 (structure), 10 Step 8 (`git diff` proof). ✓
- Canonical byte-identical except one reviewed seam → Phase 1 (Tasks 1–3, gated on unchanged counts), Task 10 Step 8 `git diff --stat`. ✓
- HD task + zero-literal derivable scorer + unique code-determined oracle → Task 6 (`deriveOracle` reads corpus, `scoreHonestDerivable` has no expected literal, corpus test asserts `"local"` only in `ui/config.ts`). ✓
- Trapped control, graduation-only, contamination alarm → Task 7 (`scoreTrapped`, test asserts honest-correct render FAILS trap). ✓
- Experiment interface (one file, hypothesis, task, composed overrides) → Task 8. ✓
- Seam (additive, optional, default-preserving, exported, decisions.md entry) → Tasks 1–3. ✓
- Cheap N=1 live runner, transcript+verdict to stdout, no baseline/pre-reg → Task 9. ✓
- Initial backlog lever #1 (per-scope add_parameter) → Task 10; levers #2–4 (overlap gate, escape-hatch removal, loop wrapper) are added later as additional one-file experiments using the same Task-8 interface (explicitly future experiments, not gaps — the spec calls the backlog "a starting point, not a fixed protocol"). ✓
- Graduation criterion → documented in README (Task 4), runner output (Task 9), and the Operator step. ✓
- Lab mechanics tests model-free; cheap live run never in CI → Task 10 Step 2 (model-free), Task 4 fence (recursive `test` no-op). ✓

**Placeholder scan:** The two `void`/`throw` stubs (Task 8 `renderCommittedSrc`, Task 10 `buildVariantToolServer`) are each immediately followed by a dedicated implementation step (Task 8 Step 5, Task 10 Step 5) with concrete, numbered instructions referencing exact canonical source to copy — not "TODO later". Acceptable by design (TDD red→green within the same task).

**Type consistency:** `LabCriteria` (index-signature `[extra:string]:boolean` + the three base booleans) is defined in Task 2 and consumed unchanged in Tasks 8/9 (`labOk` is a valid extra key). `RunAgentLabParams` fields (`toolServerFactory`, `canUseTool`, `acceptance`, `emptyCriteria`, `score`) defined in Task 2 are used verbatim in Tasks 9/10. `LabExperiment.overrides` shape is consistent across Tasks 8/9/10. `scoreHonestDerivable`/`scoreTrapped` signatures (`Map<string,string> → {pass}`) consistent across Tasks 6/7/8. ✓

---

## Execution Handoff

(Provided after the plan is reviewed.)
