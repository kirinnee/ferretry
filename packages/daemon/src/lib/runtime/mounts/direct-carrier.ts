/**
 * THE DIRECT CARRIER'S ONE ROUTE: where a browser that can reach this daemon opens a session.
 *
 * The session itself is `lib/relay/direct-carrier.ts` — the same `RelayLink` a rendezvous socket
 * runs, over one socket to this listener. This file is only where the route is DECLARED, beside every
 * other route this daemon serves, so the route-agreement gate counts it like any other.
 */

import { ApiError } from '../../api/error.ts';
import type { SocketRoute } from '../../api/socket.ts';
import { type DirectCarrierDependencies, DirectSession, MAX_DIRECT_SESSIONS } from '../../relay/direct-carrier.ts';

/** The socket route a browser dials for a direct session. */
export function directCarrierSocketRoute(deps: DirectCarrierDependencies): SocketRoute {
  let live = 0;
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
      if (live >= MAX_DIRECT_SESSIONS)
        throw new ApiError(429, 'this daemon is carrying as many direct sessions as it allows', 'rendezvous_busy');
      const arrival = {
        loopback: request.loopback,
        privilegedLoopback: request.privilegedLoopback === true,
        ...(request.clientAddress === undefined ? {} : { clientAddress: request.clientAddress }),
      };
      return async downstream => {
        live += 1;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          live -= 1;
        };
        return new DirectSession(deps, arrival, downstream, release);
      };
    },
  };
}
