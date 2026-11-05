/**
 * ONE LIVE TAB PER BROWSER, with the Web Locks API: the first tab to press Live holds a named lock
 * until it ends; a second is refused at once (`ifAvailable`), never queued. A browser without Web
 * Locks cannot offer the guard, and Live still works there (two tabs listening is annoying, not unsafe:
 * each only sends what it shows).
 */

import type { MicLockPort } from './ports.ts';

export const LIVE_LOCK_NAME = 'ferretry-live-voice';

export interface LocksLike {
  request(
    name: string,
    options: { readonly ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

export function webMicLock(locks: LocksLike | null | undefined): MicLockPort {
  let held = false;
  let release: (() => void) | null = null;
  return {
    acquire: () => {
      if (held || locks === undefined || locks === null) return Promise.resolve(true);
      return new Promise<boolean>(resolve => {
        const request = locks.request(LIVE_LOCK_NAME, { ifAvailable: true }, lock => {
          if (lock === null) {
            resolve(false);
            return null;
          }
          held = true;
          resolve(true);
          return new Promise<void>(done => {
            release = done;
          });
        });
        // A browser that refuses the request outright cannot tell us another tab holds it.
        request.catch(() => resolve(true));
      });
    },
    release: () => {
      held = false;
      release?.();
      release = null;
    },
  };
}
