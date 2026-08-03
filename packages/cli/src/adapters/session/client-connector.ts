import type { IFyApiClient } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { type ConnectionInput, resolveConnection } from '../../lib/session/connection.ts';
import type { FyClientConnector } from './fy-session-api.ts';

export interface ConnectorOptions extends ConnectionInput {
  /** The CLI version, sent so the daemon can detect a version skew. */
  readonly version: string;
  /** Resolves the local daemon credential only when the caller did not explicitly set one. */
  readonly resolveLocalToken?: () => Promise<string>;
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
    const token =
      configuredToken === '' && options.resolveLocalToken !== undefined
        ? await options.resolveLocalToken()
        : options.token;
    const connection = resolveConnection({ ...options, token });
    return await FyApiClient.connect({
      baseUrl: connection.baseUrl,
      token: connection.token,
      version: options.version,
      headers: { ...connection.headers },
    });
  };
}
