/**
 * How a phone reaches a daemon. Two carriers, one security model.
 *
 * 1. **Direct** — the socket goes straight to the daemon: a laptop on the same network, a tailnet
 *    address, a VPN, a public host. Fewest hops, fewest parties, lowest latency. It is the
 *    preferred carrier whenever it is configured and reachable, not a fallback, and nobody has to
 *    opt out of a relay to get it.
 * 2. **Your own relay** — the Workers rendezvous in this package, deployed to your own Cloudflare
 *    account, or reimplemented from the protocol document.
 *
 * **There is no third option, and deliberately so.** A hosted relay anyone could reach would be a
 * free anonymous tunnel whose operator is structurally unable to see what it carries — the same
 * property that protects users protects abusers, and no amount of care recovers visibility the
 * design removed on purpose. Policing it would need enrolment, quotas and abuse response, which is
 * the service infrastructure this product exists to avoid. So a relay serves whoever deployed it
 * and nobody else, and there is no default relay address anywhere in this package: a relay is
 * configured, or there is no relay.
 *
 * The end-to-end layer is identical on both carriers. A direct socket is not "trusted because it
 * is direct": it runs the same handshake, pins the same fingerprint and authenticates every record
 * the same way. Choosing a carrier changes latency, dependency and what an onlooker can observe —
 * it never changes what protects the traffic.
 *
 * The carrier is per daemon, stored with the pairing, so one daemon can be direct on a home
 * network while another is relayed, both at once.
 */

import { z } from 'zod';
import { parseDaemonId } from './identity.ts';

/**
 * A socket address this protocol will dial.
 *
 * Secure schemes anywhere; insecure schemes only against loopback. That is the same line the
 * published site's content-security-policy draws, and drawing it differently here would make one
 * of the two a lie.
 */
export const SocketEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && loopback)) {
      context.addIssue({ code: 'custom', message: 'endpoint must be wss/https, or ws/http on loopback' });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });

/**
 * The stored carrier choice for one daemon.
 *
 * A relay address is a field here and nowhere else. There is no default constant in this package,
 * so "bring your own relay" is not a mode to switch into — it is the only relay there is.
 */
export const ConnectionMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), daemonUrl: SocketEndpointSchema }),
  z.strictObject({ kind: z.literal('relay'), relayUrl: SocketEndpointSchema }),
]);
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

export type ConnectionRole = 'client' | 'daemon';

/**
 * The socket URL for one role.
 *
 * Both carriers spell the path the same way, so a daemon serving direct clients and a rendezvous
 * serving relayed ones answer the same route. The daemon role exists only on a relay: on a direct
 * carrier the daemon is the server, so asking for it is a mistake and returns null rather than a
 * URL that would quietly connect to the wrong thing.
 */
export function connectionSocketUrl(method: ConnectionMethod, daemonId: string, role: ConnectionRole): string | null {
  const parsedDaemonId = parseDaemonId(daemonId);
  if (parsedDaemonId === null) return null;
  if (method.kind === 'direct' && role === 'daemon') return null;
  const base = method.kind === 'direct' ? method.daemonUrl : method.relayUrl;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/rendezvous/${encodeURIComponent(parsedDaemonId)}/${role}`;
  return url.toString();
}

export interface RendezvousRoute {
  readonly daemonId: string;
  readonly role: ConnectionRole;
}

/**
 * Read a rendezvous route back out of a path.
 *
 * This is the exact inverse of {@link connectionSocketUrl} and lives beside it so the dialler and
 * the server cannot drift apart. A path that is not exactly this shape is not a route: no prefix
 * matching, no trailing segments, and no fingerprint that is merely fingerprint-shaped.
 */
export function parseRendezvousPath(pathname: string): RendezvousRoute | null {
  const segments = pathname.split('/').filter(segment => segment !== '');
  if (segments.length !== 4 || segments[0] !== 'v1' || segments[1] !== 'rendezvous') return null;
  const daemonId = parseDaemonId(decodeURIComponent(segments[2] ?? ''));
  const role = segments[3];
  if (daemonId === null || (role !== 'client' && role !== 'daemon')) return null;
  return { daemonId, role };
}

/** What a carrier costs, in the terms a person choosing one actually cares about. */
export interface ConnectionDisclosure {
  readonly label: string;
  readonly summary: string;
  /** Every party on the path, and what that party can observe. Content is never on this list. */
  readonly observers: readonly string[];
  readonly requires: readonly string[];
}

export function describeConnectionMethod(method: ConnectionMethod): ConnectionDisclosure {
  if (method.kind === 'direct') {
    return {
      label: 'Direct',
      summary: 'Your browser connects straight to the daemon. No third party carries the traffic.',
      observers: [
        'Whoever runs the network between you and the daemon sees that a connection exists, its size and its timing.',
        'Nobody else is on the path: there is no operator to trust and no service to be down.',
      ],
      requires: [
        'The daemon address has to be reachable from wherever the browser is — same network, a VPN, a tailnet or a public host.',
        'The address must serve TLS unless it is loopback.',
      ],
    };
  }
  return {
    label: 'Your own relay',
    summary:
      'A Cloudflare Worker in your own account passes ciphertext between you and the daemon. The daemon dials out, so it works from behind NAT, and nobody outside your account is on the path.',
    observers: [
      'The relay sees the daemon fingerprint in the URL, because that is what addresses the rendezvous.',
      'The relay sees both IP addresses, when each side connects and for how long.',
      'The relay sees how many frames go each way, how big each one is and exactly when it was sent.',
      'The relay cannot read a frame, alter one or insert one: every record is authenticated under a key derived on your two devices.',
      'You are the relay operator, so all of that is visible to you and to Cloudflare, and to nobody else.',
    ],
    requires: [
      'A Cloudflare account, and one deploy of this package into it.',
      'The daemon fingerprint listed in the relay deployment, so the relay serves you and not a stranger.',
      'The relay address configured on both the daemon and this browser.',
    ],
  };
}

/** The result of trying one carrier, in preference order. */
export interface ConnectionProbe {
  readonly method: ConnectionMethod;
  readonly reachable: boolean;
  /** Why it was not reachable. Required when it was not, so a refusal is never unexplained. */
  readonly detail?: string;
}

export interface ConnectionSkip {
  readonly method: ConnectionMethod;
  readonly detail: string;
}

export type ConnectionChoice =
  | {
      readonly ok: true;
      readonly method: ConnectionMethod;
      /** Plain-language sentence a surface can show verbatim. */
      readonly reason: string;
      readonly passedOver: readonly ConnectionSkip[];
    }
  | { readonly ok: false; readonly reason: string; readonly passedOver: readonly ConnectionSkip[] };

/**
 * Order carriers by preference: direct first, always.
 *
 * Ordering is separate from choosing so a caller cannot accidentally probe a relay before the
 * direct address it already has.
 */
export function connectionPreferenceOrder(methods: readonly ConnectionMethod[]): readonly ConnectionMethod[] {
  return [...methods.filter(method => method.kind === 'direct'), ...methods.filter(method => method.kind !== 'direct')];
}

/**
 * Pick a carrier from what was actually tried.
 *
 * The choice carries everything it passed over and why. A session that ends up on a relay because
 * the direct address timed out is a session whose owner should be told so — degrading silently is
 * how a person spends an evening blaming their phone for a firewall rule.
 */
export function chooseConnection(probes: readonly ConnectionProbe[]): ConnectionChoice {
  const passedOver: ConnectionSkip[] = [];
  for (const probe of probes) {
    if (!probe.reachable) {
      passedOver.push({ method: probe.method, detail: probe.detail ?? 'unreachable, with no reason reported' });
      continue;
    }
    const label = describeConnectionMethod(probe.method).label.toLowerCase();
    const reason =
      passedOver.length === 0
        ? `Connected over ${label}.`
        : `Connected over ${label} because ${passedOver.map(describeSkip).join('; ')}.`;
    return { ok: true, method: probe.method, reason, passedOver };
  }
  return {
    ok: false,
    reason:
      probes.length === 0
        ? 'No connection method is configured for this daemon.'
        : `No configured connection worked: ${passedOver.map(describeSkip).join('; ')}.`,
    passedOver,
  };
}

function describeSkip(skip: ConnectionSkip): string {
  return `${describeConnectionMethod(skip.method).label.toLowerCase()} was not reachable (${skip.detail})`;
}
