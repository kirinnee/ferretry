/**
 * `POST /v1/restarts`: restart the ferrets that run on out-of-date instructions. The daemon restarts the idle
 * ones, queues the busy ones for their next idle moment, and never forces past the in-flight inventory.
 *
 * The answer is PARSED through the shared schema, so a body this page cannot read is a failed read rather than
 * a claim about what restarted. The request id is minted per click and is what makes a retried POST safe.
 */
import {
  FY_REQUEST_ID_HEADER,
  type RestartRequest,
  RestartRequestSchema,
  type RestartResult,
  RestartResultSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from '../../lib/runtime-models.ts';

export const restartFerrets = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch,
  request: RestartRequest,
  requestId: string = crypto.randomUUID(),
): Promise<RestartResult> => {
  const target = daemonRequest(daemon, '/v1/restarts', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: requestId },
    body: JSON.stringify(RestartRequestSchema.parse(request)),
  });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new DaemonResponseError(response.status, message, typeof body.code === 'string' ? body.code : undefined);
  }
  const parsed = RestartResultSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered with a body this page cannot read');
  return parsed.data;
};
