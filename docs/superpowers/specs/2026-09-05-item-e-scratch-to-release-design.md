# Item E — ten-agent scratch-to-release scenario

Status: independently reviewed draft; fixture/schedule qualification pending,
2026-09-05. This document scopes the next
research build. It does not authorize live calls or declare Item C implemented.
Governing constraints: `strata-design.md`, `decisions.md`, and
`docs/product-roadmap.md` Iteration 6. The original Phase-6 results retain their
original substrate, task manifest, and scope.

## Question and proposed application

Can ten independently running agents build a small TypeScript application to
one verified release through the shared kernel, with less integration overhead
than the same workers on Git worktrees plus integration agents?

Build **Task Ledger**, a dependency-free Node application for managing a local
task list. Its public interface is a JSON request/response CLI; its domain API
is also importable. Records have an ID, title, status (`todo`, `doing`, `done`),
integer priority (0–3), and sorted unique string tags. Commands create, update,
remove, query, summarize, export, and import records. Disk persistence is a
versioned JSON document with atomic replacement. IDs and clocks are injected
at the domain boundary so fixtures are deterministic. No network, accounts,
UI, server deployment, package publishing, or task orchestration inside Strata.

Target size is 800–1,500 application lines across approximately 8–12 modules.
Size is disclosed, not scored. Release means an offline build and executable
artifact passing the frozen acceptance below, not a registry publication.

The operator may revise the application before task/fixture registration. Once
registered, task changes invalidate the registration and require a new review;
results cannot be rescued by narrowing acceptance after an agent runs.

## Starting state and meaning of scratch

Both arms start with zero application implementations. A byte-identical
bootstrap provides package metadata, lockfile, strict TypeScript configuration,
test/build tooling, immutable fixtures, and one `export {}` module. This is
disclosed tooling scaffolding, not a prebuilt domain skeleton or solution. The
single module is necessary because `runCorpusAcceptanceBounded` currently
rejects an empty rendered module map (`packages/verify/src/corpusRun.ts`).
No target IDs or implementation declarations are handed to Strata agents;
they discover the bootstrap module through the typed client.

Both arms receive the same API contract, examples, task packets, and test
specification. Exact API signatures, error vocabulary, command grammar, and
fixture bytes must be committed and digested before implementation of the
scenario harness is accepted. The contract is an interface specification;
it must contain no reference implementation or prescribed statement bodies.

## Ten fixed work packets

The external harness launches all ten workers at one dispatch barrier. It
assigns each packet once, records dependencies, and relays bounded completion
notices. Workers may draft before dependencies publish; scheduling tasks is
never a kernel responsibility. Ten active sessions does not imply ten
simultaneously runnable publications; report actual concurrency and idle time.

| Worker | Deliverable | Prerequisites for integrated use |
| --- | --- | --- |
| W1 | Record and command types; runtime input validation; error vocabulary | none |
| W2 | Immutable create/update/remove operations with injected ID source | W1 |
| W3 | Status transitions, priority changes, and tag updates | W1, W2 |
| W4 | Query predicates and stable sorting/pagination | W1 |
| W5 | Counts by status, priority summaries, and tag summaries | W1 |
| W6 | Versioned JSON codec; strict import validation and duplicate-ID rejection | W1 |
| W7 | Persistence adapter: load, atomic save, missing/corrupt document behavior | W6 |
| W8 | JSON command parser and dispatcher | W1–W6 |
| W9 | CLI entry and consistent stdout/stderr/exit behavior | W7, W8 |
| W10 | Public API composition and end-to-end workflow integration | W2–W9 |

Each worker is responsible for repairing its deliverable after shared state
changes. W10 is a matched application task in both arms; it is distinct from
the baseline's extra Git integration role. Packets include explicit shared
module participation: W2/W3 both contribute to the task-operation module;
W4/W5 to the query/report module; W8/W9/W10 integrate the command/API surface.
Agents still choose their own implementation bodies. No task-specific delta
publisher or solution replay is allowed in a live arm.

Expected conflict density is moderate: three named shared-module clusters,
with W1's declarations referenced throughout. Before registration, a scripted
trace must demonstrate both disjoint progress and contention on the new
structural operations. Record observed inferred overlap, queueing, fresh
decisions, and baseline text conflicts. Shared filenames alone do not prove
semantic overlap. The final spec must name an exact same-node revision task
only if the fixed app requirements naturally require it; do not claim that
coverage from append contention alone.

## Continuous gate and final release gate

Feature completeness cannot be required at generation zero. Use two fixed,
separately named contracts, identical across arms:

1. **Publication safety:** strict source type-check plus an immutable behavioral
   construction suite that validates every present public capability. An absent capability
   is reported as absent, not passed. A present export with a wrong type,
   throwing implementation, malformed return, or incorrect behavior fails.
   Exceptions and failed imports never count as absence. The bootstrap has
   zero capabilities and passes only this safety contract.
2. **Release completeness:** all registered capabilities must be present, all
   behavioral cases run, and the complete CLI acceptance succeeds. No skip,
   missing export, TODO, `test.only`, or test/config mutation is accepted.
   A no-op run must fail this gate. The release gate cannot use agents' claims
   of completion as evidence.

The publication fixture set and its digest remain fixed through a service
incarnation; do not switch manifests per change set or start a daemon on a red
baseline. Capability checks are derived from actual exports in freshly rendered
modules, never an agent-maintained feature flag. The harness records coverage
for every publication. The scenario's admitted mutation vocabulary is append-only
creation/imports plus function-body replacement. Module names, declaration names,
signatures, and export visibility cannot be removed or revised after publication.
That makes the set of obligations monotonic without mutable completion flags.
Enforce this at the kernel's operation-admission and delta-containment boundaries,
not just by hiding tools in the model prompt. Existing rename/add-parameter
operations remain supported elsewhere but are unavailable in this scenario.
Any attempt to remove a required export, use runtime export reassignment, or
hide a failed import as absence must fail a discriminating key-free gate.
Presence is established from the parsed canonical export surface before running
tests; runtime failures are always failures. Public runtime capabilities must be
named function declarations; types are checked by generated consumer compilation.

Claim wording is **continuous publication safety plus final release
completeness**. Do not describe the empty bootstrap as an already functioning
application. Baseline private worktrees may be red during editing, as normal;
measure safety at the integrated baseline head. Its integrator must run the
same safety gate before advancing that head.

Final acceptance includes deterministic fixtures for every command; invalid
input and error exit codes; duplicate IDs; immutable domain operations; stable
query order and pagination; codec round trips; corrupt/missing disk state;
atomic-save failure preservation; a real spawned CLI create→update→query→
export→import workflow; and rebuilding/running the artifact in an isolated
directory with no repository access. The harness owns fixture/config digests
and checks them before and after each arm. Application runtime filesystem
access is allowed only inside the test sandbox; this grants no filesystem
tools to Strata's coding agents.

## Minimal kernel surface and Item C boundary

The current kernel and both wire schemas accept only rename and add-parameter
intents (`coordination/model.rs`, `coordination-client/src/protocol.ts`). The
current candidate worker dispatches only those operations. Existing SQLite
creation tools therefore do not make this scenario executable on the kernel.

Proposed additions, each requiring a reviewed semantic contract and deterministic
containment tests before any live use:

- `create_module(logicalName)` creates a module node in a project namespace.
  It accepts a bounded logical name, not a filesystem path. Render owns a
  collision-checked mapping to source artifact paths. Module namespace and
  absence observations participate in reservations and validation.
- `create_declaration(moduleId, declaration)` accepts exactly one parsed
  top-level function, interface, type alias, or variable declaration. Node
  parses language text, derives identifiers/references and an immutable delta;
  Rust verifies scope/containment and assigns or verifies canonical identity.
  Agents cannot supply raw node records, lock keys, offsets, or deltas.
- `add_import(moduleId, sourceModuleId, bindings)` resolves graph module
  identity to render paths. The scenario may also need explicit trusted Node
  builtin imports; arbitrary package installation remains outside the race.
- `replace_body(functionId, body)` lets workers repair published functions. It
  retains declaration identity, signature, name and export visibility, and
  requires fresh symbol-resolution/namespace validation. No general declaration
  replacement is admitted. Types and signatures follow the frozen API contract;
  errors in that contract stop qualification before live work.

Do not port all twenty SQLite tools. Delete/move are unnecessary for the initial
scenario unless the reviewed scripted solution proves otherwise. Creating a
third bridged operation triggers the recorded convergence decision: retain the
provisional SQLite product/kernel research split during this proof and record
the decision explicitly before implementation; no automatic product migration.

Item C must provide immutable opaque IDs separate from ordering, retain existing
16-hex IDs verbatim, and preserve surviving declaration and identifier identity
through unrelated insertions and supported revisions. Reconcile against the
existing canonical graph; do not infer lost history from stateless re-ingest.
Creation IDs must survive retry and restart without duplicate nodes. A change
set needs local symbolic handles for newly created modules/declarations so
related imports and definitions can be validated and published atomically.
These handles must not let a client mint canonical authority.

This is more than changing `ids.ts`: `store/src/resolveReferences.ts` currently
reconstructs reference endpoints from statement/identifier ordinal positions,
and `materializeGraph.ts` emits the same positional IDs. Both need a canonical
syntax-origin-to-logical-ID mapping. Likewise `coordination/analyzer.rs` currently
analyzes each intent against the same unchanged graph; references to objects
created earlier within a change set require a reviewed draft analysis model.

New imports, declarations, and shadowing change name resolution without
necessarily rewriting all dependents. Extend the validation-circle contract
before admitting them: namespace/absence, import/export membership, references,
parent ordering, and every affected resolution dependency must be versioned.
Whole-corpus tsc alone does not prove independent publication safe. Key-free
tests must force same-name concurrent creation, sibling insertion, dependency
drift, stale candidates, replay, and grouped only-green-together creation.

## Matched experiment and measurements

Strata: ten workers over `@strata-code/coordination-client`, through a thin
adapter, one daemon, full semantic scheduling and publication. Explicitly pin
binary, Node worker, validation manifest, and persistent-bridge flag. Default
proposal leaves the persistent bridge off. Any opt-in requires an explicitly
registered configuration and inherits no previous performance claim. SQLite
remains the product path.

Baseline: ten identical worker packets in separate Git worktrees, plus one
bounded, resumable integration agent owning the integration branch. Completed
packet submissions enter a FIFO queue (worker ID breaks simultaneous ties).
The integrator merges, repairs, and runs publication safety before advancing
the shared head; dependent workers receive that accepted head and update their
worktrees. Failed submissions remain visible and consume the same budgets.
Every accepted baseline head must also preserve previously present public
capabilities: compare its export surface with the previous accepted head and
reject removal, renaming, or signature/export loss, even if partial tests pass.
W10 owns application composition in both arms; this extra baseline role owns
Git integration. Include all integration time, model usage, retries, and repair.
This is eleven baseline agents versus ten Strata agents, not equal aggregate
resources. Qualify this schedule with the scripted dependency graph before
freezing it for live use.

Both arms use the same pinned model, worker limits, API requirements, dependency
notifications, corpus/toolchain, machine, and acceptance. Baseline workers may
read and edit files; Strata workers see the graph and registered fixtures. The
surface difference is the experimental variable and is disclosed. Baseline may
use ordinary Git and compiler tools; do not impose exact AST output or count
legitimate alternate implementations as failure.

Primary outcome: dispatch to one integrated artifact passing release acceptance.
Include discovery, queue wait, validation, integration, and export/packaging in
that clock. Also record daemon/ingest setup separately and provide inclusive
setup-to-release wall time for both arms. Failed/time-limited arms remain failed,
not paired successes. Report time-to-release only for completed arms alongside
success counts and full stopped-run records.

Secondary: safety of each integrated generation, capability completion over
time, total model cost/tokens, tool calls, validation attempts, queue wait,
actual concurrent candidates, manual interventions, process RSS, journal size,
restart time, and integration actions. Costs are descriptive; no synthesis
cost-win hypothesis. Do not claim parallel speedup without a separately
registered serial control. Any lost update, dirty read, partial publication,
authority bypass, or deletion of another worker's committed effect stops the
Strata arm and falsifies correctness irrespective of makespan.

D-3b measured journal/audit contention at ten actors. Capture those waits and
single-flight bridge queue wait under this workload before attributing latency
to model reasoning. Set bounded session/request/change-set limits in the
harness and measure retained state. A long-session leak or unschedulable queue
requires its own fix/review; no unregistered durability optimization in E.

## Gates and budget

1. Independently review the publication/completeness contract and baseline
   integration schedule; finalize exact API/fixtures/task packets.
2. Review and implement the minimal C/creation slices with real-corpus tests
   on `examples/medium` as well as the new application. Prove ID preservation,
   reference coherence, namespace conflict inference, and restart/retry safety.
3. Run a scripted ten-client application build through the real production
   semantic bridge, without model keys or direct canonical-store writes. Run
   the matched baseline integration schedule. Both must produce a releasable
   app; reject intentionally wrong and incomplete solutions using the same
   scorer. Inject overlap, crash/restart, drain, and duplicate deliveries.
4. Pass the full existing key-free chain and new discriminating acceptance;
   independently review the integrated implementation and artifact accounting.
5. Emit a dry-run registration with source/binary/toolchain/fixture/prompt
   digests, schedule seed, arm order, model ID, all ceilings, and exact projected
   maximum spend. Only explicit operator approval of that artifact unlocks
   a live run.

Provisional single-pair budget envelope: 20 worker sessions at at most USD 8
each, one resumable baseline integration session at USD 40, and USD 20 separately
accounted retry reserve: **USD 220 total**. This is a proposed spending cap,
not a price-derived forecast or approved spend. Initial worker bounds: 60 turns
and 20 minutes; integrator bounds: 160 turns and 60 minutes; per-arm wall cap:
90 minutes. Live approval must choose a supported model and current pricing,
prove the runner enforces the aggregate cap, and reconcile every retry with
these limits. No hidden replacement sessions or automatic N=3 extension.

Worker time limits count active execution, including tool calls and validation,
but exclude harness-declared dependency waits; all waits still count against
the 90-minute arm deadline and reported makespan. The harness records pause
boundaries identically in both arms. Qualification must prove the SDK/session
resumption and FIFO delivery can enforce this accounting before registration.

The first live study is one paired feasibility run with pre-registered arm
order. Report bounded feasibility and observed makespan, with no statistical
generality claim. Any repeated study requires its own falsifiable question,
registration and spending approval.

## Completion of this design slice

This slice delivers a reviewed scenario and explicit prerequisite decisions.
The scenario requires qualification before live use, including the kernel-enforced
monotonic vocabulary and matched baseline dependency integration. Native binary
packaging follows the actual embedding needs revealed
here. The write-up's publication venue remains a separate operator decision.

Independent read-only review used `gpt-6-astra` at `xhigh`. Final disposition:
no blocker to a reviewed draft, with fixture/schedule qualification pending.
Corrections incorporated: zero-implementation scaffold rather than zero graph;
separate immutable publication/release oracles; kernel-enforced preservation
of public capabilities; matching baseline monotonicity; disclosed extra
integrator resources; explicit dependency-wait accounting; persistent bridge
off. Source-grounded findings about current intent variants, resolver identity
reconstruction, and unchanged-generation intent analysis were checked against
the repository. This review does not close implementation or live-run gates.
