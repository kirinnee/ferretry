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
 */
export const daemonEventUrl = (daemon: DaemonConnection, ticket: string): string => {
  if (ticket.trim() === '') throw new Error('websocket ticket must not be empty');
  const url = new URL(daemonUrl(daemon, '/v1/events'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
};
