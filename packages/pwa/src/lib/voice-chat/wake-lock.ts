/**
 * KEEP THE SCREEN ON while Live listens (Screen Wake Lock). The browser drops the lock whenever the page
 * is hidden, so it is asked for again when the page comes back — while Live still wants it. A refusal
 * (no API, a battery saver, an insecure page) is a value, not an error: Live works, the screen may sleep.
 */

import type { VisibilityPort, WakeLockPort } from './ports.ts';

interface WakeSentinelLike {
  release(): Promise<void>;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeSentinelLike>;
}

export function screenWakeLock(api: WakeLockApiLike | null | undefined, visibility: VisibilityPort): WakeLockPort {
  let wanted = false;
  let sentinel: WakeSentinelLike | null = null;
  let unwatch: (() => void) | null = null;

  const request = async (): Promise<boolean> => {
    if (api === undefined || api === null) return false;
    try {
      const next = await api.request('screen');
      if (!wanted) {
        // Released while the request was in flight.
        next.release().catch(() => undefined);
        return false;
      }
      sentinel = next;
      return true;
    } catch {
      return false;
    }
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
      unwatch?.();
      unwatch = null;
      const held = sentinel;
      sentinel = null;
      held?.release().catch(() => undefined);
    },
  };
}

/**
 * The person's "Keep screen on" switch in front of a wake lock, asked at each `acquire` (Live asks again after a
 * hidden tab comes back) so a change applies the next time. Off, `acquire` answers "fine" without asking the
 * browser — this was a choice, not a refusal, so Live does not warn that the screen may turn off.
 */
export function gatedWakeLock(inner: WakeLockPort, keepOn: () => boolean): WakeLockPort {
  return {
    acquire: () => (keepOn() ? inner.acquire() : Promise.resolve(true)),
    release: () => inner.release(),
  };
}
