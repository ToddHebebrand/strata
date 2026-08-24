# Item D-3b Plan — Independent Codex Review Record

**Date:** 2026-08-24

**Reviewer:** Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only

**Input:** D-3b implementation plan v1, governing Item-D design, prior D-3
review archives, D-3a close decision, and repository source at `9a15096`.

## Verdict

**DO NOT PROCEED with v1.** The state shape and request-admission seam were
sound, but one sequencing blocker and several important test/lifecycle gaps had
to be corrected before implementation.

## Findings carried into v2

### Blocker

1. Task 3 required successful waited stop and idle daemon exit before Task 4
   replaced the blocking `listener.incoming()` loop. Those tests could not pass
   in the proposed sequence. Positive-wait and process-exit behavior must be
   implemented and tested with the poll loop in Task 4; Task 3 is limited to
   protocol, health, and acknowledge-only stop behavior.

### Important

1. A socket peer that stops reading is not a deterministic response-flush
   oracle: a small Unix-domain-socket response can fit in the kernel buffer.
   Use a feature-gated barrier immediately before the write/flush attempt and
   observe the active/stop guard on both sides of that barrier.
2. Signal handling needs process-global ownership, atomic wake-fd publication,
   transition-time signal masking, prior-handler restoration, and explicit
   restore/clear-before-pipe-close ordering. Otherwise concurrent registration
   or fd reuse can direct a signal write to the wrong descriptor.
3. The forced-exit worker test would not exercise a persistent worker as
   written because the bridge defaults off. Start with `--persistent-bridge`,
   discover the actual child PID, and prove that PID is gone after forced exit.
4. The historical measurement runner cannot be unchanged at the transport
   level: `db15b38` uses protocol v1 one-shot requests, while `0e07f60` uses
   protocol v2 persistent sessions. Keep one semantic workload and one sampler,
   but provide tested ref-native v1/v2 wire adapters and dry-run both refs before
   collecting samples.
5. Live-compare cleanup must execute the exact binary used to launch the
   service, not resolve `strata-kernel-service` again through `PATH`.
6. The CLI matrix did not define precedence for a repeated stop with a positive
   wait. V2 defines endpoint disappearance by the wait deadline as exit 0 after
   either acknowledgement; timeout is 6. Exit 5 is acknowledge-only repeated
   stop.

### Minor and missing gates

- Correct `DrainController::new` to include the grace argument.
- Use canonical CLI syntax `--wait-ms 0`, not `--wait-ms=0`.
- Update `print_help` and its exact-output tests in the CLI task.
- Add SIGINT, repeated-signal/deadline, handler restoration/fd-reuse, queued
  typed-client call, feature-off lock sampler, historical adapter dry-run, and
  exact waited-stop precedence coverage.

## Source verification by the implementing agent

The pivotal empirical claims were checked against repository source/history:

- Current service accept is blocking in `server.rs`; v1 could not make the
  Task-3 idle-exit assertion true without Task 4.
- Persistent bridge startup is opt-in in `main.rs`.
- `packages/live-compare/src/service.ts` retains the launch binary locally, so
  using that exact value for stop is feasible.
- `git show db15b38` reports protocol version 1 and a one-shot request path;
  `0e07f60` is on the protocol-v2 persistent-session path.

## Resolution

All blocker and important findings above are incorporated in plan v2. The
review did not request changes to the core drain state, RAII request/stop guard,
reservation counts, forced `process::exit(3)` ownership rule, or terminal
non-replaying `service_draining` client policy.
