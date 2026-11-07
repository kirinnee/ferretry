/**
 * Where a client on this machine dials the daemon, and what counts as this machine (P90, S57).
 * Copied from today's `protocol/address.ts` and `cli/lib/daemon/address.ts`, whole-domain loopback rule intact.
 */

/** Loopback, never a routable interface: a daemon binds the machine it runs on and nothing else. */
export const LOOPBACK = '127.0.0.1';
/** The port a daemon binds when its operator has named none. */
export const DEFAULT_DAEMON_PORT = 7431;

const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;
const IPV6_GROUP_COUNT = 8;

function bareHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

function ipv6GroupsOf(half: string): readonly number[] | undefined {
  if (half === '') return [];
  const groups = half.split(':').map(group => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

/** The eight groups of an IPv6 spelling, or `undefined` when the host is not one. `::`, `::0` and the long form agree. */
function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = ipv6GroupsOf(halves[0] ?? '');
  const tail = ipv6GroupsOf(halves[1] ?? '');
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  return elided < 1 ? undefined : [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** A host spelling as an operator writes one: names included. All of `127.0.0.0/8`, `::1`, `*.localhost`. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}

/** Every spelling of the unspecified address (`0.0.0.0`, `::`, `::0`, …): a bind instruction, not a destination. */
export function isWildcardHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === '0.0.0.0') return true;
  const groups = ipv6Groups(bare);
  return groups !== undefined && groups.every(group => group === 0);
}

export function daemonAddress(host: string, port: number): string {
  const authorityHost = host.startsWith('[') && host.endsWith(']') ? host : host.includes(':') ? `[${host}]` : host;
  return `http://${authorityHost}:${String(port)}`;
}

export const DEFAULT_DAEMON_URL = daemonAddress(LOOPBACK, DEFAULT_DAEMON_PORT);

/**
 * Whether a daemon URL names this machine and may therefore be sent a locally minted credential. Decided from the
 * URL, never from whether `FY_URL` was set. A URL that will not parse is not loopback: guessing wrong in that
 * direction sends a credential off this machine.
 */
export function isLocalDaemonUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function declaredBind(document: object): object {
  const carriers = (document as { readonly carriers?: unknown }).carriers;
  if (!Array.isArray(carriers)) return document;
  const bind: unknown = carriers.find(
    entry => typeof entry === 'object' && entry !== null && (entry as { readonly kind?: unknown }).kind === 'bind',
  );
  return (bind as object | undefined) ?? document;
}

/**
 * Where the daemon says it listens, from `config/daemon.json`: the BIND, never the advertisement (`publicUrl`
 * answers where somebody else reaches this machine). A wildcard bind answers loopback. Tolerant by design: a
 * document this cannot read leaves the client on the well-known default, which fails by reporting the daemon away.
 */
export function recordedBindAddress(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null) return undefined;
  const recorded = declaredBind(document) as { readonly host?: unknown; readonly port?: unknown };
  if (typeof recorded.port !== 'number' || !Number.isInteger(recorded.port)) return undefined;
  const host = typeof recorded.host === 'string' && recorded.host.trim() !== '' ? recorded.host.trim() : LOOPBACK;
  return daemonAddress(isWildcardHost(host) ? LOOPBACK : host, recorded.port);
}

/** An explicit `FY_URL` wins outright (P90); then what the daemon recorded; then the well-known default. */
export function resolveDaemonUrl(explicitUrl: string, documentText: string | undefined): string {
  if (explicitUrl.trim() !== '') return explicitUrl.trim();
  if (documentText === undefined) return DEFAULT_DAEMON_URL;
  try {
    return recordedBindAddress(JSON.parse(documentText)) ?? DEFAULT_DAEMON_URL;
  } catch {
    return DEFAULT_DAEMON_URL;
  }
}
