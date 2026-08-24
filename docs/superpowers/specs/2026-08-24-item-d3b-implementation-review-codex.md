# D-3b implementation review — Codex

Date: 2026-08-24

Reviewer: Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only and repo-grounded.

Reviewed range: `aa4ebfe..4d6ee05` (the committed implementation at dispatch time).

## Findings

### Critical

None.

### Major

1. `stop --wait-ms` treated an unreachable endpoint as successful disappearance. A forced grace expiry exits the daemon with code 3 via `process::exit`, leaving the incarnation socket for crash recovery; the waited CLI could therefore return 0 even though recovery was required.
2. Forced-recovery acceptance coverage did not prove the plan's exact journal, audit, canonical-operation, or queued-ticket invariants.

### Minor

1. Stop CLI coverage did not include a socket that accepted the connection but returned foreign or malformed protocol data.
2. Lock-sample summarization exposed the dropped count but did not fail closed when it was nonzero.

## Disposition

All findings were addressed before closure:

- Waited stop now succeeds only after actual endpoint disappearance; an orphaned but unreachable socket remains non-success and reaches the caller's timeout exit 6.
- The deterministic post-Pending forced-exit gate now parses journal record types, proves exactly one recovered effect and terminal record, reads the literal pre-existing canonical operation ID, and proves the operation ID occurs exactly once in events. A separate real-contention lifecycle gate proves a queued ticket remains exactly `queued` across drain and restart.
- A foreign-protocol Unix socket is covered and returns exit 4.
- Any nonzero dropped-sample count makes summarization throw.

During disposition, the measurement adapters were also tightened to exact reply/handshake key sets and canonical integer fields, and the N-actor workload gained an explicit per-phase common release barrier. Because that changes the measurement protocol, the D-3b artifact was regenerated rather than retaining the earlier numbers.
