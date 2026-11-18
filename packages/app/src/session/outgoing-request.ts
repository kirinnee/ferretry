import { acceptEncodingHeader } from './compression.ts';

/** The part of a request frame this module reads: its verb and headers. The session owns the full frame type. */
interface Askable {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The request as it goes out: what was asked, plus the two things THIS side adds to every request. EVERY request
 * of a session, direct or relayed, passes through here (`RelayClientSession.request`): the one place both are decided.
 *
 * - A relayed answer is not a browser fetch, so this side asks for gzip itself (and decodes it on the way
 *   back). Only a `GET` is ever answered compressed, so nothing else carries the header.
 * - `attended` is asked once per request: is a person at this device right now? A yes marks the request
 *   `presence`, the ONE thing the daemon counts as use (its idle clock moves on a marked request and on
 *   nothing else, a renewal included). Absent, no request is marked. The browser's answer lives in the
 *   transport, not in the pure session module.
 */
export function outgoingRequest<T extends Askable>(
  asked: T,
  attended?: () => boolean,
): T | (T & { readonly presence: true }) {
  const asking = asked.method === 'GET' ? acceptEncodingHeader() : {};
  const compressed = Object.keys(asking).length === 0 ? asked : { ...asked, headers: { ...asking, ...asked.headers } };
  return attended?.() === true ? { ...compressed, presence: true as const } : compressed;
}
