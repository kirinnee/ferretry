/**
 * ONE LIVE TAB PER BROWSER, with the Web Locks API: the first tab to press Live holds a named lock
 * until it ends; a second is refused at once (`ifAvailable`), never queued. A browser without Web
 * Locks cannot offer the guard, and Live still works there (two tabs listening is annoying, not unsafe:
 * each only sends what it shows).
 *
 * RELEASE BEATS A LATE GRANT. The browser grants the lock asynchronously, so `release()` can run before the
 * request's callback does (Live ended, the page was leaving). `release` advances an epoch; a request made
 * in an older epoch hands the lock straight back when it is finally granted and tells its asker `false`, so
 * a Live that is gone can never hold the lock another tab is waiting for.
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
  let epoch = 0;
  return {
    acquire: () => {
      if (held || locks === undefined || locks === null) return Promise.resolve(true);
      const asked = epoch;
      return new Promise<boolean>(resolve => {
        const request = locks.request(LIVE_LOCK_NAME, { ifAvailable: true }, lock => {
          if (lock === null || asked !== epoch) {
            // Refused, or released before it was granted: a grant now is nobody's, so it goes straight back.
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
        request.catch(() => resolve(asked === epoch));
      });
    },
    release: () => {
      epoch += 1;
      held = false;
      release?.();
      release = null;
    },
  };
}
