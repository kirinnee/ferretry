import type { AnalyticsIndexStatus, AnalyticsResponse } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { AnalyticsPricingRate } from '../../analytics/pricing.ts';
import { AnalyticsQueryError, parseAnalyticsQuery } from '../../analytics/query.ts';
import { queryAnalyticsRecords } from '../../analytics/results.ts';
import { rebuildAnalyticsSessionIndex, type FinishedAnalyticsSession } from '../../analytics/session-record.ts';

/**
 * The analytics read: one bounded PromQL-like query over every finished session the daemon holds a
 * durable record for.
 *
 * This is the route the CLI's `fy analytics` already speaks — `GET /v1/analytics?q=…` — so mounting
 * it is what turns the shipped command from a 404 into an answer. The query parser, the pricing
 * snapshot, the model-identity normaliser and the aggregator behind it were built and fully tested
 * and nothing constructed them.
 *
 * THE INDEX IS REBUILT PER REQUEST, from the authoritative session documents, rather than being
 * materialised into a durable table. `rebuildAnalyticsSessionIndex` exists precisely because the
 * index is disposable — "an analytics index is never a source of truth" — and a daemon that holds
 * tens of sessions has nothing to gain from caching a derivation this cheap. `refreshing` is
 * therefore always `false`: there is no background pass that could be mid-flight.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE.
 *
 * TOKEN AND COST COLUMNS ARE NULL. Per-session token totals are TRANSCRIPT evidence, and the daemon
 * mounts no analytics transcript ingestion: nothing folds a harness transcript's usage records into
 * a session total. So `usage` is reported absent, every token column comes back `null`, the
 * `token_data` label answers `unknown`, and `tokenSessions` counts what is actually known — zero
 * today. Deriving a token count from `contextTokens`, the only token-shaped number the daemon does
 * hold, would put a number on the board that measures the context window rather than the spend.
 *
 * COSTS ARE UNPRICED, NOT ZERO. Pricing needs an operator-owned rate catalog and the daemon has no
 * source mounted for one, so the catalog arrives empty and every snapshot is `unpriced` with a
 * reason. An empty catalog can never produce a cost, which is the point: a zero would read as free.
 *
 * `transcriptSources` and its companions are `0` for the same reason — this index reads durable
 * session documents only, so there are no transcript sources to be behind on.
 */

/**
 * The stored index schema this daemon materialises.
 *
 * It is `1` because the shape has never changed; it is DECLARED rather than omitted so a client can
 * tell a daemon that rebuilt the index under a new derivation from one that did not.
 */
const ANALYTICS_INDEX_SCHEMA_VERSION = 1;

/** The only parameter this route takes. See `analyticsQuery` for why an unknown one is refused. */
const ANALYTICS_PARAMETERS = ['q'] as const;

/**
 * The analytics subsystem as the route needs it.
 *
 * Both members are pulled per request rather than held: the finished-session set changes as sessions
 * end, and a route that closed over a snapshot taken at boot would answer with the fleet as it was
 * when the daemon started.
 */
export interface AnalyticsSubsystem {
  /**
   * Every session the daemon holds a durable FINISHED record for. A session still running has no
   * finish instant, so it has no duration and no end-of-run context — including it would report a
   * half-measured run as a completed one.
   */
  finished(): Promise<readonly FinishedAnalyticsSession[]>;
  /** The operator's rate catalog. Empty means costs are honestly unpriced, never zero. */
  pricing(): readonly AnalyticsPricingRate[];
}

/**
 * The query the caller asked for.
 *
 * An unrecognised parameter is REFUSED rather than ignored, matching the task board's filters: a
 * caller who narrows a query with a parameter this daemon does not implement and gets the whole
 * fleet back has been given a wrong answer, not a missing feature.
 */
function analyticsQuery(request: ApiRequest): string | undefined {
  for (const [name] of request.query) {
    if (!ANALYTICS_PARAMETERS.some(known => known === name))
      throw new ApiError(400, `unknown analytics parameter ${name}`, 'unknown_parameter');
  }
  return request.query.get('q')?.[0];
}

/**
 * Re-raises a query the parser refused as the CALLER's fault, and anything else as itself.
 *
 * The distinction is the point: a state home the daemon could not read is the daemon's problem and
 * must surface as a 500, never as "your query was malformed" — a caller told its query was wrong
 * will keep rewriting a query that was right all along.
 */
function reraise(error: unknown): never {
  if (error instanceof AnalyticsQueryError) throw new ApiError(400, error.message, 'invalid_query');
  throw error;
}

/** What the freshly derived index consists of, reported alongside every answer so a caller can tell
 *  "nothing matched" from "nothing is indexed". */
function indexStatus(sessions: number, tokenSessions: number): AnalyticsIndexStatus {
  return {
    schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
    sessions,
    tokenSessions,
    transcriptSources: 0,
    indexedTranscriptSources: 0,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  };
}

/** One analytics answer over the whole fleet. */
async function query(subsystem: AnalyticsSubsystem, context: RouteContext): Promise<ApiResponse> {
  const source = analyticsQuery(context.request);
  try {
    // Parsed BEFORE the session set is read: a malformed query is the caller's mistake and must not
    // cost a full read of every session document in the state home first.
    parseAnalyticsQuery(source);
    const catalog = subsystem.pricing();
    const finished = await subsystem.finished();
    const records = rebuildAnalyticsSessionIndex({ listFinishedAnalyticsSessions: () => finished }, catalog);
    const rows = records.map(record => record.raw);
    const response: AnalyticsResponse = queryAnalyticsRecords(rows, source, {
      index: indexStatus(rows.length, rows.filter(row => row.tokens !== null).length),
    });
    return jsonResponse(response);
  } catch (error) {
    reraise(error);
  }
}

/**
 * `admin` scope: the answer carries every session's working directory, label and parentage across
 * the whole fleet, which is more than a warden-scoped caller is trusted with.
 *
 * `noStore` because the index is derived from live session state; a cached answer reports a fleet
 * that has already moved on.
 */
export function analyticsRoutes(subsystem: AnalyticsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/analytics',
      scope: 'admin',
      noStore: true,
      handle: async context => await query(subsystem, context),
    },
  ];
}
