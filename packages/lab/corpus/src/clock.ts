// A controllable clock used by tests and the CLI's `--simulate` mode.
// The real store accepts any `Clock`; this one lets you fast-forward
// without dealing with real wall-clock time.

import type { Clock, Millis } from "./types.ts";

export class ManualClock implements Clock {
  private current: Millis;

  constructor(start: Millis = 0) {
    this.current = start;
  }

  now(): Millis {
    return this.current;
  }

  /** Advance the clock forward by `ms` milliseconds. Returns the new time. */
  advance(ms: number): Millis {
    if (ms < 0) {
      throw new RangeError(`cannot rewind clock by ${ms}ms`);
    }
    this.current += ms;
    return this.current;
  }

  /** Jump the clock to an absolute time. Must not move backwards. */
  setTime(target: Millis): Millis {
    if (target < this.current) {
      throw new RangeError(
        `clock cannot move backwards (current=${this.current}, target=${target})`,
      );
    }
    this.current = target;
    return this.current;
  }
}
