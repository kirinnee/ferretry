/**
 * The wire formats of the proxy sign-in relay (docs/browser-proxy.md#credentials): Chrome speaks plain HTTP
 * proxying to a loopback port, and the relay speaks to the real proxy — adding the credentials Chrome's
 * `--proxy-server` has no way to carry. Pure: bytes and strings in, bytes and strings out.
 */
import type { ProxyEndpoint } from './endpoint.ts';

export interface Destination {
  readonly host: string;
  readonly port: number;
}

export interface RequestHead {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
}

/** The most a request head may be before the relay refuses it: a proxy request line plus headers is small. */
export const MAX_HEAD_BYTES = 16 * 1024;

const HEAD_END = new Uint8Array([13, 10, 13, 10]);

/** Where the first request head ends (the index just past its blank line), or -1 while it is incomplete. */
export function headEnd(buffer: Uint8Array): number {
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (HEAD_END.every((byte, offset) => buffer[index + offset] === byte)) return index + 4;
  }
  return -1;
}

export function parseRequestHead(text: string): RequestHead | undefined {
  const [requestLine = '', ...lines] = text.split('\r\n');
  const match = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/u.exec(requestLine);
  if (match === null) return undefined;
  const headers: (readonly [string, string])[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return undefined;
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { method: match[1] as string, target: match[2] as string, version: match[3] as string, headers };
}

/** `host:port` or `[v6]:port`, as a CONNECT carries it. */
export function parseAuthority(value: string): Destination | undefined {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:/[\]]+)):(\d{1,5})$/u.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host, port };
}

/** A plain-HTTP request in the absolute form a proxy receives, split into where it goes and what the origin sees. */
export function parsePlainTarget(
  target: string,
): { readonly destination: Destination; readonly path: string } | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') return undefined;
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1');
  return {
    destination: { host, port: url.port === '' ? 80 : Number(url.port) },
    path: `${url.pathname}${url.search}` || '/',
  };
}

export function basicProxyAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** Header names a hop must not pass on: this relay speaks one request per connection and signs in for itself. */
const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive']);

/**
 * The request as the next hop receives it: the target given, the hop-by-hop headers replaced, and
 * `Connection: close` so one connection carries one request and the next one is read afresh.
 */
export function forwardedHead(head: RequestHead, target: string, proxyAuthorization?: string): string {
  const lines = head.headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())).map(([n, v]) => `${n}: ${v}`);
  if (proxyAuthorization !== undefined) lines.push(`Proxy-Authorization: ${proxyAuthorization}`);
  lines.push('Connection: close');
  return `${head.method} ${target} ${head.version}\r\n${lines.join('\r\n')}\r\n\r\n`;
}

export function connectHead(destination: Destination, proxyAuthorization?: string): string {
  const authority = destination.host.includes(':') ? `[${destination.host}]` : destination.host;
  const auth = proxyAuthorization === undefined ? '' : `Proxy-Authorization: ${proxyAuthorization}\r\n`;
  return `CONNECT ${authority}:${destination.port} HTTP/1.1\r\nHost: ${authority}:${destination.port}\r\n${auth}\r\n`;
}

/** The status code of an HTTP response head, or `undefined` while it is incomplete or not HTTP. */
export function responseStatus(buffer: Uint8Array): { readonly code: number; readonly length: number } | undefined {
  const end = headEnd(buffer);
  if (end < 0) return undefined;
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(new TextDecoder().decode(buffer.subarray(0, end)));
  return match === null ? { code: 0, length: end } : { code: Number(match[1]), length: end };
}

export const CONNECT_ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n';

export function gatewayFailure(reason: string): string {
  const body = `${reason}\n`;
  return `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

export function badRequest(): string {
  return 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function ipv6Bytes(host: string): Uint8Array | undefined {
  const [head = '', tail, ...rest] = host.split('::');
  if (rest.length > 0) return undefined;
  const groups = (text: string): string[] | undefined => {
    if (text === '') return [];
    const parts = text.split(':');
    return parts.every(part => /^[0-9A-Fa-f]{1,4}$/u.test(part)) ? parts : undefined;
  };
  const before = groups(head);
  const after = tail === undefined ? [] : groups(tail);
  if (before === undefined || after === undefined) return undefined;
  const missing = 8 - before.length - after.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const all = [...before, ...Array.from({ length: tail === undefined ? 0 : missing }, () => '0'), ...after];
  const bytes = new Uint8Array(16);
  all.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/** RFC 1928 and RFC 1929: the three messages a client sends and the replies it reads. */
export const socks5 = {
  /** Offers "no authentication" and, when there are credentials to give, "username/password". */
  greeting: (withCredentials: boolean): Uint8Array =>
    withCredentials ? new Uint8Array([5, 2, 0, 2]) : new Uint8Array([5, 1, 0]),

  /** The method the server chose, or `undefined` while the two bytes have not all arrived. */
  methodChoice: (reply: Uint8Array): 'none' | 'password' | 'refused' | undefined => {
    if (reply.length < 2) return undefined;
    if (reply[0] !== 5) return 'refused';
    return reply[1] === 0 ? 'none' : reply[1] === 2 ? 'password' : 'refused';
  },

  authRequest: (username: string, password: string): Uint8Array | undefined => {
    const user = Buffer.from(username, 'utf8');
    const pass = Buffer.from(password, 'utf8');
    if (user.length === 0 || user.length > 255 || pass.length === 0 || pass.length > 255) return undefined;
    return new Uint8Array([1, user.length, ...user, pass.length, ...pass]);
  },

  /** `true` accepted, `false` refused, `undefined` still incomplete. */
  authAccepted: (reply: Uint8Array): boolean | undefined => (reply.length < 2 ? undefined : reply[1] === 0),

  connectRequest: (destination: Destination): Uint8Array | undefined => {
    const port = [destination.port >> 8, destination.port & 0xff];
    const v4 = IPV4.exec(destination.host);
    if (v4 !== null) {
      const octets = v4.slice(1).map(Number);
      return octets.every(octet => octet <= 255) ? new Uint8Array([5, 1, 0, 1, ...octets, ...port]) : undefined;
    }
    if (destination.host.includes(':')) {
      const bytes = ipv6Bytes(destination.host);
      return bytes === undefined ? undefined : new Uint8Array([5, 1, 0, 4, ...bytes, ...port]);
    }
    const name = Buffer.from(destination.host, 'utf8');
    if (name.length === 0 || name.length > 255) return undefined;
    return new Uint8Array([5, 1, 0, 3, name.length, ...name, ...port]);
  },

  /** Where a connect reply ends, or why it failed; `incomplete` until the whole variable-length reply is here. */
  connectReply: (
    reply: Uint8Array,
  ):
    | { readonly state: 'incomplete' }
    | { readonly state: 'ok'; readonly length: number }
    | { readonly state: 'failed'; readonly why: string } => {
    if (reply.length < 4) return { state: 'incomplete' };
    if (reply[0] !== 5) return { state: 'failed', why: 'the proxy did not answer in SOCKS5' };
    if (reply[1] !== 0) return { state: 'failed', why: socksFailure(reply[1] as number) };
    const address = reply[3];
    const length = address === 1 ? 10 : address === 4 ? 22 : address === 3 ? 7 + (reply[4] ?? 0) : 0;
    if (length === 0) return { state: 'failed', why: 'the proxy answered with an address this relay cannot read' };
    return reply.length < length ? { state: 'incomplete' } : { state: 'ok', length };
  },
};

function socksFailure(code: number): string {
  switch (code) {
    case 2:
      return 'the proxy refused the connection by its rules';
    case 3:
      return 'the proxy has no route to that network';
    case 4:
      return 'the proxy could not reach that host';
    case 5:
      return 'that host refused the connection';
    case 6:
      return 'the connection timed out at the proxy';
    case 7:
      return 'the proxy does not support that command';
    case 8:
      return 'the proxy does not support that address type';
    default:
      return 'the proxy reported a general failure';
  }
}

/** The words for a proxy that is not reachable, for the one sentence a page and an owner see. */
export function proxyUnreachable(endpoint: ProxyEndpoint): string {
  return `the browser proxy at ${endpoint.scheme}://${endpoint.host}:${endpoint.port} could not be reached`;
}
