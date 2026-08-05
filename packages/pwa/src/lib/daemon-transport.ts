/**
 * ONE REQUEST SHAPE, WHICHEVER CARRIER TAKES IT.
 *
 * Everything here still builds a request against the daemon's OWN address, and that
 * stays true on a relay: `docs/relay-protocol.md` §14 says a relayed request carries
 * the daemon's own raw pathname, nothing normalises it, and it reaches exactly the
 * route table a direct request reaches. So the URL below is either dialled (direct)
 * or read apart into a §14 record by `relay-carrier.ts` — and because it is the same
 * URL either way, there is no second request surface to keep in step.
 *
 * The bearer header attached here is DROPPED by that translation, deliberately. §14
 * refuses a relayed request that carries its own `authorization`: the credential is
 * the device grant that opened the session, and it is the same token, so dropping it
 * removes a duplicate rather than a credential. Attaching it here anyway is what
 * keeps the direct path — the common one — free of a carrier-shaped special case.
 */

import type { DaemonConnection } from './daemon-connection.ts';

const requirePath = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//')) throw new Error('daemon path must be an origin-relative path');
  return value;
};

/** Resolves a path against the paired daemon, never against the page origin. */
export const daemonUrl = (daemon: DaemonConnection, path: string): string => {
  const url = new URL(requirePath(path), `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin) throw new Error('daemon path must remain on the paired daemon');
  return url.toString();
};

export interface DaemonRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Builds an authenticated browser request bound to one daemon.  Credentials
 * are included for daemon-side access adapters; the device token stays in a
 * header and is never placed in a URL.
 */
export const daemonRequest = (daemon: DaemonConnection, path: string, init: RequestInit = {}): DaemonRequest => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${daemon.deviceToken}`);
  return { url: daemonUrl(daemon, path), init: { ...init, headers, credentials: 'include' } };
};

/**
 * Produces an event endpoint using a short-lived ticket.  The device token is
 * intentionally absent: browsers cannot send WS headers and a durable token
 * in a query string would leak into logs.
 *
 * THIS ONE IS DIRECT-ONLY, and it is the exception the relay protocol names rather
 * than an oversight: §14 does not carry a protocol-switching surface, so a relayed
 * connection has no event stream at all. `event-transport.ts` refuses on a relay
 * carrier instead of handing this URL to a socket that would open on nothing.
 */
export const daemonEventUrl = (daemon: DaemonConnection, ticket: string): string => {
  if (ticket.trim() === '') throw new Error('websocket ticket must not be empty');
  const url = new URL(daemonUrl(daemon, '/v1/events'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
};
