import { type DaemonUpdateView, DaemonUpdateViewSchema } from '@ferretry/protocol';
import type { IDaemonUpdateViewPort } from '../../lib/update/ports.ts';

/** The daemon route that owns the release check and the mid-turn count. */
export const DAEMON_UPDATE_PATH = '/v1/daemon/update';

/** The one client capability this read needs. */
export interface DaemonUpdateApiClient {
  request<T>(path: string, schema: import('zod').ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T>;
}

/**
 * The daemon's update view, over the authenticated client.
 *
 * `undefined` for every failure: a daemon that is down, one too old to serve the route, one that
 * refuses this credential. `status` then simply says nothing about updates, and `update` and
 * `restart` count no ferret as mid-turn — which is right for a daemon that is not running. The count
 * only ever chooses a sentence or a `--when-idle` wait: no update or restart is refused for it.
 */
export class ProtocolDaemonUpdateView implements IDaemonUpdateViewPort {
  constructor(
    private readonly client: DaemonUpdateApiClient,
    private readonly timeoutMs = 3_000,
  ) {}

  async view(): Promise<DaemonUpdateView | undefined> {
    try {
      return await this.client.request(DAEMON_UPDATE_PATH, DaemonUpdateViewSchema, undefined, this.timeoutMs);
    } catch {
      return undefined;
    }
  }
}
