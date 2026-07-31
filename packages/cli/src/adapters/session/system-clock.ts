import type { IClock } from '../../lib/session/ports.ts';

/** The host clock. The only reader of wall-clock time in the session commands. */
export class SystemClock implements IClock {
  nowMs(): number {
    return Date.now();
  }
}
