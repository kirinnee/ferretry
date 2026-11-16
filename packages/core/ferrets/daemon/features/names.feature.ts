import { ApiError, jsonResponse, queryValue } from '@ferretry/kernel/contract';
import { DEFAULT_CALLSIGN_POOL, suggestCallsigns } from '../lib/names/index.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, ready, archiveRead, heldClaims } = f;

  return {
    routes: {
      'GET /v1/names': async call => {
        await ready();
        const raw = queryValue(call.request, 'count');
        const count = raw === undefined ? 1 : Number(raw);
        if (!Number.isInteger(count) || count < 1)
          throw new ApiError(400, 'count must be a whole number of at least one', 'invalid_count');
        await archiveRead();
        const nowMs = kernel.clock.nowMs();
        // A suggestion, not a reservation: the names the fleet holds (a stopped ferret's inside its window), as today.
        const start = Math.floor(nowMs / 1000) % DEFAULT_CALLSIGN_POOL.length;
        return jsonResponse([...suggestCallsigns(DEFAULT_CALLSIGN_POOL, heldClaims(), nowMs, count, start)]);
      },
    },
  };
}

export default { id: 'names', register } satisfies FerretsFeature;
