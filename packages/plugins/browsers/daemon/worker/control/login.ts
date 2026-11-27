import type { Instant } from '@ferretry/std';
import type { BrowserLoginConnection, BrowserLoginState } from '../../../contract/wire/login.ts';
import type { BrowserLoginStatus } from '../../../contract/index.ts';
import type { BrowserProfileLease } from './profile.ts';

/**
 * The login window's status IS the wire contract — it is what the daemon answers
 * `/v1/browser/login` with, and a reader parses it with the protocol schema. So
 * the state-discriminated protocol types are re-exported rather than restated
 * (the pattern `lib/pins/types.ts` already uses). Restating them here as a flat,
 * all-optional shape let the daemon's own types admit statuses the protocol
 * rejects: a `closed` window still carrying a live VNC password and countdown,
 * or an `open` one with no endpoint at all. Sharing one definition makes that
 * drift impossible rather than merely tested.
 */
export type { BrowserLoginConnection, BrowserLoginState, BrowserLoginStatus };

/**
 * The sign-in window of each browser identity: one window per identity, each on that identity's own profile and screen,
 * so signing in to one never closes, or shows, another's. An absent `identity` is the built-in `agent` one.
 */
export interface BrowserLoginLifecycle {
  status(identity?: string): Promise<BrowserLoginStatus>;
  start(options?: { readonly minutes?: number; readonly identity?: string }): Promise<BrowserLoginStatus>;
  stop(options?: { readonly primed?: boolean; readonly identity?: string }): Promise<BrowserLoginStatus>;
  confirm(identity?: string): Promise<BrowserLoginStatus>;
}

export interface BrowserLoginWindow {
  readonly chromePid: number;
  readonly vncPid: number;
  readonly lease: BrowserProfileLease;
  readonly chromeVersion: string;
  readonly port: number;
  readonly password: string;
  readonly openedAt: Instant;
  readonly expiresAt: Instant;
}
