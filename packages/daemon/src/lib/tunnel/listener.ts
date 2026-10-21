/**
 * THE TUNNEL'S OWN LISTENER: one route, and every arrival on it remote — `docs/relay-protocol.md` §15.
 *
 * `cloudflared` forwards from this daemon's own host, so everything that comes through a tunnel arrives
 * from a loopback peer. Pointing the tunnel at the daemon's API listener would therefore make a phone on
 * the far side of Cloudflare indistinguishable from a browser at the machine. So the tunnel never points
 * there: the daemon binds a SECOND listener on `127.0.0.1`, on an ephemeral port (the `originPort` it
 * provisions with), and that listener
 *
 * - serves ONLY `GET /v1/rendezvous/<its daemonId>/client` — the direct carrier's session route, the
 *   very same {@link SocketRoute} and session, not a fork of either — and answers `404` to everything
 *   else, including that path without an upgrade and any other fingerprint;
 * - stamps every arrival `loopback: false` and not privileged (the adapter applies
 *   `ApiBindOptions.remotePeer`), which is the relay rule of §14 for the same reason. A query-string
 *   token is honoured only from a loopback arrival, so it is never honoured here; a session opened here
 *   carries a remote {@link SessionArrival}, so nothing inside it reaches a `privilegedOnly` route, and
 *   its requests are governed by grants exactly as a relayed device's are;
 * - keys the per-peer admission bounds of §4 by `CF-Connecting-IP` — the address Cloudflare's edge saw —
 *   and falls back to ONE shared key when it is absent or not an address, so a caller that hides it
 *   shares a bucket rather than escaping one.
 *
 * The edge's ingress forwards only that one path too (`tunnelIngress`), so this is the inner of two
 * walls rather than the only one.
 */

import type { ApiCredentials } from '../api/authentication.ts';
import type { CapabilityGuard } from '../api/capability.ts';
import { errorResponse } from '../api/responses.ts';
import type { ApiHeaders } from '../api/http.ts';
import { ApiRouter } from '../api/router.ts';
import type { ApiSurface } from '../api/server.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../api/socket.ts';

/** The header Cloudflare's edge sets to the address it accepted the connection from. */
export const TUNNEL_PEER_HEADER = 'cf-connecting-ip';

/** The one bucket every tunnel arrival without a usable `CF-Connecting-IP` shares. */
export const TUNNEL_SHARED_PEER = 'tunnel';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const HEXTET = /^[0-9A-Fa-f]{1,4}$/u;

/**
 * An IPv6 address as its /64 network, or nothing when it is not one.
 *
 * ONE SUBSCRIBER IS ONE /64. A single IPv6 customer is routinely given a whole /64 — 2^64 addresses —
 * so keying by the full address would hand one caller that many buckets and the per-peer bounds of §4
 * would bound nobody. An IPv4-mapped address is read as the IPv4 address it carries.
 */
function ipv6Network(value: string): string | undefined {
  if (value.includes('.')) {
    const mapped = /^::ffff:(.+)$/iu.exec(value)?.[1];
    return mapped !== undefined && IPV4.test(mapped) ? mapped : undefined;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every(group => HEXTET.test(group))) return undefined;
  return `${groups
    .slice(0, 4)
    .map(group => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * The rate-limit identity of one tunnel arrival: an IPv4 address whole, an IPv6 address by its /64, and
 * one shared bucket for anything else — so a caller that hides or garbles the header shares a bucket
 * rather than escaping one.
 */
export function tunnelPeer(headers: ApiHeaders): string {
  const value = headers.get(TUNNEL_PEER_HEADER)?.trim();
  if (value === undefined || value.length > 45) return TUNNEL_SHARED_PEER;
  if (IPV4.test(value)) return value;
  return (value.includes(':') ? ipv6Network(value) : undefined) ?? TUNNEL_SHARED_PEER;
}

/** Everything else on this listener is not served, and says nothing about what is. */
const NOT_SERVED = errorResponse(404, 'nothing is served at this path', 'not_found');

/**
 * The listener's whole surface: the session route as its ONLY socket route, and `404` for every
 * request that is not an upgrade to it.
 *
 * The socket table is the shared {@link ApiSocketDispatcher} over a router holding that one route, so
 * the upgrade is admitted by the same authorization code the main listener runs — the route is public
 * because its credential is the device proof inside the session, never anything on the upgrade.
 * `route` must be its OWN instance of the direct carrier's route, so tunnel arrivals are counted
 * against their own admission bounds and keyed by their own peers.
 */
export function tunnelListenerSurface(input: {
  readonly route: SocketRoute;
  readonly credentials: ApiCredentials;
  readonly guard: CapabilityGuard;
  /** The same browser origins the main listener admits: the PWA dials this exactly as it dials direct. */
  readonly corsOrigins: readonly string[];
}): ApiSurface {
  const sockets = new ApiSocketDispatcher(new ApiRouter([input.route]), input.credentials, input.guard);
  return {
    http: { dispatch: async () => NOT_SERVED },
    sockets: {
      // GET only: the router would answer another method on this path 405 (or 401 to a stranger),
      // which tells a prober the path exists. Here it is the same 404 as everything else.
      claims: request => request.method === 'GET' && sockets.claims(request),
      upgrade: async request => await sockets.upgrade(request),
    },
    corsOrigins: input.corsOrigins,
  };
}
