import { LiveWindowLedger } from '@ferretry/std/live-window';
import { BrowserSessionService } from '../../daemon/pages/service.ts';
import { protectionWindows } from '../../daemon/protection/windows.ts';
import { SurfaceControl } from '../../daemon/tools/control.ts';
import { BrowserTools } from '../../daemon/tools/service.ts';
import { browserKernel } from './kernel.ts';
import { Tabs } from './tabs.ts';

/** The repo's fixed fake pairing code: the only one a test ever uses, and never a minted one. */
export const FAKE_CODE = 'FAKE-PAIR-0000';

/** The app's own origin in these worlds, the one Connections advertises. */
export const APP_ORIGIN = 'https://app.example.test';

/** Where the test clock starts; the browser, the ledgers and the guard all read it. */
export const START = Date.parse('2026-11-13T10:00:00.000Z');

export interface WorldOptions {
  /** The origins Connections advertises as the app's besides the hosted one; default `[APP_ORIGIN]`. */
  readonly allowed?: readonly string[];
  /** Connections cannot say at all. */
  readonly noConnections?: boolean;
  /** Access's provider is not there. */
  readonly noPairingWindow?: boolean;
  /** Catalogs' provider is not there. */
  readonly noShareWindow?: boolean;
  /** Where the page named `app` starts; default the app origin. */
  readonly appUrl?: string;
}

/**
 * The REAL runtime and the REAL tools over a faked browser (`Tabs`), with the daemon's own ledgers for a pairing code and a
 * share invite (the same class Access and Catalogs keep theirs in) on a clock the test moves.
 */
export async function pairingWorld(options: WorldOptions = {}) {
  const clock = { at: START };
  const tabs = new Tabs();
  const pairing = new LiveWindowLedger(() => clock.at);
  const share = new LiveWindowLedger(() => clock.at);
  const browser = new BrowserSessionService(
    { get: async id => (id === 's1' ? {} : undefined) },
    { launch: async () => tabs.automation },
    () => clock.at,
  );
  const protection = protectionWindows({
    now: () => clock.at,
    connections: () =>
      options.noConnections === true
        ? undefined
        : {
            advertisement: () =>
              ({
                advertisement: { kind: 'none', refusal: { reason: 'none' } },
                appOrigin: APP_ORIGIN,
                allowedOrigins: options.allowed ?? [APP_ORIGIN],
              }) as never,
          },
    windows: [
      () => (options.noPairingWindow === true ? undefined : pairing),
      () => (options.noShareWindow === true ? undefined : share),
    ],
  });
  const tools = new BrowserTools({
    browser,
    control: new SurfaceControl({ publish: async () => undefined, history: async () => [] }, { now: () => Date.now() }),
    kernel: browserKernel().kernel,
    policy: { allows: async () => true },
    files: {
      save: async (_session: string, staged: { name: string; size: number }) => ({
        saved: staged.name,
        size: staged.size,
      }),
    } as never,
    binaryName: 'fy',
    protection,
  });
  const app = await browser.openPage('s1', 'app', {
    url: options.appUrl ?? `${APP_ORIGIN}/`,
    openedBy: { by: 'agent', sessionId: 's1' },
  });
  return { tabs, browser, tools, app, clock, pairing, share, protection };
}
