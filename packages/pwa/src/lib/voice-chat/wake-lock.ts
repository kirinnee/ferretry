/**
 * KEEP THE SCREEN ON while Live listens (Screen Wake Lock). The browser drops the lock whenever the page
 * is hidden, so it is asked for again when the page comes back — while Live still wants it. A refusal
 * (no API, a battery saver, an insecure page) is a value, not an error: Live works, the screen may sleep.
 *
 * ONE REQUEST AT A TIME, ONE SENTINEL HELD. Hide, show and Resume can each ask while an earlier request is
 * still in flight; they share it instead of issuing more. Every answer carries the generation it was asked in
 * (`release` advances it), and a grant that arrives after the lock was released — or that replaces a sentinel
 * the browser already dropped — is handed straight back, so End always releases everything that was granted.
 */

import type { VisibilityPort, WakeLockPort } from './ports.ts';

interface WakeSentinelLike {
  release(): Promise<void>;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeSentinelLike>;
}

const handBack = (sentinel: WakeSentinelLike): void => {
  sentinel.release().catch(() => undefined);
};

export function screenWakeLock(api: WakeLockApiLike | null | undefined, visibility: VisibilityPort): WakeLockPort {
  let wanted = false;
  let sentinel: WakeSentinelLike | null = null;
  let unwatch: (() => void) | null = null;
  /** The request in flight, shared by everyone who asks meanwhile. */
  let inFlight: Promise<boolean> | null = null;
  /** Advances at every `release`: an answer to an older request is stale. */
  let generation = 0;

  const request = (): Promise<boolean> => {
    if (api === undefined || api === null) return Promise.resolve(false);
    if (inFlight !== null) return inFlight;
    const asked = generation;
    const run = async (): Promise<boolean> => {
      try {
        const next = await api.request('screen');
        if (!wanted || asked !== generation) {
          // Released while the request was in flight.
          handBack(next);
          return false;
        }
        // The browser drops a sentinel when the page hides: the new one replaces it.
        const replaced = sentinel;
        sentinel = next;
        if (replaced !== null) handBack(replaced);
        return true;
      } catch {
        return false;
      }
    };
    const attempt: Promise<boolean> = run().finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  };

  return {
    acquire: async () => {
      wanted = true;
      unwatch ??= visibility.watch(visible => {
        if (visible && wanted) void request();
      });
      if (sentinel !== null) return true;
      return request();
    },
    release: () => {
      wanted = false;
      generation += 1;
      inFlight = null;
      unwatch?.();
      unwatch = null;
      const held = sentinel;
      sentinel = null;
      if (held !== null) handBack(held);
    },
  };
}
