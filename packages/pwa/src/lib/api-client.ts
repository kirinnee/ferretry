import type { FyClientOptions, IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnection } from './daemon-connection.ts';

/**
 * This is the public PWA build's protocol version, not a daemon identity.
 * Pairing supplies all daemon-specific data at runtime.
 */
export const PWA_PROTOCOL_VERSION = '0.0.0' as const;

export type DaemonApiClientOptions = Omit<FyClientOptions, 'baseUrl' | 'token' | 'version' | 'transport'> & {
  readonly transport?: IFyHttpTransport;
};

type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Keep the browser builtin in its WebIDL realm. `fetch` rejects calls whose
 * receiver is not the Window/global object, so storing an unbound builtin on a
 * transport and invoking it later would make a healthy paired daemon look down.
 */
const browserFetch: DaemonFetch = (input, init) => globalThis.fetch(input, init);

/**
 * Browser transport for a paired daemon. It refuses a typed-client URL that
 * leaves the paired origin and always includes credentials for daemon-side
 * access adapters. Authentication itself remains owned by FyApiClient.
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
    return fetcher(target.toString(), { ...init, credentials: 'include' });
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
    token: daemon.deviceToken,
    version: PWA_PROTOCOL_VERSION,
    transport: options.transport ?? new DaemonHttpTransport(daemon),
  });
