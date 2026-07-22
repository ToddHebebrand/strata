#!/usr/bin/env node
// Gate 3, Task 4 fix-report addendum: a fake child entrypoint used ONLY by
// gate3RunnersUnit.test.ts's error/kill-path coverage. It stands in for a
// real kernel-child.js/sqlite-child.js that has gone wrong: it writes one
// well-formed ChildResult line, then a SECOND line that is NOT the
// contractual `{ done: true }` terminator — a wire-protocol violation
// `runChildOnce` must reject on — and then hangs forever instead of exiting
// on its own, so the test can prove `runChildOnce` actually SIGKILLs it
// rather than merely rejecting while the process leaks.
"use strict";
const fs = require("node:fs");

const pidFile = process.env.STUB_PID_FILE;
if (pidFile) {
  fs.writeFileSync(pidFile, String(process.pid));
}

process.stdout.write(
  `${JSON.stringify({
    callerWallNs: 1,
    childMaxRssBytes: 1,
    published: true,
    lifecycle: ["stub"],
    childPid: process.pid
  })}\n`
);

// Protocol violation: the child-protocol.ts contract requires the next
// (and only the next) line to be the terminal `{ done: true }`.
process.stdout.write(`${JSON.stringify({ done: false, reason: "stub-protocol-violation" })}\n`);

// Deliberately never exit on our own — only a SIGKILL from the parent
// should end this process. If the parent's kill-on-mismatch branch were
// missing, this process would still be alive (and reachable via
// `process.kill(pid, 0)`) long after the test's assertions run.
setInterval(() => {}, 60_000);
