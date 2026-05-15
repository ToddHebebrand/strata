# Phase 4 — T03 Benchmark (Substrate vs. File-Based Baseline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/bench` (`@strata/bench`): a key-free-testable harness that runs the existing Phase 3 substrate (`runAgentT03`) and a new file-based "Claude Code"-style baseline N trials each on T03, scores both through one provably-equivalent text-criteria core, and emits a distribution report — with the live round itself as an explicit, key-gated operator command, never a CI test.

**Architecture:** One new leaf package `packages/bench` consuming `@strata/agent` + `@strata/verify` (no `@strata/cli` edge — the shared scorer core stays in `@strata/verify`). A behavior-preserving refactor first extracts `evaluateT03TextCriteria(Map<modulePath,string>)` inside `@strata/verify` so the substrate adapter (renders committed store modules) and the baseline adapter (reads post-edit `.ts` files off a temp tree) feed byte-identical scoring logic. The runner loops trials, the substrate config wraps `runAgentT03` as-is, the baseline config runs a file-tool SDK `query()` on a recursive copy of `examples/medium`, metrics aggregate into distributions (never bare means), and `pnpm --filter @strata/bench bench:t03` is the operator-only live entry point that writes artifacts under `packages/bench/results/`.

**Tech Stack:** TypeScript 5.8, Node 22, pnpm workspaces, `@anthropic-ai/claude-agent-sdk@0.2.118` (installed; `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), `zod@4.4.3` imported as `zod/v4`, `vitest@3`, the existing `@strata/agent` / `@strata/verify` / `@strata/ingest` / `@strata/render` / `@strata/store` packages, `examples/medium` corpus.

---

## Plan amendments (authoritative — override any conflicting task detail below)

**Where any task, file-layout line, code snippet, or "Resolution" below conflicts with these, the amendment wins.** The implementer adapts package boundaries, imports, `package.json` deps, and tsconfig `references` accordingly using judgment; the intent is unambiguous even where a downstream snippet still shows the old shape.

### Amendment 1 — the shared text-criteria core stays in `@strata/verify`; `bench` imports it from the verify barrel

The spec is explicit (§ "Package / file layout", § "Scorer equivalence"): `evaluateT03TextCriteria` lives in `@strata/verify` and `@strata/bench` reaches it through the verify barrel (`@strata/verify`), **not** a deep `dist/` path and **not** by relocating the scorer into `bench`. Moving it to `bench` would create a cycle (`verify`'s own `evaluateT03Criteria` needs it, and `agent` → `verify`; `bench` → `agent`/`verify`). The dependency graph stays acyclic: `bench → agent → … → verify`, and `bench → verify` directly. **No one may "tidy" the scorer core into `bench` later** — call this out in the Task 0 decision entry. The Phase 3 plan's Amendment 1 already noted this Phase 4 relocation question and resolved it the same way: it does **not** relocate.

### Amendment 2 — the live benchmark is NOT a vitest test

`pnpm -r test` must stay green with **no API key**. The benchmark makes live nondeterministic model calls and **writes artifacts**; it is therefore an explicit key-gated `package.json` script (`pnpm --filter @strata/bench bench:t03`), never wired into `pnpm -r test`. Every `packages/bench/tests/*` file is key-free and uses synthetic session results / synthetic temp trees. No test in the whole monorepo suite may require a key or make a live call. (Mirrors the Phase 3 operator-pending live-run pattern, but Phase 4 has **no replay** — replaying would fabricate the very token/wall-time numbers the benchmark measures, so the live round is operator-only and its output is artifacts, not assertions.)

---

## Operator-vs-implementer split (read first)

The implementer (Codex) **cannot use git** and **cannot reliably reach the npm registry** from its sandbox. Therefore:

- **The implementer never runs `git`.** Every task below ends at a "**Operator commit boundary**" marker instead of a `git commit` step. The implementer's definition of done for a task is: the listed tests pass **and** `pnpm -r build` is green **and** `pnpm -r test` is green. The human operator runs `git add`/`git commit` at each boundary, runs the one-time `pnpm install` (Task 1), and runs the key-gated live benchmark round (Task 9).
- **The implementer must run BOTH `pnpm -r build` AND `pnpm -r test` at every task boundary.** Vitest does **not** typecheck (it transpiles per-file). A green `pnpm -r test` with a broken `pnpm -r build` (`tsc -b`) is **NOT done** — this trap bit Phase 1. Build first, then test. Both green = task done.
- **`pnpm install` is operator-only and happens once (Task 1, Step 2).** The implementer must not run `pnpm add`/`pnpm install`. Task 1 writes `package.json`/`tsconfig.json`; the operator runs install before the implementer continues.
- **No API key is required to run `pnpm -r test` green.** The only key-gated path is the `bench:t03` script (Task 9), which is a `package.json` script, NOT a test. There is no `describe.skipIf` live test in `packages/bench` at all — harness logic is exercised exclusively against synthetic inputs.
- **Only public TypeScript / SDK APIs.** No internal `.jsDoc`-style property hacks; no reaching into other packages' `src/` internals — consume them through their `@strata/*` barrels. (See `decisions.md` 2026-05-15 "BS1 … `getChildren` traversal" for why internal-property hacks break `tsc -b` even when vitest is green.)

## Source-of-truth pointers

- Spec (authoritative for WHAT): `/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-05-15-phase4-t03-benchmark-design.md`
- Invariants: `/Users/toddhebebrand/Strata/CLAUDE.md` — files are not first-class **for the substrate**; the baseline is the control group and is file-based by construction (spec § "The deliberate contrast").
- Prior decisions (do not re-litigate): `/Users/toddhebebrand/Strata/decisions.md` (newest-first; per-task entries). Especially the 2026-05-15 "Agent hermetic isolation" entry — the baseline config deliberately **inverts** it.
- Benchmark task: `/Users/toddhebebrand/Strata/docs/benchmarks.md` § T03 (verbatim prompt + criteria + the retry-counting ambiguity the spec resolves).
- Phase 3 plan (format/convention reference): `/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-05-15-phase3-agent-plan.md`
- Existing code reused/extended: `packages/agent/src/session.ts` (`runAgentT03`, `T03_PROMPT`, `AgentT03Result`, `SessionLog`, `TerminalReason` — reuse as-is, do NOT fork), `packages/agent/src/log.ts` (`ResultEvent`/`ToolCallEvent`/`SessionLogEvent`), `packages/verify/src/t03Criteria.ts` (+ barrel) (refactor target), `packages/cli/src/commands/t03.ts` (must stay green), `examples/medium/` (the corpus; `src/` is the root scored).

## Decisions logged by this plan (per-task, newest-first convention)

`decisions.md` is append-only, newest-first. Each task that finalizes a durable choice appends its entry **in that task's own operator commit** (the implementer writes the `decisions.md` text; the operator commits it). Mapping:

- **D1 — behavior-preserving `evaluateT03TextCriteria` extraction in `@strata/verify`.** Logged in Task 0.
- **D2 — `@strata/bench` package created; scorer core stays in `verify` (no cycle).** Logged in Task 1.
- **D3 — symmetric retry/failure counting rule shipped as specified (Open Question 1).** Logged in Task 4.
- **D4 — baseline temp-checkout mechanism (copy vs. clone; corpus deps handling) (Open Question 3).** Logged in Task 7.
- **D5 — Phase 4 verticalizes on the T03 substrate-vs-baseline benchmark; the live round + BS-Bench-A/C/D observations.** Logged in Task 9 (operator, after the round).

If implementation forces a logged decision to change, append a **new** newest-first entry in the task where it changed; do not edit the old one. Bail-signal observations are logged in the task that surfaces them, not deferred.

## Bail-signal map (from spec § "Bail signals", cross-referenced to tasks)

Stop and surface if any of these fire. Do **not** work around. A surfaced wall is more valuable than a papered-over one.

- **BS-Bench-A — baseline cannot do T03 with file tools at all.** Surfaced in **Task 9** (the live round). Zero baseline successes across the trial set is a *finding to report as observed*, not engineered away by making T03 easier for the baseline than the substrate. Probed cheaply earlier only insofar as Task 7's synthetic-tree adapter test proves the scoring path is sound; the *agent capability* claim is operator-pending and recorded in Task 9's `decisions.md` entry regardless of outcome.
- **BS-Bench-B — substrate and baseline scorers not provably equivalent.** Surfaced in **Task 3** (the scorer-equivalence test). This is the **gate**: a key-free test must feed the *same logical outcome* through both the substrate `evaluateT03Criteria` path and the baseline adapter and assert the ten shared criteria are identical. If canonical-form divergence (whitespace/quotes from `render` vs. raw file text) cannot be reconciled inside the shared core, STOP — do not ship a number. Do not proceed past Task 3 until equivalence holds.
- **BS-Bench-C — cost explosion.** Surfaced in **Task 8** (runner prints projected spend before any trial) and **Task 9** (operator confirms before the round; records actuals). N default 3, configurable up to 5; a `--trials=0` dry-run mode exists. A round that would blow `$200–500` is halted and the cost driver logged, not absorbed.
- **BS-Bench-D — variance swamps signal at N=3–5.** Surfaced in **Task 9** (the report). Overlapping distributions / "no separable signal at this N" is a legitimate published result. Do NOT cherry-pick trials, drop outliers, raise N silently, or report a mean that hides overlap. The report formatter (Task 8) emits raw per-trial values + full distribution stats precisely so this cannot be massaged.

## File structure

Files created or modified, with one-line responsibilities. Sequencing is by task number.

**`packages/verify/src/` (refactor only — behavior preserved, Task 0):**
- `t03Criteria.ts` — **modified.** New exported pure `evaluateT03TextCriteria(modules: Map<string,string>): T03TextCriteria` (the nine text-derived criteria). `evaluateT03Criteria` keeps its exact signature, builds the `Map` from `db`/`batch` as today, then delegates for the nine text criteria and computes `commitReturnedOk`/`validateAfterCommitClean`/`operationRowAppended` exactly as before. No regex changed.
- `index.ts` — **modified.** Re-export `evaluateT03TextCriteria` + `T03TextCriteria` from the barrel.

**`packages/bench/` (new package):**
- `package.json` — `@strata/bench`; deps `@strata/agent`/`@strata/verify`/`@strata/ingest`/`@strata/render`/`@strata/store` (`workspace:*`), `@anthropic-ai/claude-agent-sdk`, `zod`; `bench:t03` script.
- `tsconfig.json` — extends `../../tsconfig.base.json`, `composite: true`, `references` agent/verify/ingest/render/store.
- `src/index.ts` — barrel: runner, `Metrics`/report types, config entry points.
- `src/metrics.ts` — `Metrics`/`TrialMetrics` schema + `distribution()` stats (N/min/max/median/mean/p25/p75/stddev + raw values) + `aggregate()`.
- `src/score.ts` — baseline file-reading adapter: walk `<tempCheckout>/src/**/*.ts` → `Map<modulePath,text>` → `evaluateT03TextCriteria`; the ten-shared-criterion assembler shared by both configs.
- `src/retry.ts` — the symmetric retry/failure counter over a session log (substrate side) and a baseline event list.
- `src/session.ts` — shared headless `query()` loop + `tool_use`/`tool_use_result` pairing + `SDKResultMessage` capture, factored so the baseline config reuses one loop (substrate reuses `@strata/agent`'s own loop via `runAgentT03`).
- `src/configs/substrate.ts` — thin wrapper over `runAgentT03` (live, per-trial); extracts metrics from its `SessionLog`; records `operationRowAppended` as the substrate-only sub-metric; `resultQuality` via render-to-temp + `tsc`/vitest.
- `src/configs/baseline.ts` — file-based SDK `query()` agent on a recursive temp copy of `examples/medium`; verbatim `T03_PROMPT` (imported from `@strata/agent`); file tool surface; scores via `src/score.ts`.
- `src/report.ts` — JSON + Markdown comparison report writer (distributions, never bare means).
- `src/runner.ts` — trial loop (for trial 1..N: substrate then baseline; aggregate; write artifact); projected-spend print; `--trials` / dry-run handling; CLI entry for `bench:t03`.
- `tests/metrics.test.ts` — distribution math on synthetic per-trial arrays (key-free).
- `tests/score.test.ts` — scorer-equivalence: same logical outcome → identical ten criteria via both paths (BS-Bench-B gate, key-free).
- `tests/baselineAdapter.test.ts` — post-edit files → `Map` on a synthetic temp tree (key-free).
- `tests/retry.test.ts` — symmetric retry rule on synthetic substrate logs + synthetic baseline event lists (key-free).
- `tests/substrateConfig.test.ts` — metric extraction from a synthetic `AgentT03Result` (key-free).
- `tests/report.test.ts` — report formatter on synthetic per-trial metrics (key-free).
- `results/.gitkeep` — keeps the artifact dir; round artifacts are gitignored.

**Documentation:**
- `.gitignore` — **modified** (Task 1): ignore `packages/bench/results/*` except `.gitkeep`.
- `decisions.md` — appended per-task (D1–D5).
- `CLAUDE.md` § "Tooling commands" — appended in Task 9 with the `bench:t03` command.

---

## Task 0: Behavior-preserving `evaluateT03TextCriteria` extraction in `@strata/verify`

De-risk the crux before any bench code. The substrate path and the baseline path must score the nine text criteria through *identical* logic. This is a pure refactor: `evaluateT03Criteria`'s signature, behavior, and every existing call site stay green unchanged.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/verify/src/t03Criteria.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/verify/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/verify/tests/t03TextCriteria.test.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Confirm Phase 3 is green from a clean state**

Run from `/Users/toddhebebrand/Strata`:
```bash
pnpm -r build && pnpm -r test
```
Expected: every package builds (`tsc -b`) and tests pass, including `packages/cli/tests/t03.test.ts`, `packages/verify/tests/*`, and `packages/agent/tests/replay.test.ts`. If anything fails, stop — this plan extends a green Phase 3, it does not repair it.

- [ ] **Step 2: Write the failing text-criteria test**

Create `/Users/toddhebebrand/Strata/packages/verify/tests/t03TextCriteria.test.ts`. This pins the nine text criteria as a pure function of a `Map<modulePath,text>`, independent of `db`:
```ts
import { describe, expect, it } from "vitest";
import { evaluateT03TextCriteria } from "../src/index";

/**
 * A fully-correct post-rename module set (User -> Account everywhere it is a
 * type; the audit.ts "User" string literal untouched). Keys are POSIX paths
 * relative to the corpus src/ root, exactly as both adapters key them.
 */
function correctModules(): Map<string, string> {
  return new Map<string, string>([
    [
      "users/greet.ts",
      'import type { Account } from "../types/user.ts";\n' +
        "/** @param {Account} user */\n" +
        "export function greet(user: Account): string {\n" +
        "  return `hi ${user.name}`;\n}\n"
    ],
    [
      "users/legacy.ts",
      "/** @param {Account} u */\nexport function legacy(u: Account): void {}\n"
    ],
    [
      "users/list.ts",
      "import type { Account } from \"../types/user.ts\";\n" +
        "export function list(): Promise<Account[]> { return Promise.resolve([]); }\n"
    ],
    [
      "users/serializer.ts",
      'import type * as UserTypes from "../types/user.ts";\n' +
        "export function ser(user: UserTypes.Account): string { return user.name; }\n"
    ],
    [
      "users/repo.ts",
      "import type { Account } from \"../types/user.ts\";\n" +
        "export interface Repo { save(user: Account): Promise<void>; }\n"
    ],
    [
      "types/user.ts",
      "export interface Account { name: string; }\n"
    ],
    [
      "server/audit.ts",
      'export function audit(kind: "User"): void { console.log("User", kind); }\n'
    ],
    [
      "index.ts",
      'export type { Account } from "./types/user.ts";\n'
    ]
  ]);
}

describe("evaluateT03TextCriteria", () => {
  it("returns all nine text criteria true for a fully-correct rename", () => {
    const c = evaluateT03TextCriteria(correctModules());
    for (const [key, value] of Object.entries(c)) {
      expect(value, `criterion ${key}`).toBe(true);
    }
  });

  it("fails when the audit literal was clobbered to Account", () => {
    const m = correctModules();
    m.set(
      "server/audit.ts",
      'export function audit(kind: "Account"): void { console.log("Account", kind); }\n'
    );
    const c = evaluateT03TextCriteria(m);
    // The "User" literal must survive; clobbering it must fail these two.
    expect(c.auditLiteralUntouched).toBe(false);
    expect(c.auditLiteralOnlyRemainingUser).toBe(false);
  });

  it("fails when a type position was left as User (half-rename)", () => {
    const m = correctModules();
    m.set(
      "users/list.ts",
      "import type { User } from \"../types/user.ts\";\n" +
        "export function list(): Promise<User[]> { return Promise.resolve([]); }\n"
    );
    const c = evaluateT03TextCriteria(m);
    expect(c.genericPromiseRenamed).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @strata/verify test -- t03TextCriteria`
Expected: FAIL with "evaluateT03TextCriteria is not exported" / `TypeError: not a function`.

- [ ] **Step 4: Extract the pure core, behavior-preservingly**

Modify `/Users/toddhebebrand/Strata/packages/verify/src/t03Criteria.ts`. Add the `T03TextCriteria` type (the nine text-derived keys), add `evaluateT03TextCriteria(modules: Map<string,string>)` containing the **verbatim** `mustGet`/regex/`\bUser\b`-counting block lifted from `evaluateT03Criteria` (no regex rewritten), and have `evaluateT03Criteria` build the `Map` from `db`/`batch` exactly as today, then delegate. Replace the file body with:

```ts
import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

export interface T03Criteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
  importRenamed: boolean;
  typeAnnotationRenamed: boolean;
  genericPromiseRenamed: boolean;
  namespaceImportRenamed: boolean;
  auditLiteralUntouched: boolean;
  auditLiteralOnlyRemainingUser: boolean;
  indexReExportRenamed: boolean;
  jsdocReferencesRenamed: boolean;
  operationRowAppended: boolean;
}

/**
 * The nine text-derived T03 criteria — a PURE function of the final
 * TypeScript text of each module, keyed by POSIX path relative to the
 * corpus src/ root. Both Phase 4 configs feed this identical function:
 * the substrate renders committed store modules to text; the baseline
 * reads post-edit .ts files off its temp working tree. The scorer cannot
 * tell which produced the text. This is the single source of scoring
 * truth that makes the substrate/baseline comparison valid (spec
 * § "Scorer equivalence"). Regexes are verbatim from the original
 * evaluateT03Criteria — none rewritten.
 */
export type T03TextCriteria = Pick<
  T03Criteria,
  | "importRenamed"
  | "typeAnnotationRenamed"
  | "genericPromiseRenamed"
  | "namespaceImportRenamed"
  | "auditLiteralUntouched"
  | "auditLiteralOnlyRemainingUser"
  | "indexReExportRenamed"
  | "jsdocReferencesRenamed"
>;

export function evaluateT03TextCriteria(
  modules: Map<string, string>
): T03TextCriteria {
  const auditText = mustGet(modules, "server/audit.ts");
  const indexText = mustGet(modules, "index.ts");
  const greetText = mustGet(modules, "users/greet.ts");
  const legacyText = mustGet(modules, "users/legacy.ts");
  const listText = mustGet(modules, "users/list.ts");
  const serializerText = mustGet(modules, "users/serializer.ts");
  const repoText = mustGet(modules, "users/repo.ts");
  const userText = mustGet(modules, "types/user.ts");

  const remainingUserOccurrences = [...modules.values()]
    .flatMap((text) => text.match(/\bUser\b/g) ?? [])
    .length;
  const auditUserOccurrences = (auditText.match(/\bUser\b/g) ?? []).length;

  return {
    importRenamed:
      /import type \{\s*Account\s*\} from "\.\.\/types\/user\.ts";/.test(
        greetText
      ),
    typeAnnotationRenamed:
      /export function greet\(user: Account\): string/.test(greetText) &&
      /export interface Account\b/.test(userText) &&
      /save\(user: Account\): Promise<void>;/.test(repoText),
    genericPromiseRenamed:
      /Promise<Account\[\]>/.test(listText) &&
      !/Promise<User\[\]>/.test(listText),
    namespaceImportRenamed:
      /import type \* as UserTypes from "\.\.\/types\/user\.ts";/.test(
        serializerText
      ) && /user: UserTypes\.Account/.test(serializerText),
    auditLiteralUntouched:
      /"User"/.test(auditText) && /kind: "User"/.test(auditText),
    auditLiteralOnlyRemainingUser:
      remainingUserOccurrences === auditUserOccurrences &&
      auditUserOccurrences > 0,
    indexReExportRenamed:
      /export type \{\s*Account\s*\} from "\.\/types\/user\.ts";/.test(
        indexText
      ) &&
      !/export type \{\s*User\s*\} from "\.\/types\/user\.ts";/.test(
        indexText
      ),
    jsdocReferencesRenamed:
      /@param \{Account\} user/.test(greetText) &&
      /@param \{Account\} u/.test(legacyText) &&
      !/@param \{User\}/.test(greetText) &&
      !/@param \{User\}/.test(legacyText)
  };
}

export interface T03CriteriaInput {
  /** Result of the agent/programmatic commit: did commit return ok? */
  commitReturnedOk: boolean;
  /** Result of a post-commit re-validate on a throwaway tx: zero diagnostics? */
  validateAfterCommitClean: boolean;
  /** The tx id whose single operation row must be the RenameSymbol row. */
  renameTxId: string;
}

export interface T03Batch {
  modules: { path: string; moduleId: string }[];
}

interface OperationRow {
  tx_id: string;
  kind: string;
  params_json: string;
  affected_node_ids_json: string;
}

/**
 * Substrate post-commit scoring for T03. Builds the rendered-text Map from
 * committed store state (unchanged from the original), delegates the nine
 * text criteria to evaluateT03TextCriteria, and adds the two
 * substrate-driven fields plus the substrate-only operationRowAppended.
 * Signature and behavior unchanged — existing callers (cli runT03,
 * agent runAgentT03) stay green.
 */
export function evaluateT03Criteria(
  db: Db,
  batch: T03Batch,
  srcRoot: string,
  input: T03CriteriaInput
): T03Criteria {
  const renderedBySuffix = new Map<string, string>();
  for (const module of batch.modules) {
    renderedBySuffix.set(
      toPosix(path.relative(srcRoot, module.path)),
      renderModule(db, module.moduleId)
    );
  }

  const text = evaluateT03TextCriteria(renderedBySuffix);

  const operations = db
    .prepare(
      `SELECT tx_id, kind, params_json, affected_node_ids_json
         FROM operations`
    )
    .all() as OperationRow[];

  return {
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true,
    ...text,
    operationRowAppended: operationLogged(operations, input.renameTxId)
  };
}

export function emptyT03Criteria(): T03Criteria {
  return {
    commitReturnedOk: false,
    validateAfterCommitClean: false,
    importRenamed: false,
    typeAnnotationRenamed: false,
    genericPromiseRenamed: false,
    namespaceImportRenamed: false,
    auditLiteralUntouched: false,
    auditLiteralOnlyRemainingUser: false,
    indexReExportRenamed: false,
    jsdocReferencesRenamed: false,
    operationRowAppended: false
  };
}

function renderModule(db: Db, moduleId: string): string {
  const loaded = loadModule(db, moduleId);
  return renderWithSourceMap(loaded.module, loaded.children).text;
}

function operationLogged(operations: OperationRow[], txId: string): boolean {
  if (operations.length !== 1) {
    return false;
  }

  const operation = operations[0]!;
  if (operation.tx_id !== txId || operation.kind !== "RenameSymbol") {
    return false;
  }

  const params = JSON.parse(operation.params_json) as {
    old_name?: string;
    new_name?: string;
  };
  const affected = JSON.parse(operation.affected_node_ids_json) as unknown[];
  return (
    params.old_name === "User" &&
    params.new_name === "Account" &&
    affected.length > 1
  );
}

function mustGet(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing rendered module: ${key}`);
  }
  return value;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
```

Behavior-preservation note (load-bearing): the spread `...text` followed by `operationRowAppended` reproduces the original return object field-for-field; `commitReturnedOk`/`validateAfterCommitClean` keep their `=== true` coercion; `\bUser\b` counting moved verbatim into the core (it operates over the same `renderedBySuffix` map values). No regex or `mustGet` key changed. The original `T03Batch`/`T03CriteriaInput` exports are retained for `cli`/`agent`.

- [ ] **Step 5: Re-export the core from the verify barrel**

Modify `/Users/toddhebebrand/Strata/packages/verify/src/index.ts`:
```ts
export { commit, validate, type CommitResult, type Diagnostic } from "./validate";
export {
  emptyT03Criteria,
  evaluateT03Criteria,
  evaluateT03TextCriteria,
  type T03Criteria,
  type T03CriteriaInput,
  type T03TextCriteria
} from "./t03Criteria";
```

- [ ] **Step 6: Run the new test and every existing call site's tests**

Run:
```bash
pnpm --filter @strata/verify test
pnpm --filter @strata/cli test -- t03
pnpm --filter @strata/agent test -- replay
```
Expected: PASS — new `t03TextCriteria.test.ts` green; the unchanged `cli` `t03.test.ts` and `agent` `replay.test.ts` (both call `evaluateT03Criteria`) still green with no edits to those tests.

- [ ] **Step 7: Full build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: every package builds (`tsc -b`) and all tests pass. (Vitest does not typecheck — the build must be independently green; `T03TextCriteria` as a `Pick<...>` must compile.)

- [ ] **Step 8: Append decision D1 to `decisions.md`**

Add at the top of the newest-first list (below the `<!-- New entries -->` marker line):
```markdown
## 2026-05-15 — T03 text-criteria core extracted (evaluateT03TextCriteria) in @strata/verify (D1)

**Context:** Phase 4 needs the substrate and the file-based baseline to score the nine text-derived T03 criteria through identical logic, or the comparison is invalid (BS-Bench-B). The nine criteria were inlined inside `evaluateT03Criteria`, coupled to `db`/`batch`.

**Considered:** (a) duplicate the regexes in the bench baseline adapter; (b) extract a pure `Map<modulePath,text>`-taking core in `@strata/verify` that `evaluateT03Criteria` delegates to and the baseline adapter also calls; (c) move the scorer into the new `@strata/bench`.

**Decided:** (b). `packages/verify/src/t03Criteria.ts` now exports `evaluateT03TextCriteria(modules)` (the nine text criteria, regexes verbatim) and `T03TextCriteria`. `evaluateT03Criteria` keeps its signature, builds the rendered-text Map from `db`/`batch` exactly as before, delegates the nine, and adds `commitReturnedOk`/`validateAfterCommitClean`/`operationRowAppended` unchanged.

**Why:** A single pure core called by both adapters makes "T03 succeeded" mean exactly the same thing for substrate and baseline. (c) was rejected: it would cycle (`verify` needs the core; `agent`→`verify`; `bench`→`agent`/`verify`). The core MUST stay in `@strata/verify` — moving it to `bench` later would reintroduce the cycle; do not "tidy" it there.

**Design-doc impact:** none — refactor only; `evaluateT03Criteria` signature/behavior unchanged, `cli` `t03.test.ts` and `agent` `replay.test.ts` green unchanged.

**Revisit when:** T03 grows criteria, or a fourth caller needs the core.
```

- [ ] **Operator commit boundary**

Implementer: ensure `pnpm -r build && pnpm -r test` is green, then stop. Operator commits:
```
git add packages/verify/src/t03Criteria.ts packages/verify/src/index.ts packages/verify/tests/t03TextCriteria.test.ts decisions.md
git commit -m "refactor(verify): extract pure evaluateT03TextCriteria core (Phase 4 D1)"
```

---

## Task 1: Scaffold `packages/bench`

Create the package skeleton mirroring `@strata/agent`/`@strata/verify`. No logic yet — a buildable, testable empty package on the workspace, plus the gitignore for round artifacts.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/package.json`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tsconfig.json`
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/results/.gitkeep`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/scaffold.test.ts`
- Modify: `/Users/toddhebebrand/Strata/.gitignore`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write `package.json`**

Create `/Users/toddhebebrand/Strata/packages/bench/package.json`:
```json
{
  "name": "@strata/bench",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "bench:t03": "node dist/runner.js"
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

Rationale (deps): `@strata/agent` for `runAgentT03`/`T03_PROMPT`/`AgentT03Result`/`SessionLog`/`TerminalReason`; `@strata/verify` for `evaluateT03TextCriteria`/`T03TextCriteria`; `@strata/ingest`+`@strata/store`+`@strata/render` because the substrate `resultQuality` path renders committed store modules to a scratch dir (same render+store surface `@strata/verify` uses). `@anthropic-ai/claude-agent-sdk`+`zod` are direct deps because the baseline config runs the SDK directly. **No `@strata/cli`** — the scorer core lives in `@strata/verify` precisely so `bench` reaches it without a `cli` edge (acyclic: `bench → agent → … → verify`; `bench → verify`).

- [ ] **Step 2: OPERATOR — install dependencies (one time)**

This is the only `pnpm install`. Implementer must NOT run this. Operator runs from `/Users/toddhebebrand/Strata`:
```bash
pnpm install
```
Expected: `@strata/bench` linked into the workspace; `pnpm-lock.yaml` updated. After this completes, the implementer continues at Step 3.

- [ ] **Step 3: Write `tsconfig.json`**

Create `/Users/toddhebebrand/Strata/packages/bench/tsconfig.json`:
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

Note: every package actually imported is listed in `references` so project-references `tsc -b` builds them first (the Phase 3 "build first; vitest does not typecheck" trap applies here too). `agent` is referenced because the substrate config imports `runAgentT03`; `render`/`store` because the substrate `resultQuality` renders committed modules to a scratch dir.

- [ ] **Step 4: Write the placeholder barrel**

Create `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`:
```ts
/**
 * @strata/bench — the Phase 4 T03 benchmark harness: substrate
 * (runAgentT03) vs. file-based baseline, N trials each, scored through
 * one provably-equivalent text-criteria core, reported as distributions.
 *
 * Real exports (metrics, score, configs, runner, report) land in later
 * tasks. The live round is the operator-only `bench:t03` script, never a
 * vitest test.
 */
export const BENCH_PACKAGE = "@strata/bench" as const;
```

- [ ] **Step 5: Create the artifact dir keeper**

Create `/Users/toddhebebrand/Strata/packages/bench/results/.gitkeep` with a single comment line:
```
# Benchmark round artifacts (JSON + Markdown) are written here. Gitignored except this file.
```

- [ ] **Step 6: Gitignore round artifacts**

Add to `/Users/toddhebebrand/Strata/.gitignore` (append at end):
```
# Phase 4 benchmark round artifacts (operator-run; not committed)
packages/bench/results/*
!packages/bench/results/.gitkeep
```

- [ ] **Step 7: Write the scaffold test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/scaffold.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { BENCH_PACKAGE } from "../src/index";

describe("@strata/bench scaffold", () => {
  it("exports the package marker", () => {
    expect(BENCH_PACKAGE).toBe("@strata/bench");
  });
});
```

- [ ] **Step 8: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: `@strata/bench` builds via `tsc -b` (its `dist/` appears) and its scaffold test passes; all other packages stay green.

- [ ] **Step 9: Append decision D2 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — @strata/bench created; T03 scorer core stays in @strata/verify (D2)

**Context:** Phase 4's harness needs a package. `strata-design.md` § "Project layout" reserves `packages/bench`. The shared scorer core (D1) could nominally live in `bench`.

**Considered:** (a) put `evaluateT03TextCriteria` in `bench`; (b) keep it in `@strata/verify` and have `bench` import it from the verify barrel.

**Decided:** (b). `packages/bench` (`@strata/bench`) depends on `@strata/agent`/`@strata/verify`/`@strata/ingest`/`@strata/render`/`@strata/store` + the SDK + zod, NOT `@strata/cli`. The scorer core stays in `@strata/verify`.

**Why:** (a) cycles: `verify`'s own `evaluateT03Criteria` needs the core, and `agent`→`verify`, `bench`→`agent`/`verify`. Keeping it in `verify` keeps the graph acyclic (`bench → agent → … → verify`; `bench → verify`) and lets `bench` reach the core via the barrel with no `cli` edge and no deep `dist/` import. The scorer core must NOT be relocated to `bench` later.

**Design-doc impact:** none — additive package on the reserved `packages/bench` slot.

**Revisit when:** a non-T03 benchmark task is added (the harness generalizes; the T03 scorer does not move).
```

- [ ] **Operator commit boundary**

Implementer: ensure `pnpm -r build && pnpm -r test` green, then stop. Operator commits:
```
git add packages/bench/package.json packages/bench/tsconfig.json packages/bench/src/index.ts packages/bench/results/.gitkeep packages/bench/tests/scaffold.test.ts .gitignore decisions.md pnpm-lock.yaml
git commit -m "feat(bench): scaffold @strata/bench package (Phase 4 D2)"
```

---

## Task 2: Metrics schema + distribution statistics

The `Metrics`/`TrialMetrics` schema (spec § "Metrics & statistics") and the distribution math (N, min, max, median, mean, p25, p75, stddev, raw values — never a bare mean). Pure, model-free, fully unit-testable.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/metrics.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/metrics.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`

- [ ] **Step 1: Write the failing metrics test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/metrics.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { distribution, type Distribution } from "../src/metrics";

describe("distribution", () => {
  it("computes N/min/max/median/mean/p25/p75/stddev and keeps raw values", () => {
    const d: Distribution = distribution([10, 2, 8, 4, 6]);
    expect(d.n).toBe(5);
    expect(d.min).toBe(2);
    expect(d.max).toBe(10);
    expect(d.median).toBe(6);
    expect(d.mean).toBe(6);
    expect(d.values).toEqual([10, 2, 8, 4, 6]); // raw, insertion order preserved
    // population stddev of [2,4,6,8,10] = sqrt(8) ≈ 2.8284
    expect(d.stddev).toBeCloseTo(2.8284, 3);
    expect(d.p25).toBe(4);
    expect(d.p75).toBe(8);
  });

  it("handles a single value without NaN", () => {
    const d = distribution([7]);
    expect(d).toMatchObject({
      n: 1,
      min: 7,
      max: 7,
      median: 7,
      mean: 7,
      p25: 7,
      p75: 7,
      stddev: 0
    });
    expect(d.values).toEqual([7]);
  });

  it("returns an explicit empty distribution for no values (never NaN)", () => {
    const d = distribution([]);
    expect(d.n).toBe(0);
    expect(d.values).toEqual([]);
    expect(d.mean).toBeNull();
    expect(d.median).toBeNull();
    expect(d.min).toBeNull();
    expect(d.max).toBeNull();
    expect(d.p25).toBeNull();
    expect(d.p75).toBeNull();
    expect(d.stddev).toBeNull();
  });

  it("computes an even-length median as the mean of the two middles", () => {
    const d = distribution([1, 2, 3, 4]);
    expect(d.median).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- metrics`
Expected: FAIL with "Cannot find module '../src/metrics'".

- [ ] **Step 3: Implement `metrics.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/metrics.ts`:
```ts
export type ConfigName = "substrate" | "baseline";

export type TerminalReason =
  | "success"
  | "error_max_turns"
  | "error_wall_time"
  | "error_during_execution"
  | "error_other";

/** One trial's measurements, matching spec § "Metrics & statistics". */
export interface TrialMetrics {
  config: ConfigName;
  trial: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  wallTimeMs: number;
  /** Harness Date.now() bracket, cross-check of SDK duration_ms. */
  harnessWallTimeMs: number;
  toolInvocations: number;
  failuresRetries: number;
  totalCostUsd: number;
  /** All ten shared criteria pass. */
  success: boolean;
  /** tsc --noEmit clean AND the corpus's own vitest passes. */
  resultQuality: { tscClean: boolean; vitestPassed: boolean };
  terminalReason: TerminalReason;
  /** Substrate-only sub-metric; null for baseline (spec fairness decision). */
  operationRowAppended: boolean | null;
}

/**
 * A numeric metric's distribution across trials. NEVER reduced to a bare
 * mean (spec § "Distributions, not means"); the raw per-trial values are
 * always carried. Empty input yields nulls, never NaN.
 */
export interface Distribution {
  n: number;
  min: number | null;
  max: number | null;
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  stddev: number | null;
  /** Raw per-trial values in insertion order. */
  values: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function distribution(values: number[]): Distribution {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0,
      min: null,
      max: null,
      median: null,
      mean: null,
      p25: null,
      p75: null,
      stddev: null,
      values: []
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  return {
    n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    median: percentile(sorted, 0.5),
    mean,
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    stddev: Math.sqrt(variance),
    values: [...values]
  };
}

/** Per-config aggregate across that config's trials. */
export interface ConfigAggregate {
  config: ConfigName;
  trials: number;
  successCount: number;
  successRate: number;
  terminalReasonCounts: Record<string, number>;
  totalTokens: Distribution;
  wallTimeMs: Distribution;
  toolInvocations: Distribution;
  failuresRetries: Distribution;
  totalCostUsd: Distribution;
  resultQualityTscCleanCount: number;
  resultQualityVitestPassedCount: number;
  /** Substrate only; null when not applicable. */
  operationRowAppendedCount: number | null;
}

export function aggregate(
  config: ConfigName,
  trials: TrialMetrics[]
): ConfigAggregate {
  const terminalReasonCounts: Record<string, number> = {};
  for (const t of trials) {
    terminalReasonCounts[t.terminalReason] =
      (terminalReasonCounts[t.terminalReason] ?? 0) + 1;
  }
  const successCount = trials.filter((t) => t.success).length;
  const opRows = trials
    .map((t) => t.operationRowAppended)
    .filter((v): v is boolean => v !== null);
  return {
    config,
    trials: trials.length,
    successCount,
    successRate: trials.length === 0 ? 0 : successCount / trials.length,
    terminalReasonCounts,
    totalTokens: distribution(trials.map((t) => t.totalTokens)),
    wallTimeMs: distribution(trials.map((t) => t.wallTimeMs)),
    toolInvocations: distribution(trials.map((t) => t.toolInvocations)),
    failuresRetries: distribution(trials.map((t) => t.failuresRetries)),
    totalCostUsd: distribution(trials.map((t) => t.totalCostUsd)),
    resultQualityTscCleanCount: trials.filter(
      (t) => t.resultQuality.tscClean
    ).length,
    resultQualityVitestPassedCount: trials.filter(
      (t) => t.resultQuality.vitestPassed
    ).length,
    operationRowAppendedCount:
      opRows.length === 0 ? null : opRows.filter((v) => v).length
  };
}
```

- [ ] **Step 4: Re-export from the barrel**

Replace `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`:
```ts
export const BENCH_PACKAGE = "@strata/bench" as const;
export {
  aggregate,
  distribution,
  type ConfigAggregate,
  type ConfigName,
  type Distribution,
  type TerminalReason,
  type TrialMetrics
} from "./metrics";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- metrics`
Expected: PASS — distribution math correct on all four cases including the empty-input null case (never NaN).

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/metrics.ts packages/bench/src/index.ts packages/bench/tests/metrics.test.ts
git commit -m "feat(bench): Metrics schema + distribution statistics"
```

---

## Task 3: Baseline file-adapter scorer + scorer-equivalence test (BS-Bench-B gate)

The baseline adapter (post-edit `.ts` files off a temp tree → `Map<modulePath,text>` → `evaluateT03TextCriteria`) and the ten-shared-criterion assembler shared by both configs. The equivalence test is the **BS-Bench-B gate**: the same logical outcome scored through both the substrate `evaluateT03Criteria` path and the baseline adapter must yield identical ten criteria. Do not proceed past this task until equivalence holds.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/score.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/score.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`

- [ ] **Step 1: Write the failing scorer-equivalence test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/score.test.ts`. It drives a real programmatic T03 rename to get the substrate's committed-store score, then writes the **rendered** module text (the substrate's own canonical text) to a temp tree and scores it through the baseline adapter; the ten shared criteria must match exactly. Rendering the substrate text to disk and scoring it as "files" is the faithful equivalence check — both paths see the *same canonical text*, proving the comparison is config-portable (spec § "Determinism … Equivalence is proved key-free"):
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  rename_symbol
} from "@strata/store";
import { renderWithSourceMap } from "@strata/render";
import { commit, evaluateT03Criteria } from "@strata/verify";
import { describe, expect, it } from "vitest";
import { scoreSharedCriteria, type SharedCriteria } from "../src/score";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

describe("scorer equivalence (BS-Bench-B gate)", () => {
  it("substrate path and baseline file adapter score the ten shared criteria identically", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");

    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decl = find_declarations(db, {
        name: "User",
        kind: "interface"
      })[0]!;
      const tx = begin(db, "equiv");
      rename_symbol(db, tx, decl.id, "Account");
      const commitResult = commit(db, tx);
      expect(commitResult.ok).toBe(true);

      // Substrate path: full criteria off committed store state.
      const substrateFull = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true,
        renameTxId: tx.id
      });

      // Materialize the SAME canonical text to a temp tree, then score it
      // through the baseline file adapter.
      const tmp = mkdtempSync(path.join(tmpdir(), "strata-equiv-"));
      const tmpSrc = path.join(tmp, "src");
      for (const m of batch.modules) {
        const rel = path
          .relative(srcRoot, m.path)
          .replaceAll("\\", "/");
        const loaded = loadModule(db, m.moduleId);
        const text = renderWithSourceMap(
          loaded.module,
          loaded.children
        ).text;
        const dest = path.join(tmpSrc, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, text);
      }

      const baseline: SharedCriteria = scoreSharedCriteria({
        modules: readModuleMap(tmpSrc),
        // The baseline's commit/validate analog is supplied by the caller
        // (Task 7 fills it from the real run); here we feed the same
        // logical outcome the substrate had.
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true
      });

      // The ten shared criteria, extracted from the substrate's full set.
      const substrate: SharedCriteria = {
        commitReturnedOk: substrateFull.commitReturnedOk,
        validateAfterCommitClean: substrateFull.validateAfterCommitClean,
        importRenamed: substrateFull.importRenamed,
        typeAnnotationRenamed: substrateFull.typeAnnotationRenamed,
        genericPromiseRenamed: substrateFull.genericPromiseRenamed,
        namespaceImportRenamed: substrateFull.namespaceImportRenamed,
        auditLiteralUntouched: substrateFull.auditLiteralUntouched,
        auditLiteralOnlyRemainingUser:
          substrateFull.auditLiteralOnlyRemainingUser,
        indexReExportRenamed: substrateFull.indexReExportRenamed,
        jsdocReferencesRenamed: substrateFull.jsdocReferencesRenamed
      };

      expect(baseline).toEqual(substrate);
      // And a correct rename passes all ten.
      for (const [k, v] of Object.entries(baseline)) {
        expect(v, `shared criterion ${k}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});

// Local mirror of the adapter's directory walk, to assert the production
// readModuleMap is exercised via scoreSharedCriteria above. Kept inline so
// the test does not depend on a second export.
function readModuleMap(srcRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts"))
        map.set(
          path.relative(srcRoot, abs).replaceAll("\\", "/"),
          readFileSync(abs, "utf8")
        );
    }
  }
  walk(srcRoot);
  return map;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- score`
Expected: FAIL with "Cannot find module '../src/score'".

- [ ] **Step 3: Implement `score.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/score.ts`:
```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  evaluateT03TextCriteria,
  type T03TextCriteria
} from "@strata/verify";

/**
 * The TEN shared criteria judged identically for both configs (spec
 * § "Scorer equivalence"): the nine text-derived criteria from
 * evaluateT03TextCriteria plus the symmetric commitReturnedOk /
 * validateAfterCommitClean pair. `success` ⇔ all ten true.
 * `operationRowAppended` is NOT here — it is a substrate-only sub-metric.
 */
export interface SharedCriteria extends T03TextCriteria {
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}

/**
 * Read the post-edit TypeScript text off a working tree's src/ root into
 * a Map keyed by POSIX path relative to that root — the baseline analog of
 * the substrate's "render each committed module to text". The scorer
 * cannot tell which produced the text.
 */
export function readModuleMap(srcRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        map.set(
          path.relative(srcRoot, abs).replaceAll("\\", "/"),
          readFileSync(abs, "utf8")
        );
      }
    }
  }
  walk(srcRoot);
  return map;
}

export interface ScoreInput {
  /** modulePath (POSIX, relative to src/) -> final source text. */
  modules: Map<string, string>;
  /** Baseline analog of "commit returned ok" (spec § symmetric pair). */
  commitReturnedOk: boolean;
  /** Baseline analog of "post-change tsc --noEmit clean". */
  validateAfterCommitClean: boolean;
}

/**
 * Assemble the ten shared criteria from final module text + the symmetric
 * commit/validate pair. Both configs call this with their own Map producer
 * and their own commit/validate analog; the nine text criteria flow through
 * the identical @strata/verify core.
 */
export function scoreSharedCriteria(input: ScoreInput): SharedCriteria {
  const text = evaluateT03TextCriteria(input.modules);
  return {
    ...text,
    commitReturnedOk: input.commitReturnedOk === true,
    validateAfterCommitClean: input.validateAfterCommitClean === true
  };
}

/** All ten shared criteria true. */
export function isSharedSuccess(c: SharedCriteria): boolean {
  return Object.values(c).every((v) => v === true);
}

/**
 * Baseline scoring entry point: read the temp working tree's src/ and the
 * baseline's commit/validate analog, produce the ten shared criteria.
 */
export function scoreBaselineWorkingTree(input: {
  srcRoot: string;
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}): SharedCriteria {
  return scoreSharedCriteria({
    modules: readModuleMap(input.srcRoot),
    commitReturnedOk: input.commitReturnedOk,
    validateAfterCommitClean: input.validateAfterCommitClean
  });
}
```

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  isSharedSuccess,
  readModuleMap,
  scoreBaselineWorkingTree,
  scoreSharedCriteria,
  type ScoreInput,
  type SharedCriteria
} from "./score";
```

- [ ] **Step 5: Run the equivalence test (key-free)**

Run: `pnpm --filter @strata/bench test -- score`
Expected: PASS — the baseline adapter scoring the substrate's rendered text yields the **identical** ten shared criteria as the substrate path, and all ten are true for a correct rename.

**Bail-signal note (BS-Bench-B):** If `baseline` does NOT `toEqual` `substrate` here — e.g. a regex that passes on committed-store-rendered text fails on the same text read back off disk (trailing-newline, encoding, or path-keying divergence) — **STOP and surface BS-Bench-B**. The comparison is invalid until the shared core scores both identically. Reconcile inside the shared path (e.g. normalize the read text the same way render produces it, before scoring — legitimate, since both are then judged on the same canonical form) or log that the T03 scorer is not config-portable and the benchmark needs a different oracle. Do not special-case per config. A wrong equivalence is worse than no number. Do not proceed to Task 4 until this is green.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/score.ts packages/bench/src/index.ts packages/bench/tests/score.test.ts
git commit -m "feat(bench): baseline file-adapter scorer + equivalence test (BS-Bench-B gate)"
```

---

## Task 4: Symmetric retry/failure counter

The retry rule resolving the `benchmarks.md` ambiguity (spec § "The symmetric retry/failure counting rule"): one observed self-correction = a failed verification action followed by at least one further mutating action before the terminal result. Counted per-config from each side's session log. Pure, model-free, unit-testable.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/retry.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/retry.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write the failing retry test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/retry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  countBaselineRetries,
  countSubstrateRetries,
  type BaselineToolEvent,
  type SubstrateToolEvent
} from "../src/retry";

describe("countSubstrateRetries", () => {
  it("counts a failed validate followed by a further mutation as ONE retry", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "find_declarations", ok: true },
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: true }, // failed check
      { tool: "rollback_transaction", ok: true }, // mutating follow-up
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: false },
      { tool: "commit_transaction", ok: true, commitOk: true }
    ];
    // The single failed validate + subsequent rollback/rename = ONE retry,
    // not three (spec Open Question 1 worked example).
    expect(countSubstrateRetries(events)).toBe(1);
  });

  it("counts a commit_transaction ok:false followed by another rename as a retry", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "commit_transaction", ok: true, commitOk: false },
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "commit_transaction", ok: true, commitOk: true }
    ];
    expect(countSubstrateRetries(events)).toBe(1);
  });

  it("does NOT count a failed check with no subsequent mutation", () => {
    const events: SubstrateToolEvent[] = [
      { tool: "begin_transaction", ok: true },
      { tool: "rename_symbol", ok: true },
      { tool: "validate", ok: true, returnedDiagnostics: true }
      // gave up — no further mutation
    ];
    expect(countSubstrateRetries(events)).toBe(0);
  });
});

describe("countBaselineRetries", () => {
  it("counts a non-zero tsc/test Bash run followed by a further edit as one retry", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Read", path: "src/types/user.ts" },
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Bash", command: "pnpm tsc --noEmit", exitCode: 2 }, // failed
      { tool: "Edit", path: "src/users/list.ts" }, // follow-up edit
      { tool: "Bash", command: "pnpm vitest run", exitCode: 0 }
    ];
    expect(countBaselineRetries(events)).toBe(1);
  });

  it("counts a re-edit of an already-edited file (followed by another edit) as a retry", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Edit", path: "src/users/greet.ts" },
      { tool: "Edit", path: "src/types/user.ts" }, // re-edit of touched file
      { tool: "Write", path: "src/index.ts" } // further mutation after
    ];
    expect(countBaselineRetries(events)).toBe(1);
  });

  it("does NOT count a failed tsc with no subsequent edit", () => {
    const events: BaselineToolEvent[] = [
      { tool: "Edit", path: "src/types/user.ts" },
      { tool: "Bash", command: "pnpm tsc --noEmit", exitCode: 1 }
      // gave up
    ];
    expect(countBaselineRetries(events)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- retry`
Expected: FAIL with "Cannot find module '../src/retry'".

- [ ] **Step 3: Implement `retry.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/retry.ts`:
```ts
/**
 * Spec § "The symmetric retry/failure counting rule": one failure/retry =
 * a verification action that returned a negative result AND was followed by
 * at least one further mutating action in the same session, before the
 * terminal result. Unifying definition: "the agent checked its work, the
 * check failed, and it changed the code again." A failed check with no
 * subsequent mutation is NOT a retry (recorded in terminalReason/success
 * instead). Counting rule shipped as specified; validated against the first
 * live round's logs by hand (Open Question 1) and corrected only via a
 * newest-first decisions.md entry, never silently.
 */

export interface SubstrateToolEvent {
  tool: string;
  ok: boolean;
  /** validate returned a non-empty Diagnostic[]. */
  returnedDiagnostics?: boolean;
  /** commit_transaction returned { ok: true|false }. */
  commitOk?: boolean;
}

const SUBSTRATE_MUTATING = new Set([
  "rename_symbol",
  "begin_transaction",
  "rollback_transaction"
]);

export function countSubstrateRetries(
  events: SubstrateToolEvent[]
): number {
  let retries = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const failedCheck =
      (e.tool === "validate" && e.returnedDiagnostics === true) ||
      (e.tool === "commit_transaction" && e.commitOk === false);
    if (!failedCheck) continue;
    const hasFollowingMutation = events
      .slice(i + 1)
      .some((n) => SUBSTRATE_MUTATING.has(n.tool));
    if (hasFollowingMutation) retries++;
  }
  return retries;
}

export interface BaselineToolEvent {
  tool: string;
  /** For Edit/Write/Read. */
  path?: string;
  /** For Bash. */
  command?: string;
  /** For Bash: process exit code. */
  exitCode?: number;
}

const BASELINE_MUTATING = new Set(["Edit", "Write"]);

function isFailedVerification(
  e: BaselineToolEvent,
  editedSoFar: Set<string>
): boolean {
  if (
    e.tool === "Bash" &&
    typeof e.command === "string" &&
    /\b(tsc|vitest|test)\b/.test(e.command) &&
    typeof e.exitCode === "number" &&
    e.exitCode !== 0
  ) {
    return true;
  }
  // Re-edit of an already-touched file is itself a self-correction signal.
  if (
    BASELINE_MUTATING.has(e.tool) &&
    typeof e.path === "string" &&
    editedSoFar.has(e.path)
  ) {
    return true;
  }
  return false;
}

export function countBaselineRetries(
  events: BaselineToolEvent[]
): number {
  let retries = 0;
  const editedSoFar = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const failed = isFailedVerification(e, editedSoFar);
    if (failed) {
      const hasFollowingMutation = events
        .slice(i + 1)
        .some((n) => BASELINE_MUTATING.has(n.tool));
      if (hasFollowingMutation) retries++;
    }
    if (
      BASELINE_MUTATING.has(e.tool) &&
      typeof e.path === "string"
    ) {
      editedSoFar.add(e.path);
    }
  }
  return retries;
}
```

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  countBaselineRetries,
  countSubstrateRetries,
  type BaselineToolEvent,
  type SubstrateToolEvent
} from "./retry";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- retry`
Expected: PASS — the worked example counts as ONE retry; a failed check with no follow-up counts as zero; both configs' rules behave symmetrically.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Step 7: Append decision D3 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — Symmetric T03 retry/failure counting rule shipped as specified (D3, Open Question 1)

**Context:** `docs/benchmarks.md` Open Questions flags that "retry" is undefined for the file baseline, so the metric is meaningless without a concrete rule. The Phase 4 spec proposed a symmetric definition.

**Considered:** count every failed tool call (over-counts a single self-correction as 3); count only explicit substrate commit blocks (no file analog); the spec's "failed verification + subsequent mutation = one self-correction" rule.

**Decided:** Shipped the spec's rule. Substrate retry = a `validate` returning diagnostics OR `commit_transaction` `{ ok:false }`, followed by a further mutating tool call (`rename_symbol`/`begin_transaction`/`rollback_transaction`). Baseline retry = a `tsc`/`vitest`/test Bash run exiting non-zero OR a re-edit of an already-edited file, followed by a further `Edit`/`Write`. A failed check with no subsequent mutation is NOT a retry.

**Why:** Symmetric on each side's native verify/edit primitives, derivable from each config's session log with no extra instrumentation, resilient to differing tool vocabularies. The worked example (one failed validate → rollback → corrected rename) counts as ONE, matching the spec's stated intent.

**Design-doc impact:** none — resolves `benchmarks.md` Open Question; the rule is reported alongside the metric so a reader can audit it.

**Revisit when:** the first live round's logs (operator, Task 9) show mis-classification — a corrected rule is then logged as a NEW newest-first entry, never silently retuned.
```

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/retry.ts packages/bench/src/index.ts packages/bench/tests/retry.test.ts decisions.md
git commit -m "feat(bench): symmetric T03 retry/failure counter (D3)"
```

---

## Task 5: Shared headless `query()` session loop (baseline driver)

A reusable headless `query()` loop with `tool_use`/`tool_use_result` pairing and `SDKResultMessage` capture, factored so the baseline config reuses it. (The Phase 3 `runLiveSession` pairing logic lives **private** inside `@strata/agent`'s `session.ts` — it is not on the barrel — so the substrate side keeps using `runAgentT03` as-is and the baseline gets its own equivalent loop here, mirroring the proven Phase 3 pairing mechanism. This is NOT forking the substrate; it is the baseline's own driver.) Unit-tested against a synthetic message stream with NO model and NO key by injecting a fake async-iterable.

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/session.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/session.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`

- [ ] **Step 1: Write the failing session-pairing test (synthetic stream, no key)**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/session.test.ts`. It feeds a hand-built async generator of SDK-shaped messages into the loop and asserts the captured metrics + tool-event list — proving the file-tool baseline's loop logic is correct WITHOUT a model or key (the riskiest-to-plan part; the strategy is dependency injection of the message stream, not mocking `query()`):
```ts
import { describe, expect, it } from "vitest";
import { collectBaselineSession } from "../src/session";

/** A synthetic SDK message stream: init -> assistant(tool_use) ->
 *  user(tool_result) -> assistant(text) -> result(success). */
async function* fakeStream(): AsyncGenerator<unknown, void> {
  yield {
    type: "system",
    subtype: "init",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    mcp_servers: []
  };
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Edit",
          input: { file_path: "src/types/user.ts" }
        }
      ]
    }
  };
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [] },
    tool_use_result: [
      { type: "tool_result", tool_use_id: "tu_1", is_error: false }
    ]
  };
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }]
    }
  };
  yield {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 2,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5
    },
    modelUsage: {},
    is_error: false
  };
}

describe("collectBaselineSession (synthetic stream, no key)", () => {
  it("captures SDKResult metrics, terminalReason, and the tool-event list", async () => {
    const s = await collectBaselineSession(fakeStream());
    expect(s.terminalReason).toBe("success");
    expect(s.result).toBeDefined();
    expect(s.result?.totalCostUsd).toBe(0.42);
    expect(s.result?.numTurns).toBe(2);
    expect(s.result?.durationMs).toBe(1234);
    expect(s.result?.usage.inputTokens).toBe(100);
    expect(s.result?.usage.outputTokens).toBe(50);
    expect(s.result?.usage.cacheReadInputTokens).toBe(10);
    expect(s.toolEvents).toEqual([
      { tool: "Edit", path: "src/types/user.ts", command: undefined, exitCode: undefined }
    ]);
    expect(s.toolInvocations).toBe(1);
  });

  it("maps error_max_turns terminal subtype", async () => {
    async function* errStream(): AsyncGenerator<unknown, void> {
      yield { type: "result", subtype: "error_max_turns", duration_ms: 1, duration_api_ms: 1, num_turns: 9, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, is_error: true, errors: ["max turns"] };
    }
    const s = await collectBaselineSession(errStream());
    expect(s.terminalReason).toBe("error_max_turns");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- session`
Expected: FAIL with "Cannot find module '../src/session'".

- [ ] **Step 3: Implement `session.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/session.ts`. The driver is injectable: `collectBaselineSession(stream)` consumes any async-iterable of SDK-shaped messages, so the key-free test passes a synthetic generator and the live runner (Task 7) passes the real `query(...)` generator. Parsing mirrors the proven Phase 3 `runLiveSession` pairing (Bash exit code is read from the tool_result content text when present):
```ts
import type { TerminalReason } from "./metrics";

export interface BaselineToolEvent {
  tool: string;
  path: string | undefined;
  command: string | undefined;
  exitCode: number | undefined;
}

export interface BaselineResultCapture {
  subtype: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface BaselineSession {
  terminalReason: TerminalReason;
  result?: BaselineResultCapture;
  toolEvents: BaselineToolEvent[];
  toolInvocations: number;
  initTools: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function num(usage: unknown, key: string): number {
  return isRecord(usage) && typeof usage[key] === "number"
    ? (usage[key] as number)
    : 0;
}

function terminalFromSubtype(subtype: string): TerminalReason {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "error_max_turns";
  if (subtype === "error_during_execution")
    return "error_during_execution";
  return "error_other";
}

/** Extract a Bash exit code from a tool_result's text payload, if present. */
function parseExitCode(result: unknown): number | undefined {
  let text: string | undefined;
  if (isRecord(result)) {
    if (typeof result.content === "string") text = result.content;
    else if (Array.isArray(result.content)) {
      const t = result.content.find(
        (b): b is { type: string; text: string } =>
          isRecord(b) && b.type === "text" && typeof b.text === "string"
      );
      text = t?.text;
    }
  }
  if (text === undefined) return undefined;
  const m = /exit(?:\s*code)?[:=]?\s*(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Drive any async-iterable of SDK-shaped messages to completion, capturing
 * the terminal SDKResult metrics and a flat tool-event list (for the
 * symmetric retry counter). Injectable: the key-free test passes a
 * synthetic generator; the live runner passes query(...). This mirrors the
 * proven Phase 3 runLiveSession pairing (which is private to @strata/agent;
 * the baseline gets its own equivalent here — not a substrate fork).
 */
export async function collectBaselineSession(
  stream: AsyncIterable<unknown>
): Promise<BaselineSession> {
  const session: BaselineSession = {
    terminalReason: "error_other",
    toolEvents: [],
    toolInvocations: 0,
    initTools: []
  };
  const pending = new Map<string, { tool: string; input: unknown }>();

  for await (const message of stream) {
    if (!isRecord(message)) continue;
    const type = message.type;

    if (type === "system" && message.subtype === "init") {
      session.initTools = Array.isArray(message.tools)
        ? (message.tools as string[])
        : [];
    } else if (type === "assistant") {
      const content =
        isRecord(message.message) && Array.isArray(message.message.content)
          ? message.message.content
          : [];
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          pending.set(block.id, { tool: block.name, input: block.input });
        }
      }
    } else if (type === "user") {
      const results: { id: string; result: unknown }[] = [];
      const collect = (v: unknown): void => {
        if (Array.isArray(v)) {
          v.forEach(collect);
          return;
        }
        if (!isRecord(v)) return;
        const id =
          typeof v.tool_use_id === "string" ? v.tool_use_id : undefined;
        if (v.type === "tool_result" && id) {
          results.push({ id, result: v });
          return;
        }
        Object.values(v).forEach(collect);
      };
      collect(message.tool_use_result);
      if (isRecord(message.message))
        collect(message.message.content);
      for (const r of results) {
        const call = pending.get(r.id);
        if (!call) continue;
        pending.delete(r.id);
        const input = isRecord(call.input) ? call.input : {};
        const filePath =
          typeof input.file_path === "string"
            ? input.file_path
            : typeof input.path === "string"
              ? input.path
              : undefined;
        const command =
          typeof input.command === "string" ? input.command : undefined;
        session.toolEvents.push({
          tool: call.tool,
          path: filePath,
          command,
          exitCode:
            call.tool === "Bash" ? parseExitCode(r.result) : undefined
        });
        session.toolInvocations++;
      }
    } else if (type === "result") {
      const subtype =
        typeof message.subtype === "string" ? message.subtype : "error";
      session.terminalReason = terminalFromSubtype(subtype);
      session.result = {
        subtype,
        numTurns:
          typeof message.num_turns === "number" ? message.num_turns : 0,
        durationMs:
          typeof message.duration_ms === "number"
            ? message.duration_ms
            : 0,
        durationApiMs:
          typeof message.duration_api_ms === "number"
            ? message.duration_api_ms
            : 0,
        totalCostUsd:
          typeof message.total_cost_usd === "number"
            ? message.total_cost_usd
            : 0,
        usage: {
          inputTokens: num(message.usage, "input_tokens"),
          outputTokens: num(message.usage, "output_tokens"),
          cacheReadInputTokens: num(
            message.usage,
            "cache_read_input_tokens"
          ),
          cacheCreationInputTokens: num(
            message.usage,
            "cache_creation_input_tokens"
          )
        }
      };
    }
  }
  return session;
}
```

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  collectBaselineSession,
  type BaselineResultCapture,
  type BaselineSession,
  type BaselineToolEvent as BaselineSessionToolEvent
} from "./session";
```

(Aliased on export to avoid colliding with `./retry`'s `BaselineToolEvent`; `retry.ts`'s type is the counting-rule input shape, `session.ts`'s is the captured shape — they are compatible by structure but kept distinct in the barrel.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- session`
Expected: PASS — synthetic stream yields the captured metrics, `terminalReason: "success"`, the single `Edit` tool event, and the `error_max_turns` mapping.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/session.ts packages/bench/src/index.ts packages/bench/tests/session.test.ts
git commit -m "feat(bench): injectable headless query() session loop for baseline"
```

---

## Task 6: Substrate config wrapper (reuse `runAgentT03` as-is)

A thin wrapper over `@strata/agent`'s `runAgentT03` that extracts the trial metrics from its returned `SessionLog` and maps the ten shared criteria (recording `operationRowAppended` as the substrate-only sub-metric). The substrate path is **not modified** — Phase 4 consumes its public barrel surface. Metric extraction is unit-tested against a synthetic `AgentT03Result` (no model, no key).

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/configs/substrate.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/substrateConfig.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`

- [ ] **Step 1: Write the failing metric-extraction test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/substrateConfig.test.ts`. It builds a synthetic `SessionLog` (the public `@strata/agent` `SessionLog` class) and a synthetic `AgentT03Result`, then asserts `extractSubstrateMetrics` derives the right `TrialMetrics`:
```ts
import { SessionLog, type AgentT03Result } from "@strata/agent";
import { describe, expect, it } from "vitest";
import { extractSubstrateMetrics } from "../src/configs/substrate";

function syntheticResult(): AgentT03Result {
  const log = new SessionLog();
  log.append({
    type: "session_start",
    ts: 0,
    model: "claude-sonnet-4-6",
    maxTurns: 25,
    task: "T03",
    actor: "agent-t03"
  });
  log.append({
    type: "tool_call",
    ts: 1,
    tool: "find_declarations",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 2,
    turn: 0
  });
  log.append({
    type: "tool_call",
    ts: 2,
    tool: "begin_transaction",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 1,
    turn: 0
  });
  log.append({
    type: "tool_call",
    ts: 3,
    tool: "rename_symbol",
    args: {},
    result_summary: "",
    ok: true,
    error: null,
    durationMs: 3,
    turn: 1
  });
  log.append({
    type: "tool_call",
    ts: 4,
    tool: "validate",
    args: {},
    result_summary: "[]",
    ok: true,
    error: null,
    durationMs: 5,
    turn: 1
  });
  log.append({
    type: "tool_call",
    ts: 5,
    tool: "commit_transaction",
    args: {},
    result_summary: '{"ok":true}',
    ok: true,
    error: null,
    durationMs: 4,
    turn: 1
  });
  log.append({
    type: "result",
    ts: 6,
    subtype: "success",
    numTurns: 2,
    durationMs: 9000,
    durationApiMs: 8000,
    totalCostUsd: 0.31,
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 100
    },
    modelUsage: {},
    errors: []
  });
  return {
    criteria: {
      commitReturnedOk: true,
      validateAfterCommitClean: true,
      importRenamed: true,
      typeAnnotationRenamed: true,
      genericPromiseRenamed: true,
      namespaceImportRenamed: true,
      auditLiteralUntouched: true,
      auditLiteralOnlyRemainingUser: true,
      indexReExportRenamed: true,
      jsdocReferencesRenamed: true,
      operationRowAppended: true
    },
    terminalReason: "success",
    log,
    transcript: []
  };
}

describe("extractSubstrateMetrics", () => {
  it("derives TrialMetrics from a synthetic AgentT03Result", () => {
    const m = extractSubstrateMetrics({
      trial: 1,
      result: syntheticResult(),
      harnessWallTimeMs: 9100,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(m.config).toBe("substrate");
    expect(m.trial).toBe(1);
    expect(m.totalTokens).toBe(1600); // input + output
    expect(m.inputTokens).toBe(1200);
    expect(m.cacheReadInputTokens).toBe(800);
    expect(m.wallTimeMs).toBe(9000); // SDK duration_ms
    expect(m.harnessWallTimeMs).toBe(9100);
    expect(m.totalCostUsd).toBe(0.31);
    expect(m.toolInvocations).toBe(5);
    expect(m.failuresRetries).toBe(0);
    expect(m.success).toBe(true); // all ten shared criteria
    expect(m.terminalReason).toBe("success");
    expect(m.operationRowAppended).toBe(true); // substrate-only sub-metric
  });

  it("success is false when a shared criterion fails (op row excluded from the bar)", () => {
    const r = syntheticResult();
    r.criteria.jsdocReferencesRenamed = false; // a shared criterion fails
    const m = extractSubstrateMetrics({
      trial: 2,
      result: r,
      harnessWallTimeMs: 1,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(m.success).toBe(false);

    const r2 = syntheticResult();
    r2.criteria.operationRowAppended = false; // substrate-only; NOT in bar
    const m2 = extractSubstrateMetrics({
      trial: 3,
      result: r2,
      harnessWallTimeMs: 1,
      resultQuality: { tscClean: true, vitestPassed: true }
    });
    expect(m2.success).toBe(true); // op row excluded from shared success
    expect(m2.operationRowAppended).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- substrateConfig`
Expected: FAIL with "Cannot find module '../src/configs/substrate'".

- [ ] **Step 3: Implement `configs/substrate.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/configs/substrate.ts`:
```ts
import {
  runAgentT03,
  type AgentT03Result,
  type SessionLogEvent
} from "@strata/agent";
import { countSubstrateRetries } from "../retry";
import type { TrialMetrics } from "../metrics";

/** The ten shared criteria (op row excluded — spec fairness decision). */
const SHARED_KEYS = [
  "commitReturnedOk",
  "validateAfterCommitClean",
  "importRenamed",
  "typeAnnotationRenamed",
  "genericPromiseRenamed",
  "namespaceImportRenamed",
  "auditLiteralUntouched",
  "auditLiteralOnlyRemainingUser",
  "indexReExportRenamed",
  "jsdocReferencesRenamed"
] as const;

function findResultEvent(
  events: readonly SessionLogEvent[]
): Extract<SessionLogEvent, { type: "result" }> | undefined {
  return events.find(
    (e): e is Extract<SessionLogEvent, { type: "result" }> =>
      e.type === "result"
  );
}

export interface ExtractSubstrateInput {
  trial: number;
  result: AgentT03Result;
  harnessWallTimeMs: number;
  resultQuality: { tscClean: boolean; vitestPassed: boolean };
}

/**
 * Pure: derive TrialMetrics from a (real or synthetic) AgentT03Result.
 * Tested key-free. The substrate path is NOT modified — this only reads
 * its public log + criteria.
 */
export function extractSubstrateMetrics(
  input: ExtractSubstrateInput
): TrialMetrics {
  const { result } = input;
  const resultEvent = findResultEvent(result.log.events);
  const usage = resultEvent?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  const toolCalls = result.log.events.filter(
    (e) => e.type === "tool_call"
  );
  const retryEvents = toolCalls.map((e) => {
    const tc = e as Extract<SessionLogEvent, { type: "tool_call" }>;
    return {
      tool: tc.tool,
      ok: tc.ok,
      returnedDiagnostics:
        tc.tool === "validate" && tc.result_summary !== "[]",
      commitOk:
        tc.tool === "commit_transaction"
          ? tc.result_summary.includes('"ok":true')
          : undefined
    };
  });

  const success = SHARED_KEYS.every(
    (k) => result.criteria[k] === true
  );

  return {
    config: "substrate",
    trial: input.trial,
    totalTokens: usage.inputTokens + usage.outputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    wallTimeMs: resultEvent?.durationMs ?? 0,
    harnessWallTimeMs: input.harnessWallTimeMs,
    toolInvocations: toolCalls.length,
    failuresRetries: countSubstrateRetries(retryEvents),
    totalCostUsd: resultEvent?.totalCostUsd ?? 0,
    success,
    resultQuality: input.resultQuality,
    terminalReason:
      result.terminalReason === "replay_complete"
        ? "error_other"
        : result.terminalReason,
    operationRowAppended: result.criteria.operationRowAppended
  };
}

export interface RunSubstrateTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  logPath?: string;
  /** Inject the resultQuality probe so the live tsc/vitest call is testable. */
  resultQuality?: (
    result: AgentT03Result
  ) => Promise<{ tscClean: boolean; vitestPassed: boolean }>;
}

/**
 * One live substrate trial: call runAgentT03 (NOT replay), measure the
 * harness wall bracket, run the resultQuality probe, extract metrics. The
 * default resultQuality renders committed modules to a scratch dir and
 * runs tsc+vitest there; injectable so the runner test never makes a
 * model call.
 */
export async function runSubstrateTrial(
  params: RunSubstrateTrialParams
): Promise<TrialMetrics> {
  const startedAt = Date.now();
  const result = await runAgentT03({
    corpusRoot: params.corpusRoot,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    logPath: params.logPath
  });
  const harnessWallTimeMs = Date.now() - startedAt;
  const resultQuality = params.resultQuality
    ? await params.resultQuality(result)
    : { tscClean: false, vitestPassed: false };
  return extractSubstrateMetrics({
    trial: params.trial,
    result,
    harnessWallTimeMs,
    resultQuality
  });
}
```

Implementer note (resultQuality default): the spec wants the substrate's `resultQuality` to render every committed module to a temp dir and run `tsc --noEmit` + `pnpm vitest run` there. That render-to-temp + child-process step is non-deterministic-environment-sensitive and is wired in the runner (Task 8) as the default `resultQuality` callback, where it is exercised only by the operator's live round; the unit test injects a stub. Keep `runSubstrateTrial`'s default conservative (`false`/`false`) so a missing injection never reports a false pass.

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  extractSubstrateMetrics,
  runSubstrateTrial,
  type ExtractSubstrateInput,
  type RunSubstrateTrialParams
} from "./configs/substrate";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- substrateConfig`
Expected: PASS — metrics derived correctly; `success` uses only the ten shared criteria; `operationRowAppended` recorded but excluded from the success bar.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green. (`tsc -b` must compile the `@strata/agent` barrel imports and the `SessionLogEvent` discriminated-union narrowing.)

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/configs/substrate.ts packages/bench/src/index.ts packages/bench/tests/substrateConfig.test.ts
git commit -m "feat(bench): substrate config wrapper over runAgentT03"
```

---

## Task 7: Baseline config (file-tools SDK agent on a temp checkout) + temp-tree materialization

The file-based baseline: materialize a fresh recursive copy of `examples/medium` in an OS temp dir, run a headless file-tool `query()` with the verbatim `T03_PROMPT`, score via the baseline adapter, run `resultQuality` in the working tree. The temp-tree materialization + post-edit `Map` read is unit-tested on a synthetic tree (key-free); the live `query()` path is exercised only by the operator's round (Task 9). The SDK options block is pinned against the installed `sdk.d.ts` (mirroring how Phase 3 grounded SDK options).

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/configs/baseline.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/baselineAdapter.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Confirm the SDK option surface against the installed types**

Read the installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and confirm: `Options.tools` is `string[] | { type: 'preset'; preset: 'claude_code' }`; `Options.systemPrompt` accepts `{ type: 'preset'; preset: 'claude_code' }`; `Options.cwd`, `Options.maxTurns`, `Options.abortController`, `Options.model`, `Options.permissionMode`, `Options.allowDangerouslySkipPermissions` exist. (These were verified during planning: `tools` line ~1196, `systemPrompt` preset line ~1693, `cwd` line ~126, result-message shape `SDKResultSuccess` line ~3053.) The baseline uses the **explicit allow-list** `['Read','Write','Edit','Glob','Grep','Bash']` for `tools` (deterministic, audit-able tool surface — preferred over `{type:'preset',preset:'claude_code'}` whose membership is SDK-version-defined) and the **preset** `{ type: 'preset', preset: 'claude_code' }` for `systemPrompt` (the baseline *should* get Claude Code's real file-centric instructions — that is what "the Claude Code baseline" means; it must NOT get the Strata worldview prompt). Record the chosen expressions in the D4 decision (Step 7).

- [ ] **Step 2: Write the failing temp-tree + adapter test (synthetic, key-free)**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/baselineAdapter.test.ts`:
```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeCorpus,
  scoreBaselineTrial
} from "../src/configs/baseline";

describe("materializeCorpus", () => {
  it("recursively copies a synthetic corpus into a fresh temp tree", () => {
    const src = mkdtempSync(path.join(tmpdir(), "strata-src-"));
    mkdirSync(path.join(src, "src", "types"), { recursive: true });
    writeFileSync(
      path.join(src, "src", "types", "user.ts"),
      "export interface User {}\n"
    );
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "x", private: true })
    );

    const { root, srcRoot } = materializeCorpus(src);
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
    expect(
      readFileSync(path.join(srcRoot, "types", "user.ts"), "utf8")
    ).toContain("interface User");
    // It is a copy, not the original.
    expect(root).not.toBe(src);
  });
});

describe("scoreBaselineTrial", () => {
  it("reads post-edit files off the temp tree and scores the ten shared criteria", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "strata-bl-"));
    const srcRoot = path.join(tmp, "src");
    const write = (rel: string, text: string) => {
      const dest = path.join(srcRoot, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    };
    write("users/greet.ts", 'import type { Account } from "../types/user.ts";\n/** @param {Account} user */\nexport function greet(user: Account): string { return `${user.name}`; }\n');
    write("users/legacy.ts", "/** @param {Account} u */\nexport function legacy(u: Account): void {}\n");
    write("users/list.ts", 'import type { Account } from "../types/user.ts";\nexport function list(): Promise<Account[]> { return Promise.resolve([]); }\n');
    write("users/serializer.ts", 'import type * as UserTypes from "../types/user.ts";\nexport function s(user: UserTypes.Account): string { return user.name; }\n');
    write("users/repo.ts", 'import type { Account } from "../types/user.ts";\nexport interface Repo { save(user: Account): Promise<void>; }\n');
    write("types/user.ts", "export interface Account { name: string; }\n");
    write("server/audit.ts", 'export function audit(kind: "User"): void { console.log("User", kind); }\n');
    write("index.ts", 'export type { Account } from "./types/user.ts";\n');

    const c = scoreBaselineTrial({
      srcRoot,
      commitReturnedOk: true,
      validateAfterCommitClean: true
    });
    for (const [k, v] of Object.entries(c)) {
      expect(v, `shared criterion ${k}`).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Implement `configs/baseline.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/configs/baseline.ts`:
```ts
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { T03_PROMPT } from "@strata/agent";
import { collectBaselineSession } from "../session";
import { countBaselineRetries } from "../retry";
import {
  scoreBaselineWorkingTree,
  isSharedSuccess,
  type SharedCriteria
} from "../score";
import type { TrialMetrics } from "../metrics";

/** Materialize a fresh recursive copy of the corpus in an OS temp dir. */
export function materializeCorpus(corpusRoot: string): {
  root: string;
  srcRoot: string;
} {
  const root = mkdtempSync(
    path.join(tmpdir(), "strata-bench-baseline-")
  );
  cpSync(corpusRoot, root, { recursive: true });
  return { root, srcRoot: path.join(root, "src") };
}

export interface ScoreBaselineTrialInput {
  srcRoot: string;
  commitReturnedOk: boolean;
  validateAfterCommitClean: boolean;
}

/** Pure: ten shared criteria from the post-edit working tree. */
export function scoreBaselineTrial(
  input: ScoreBaselineTrialInput
): SharedCriteria {
  return scoreBaselineWorkingTree(input);
}

/**
 * The verbatim T03 task text the substrate gets, prefixed ONLY with the
 * irreducible "file world" framing (the substrate is told it works on a
 * graph; the baseline is told where the files are). T03_PROMPT is imported
 * from @strata/agent so the task text cannot drift.
 */
export function baselinePrompt(workingTreeRoot: string): string {
  return (
    `The TypeScript codebase is on disk at ${workingTreeRoot} ` +
    `(sources under ${path.join(workingTreeRoot, "src")}). ` +
    `You may read, edit, and run \`tsc --noEmit\` and the test suite ` +
    `freely.\n\n${T03_PROMPT}`
  );
}

/** The pinned file-tool surface (explicit allow-list, audit-able). */
export const BASELINE_TOOLS: string[] = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash"
];

export interface RunBaselineTrialParams {
  trial: number;
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  keepArtifacts?: boolean;
  /** Injected so the runner test never makes a model call. */
  validateWorkingTree?: (srcRoot: string) => Promise<{
    tscClean: boolean;
    vitestPassed: boolean;
    anyFileModified: boolean;
  }>;
}

/**
 * One live baseline trial. Deliberately INVERTS the substrate's hermetic
 * isolation (decisions.md 2026-05-15 "Agent hermetic isolation"): real
 * file tools, real working tree, free tsc/test. NO Strata tools, NO
 * mcpServers. cwd scoped to the temp tree. systemPrompt is the Claude Code
 * preset (the baseline gets Claude Code's real file-centric instructions).
 */
export async function runBaselineTrial(
  params: RunBaselineTrialParams
): Promise<TrialMetrics> {
  const { root, srcRoot } = materializeCorpus(params.corpusRoot);
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    params.wallTimeMs
  );

  try {
    const options: Options = {
      cwd: root,
      tools: BASELINE_TOOLS,
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: params.model,
      maxTurns: params.maxTurns,
      abortController
    };

    async function* prompt(): AsyncGenerator<unknown, void> {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: baselinePrompt(root) }
      };
    }

    const session = await collectBaselineSession(
      query({
        prompt: prompt() as never,
        options
      }) as AsyncIterable<unknown>
    );
    const harnessWallTimeMs = Date.now() - startedAt;

    const probe = params.validateWorkingTree
      ? await params.validateWorkingTree(srcRoot)
      : { tscClean: false, vitestPassed: false, anyFileModified: false };

    // Symmetric commit/validate analog (spec § symmetric pair):
    const commitReturnedOk =
      session.terminalReason === "success" && probe.anyFileModified;
    const validateAfterCommitClean = probe.tscClean;

    const criteria = scoreBaselineWorkingTree({
      srcRoot,
      commitReturnedOk,
      validateAfterCommitClean
    });
    const r = session.result;

    return {
      config: "baseline",
      trial: params.trial,
      totalTokens:
        (r?.usage.inputTokens ?? 0) + (r?.usage.outputTokens ?? 0),
      inputTokens: r?.usage.inputTokens ?? 0,
      outputTokens: r?.usage.outputTokens ?? 0,
      cacheReadInputTokens: r?.usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: r?.usage.cacheCreationInputTokens ?? 0,
      wallTimeMs: r?.durationMs ?? 0,
      harnessWallTimeMs,
      toolInvocations: session.toolInvocations,
      failuresRetries: countBaselineRetries(
        session.toolEvents.map((e) => ({
          tool: e.tool,
          path: e.path,
          command: e.command,
          exitCode: e.exitCode
        }))
      ),
      totalCostUsd: r?.totalCostUsd ?? 0,
      success: isSharedSuccess(criteria),
      resultQuality: {
        tscClean: probe.tscClean,
        vitestPassed: probe.vitestPassed
      },
      terminalReason: session.terminalReason,
      operationRowAppended: null
    };
  } finally {
    clearTimeout(timer);
    abortController.abort();
    if (!params.keepArtifacts) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 4: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  BASELINE_TOOLS,
  baselinePrompt,
  materializeCorpus,
  runBaselineTrial,
  scoreBaselineTrial,
  type RunBaselineTrialParams,
  type ScoreBaselineTrialInput
} from "./configs/baseline";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- baselineAdapter`
Expected: PASS — `materializeCorpus` produces a real recursive copy; `scoreBaselineTrial` reads the synthetic post-edit tree and scores all ten shared criteria true. No model call, no key.

- [ ] **Step 6: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green. (`tsc -b` must accept the pinned `Options` block against the installed `sdk.d.ts` — `tools: string[]`, `systemPrompt: { type:'preset', preset:'claude_code' }`. The `query({ prompt, options })` generator is cast through `as never`/`as AsyncIterable<unknown>` only at the SDK boundary, mirroring the Phase 3 `singlePrompt` cast.)

- [ ] **Step 7: Append decision D4 to `decisions.md`**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — Baseline temp-checkout = recursive copy; file tool surface pinned (D4, Open Question 3)

**Context:** Phase 4's baseline needs an isolated, writable, real .ts tree with the corpus tsconfig/package.json and working tsc/vitest. Open Question 3 left clone-vs-copy and corpus-deps handling to implementation.

**Considered:** `git clone --depth=1 file://`; recursive copy + `git init`; recursive copy only.

**Decided:** Recursive `cpSync(corpusRoot, tmp, { recursive: true })` into an OS temp dir. The baseline needs no repo history; `examples/medium` is a `noEmit` corpus with no own vitest suite and no runtime deps (only `@types/node` via the workspace), so no `node_modules` install/symlink is required for the trial itself — `tsc --noEmit` resolves against the workspace TypeScript. (If a future corpus gains its own runtime deps, the materializer pre-installs once into the temp tree; revisit then.) The baseline `tools` surface is the explicit allow-list `['Read','Write','Edit','Glob','Grep','Bash']` (audit-able, SDK-version-stable) rather than `{type:'preset',preset:'claude_code'}`; `systemPrompt` IS the `{type:'preset',preset:'claude_code'}` preset (the baseline must get Claude Code's real file-centric instructions, never the Strata worldview). `git init` was dropped: the re-edit-detection retry rule tracks edited paths in-process and needs no git tree.

**Why:** Copy is the minimal mechanism that gives an isolated writable real tree; the corpus's `noEmit`/no-deps shape means clone/install ceremony buys nothing. Pinning the tool list keeps the fairness invariant ("same model, prompt, success bar; vary substrate vs files") auditable run to run.

**Design-doc impact:** none — implements spec § "Baseline config" / Open Question 3.

**Revisit when:** the corpus gains its own runtime deps or vitest suite (then deps pre-install is required and this entry is superseded by a new one), or an SDK upgrade changes `Options.tools`/`systemPrompt` preset semantics.
```

(Implementer: if, while wiring Task 9's live round, the operator finds `examples/medium` actually does need installed deps for `resultQuality`'s vitest step, that contradicts this entry — log a NEW newest-first entry, do not edit this one.)

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/configs/baseline.ts packages/bench/src/index.ts packages/bench/tests/baselineAdapter.test.ts decisions.md
git commit -m "feat(bench): file-tools baseline config on temp corpus copy (D4)"
```

---

## Task 8: Report writer (JSON + Markdown, distributions) + runner trial loop

The distribution report (JSON + Markdown, never a bare mean) and the runner: trial loop, N config, projected-spend print (BS-Bench-C), `--trials=0` dry-run, artifact writing under `results/`. The report formatter and runner orchestration are unit-tested on synthetic per-trial metrics with injected config runners (no model, no key).

**Files:**
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/report.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/runner.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/report.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`

- [ ] **Step 1: Write the failing report + runner test**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/report.test.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, renderMarkdown } from "../src/report";
import { runBenchmark } from "../src/runner";
import type { TrialMetrics } from "../src/metrics";

function trial(
  config: "substrate" | "baseline",
  trial: number,
  over: Partial<TrialMetrics> = {}
): TrialMetrics {
  return {
    config,
    trial,
    totalTokens: 1000,
    inputTokens: 800,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    wallTimeMs: 5000,
    harnessWallTimeMs: 5100,
    toolInvocations: 5,
    failuresRetries: 0,
    totalCostUsd: 0.2,
    success: true,
    resultQuality: { tscClean: true, vitestPassed: true },
    terminalReason: "success",
    operationRowAppended: config === "substrate" ? true : null,
    ...over
  };
}

describe("buildReport / renderMarkdown", () => {
  it("emits per-config distributions with raw values and never a bare mean", () => {
    const report = buildReport({
      task: "T03",
      model: "claude-sonnet-4-6",
      n: 3,
      substrate: [trial("substrate", 1), trial("substrate", 2, { totalTokens: 1200 }), trial("substrate", 3, { totalTokens: 800 })],
      baseline: [trial("baseline", 1, { totalTokens: 4000, failuresRetries: 2 }), trial("baseline", 2, { totalTokens: 5000, success: false, terminalReason: "error_max_turns" }), trial("baseline", 3, { totalTokens: 4500 })],
      totalCostUsd: 1.4
    });
    expect(report.substrate.totalTokens.values).toEqual([1000, 1200, 800]);
    expect(report.baseline.successCount).toBe(2);
    expect(report.baseline.terminalReasonCounts.error_max_turns).toBe(1);
    const md = renderMarkdown(report);
    expect(md).toContain("raw:"); // raw per-trial values present
    expect(md).toContain("substrate");
    expect(md).toContain("baseline");
    // Honest no-signal labeling is available.
    expect(typeof report.comparisonNote).toBe("string");
  });
});

describe("runBenchmark (injected config runners, no model/key)", () => {
  it("runs N trials per config, aggregates, and writes JSON + Markdown artifacts", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "strata-rep-"));
    const res = await runBenchmark({
      task: "T03",
      model: "fake-model",
      trials: 2,
      corpusRoot: "/unused-in-injected-mode",
      maxTurns: 5,
      wallTimeMs: 1000,
      outDir,
      runSubstrate: async (t) => trial("substrate", t),
      runBaseline: async (t) => trial("baseline", t)
    });
    expect(res.artifactJsonPath).toBeDefined();
    expect(existsSync(res.artifactJsonPath)).toBe(true);
    expect(existsSync(res.artifactMarkdownPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(res.artifactJsonPath, "utf8"));
    expect(parsed.substrate.trials).toBe(2);
    expect(parsed.baseline.trials).toBe(2);
  });

  it("dry-run (trials=0) prints projected spend and writes no artifact", async () => {
    const res = await runBenchmark({
      task: "T03",
      model: "fake-model",
      trials: 0,
      corpusRoot: "/unused",
      maxTurns: 5,
      wallTimeMs: 1000,
      outDir: mkdtempSync(path.join(tmpdir(), "strata-dry-")),
      runSubstrate: async (t) => trial("substrate", t),
      runBaseline: async (t) => trial("baseline", t)
    });
    expect(res.dryRun).toBe(true);
    expect(res.artifactJsonPath).toBe("");
    expect(res.projectedRuns).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- report`
Expected: FAIL with "Cannot find module '../src/report'".

- [ ] **Step 3: Implement `report.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/report.ts`:
```ts
import { aggregate, type ConfigAggregate, type TrialMetrics } from "./metrics";

export interface BenchmarkReport {
  task: "T03";
  model: string;
  n: number;
  generatedAt: string;
  substrate: ConfigAggregate;
  baseline: ConfigAggregate;
  substrateTrials: TrialMetrics[];
  baselineTrials: TrialMetrics[];
  totalCostUsd: number;
  /** Honest signal/overlap labeling (BS-Bench-D). */
  comparisonNote: string;
  /** The retry rule stated alongside the metric so a reader can audit it. */
  retryRule: string;
}

const RETRY_RULE =
  'A "failure/retry" is one observed self-correction: a verification ' +
  "action that returned a negative result followed by at least one " +
  "further mutating action before the terminal result (substrate: failed " +
  "validate / commit_transaction:false; baseline: non-zero tsc/test run " +
  "or re-edit of an already-edited file).";

function overlaps(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const aMin = Math.min(...a);
  const aMax = Math.max(...a);
  const bMin = Math.min(...b);
  const bMax = Math.max(...b);
  return aMin <= bMax && bMin <= aMax;
}

export function buildReport(input: {
  task: "T03";
  model: string;
  n: number;
  substrate: TrialMetrics[];
  baseline: TrialMetrics[];
  totalCostUsd: number;
}): BenchmarkReport {
  const sub = aggregate("substrate", input.substrate);
  const base = aggregate("baseline", input.baseline);
  const tokenOverlap = overlaps(
    sub.totalTokens.values,
    base.totalTokens.values
  );
  const comparisonNote =
    input.substrate.length < 3 || input.baseline.length < 3
      ? "N < 3 per config — distribution is indicative only, not a claim."
      : tokenOverlap
        ? "Total-token distributions overlap at this N — no separable signal; reported as the result, not massaged (BS-Bench-D)."
        : "Total-token distributions are separated at this N — see per-metric distributions below; this is not a significance claim, only an observed separation.";
  return {
    task: input.task,
    model: input.model,
    n: input.n,
    generatedAt: new Date().toISOString(),
    substrate: sub,
    baseline: base,
    substrateTrials: input.substrate,
    baselineTrials: input.baseline,
    totalCostUsd: input.totalCostUsd,
    comparisonNote,
    retryRule: RETRY_RULE
  };
}

function dist(label: string, d: ConfigAggregate["totalTokens"]): string {
  if (d.n === 0) return `- ${label}: (no trials)`;
  return (
    `- ${label}: n=${d.n} min=${d.min} p25=${d.p25} median=${d.median} ` +
    `mean=${d.mean?.toFixed(1)} p75=${d.p75} max=${d.max} ` +
    `stddev=${d.stddev?.toFixed(2)} raw:[${d.values.join(", ")}]`
  );
}

export function renderMarkdown(r: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# T03 Benchmark — substrate vs. baseline`);
  lines.push("");
  lines.push(
    `Model: \`${r.model}\` · N per config: ${r.n} · generated ${r.generatedAt}`
  );
  lines.push(`Round total cost: $${r.totalCostUsd.toFixed(2)}`);
  lines.push("");
  lines.push(`> ${r.comparisonNote}`);
  lines.push("");
  lines.push(`Retry rule: ${r.retryRule}`);
  lines.push("");
  for (const [name, agg] of [
    ["substrate", r.substrate] as const,
    ["baseline", r.baseline] as const
  ]) {
    lines.push(`## ${name}`);
    lines.push(
      `Success: ${agg.successCount}/${agg.trials} (rate ${(
        agg.successRate * 100
      ).toFixed(0)}%)`
    );
    lines.push(
      `Terminal reasons: ${JSON.stringify(agg.terminalReasonCounts)}`
    );
    lines.push(dist("totalTokens", agg.totalTokens));
    lines.push(dist("wallTimeMs", agg.wallTimeMs));
    lines.push(dist("toolInvocations", agg.toolInvocations));
    lines.push(dist("failuresRetries", agg.failuresRetries));
    lines.push(dist("totalCostUsd", agg.totalCostUsd));
    lines.push(
      `- resultQuality: tsc clean ${agg.resultQualityTscCleanCount}/${agg.trials}, vitest passed ${agg.resultQualityVitestPassedCount}/${agg.trials}`
    );
    if (agg.operationRowAppendedCount !== null) {
      lines.push(
        `- operationRowAppended (substrate-only sub-metric, NOT part of the shared bar): ${agg.operationRowAppendedCount}/${agg.trials}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Implement `runner.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/runner.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSubstrateTrial } from "./configs/substrate";
import { runBaselineTrial } from "./configs/baseline";
import { buildReport, renderMarkdown } from "./report";
import type { TrialMetrics } from "./metrics";

export interface RunBenchmarkParams {
  task: "T03";
  model: string;
  trials: number;
  corpusRoot: string;
  maxTurns: number;
  wallTimeMs: number;
  outDir: string;
  /** Injected in tests so no model is called. */
  runSubstrate?: (trial: number) => Promise<TrialMetrics>;
  runBaseline?: (trial: number) => Promise<TrialMetrics>;
  keepArtifacts?: boolean;
}

export interface RunBenchmarkResult {
  dryRun: boolean;
  projectedRuns: number;
  artifactJsonPath: string;
  artifactMarkdownPath: string;
}

export async function runBenchmark(
  params: RunBenchmarkParams
): Promise<RunBenchmarkResult> {
  const projectedRuns = 2 * params.trials;
  // BS-Bench-C: print projected spend before any live trial.
  // Per-run cost band is unknown until the first live round establishes it
  // (spec § "Cost budget"); printed honestly rather than guessed.
  // eslint-disable-next-line no-console
  console.log(
    `[bench] task=${params.task} model=${params.model} N=${params.trials} ` +
      `=> ${projectedRuns} live runs. Per-run cost band: unknown until the ` +
      `first live round establishes baseline cost; BS-Bench-C is evaluated ` +
      `from round one actuals.`
  );

  if (params.trials <= 0) {
    // eslint-disable-next-line no-console
    console.log("[bench] dry-run (trials=0): no live runs, no artifact.");
    return {
      dryRun: true,
      projectedRuns: 0,
      artifactJsonPath: "",
      artifactMarkdownPath: ""
    };
  }

  const runSub =
    params.runSubstrate ??
    ((trial: number) =>
      runSubstrateTrial({
        trial,
        corpusRoot: params.corpusRoot,
        model: params.model,
        maxTurns: params.maxTurns,
        wallTimeMs: params.wallTimeMs
      }));
  const runBase =
    params.runBaseline ??
    ((trial: number) =>
      runBaselineTrial({
        trial,
        corpusRoot: params.corpusRoot,
        model: params.model,
        maxTurns: params.maxTurns,
        wallTimeMs: params.wallTimeMs,
        keepArtifacts: params.keepArtifacts
      }));

  const substrate: TrialMetrics[] = [];
  const baseline: TrialMetrics[] = [];
  for (let t = 1; t <= params.trials; t++) {
    substrate.push(await runSub(t));
    baseline.push(await runBase(t));
  }

  const totalCostUsd =
    substrate.reduce((s, m) => s + m.totalCostUsd, 0) +
    baseline.reduce((s, m) => s + m.totalCostUsd, 0);

  const report = buildReport({
    task: params.task,
    model: params.model,
    n: params.trials,
    substrate,
    baseline,
    totalCostUsd
  });

  mkdirSync(params.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(params.outDir, `t03-${stamp}.json`);
  const mdPath = path.join(params.outDir, `t03-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report));
  // eslint-disable-next-line no-console
  console.log(
    `[bench] wrote ${jsonPath} and ${mdPath}; round cost $${totalCostUsd.toFixed(
      2
    )}`
  );

  return {
    dryRun: false,
    projectedRuns,
    artifactJsonPath: jsonPath,
    artifactMarkdownPath: mdPath
  };
}

/** CLI entry for the operator-only `bench:t03` script (Task 9 wires it). */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt: string): string => {
    const hit = args.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : dflt;
  };
  const trials = Number(get("--trials", "3"));
  const model = get("--model", "claude-sonnet-4-6");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpusRoot = path.resolve(here, "../../../examples/medium");
  const outDir = path.resolve(here, "../results");
  await runBenchmark({
    task: "T03",
    model,
    trials,
    corpusRoot,
    maxTurns: Number(get("--max-turns", "25")),
    wallTimeMs: Number(get("--wall-ms", "240000")),
    outDir,
    keepArtifacts: args.includes("--keep-artifacts")
  });
}

// Only runs when invoked directly as the bench:t03 script, never on import
// (so importing the barrel in tests does not trigger a live round).
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  });
}
```

Implementer note: `tsconfig.base.json` is `module: CommonJS`. `import.meta.url` requires an ESM-ish module setting. If `tsc -b` rejects `import.meta` under the inherited CommonJS module option, replace the direct-invocation guard and `fileURLToPath(import.meta.url)` with the CommonJS equivalent (`require.main === module` and `__dirname`) — this is a module-system adaptation, not a behavior change; pick whichever the installed `tsc` accepts and keep the guard semantics ("only run `main()` when invoked as the script, never on import"). State which form was used in the Task 9 boundary note.

- [ ] **Step 5: Re-export from the barrel**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  buildReport,
  renderMarkdown,
  type BenchmarkReport
} from "./report";
export {
  runBenchmark,
  type RunBenchmarkParams,
  type RunBenchmarkResult
} from "./runner";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @strata/bench test -- report`
Expected: PASS — report carries raw per-trial values and distribution stats; the runner runs N trials per config with injected runners, writes JSON+MD artifacts, and the `trials=0` dry-run writes no artifact and prints projected spend. No model, no key.

- [ ] **Step 7: Build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green.

- [ ] **Operator commit boundary**

Implementer: ensure green, stop. Operator commits:
```
git add packages/bench/src/report.ts packages/bench/src/runner.ts packages/bench/src/index.ts packages/bench/tests/report.test.ts
git commit -m "feat(bench): distribution report + trial runner (BS-Bench-C/D)"
```

---

## Task 9: Wire `bench:t03` resultQuality + the key-gated live round (operator) + docs

Wire the substrate `resultQuality` (render committed modules to a scratch dir → `tsc`/vitest) and the baseline `validateWorkingTree` (tsc/vitest in the temp tree) as the runner's default callbacks, document the command in `CLAUDE.md`, and hand the key-gated live round to the operator. The live round is NOT a test — it is the operator running `pnpm --filter @strata/bench bench:t03`.

**Files:**
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/configs/substrate.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/configs/baseline.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/src/quality.ts`
- Create: `/Users/toddhebebrand/Strata/packages/bench/tests/quality.test.ts`
- Modify: `/Users/toddhebebrand/Strata/packages/bench/src/index.ts`
- Modify: `/Users/toddhebebrand/Strata/CLAUDE.md`
- Modify: `/Users/toddhebebrand/Strata/decisions.md`

- [ ] **Step 1: Write the failing quality-probe test (synthetic tree, key-free)**

Create `/Users/toddhebebrand/Strata/packages/bench/tests/quality.test.ts`:
```ts
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderStoreToDir, tscNoEmit } from "../src/quality";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import { readFileSync, readdirSync, statSync } from "node:fs";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(dir: string): void {
    for (const e of readdirSync(dir).sort()) {
      const abs = path.join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (e.endsWith(".ts"))
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(rootDir);
  return out;
}

describe("renderStoreToDir + tscNoEmit (no model, no key)", () => {
  it("renders committed modules to a scratch dir that tsc accepts clean", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decl = find_declarations(db, {
        name: "User",
        kind: "interface"
      })[0]!;
      const tx = begin(db, "q");
      rename_symbol(db, tx, decl.id, "Account");
      expect(commit(db, tx).ok).toBe(true);

      const out = mkdtempSync(path.join(tmpdir(), "strata-q-"));
      const outSrc = renderStoreToDir(db, batch, srcRoot, out, corpusRoot);
      const result = tscNoEmit(out);
      expect(result.tscClean).toBe(true);
      // The rename landed in the rendered scratch tree.
      const userText = readFileSync(
        path.join(outSrc, "types", "user.ts"),
        "utf8"
      );
      expect(userText).toContain("interface Account");
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @strata/bench test -- quality`
Expected: FAIL with "Cannot find module '../src/quality'".

- [ ] **Step 3: Implement `quality.ts`**

Create `/Users/toddhebebrand/Strata/packages/bench/src/quality.ts`:
```ts
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
  existsSync
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderWithSourceMap } from "@strata/render";
import { loadModule, type Db } from "@strata/store";

interface T03Batch {
  modules: { path: string; moduleId: string }[];
}

/**
 * Render every committed store module to a scratch dir mirroring the
 * corpus src/ layout, copying the corpus tsconfig.json so tsc resolves
 * the same way the corpus does (decisions.md 2026-05-15 "Validate uses
 * the nearest corpus tsconfig"). Returns the scratch src/ root.
 */
export function renderStoreToDir(
  db: Db,
  batch: T03Batch,
  srcRoot: string,
  outRoot: string,
  corpusRoot: string
): string {
  const outSrc = path.join(outRoot, "src");
  for (const m of batch.modules) {
    const rel = path.relative(srcRoot, m.path).replaceAll("\\", "/");
    const loaded = loadModule(db, m.moduleId);
    const text = renderWithSourceMap(loaded.module, loaded.children).text;
    const dest = path.join(outSrc, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  const corpusTsconfig = path.join(corpusRoot, "tsconfig.json");
  if (existsSync(corpusTsconfig)) {
    copyFileSync(corpusTsconfig, path.join(outRoot, "tsconfig.json"));
  }
  const corpusPkg = path.join(corpusRoot, "package.json");
  if (existsSync(corpusPkg)) {
    copyFileSync(corpusPkg, path.join(outRoot, "package.json"));
  }
  return outSrc;
}

export interface QualityResult {
  tscClean: boolean;
  vitestPassed: boolean;
}

/** Run `tsc --noEmit` over a tree using its own tsconfig. */
export function tscNoEmit(treeRoot: string): { tscClean: boolean } {
  const res = spawnSync(
    "npx",
    ["tsc", "--noEmit", "-p", path.join(treeRoot, "tsconfig.json")],
    { cwd: treeRoot, encoding: "utf8" }
  );
  return { tscClean: res.status === 0 };
}

/**
 * Run the corpus's own vitest if it has one; the examples/medium corpus
 * has no vitest suite (D4), so vitestPassed is reported true only when a
 * suite exists and exits 0, and is treated as "not applicable -> true" by
 * a caller that knows the corpus has none. The runner passes the corpus
 * shape so this stays honest.
 */
export function vitestRun(treeRoot: string): { vitestPassed: boolean } {
  const res = spawnSync("npx", ["vitest", "run"], {
    cwd: treeRoot,
    encoding: "utf8"
  });
  // exit 0 = passed; non-zero with "No test files" also acceptable for a
  // corpus with no own suite.
  if (res.status === 0) return { vitestPassed: true };
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { vitestPassed: /No test files found/i.test(out) };
}
```

- [ ] **Step 4: Wire the default callbacks into the configs**

Modify `/Users/toddhebebrand/Strata/packages/bench/src/configs/substrate.ts`: add a `defaultSubstrateResultQuality(corpusRoot)` factory that, given an `AgentT03Result`, re-ingests the corpus, replays the committed store is not needed (the substrate already committed in `runAgentT03`'s own db which is closed) — so instead the runner-level default re-runs the programmatic render off the trial's own returned data. **Resolution:** `runAgentT03` closes its db, so `resultQuality` cannot read that store post-hoc. The faithful substrate `resultQuality` therefore re-derives it: render is a pure function of committed state, and a successful substrate trial's correctness is already captured by the ten shared criteria + the operation row; for `resultQuality` specifically the runner default re-runs the deterministic programmatic T03 (`@strata/cli` is NOT a dep — instead inline the same ingest→rename→commit→render-to-dir→tsc using `@strata/store`/`@strata/verify`/`@strata/render` already on deps) into a scratch dir and runs `tscNoEmit`. Add to `substrate.ts`:
```ts
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import { renderStoreToDir, tscNoEmit, vitestRun } from "../quality";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

/**
 * Default substrate resultQuality: re-derive the committed state (render
 * is pure; a correct substrate rename is deterministic) into a scratch
 * dir and run tsc. The corpus has no own vitest suite (D4) so vitest is
 * reported via the "no test files" allowance. This is NOT a second
 * scoring path — success is the ten shared criteria; this only answers
 * "does the resulting code typecheck/test".
 */
export function defaultSubstrateResultQuality(
  corpusRoot: string
): () => Promise<{ tscClean: boolean; vitestPassed: boolean }> {
  return async () => {
    const srcRoot = nodePath.join(corpusRoot, "src");
    const files: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir).sort()) {
        const abs = nodePath.join(dir, e);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (e.endsWith(".ts"))
          files.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    };
    walk(srcRoot);
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decl = find_declarations(db, {
        name: "User",
        kind: "interface"
      })[0];
      if (!decl) return { tscClean: false, vitestPassed: false };
      const tx = begin(db, "rq");
      rename_symbol(db, tx, decl.id, "Account");
      if (!commit(db, tx).ok)
        return { tscClean: false, vitestPassed: false };
      const out = mkdtempSync(nodePath.join(tmpdir(), "strata-rq-"));
      renderStoreToDir(db, batch, srcRoot, out, corpusRoot);
      const { tscClean } = tscNoEmit(out);
      const { vitestPassed } = vitestRun(out);
      return { tscClean, vitestPassed };
    } finally {
      db.close();
    }
  };
}
```
and in `runSubstrateTrial`, default `params.resultQuality` to `defaultSubstrateResultQuality(params.corpusRoot)` (called as `await rq(result)` — accept the ignored arg by wrapping: `params.resultQuality ?? ((_: AgentT03Result) => defaultSubstrateResultQuality(params.corpusRoot)())`).

Modify `/Users/toddhebebrand/Strata/packages/bench/src/configs/baseline.ts`: default `params.validateWorkingTree` to a function that runs `tscNoEmit(treeRoot)` + `vitestRun(treeRoot)` on the temp tree root (the parent of `srcRoot`) and sets `anyFileModified` by comparing the post-run `readModuleMap(srcRoot)` against a snapshot taken right after `materializeCorpus` (capture the pre-run map before the `query` call; `anyFileModified` = any value differs). Import `tscNoEmit`/`vitestRun` from `../quality` and `readModuleMap` from `../score`.

- [ ] **Step 5: Re-export + run quality test**

Add to `/Users/toddhebebrand/Strata/packages/bench/src/index.ts` (append):
```ts
export {
  renderStoreToDir,
  tscNoEmit,
  vitestRun,
  type QualityResult
} from "./quality";
export { defaultSubstrateResultQuality } from "./configs/substrate";
```
Run: `pnpm --filter @strata/bench test -- quality`
Expected: PASS — committed modules render to a scratch dir that `tsc --noEmit` accepts clean; the rename is present in the rendered text. No model, no key.

- [ ] **Step 6: Document the command in `CLAUDE.md`**

In `/Users/toddhebebrand/Strata/CLAUDE.md` § "Tooling commands", append:
```markdown
- run the Phase 4 T03 benchmark (operator-only, key-gated, NOT a CI test):
  `ANTHROPIC_API_KEY=… pnpm --filter @strata/bench bench:t03 -- --trials=3`
  (defaults: N=3, model `claude-sonnet-4-6`, maxTurns 25, wall 240s; writes
  JSON+Markdown under `packages/bench/results/`; `--trials=0` is a dry-run
  that prints projected spend and writes nothing; `--keep-artifacts` keeps
  the baseline temp trees for post-mortem). `pnpm -r test` never runs this
  and needs no key.
```

- [ ] **Step 7: Full build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all green; NO test requires a key or makes a live call (the live round is the `bench:t03` script, not a test).

- [ ] **Step 8: Append decision D5 to `decisions.md` (implementer writes the deferred-observation form; operator updates after the round)**

Add at the top of the newest-first list:
```markdown
## 2026-05-15 — Phase 4 verticalizes on the T03 substrate-vs-baseline benchmark (D5); BS-Bench-A/C/D observation

**Context:** `@strata/bench` now runs the substrate (`runAgentT03`, reused as-is) and a file-tools baseline (temp copy of `examples/medium`) N trials each on T03, scores both through the shared `evaluateT03TextCriteria` core (BS-Bench-B gate green key-free), aggregates distributions, and writes artifacts via the operator-only key-gated `bench:t03` script. `strata-design.md` Phase 4 remains broader (10 tasks); this is the verticalized T03-only slice the spec settled.

**Considered:** n/a — verticalization is settled by the approved spec; this is the build record + the bail-signal observation.

**Decided / Observed:** <"Live round run by operator: N=<n>, model=<m>; substrate <s>/<n> success, baseline <b>/<n> success; round cost $<c>; <BS-Bench-A: baseline could/could not do T03 with file tools>; <BS-Bench-C: per-run cost band $<lo>-$<hi>, within/over budget>; <BS-Bench-D: distributions overlap / separate at this N — reported as observed, not massaged>." OR "Deferred: no API key in this environment; the live round is an operator action via `pnpm --filter @strata/bench bench:t03`. All harness logic (scorer-equivalence BS-Bench-B gate, metrics/distribution math, retry counter, report) is green key-free; BS-Bench-A/C/D are recorded by the operator from round one regardless of outcome."> Runner module-system form used for the script self-invocation guard: <import.meta / require.main>.

**Why:** BS-Bench-A/C/D are measurement findings recorded from the real round, never inferred from skipped logic. The substrate path was not modified; only the behavior-preserving D1 extraction touched existing packages.

**Design-doc impact:** none — `strata-design.md` Phase 4 remains the broader target; this records the implemented verticalized slice and the operator-pending live round.

**Revisit when:** the operator completes the keyed live round (fill the bracket with actuals as a NEW entry if this was logged deferred), N is raised as a budgeted operator decision, or Phase 4.5 widens to a second task.
```

- [ ] **Step 9: OPERATOR — run the key-gated live round**

Implementer must NOT run this (no key, no registry, no git). Operator, with auth, runs from `/Users/toddhebebrand/Strata`:
```bash
pnpm -r build
ANTHROPIC_API_KEY=… pnpm --filter @strata/bench bench:t03 -- --trials=3
```
Expected: a `packages/bench/results/t03-<stamp>.json` + `.md` artifact with per-config distributions and raw per-trial values; the projected-spend line printed before trials; round cost recorded. The operator then updates D5's bracket with the actuals (BS-Bench-A/C/D as observed), as a NEW newest-first entry if D5 was committed in deferred form, and commits the artifacts only if desired (they are gitignored by default; the `.md` may be copied into docs if the operator chooses).

- [ ] **Operator commit boundary**

Implementer: ensure `pnpm -r build && pnpm -r test` green (no key needed), then stop. Operator commits (code + docs; results artifacts are gitignored):
```
git add packages/bench/src/quality.ts packages/bench/src/configs/substrate.ts packages/bench/src/configs/baseline.ts packages/bench/src/index.ts packages/bench/tests/quality.test.ts CLAUDE.md decisions.md
git commit -m "feat(bench): resultQuality wiring + key-gated bench:t03 round (Phase 4 D5)"
```
Then the operator runs Step 9's live round (a separate, key-gated action) and records BS-Bench-A/C/D.

---

## Self-review

Run against the spec with fresh eyes.

**1. Spec coverage.**
- § "Scorer equivalence" (shared-core refactor + two adapters) → Task 0 (core extraction, behavior-preserving) + Task 3 (baseline adapter + the equivalence gate). ✓
- § "The `commitReturnedOk`/`validateAfterCommitClean` pair" (symmetric per-config) → Task 3 (`ScoreInput` carries them) + Task 7 (baseline analog: `success` terminal + any file modified; `tsc` clean) + Task 6 (substrate: from the agent log / criteria). ✓
- § "The `operationRowAppended` fairness decision" (substrate-only, excluded from shared bar) → Task 6 (`SHARED_KEYS` excludes it; recorded as sub-metric) + Task 2 (`operationRowAppended: boolean|null`) + Task 8 (reported labeled "NOT part of the shared bar"). ✓
- § "Metrics & statistics" schema → Task 2 (`TrialMetrics` row-for-row vs. the spec table). ✓
- § "The symmetric retry/failure counting rule" → Task 4 (both counters + the worked one-retry example) + Task 8 (rule stated in the report). ✓
- § "Distributions, not means" → Task 2 (`Distribution` carries raw `values`, never bare mean) + Task 8 (report prints raw + stats + honest overlap note). ✓
- § "Cost budget" → Task 8 (projected-spend print, N default 3, `--trials=0` dry-run, recorded round cost). ✓
- § "Configurations in detail" substrate (reuse `runAgentT03` as-is) → Task 6 (thin wrapper, path not modified). ✓
- § "Configurations in detail" baseline (temp copy, verbatim `T03_PROMPT`, file tools, no Strata tools, cwd-scoped, claude_code system prompt) → Task 7. ✓
- § "Determinism & the no-key / CI story" (harness key-free tested; benchmark is a key-gated script not a test; equivalence proved key-free) → Amendment 2, Tasks 3/4/5/6/8 all key-free, Task 9 operator-only. ✓
- § "Package / file layout" (new `packages/bench`, acyclic, no `cli` edge, scorer stays in `verify`) → Amendment 1, Task 1, Task 0 D1. ✓
- § "Bail signals" BS-Bench-A/B/C/D → bail-signal map + Tasks 3 (B gate), 8/9 (C/D), 9 (A). ✓
- Open Questions 1/2/3 → D3 (Task 4, retry rule shipped + operator validates), D1/Task 6 (op-row exclusion confirmed by construction), D4 (Task 7, copy mechanism + no-deps finding). ✓

**2. Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N"/"write tests for the above" — every code step shows full code; every test step shows the full test; the one acknowledged module-system fork (`import.meta` vs `require.main`) is given both concrete forms with a decision rule, not a placeholder. ✓ (Fixed inline: the substrate `resultQuality` "store is closed" hazard is resolved explicitly in Task 9 Step 4 by re-deriving via the deterministic programmatic rename rather than reading the closed db — a real decomposition risk surfaced and pinned.)

**3. Type consistency.** `TrialMetrics`/`Distribution`/`ConfigAggregate` (Task 2) are consumed unchanged by Tasks 6/7/8. `SharedCriteria` (Task 3) extends `T03TextCriteria` (Task 0) and is produced by both `scoreSharedCriteria` (Task 3) and consumed by `isSharedSuccess` (Task 3), Task 7. `evaluateT03TextCriteria`/`T03TextCriteria` (Task 0) are imported by Task 3 from the `@strata/verify` barrel (not deep path). `collectBaselineSession`'s `BaselineToolEvent` (Task 5) is barrel-aliased to avoid colliding with `retry.ts`'s `BaselineToolEvent` (Task 4) — flagged and resolved at the export. `runAgentT03`/`AgentT03Result`/`SessionLog`/`SessionLogEvent`/`T03_PROMPT` are consumed from `@strata/agent`'s real barrel (verified present in `packages/agent/src/index.ts`). `TerminalReason` is redefined locally in `metrics.ts` (Task 2) WITHOUT `replay_complete` — Task 6 explicitly maps the agent's `replay_complete` to `error_other` so the union stays consistent (replay is never used in a metric run anyway). ✓

No unfixed issues.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-phase4-t03-benchmark-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
