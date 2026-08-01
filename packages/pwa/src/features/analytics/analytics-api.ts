/**
 * Daemon-bound transport for the fleet analytics page.
 *
 * Analytics data is never read from the page origin or a module singleton: the
 * paired connection is an explicit input to every request.
 */
import { AnalyticsResponseSchema, scopeAnalyticsQuery, type AnalyticsResponse } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonRequest } from '../../lib/daemon-transport.ts';
import { DaemonResponseError, type DaemonFetch } from '../../lib/runtime-models.ts';

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

/**
 * Reads one session's analytics from exactly the supplied paired daemon.
 *
 * The daemon's `/v1/analytics` route accepts only `q` and rejects any other
 * parameter with 400 `unknown_parameter`, so — unlike kteam's server, which
 * re-enforced the session via a separate `session=` parameter — the exact-id
 * matcher is enforced here, in the browser, on every request. `scopeAnalyticsQuery`
 * rewrites the visible query onto `scope.sessionId` before transport, so a reader
 * who edits or deletes the matcher can never turn this side pane into a fleet
 * query. That is a deliberate reduction in defense-in-depth (one boundary, not
 * two) and is tracked as a known caveat rather than silently dropped; the daemon
 * still echoes the canonical scoped query, which the surface writes back into the
 * input so the box always shows what actually ran.
 */
export const fetchSessionAnalytics = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  query?: string,
  fetcher: DaemonFetch = fetch,
): Promise<AnalyticsResponse> => {
  assertScopeDaemon(daemon, scope);
  return fetchAnalytics(daemon, scopeAnalyticsQuery(query, scope.sessionId), fetcher);
};
