import { type IFyEventTransport, SocketTicketResponseSchema } from '@ferretry/protocol';
import type { ConnectionMethod } from '@ferretry/relay';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonEventUrl, daemonRequest, daemonUrl } from './daemon-transport.ts';

/**
 * WHICH CARRIER IS LIVE, ASKED RATHER THAN ASSUMED.
 *
 * A stream is the one thing a relayed session CANNOT carry, so this transport has
 * to know. `undefined` means "nothing has decided yet", which is read as direct —
 * the carrier this URL builder has always described.
 */
export type ActiveCarrier = () => ConnectionMethod | undefined;

/**
 * THE EVENT STREAM DOES NOT GO THROUGH A RELAY, AND SAYS SO.
 *
 * `docs/relay-protocol.md` §14 states it outright: the tunnel above the channel
 * carries one request and one answer, and the daemon's PROTOCOL-SWITCHING surfaces
 * — `/v1/events`, terminal streams — are not that shape. Each needs an envelope of
 * its own, and neither end has one yet.
 *
 * So on a relayed carrier this refuses instead of building a `wss://` URL against
 * the daemon's own address. That address is precisely the one the relay exists
 * because the browser cannot reach, so the socket would open on nothing: a live
 * session, a subscribed viewer, and no events, forever. §13 records the gap; this
 * is the code that will not paper over it.
 */
export const RELAY_STREAM_UNSUPPORTED =
  'the live event stream cannot travel over a relay yet: §14 of the relay protocol carries one request and one ' +
  'answer per record, and a stream needs an envelope neither end has built. This daemon is reachable only through ' +
  'a relay right now, so its live updates are unavailable — everything else still works.';

const refuseRelayedStream = (carrier: ConnectionMethod | undefined): void => {
  if (carrier?.kind === 'relay') throw new Error(RELAY_STREAM_UNSUPPORTED);
};

/** Obtains a short-lived, single-use event ticket for one paired daemon. */
export type DaemonEventTicketIssuer = (daemon: DaemonConnection) => Promise<string>;

/** The one request in this adapter that CAN carry a header, which is the whole reason it exists: the
 *  device token buys a ticket here so the socket below never has to put a durable credential in a URL.
 *  A refusal is thrown rather than smoothed over — a stream that silently never connects is worse for
 *  a viewer than one that says the daemon would not have it. */
export const daemonEventTicket = async (
  daemon: DaemonConnection,
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  carrier: ActiveCarrier = () => undefined,
): Promise<string> => {
  // Refused before the ticket is minted, not after. A single-use ticket spent on a
  // socket that cannot open is a ticket the daemon has burned for nothing.
  refuseRelayedStream(carrier());
  const { url, init } = daemonRequest(daemon, '/v1/events/ticket', { method: 'POST' });
  const response = await send(url, init);
  if (!response.ok) throw new Error(`daemon refused an event ticket: ${response.status}`);
  return SocketTicketResponseSchema.parse(await response.json()).ticket;
};

/** The browser WebSocket surface used by the protocol-client adapter. */
export interface DaemonEventSocket {
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  close(): void;
}

/** Constructor seam for browser WebSockets and deterministic unit tests. */
export type DaemonEventSocketFactory = (url: string) => DaemonEventSocket;

const browserSocket: DaemonEventSocketFactory = url => new WebSocket(url) as unknown as DaemonEventSocket;

const eventUrl = (daemon: DaemonConnection, source: string, ticket: string): string => {
  const requested = new URL(source);
  const expected = new URL(daemonUrl(daemon, '/v1/events'));
  expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  if (requested.origin !== expected.origin || requested.pathname !== expected.pathname)
    throw new Error('event stream must remain on the paired daemon');

  const target = new URL(daemonEventUrl(daemon, ticket));
  for (const [name, value] of requested.searchParams) {
    if (name !== 'after' && name !== 'sessionId') throw new Error(`unsupported event stream parameter: ${name}`);
    target.searchParams.set(name, value);
  }
  return target.toString();
};

/**
 * Browser adapter for the protocol client's event stream. Browser WebSockets
 * cannot attach an Authorization header, so every connection obtains a
 * runtime-issued ticket and never places the paired device token in its URL.
 */
export class DaemonEventTransport implements IFyEventTransport {
  constructor(
    private readonly daemon: DaemonConnection,
    private readonly issueTicket: DaemonEventTicketIssuer,
    private readonly socket: DaemonEventSocketFactory = browserSocket,
    private readonly carrier: ActiveCarrier = () => undefined,
  ) {}

  async stream(input: {
    url: string;
    token: string;
    signal?: AbortSignal;
    onMessage(value: unknown): void;
  }): Promise<void> {
    const aborted = (): boolean => input.signal?.aborted === true;
    if (aborted()) return;
    // Thrown rather than resolved. A stream that returns quietly is indistinguishable
    // from one that ended, and a viewer would sit on a screen that never updates and
    // never explains itself.
    refuseRelayedStream(this.carrier());
    const ticket = await this.issueTicket(this.daemon);
    if (aborted()) return;
    const url = eventUrl(this.daemon, input.url, ticket);

    return new Promise((resolve, reject) => {
      let settled = false;
      const connection = this.socket(url);
      const cleanup = (): void => {
        input.signal?.removeEventListener('abort', cancel);
        connection.onmessage = null;
        connection.onclose = null;
        connection.onerror = null;
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        connection.close();
        reject(error instanceof Error ? error : new Error('daemon event stream failed'));
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        connection.close();
        resolve();
      };

      connection.onmessage = event => {
        try {
          input.onMessage(JSON.parse(String(event.data)));
        } catch (error) {
          fail(error);
        }
      };
      connection.onclose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('daemon event stream closed unexpectedly'));
      };
      connection.onerror = () => fail(new Error('daemon event stream failed'));
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted === true) cancel();
    });
  }
}
