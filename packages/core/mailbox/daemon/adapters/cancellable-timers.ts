import type { Cancel, Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';

/**
 * Waits on the kernel clock that can be given up, and are ALL given up when the daemon stops: a wait nobody is left to
 * read is no timer left running. A cancelled wait never resolves (the one waiting is always racing something else).
 */
export class CancellableTimers {
  private readonly waiting = new Set<Cancel>();

  constructor(private readonly clock: Pick<Clock, 'after'>) {}

  after(delay: number): { readonly done: Promise<void>; cancel(): void } {
    let cancel: Cancel = () => undefined;
    const done = new Promise<void>(resolve => {
      cancel = this.clock.after(milliseconds(delay), () => {
        this.waiting.delete(cancel);
        resolve();
      });
    });
    this.waiting.add(cancel);
    return {
      done,
      cancel: () => {
        this.waiting.delete(cancel);
        cancel();
      },
    };
  }

  /** How many waits are still running. */
  pending(): number {
    return this.waiting.size;
  }

  /** Gives up every wait still pending. */
  cancelAll(): void {
    for (const cancel of this.waiting) cancel();
    this.waiting.clear();
  }
}
