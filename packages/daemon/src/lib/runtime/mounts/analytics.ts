import type { AnalyticsResponse } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { AnalyticsQueryError, parseAnalyticsQuery, scopeAnalyticsQuery } from '../../analytics/query.ts';
import { queryAnalyticsRecords } from '../../analytics/results.ts';
import type { AnalyticsIndexRead } from '../../analytics/ingestion.ts';

/**
 * The analytics read: one bounded PromQL-like query over every finished session the daemon has
 * INGESTED into its analytics store.
 *
 * This is the route the CLI's `fy analytics` already speaks — `GET /v1/analytics?q=…` — so mounting
 * it is what turns the shipped command from a 404 into an answer. The query parser, the pricing
 * snapshot, the model-identity normaliser and the aggregator behind it were built and fully tested
 * and nothing constructed them.
 *
 * THE ROWS ARE MATERIALISED, NOT DERIVED PER REQUEST. Ingestion happens when a session reaches a
 * durable terminal state, and this route reads the result. It used to be the other way round: every
 * question re-parsed every session's documents and re-folded every transcript, so the cost of one
 * query grew with the whole history of the fleet and no richer analytics surface could be built on it.
 * The store is still DISPOSABLE — it can be dropped and rebuilt from the durable session records at
 * any time, because those records, not this table, are what the daemon actually knows.
 *
 * WHAT IS AND IS NOT CLAIMED HERE.
 *
 * TOKEN COLUMNS ARE TRANSCRIPT EVIDENCE, OR THEY ARE NULL. A session's total is folded from its own
 * transcript's usage records, summed across every request the session made. Where that evidence is
 * missing, damaged or ambiguous the fold REFUSES, `usage` is absent, every token column comes back
 * `null` and the `token_data` label answers `unknown`. It is never reported as zero, because a
 * session whose evidence could not be read spent an unknown amount rather than nothing. Deriving a
 * count from `contextTokens` instead would put a number on the board that measures the context
 * window rather than the spend.
 *
 * COSTS ARE UNPRICED, NOT ZERO. Pricing needs an operator-owned rate catalog, supplied per daemon
 * and never guessed. A model the operator did not price stays `unpriced` with a reason, as does a
 * session whose tokens could not be established, whose model the transcript does not name, or which
 * ran under more than one model — that last one because a row carries a single price and charging a
 * whole run at one of its models would misattribute the rest. An empty catalog therefore prices
 * nothing at all, which is the point: a zero would read as free.
 *
 * COST IS API-EQUIVALENT, NOT SPEND. What a priced row states is what the same tokens would have
 * cost at the operator's per-token rates. Fleet accounts are commonly subscriptions, where marginal
 * token cost is not what the human pays, so this number must never be presented as a bill.
 *
 * COSTS ARE PRICED WHEN THE ROW IS WRITTEN, and the rate that priced it is stored beside it. An
 * operator who corrects the catalog therefore changes what future ingestions cost, and can see from
 * the row which rates a past one was charged at, instead of every historical figure silently moving.
 *
 * `transcriptSources` and its companions are the ingestion account: one source per ingested session,
 * indexed when its fold produced a total and PENDING when the fold was refused, because a refusal is
 * re-attempted on the next pass. `sourceErrors` counts the transcripts the last pass could not read at
 * all, and `refreshing` says a pass is in flight — the distinction between an index that is behind and
 * one that has nothing to say.
 */

/** The parameters this route takes. `session` is the server-enforced side-pane scope. */
const ANALYTICS_PARAMETERS = ['q', 'session'] as const;

/**
 * The analytics subsystem as the route needs it.
 *
 * READ PER REQUEST, never held: sessions keep ending and the ingestion pass keeps writing, so a route
 * that closed over a snapshot taken at boot would answer with the fleet as it was when the daemon
 * started. The operator's rate catalog is deliberately NOT part of this interface any more — a row is
 * priced when it is ingested, so the read has no pricing decision left to take.
 */
export interface AnalyticsSubsystem {
  /** The materialised rows, and an account of what they consist of. */
  index(): AnalyticsIndexRead;
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
  const source = request.query.get('q')?.[0];
  const scopes = request.query.get('session');
  if (scopes !== undefined && scopes.length > 1)
    throw new ApiError(400, 'analytics parameter session may be given once', 'repeated_parameter');
  const session = scopes?.[0];
  if (session === undefined) return source;
  if (session.trim() === '') throw new ApiError(400, 'analytics session must name one session', 'invalid_query');
  return scopeAnalyticsQuery(source, session);
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

/** One analytics answer over the whole fleet. */
function query(subsystem: AnalyticsSubsystem, context: RouteContext): ApiResponse {
  const source = analyticsQuery(context.request);
  try {
    // Parsed BEFORE the index is read: a malformed query is the caller's mistake and must not cost a
    // full read of the store first.
    parseAnalyticsQuery(source);
    const read = subsystem.index();
    const response: AnalyticsResponse = queryAnalyticsRecords(read.rows, source, { index: read.status });
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
      minimum: 'operator',
      noStore: true,
      handle: context => Promise.resolve(query(subsystem, context)),
    },
  ];
}
