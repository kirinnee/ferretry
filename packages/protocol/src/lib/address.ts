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
export const FY_DEFAULT_DAEMON_PORT = 7089;

/** Where a client looks for a daemon when nothing has told it otherwise. */
export const FY_DEFAULT_DAEMON_URL = `http://${LOOPBACK}:${String(FY_DEFAULT_DAEMON_PORT)}`;
