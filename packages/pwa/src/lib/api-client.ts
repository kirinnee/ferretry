import type { FyClientOptions, IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnection } from './daemon-connection.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';

/**
 * This is the public PWA build's protocol version, not a daemon identity.
 * Pairing supplies all daemon-specific data at runtime.
 */
export const PWA_PROTOCOL_VERSION = '0.0.0' as const;

/** What the shared typed client is told the token is. Never a credential: see {@link DaemonHttpTransport}. */
const SESSION_CARRIED = 'carried-by-the-device-session';

export type DaemonApiClientOptions = Omit<FyClientOptions, 'baseUrl' | 'token' | 'version' | 'transport'> & {
  readonly transport?: IFyHttpTransport;
};

/**
 * Browser transport for a paired daemon. It refuses a typed-client URL that
 * leaves the paired origin.
 *
 * IT DROPS THE TYPED CLIENT'S `authorization` HEADER, and that is the whole of
 * device authentication in this transport: there is none to do. The typed client
 * is shared with the command line, which really does send the host's token; a
 * browser holds no bearer value at all, and its requests are carried by a session
 * the device key opened (`relay-carrier.ts`). So the header the shared client
 * insists on writing is a placeholder, and it is removed here rather than sent.
 */
export class DaemonHttpTransport implements IFyHttpTransport {
  readonly #origin: string;
  readonly #fetch: DaemonFetch;

  constructor(daemon: DaemonConnection, fetcher: DaemonFetch = browserFetch) {
    this.#origin = new URL(daemon.baseUrl).origin;
    this.#fetch = fetcher;
  }

  send(url: string, init: RequestInit): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== this.#origin) throw new Error('API client request must remain on the paired daemon');
    // Call through a local so a caller-supplied function never receives this
    // transport as its receiver. The default above also keeps Window.fetch
    // bound to its own realm.
    const fetcher = this.#fetch;
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    return fetcher(target.toString(), { ...init, headers, credentials: 'include' });
  }
}

/**
 * Connects the shared typed protocol client to exactly one runtime-paired
 * daemon. There is deliberately no page-origin fallback or module singleton.
 */
export const daemonApiClient = (daemon: DaemonConnection, options: DaemonApiClientOptions = {}): Promise<FyApiClient> =>
  FyApiClient.connect({
    ...options,
    baseUrl: daemon.baseUrl,
    // The shared client requires SOME token; a browser has none, and the transport drops the header.
    token: SESSION_CARRIED,
    version: PWA_PROTOCOL_VERSION,
    transport: options.transport ?? new DaemonHttpTransport(daemon),
  });
