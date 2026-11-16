import type { Cancel, Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { SendScheduler } from '../lib/tracker.ts';

/** One pending re-check per ferret, on the kernel clock: scheduling again replaces the one waiting. */
export class ClockSendScheduler implements SendScheduler {
  private readonly timers = new Map<SessionId, Cancel>();

  constructor(private readonly clock: Pick<Clock, 'after'>) {}

  schedule(id: SessionId, delayMs: number, run: () => void): void {
    this.timers.get(id)?.();
    this.timers.set(
      id,
      this.clock.after(milliseconds(delayMs), () => {
        this.timers.delete(id);
        run();
      }),
    );
  }

  cancelAll(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
}
