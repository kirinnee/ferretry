import type { IFyEventTransport } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonEventUrl, daemonUrl } from './daemon-transport.ts';

/** Obtains a short-lived, single-use event ticket for one paired daemon. */
export type DaemonEventTicketIssuer = (daemon: DaemonConnection) => Promise<string>;

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
  ) {}

  async stream(input: { url: string; token: string; onMessage(value: unknown): void }): Promise<void> {
    const ticket = await this.issueTicket(this.daemon);
    const url = eventUrl(this.daemon, input.url, ticket);

    return new Promise((resolve, reject) => {
      let settled = false;
      const connection = this.socket(url);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        connection.close();
        reject(error instanceof Error ? error : new Error('daemon event stream failed'));
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
        resolve();
      };
      connection.onerror = () => fail(new Error('daemon event stream failed'));
    });
  }
}
