/** Host spellings that name this machine (copied from today's protocol address helpers; pure). */
const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/** One group of an IPv6 spelling, which is where an all-zero or all-but-one-zero address is read. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;

/** The number of groups a whole IPv6 address has, and the index of the one loopback sets. */
const IPV6_GROUP_COUNT = 8;
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

/** A host SPELLING, as an operator writes one: names included. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}
