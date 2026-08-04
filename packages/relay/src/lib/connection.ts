/**
 * How a phone reaches a daemon. Two carriers, one security model.
 *
 * 1. **Direct** — the socket goes straight to the daemon: a laptop on the same network, a tailnet
 *    address, a VPN, a public host. Fewest hops, fewest parties, lowest latency. It is the
 *    preferred carrier whenever it is configured and reachable, not a fallback, and nobody has to
 *    opt out of a relay to get it.
 * 2. **Relay** — the Workers rendezvous in this package. Ferretry's metered hosted service is the
 *    automatic fallback only after direct fails; running the same carrier in your own Cloudflare
 *    account remains an expert override in the required product contract. The current PWA's
 *    interim carrier chooser has not caught up with that contract yet. Who operates and pays for
 *    the relay changes, but the wire protocol and security model do not.
 *
 * A hosted relay anyone can reach is abusable precisely because its operator cannot read what it
 * carries. Ferretry accepts that risk for its hosted deployment and bounds the bill with runtime
 * metering and fail-safe caps. The address is still configuration: a remotely served advertisement
 * can be changed or set to null without releasing this package, while a self-hosted address remains
 * a value its owner supplies directly.
 *
 * The end-to-end layer is identical on both carriers. A direct socket is not "trusted because it
 * is direct": it runs the same handshake, pins the same fingerprint and authenticates every record
 * the same way. Choosing a carrier changes latency, dependency and what an onlooker can observe —
 * it never changes what protects the traffic.
 *
 * The model is deliberately per daemon, so the future client mounting can persist one daemon as
 * direct and another as relayed without inventing a global carrier switch. That persistence and
 * transport are not mounted yet; this module defines the decision and disclosure contract they
 * must consume.
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
 * A relay address is a field here and nowhere else. There is no default address constant in this
 * package.
 *
 * `operator` selects nothing but the disclosure a surface owes the user — who runs the relay is not
 * a wire difference, and both values take the identical path. It is optional because a stored record
 * written before the field existed can only have described a relay its owner deployed, so absent is
 * read as `'self'` rather than as an unknown: an old pairing keeps its exact meaning instead of
 * being re-described as somebody else's service.
 */
export const ConnectionMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), daemonUrl: SocketEndpointSchema }),
  z.strictObject({
    kind: z.literal('relay'),
    relayUrl: SocketEndpointSchema,
    operator: z.enum(['self', 'hosted']).optional(),
  }),
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
  if (method.operator === 'hosted') {
    return {
      label: 'Hosted relay',
      summary:
        'Ferretry’s Cloudflare Worker passes ciphertext between you and the daemon. It works behind NAT without making you deploy infrastructure.',
      observers: [
        'Ferretry and Cloudflare see the daemon fingerprint in the URL, because that is what addresses the rendezvous.',
        'They see both IP addresses, when each side connects and for how long.',
        'They see request counts, frame sizes and timing, and how many connections the daemon has.',
        'They cannot read frame payloads, device tokens, session content, commands, output or names.',
      ],
      requires: [
        'The hosted relay’s runtime advertisement must be enabled; the operator can disable it without an app release.',
        'Traffic and connection use must remain below both the daemon’s ceilings and the hosted service’s global ceilings.',
        'The same relay address must be configured on the daemon and this browser.',
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
