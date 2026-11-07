// Copied from protocol/address.ts and advertisement.ts; one decision, no caller-dependent locality.
import { isLoopbackHost, type Advertisement } from '../../../contract/index.ts';
const WILDCARD_BIND_HOST = '0.0.0.0';
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;

/** The number of groups a whole IPv6 address has, and the index of the one loopback sets. */
const IPV6_GROUP_COUNT = 8;

/**
 * A host spelling with the decorations an operator's spelling may carry taken off.
 *
 * Case is not meaningful in a host name and brackets are not part of one — they are how an authority
 * carries a raw IPv6 address, and `daemonAddress` above puts them on. Taking both off once, here, is
 * what keeps the predicates below from being a list of spellings somebody must remember to extend.
 */
function bareHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

/**
 * The eight groups of an IPv6 spelling, or `undefined` when the host is not one.
 *
 * READ RATHER THAN LISTED, because `::`, `::0` and `0:0:0:0:0:0:0:0` are one address and a set that
 * held only the first called the other two routable. A daemon bound to every interface under either
 * of the other two spellings therefore had an advertisement derived from a bind instruction, and the
 * phone was handed a link that fails with nothing to explain it. Reading the groups leaves no
 * spelling of an all-zero address unrecognised, which no list of them can promise.
 *
 * The IPv4-mapped form is deliberately NOT read here. It is what a socket reports and never what an
 * operator writes, so it belongs to `isLoopbackPeer` below and to nothing in this domain.
 */
function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = ipv6GroupsOf(halves[0] ?? '');
  const tail = ipv6GroupsOf(halves[1] ?? '');
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  // `::` stands for at least one elided group, so a spelling that leaves none is not an address.
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  return elided < 1 ? undefined : [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** The groups on one side of a `::`, or `undefined` when any of them is not a group at all. */
function ipv6GroupsOf(half: string): readonly number[] | undefined {
  if (half === '') return [];
  const groups = half.split(':').map(group => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

export function isWildcardHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === WILDCARD_BIND_HOST) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every(group => group === 0);
}

export function daemonAddress(host: string, port: number): string {
  const authorityHost = host.startsWith('[') && host.endsWith(']') ? host : host.includes(':') ? `[${host}]` : host;
  return `http://${authorityHost}:${String(port)}`;
}

export function decideAdvertisement(input: {
  /** An operator's own `publicUrl`. Handed back verbatim, never validated against the bind. */
  readonly operatorPublicUrl?: string;
  readonly host: string;
  readonly port?: number;
}): Advertisement {
  if (input.operatorPublicUrl !== undefined)
    return { kind: 'address', url: input.operatorPublicUrl, origin: 'operator' };
  if (isWildcardHost(input.host)) return { kind: 'none', refusal: 'wildcard-bind' };
  if (input.port === undefined) return { kind: 'none', refusal: 'no-port' };
  const url = daemonAddress(input.host, input.port);
  return isLoopbackHost(input.host) ? { kind: 'local-only', url } : { kind: 'address', url, origin: 'derived' };
}
