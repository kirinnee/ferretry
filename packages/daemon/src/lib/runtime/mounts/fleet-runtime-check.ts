/**
 * `POST /v1/fleet/runtimes/:runtimeId/check` — one real "reply OK" through a runtime on its own default
 * model, the start probe `fy new` runs, asked for on purpose (`../../fleet/runtime-check.ts`).
 *
 * ## `fleet.use`
 *
 * It changes nothing and starts no ferret: it runs the runtime's own launcher once, exactly as the probe
 * before every Pack start does, and answers a code and a sentence built from plain facts. It spends one
 * model call on the runtime's own login — the same call any start already spends — so it sits with the
 * other uses of the fleet's runtimes, not with `configure`. The security log records it as a use of that
 * login's secrets (`secrets.used`, `action: runtime-check`).
 *
 * ## `noStore`
 *
 * Every answer is a statement about now. 30 seconds at most; a pass is kept by the probe cache.
 */
import { FleetRuntimeCheckRequestSchema, FleetRuntimeCheckResultSchema } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { RuntimeCheckRefusal, type RuntimeCheckService } from '../../fleet/runtime-check.ts';

export type FleetRuntimeCheckSubsystem = Pick<RuntimeCheckService, 'check'>;

function runtimeId(context: RouteContext): string {
  const id = decodeParameter(context.params.get('runtimeId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the runtime id in the path is not usable', 'bad_request');
  return id;
}

/** This subsystem's route table. */
export function fleetRuntimeCheckRoutes(subsystem: FleetRuntimeCheckSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/fleet/runtimes/:runtimeId/check',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context => {
        // An empty strict body: a field an older client still sends is refused, not ignored.
        await parseBody(context.request, FleetRuntimeCheckRequestSchema);
        const id = runtimeId(context);
        try {
          return jsonResponse(FleetRuntimeCheckResultSchema.parse(await subsystem.check(id)));
        } catch (error) {
          if (error instanceof RuntimeCheckRefusal) {
            throw new ApiError(error.code === 'fleet_runtime_unknown' ? 404 : 409, error.message, error.code);
          }
          throw error;
        }
      },
    },
  ];
}
