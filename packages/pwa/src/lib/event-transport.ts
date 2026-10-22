import type { IFyEventTransport } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonUrl } from './daemon-transport.ts';
import type { RelayStreamRequest } from './relay-carrier.ts';
import type { RelayClientSession } from './relay-session.ts';

/**
 * Opens one §14 stream session on whichever carrier reaches the daemon.
 *
 * The router's own method, injected rather than imported, so this transport stays a thing a suite can
 * drive without a carrier, a socket or a daemon.
 */
export type DaemonStreamOpener = (daemon: DaemonConnection, request: RelayStreamRequest) => Promise<RelayClientSession>;

/**
 * The daemon route this stream is asking for, as the path and query a stream session names.
 *
 * NO TICKET AND NO TOKEN. A stream is its own session, opened by a credential record the device key
 * signed, so there is nothing for a URL to carry — and §14 refuses `ticket` or `token` in a stream's
 * query with `4400` anyway. A paired device has no ticket to buy any more (the daemon refuses to sell
 * one), which is why there is no longer a "direct WebSocket" branch here at all.
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
    if (name !== 'after' && name !== 'sessionId' && name !== 'live' && name !== 'topic' && name !== 'tail')
      throw new Error(`unsupported event stream parameter: ${name}`);
    query.push([name, value]);
  }
  return { path: expected.pathname, query };
};

/**
 * Browser adapter for the protocol client's event stream: one §14 stream session per subscription.
 *
 * The session is opened on whichever carrier reaches the daemon — its own address first, then each
 * rendezvous — by a credential record that carries the device's proof, the path and the query in one
 * breath. That is the same on both carriers, which is the point: the LAN is no longer the one place a
 * live feed travels in the clear.
 */
export class DaemonEventTransport implements IFyEventTransport {
  constructor(
    private readonly daemon: DaemonConnection,
    private readonly openStream: DaemonStreamOpener,
  ) {}

  /**
   * The stream as one §14 session, ended by the same taxonomy a direct socket would carry.
   *
   * A CANCELLED VIEWER SAYS SO ON THE WIRE. §14 makes client cancellation an explicit sealed record
   * "so that the taxonomy survives in both directions and a deliberate leave is never spelled the
   * same as a network failure", so an abort sends `stream-close(1000)` rather than dropping a socket.
   */
  async stream(input: {
    url: string;
    token: string;
    signal?: AbortSignal;
    onMessage(value: unknown): void;
  }): Promise<void> {
    if (input.signal?.aborted === true) return;
    const target = eventStreamTarget(this.daemon, input.url);
    // A frame can arrive before the session promise below exists, so a damaged one is remembered here
    // and the stream is refused the moment there is somebody to refuse it to.
    let damaged: Error | undefined;
    let refuse: ((reason: Error) => void) | undefined;
    const session = await this.openStream(this.daemon, {
      path: target.path,
      ...(target.query.length === 0 ? {} : { query: target.query }),
      onData: frame => {
        // The event feed is a text stream: §14 gives `text` records "exactly one complete text
        // frame", which is exactly one event. A `bytes` record on this route is the daemon speaking a
        // shape this stream does not have, and parsing it as text would be inventing the message.
        if (frame.kind !== 'text' || damaged !== undefined) return;
        let value: unknown;
        try {
          value = JSON.parse(frame.text);
        } catch {
          damaged = new Error('daemon event stream sent a frame that is not JSON');
          refuse?.(damaged);
          return;
        }
        input.onMessage(value);
      },
    });
    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        input.signal?.removeEventListener('abort', cancel);
        return true;
      };
      const cancel = (): void => {
        if (!finish()) return;
        session.closeStream(1000, 'the viewer left this stream');
        resolve();
      };
      refuse = reason => {
        if (!finish()) return;
        session.closeStream(1003, 'the viewer could not read this stream');
        reject(reason);
      };
      session.onStreamClosed(closed => {
        if (!finish()) return;
        // `1000` is the daemon agreeing the stream is over; anything else is a reason a viewer is
        // owed, and it is the SEALED code that carries it — never the session's own close.
        if (closed.code === 1000) resolve();
        else reject(new Error(`daemon event stream closed: ${closed.code} ${closed.reason}`));
      });
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (damaged !== undefined) refuse(damaged);
      else if (input.signal?.aborted === true) cancel();
    });
  }
}
