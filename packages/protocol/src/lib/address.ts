/**
 * The well-known loopback address of a local daemon.
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
const LOOPBACK = '127.0.0.1';

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
 * client reports it down. One function, called from both.
 */
export function daemonAddress(host: string, port: number): string {
  return `http://${host}:${String(port)}`;
}

/**
 * The address recorded in a daemon's configuration document, or `undefined` when it records none.
 *
 * WHY A CLIENT READS THIS AT ALL: the daemon may choose its own port. A first boot whose preferred
 * port is taken binds the next free one and writes the choice down, so a client that assumed the
 * default would be looking at an address its daemon deliberately moved off. The recorded value is
 * the daemon's answer to "where am I", and following it is what makes the fallback safe.
 *
 * TOLERANT BY DESIGN, and that is not the usual rule here. A document this cannot read leaves a
 * client using the well-known default — the same place it looked before any of this existed — which
 * fails by reporting the daemon unreachable. That is a recoverable, visible outcome, and it is the
 * behaviour a client wants from a file it does not own. The DAEMON parses the same document
 * strictly and refuses to boot on damage, which is where a damaged document must be caught.
 */
export function recordedDaemonAddress(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null) return undefined;
  const recorded = document as { readonly host?: unknown; readonly port?: unknown; readonly publicUrl?: unknown };
  // The advertised address wins when an operator set one, exactly as the daemon resolves it.
  if (typeof recorded.publicUrl === 'string' && recorded.publicUrl.trim() !== '') return recorded.publicUrl.trim();
  if (typeof recorded.port !== 'number' || !Number.isInteger(recorded.port)) return undefined;
  return daemonAddress(
    typeof recorded.host === 'string' && recorded.host.trim() !== '' ? recorded.host : LOOPBACK,
    recorded.port,
  );
}
