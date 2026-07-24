#!/usr/bin/env node
// Scripted fake persistent bridge worker for the unit gates in
// crates/strata-kernel/src/bridge/persistent.rs (bridge-persistence slice,
// Task 3).
//
// Plain Node, dependency-free, NO native modules — keep it that way: these
// gates run with whatever `node` is on PATH, and must never depend on the
// Homebrew-node native-module toolchain.
//
// Protocol: u32 little-endian length-prefixed JSON frames on stdin/stdout,
// exactly one response per request — except where a scripted violation says
// otherwise. Exits 0 on stdin EOF (the host's clean-shutdown contract).
//
// Behavior is selected via argv (the host passes config arguments through):
//   --mode=echo|extra-frame|wrong-id|silent|slow|stderr-flood|crash-once|
//          oversize-response|malformed|refuse|refuse-sync-attest-hydrate|
//          refuse-ahead|crash-on-sync-once|refuse-semantic
//   --log=<path>          append one line per received frame: "<kind>:<tag>"
//                         (kind falls back to "semantic" for kindless frames)
//   --delay-ms=<n>        slow mode: response delay in milliseconds
//   --stderr-bytes=<n>    stderr-flood mode: bytes written to stderr
//   --oversize-len=<n>    oversize-response mode: claimed frame length
//   --marker=<path>       crash-once mode: marker file distinguishing the
//                         first (crashing) instance from respawns
//   --persistent          accepted and ignored (mirrors the real worker argv)
'use strict';
const fs = require('fs');

const options = {
  mode: 'echo',
  log: null,
  delayMs: 500,
  stderrBytes: 8192,
  oversizeLen: 17 * 1024 * 1024,
  marker: null,
};
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
  if (!match) continue;
  const [, key, value] = match;
  if (key === 'mode') options.mode = value;
  else if (key === 'log') options.log = value;
  else if (key === 'delay-ms') options.delayMs = Number(value);
  else if (key === 'stderr-bytes') options.stderrBytes = Number(value);
  else if (key === 'oversize-len') options.oversizeLen = Number(value);
  else if (key === 'marker') options.marker = value;
  // --persistent and anything else: accepted and ignored.
}

let pending = Buffer.alloc(0);
let sentExtraFrame = false;

function writeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([prefix, body]));
}

// Writes a length prefix claiming `length` bytes, optionally followed by a
// body that does NOT need to match it — the oversize/malformed gates poke
// the host's reader directly.
function writeRaw(length, body) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(length, 0);
  process.stdout.write(prefix);
  if (body) process.stdout.write(body);
}

function logFrame(frame) {
  if (!options.log) return;
  const kind = typeof frame.kind === 'string' ? frame.kind : 'semantic';
  const tag = typeof frame.tag === 'string' ? frame.tag : '';
  // appendFileSync keeps the log strictly in frame-receipt order — the
  // G/G+1 atomicity gate depends on that ordering.
  fs.appendFileSync(options.log, `${kind}:${tag}\n`);
}

function isSyncKind(frame) {
  return frame.kind === 'sync' || frame.kind === 'hydrate';
}

function echoResponse(frame) {
  if (isSyncKind(frame)) {
    // Attest exactly the identity the sync/hydrate frame targeted.
    writeFrame({ requestId: frame.requestId, kind: 'attest', identity: frame.target });
  } else {
    writeFrame({ requestId: frame.requestId, ok: true, echo: frame.tag ?? null });
  }
}

function handleFrame(frame) {
  logFrame(frame);
  switch (options.mode) {
    case 'echo':
      echoResponse(frame);
      break;
    case 'extra-frame':
      // Valid response first, then a single-flight violation: an unsolicited
      // frame while the host has nothing outstanding.
      echoResponse(frame);
      if (frame.kind !== 'sync' && !sentExtraFrame) {
        sentExtraFrame = true;
        writeFrame({ requestId: 'unsolicited-frame', kind: 'noise' });
      }
      break;
    case 'wrong-id':
      writeFrame({ requestId: `${frame.requestId}-mismatch`, ok: true });
      break;
    case 'silent':
      // Never respond; stay alive so only the deadline can fire.
      break;
    case 'slow':
      setTimeout(() => echoResponse(frame), options.delayMs);
      break;
    case 'stderr-flood':
      // Exceed the host's stderr bound, never respond: the only way the
      // request can end is the stderr-overflow poison (not a data race with
      // a valid response).
      process.stderr.write('e'.repeat(options.stderrBytes));
      break;
    case 'crash-once':
      if (options.marker && !fs.existsSync(options.marker)) {
        fs.writeFileSync(options.marker, 'crashed');
        process.exit(1); // mid-request crash: frame read, no response
      }
      echoResponse(frame);
      break;
    case 'oversize-response':
      writeRaw(options.oversizeLen, null);
      break;
    case 'malformed':
      writeRaw(16, Buffer.from('this is not json', 'utf8'));
      break;
    case 'refuse':
      if (isSyncKind(frame)) {
        writeFrame({
          requestId: frame.requestId,
          kind: 'refuse',
          reason: 'gap',
          have: { generation: '0', digest: '' },
        });
      } else {
        echoResponse(frame);
      }
      break;
    case 'refuse-sync-attest-hydrate':
      // Refuses delta syncs but accepts full hydration: the host's one
      // refusal-triggered hydrate retry must recover the request.
      if (frame.kind === 'sync') {
        writeFrame({
          requestId: frame.requestId,
          kind: 'refuse',
          reason: 'digest-mismatch',
          have: { generation: '0', digest: '' },
        });
      } else {
        echoResponse(frame);
      }
      break;
    case 'refuse-ahead':
      // Claims to be ahead of every sync target (forward-only gate): the
      // host must NOT attempt a hydrate and must serve one-shot.
      if (isSyncKind(frame)) {
        writeFrame({
          requestId: frame.requestId,
          kind: 'refuse',
          reason: 'ahead',
          have: { generation: '999', digest: 'f'.repeat(64) },
        });
      } else {
        echoResponse(frame);
      }
      break;
    case 'crash-on-sync-once':
      // Dies mid-sync exactly once (marker-guarded); respawned instances
      // behave like echo — the lazy respawn must full-hydrate and attest.
      if (isSyncKind(frame) && options.marker && !fs.existsSync(options.marker)) {
        fs.writeFileSync(options.marker, 'crashed');
        process.exit(1);
      }
      echoResponse(frame);
      break;
    case 'refuse-semantic':
      // Attests syncs but refuses semantic frames (host/worker attestation
      // divergence seam): the host must clear its attestation and serve
      // one-shot without poisoning.
      if (isSyncKind(frame)) {
        echoResponse(frame);
      } else {
        writeFrame({
          requestId: frame.requestId,
          kind: 'refuse',
          reason: 'digest-mismatch',
          have: { generation: '1', digest: 'a'.repeat(64) },
        });
      }
      break;
    default:
      process.stderr.write(`unknown fake-worker mode: ${options.mode}\n`);
      process.exit(2);
  }
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (pending.length < 4 + length) return;
    const body = pending.subarray(4, 4 + length);
    pending = pending.subarray(4 + length);
    handleFrame(JSON.parse(body.toString('utf8')));
  }
});
process.stdin.on('end', () => process.exit(0));
