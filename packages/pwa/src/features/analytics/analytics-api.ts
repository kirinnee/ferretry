/**
 * Daemon-bound transport for the fleet analytics page.
 *
 * Analytics data is never read from the page origin or a module singleton: the
 * paired connection is an explicit input to every request.
 */
import { AnalyticsResponseSchema, type AnalyticsResponse } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { browserFetch, DaemonResponseError, type DaemonFetch } from '../../lib/runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('analytics scope must belong to the requested daemon');
};

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const analyticsRead = async (
  daemon: DaemonConnection,
  search: URLSearchParams,
  fetcher: DaemonFetch,
): Promise<AnalyticsResponse> => {
  const request = daemonRequest(daemon, `/v1/analytics${search.size === 0 ? '' : `?${search.toString()}`}`);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return AnalyticsResponseSchema.parse(await response.json());
};

/** Reads one analytics query from exactly the supplied paired daemon. */
export const fetchAnalytics = async (
  daemon: DaemonConnection,
  query?: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<AnalyticsResponse> => {
  const search = new URLSearchParams();
  if (query?.trim()) search.set('q', query.trim());
  return await analyticsRead(daemon, search, fetcher);
};

/**
 * Reads one session's analytics from exactly the supplied paired daemon.
 *
 * Scope travels separately from editable query text so the daemon enforces it.
 * The response echoes the canonical scoped query, which the surface writes back
 * into its input after a request.
 */
export const fetchSessionAnalytics = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  query?: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<AnalyticsResponse> => {
  assertScopeDaemon(daemon, scope);
  const search = new URLSearchParams();
  if (query?.trim()) search.set('q', query.trim());
  search.set('session', scope.sessionId);
  return await analyticsRead(daemon, search, fetcher);
};
