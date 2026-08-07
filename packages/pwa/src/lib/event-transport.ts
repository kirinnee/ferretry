import { type IFyEventTransport, SocketTicketResponseSchema } from '@ferretry/protocol';
import type { ConnectionMethod } from '@ferretry/relay';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonEventUrl, daemonRequest, daemonUrl } from './daemon-transport.ts';
import type { RelayStreamRequest } from './relay-carrier.ts';
import type { RelayClientSession } from './relay-session.ts';

/**
 * WHICH CARRIER IS LIVE, ASKED RATHER THAN ASSUMED.
 *
 * The two carriers open a stream in completely different ways — a `wss://` socket at the daemon's own
 * address, or a §14 stream session over a rendezvous — so this transport has to know which one it is
 * on. `undefined` means "nothing has decided yet", which is read as direct: the carrier this URL
 * builder has always described, and the one a browser on the daemon's own network gets.
 */
export type ActiveCarrier = () => ConnectionMethod | undefined;

/**
 * Opens one §14 stream session, or answers `null` when this daemon's traffic is not on a rendezvous.
 *
 * The router's own method, injected rather than imported, so this transport stays a thing a suite can
 * drive without a carrier, a socket or a daemon.
 */
export type DaemonStreamOpener = (
  daemon: DaemonConnection,
  request: RelayStreamRequest,
) => Promise<RelayClientSession | null>;

/** Obtains a short-lived, single-use event ticket for one paired daemon. */
export type DaemonEventTicketIssuer = (daemon: DaemonConnection) => Promise<string>;

/**
 * A RELAYED STREAM BUYS NO TICKET, AND THE REFUSAL COMES BEFORE THE PURCHASE.
 *
 * `docs/relay-protocol.md` §14: "Single-use socket tickets exist because a browser cannot attach a
 * header to a WebSocket; here the credential is the record, so there is nothing for a ticket to do.
 * `ticket` or `token` in a stream's `query` is refused with `4400` … A client must also not BUY a
 * ticket it means to spend here — a single-use ticket minted for a surface that refuses it is a
 * credential the daemon burned for nothing, so the refusal happens before the purchase, not after."
 *
 * This module honours that by deciding the carrier FIRST and only then reaching for a ticket. The
 * ordering used to exist for a different reason — the stream was refused outright on a relay — and it
 * is kept for this one.
 */
const relayed = (carrier: ConnectionMethod | undefined): boolean => carrier?.kind === 'relay';

/** The one request in this adapter that CAN carry a header, which is the whole reason it exists: the
 *  device token buys a ticket here so the socket below never has to put a durable credential in a URL.
 *  A refusal is thrown rather than smoothed over — a stream that silently never connects is worse for
 *  a viewer than one that says the daemon would not have it. */
export const daemonEventTicket = async (
  daemon: DaemonConnection,
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  carrier: ActiveCarrier = () => undefined,
): Promise<string> => {
  // Not minted at all on a relay: §14 refuses a ticket in a stream's query, so one bought here would
  // be a live single-use credential the daemon burned for a socket that will never present it.
  if (relayed(carrier())) throw new Error(RELAY_STREAM_NEEDS_NO_TICKET);
  const { url, init } = daemonRequest(daemon, '/v1/events/ticket', { method: 'POST' });
  const response = await send(url, init);
  if (!response.ok) throw new Error(`daemon refused an event ticket: ${response.status}`);
  return SocketTicketResponseSchema.parse(await response.json()).ticket;
};

export const RELAY_STREAM_NEEDS_NO_TICKET =
  'a relayed stream carries the credential its session was opened with, so no event ticket may be minted for one';

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

/**
 * The daemon route this stream is asking for, as the path and query BOTH carriers address it by.
 *
 * ONE VALUE, TWO CARRIERS. A direct viewer turns it into a `wss://` URL with a ticket appended; a
 * relayed viewer puts the same path and query in its `stream` credential record and appends nothing.
 * Deriving them separately is how a ticket ends up in a relayed stream's query, which §14 refuses
 * with `4400` — so the credential-free target is the shared value and each carrier adds its own.
 */
export interface DaemonStreamTarget {
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
}

const eventStreamTarget = (daemon: DaemonConnection, source: string): DaemonStreamTarget => {
  const requested = new URL(source);
  const expected = new URL(daemonUrl(daemon, '/v1/events'));
  expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
  if (requested.origin !== expected.origin || requested.pathname !== expected.pathname)
    throw new Error('event stream must remain on the paired daemon');

  const query: (readonly [string, string])[] = [];
  for (const [name, value] of requested.searchParams) {
    if (name !== 'after' && name !== 'sessionId') throw new Error(`unsupported event stream parameter: ${name}`);
    query.push([name, value]);
  }
  return { path: expected.pathname, query };
};

const directEventUrl = (daemon: DaemonConnection, target: DaemonStreamTarget, ticket: string): string => {
  const url = new URL(daemonEventUrl(daemon, ticket));
  for (const [name, value] of target.query) url.searchParams.set(name, value);
  return url.toString();
};

/**
 * Browser adapter for the protocol client's event stream, on whichever carrier is live.
 *
 * DIRECT: browser WebSockets cannot attach an Authorization header, so every connection obtains a
 * runtime-issued ticket and never places the paired device token in its URL.
 *
 * RELAYED: the stream is its own §14 session, opened by a credential record that carries the device
 * token, the path and the query in one breath. No ticket, no second credential, and no socket at the
 * daemon's own address — which is precisely the address the relay exists because the browser cannot
 * reach, and opening one there would leave a subscribed viewer receiving nothing forever.
 */
export class DaemonEventTransport implements IFyEventTransport {
  constructor(
    private readonly daemon: DaemonConnection,
    private readonly issueTicket: DaemonEventTicketIssuer,
    private readonly socket: DaemonEventSocketFactory = browserSocket,
    private readonly carrier: ActiveCarrier = () => undefined,
    private readonly openStream: DaemonStreamOpener = async () => null,
  ) {}

  async stream(input: {
    url: string;
    token: string;
    signal?: AbortSignal;
    onMessage(value: unknown): void;
  }): Promise<void> {
    const aborted = (): boolean => input.signal?.aborted === true;
    if (aborted()) return;
    const target = eventStreamTarget(this.daemon, input.url);
    if (relayed(this.carrier())) return await this.#relayed(target, input);
    const ticket = await this.issueTicket(this.daemon);
    if (aborted()) return;
    return await this.#direct(directEventUrl(this.daemon, target, ticket), input);
  }

  /**
   * The stream as one §14 session, ended by the same taxonomy a direct socket would carry.
   *
   * A CANCELLED VIEWER SAYS SO ON THE WIRE. §14 makes client cancellation an explicit sealed record
   * "so that the taxonomy survives in both directions and a deliberate leave is never spelled the
   * same as a network failure", so an abort sends `stream-close(1000)` rather than dropping a socket.
   */
  async #relayed(
    target: DaemonStreamTarget,
    input: { signal?: AbortSignal; onMessage(value: unknown): void },
  ): Promise<void> {
    const session = await this.openStream(this.daemon, {
      path: target.path,
      ...(target.query.length === 0 ? {} : { query: target.query }),
      onData: frame => {
        // The event feed is a text stream: §14 gives `text` records "exactly one complete text
        // frame", which is exactly one event. A `bytes` record on this route is the daemon speaking a
        // shape this stream does not have, and parsing it as text would be inventing the message.
        if (frame.kind === 'text') input.onMessage(JSON.parse(frame.text));
      },
    });
    // `null` means the carrier is not a rendezvous after all — it changed under this call — and the
    // honest answer is the failure a caller can retry rather than a promise that never settles.
    if (session === null) throw new Error('this daemon is no longer reachable over a rendezvous');
    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', cancel);
        session.closeStream(1000, 'the viewer left this stream');
        resolve();
      };
      session.onStreamClosed(closed => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', cancel);
        // `1000` is the daemon agreeing the stream is over; anything else is a reason a viewer is
        // owed, and it is the SEALED code that carries it — never the session's own close.
        if (closed.code === 1000) resolve();
        else reject(new Error(`daemon event stream closed: ${closed.code} ${closed.reason}`));
      });
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted === true) cancel();
    });
  }

  #direct(url: string, input: { signal?: AbortSignal; onMessage(value: unknown): void }): Promise<void> {
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
