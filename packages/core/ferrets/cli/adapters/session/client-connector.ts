import type { DaemonRestartPatience, IFyApiClient, IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { type ConnectionInput, resolveConnection } from '../../lib/session/connection.ts';
import type { FyClientConnector } from './fy-session-api.ts';

/** The credential this machine supplies when `FY_TOKEN` is absent, and the wire it must travel on. */
interface LocalCredential {
  readonly token: string;
  /** Where the credential was decided for. A session bearer is only ever sent to the daemon that took it. */
  readonly baseUrl?: string;
  /** Present for a ferret's session bearer: the transport that owns its one narrow fallback. */
  readonly transport?: IFyHttpTransport;
}

export interface ConnectorOptions extends ConnectionInput {
  /** The CLI version, sent so the daemon can detect a version skew. */
  readonly version: string;
  /** Resolves the local daemon credential only when the caller did not explicitly set one. */
  readonly resolveLocalCredential?: () => Promise<LocalCredential>;
  /** How the client waits out a daemon restart; absent, it fails as soon as the daemon is away. */
  readonly restartPatience?: DaemonRestartPatience;
}

/**
 * Builds the lazy connector the session API uses.
 *
 * Nothing is validated or connected until a command actually needs the daemon, so `--help` and
 * `--version` work on a host that has never run one.
 */
export function createFyClientConnector(options: ConnectorOptions): FyClientConnector {
  return async (): Promise<IFyApiClient> => {
    const configuredToken = options.token?.trim() ?? '';
    const local =
      configuredToken === '' && options.resolveLocalCredential !== undefined
        ? await options.resolveLocalCredential()
        : undefined;
    const connection = resolveConnection({
      ...options,
      token: local?.token ?? options.token,
      ...(local?.baseUrl === undefined ? {} : { url: local.baseUrl }),
    });
    return await FyApiClient.connect({
      baseUrl: connection.baseUrl,
      token: connection.token,
      version: options.version,
      headers: { ...connection.headers },
      ...(local?.transport === undefined ? {} : { transport: local.transport }),
      ...(options.restartPatience === undefined ? {} : { restartPatience: options.restartPatience }),
    });
  };
}
