# Phase-6 Live Multi-Agent Comparison Design

**Status:** Proposed; no production implementation or live-model execution is
authorized by this document

**Date:** 2026-07-16

**Scope:** The first falsifiable live comparison after the integrated
deterministic full key-free coordination gate

## Purpose

Test one narrow question:

> On six pre-registered, stable-ID TypeScript task pairs, can two independent
> agents using Strata's Rust/redb authority reach one shared green codebase with
> less elapsed time and total agent cost than two matched Git-worktree agents
> followed by an integration agent, without any correctness or authority
> failure?

The experiment tests coordination, not task decomposition. The harness assigns
the same two already-defined tasks in both arms. Strata does not decide which
task exists, which agent receives it, or how a larger request should be split.

This design does not authorize a keyed run. A live run requires a second,
explicit operator approval of the exact model, trial count, turn limits, wall
limits, per-query dollar limit, and projected round maximum after the
deterministic implementation gate passes.

## Governing criteria

The experiment is governed by the Phase-6 kernel design, the integrated full
key-free acceptance gate, and the following decision rules:

1. The outcome is one shared, externally verified green codebase, not two
   locally completed tasks.
2. Both arms use the same source commit, corpus, task semantics, model,
   provider, per-role prompt body, per-session bounds, external verifier, and
   semantic acceptance criteria.
3. The baseline consists of two independent task worktrees and a third
   integration-agent session. Integration-agent time, tokens, and dollars are
   part of the baseline result.
4. The Strata arm consists of two independent model sessions connected only to
   a Rust-owned coordination service. Neither session receives filesystem
   tools, a redb path, canonical graph bytes, resource keys, clocks,
   reservations, fences, or publication authority.
5. Lost updates, dirty reads, partial commits, stale publication, invalid final
   code, manual intervention, or an authority-boundary escape are dispositive
   failures. A fast or cheap result cannot offset one.
6. The primary measurements are elapsed time and total model cost from team
   dispatch to the end of shared final verification.
7. The deterministic full key-free gate is additive and unchanged. Live-run
   convenience may not weaken it or make test-only injection available in a
   default build.

## Repo-grounded starting point and gaps

| Concern | Integrated repository provides | Missing for a fair live comparison |
| --- | --- | --- |
| Canonical authority | Rust/redb owns graph generations, resource keys, dependency clocks, scheduling, reservations, fencing, containment, candidate digests, publication, history, and recovery. | A process boundary through which independent live clients can request bounded lifecycle actions without linking the crate or opening redb. |
| TypeScript semantics | The one-shot Node bridge analyzes real `rename_symbol` and `add_parameter` intents and returns bounded semantic facts or validated graph deltas. | A service host that invokes the bridge privately and never exposes worker configuration or canonical storage to clients. |
| Deterministic coordination | Twelve full key-free rows cover real disjoint and overlapping work, dynamic scope expansion, FIFO/aging, crash recovery, optimistic rebase, fencing, composite publication, replay, containment, and default-build sealing. | Deterministic service/protocol, multi-process client, harness, and artifact tests. The existing dynamic-expansion row uses a feature-gated G+1 publisher and is not itself a live task. |
| Current Strata agent | `packages/agent/src/runAgent.ts` creates or opens SQLite directly; `createStrataTools` binds all twenty tools to that SQLite context. `runLiveSession` is hermetic and records turns, tool calls, tokens, cost, and terminal state. | A coordination-specific MCP surface and a generic hermetic session wrapper that can use it without giving the session SQLite or filesystem access. The SQLite product path must remain unchanged. |
| Current baseline | `packages/agent/src/runBaseline.ts` runs one Claude Code session in one materialized temp tree and verifies it. | Two task worktrees, deterministic capture of their outputs, an integration worktree and integration-agent session, shared-team timing, and failure attribution. |
| Current benchmark | `packages/bench/src/runner.ts` records per-session cost/time and always runs substrate before baseline. | Seeded counterbalancing, simultaneous task-agent launch within an arm, team makespan, integration cost, kernel/service events, final-state digests, a pre-registered failure taxonomy, and immutable manifests. |
| Tasks and scoring | `examples/medium`, real stable IDs, TypeScript validation, Vitest support, and text/semantic criteria for prior tasks. | Six matched two-task packets required by the governing design, task-specific semantic assertions, a dynamic-expansion qualification rule, and one arm-neutral final verifier. |
| Budget control | The installed Agent SDK supports `maxTurns`, wall-time cancellation, `maxBudgetUsd`, and reports model usage/cost. | Manifest-enforced per-query dollar limits, a projected round maximum, a stop-before-next-session cumulative guard, and explicit operator approval. |

The external service boundary is therefore required. Running Node clients in
the Rust process is not possible; letting each Node process open redb would
violate the authority boundary; and giving each client an in-process kernel
would not create one shared authority.

## Experimental unit

A **matched trial** is one task packet run once in each arm. It contains:

- one immutable source commit and `examples/medium` content digest;
- two task definitions and task-specific acceptance checks;
- one model/provider/configuration tuple;
- one pre-registered arm order and launch seed;
- one Strata team run and one worktree-baseline team run;
- one final verifier version and configuration; and
- complete artifacts for both arms, including failures.

The six task packets are separate scenarios. Results are reported by scenario
and as an explicitly labeled aggregate. They are not pooled as interchangeable
independent samples.

## Arms

### Strata coordination arm

1. Before the clock starts, the harness ingests the exact corpus, resolves the
   task targets to stable logical IDs, starts one Rust service over a fresh redb
   database, and waits for its ready record.
2. The harness launches two independent Agent SDK processes concurrently. Each
   receives only its own task, the shared task-body prompt, an arm-specific tool
   appendix, and a service endpoint/client credential. It does not receive the
   other task.
3. Each process has only the coordination MCP server. It may inspect bounded
   node projections, create typed intent change sets, submit them, ask the
   service to advance ready work, read/acknowledge coordination events, cancel
   obsolete work, and create a replacement change set after a fresh decision.
4. Rust assigns logical ticks, derives scope and keys, grants and fences claims,
   invokes Node semantic work, contains deltas, publishes canonical generations,
   and emits the event history. Claim handles and fences stay inside the
   service.
5. The team succeeds only after both task predicates hold in one canonical
   graph and the external verifier passes the rendered shared state.

No integration agent is added to this arm. Reconciliation is the mechanism
under test.

### Git-worktree baseline arm

1. Before the clock starts, the harness creates two clean independent task
   worktrees and one clean integration worktree from the same source commit.
2. It launches two independent Claude Code sessions concurrently, one in each
   task worktree, with the same model/provider/session bounds and the same task
   body as the corresponding Strata client. Only the arm-specific tool appendix
   differs.
3. After both task sessions terminate, the harness mechanically captures each
   complete tree as a standardized branch commit. This is deterministic
   orchestration, not human integration. Empty or invalid results are preserved.
4. A fresh integration-agent session starts in the integration worktree. It
   receives both task specifications and branch names, integrates both results,
   resolves conflicts or incomplete task work, and runs no privileged scorer.
   It may use the normal Claude Code file and shell tools.
5. The same external verifier runs on the integration worktree. The baseline
   clock includes the task phase, capture phase, integration-agent phase, and
   final verification.

The integration agent runs even when a task branch is incomplete if the branch
can be captured. If it completes missing task work, that time and cost remain
part of the baseline. Provider-level failures that produce no usable session
artifact follow the infrastructure rerun rule below.

## Minimal Rust service boundary

### Transport and ownership

Use one single-host Rust daemon and a versioned request/response protocol over a
Unix domain socket. The socket is an experimental local boundary, not a public
network API. It deliberately excludes TCP, remote authentication, discovery,
multi-host operation, and consensus.

The daemon process is the only process that:

- opens the redb database;
- owns the `Kernel` and its service epoch;
- assigns monotonic logical ticks used by coordination calls;
- owns bridge worker configuration and launches Node bridge processes;
- retains claim/fence handles between client actions;
- renders/captures the canonical final state for privileged harness scoring;
  and
- appends a hash-chained service audit stream.

The harness is privileged setup/scoring infrastructure and may create the
database and service process. Model clients are unprivileged and receive only
the socket endpoint and a per-client opaque identity token.

### Client-visible operations

The version-1 client API is intentionally small:

- `inspect_nodes`: return payloads and bounded immediate relationships for a
  caller-supplied list of stable node IDs, subject to response limits;
- `begin_change_set`: create an actor-bound draft with reasoning;
- `add_intent`: add `rename_symbol` or uniform-value `add_parameter` typed
  parameters to that draft;
- `submit_change_set`: analyze and schedule the draft;
- `advance_change_set`: have the service claim and execute current ready work,
  or return `queued`, `needs_decision`, `validation_failed`, or terminal state;
- `read_events` and `ack_events`: use the durable per-client event cursor; and
- `cancel_change_set`: release obsolete work before creating a replacement.

The service may expose status fields already safe in the public coordination
model: change-set ID/state, ticket state, graph generation, event sequence,
operation ID, affected stable node IDs, bounded diagnostics, and final
publication digest. It must not expose inferred resource keys, reservation
sets, dependency clocks, scope fingerprints, service epochs, attempt IDs,
claim handles, fences, candidate deltas, bridge requests, redb paths, or worker
configuration.

Client requests never contain a logical tick. The daemon assigns it. They also
never contain scope, keys, clocks, reservations, dependency versions, policy,
fencing, candidate digests, or graph deltas.

### Protocol safety

The protocol has strict schemas, bounded frame/request/response sizes, request
IDs, client/change-set ownership checks, deadlines, one response per request,
and fail-closed handling of malformed or duplicate requests. Mutating requests
use durable idempotency keys so reconnect/retry cannot duplicate a change set,
intent, cancellation, or publication.

An unavailable client does not hold publication authority. A service restart
opens the same redb database, advances the service epoch, recovers coordination,
fences any in-memory claim, and lets clients resume through durable events.

### Default-build sealing

Production service code uses only normal kernel APIs. Existing failpoints,
fixture publishers, raw storage accessors, and test hooks remain behind their
current test features. Compile-fail/default-build tests must prove that the new
service and Node client packages cannot reach raw publication or test
injection. The existing `kernel:full-key-free:test` command remains unchanged
and green.

## Task packets

All targets are resolved from the trial's ingest snapshot and recorded in the
manifest. Model clients receive stable node IDs and human-readable semantic
descriptions, not resource keys. Baseline agents receive equivalent module and
symbol locators because files are their native interface.

Only `rename_symbol` and uniform-value `add_parameter` are allowed. No task
inserts, deletes, or moves a structural node. The unchanged declaration or
statement keeps its stable logical ID.

### D: disjoint propagation

- Agent D1: rename exported interface `User` to `Account` everywhere.
- Agent D2: rename exported function `formatTimestamp` to `renderTimestamp`
  everywhere.

Acceptance requires both declarations and all references to use the new names,
no old symbol reference to remain, exact task-specific tests to pass, and the
shared tree to be green. The deterministic gate already proves these scopes can
publish in both orders.

### M: same-module, disjoint nodes

- Agent M1: rename `logEvent` to `recordEvent` everywhere.
- Agent M2: rename `eventLine` to `formatEventLine` everywhere.

Both declarations start in `src/server/events.ts` but neither refers to the
other. Acceptance requires both declarations/references to use the new names,
the original names to be absent from their respective symbol closures, and the
shared tree to be green. Deterministic qualification must prove the kernel
infers disjoint reservation scopes and can make both ready concurrently; if
module-wide validation makes them overlap, stop and return for review rather
than relabeling the scenario.

### R: reference-mediated shared symbol

- Agent R1: rename exported interface `User` to `Account` everywhere.
- Agent R2: add parameter `excited: boolean = false` at position 1 of `greet`
  using the uniform-value `add_parameter` operation.

The `greet` signature already references `User`, so Rust must infer overlap
before mutation. Acceptance requires `greet(user: Account, excited: boolean =
false)`, all direct callsites (if any) to receive the uniform argument exactly
once, all User references to become Account, and the shared tree to be green.

### S: compatible same-node overlap

- Agent S1: rename `greet` to `welcomeUser` everywhere.
- Agent S2: add parameter `excited: boolean = false` at position 1 of the same
  stable `greet` function node.

Both operations mutate the same declaration node but have compatible final
intent. Acceptance requires the stable declaration ID to survive both orders,
the final signature to be `welcomeUser(user: User, excited: boolean = false)`,
all references/calls to use the new name and argument exactly once, explicit
ordering or fresh-state reanalysis, and a green shared tree.

### X: dynamically expanding reference

- Agent X1: rename `logEvent` to `recordEvent` everywhere.
- Agent X2: add parameter `fallbackLine: string = logEvent(0, "idle")` at
  position 1 of `eventLine` using uniform-value `add_parameter`.

At generation zero, `eventLine` does not reference `logEvent`. If X2 publishes
first after X1's analysis, X1's fresh analysis must discover the new reference,
expand scope, requeue before candidate construction, and ultimately produce
`fallbackLine: string = recordEvent(0, "idle")`. If X1 publishes first, X2 must
observe current state and replace its obsolete typed intent rather than publish
an unresolved stale name.

This packet is admitted to live execution only if a deterministic preflight on
the exact ingest-derived IDs proves both publication orders reach the same
green result and the X2-first choreography emits `ScopeExpanded` before X1
candidate construction. If the current operation semantics cannot satisfy that
gate without a feature-gated publisher or task-specific production hook, X is
excluded and the live design returns for operator review. It is not replaced
silently, and the experiment may not claim dynamic live coordination.

Whether an organic live trial actually takes the expanding ordering is recorded
as `dynamic_scope_observed`. Absence of that event is not relabeled as proof of
dynamic behavior.

### G: grouped only-green-together change

- Agent G1: in one ordered change set, rename `User` to `Account` and add
  parameter `account: Account = undefined as never` at position 1 of `greet`.
- Agent G2: rename `formatTimestamp` to `renderTimestamp` everywhere.

The G1 `add_parameter` intent alone is invalid because `Account` is unresolved;
the ordered rename plus parameter addition must validate and publish as one
generation and one aggregate operation. G2 is a separately assigned disjoint
task from the second independent agent. Acceptance requires the composite to
publish exactly once, the standalone negative control to publish nothing, the
timestamp rename to remain present, all stable IDs to survive, and the final
shared tree to be green.

## Prompt equivalence

Each task prompt is generated from:

1. a byte-identical task body containing intent, constraints, semantic target,
   and success predicate;
2. a role-neutral instruction to finish its assigned task and leave the team
   able to reach the shared predicate; and
3. an arm appendix explaining only the available interface.

The Strata appendix explains stable IDs and coordination tools. The baseline
appendix explains the assigned worktree and normal file tools. Neither contains
advice about the other agent's task or expected conflict. Prompt bytes and
hashes are artifacts. Any necessary arm-specific semantic hint must be added to
both task bodies or the packet is invalid.

## Verification

The final verifier is outside all model sessions and has no repair capability.
For each arm it:

1. materializes the final shared TypeScript tree in a fresh verification
   directory (canonical render for Strata; integration worktree copy for the
   baseline);
2. confirms the source digest started from the registered corpus;
3. runs the same `tsc --noEmit` configuration and the same Vitest suite;
4. evaluates task-specific AST/text predicates for both assigned tasks;
5. detects duplicate arguments, residual old references, missing new
   references, and unexpected out-of-scope semantic changes;
6. records stdout/stderr, exit codes, durations, and content digests; and
7. performs a Strata-only authority audit against the canonical operation log,
   graph generation sequence, event history, and final digest without giving
   those details to the model clients.

The arm succeeds only if every common check passes. A Strata authority-audit
failure is additionally dispositive.

## Measurements and accounting

### Primary outcomes

- `shared_green`: boolean, after all dispositive checks.
- `time_to_shared_green_ms`: monotonic time from release of the two task agents
  to successful completion of the external verifier.
- `total_agent_cost_usd`: sum of every model-session reported dollar cost in
  the arm. This is two sessions for Strata and two task sessions plus the
  integration session for the baseline.

Time includes queue wait, retries within a session, deterministic branch
capture, baseline integration, service/client orchestration, and final
verification. Pre-trial dependency installation, corpus ingest, worktree
creation, daemon startup, and model warm-up checks are setup and recorded
separately, not included. Both arms use a ready barrier before their clock.

### Secondary outcomes

- total input, output, cache-read, and cache-creation tokens;
- total API duration and per-role/model usage;
- task phase makespan, integration-agent time/cost, and final verification time;
- Strata queue wait, requeue count, fresh-decision count, scope expansions,
  publication generations, and service restarts;
- tool calls, model turns, timeouts, validation failures, and cancellations;
- baseline merge conflicts, integration commands, changed paths, and repair
  edits; and
- correctness/failure taxonomy counts.

Failed trials retain elapsed time/cost to failure and are not assigned an
invented success time. With the proposed small N, results are tables and paired
observations, not null-hypothesis significance tests.

## Ordering and randomization

Arms run sequentially to avoid local CPU/disk contention and simultaneous API
load. Within an arm, its two task agents launch concurrently behind one barrier.

A recorded seed creates:

- exactly balanced AB/BA arm order across the six-scenario pilot, then
  alternated within each scenario across later repetitions (an odd per-scenario
  count may differ by one);
- a seeded scenario order per repetition; and
- a stable mapping of task A/B to process launch order.

The seed and complete schedule are written to the manifest before a keyed call.
No result-dependent reordering is allowed. Caches and reported cache-token
fields are retained rather than manually cleared mid-round; ephemeral session
directories prevent accidental conversation reuse.

## Recommended first live stage

The first keyed stage is a falsification pilot, not a performance claim:

- provider: Anthropic Claude Agent SDK for both arms;
- model: `claude-sonnet-4-6`, the repository's current live-agent and benchmark
  default;
- trials: one matched trial for each of D, M, R, S, qualified X, and G;
- task and integration sessions: `maxTurns=25`, `wallTimeMs=240000`, and
  `maxBudgetUsd=0.75` each;
- team wall deadline: 480,000 ms in both arms, including final verification;
- maximum model sessions: 30 (twelve Strata task sessions, twelve baseline task
  sessions, and six baseline integration sessions);
- sum of configured per-query budgets: USD 22.50; and
- proposed operator-approved projected round maximum: USD 30.00, retaining a
  USD 7.50 reserve because a provider call can cross a query budget before the
  SDK returns its budget terminal result.

The harness stops before launching another session when accumulated reported
cost reaches the approved round maximum. Because the two task sessions in an
arm start concurrently, the manifest must state that the round maximum is a
projected bound rather than a transactionally enforced billing ceiling.

If the pilot is clean, a later directional comparison may extend to three total
matched trials per scenario. That is a new live run requiring separate approval
of its exact remaining session count and spend. The pilot cannot support a
claim that one arm is faster or cheaper in general.

These are recommendations, not authorization. The operator may select another
available model or bounds, but the exact same selection must be used for all
task and integration sessions in both arms. Changing a parameter after a model
call starts invalidates the round.

## Failure taxonomy

### Dispositive correctness/authority failures

- `lost_update`
- `dirty_read`
- `partial_commit`
- `stale_publication`
- `invalid_final_code`
- `task_predicate_missing`
- `manual_intervention`
- `authority_escape`
- `canonical_history_mismatch`
- `unexpected_out_of_scope_change`

Any one makes the arm and matched trial unsuccessful and stops the live round
after evidence is flushed.

### Coordination/task failures

- `task_agent_timeout`
- `integration_agent_timeout`
- `team_timeout`
- `max_turns`
- `max_budget`
- `needs_decision_unresolved`
- `candidate_validation_failed`
- `integration_failed`
- `dynamic_scenario_not_exercised`

These are genuine observed failures, not automatically rerunnable noise.

### Infrastructure/harness failures

- `provider_unavailable`
- `provider_rate_limited`
- `agent_process_crash`
- `service_process_crash`
- `artifact_write_failed`
- `harness_invariant_failed`
- `verifier_infrastructure_failed`

An unexpected service crash is a Strata-arm failure unless recovery completes
within the same team deadline and all authority checks pass; both the crash and
recovery remain reported. A harness or verifier defect discovered after model
output is preserved and stops the round. No silent rerun is allowed.

A provider outage or rate limit may receive one rerun only when the session
produced no assistant content, no tool call, no source/canonical mutation, and
no billable result. The original attempt remains an artifact. Any other rerun
requires a new manifest and operator approval.

## Stop conditions

Stop deterministic implementation and return for operator review if:

- the service cannot keep redb, ticks, claims, fences, bridge configuration,
  candidate deltas, and publication wholly server-side;
- a client must enumerate a resource/reservation key or inspect canonical
  storage directly;
- X cannot pass its exact deterministic two-order preflight with stable IDs;
- final verification cannot be made byte-for-byte equivalent in semantics
  across arms;
- baseline integration cannot be captured without human action;
- the existing SQLite product path or deterministic full key-free gate would
  need weakening; or
- SDK/provider settings cannot apply the same model and per-session bounds to
  all three baseline roles and both Strata clients.

Stop a live round immediately after artifact flush if:

- any dispositive failure occurs;
- manual repair or an unregistered prompt/config change would be required;
- the approved cumulative projected spend is reached before the next session;
- a task, scorer, source, model, provider, or schedule digest differs from the
  pre-registered manifest;
- an infrastructure defect makes either arm unscorable; or
- credentials for different providers/accounts would make accounting
  incomparable.

## Artifacts

Every run directory is immutable after finalization and contains:

- `experiment-manifest.json`: schema version, repository/source/task/verifier
  digests, model/provider, all bounds, projected spend, seed, precomputed
  schedule, package versions, machine metadata, and approval record;
- `tasks/*.json`: stable IDs, baseline locators, prompt bodies/appendices and
  hashes, intent parameters, and acceptance predicates;
- `trials/<trial-id>/<arm>/team.json`: timestamps, status, costs, tokens,
  timeouts, failures, and final verification summary;
- `sessions/<session-id>.jsonl`: existing agent log events plus role, trial,
  task, arm, and monotonic harness timestamps;
- `service.jsonl`: request metadata, daemon-assigned ticks, state transitions,
  kernel event sequences, restart/recovery records, and hashes without secrets
  or redb contents;
- `kernel-events.jsonl` and `canonical-audit.json`: bounded event history,
  generations, operation metadata, affected stable IDs, and final digests;
- `git-events.jsonl`: worktree creation, branch capture, integration commands,
  commits, conflicts, and final tree digest;
- `verification.json` plus raw bounded stdout/stderr files;
- final Strata render and baseline integrated tree as evidence snapshots; and
- `summary.json` and `summary.md` generated only from finalized trial records.

Artifact schemas are strict and versioned. Timestamps use both wall-clock ISO
strings and monotonic offsets; ordering claims use monotonic offsets and kernel
event sequences, not wall-clock timestamps. Secrets, environment values,
credentials, socket tokens, and raw model authentication data are redacted.

## Claims this experiment can support

If the deterministic gate and live trials pass, the evidence may support:

- two independent agents can use the tested Strata service to publish the
  tested stable-ID operations into one shared, externally green codebase;
- the tested authority boundary avoided the registered correctness failures;
- observed paired time and model-cost differences for D, M, R, S, X, and G
  under the exact model, prompts, bounds, corpus, and machine; and
- observed baseline integration overhead and Strata coordination/requeue
  behavior.

## Claims this experiment cannot support

It cannot establish:

- general superiority across repositories, models, providers, prompts, task
  sizes, or operation classes;
- statistical population-level performance from one or three repetitions;
- production reliability, security hardening, multi-host scale, or consensus;
- structural insert/delete/move concurrency;
- multi-language, human-agent, or long-lived product compatibility;
- that single-site synthesis is a token or cost win;
- causal attribution to redb rather than the complete Strata interface; or
- a claim of dynamic live coordination unless `ScopeExpanded` is observed in a
  qualified live X trial.

## Explicit scope exclusions

- no task decomposition, assignment, prioritization, or orchestration by
  Strata;
- no structural insert/delete/move operation;
- no change to stable logical-ID or operation-log invariants;
- no replacement or removal of the SQLite product path;
- no FUSE, Git integration inside Strata, language expansion, remote client,
  multi-host consensus, human-compatibility layer, or production distributed
  deployment;
- no benchmark tuning based on unblinded live results; and
- no live call during design, implementation, deterministic testing, or dry
  run.

## Approval gates

1. **Design/production-code approval:** approve this service boundary, task
   packets, fairness rules, metrics, and stop conditions before production code
   changes.
2. **Deterministic implementation gate:** all new behaviors begin with failing
   tests; the service/client/harness/task/verifier suites, existing repository
   tests, unchanged full key-free gate, and default-build sealing pass; evidence
   and one independent repo-grounded review are complete; worktree is clean.
3. **Live budget approval:** approve the exact provider/model, qualified task
   set, trial count, seed, `maxTurns`, wall times, `maxBudgetUsd`, team deadline,
   projected maximum spend, and credential source. Approval is recorded in the
   manifest before any keyed process starts.
4. **Execution:** only then may the pre-registered live command run.
