# Decisions

A running log of build-time decisions for Strata. Append-only. Newest at the top.

Log an entry whenever:
- A choice diverges from `strata-design.md` (swapped library, changed schema, dropped/added scope, different tool shape).
- A spec-level question from § "Open design questions" gets resolved.
- A non-obvious trade-off is made that a future reader would otherwise have to re-derive.
- An attempt fails and shapes the next attempt (record the failure too — silent retries lose information).

If the decision is durable, also update `strata-design.md` and reference the diff or commit from the entry.

## Entry format

```
## YYYY-MM-DD — <short title>

**Context:** what triggered this decision (phase, package, problem encountered).

**Considered:** the alternatives weighed (briefly).

**Decided:** what we're doing now.

**Why:** the reasoning, especially anything not obvious from the alternatives.

**Design-doc impact:** "none" / "updated § X" / "supersedes § X paragraph N".

**Revisit when:** the condition that should make us reopen this (e.g., "if Phase 4 benchmarks show ingest is the bottleneck").
```

---

<!-- New entries go below this line, newest first. -->

## 2026-05-15 — Agent hermetic isolation: `LSP` disallowed + `strictMcpConfig`/`settingSources` required

**Context:** Phase 3 live BS-A run. With `tools: []` (documented as "disable all built-in tools"), the runtime invariant guard still tripped — first on an injected `LSP` tool, then (after fixing that) on `mcp__claude_ai_Breeze__*` tools leaking in from the operator's `~/.claude.json`. Both violate the CLAUDE.md invariant that the agent's only tools are the in-process Strata ones and its world is the node graph, not files. The bail-signal guard caught this; it was NOT relaxed.

**Considered:**
- Relax the runtime guard to allow `LSP` / ambient MCP tools — rejected: papers over a real invariant violation and would invalidate the benchmark (an `LSP` tool inspects real files; Breeze tools perform arbitrary RMM actions).
- Whack-a-mole add every ambient tool to a banned list — rejected: not hermetic, brittle.
- Use the SDK's own hard-removal/isolation mechanisms — chosen.

**Decided:** In `runLiveSession` options: (1) add `"LSP"` to `BANNED_BUILTINS` (fed to `disallowedTools`, the SDK's documented "removed from the model's context and cannot be used" path) — `tools: []` does not strip `LSP` in `@anthropic-ai/claude-agent-sdk@0.2.118`; (2) set `strictMcpConfig: true` — in the underlying Claude CLI this means "use only the explicitly-passed MCP servers, ignore all other sources"; without it the SDK inherits `~/.claude.json` servers (Breeze); (3) set `settingSources: []` explicitly (documented default when omitted, set to make hermetic intent unambiguous). After these, the strict guard passes live and the agent completes T03 through only the 8 Strata tools.

**Why:** Enforces the invariant via the SDK's own mechanisms rather than weakening the check. Documents two installed-SDK-vs-docs gaps (the Phase 3 spec already flagged this class of risk): `tools: []` does not cover `LSP`; `strictMcpConfig`'s type doc says "strict validation" but its operative effect is MCP source isolation.

**Design-doc impact:** none — confirms strata-design.md § "The Agent" ("no file tools ... entire world is the node graph") is enforceable on this SDK with explicit isolation options.

**Revisit when:** upgrading `@anthropic-ai/claude-agent-sdk` (re-verify `tools: []`/LSP/`strictMcpConfig` behavior — these are version-observed, not type-guaranteed), or if a future SDK injects another ambient tool the guard catches.

## 2026-05-15 — Phase 3 verticalizes on agent-drives-T03 (D5)

**Context:** Phase 3 now has `@strata/agent` wrapping the existing store/verify spine as eight in-process SDK tools, a static worldview prompt, session logging, a headless `query()` live path configured with `tools: []`, and a deterministic replay path that passes all 11 shared `evaluateT03Criteria` checks. The design doc's Phase 3 remains broader than this slice.

**Considered:** broaden to the full benchmark harness, more tools, and the Claude Code baseline now; or ship the single agent-drives-T03 vertical slice and broaden in Phase 3.5/4.

**Decided:** single vertical slice. Phase 3 verticalizes on the proven `rename_symbol` T03 spine with no filesystem tools. Broadening to more tasks, more tools, and baseline comparison is Phase 3.5/4.

**Why:** Verticalizing isolates agent/SDK-integration risk from substrate risk. The substrate was already green for T03, so this run focuses on whether a Strata-only tool loop can drive the same outcome. The no-key replay path proves the substrate outcome deterministically. BS-A and the live half of BS-B are not claimed from skipped tests; they remain operator-pending keyed runs. BS-C cost capture wiring exists in the session log and will be populated by the operator's keyed run.

**Design-doc impact:** none — `strata-design.md` Phase 3 remains the target; this records the implemented first slice.

**Revisit when:** the operator completes the keyed live acceptance, Phase 3.5 adds a second tool/task, or Phase 4 builds the baseline comparison.

## 2026-05-15 — Phase 3 acceptance determinism: recorded-transcript replay (D4)

**Context:** The agent T03 acceptance test calls a live model, but CI must be deterministic and key-free.

**Considered:** key-gated live-only with a retry budget; or record a live transcript and replay the tool-call sequence through the real handlers so the store outcome is a pure function of the sequence.

**Decided:** Use replay. `runAgentT03` supports a replay path that re-executes `{ tool, args }` steps through the real Strata handlers and substitutes `"$TX"` with a fresh transaction handle. The committed fixture at `packages/agent/tests/fixtures/agent-t03-transcript.jsonl` is clearly labeled as a synthetic placeholder because this environment has no key; it keeps key-free CI exercising the full replay path and all 11 criteria. The operator replaces it with a real keyed live recording using `pnpm --filter @strata/agent build && ANTHROPIC_API_KEY=... pnpm --filter @strata/agent record:t03-fixture`.

**Why:** Replay keeps CI deterministic without secrets while a real live run remains the source of truth once recorded. The store outcome is a pure function of the recorded tool-call sequence, so replay is a faithful substrate-outcome reproduction, not a mock. The current placeholder is not represented as a real agent run; live confirmation remains operator-pending.

**Design-doc impact:** none — implements spec § "Acceptance test" / Open Question 2.

**Revisit when:** the SDK changes how tool calls are surfaced, the T03 corpus changes, or the operator regenerates the placeholder from a successful live run.

## 2026-05-15 — Phase 3 agent drives T03 live: BS-A / BS-C observation

**Context:** Phase 3 Task 10 wires the headless agent against the verbatim T03 prompt with only the eight Strata tools and `tools: []`.

**Considered:** n/a — this is a bail-signal observation entry, not a design choice.

**Decided / Observed:** Deferred in this environment: no Anthropic API key or Claude Code OAuth token is available, so the live BS-A run is an operator action. The live half of BS-B is likewise pending keyed confirmation from the SDK session. The CI proof for substrate outcome is the replay path added in Task 11. BS-C: token, cost, and wall-time numbers are pending the operator live run, but the session log now captures `SDKResultMessage` usage, per-model usage, total cost, and duration fields.

**Why:** BS-A is the substrate-agent-fit signal; BS-C is a primary Phase 4 cost signal. Both must be recorded from a real live run, not inferred from skipped tests.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed live acceptance, the prompt is iterated again, the tool set is widened, or Phase 4 benchmarking begins.

## 2026-05-15 — Phase 3 SDK session integration shape pending live confirmation (D3)

**Context:** Phase 3 BS-B asks whether the SDK runs headless with only custom in-process tools and `tools: []`, and whether tool results compose with our transaction model. Task 4 cleared the tool loop at the handler layer with no model; Task 5 adds the live one-tool session probe.

**Considered:** trust BS4 (schema-only) and build the full orchestrator directly; or probe a minimal one-tool session first.

**Decided:** probe-first. `packages/agent/src/session.ts` implements a single-yield async-generator prompt and `collectSession(...)` over the public `query(...)` API. `packages/agent/tests/sessionSmoke.test.ts` registers an in-process `createSdkMcpServer` with one `ping` tool, runs with `tools: []`, `allowedTools: ["mcp__probe__ping"]`, `bypassPermissions` + `allowDangerouslySkipPermissions`, `maxTurns`, and an `abortController`. Result: pending-live-confirmation — this environment has no API key, so the live SDK probe is skipped until the operator runs it with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

**Why:** The session/loop is the part BS4 did not exercise. Probing one tool isolates "the SDK headless loop composes" from "our eight tools / system prompt are right" before the full orchestrator. The no-key surface remains covered by Task 4's direct handler test; BS-B live confirmation is not claimed from a skipped test.

**Design-doc impact:** none — confirms the intended integration shape in code, with live confirmation pending.

**Revisit when:** the keyed Task 5 probe runs, an SDK upgrade changes `query`/`Options.tools`/MCP server handling, or the full Task 10 session reveals loop behavior the one-tool probe did not.

## 2026-05-15 — `read_node` added to @strata/store for the Phase 3 agent

**Context:** Phase 3's `read_node` tool needs "a node plus optional shallow children". `@strata/store` exposed `findNodeById` and `listChildren` separately; the agent must not reach into store internals.

**Considered:** (a) compose `findNodeById`+`listChildren` inside `packages/agent`; (b) add a public `readNode`/`read_node` to `@strata/store`.

**Decided:** (b). `packages/store/src/read_node.ts` exports `readNode(db, id, { includeChildren? })` (alias `read_node`) returning `{ node, children? }`.

**Why:** Keeps the dependency edge clean (`agent -> store` public surface only) and matches the spec's note that this helper belongs in `store`, not in `agent`. Minimal: one level of children, no recursion (Open Question 1 — widen only if agent behavior shows it's needed).

**Design-doc impact:** none — additive public API on an existing package.

**Revisit when:** the agent's transcript shows it repeatedly needs deeper traversal than one child level (then it becomes a logged tool-widening decision per Open Question 1).

## 2026-05-15 — T03 scoring extracted to `@strata/verify`

**Context:** Phase 3 needs the agent path and the programmatic `cli t03` path to score against identical logic so the agent cannot be given a weaker or vacuous check. The scoring block was inlined inside `runT03`, and Plan Amendment 1 moved the shared scorer boundary from `@strata/cli` to `@strata/verify`.

**Considered:** (a) duplicate the regex/operation checks in the agent test; (b) extract the post-commit scoring into `@strata/cli`; (c) extract it into `@strata/verify` and export it through the verify barrel.

**Decided:** (c). `packages/verify/src/t03Criteria.ts` exports `evaluateT03Criteria(db, batch, srcRoot, input)` and `emptyT03Criteria()`, re-exported from `@strata/verify`. `runT03` keeps driving the rename + post-commit re-validate itself and passes `commitReturnedOk`/`validateAfterCommitClean`/`renameTxId` in; the regex/operation-row scoring moved behavior-preservingly.

**Why:** `@strata/verify` already owns validation and depends on the store/render surface the scorer needs, while both `@strata/cli` and the Phase 3 agent can consume it without creating an `agent -> cli` dependency or a fragile deep `dist/` import. The 4th `input` arg keeps the function pure while letting each caller feed in its own commit outcome.

**Design-doc impact:** none — refactor only; `RunT03Result` shape unchanged, existing `t03.test.ts` unchanged and green.

**Revisit when:** T03 grows additional criteria, or Phase 4 creates a dedicated `@strata/bench` package that should own benchmark-acceptance logic.

## 2026-05-15 — Phase 1 verticalizes around `rename_symbol`

**Context:** Phase 1 completed Tasks 10-14 after the substrate pieces from Tasks 0-9 were already green. The design doc's Phase 1 remains broader than this run's implemented mutation surface.

**Considered:**
- Implement the whole Phase 1 mutation set now.
- Ship the single `rename_symbol` vertical slice with the infrastructure it forced, then broaden later.

**Decided:** Phase 1 ships as the `rename_symbol` vertical slice: identifier-level ingest, TypeChecker references, transactions, operation log, render splicing, `@strata/verify` validate-before-commit, CLI smoke commands, and the T03 acceptance path.

**Why:** The T03 path exercises the load-bearing substrate without prematurely designing every mutation. The stable-ID, overlay, JSDoc traversal, source-map, validation, and SDK-schema decisions have all been tested against the same hero operation.

**Design-doc impact:** none for now. `strata-design.md` still describes the broader target; this records the implemented Phase 1 slice.

**Revisit when:** Phase 1.5 adds the second structural mutation and tests whether the same transaction/reference/render spine generalizes.

## 2026-05-15 — BS4 cleared with SDK Zod tool schemas

**Context:** Phase 1 Task 12 probed whether `@anthropic-ai/claude-agent-sdk` can express the future Strata tool shapes before Phase 3 agent work starts.

**Considered:**
- A hand-written JSON-schema-shaped smoke object only.
- A smoke harness that also type-checks against the SDK's real `tool(...)` / `SdkMcpToolDefinition` API.

**Decided:** Use the SDK's typed `tool(...)` surface with explicit Zod schemas for `TxHandle`, `NodeId`, and `Diagnostic[]`, plus a serializable `sdk-smoke` command output for inspection.

**Why:** The installed SDK exposes `tool` and accepts Zod raw-shape schemas. The smoke harness type-checks and runs, so BS4 is cleared without inventing a custom schema representation.

**Design-doc impact:** none — this confirms the planned Phase 3 SDK direction remains viable.

**Revisit when:** Phase 3 adds the real agent tool registry, or an SDK upgrade changes `SdkMcpToolDefinition` / `tool(...)`.

## 2026-05-15 — Validate uses the nearest corpus tsconfig before root defaults

**Context:** Phase 1 Task 11 T03 initially failed validation before any rename-specific check: `examples/medium` imports `.ts` extensions and uses `import.meta` / top-level await, but `@strata/verify` was compiling rendered files with the monorepo `tsconfig.base.json` CommonJS defaults.

**Considered:**
- Keep using only `tsconfig.base.json` and special-case T03.
- Load the nearest `tsconfig.json` from the rendered module paths, falling back to `tsconfig.base.json` when no corpus config exists.

**Decided:** `@strata/verify` now loads the nearest corpus `tsconfig.json` for rendered module roots and falls back to `tsconfig.base.json`.

**Why:** The corpus already compiles cleanly under its own `examples/medium/tsconfig.json`; validation should check rendered output under the same compiler options as the corpus, not unrelated package defaults. This was an implementation bug, not a TypeChecker resolution wall.

**Design-doc impact:** supersedes the earlier Phase 0 assumption that one root base config is enough for verification.

**Revisit when:** validation spans multiple package roots with incompatible configs.

## 2026-05-15 — BS2 T03 timing recorded below total-run threshold

**Context:** Phase 1 Task 11 timed the built T03 path: ingest `examples/medium`, rename `User` to `Account`, validate through `@strata/verify`, commit, and assert acceptance criteria.

**Considered:** Stop if the run exceeded the plan's total-run timing note or if a single-module ingest / affected-node transaction clearly crossed the BS2 thresholds.

**Decided:** Continue. The final built command reported `wallTimeMs = 511.3`; `/usr/bin/time -p` reported `real 0.69`, `user 1.21`, `sys 0.06`.

**Why:** The full command is well below the plan's 5s T03 total-run note, and no single 2k-LOC ingest or ~50-node transaction threshold was clearly exceeded by this fixture.

**Design-doc impact:** none.

**Revisit when:** T03 grows to the intended ~15 modules / ~40 type positions, or validate timing becomes agent-loop visible.

## 2026-05-15 — Render source maps are per-module statement spans

**Context:** Phase 1 Task 9 moved validation into the new `@strata/verify` package and maps TypeScript diagnostics from rendered files back to graph nodes.

**Considered:**
- A per-module source map of rendered byte spans to renderable node IDs.
- A deeper identifier-level source map that maps diagnostics directly to Identifier nodes.

**Decided:** `renderWithSourceMap` returns `Array<{ renderedStart; renderedEnd; nodeId }>` sorted by `renderedStart` for each module. `@strata/verify` keys those maps by rendered module path and binary-searches the span containing `diagnostic.start`. In Phase 1 those entries point to renderable statement/EOF nodes; Identifier rows remain splice inputs rather than source-map targets.

**Why:** TypeScript diagnostics are file-position based, and statement-level mapping is enough to make validate failures actionable for the rename slice. Identifier-level mapping can be layered on later without changing the per-module map contract. The BS3 probe on the two-module validate corpus took 322.9ms cold and returned one mapped diagnostic for the intentional half-rename, below the 500ms bail threshold, so a fresh `ts.Program` per validate call remains acceptable.

**Design-doc impact:** none — this locks in the Phase 1 source-map shape without changing `strata-design.md`.

**Revisit when:** diagnostics need to drive automatic repair at identifier precision, or validate on the medium corpus crosses the BS3 threshold.

## 2026-05-15 — Transaction overlay stores identifier text mutations in memory

**Context:** Phase 1 Task 6 implemented transactions for the `rename_symbol` slice.

**Considered:**
- Store full replacement `NodeRow` values in the overlay keyed by node ID.
- Store only identifier-text mutations keyed by identifier node ID, plus pending operation rows.

**Decided:** The Phase 1 overlay is an in-memory `identifierMutations: Map<identifierId, { text }>` plus `pendingOps: PendingOp[]`, keyed by `tx_id`. `commitWithoutValidate` materializes those text mutations into canonical Identifier payload rows. Open transactions do not survive process restart; startup recovery marks persisted `status='open'` rows as `rolled_back`.

**Why:** The public Task 6/9 mutation surface queues identifier updates without a database handle, so it cannot safely construct full replacement rows at queue time. The canonical offset and statement splice context stay in the store rows until validate/commit materializes the transaction view. This preserves the Phase 1 rename invariant while keeping the overlay small and tied to operation intent.

**Design-doc impact:** none to `strata-design.md`; this records a narrower implementation shape than the plan's full-`NodeRow` overlay option.

**Revisit when:** mutations need non-identifier replacements, or read APIs must expose a fully overlay-merged graph view before commit.

## 2026-05-15 — BS1 probed and cleared: AST traversal must use `getChildren`, not `forEachChild` + internal `.jsDoc`

**Context:** Phase 1 Task 4. The BS1 probe ("resolves the JSDoc `@param {User}` identifier") fired: the resolver resolved 5 of 6 `User` references, missing the JSDoc one. Per the spec this is a bail signal — stop, do not work around. Investigation followed before accepting the bail.

**Considered:**
- Accept BS1 as a true substrate wall (TypeScript can't do reference-aware rename through JSDoc) and re-spec.
- Investigate whether the miss is a substrate limitation or an implementation defect.

**Decided:** Not a true bail. Root cause is an implementation defect: the ingest/resolver traversal used `ts.forEachChild` (which deliberately skips JSDoc nodes) plus the **internal** `node.jsDoc` property as a workaround. The internal property is absent from TypeScript's public typings, so `tsc -b` failed outright; and even cast, `forEachChild` is the wrong traversal for JSDoc. A standalone probe (`/tmp/bs1-probe.mjs`) proved `checker.getSymbolAtLocation` **does** resolve JSDoc `@param {User}` and `@returns {User}` type-reference identifiers to their `InterfaceDeclaration` when the AST is walked with the public `node.getChildren(sourceFile)` API (which includes JSDoc). Resolution: all identifier traversal in `packages/ingest` uses a pre-order DFS over `node.getChildren(sourceFile)`; `ts.forEachChild` + `.jsDoc` is banned for identifier discovery.

**Why:** The spec's BS1 threshold is explicit — "if the workaround is no more than a different TypeChecker/AST method, continue." Switching `forEachChild`→`getChildren` is exactly a different AST method. The substrate (TS Compiler API) is sufficient for reference-aware rename including JSDoc; the bail signal correctly prevented a papered-over probe but the wall was illusory.

**Design-doc impact:** none — confirms the design's premise rather than changing it. Strengthens spec § "Open questions" Q1: TypeChecker accuracy is adequate for JSDoc type references.

**Revisit when:** a later identifier-bearing construct (e.g. template literal types, satisfies expressions) is missed by `getChildren` traversal — re-probe before assuming a wall, same as here.

## 2026-05-15 — Identifier lowering stops at TypeScript identifiers

**Context:** Phase 1 Task 3 added identifier-level ingest for `rename_symbol`, which needs addressable nodes for declaration and reference occurrences without turning the whole AST into graph rows.

**Considered:**
- Emit every `ts.Identifier` under each statement, including declaration names, type references, expression references, property names, and JSDoc identifiers surfaced by the TypeScript AST.
- Emit only rename-candidate identifiers after TypeChecker resolution.
- Add deeper expression/property-access lowering immediately.

**Decided:** Emit every `ts.Identifier` occurrence under a statement as an `Identifier` node with `{ text, offset }`, while leaving string literals, template literal text, and ordinary comment text out of the identifier layer. Identifier rows are non-renderable until the render splice work lands.

**Why:** The raw statement payload remains the canonical render path for now, and a shallow identifier layer is enough for Phase 1 rename resolution. Deferring filtering until Task 4 keeps ingest simple and lets the TypeChecker decide which identifiers are real references.

**Design-doc impact:** none — this locks in the Phase 1 plan's identifier emission boundary without changing the broader node graph direction.

**Revisit when:** later mutations need property-access member renames, expression-level edits, or comment-aware transformations outside JSDoc.

## 2026-05-15 — Stable node IDs use path plus structural child path

**Context:** Phase 1 Task 1 needs deterministic node IDs before identifier-level ingest and rename operations can preserve identity across non-structural mutations.

**Considered:**
- Path + structural-position hash: `modulePath`, dot-joined child index path, and node kind.
- Content-anchored IDs based on source text or syntax-node content.

**Decided:** Use `sha1(modulePath + ":" + childIndexPath + ":" + kind)`, truncated to 16 hex characters, implemented as the single `nodeId()` helper in `@strata/store`.

**Why:** This is deterministic across re-ingest of unchanged files and stable across Phase 1 rename mutations, which only change identifier text and do not alter parent/child shape. Content anchoring would better survive statement insertion, but it is more work than Phase 1's rename slice needs.

**Design-doc impact:** none yet — this resolves a Phase 1 plan-level open choice without changing the design direction.

**Revisit when:** operations need identity stability across structural edits such as inserted statements or moved declarations.

## 2026-05-14 — EOF trivia stored as a sibling `EndOfFileTrivia` node, not on the module

**Context:** Phase 0 ingest review found trailing trivia (comments/whitespace between the last statement's end and EOF) was silently dropped because `sourceFile.statements` doesn't include the `endOfFileToken`. A real codebase with a trailing footer comment would round-trip lossy without ingest noticing.

**Considered:**
- (a) Add a synthetic child node of kind `EndOfFileTrivia` at the highest `childIndex`, with the trivia text as its payload.
- (b) Attach the trivia to the module node (e.g., JSON-encode `{ path, trailingTrivia }` into the module payload).

**Decided:** (a). The module payload stays a plain string label, and rendering — which already orders children by `childIndex` — concatenates the trivia naturally as the last child.

**Why:** Keeps the module payload schema simple (still just a path string), avoids special-casing module payload parsing in render, and produces byte-identical round-trip on the new comment fixture and on all examples/small/*.ts. The trade-off is one extra node per module and a non-statement kind in the child list — fine because `EndOfFileTrivia` is structurally just another payload-bearing child for Phase 0.

**Design-doc impact:** none yet — Phase 0 is intentionally pre-schema. Lock in when the formal node-graph schema is written for Phase 1.

**Revisit when:** statement-level lowering lands and ingest no longer stores raw source text per child. The lowering for EOF trivia will probably remain "verbatim text" since it has no semantic structure, but the node kind may want renaming once other trivia kinds (between-statement comments, JSDoc) get their own representation.

## 2026-05-14 — Verify uses in-process TypeScript Compiler API, not subprocess `tsc`

**Context:** Phase 0 CLI initially shelled out to `npx tsc --noEmit` with hard-coded compiler options that didn't match `tsconfig.base.json`. Three problems: (1) PATH-dependent `npx` resolution, (2) the rendered output was being type-checked under different settings than the project's own build, (3) it contradicted the 2026-05-14 "TS Compiler API everywhere" decision logged below.

**Decided:** Verify is now in-process: `ts.createProgram([outputPath], options)` + `ts.getPreEmitDiagnostics(program)`. Compiler options are loaded from `tsconfig.base.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. No subprocesses anywhere in `packages/cli`.

**Why:** Consistency with the parser/printer decision; one toolchain for parse, print, and verify. Also faster (no `npx` cold start), and the rendered output is checked under the same compiler options that the project's own packages build under.

**Design-doc impact:** Consistent with strata-design.md § Verify ("TypeScript Compiler API for in-process type checks"). The design doc was already correct — Phase 0's first cut diverged and has now been brought back in line.

**Revisit when:** multi-file verification is needed (Phase 2). The current implementation only type-checks the single rendered file; Phase 2 will need program-level verification across all rendered modules.

## 2026-05-14 — Use TypeScript Compiler API for parse + print in Phase 0 (drop tree-sitter and Prettier)

**Context:** Phase 0 bootstrap. The design doc specifies `tree-sitter-typescript` for parsing and `prettier` for canonical rendering, with the TS compiler API reserved for type-checking in `verify`.

**Considered:**
- tree-sitter + Prettier as specified.
- @swc/core (fast Rust parser with a built-in printer).
- TypeScript Compiler API (`typescript` package) for both parse and print, with Prettier added later only if style needs tightening.

**Decided:** Use the TypeScript Compiler API for both parse and print in Phase 0. No tree-sitter, no swc, no Prettier yet.

**Why:** The design's stated reason for tree-sitter is "round-trip preservation," but Strata renders canonically and discards original formatting — that benefit is moot for our pipeline. Meanwhile `verify` already needs the TS compiler API, so using it as the parser too collapses three toolchains into one. `ts.createPrinter()` produces serviceable canonical output; Prettier can be a post-pass when we have a reason to add it. Cuts dependencies, install time, and conceptual surface for a phase whose only goal is proving the pipeline.

**Design-doc impact:** Supersedes the Tech stack § "Parser" recommendation and the Render § "prettier" line *for Phase 0*. Will revisit at Phase 1 boundary; if expression-level lowering reveals TS-printer output to be inadequate, reopen.

**Revisit when:** (a) we need richer formatting control than `ts.createPrinter()` provides; (b) ingest perf becomes a bottleneck (swc); (c) we need incremental reparse for live editing (tree-sitter).
