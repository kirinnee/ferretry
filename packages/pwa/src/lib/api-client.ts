import type { FyClientOptions, IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonBound } from './daemon-transport.ts';
import type { DaemonFetch } from './runtime-models.ts';
import { type ReadSender, sharingIdenticalReads } from './shared-reads.ts';

/**
 * This is the public PWA build's protocol version, not a daemon identity.
 * Pairing supplies all daemon-specific data at runtime.
 */
export const PWA_PROTOCOL_VERSION = '0.0.0' as const;

/** What the shared typed client is told the token is. Never a credential: see {@link DaemonHttpTransport}. */
const SESSION_CARRIED = 'carried-by-the-device-session';

/**
 * The transport is REQUIRED, and that is the fix for a defect rather than a style.
 *
 * A paired browser can reach its daemon only inside a session its device key opened, so a client built
 * on the plain network reaches nothing at all. Its default used to be exactly that, and every surface
 * that wrote `createClient = daemonApiClient` silently got a client that failed on every carrier. With
 * no default, a caller has to say which path it means — and the composition root's carrier-routed pool
 * (`useDaemonClient` in `store.tsx`) is the only one a surface should ever pick.
 */
export type DaemonApiClientOptions = Omit<FyClientOptions, 'baseUrl' | 'token' | 'version' | 'transport'> & {
  readonly transport: IFyHttpTransport;
};

/**
 * Browser transport for a paired daemon. It refuses a typed-client URL that
 * leaves the paired origin.
 *
 * IT NEVER SEES THE TYPED CLIENT'S `authorization` HEADER — `daemonApiClient`
 * strips it before any transport is called — and that is the whole of device
 * authentication here: there is none to do. The typed client
 * is shared with the command line, which really does send the host's token; a
 * browser holds no bearer value at all, and its requests are carried by a session
 * the device key opened (`relay-carrier.ts`). So the header the shared client
 * insists on writing is a placeholder, and it is removed here rather than sent.
 *
 * An identical read already in flight to this daemon is joined rather than sent
 * again (`shared-reads.ts`): opening the app asks several of the same questions at once.
 */
export class DaemonHttpTransport implements IFyHttpTransport {
  readonly #daemon: DaemonConnection;
  readonly #origin: string;
  readonly #send: ReadSender;

  constructor(daemon: DaemonConnection, fetcher: DaemonFetch) {
    this.#daemon = daemon;
    this.#origin = new URL(daemon.baseUrl).origin;
    // Called through a closure so a caller-supplied function never receives this
    // transport as its receiver.
    this.#send = sharingIdenticalReads((url, init) => fetcher(url, init));
  }

  send(url: string, init: RequestInit): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== this.#origin) throw new Error('API client request must remain on the paired daemon');
    // Bound to THIS daemon, because its address may be another paired machine's too (`daemonBound`).
    return this.#send(target.toString(), daemonBound(this.#daemon, init));
  }
}

/**
 * Whatever transport a client is given, it never sees the placeholder header.
 *
 * Wrapped around the INJECTED transport too, not only the default: a placeholder that reached any
 * transport would be one refactor away from reaching a wire.
 */
const withoutPlaceholder = (transport: IFyHttpTransport): IFyHttpTransport => ({
  send: (url, init) => {
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    return transport.send(url, { ...init, headers });
  },
});

/**
 * Connects the shared typed protocol client to exactly one runtime-paired
 * daemon. There is deliberately no page-origin fallback or module singleton.
 */
export const daemonApiClient = (daemon: DaemonConnection, options: DaemonApiClientOptions): Promise<FyApiClient> =>
  FyApiClient.connect({
    ...options,
    baseUrl: daemon.baseUrl,
    // The shared client requires SOME token; a browser has none, and the transport drops the header.
    token: SESSION_CARRIED,
    version: PWA_PROTOCOL_VERSION,
    transport: withoutPlaceholder(options.transport),
  });
