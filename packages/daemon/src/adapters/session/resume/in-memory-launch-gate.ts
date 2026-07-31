import type { SessionId } from '../../../lib/session-id.ts';
import type { LaunchGate } from '../../../lib/session/resume/types.ts';

/**
 * Which sessions this process currently has a launch in flight for.
 *
 * Per-process by nature: it describes what THIS daemon is doing right now, and a stale entry
 * inherited from a dead process would grant amnesty to a launch nobody is performing. It is an
 * instance, not module state, so a test constructs its own and two daemons in one test file cannot
 * see each other's launches.
 */
export class InMemoryLaunchGate implements LaunchGate {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly sleep: (milliseconds: number) => Promise<void>,
    /** How often a waiter re-checks; short enough to answer promptly, long enough not to spin. */
    private readonly pollMs = 100,
  ) {}

  launching(id: SessionId): boolean {
    return this.inFlight.has(id);
  }

  /** Resolves true once the launch settled, false if it did not within the budget. */
  async awaitSettled(id: SessionId, timeoutMs: number): Promise<boolean> {
    for (let waited = 0; waited < timeoutMs; waited += this.pollMs) {
      if (!this.inFlight.has(id)) return true;
      await this.sleep(Math.min(this.pollMs, timeoutMs - waited));
    }
    return !this.inFlight.has(id);
  }

  register(id: SessionId): { release(): void } {
    let release = (): void => {};
    const settled = new Promise<void>(resolve => {
      release = () => resolve();
    });
    this.inFlight.set(id, settled);
    return {
      release: () => {
        // Only the registration that still owns the slot may clear it: a late release from a
        // superseded attempt would otherwise un-register the launch that replaced it.
        if (this.inFlight.get(id) === settled) this.inFlight.delete(id);
        release();
      },
    };
  }
}
