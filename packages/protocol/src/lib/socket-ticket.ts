import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * How long a socket ticket is worth anything.
 *
 * A ticket travels in a URL, where every proxy and access log on the path keeps a copy of it, so it
 * is built to be worthless by the time anyone reads one back: single use, and seconds rather than the
 * lifetime of the credential that bought it. A browser cannot put a header on a `WebSocket`, which is
 * the entire reason a URL-borne credential exists at all.
 */
export const SOCKET_TICKET_TTL_SECONDS = 30 as const;

/** Visibly typed like every other credential here, carrying 256 random bits as base64url. */
export const SocketTicketSchema = z.string().regex(/^fy_ticket_[A-Za-z0-9_-]{43}$/u, 'invalid socket ticket');
export type SocketTicket = z.infer<typeof SocketTicketSchema>;

/** Issuing is bodyless: a ticket carries the authority of the request that asked for it and nothing
 *  a caller could name. */
export const SocketTicketRequestSchema = z.strictObject({});
export type SocketTicketRequest = z.infer<typeof SocketTicketRequestSchema>;

export const SocketTicketResponseSchema = z.strictObject({
  ticket: SocketTicketSchema,
  ttlSeconds: z.literal(SOCKET_TICKET_TTL_SECONDS),
  expiresAt: InstantSchema,
});
export type SocketTicketResponse = z.infer<typeof SocketTicketResponseSchema>;
