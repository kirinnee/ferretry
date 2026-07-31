import type { NameSuggestions } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import type { ApiRequest, ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { DEFAULT_CALLSIGN_POOL, suggestCallsigns, type NameClaim } from '../../names/index.ts';

/**
 * Free teammate callsigns, so a human can compose a `[Name] Task` title before starting anything.
 *
 * This is the route `fy name` already speaks — `GET /v1/names?count=N` — and the callsign pool it
 * reads was built and fully tested by PR #9 and never constructed.
 *
 * THESE ARE SUGGESTIONS, AND THAT IS THE WHOLE CONTRACT. Nothing is reserved. The endpoint the CLI
 * calls is named `suggestNames`, and a request for ten names is a human browsing, not ten sessions
 * about to exist — claiming on read would burn nine callsigns nobody took.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. `NameAllocator` — the atomic claim-and-fall-back path a
 * session START needs — stays unmounted. It demands a claim store whose `tryClaim` is atomic across
 * concurrent daemon requests, no adapter implements one, and a suggestion endpoint is the wrong
 * place to invent it: the claim belongs to the request that creates the session, not to the one that
 * asked what was free.
 *
 * WHAT COUNTS AS TAKEN is therefore read from the live fleet rather than from a reservation ledger:
 * a callsign a session is currently using is not free, and one whose session has aged out of the
 * resolution window is. That is the same window `resolveSessionReference` uses to decide which
 * session a bare callsign still names, so the two cannot disagree about who owns a name.
 */

/** The name pool as the route needs it: who holds what, and where to start looking. */
export interface NameSubsystem {
  /** The callsigns the fleet is currently using, with the instant each was taken. */
  claims(): Promise<readonly NameClaim[]>;
  /** Wall-clock milliseconds, injected so a claim's expiry is drivable from a test. */
  now(): number;
  /**
   * Where in the pool to start.
   *
   * Randomised in production on purpose: two humans asking at the same moment must not both be
   * offered the same first name and then collide on `fy start`.
   */
  startIndex(upperExclusive: number): number;
}

/** The only parameter this route takes; an unknown one is refused rather than ignored. */
const NAME_PARAMETERS = ['count'] as const;

/**
 * How many callsigns to offer.
 *
 * A non-numeric or non-positive `count` is REFUSED rather than clamped: the caller asked a question
 * with no answer, and quietly handing back one name would look like the pool was nearly empty.
 * The upper bound is the pool policy's own, so this route cannot promise more than it will return.
 */
function requestedCount(request: ApiRequest): number {
  for (const [name] of request.query) {
    if (!NAME_PARAMETERS.some(known => known === name))
      throw new ApiError(400, `unknown names parameter ${name}`, 'unknown_parameter');
  }
  const raw = request.query.get('count')?.[0];
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new ApiError(400, 'count must be a whole number of at least one', 'invalid_count');
  return parsed;
}

/** The callsigns nobody is using, in pool order from a rotating start. */
async function suggest(subsystem: NameSubsystem, context: RouteContext): Promise<ApiResponse> {
  const count = requestedCount(context.request);
  const response: NameSuggestions = [
    ...suggestCallsigns(
      DEFAULT_CALLSIGN_POOL,
      await subsystem.claims(),
      subsystem.now(),
      count,
      subsystem.startIndex(DEFAULT_CALLSIGN_POOL.length),
    ),
  ];
  return jsonResponse(response);
}

/**
 * `admin` scope: the answer is derived from which callsigns the fleet is currently using, which
 * tells a caller how many teammates are alive and what they are called.
 *
 * `noStore` because a cached suggestion is a name somebody else has taken since.
 */
export function nameRoutes(subsystem: NameSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/names',
      scope: 'admin',
      noStore: true,
      handle: async context => await suggest(subsystem, context),
    },
  ];
}
