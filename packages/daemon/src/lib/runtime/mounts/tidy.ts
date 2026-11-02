import type { TidyPlan } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { TidyPlanResult } from '../../tidy/index.ts';
import { boardCaller } from './board.ts';

/** One ferret's tidy plan (docs/board.md, "Tidy"). `TidyService` satisfies this structurally. */
export interface TidySubsystem {
  plan(sessionId: string): Promise<TidyPlanResult>;
}

/**
 * The plan is a read, and a read of ONE ferret's own work: the session is the caller's own credential's, never
 * a field of the request, so a ferret cannot ask for another's plan. The owner and the admin token with no
 * session have no work of their own to tidy and are refused with the way to do it by hand.
 *
 * Grants are the board's (`operator`, plus the `fleet` capability): a plan names cards and agenda items.
 */
export function tidyRoutes(tidy: TidySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/tidy/plan',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        if (caller.kind !== 'ferret') {
          throw new ApiError(
            403,
            'fy tidy tidies the work of the ferret that runs it; run it inside a ferret’s own pane',
            'forbidden',
          );
        }
        const result = await tidy.plan(caller.sessionId);
        if (!result.ok) throw new ApiError(503, `the tidy plan could not be read: ${result.message}`, 'unavailable');
        return jsonResponse(result.plan satisfies TidyPlan);
      },
    },
  ];
}
