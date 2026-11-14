import { LiveWindowLedger } from '@ferretry/std/live-window';
import type { ProtectionWindows } from '../../daemon/pages/pairing-screen-guard.ts';
import { protectionWindows } from '../../daemon/protection/windows.ts';

/**
 * A daemon whose own facts say NO PAIRING SCREEN: Connections advertises one app origin no test page is on, and neither a
 * pairing code nor a share invite has ever been live. The pairing guard (docs/pairing.md, "Never show it to an agent")
 * still runs on every agent read and still asks the page, so a page that marks itself as the screen is still refused;
 * it simply has nothing of the daemon's to refuse for. Suites written for something else (ownership, sealed values,
 * takeovers) use it so each test exercises what it was written to test.
 */
const QUIET_APP_ORIGIN = 'https://app.ferretry.test';

/** Connections' port as the guard reads it: the app origin and the browser origins, nothing else. */
const quietConnections = {
  advertisement: () =>
    ({
      advertisement: { kind: 'none', refusal: { reason: 'none' } },
      appOrigin: QUIET_APP_ORIGIN,
      allowedOrigins: [QUIET_APP_ORIGIN],
    }) as never,
};

/** A credential ledger nothing was ever opened in: it answers a plain "no" for every instant. */
const neverLive = (): LiveWindowLedger => new LiveWindowLedger(() => Date.now());

/** The `uses` a test host binds so the browsers half's pairing guard reads "no pairing screen" (see the manifest). */
export function quietPairingUses(): {
  readonly connections: typeof quietConnections;
  readonly pairingWindow: LiveWindowLedger;
  readonly shareWindow: LiveWindowLedger;
} {
  return { connections: quietConnections, pairingWindow: neverLive(), shareWindow: neverLive() };
}

/** The `protection` port a directly built `BrowserTools` takes, over the same facts. */
export function quietProtection(): ProtectionWindows {
  const { connections, pairingWindow, shareWindow } = quietPairingUses();
  return protectionWindows({
    now: () => Date.now(),
    connections: () => connections,
    windows: [() => pairingWindow, () => shareWindow],
  });
}
