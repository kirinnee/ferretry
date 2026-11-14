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

/** The spellings a machine's own loopback is reached by: one daemon, three addresses it answers on. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** The addresses a daemon binds to listen on every interface: loopback is one of the ways in, so it is the app's too. */
const WILDCARD_HOSTS: readonly string[] = ['0.0.0.0', '[::]'];

/** Every spelling of loopback at `port` (the scheme the listener speaks is plain `http`). */
const loopbackAt = (protocol: string, port: string): string[] =>
  LOOPBACK_HOSTS.map(host => `${protocol}//${host}${port === '' ? '' : `:${port}`}`);

/**
 * The origins the daemon's own listener is the app on. A listener answers on every spelling of loopback whatever it is
 * bound to and whatever public address or CORS list is configured beside it, so: the listener's own port (the fact
 * Connections reports), and any configured or advertised origin whose host is loopback or a wildcard bind (`0.0.0.0`,
 * `[::]`) at ITS port. An unrelated port, or host, is not in it.
 */
function loopbackApps(listenerPort: number | undefined, spelled: readonly string[]): string[] {
  const found = listenerPort === undefined ? [] : loopbackAt('http:', String(listenerPort));
  for (const address of spelled) {
    try {
      const parsed = new URL(address);
      if (LOOPBACK_HOSTS.includes(parsed.hostname) || WILDCARD_HOSTS.includes(parsed.hostname))
        found.push(...loopbackAt(parsed.protocol, parsed.port));
    } catch {
      // not an address: nothing to match, and the caller already refuses text no one can read
    }
  }
  return found;
}

/**
 * THE DAEMON'S OWN FACTS, put in the shape the agent guard reads them (`../pages/pairing-screen-guard.ts`).
 *
 * WHICH ORIGINS ARE THE APP: the hosted app this build carries (always), the app origin and the browser origins
 * Connections advertises, the origin of the address it advertises for the daemon's own listener, and the daemon's own
 * loopback app on every spelling at the port it listens on, wildcard bind or not (`loopbackApps`) — read live, never one
 * hard-coded address. If Connections cannot say, or says something unreadable, the answer is `undefined`: every page is then taken
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
        const origins = [...spelled, ...loopbackApps(advertised.port, spelled)].map(originOf);
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
