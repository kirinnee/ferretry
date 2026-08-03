/**
 * Short-lived, single-use credentials for a protocol switch.
 *
 * WHY THIS EXISTS. A browser cannot put a header on a `WebSocket`, so the only credential a paired
 * phone could present on an upgrade is one carried in the URL — and a token in a query string is
 * honoured for loopback peers only, deliberately, because a URL is copied into every access log on
 * the path. The result was a device that could make authenticated requests and could not open the
 * live event stream at all: the feed the remote app exists to show.
 *
 * A ticket closes that without weakening the rule that produced it. It is bought with the real
 * credential over a header-carrying request, it names no authority of its own — it replays exactly
 * the classification the bearer produced — it is spent on first use, it expires in seconds, and it is
 * redeemable ONLY on an upgrade: the request/response boundary is never handed a redeemer, so a
 * ticket recovered from a log cannot be replayed against an ordinary route even inside its window.
 *
 * What it is NOT is a way to hold authority longer or more widely than the credential behind it. A
 * device's ticket authorizes what a device may do; revoking the grant behind it leaves at most one
 * ticket-length window, which is why that window is seconds.
 */

import { SOCKET_TICKET_TTL_SECONDS } from '@ferretry/protocol';
import { type Authentication, secretsMatch } from './authentication.ts';

/** Query parameter carrying a ticket on an upgrade. Distinct from `token`, which stays loopback-only,
 *  so the two can never be confused for one another by a client or by a reader of this code. */
export const SOCKET_TICKET_QUERY_PARAMETER = 'ticket';

export const SOCKET_TICKET_TTL_MS = SOCKET_TICKET_TTL_SECONDS * 1_000;

/**
 * How many unredeemed tickets one daemon keeps.
 *
 * Every issue is authenticated, so this bounds a mistake rather than an attack — a client that
 * reconnects in a loop, or a viewer that asks for a ticket and never uses it. The oldest goes first,
 * and the same ceiling bounds the comparison below.
 */
export const SOCKET_TICKET_MAX_OUTSTANDING = 64;

/** What a ticket replays: exactly the classification the bearer that bought it produced. */
export type AuthenticatedCredential = Extract<Authentication, { readonly kind: 'authenticated' }>;

export interface SocketTicketClock {
  now(): number;
}

/** Ticket material. A port because randomness belongs to an adapter, and because a test needs to
 *  know which ticket was minted without reading it back out of the registry. */
export interface SocketTicketSecrets {
  ticket(): string;
}

export interface SocketTicketGrant {
  readonly ticket: string;
  readonly expiresAtMs: number;
}

/** Turning a ticket back into the credential that bought it. The upgrade boundary holds one of these;
 *  the request/response boundary deliberately does not. */
export interface SocketTicketRedeemer {
  redeem(ticket: string): AuthenticatedCredential | undefined;
}

export interface SocketTicketBroker extends SocketTicketRedeemer {
  issue(credential: AuthenticatedCredential): SocketTicketGrant;
}

interface OutstandingTicket {
  readonly credential: AuthenticatedCredential;
  readonly expiresAtMs: number;
}

/** The live outstanding tickets of one daemon. Held in memory and never persisted: a ticket outliving
 *  a restart would be a credential surviving the state that justified it, and a lost one costs a
 *  client one round trip. Memory-only is also what keeps a ticket unusable at another daemon. */
export class SocketTicketRegistry implements SocketTicketBroker {
  private readonly outstanding = new Map<string, OutstandingTicket>();

  constructor(
    private readonly clock: SocketTicketClock,
    private readonly secrets: SocketTicketSecrets,
    private readonly ttlMs: number = SOCKET_TICKET_TTL_MS,
    private readonly limit: number = SOCKET_TICKET_MAX_OUTSTANDING,
    private readonly compare: (left: string, right: string) => boolean = secretsMatch,
  ) {}

  issue(credential: AuthenticatedCredential): SocketTicketGrant {
    const now = this.clock.now();
    this.forget(now);
    const ticket = this.secrets.ticket();
    // A generator that yields nothing must never become a ticket that something matches. This is the
    // blank-secret rule at the other end of the same exchange: no credential, no authentication.
    if (ticket.trim() === '') throw new Error('the socket ticket generator produced no ticket');
    const expiresAtMs = now + this.ttlMs;
    this.outstanding.set(ticket, { credential, expiresAtMs });
    return { ticket, expiresAtMs };
  }

  redeem(ticket: string): AuthenticatedCredential | undefined {
    // Nothing is not a credential: `?ticket=` arrives as ''.
    if (ticket.trim() === '') return undefined;
    const now = this.clock.now();
    // Every outstanding ticket is compared, all the way, through the daemon's one comparator. Neither
    // which ticket matched nor whether any did changes the work done.
    let matched: readonly [string, OutstandingTicket] | undefined;
    for (const entry of this.outstanding) if (this.compare(ticket, entry[0])) matched = entry;
    if (matched === undefined) return undefined;
    // Spent whether or not it proves to still be valid, so an expiring ticket cannot be probed twice.
    this.outstanding.delete(matched[0]);
    return now >= matched[1].expiresAtMs ? undefined : matched[1].credential;
  }

  /** Drops what has expired, then makes room for one more. */
  private forget(now: number): void {
    for (const [ticket, outstanding] of this.outstanding)
      if (now >= outstanding.expiresAtMs) this.outstanding.delete(ticket);
    // Deleting during iteration is defined: an entry already passed is not revisited, so this cannot
    // spin, and it needs no unreachable guard to prove that.
    for (const oldest of this.outstanding.keys()) {
      if (this.outstanding.size < this.limit) break;
      this.outstanding.delete(oldest);
    }
  }
}
