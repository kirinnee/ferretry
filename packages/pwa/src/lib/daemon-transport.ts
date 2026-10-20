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
 * THERE IS NO CREDENTIAL IN IT. A paired browser holds no bearer value: the device
 * key that opened the session the request rides on is the credential, and §14
 * refuses a request that carries its own `authorization` anyway. Both carriers are
 * sessions now, so nothing built here is ever sent as plain HTTP to a daemon.
 */

import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

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

/**
 * WHICH DAEMON A REQUEST IS FOR, carried beside the URL because the URL cannot say.
 *
 * Every daemon a phone pairs with over the hosted relay announces its own loopback — two machines,
 * one loopback origin — so an origin names an address, never a machine. Routing by origin sent
 * every request for the first machine to whichever machine was paired last, and both rows read as that
 * one. The router (`relay-carrier.ts`) routes by this binding instead.
 *
 * A symbol key, so it survives the `{ ...init }` every caller spreads and is never serialised: `fetch`
 * reads only the members it knows, and a relayed request record is built from named fields.
 */
const DAEMON_BINDING: unique symbol = Symbol('ferretry.daemon');

type DaemonBoundInit = RequestInit & { readonly [DAEMON_BINDING]?: DaemonId };

/** The request options, sent with the browser's credentials and bound to exactly one paired daemon. */
export const daemonBound = (daemon: DaemonConnection, init: RequestInit = {}): RequestInit => {
  const bound: DaemonBoundInit = { ...init, credentials: 'include', [DAEMON_BINDING]: daemon.daemonId };
  return bound;
};

/** The daemon a request was bound to by {@link daemonBound}, or `undefined` for an unbound request. */
export const boundDaemonId = (init: RequestInit | undefined): DaemonId | undefined =>
  (init as DaemonBoundInit | undefined)?.[DAEMON_BINDING];

export interface DaemonRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Builds a browser request bound to one daemon. It carries no credential — the session it is
 * routed onto does — so what it adds is the daemon's own address for the path, and which daemon
 * that address belongs to ({@link daemonBound}).
 */
export const daemonRequest = (daemon: DaemonConnection, path: string, init: RequestInit = {}): DaemonRequest => ({
  url: daemonUrl(daemon, path),
  init: daemonBound(daemon, init),
});
