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
 * - **per peer:** {@link DIRECT_UPGRADES_PER_PEER} ADMITTED upgrades a minute from one address, so
 *   one host on the network cannot loop handshakes — and a refused upgrade spends none of it, so an
 *   honest peer retrying during an attack does not lock itself out; and at most
 *   {@link MAX_DIRECT_UNPROVEN_PER_PEER} unproven sockets per remote address;
 * - **unproven:** at most {@link MAX_DIRECT_UNPROVEN_SESSIONS} sockets that have not proved a device.
 *   When they are all taken the OLDEST is evicted rather than the newcomer refused, so squatting needs
 *   to out-race honest arrivals, which prove themselves in milliseconds;
 * - **total:** {@link MAX_DIRECT_SESSIONS}, which also evicts the oldest unproven socket when it can.
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
  EVICTED_REASON,
  MAX_DIRECT_SESSIONS,
  MAX_DIRECT_UNPROVEN_PER_PEER,
  MAX_DIRECT_UNPROVEN_SESSIONS,
} from '../../relay/direct-carrier.ts';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';

/** How long an admitted upgrade may take to attach before its slot is handed back. */
const ATTACH_DEADLINE_MS = 10_000;
/** Peers remembered at once; past this, windows that have ended are forgotten first. */
const MAX_REMEMBERED_PEERS = 4_096;

interface PeerWindow {
  startedAtMs: number;
  upgrades: number;
}

/** One admitted upgrade, from admission until its socket closes. */
interface Reservation {
  readonly peer: string;
  /** Counted against the per-peer unproven bound: a remote address's socket, not yet proved. */
  readonly bounded: boolean;
  proved: boolean;
  released: boolean;
  /** Evicted before its socket attached: the attach answers with a close and nothing else. */
  evicted: boolean;
  session: DirectSession | undefined;
}

/** The socket route a browser dials for a direct session. */
export function directCarrierSocketRoute(deps: DirectCarrierDependencies): SocketRoute {
  let live = 0;
  /** Unproven reservations, oldest first: the order eviction takes them in. */
  const unproven: Reservation[] = [];
  const unprovenByPeer = new Map<string, number>();
  const peers = new Map<string, PeerWindow>();

  /** Whether this peer may make one more upgrade in its window. Asking spends nothing. */
  const peerMayUpgrade = (peer: string, now: number): boolean => {
    const window = peers.get(peer);
    return (
      window === undefined ||
      now - window.startedAtMs >= DIRECT_UPGRADE_WINDOW_MS ||
      window.upgrades < DIRECT_UPGRADES_PER_PEER
    );
  };

  /** Spends one of this peer's upgrades. Called only for an upgrade that was admitted. */
  const spendPeer = (peer: string, now: number): void => {
    const window = peers.get(peer);
    if (window !== undefined && now - window.startedAtMs < DIRECT_UPGRADE_WINDOW_MS) {
      window.upgrades += 1;
      return;
    }
    if (peers.size >= MAX_REMEMBERED_PEERS)
      for (const [key, value] of peers) if (now - value.startedAtMs >= DIRECT_UPGRADE_WINDOW_MS) peers.delete(key);
    peers.set(peer, { startedAtMs: now, upgrades: 1 });
  };

  /** No longer unproven: proved, released or evicted. Idempotent. */
  const leaveUnproven = (reservation: Reservation): void => {
    const index = unproven.indexOf(reservation);
    if (index < 0) return;
    unproven.splice(index, 1);
    if (!reservation.bounded) return;
    const held = (unprovenByPeer.get(reservation.peer) ?? 1) - 1;
    if (held > 0) unprovenByPeer.set(reservation.peer, held);
    else unprovenByPeer.delete(reservation.peer);
  };

  const release = (reservation: Reservation): void => {
    if (reservation.released) return;
    reservation.released = true;
    leaveUnproven(reservation);
    live -= 1;
  };

  /** Makes room by ending the oldest socket that has not proved a device. */
  const evictOldest = (): void => {
    const oldest = unproven[0];
    if (oldest === undefined) return;
    if (oldest.session !== undefined) {
      oldest.session.evict();
      return;
    }
    oldest.evicted = true;
    release(oldest);
  };

  return {
    method: 'GET',
    path: '/v1/rendezvous/:daemonId/client',
    // PUBLIC, because the credential is not on the upgrade: it is the device's proof inside the
    // session that this socket carries. An upgrade with no credential is exactly what a rendezvous
    // accepts too, and for the same reason.
    minimum: 'none',
    caller: 'any',
    accept: async ({ request, params }) => {
      // A session cannot open a session. The tunnel dispatches a stream's path through this same
      // socket table, and a nested direct session would be a carrier inside a carrier with nobody's
      // locality to stamp on it.
      if (request.device !== undefined) throw new ApiError(404, 'no stream is served at this path', 'not_found');
      if (params.get('daemonId') !== deps.identity.daemonId)
        throw new ApiError(404, 'this daemon does not answer for that fingerprint', 'not_found');
      // A peer with no address is keyed as one — never waved through as nobody.
      const peer = request.clientAddress ?? 'unknown-peer';
      // Every tab on the host shares one loopback address, so the per-address bound would refuse the
      // host's own burst of reconnecting tabs. The host is still under the global bounds. Exempt only on a
      // HOST-PROVEN carrier (a loopback-only bind): on a wildcard bind a proxy (`tailscale serve`,
      // `cloudflared`, `ssh -L`) forwards every remote caller from 127.0.0.1, and one of them could
      // otherwise hold every unproven slot. A proxy in front of a loopback-only bind still shares the
      // exemption; that deployment is declared DoS-exposed in zero-trust.md A3.
      const bounded = request.privilegedLoopback !== true;
      const now = deps.clock.now();
      if (bounded && (unprovenByPeer.get(peer) ?? 0) >= MAX_DIRECT_UNPROVEN_PER_PEER)
        throw new ApiError(429, 'this address already has sessions waiting to prove a device', 'rendezvous_busy');
      if (live >= MAX_DIRECT_SESSIONS && unproven.length === 0)
        throw new ApiError(429, 'this daemon is carrying as many direct sessions as it allows', 'rendezvous_busy');
      if (!peerMayUpgrade(peer, now))
        throw new ApiError(429, 'too many direct sessions from this address; wait a minute', 'rendezvous_busy');
      // Admitted. Only now is the peer's budget spent and room made.
      spendPeer(peer, now);
      if (live >= MAX_DIRECT_SESSIONS || unproven.length >= MAX_DIRECT_UNPROVEN_SESSIONS) evictOldest();
      const reservation: Reservation = {
        peer,
        bounded,
        proved: false,
        released: false,
        evicted: false,
        session: undefined,
      };
      live += 1;
      unproven.push(reservation);
      if (bounded) unprovenByPeer.set(peer, (unprovenByPeer.get(peer) ?? 0) + 1);
      const prove = (): void => {
        if (reservation.proved || reservation.released) return;
        reservation.proved = true;
        leaveUnproven(reservation);
      };
      let attached = false;
      const deadline = deps.scheduler.after(ATTACH_DEADLINE_MS, () => {
        if (!attached) release(reservation);
      });
      const arrival = {
        loopback: request.loopback,
        privilegedLoopback: request.privilegedLoopback === true,
        ...(request.clientAddress === undefined ? {} : { clientAddress: request.clientAddress }),
        ...(request.carrier === undefined ? {} : { carrier: request.carrier }),
      };
      return async downstream => {
        attached = true;
        deadline.cancel();
        if (reservation.evicted || reservation.released) {
          // Its slot went to somebody else while the upgrade completed: close the socket and hold nothing.
          return {
            open: async () => downstream.close(RELAY_CLOSE_CODES.rendezvousBusy, EVICTED_REASON),
            fromClient: () => undefined,
            close: () => undefined,
          };
        }
        const session = new DirectSession(deps, arrival, downstream, () => release(reservation), prove);
        reservation.session = session;
        return session;
      };
    },
  };
}
