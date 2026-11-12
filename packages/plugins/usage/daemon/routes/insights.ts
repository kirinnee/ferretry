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

/**
 * Whose rows a caller may read. Absent for the owner and a person (the whole fleet); present for a FERRET, which reads
 * its own lineage only: itself and its descendants (Ferrets' `mayTouch`). Decided at this external boundary: the
 * internal `turnUsage` port has no caller to ask.
 */
export interface InsightsLineage {
  mayRead(ferret: string): boolean;
}

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

/**
 * The index a lineage-bound caller may query: only the rows of ferrets it may touch, and the index's own counts of the
 * fleet narrowed to them, so neither a row, an aggregate nor a count says anything about a ferret outside the lineage.
 */
function narrowedTo(read: AnalyticsIndexRead, lineage: InsightsLineage): AnalyticsIndexRead {
  const rows = read.rows.filter(row => lineage.mayRead(row.id));
  const withTokens = rows.filter(row => row.inputTokens !== null).length;
  return {
    ...read,
    rows,
    // Every figure is recomputed from the authorized rows. The daemon-wide refresh state (pending sources, source errors,
    // refreshing, last refresh time) cannot be told per lineage, so it is OMITTED rather than carried or zeroed.
    status: {
      schemaVersion: read.status.schemaVersion,
      sessions: rows.length,
      tokenSessions: withTokens,
      transcriptSources: rows.length,
      indexedTranscriptSources: withTokens,
    },
  };
}

/**
 * `GET /v1/usage/insights`. A ferret caller (`lineage`) naming a ferret outside its lineage is refused (403, like every
 * `mayTouch` route); an unscoped query is NARROWED to its lineage rather than refused, because "my fleet" is an honest
 * question and the narrowed answer holds nothing the caller could not ask for by name.
 */
export function insightsAnswer(
  subsystem: InsightsSubsystem,
  request: ApiRequest,
  machine: string | null,
  lineage?: InsightsLineage,
): ApiResponse {
  const source = queryText(request);
  const timeZone = timeZoneOf(request);
  const session = queryValues(request, 'session')[0];
  if (lineage !== undefined && session !== undefined && !lineage.mayRead(session))
    throw new ApiError(403, 'a ferret reads the usage of itself and its own helpers only', 'forbidden');
  try {
    // Parsed BEFORE the index is read: a malformed query must not cost a full read of the store first.
    parseAnalyticsQuery(source);
    const read = lineage === undefined ? subsystem.index() : narrowedTo(subsystem.index(), lineage);
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
