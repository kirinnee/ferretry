import type { IFyApiClient } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';

/**
 * Where the daemon lives, from the environment the agent was launched with. Only `FY_*` is read —
 * there is no legacy fallback and no state-home probe, because the CLI must not know the daemon's
 * on-disk layout (migration plan §4).
 */
export function createFyClient(
  environment: Record<string, string | undefined>,
  version: string,
): Promise<IFyApiClient> {
  const baseUrl = environment['FY_URL']?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error('set FY_URL to the daemon base URL, for example FY_URL=http://127.0.0.1:8420');
  }
  const token = environment['FY_TOKEN']?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error('set FY_TOKEN to the daemon API token');
  }
  return FyApiClient.connect({ baseUrl, token, version });
}

/** The session a command writes to when `--session` is absent. */
export function environmentSessionId(environment: Record<string, string | undefined>): string | undefined {
  const value = environment['FY_SESSION_ID']?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
