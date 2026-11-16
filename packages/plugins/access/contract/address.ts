/**
 * The host-name facts pairing's reach answer reads (today's `protocol/src/lib/address.ts`), copied verbatim. Placement
 * gives them to the kernel's wire; until the kernel contract exports them, Access keeps this private copy and re-points
 * its imports when it does. The advertisement itself is Connections' (`ConnectionsApi.advertisement()`).
 */

/**
 * IT OWNS THE WHOLE DOMAIN, NOT THE FAMILIAR SPELLINGS. `127.0.0.0/8` is loopback in its entirety,
 * and an operator who binds `127.0.0.2` to keep two daemons apart is doing something supported;
 * `.localhost` is loopback because RFC 6761 reserves it to resolve to nowhere else. The command-line
 * client knew both and this owner knew neither, which is the exact shape of the defect single-sourcing
 * is supposed to prevent: `127.0.0.2` was this machine to the client spending an owner-only token on
 * it, and a stranger to the pairing advertisement, which duly minted a QR code for an address only
 * this machine can dial. One fact cannot be two answers, so the wider domain is the one that
 * lives here and the narrower copy is gone.
 *
 * The block is matched in its entirety, with every octet held to a real one: an address nothing can
 * hold is not one this machine answers on, and adopting it would be guessing in the direction that
 * spends a credential.
 */
const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/** One group of an IPv6 spelling, which is where an all-zero or all-but-one-zero address is read. */
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

/** A host SPELLING, as an operator writes one: names included. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}

/**
 * The wildcard an operator is TOLD TO WRITE when a daemon must accept more than loopback.
 *
 * Single-sourced beside the loopback spelling and for the same reason: the advertisement's remedy
 * names this value in a sentence somebody will copy into a configuration document, and a remedy that
 * spells a host the predicate below does not recognise is advice that quietly does nothing.
 */
export const WILDCARD_BIND_HOST = '0.0.0.0';

/**
 * A bind that names EVERY interface, so no single address can be derived from it.
 *
 * A daemon serves perfectly on one of these. What is undefined is only which address to hand out:
 * a wildcard authority is a bind instruction, not somewhere a device can dial, and handing it to a
 * phone is a link that fails with nothing to explain it.
 *
 * EVERY SPELLING OF THE UNSPECIFIED ADDRESS, read from the groups rather than listed. `::`, `::0` and
 * `0:0:0:0:0:0:0:0` are the same bind, and a list holding only the first classified the other two as
 * a routable interface — so the two operators who wrote them got an advertisement composed out of a
 * bind instruction instead of the refusal that names the remedy.
 */
export function isWildcardHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === WILDCARD_BIND_HOST) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every(group => group === 0);
}

/** What the daemon can hand out as its own address, and why it has none: Connections owns both. */
export {
  ADVERTISEMENT_REFUSALS,
  type Advertisement,
  type AdvertisementRefusal,
  type ConnectionAdvertisement,
} from '@ferretry/plugin-connections/contract';
