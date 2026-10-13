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
 * Builds a browser request bound to one daemon. It carries no credential — the session it is
 * routed onto does — so the only thing it adds is the daemon's own address for the path.
 */
export const daemonRequest = (daemon: DaemonConnection, path: string, init: RequestInit = {}): DaemonRequest => ({
  url: daemonUrl(daemon, path),
  init: { ...init, credentials: 'include' },
});
