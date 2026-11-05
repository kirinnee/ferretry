/**
 * KEEP THE SCREEN ON while Live listens (Screen Wake Lock). The browser drops the lock whenever the page
 * is hidden, so it is asked for again when the page comes back — while Live still wants it. A refusal
 * (no API, a battery saver, an insecure page) is a value, not an error: Live works, the screen may sleep.
 */

import type { VisibilityPort, WakeLockPort } from './ports.ts';

export interface WakeSentinelLike {
  release(): Promise<void>;
}

export interface WakeLockApiLike {
  request(type: 'screen'): Promise<WakeSentinelLike>;
}

export function screenWakeLock(api: WakeLockApiLike | undefined, visibility: VisibilityPort): WakeLockPort {
  let wanted = false;
  let sentinel: WakeSentinelLike | null = null;
  let unwatch: (() => void) | null = null;

  const request = async (): Promise<boolean> => {
    if (api === undefined) return false;
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
