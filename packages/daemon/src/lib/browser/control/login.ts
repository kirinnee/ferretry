import type { BrowserProfileLease, BrowserProfilePort } from './profile.ts';

export type BrowserLoginState = 'closed' | 'opening' | 'open' | 'closing' | 'error';

export interface BrowserLoginConnection {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly password: string;
  readonly sshTunnel: string;
}

export interface BrowserLoginStatus {
  readonly state: BrowserLoginState;
  readonly profilePrimed: boolean;
  readonly openedAt?: string;
  readonly expiresAt?: string;
  readonly connection?: BrowserLoginConnection;
  readonly error?: string;
}

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
