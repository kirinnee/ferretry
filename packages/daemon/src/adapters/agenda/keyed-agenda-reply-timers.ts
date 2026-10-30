import type { AgendaReplyTimers } from '../../lib/agenda/index.ts';

/**
 * One real timer per ferret's outbox. Scheduling a key again replaces its timer, and every timer is
 * `unref`'d: a held answer is durable in its outbox, so it must never be what keeps a stopping daemon
 * alive — the next start delivers it (`AgendaReplyBatcher.resume`).
 */
export class KeyedAgendaReplyTimers implements AgendaReplyTimers {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delayMs: number, task: () => void): void {
    this.cancel(key);
    const timer = setTimeout(() => {
      if (this.#timers.get(key) === timer) this.#timers.delete(key);
      task();
    }, delayMs);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.#timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(key);
  }

  /** Stops every pending timer; the outboxes keep what they held. */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
