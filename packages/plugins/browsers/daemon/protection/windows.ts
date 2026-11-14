import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';
import type { ConnectionsApi } from '@ferretry/plugin-connections/contract';
import type { LiveWindowView } from '@ferretry/std/live-window';
import type { ProtectionWindows } from '../pages/pairing-screen-guard.ts';

/** What {@link protectionWindows} reads, each read afresh on every question (a port may bind after this is built). */
export interface ProtectionSources {
  /** The daemon's clock, in epoch milliseconds: the one the credentials' ledgers keep their intervals on. */
  readonly now: () => number;
  /** Connections' port: the app origin and the origins a browser may speak as, from the facts the pairing QR is minted from. */
  readonly connections: () => Pick<ConnectionsApi, 'advertisement'> | undefined;
  /**
   * Every provider of "a credential was live" — Access's pairing code and Catalogs' share invite. A provider that is not
   * there (a plugin switched off, a port not yet bound) is a provider that cannot say, and counts as live.
   */
  readonly windows: readonly (() => LiveWindowView | undefined)[];
}

/** An origin spelled as a browser spells it, or `undefined` for text no one can read as one. */
function originOf(address: string): string | undefined {
  try {
    const { origin } = new URL(address);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * THE DAEMON'S OWN FACTS, put in the shape the agent guard reads them (`../pages/pairing-screen-guard.ts`).
 *
 * WHICH ORIGINS ARE THE APP: the hosted app this build carries, the app origin and the browser origins Connections
 * advertises, and the origin of the address it advertises for the daemon's own listener — read live, never one hard-coded
 * address. If Connections cannot say, or says something unreadable, the answer is `undefined`: every page is then taken
 * for an app page.
 *
 * WHEN A CREDENTIAL WAS LIVE: asked of every provider; one that is absent, throws or answers anything but a plain "no"
 * makes the answer "yes" (unknown is live).
 */
export function protectionWindows(sources: ProtectionSources): ProtectionWindows {
  return {
    now: () => sources.now(),
    appOrigins: () => {
      const hosted = originOf(HOSTED_APP_ORIGIN);
      const connections = sources.connections();
      if (hosted === undefined || connections === undefined) return undefined;
      try {
        const advertised = connections.advertisement();
        const spelled = [
          hosted,
          advertised.appOrigin,
          ...advertised.allowedOrigins,
          ...(advertised.advertisement.kind === 'none' ? [] : [advertised.advertisement.url]),
        ];
        const origins = spelled.map(originOf);
        if (origins.some(origin => origin === undefined)) return undefined;
        return new Set(origins as string[]);
      } catch {
        return undefined;
      }
    },
    liveSince: sinceMs => {
      for (const provider of sources.windows) {
        try {
          const window = provider();
          if (window === undefined || window.liveSince(sinceMs) !== false) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };
}
