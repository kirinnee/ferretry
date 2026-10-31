import type { PushDeliveryResult } from '@ferretry/protocol';
import type {
  NotificationAttempt,
  NotificationClock,
  NotificationDiagnostics,
  NotificationFailure,
} from '../../lib/index.ts';

/**
 * What became of this daemon's pushes since it started: each failure said in the daemon log, and the
 * newest failure and the newest push made kept for `fy doctor`. In memory only — the ledger is the
 * durable record; this is what the ledger cannot hold (a push that failed before its request was written).
 */
export class NotificationHealthMonitor implements NotificationDiagnostics {
  #lastFailed: NotificationFailure | undefined;
  #lastMade: NotificationAttempt | undefined;

  constructor(
    private readonly clock: NotificationClock,
    private readonly log: (line: string) => void,
  ) {}

  failed(key: string, reason: string): void {
    this.#lastFailed = { at: this.clock.now(), key, reason };
    this.log(`notifications: push ${key} failed — ${reason}`);
  }

  made(key: string, result: PushDeliveryResult): void {
    this.#lastMade = { at: this.clock.now(), key };
    if (result.delivered === 0 && result.failed > 0)
      this.log(`notifications: push ${key} reached none of its ${result.failed} device(s)`);
  }

  /** The newest failure and the newest push made, for the doctor reading. */
  snapshot(): { readonly lastFailed?: NotificationFailure; readonly lastMade?: NotificationAttempt } {
    return {
      ...(this.#lastFailed === undefined ? {} : { lastFailed: this.#lastFailed }),
      ...(this.#lastMade === undefined ? {} : { lastMade: this.#lastMade }),
    };
  }
}
