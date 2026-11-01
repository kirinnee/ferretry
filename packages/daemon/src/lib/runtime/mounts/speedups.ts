import {
  SpeedupProviderSchema,
  type SpeedupProvider,
  type SpeedupsView,
  type SpeedupTestResult,
} from '@ferretry/protocol';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Speed-ups: whether each optional provider key is set, and a Test that proves one works.
 *
 * NEITHER ROUTE TAKES OR RETURNS A KEY. A key goes in through `POST /v1/secrets` like every other
 * secret. The status read is a NAME lookup over the store's listing; the Test asks the daemon's
 * outbound holder to spend the key once, the cheapest way that provider allows, and answers with a
 * code and a fixed sentence — never the provider's body.
 *
 * GOVERNED AS `secrets.use`, because that is exactly what both are: the read says which secrets exist
 * (what `GET /v1/secrets` already says), and the Test spends one on the operator's account without
 * revealing it. A device the operator kept away from the store is kept away from these too.
 *
 * `operator` MINIMUM, never the warden: a Test bills the operator's provider account.
 */

/** The two calls this mount makes. `SpeedupsService` satisfies it; a test answers it with a fake. */
export interface SpeedupsSubsystem {
  view(): Promise<SpeedupsView>;
  test(provider: SpeedupProvider): Promise<SpeedupTestResult>;
}

const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };

function pathProvider(context: RouteContext): SpeedupProvider {
  const parsed = SpeedupProviderSchema.safeParse(decodeParameter(context.params.get('provider') ?? ''));
  if (!parsed.success) throw new ApiError(404, 'there is no speed-up provider by that name', 'unknown_provider');
  return parsed.data;
}

export function speedupRoutes(subsystem: SpeedupsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/speedups',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async () => jsonResponse(await subsystem.view()),
    },
    {
      method: 'POST',
      path: '/v1/speedups/:provider/test',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => jsonResponse(await subsystem.test(pathProvider(context))),
    },
  ];
}
