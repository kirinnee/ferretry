import type { ActivityLedger } from '../../lib/runtime/liveness.ts';

/**
 * `tick`, run as the labelled activity `name`, so `fy daemon profile` and a stall can name the timer
 * that did the work. The tick's own errors stay its own: a rejection is swallowed here exactly as each
 * timer already swallowed it. Without a ledger the tick runs as it always did.
 */
export function asActivity(activities: ActivityLedger | undefined, name: string, tick: () => unknown): () => void {
  return () => {
    if (activities === undefined) {
      void tick();
      return;
    }
    void activities.run(name, async () => await tick()).catch(() => undefined);
  };
}

/** The timer functions {@link afterAsActivity} arms with: the runtime's own unless a test stands in. */
export interface ActivityTimerHost {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const RUNTIME_TIMERS: ActivityTimerHost = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A one-shot timer whose `run` is its own top-level activity `name`, returning the cancel.
 *
 * ARMED OUTSIDE EVERY ACTIVITY. A loop that schedules its next tick from inside the tick it just ran
 * (the board GitHub watcher, the disable-expiry timer) would otherwise have the timer inherit that
 * tick's asynchronous context: the next tick would be counted inside the last, and the one after inside
 * that, so the context chain grows by one every tick and nothing in it can ever be released.
 */
export function afterAsActivity(
  activities: ActivityLedger | undefined,
  name: string,
  run: () => unknown,
  ms: number,
  options: { readonly unref?: boolean; readonly host?: ActivityTimerHost } = {},
): () => void {
  const host = options.host ?? RUNTIME_TIMERS;
  const arm = (): unknown => {
    const handle = host.setTimeout(asActivity(activities, name, run), ms);
    // Unreferenced, so a pending timer never holds the process open.
    if (options.unref === true) (handle as { unref?: () => void }).unref?.();
    return handle;
  };
  const handle = activities === undefined ? arm() : activities.outside(arm);
  return () => host.clearTimeout(handle);
}
