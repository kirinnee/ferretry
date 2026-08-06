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
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set([WILDCARD_BIND_HOST, '::', '[::]']);

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
 * WHERE A CLIENT ON THIS MACHINE DIALS THE DAEMON, read from what the daemon wrote down.
 *
 * WHY A CLIENT READS THIS AT ALL: the daemon may choose its own port. A first boot whose preferred
 * port is taken binds the next free one and writes the choice down, so a client that assumed the
 * default would be looking at an address its daemon deliberately moved off. The recorded value is
 * the daemon's answer to "where am I", and following it is what makes the fallback safe.
 *
 * IT READS THE BIND AND NEVER THE ADVERTISEMENT, which is the whole reason it is a separate function
 * from `decideAdvertisement`. `publicUrl` answers a DIFFERENT question — where somebody ELSE reaches
 * this machine — and welding the two is the defect `advertisement.ts` was written to remove, applied
 * to the inbound direction: an operator who followed the advice to advertise a routed address made
 * their own command line classify the daemon on their desk as remote, and the local command that
 * mints a pairing code refused to run at all. So `publicUrl` is not read here, and an operator
 * describing a reverse proxy or a tunnel does not move the socket their own client dials.
 *
 * A WILDCARD BIND ANSWERS LOOPBACK. A daemon told to accept every interface is listening on loopback
 * too, and loopback is the one spelling that keeps an owner-only credential on the machine that
 * issued it. Answering with the wildcard authority itself — a bind instruction, not a destination —
 * is how this used to report a healthy daemon unreachable while it served one interface away.
 *
 * TOLERANT BY DESIGN, and that is not the usual rule here. A document this cannot read leaves a
 * client using the well-known default — the same place it looked before any of this existed — which
 * fails by reporting the daemon unreachable. The DAEMON parses the same document strictly and
 * refuses to boot on damage, which is where a damaged document must be caught.
 */
export function recordedBindAddress(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null) return undefined;
  const recorded = document as { readonly host?: unknown; readonly port?: unknown };
  // The port is the one field with no safe assumption: a recorded document that names none has not
  // said where its daemon went, and guessing would send a client to somebody else's socket.
  if (typeof recorded.port !== 'number' || !Number.isInteger(recorded.port)) return undefined;
  const host = typeof recorded.host === 'string' && recorded.host.trim() !== '' ? recorded.host.trim() : LOOPBACK;
  return daemonAddress(isWildcardHost(host) ? LOOPBACK : host, recorded.port);
}
