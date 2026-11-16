import type { Cancel, Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { AgendaReplyTimers } from '../../lib/agenda/index.ts';

/**
 * One timer per ferret's outbox, on the kernel's clock. Scheduling a key again replaces its timer. A held answer is
 * durable in its outbox, so a timer is never what keeps a stopping daemon alive — the next start delivers it
 * (`AgendaReplyBatcher.resume`); the kernel's clock lets a stopping daemon go.
 */
export class KeyedAgendaReplyTimers implements AgendaReplyTimers {
  readonly #timers = new Map<string, { readonly cancel: Cancel }>();

  constructor(private readonly clock: Pick<Clock, 'after'>) {}

  schedule(key: string, delayMs: number, task: () => void): void {
    this.cancel(key);
    const timer: { cancel: Cancel } = { cancel: () => undefined };
    timer.cancel = this.clock.after(milliseconds(delayMs), () => {
      if (this.#timers.get(key) === timer) this.#timers.delete(key);
      task();
    });
    this.#timers.set(key, timer);
  }

  cancel(key: string): void {
    this.#timers.get(key)?.cancel();
    this.#timers.delete(key);
  }

  /** Stops every pending timer; the outboxes keep what they held. */
  close(): void {
    for (const timer of this.#timers.values()) timer.cancel();
    this.#timers.clear();
  }
}
