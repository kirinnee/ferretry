import type { LimitsView } from '@ferretry/protocol';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { ModuleContribution } from '../modules.ts';

/**
 * Ferret limits: `GET /v1/cgroups/config`, read-only.
 *
 * WHAT CHANGED. This used to be the editor's pair of routes (GET and PATCH) over a JSON document that
 * only this mount wrote. The limits are `limits.yaml` now — the machine's one human-editable
 * configuration, whose writer holds a loosening for the owner to confirm — so a second writer here would
 * be a way around that gate. The route that remains answers the question the app and `fy daemon status`
 * actually ask: what is in force on this machine, and is it working? The path keeps its name so an older
 * client reaches a route that exists; its body is the new {@link LimitsView}.
 *
 * `fleet.use` (reading), `noStore`: a cached read shows the limits a change has already replaced, and the
 * live part (ferrets slowed or killed for memory) is a measurement of this moment.
 */

/** The surface the route requires. Narrow on purpose: a test answers it without a host manager behind it. */
export interface LimitsSubsystem {
  view(): Promise<LimitsView>;
}

export function cgroupRoutes(subsystem: LimitsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/cgroups/config',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await subsystem.view()),
    },
  ];
}

/**
 * What the cgroups module adds to the daemon: its one route. It has no audit rule — the route only reads.
 *
 * Resource limits register beside the fleet they bound, and are governed by the same capability for the same
 * reason: this is a machine-wide setting about the agents this daemon runs. The path is the one fixed literal
 * `/v1/cgroups/config`, which no other subsystem uses, so this table can neither shadow nor be shadowed by
 * anything around it.
 */
export function cgroupsContribution(subsystem: LimitsSubsystem): ModuleContribution {
  return { routes: cgroupRoutes(subsystem) };
}
