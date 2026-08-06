/**
 * The well-known loopback address of a local daemon, and what counts as loopback at all.
 *
 * SINGLE-SOURCED HERE because three production files have to agree on it — the daemon's own
 * configuration default, and the two places the command-line client decides where to reach a daemon
 * — and they live in packages that may not import each other. The protocol package is the one thing
 * all of them already depend on, and an address a client must know in order to speak the protocol at
 * all belongs beside the headers it must send.
 *
 * The hazard is not hypothetical. Repeated in three files, a moved default breaks every client that
 * has never written a configuration document, and it breaks them SILENTLY: the client keeps probing
 * the old port, finds nothing, and reports the daemon down while it is serving perfectly on the new
 * one. `scripts/validate/cli-contracts.sh daemon-default-address` pins the single source so the
 * literal cannot reappear elsewhere, the same way the two-name model is pinned.
 */

import { decideAdvertisement } from './advertisement.ts';

/** Loopback, never a routable interface: a daemon binds the machine it runs on and nothing else. */
export const LOOPBACK = '127.0.0.1';

/**
 * Every spelling of loopback AN OPERATOR MAY WRITE, which is not the same set a socket reports.
 *
 * ONE FACT, TWO INPUT DOMAINS, AND THAT IS WHY THERE ARE TWO FUNCTIONS BELOW. This predicate had five
 * definitions across four packages and no two of the first three agreed — yet each was locally
 * correct, because a configured host is a NAME an operator types and a peer address is what a
 * transport reports. `localhost` belongs in one and can never appear in the other; the IPv4-mapped
 * IPv6 form belongs in the other and no operator writes it. Five anonymous sets made the difference
 * invisible; two named functions make reaching for the wrong one hard.
 *
 * The whole authorization model rests on this predicate (see `docs/grants.md`), and the pairing
 * advertisement rests on it too, so it is single-sourced here for the reason the port literal above
 * is: the packages that must agree on it may not import one another.
 */
const LOOPBACK_HOST_SPELLINGS: ReadonlySet<string> = new Set([LOOPBACK, '::1', '[::1]', 'localhost']);

/** A host SPELLING, as an operator writes one: names included. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST_SPELLINGS.has(host);
}

/**
 * A socket's PEER ADDRESS, as a transport reports one.
 *
 * `::ffff:127.0.0.1` is here because that is what a dual-stack socket actually reports for a v4
 * client, and a check missing it reads somebody at the machine as a stranger. No name is here,
 * because a peer address is never a name.
 */
const LOOPBACK_PEER_ADDRESSES: ReadonlySet<string> = new Set([LOOPBACK, '::1', `::ffff:${LOOPBACK}`]);

/** A socket's peer address, as a transport reports one: IPv4-mapped IPv6 included, names never. */
export function isLoopbackPeer(address: string): boolean {
  return LOOPBACK_PEER_ADDRESSES.has(address);
}

/**
 * A bind that names EVERY interface, so no single address can be derived from it.
 *
 * A daemon serves perfectly on one of these. What is undefined is only which address to hand out:
 * `http://0.0.0.0:…` is a bind instruction, not somewhere a device can dial, and handing it to a
 * phone is a link that fails with nothing to explain it.
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);

/** A bind that names every interface, so no advertisement can be derived from it. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/**
 * The port a daemon binds when its operator has named none.
 *
 * DELIBERATELY NOT 7337. That number was inherited from the agent supervisor this product replaces,
 * which listens on it on every machine this one is being installed onto — so the inherited default
 * collided for exactly the audience that matters, and the two are required to run side by side for
 * the whole migration. It is a well-known-port choice rather than an arbitrary one: unassigned,
 * clear of the crowded 3000/4000/5000/8000/8080 development ports, above the privileged range, and
 * below every platform's ephemeral range, so nothing on a developer's machine is expected to hold it.
 */
export const FY_DEFAULT_DAEMON_PORT = 7431;

/** Where a client looks for a daemon when nothing has told it otherwise. */
export const FY_DEFAULT_DAEMON_URL = daemonAddress(LOOPBACK, FY_DEFAULT_DAEMON_PORT);

/**
 * A daemon's address, composed the ONE way both sides must compose it.
 *
 * A daemon that derives its own address one way while a client derives it another is a daemon the
 * client cannot find, and the failure is silent on both ends: the daemon serves happily and the
 * client reports it down. One function, called from both. A raw IPv6 host is wrapped as an authority
 * exactly once; without the brackets, a correctly classified `::1` loopback becomes an invalid URL
 * before pairing can mint its local-only link.
 */
export function daemonAddress(host: string, port: number): string {
  const authorityHost = host.startsWith('[') && host.endsWith(']') ? host : host.includes(':') ? `[${host}]` : host;
  return `http://${authorityHost}:${String(port)}`;
}

/**
 * The address recorded in a daemon's configuration document, or `undefined` when it records none.
 *
 * WHY A CLIENT READS THIS AT ALL: the daemon may choose its own port. A first boot whose preferred
 * port is taken binds the next free one and writes the choice down, so a client that assumed the
 * default would be looking at an address its daemon deliberately moved off. The recorded value is
 * the daemon's answer to "where am I", and following it is what makes the fallback safe.
 *
 * IT READS THE SAME DECISION THE DAEMON DOES. This is a SEPARATE derivation site in a separate
 * package with its own coverage ledger, so a daemon-side fix does not reach it — and disagreement is
 * a client dialling an address its daemon does not consider its own. `local-only` is still returned:
 * this reader runs ON the host, which is exactly the caller such an address is right for.
 *
 * TOLERANT BY DESIGN, and that is not the usual rule here. A document this cannot read leaves a
 * client using the well-known default — the same place it looked before any of this existed — which
 * fails by reporting the daemon unreachable. The DAEMON parses the same document strictly and
 * refuses to boot on damage, which is where a damaged document must be caught.
 */
export function recordedDaemonAddress(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null) return undefined;
  const recorded = document as { readonly host?: unknown; readonly port?: unknown; readonly publicUrl?: unknown };
  const publicUrl = typeof recorded.publicUrl === 'string' ? recorded.publicUrl.trim() : '';
  const advertisement = decideAdvertisement({
    ...(publicUrl === '' ? {} : { operatorPublicUrl: publicUrl }),
    host: typeof recorded.host === 'string' && recorded.host.trim() !== '' ? recorded.host : LOOPBACK,
    ...(typeof recorded.port === 'number' && Number.isInteger(recorded.port) ? { port: recorded.port } : {}),
  });
  return advertisement.kind === 'none' ? undefined : advertisement.url;
}
