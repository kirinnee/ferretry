import type { BrowserLoginConnection, BrowserLoginState, BrowserLoginStatus } from '@ferretry/protocol';
import type { BrowserProfileLease, BrowserProfilePort } from './profile.ts';

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

export interface BrowserLoginLifecycle {
  status(): Promise<BrowserLoginStatus>;
  start(options?: { readonly minutes?: number }): Promise<BrowserLoginStatus>;
  stop(options?: { readonly primed?: boolean }): Promise<BrowserLoginStatus>;
  confirm(): Promise<BrowserLoginStatus>;
}

export interface BrowserLoginWindow {
  readonly chromePid: number;
  readonly vncPid: number;
  readonly lease: BrowserProfileLease;
  readonly chromeVersion: string;
  readonly port: number;
  readonly password: string;
  readonly openedAt: string;
  readonly expiresAt: string;
}

export interface BrowserLoginDependencies {
  readonly profile: BrowserProfilePort;
  readonly closeAgentBrowsers: () => Promise<void>;
}
