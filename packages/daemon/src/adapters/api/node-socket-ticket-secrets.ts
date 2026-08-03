import { randomBytes } from 'node:crypto';
import type { SocketTicketSecrets } from '../../lib/api/socket-ticket.ts';

/** 256 bits, the same width as the device token a ticket stands in for. */
const SOCKET_TICKET_BYTES = 32;

/** Ticket material from the platform CSPRNG, visibly typed like every other credential the daemon
 *  mints so a leaked one is recognisable for what it is in a log. */
export class NodeSocketTicketSecrets implements SocketTicketSecrets {
  constructor(private readonly random: (size: number) => Buffer = randomBytes) {}

  ticket(): string {
    return `fy_ticket_${this.random(SOCKET_TICKET_BYTES).toString('base64url')}`;
  }
}
