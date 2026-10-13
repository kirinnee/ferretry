/**
 * THE DIRECT CARRIER'S ONE ROUTE: where a browser that can reach this daemon opens a session.
 *
 * The session itself is `lib/relay/direct-carrier.ts` — the same `RelayLink` a rendezvous socket
 * runs, over one socket to this listener. This file is only where the route is DECLARED, beside every
 * other route this daemon serves, so the route-agreement gate counts it like any other — and where an
 * upgrade is ADMITTED, before any public-key work is done for it.
 *
 * ADMISSION IS THE CHEAP CHECK IN FRONT OF THE EXPENSIVE ONE. Every socket's hello costs the daemon a
 * key agreement and a signature before anything about the caller is known, so three bounds run first:
 *
 * - **per peer:** {@link DIRECT_UPGRADES_PER_PEER} upgrades a minute from one address, so one host on
 *   the network cannot loop handshakes;
 * - **unproven:** at most {@link MAX_DIRECT_UNPROVEN_SESSIONS} sockets that have not proved a device,
 *   so strangers cannot starve the devices that can;
 * - **total:** {@link MAX_DIRECT_SESSIONS}.
 *
 * A SLOT IS TAKEN WHEN THE UPGRADE IS ADMITTED, not when the socket attaches. Counting at attach let a
 * burst of concurrent upgrades all pass the check before any of them was counted. A reserved slot whose
 * socket never attaches — the upgrade failed after the answer — is handed back after ten seconds, the
 * same window an attached socket gets to prove itself.
 */

import { ApiError } from '../../api/error.ts';
import type { SocketRoute } from '../../api/socket.ts';
import {
  DIRECT_UPGRADE_WINDOW_MS,
  DIRECT_UPGRADES_PER_PEER,
  type DirectCarrierDependencies,
  DirectSession,
  MAX_DIRECT_SESSIONS,
  MAX_DIRECT_UNPROVEN_SESSIONS,
} from '../../relay/direct-carrier.ts';

/** How long an admitted upgrade may take to attach before its slot is handed back. */
const ATTACH_DEADLINE_MS = 10_000;
/** Peers remembered at once; past this, windows that have ended are forgotten first. */
const MAX_REMEMBERED_PEERS = 4_096;

interface PeerWindow {
  startedAtMs: number;
  upgrades: number;
}

/** The socket route a browser dials for a direct session. */
export function directCarrierSocketRoute(deps: DirectCarrierDependencies): SocketRoute {
  let live = 0;
  let unproven = 0;
  const peers = new Map<string, PeerWindow>();

  /** One upgrade from this peer, inside the window — or `false` when it has used its share. */
  const admitPeer = (peer: string, now: number): boolean => {
    const window = peers.get(peer);
    if (window === undefined || now - window.startedAtMs >= DIRECT_UPGRADE_WINDOW_MS) {
      if (peers.size >= MAX_REMEMBERED_PEERS)
        for (const [key, value] of peers) if (now - value.startedAtMs >= DIRECT_UPGRADE_WINDOW_MS) peers.delete(key);
      peers.set(peer, { startedAtMs: now, upgrades: 1 });
      return true;
    }
    window.upgrades += 1;
    return window.upgrades <= DIRECT_UPGRADES_PER_PEER;
  };

  return {
    method: 'GET',
    path: '/v1/rendezvous/:daemonId/client',
    // PUBLIC, because the credential is not on the upgrade: it is the device's proof inside the
    // session that this socket carries. An upgrade with no credential is exactly what a rendezvous
    // accepts too, and for the same reason.
    minimum: 'none',
    accept: async ({ request, params }) => {
      // A session cannot open a session. The tunnel dispatches a stream's path through this same
      // socket table, and a nested direct session would be a carrier inside a carrier with nobody's
      // locality to stamp on it.
      if (request.device !== undefined) throw new ApiError(404, 'no stream is served at this path', 'not_found');
      if (params.get('daemonId') !== deps.identity.daemonId)
        throw new ApiError(404, 'this daemon does not answer for that fingerprint', 'not_found');
      // A peer with no address is keyed as one — never waved through as nobody.
      if (!admitPeer(request.clientAddress ?? 'unknown-peer', deps.clock.now()))
        throw new ApiError(429, 'too many direct sessions from this address; wait a minute', 'rendezvous_busy');
      if (live >= MAX_DIRECT_SESSIONS || unproven >= MAX_DIRECT_UNPROVEN_SESSIONS)
        throw new ApiError(429, 'this daemon is carrying as many direct sessions as it allows', 'rendezvous_busy');
      live += 1;
      unproven += 1;
      let proved = false;
      let released = false;
      const prove = (): void => {
        if (proved || released) return;
        proved = true;
        unproven -= 1;
      };
      const release = (): void => {
        if (released) return;
        if (!proved) unproven -= 1;
        released = true;
        live -= 1;
      };
      let attached = false;
      const deadline = deps.scheduler.after(ATTACH_DEADLINE_MS, () => {
        if (!attached) release();
      });
      const arrival = {
        loopback: request.loopback,
        privilegedLoopback: request.privilegedLoopback === true,
        ...(request.clientAddress === undefined ? {} : { clientAddress: request.clientAddress }),
      };
      return async downstream => {
        attached = true;
        deadline.cancel();
        return new DirectSession(deps, arrival, downstream, release, prove);
      };
    },
  };
}
