import type { IFyApiClient } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { type ConnectionInput, resolveConnection } from '../../lib/session/connection.ts';
import type { FyClientConnector } from './fy-session-api.ts';

export interface ConnectorOptions extends ConnectionInput {
  /** The CLI version, sent so the daemon can detect a version skew. */
  readonly version: string;
}

/**
 * Builds the lazy connector the session API uses.
 *
 * Nothing is validated or connected until a command actually needs the daemon, so `--help` and
 * `--version` work on a host that has never run one.
 */
export function createFyClientConnector(options: ConnectorOptions): FyClientConnector {
  return async (): Promise<IFyApiClient> => {
    const connection = resolveConnection(options);
    return await FyApiClient.connect({
      baseUrl: connection.baseUrl,
      token: connection.token,
      version: options.version,
      headers: { ...connection.headers },
    });
  };
}
