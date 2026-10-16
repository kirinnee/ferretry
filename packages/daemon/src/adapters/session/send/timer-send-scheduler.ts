import type { SendScheduler } from '../../../lib/session/send/tracker.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * The send tracker's one pending look per session, on real timers.
 *
 * At most ONE timer per session exists at a time — scheduling again replaces it — so a session with a
 * hundred open sends costs one timer, and a daemon with nothing in flight holds none. The timers are
 * unreferenced, so a pending look never keeps a stopping daemon alive.
 */
export class TimerSendScheduler implements SendScheduler {
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>();

  schedule(id: SessionId, delayMs: number, run: () => void): void {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      run();
    }, delayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
