import { type ApiResponse, jsonResponse } from '@ferretry/kernel/contract';
import type { LimitsView } from '../../protocol/limits.ts';

/**
 * Ferret limits: `GET /v1/cgroups/config`, read-only. `limits.yaml` is the machine's one human-editable
 * configuration, whose writer holds a loosening for the owner to confirm, so there is no second writer here. The
 * route answers what the app and `fy daemon status` ask: what is in force on this machine, and is it working?
 *
 * `fleet.use` (reading), `noStore`: a cached read shows the limits a change has already replaced, and the live part
 * (ferrets slowed or killed for memory) is a measurement of this moment.
 */

/** The surface the route requires. Narrow on purpose: a test answers it without a host manager behind it. */
export interface LimitsSubsystem {
  view(): Promise<LimitsView>;
}

export function limitsHandler(subsystem: LimitsSubsystem): () => Promise<ApiResponse> {
  return async () => jsonResponse(await subsystem.view());
}
