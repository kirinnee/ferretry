import { SOCKET_TICKET_TTL_SECONDS, SocketTicketResponseSchema } from '@ferretry/protocol';
import { type ApiRoute, errorResponse, jsonResponse } from '../../api/index.ts';
import type { SocketTicketBroker } from '../../api/socket-ticket.ts';

/**
 * Buying a socket ticket with a real credential.
 *
 * WHY THIS IS A ROUTE AT ALL. A browser cannot attach a header to a `WebSocket`, and a durable token
 * in a query string is honoured only for loopback peers because a URL reaches every access log on the
 * path. So the remote app's live event stream had no way to authenticate: the one thing a paired
 * device most needs is the one thing it could not do. This route is the exchange — header-carrying
 * request in, URL-safe single-use ticket out.
 *
 * WHY IT IS `admin` SCOPE. Exactly the scope of the socket routes a ticket can be spent on. A ticket
 * replays its buyer's own classification, so it can never widen what that caller may reach; the scope
 * here only decides who may ask, and it must not be looser than the sockets themselves. A socket route
 * mounted at `warden` scope in future must revisit this line — not this comment.
 */

export type SocketTicketSubsystem = Pick<SocketTicketBroker, 'issue'>;

export function socketTicketRoutes(subsystem: SocketTicketSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/events/ticket',
      minimum: 'operator',
      noStore: true,
      handle: async ({ credential }) => {
        // A non-public route always has one, so this is unreachable by construction — and it refuses
        // rather than inventing an authority, because the alternative to knowing WHICH credential
        // asked is minting one that answers to nobody.
        if (credential === undefined) return errorResponse(401, 'unauthorized', 'unauthorized');
        const grant = subsystem.issue(credential, '/v1/events');
        return jsonResponse(
          SocketTicketResponseSchema.parse({
            ticket: grant.ticket,
            ttlSeconds: SOCKET_TICKET_TTL_SECONDS,
            expiresAt: new Date(grant.expiresAtMs).toISOString(),
          }),
          201,
        );
      },
    },
  ];
}
