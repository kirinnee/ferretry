/**
 * Daemon-bound transport for the fleet analytics page.
 *
 * Analytics data is never read from the page origin or a module singleton: the
 * paired connection is an explicit input to every request.
 */
import { AnalyticsResponseSchema, type AnalyticsResponse } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { DaemonResponseError, type DaemonFetch } from '../../lib/runtime-models.ts';

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Reads one analytics query from exactly the supplied paired daemon. */
export const fetchAnalytics = async (
  daemon: DaemonConnection,
  query?: string,
  fetcher: DaemonFetch = fetch,
): Promise<AnalyticsResponse> => {
  const search = new URLSearchParams();
  if (query?.trim()) search.set('q', query.trim());
  const request = daemonRequest(daemon, `/v1/analytics${search.size === 0 ? '' : `?${search.toString()}`}`);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return AnalyticsResponseSchema.parse(await response.json());
};
