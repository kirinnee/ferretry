import { type HealthView, HealthViewSchema } from '@ferretry/protocol';
import type { IDaemonHealthPort } from '../../lib/daemon/ports.ts';

/** The one client capability the health probe consumes. */
export type HealthApiClient = {
  request<T>(path: string, schema: import('zod').ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T>;
};

/** The daemon's health route. */
export const HEALTH_PATH = '/v1/health';

/**
 * Asks the daemon about itself over the protocol client.
 *
 * An unreachable daemon resolves to `undefined` rather than throwing: every caller treats "did not
 * answer" as a fact to report, not an error to propagate. The response is parsed against the protocol
 * schema, so a daemon answering with an error envelope is a miss rather than a plausible-looking
 * object that breaks three frames later.
 */
export class ProtocolDaemonHealth implements IDaemonHealthPort {
  constructor(
    private readonly client: HealthApiClient,
    private readonly timeoutMs = 2_000,
  ) {}

  async probe(): Promise<HealthView | undefined> {
    try {
      return await this.client.request(HEALTH_PATH, HealthViewSchema, undefined, this.timeoutMs);
    } catch {
      return undefined;
    }
  }
}
