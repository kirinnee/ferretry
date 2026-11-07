/**
 * Daemon-bound transport for the Insights pages.
 *
 * Insights data is never read from the page origin or a module singleton: the daemon's client is an
 * explicit input to every request (`GET /v1/usage/insights`).
 */
import { type AnalyticsResponse, AnalyticsResponseSchema } from '../../../contract/index.ts';
import type { DaemonConnection, DaemonSessionScope, UsageClient } from '../../shell.ts';

const INSIGHTS_ROUTE = 'GET /v1/usage/insights';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('insights scope must belong to the requested daemon');
};

const insightsRead = async (client: UsageClient, query: Record<string, string>): Promise<AnalyticsResponse> =>
  AnalyticsResponseSchema.parse(await client.call(INSIGHTS_ROUTE, { query }));

/**
 * Reads one insights query from the daemon the client belongs to.
 *
 * `timeZone` is the IANA zone whose calendar the daemon counts `day` and `week` in; without it the answer
 * is UTC's.
 */
export const fetchAnalytics = async (
  client: UsageClient,
  query?: string,
  timeZone?: string,
): Promise<AnalyticsResponse> => {
  const search: Record<string, string> = {};
  if (query?.trim()) search.q = query.trim();
  if (timeZone) search.tz = timeZone;
  return await insightsRead(client, search);
};

/**
 * Reads one ferret's insights from the daemon the client belongs to.
 *
 * Scope travels separately from editable query text so the daemon enforces it.
 * The response echoes the canonical scoped query, which the surface writes back
 * into its input after a request.
 */
export const fetchSessionAnalytics = async (
  daemon: DaemonConnection,
  client: UsageClient,
  scope: DaemonSessionScope,
  query?: string,
): Promise<AnalyticsResponse> => {
  assertScopeDaemon(daemon, scope);
  const search: Record<string, string> = {};
  if (query?.trim()) search.q = query.trim();
  search.session = scope.sessionId;
  return await insightsRead(client, search);
};
