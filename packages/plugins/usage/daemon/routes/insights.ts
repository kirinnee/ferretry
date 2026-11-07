import { ApiError, type ApiRequest, type ApiResponse, jsonResponse, queryValues } from '@ferretry/kernel/contract';
import {
  ANALYTICS_TOO_MANY_GROUPS_CODE,
  AnalyticsGroupLimitError,
  type AnalyticsResponse,
} from '../../contract/index.ts';
import type { AnalyticsIndexRead } from '../lib/analytics/ingestion.ts';
import { AnalyticsQueryError, parseAnalyticsQuery, scopeAnalyticsQuery } from '../lib/analytics/query.ts';
import { queryAnalyticsRecords } from '../lib/analytics/results.ts';
import { isTimeZone } from '../lib/analytics/time-zone.ts';

/**
 * The insights read: one bounded PromQL-like query over every finished ferret the daemon has INGESTED into its index.
 * The rows are materialised, not derived per request; the index is a cache the daemon can drop and rebuild at any time.
 *
 * TOKEN COLUMNS ARE EVIDENCE, OR THEY ARE NULL. Where a ferret's turns could not be read the fold refuses, every token
 * column comes back `null` and the `token_data` label answers `unknown`: never zero, because a ferret whose evidence
 * could not be read spent an unknown amount rather than nothing. COSTS ARE UNPRICED, NOT ZERO, and are the API-equivalent
 * of the tokens at the owner's rates, never presented as a bill.
 */

/** The parameters this route takes. `session` scopes it to one ferret; `tz` is the IANA zone days are read in. */
const PARAMETERS = ['q', 'session', 'tz'] as const;

/** The index as the route needs it, read per request. */
export interface InsightsSubsystem {
  index(): AnalyticsIndexRead;
}

/**
 * The query a `session` scope turns `source` into: ONE rule for the route and the port. A blank scope is refused, and a
 * scope never widens the query; the scope is applied here, not by whoever reads the rows.
 */
export function scopedInsightsQuery(source: string | undefined, session: string | undefined): string | undefined {
  if (session === undefined) return source;
  if (session.trim() === '') throw new ApiError(400, 'insights session must name one ferret', 'invalid_query');
  return scopeAnalyticsQuery(source, session);
}

function queryText(request: ApiRequest): string | undefined {
  for (const [name] of request.query) {
    if (!PARAMETERS.some(known => known === name))
      throw new ApiError(400, `unknown insights parameter ${name}`, 'unknown_parameter');
  }
  const source = request.query.get('q')?.[0];
  const scopes = queryValues(request, 'session');
  if (scopes.length > 1) throw new ApiError(400, 'insights parameter session may be given once', 'repeated_parameter');
  return scopedInsightsQuery(source, scopes[0]);
}

/** A query the parser refused is the CALLER's fault; anything else is the daemon's and surfaces as itself. */
function reraise(error: unknown): never {
  if (error instanceof AnalyticsGroupLimitError) throw new ApiError(400, error.message, ANALYTICS_TOO_MANY_GROUPS_CODE);
  if (error instanceof AnalyticsQueryError) throw new ApiError(400, error.message, 'invalid_query');
  throw error;
}

/** The zone the caller reads days in. An unknown zone is refused, never quietly read as UTC. */
function timeZoneOf(request: ApiRequest): string | undefined {
  const zones = queryValues(request, 'tz');
  if (zones.length === 0) return undefined;
  if (zones.length > 1) throw new ApiError(400, 'insights parameter tz may be given once', 'repeated_parameter');
  const zone = zones[0] as string;
  if (!isTimeZone(zone))
    throw new ApiError(
      400,
      `tz must be an IANA time zone such as Asia/Singapore, not ${JSON.stringify(zone)}`,
      'invalid_time_zone',
    );
  return zone;
}

/** What `UsageApi.insights` is asked: the same three things the route takes as parameters. */
export interface InsightsRequest {
  readonly query?: string;
  readonly session?: string;
  readonly timeZone?: string;
}

/** `UsageApi.insights`: the route's query over the index, scoped by `session` exactly as the route scopes it. */
export function insightsForPort(
  subsystem: InsightsSubsystem,
  request: InsightsRequest,
  machine: string | null,
): AnalyticsResponse {
  const source = scopedInsightsQuery(request.query, request.session);
  try {
    parseAnalyticsQuery(source);
    const read = subsystem.index();
    return queryAnalyticsRecords(read.rows, source, {
      index: read.status,
      now: read.now,
      machine,
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
    });
  } catch (error) {
    reraise(error);
  }
}

/** `GET /v1/usage/insights`. */
export function insightsAnswer(subsystem: InsightsSubsystem, request: ApiRequest, machine: string | null): ApiResponse {
  const source = queryText(request);
  const timeZone = timeZoneOf(request);
  try {
    // Parsed BEFORE the index is read: a malformed query must not cost a full read of the store first.
    parseAnalyticsQuery(source);
    const read = subsystem.index();
    const response: AnalyticsResponse = queryAnalyticsRecords(read.rows, source, {
      index: read.status,
      now: read.now,
      machine,
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    return jsonResponse(response);
  } catch (error) {
    reraise(error);
  }
}
