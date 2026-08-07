import { type CgroupConfigPatch, CgroupConfigPatchSchema, type CgroupConfigView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { CgroupError, type CgroupFailure, isEmptyCgroupConfigPatch } from '../../cgroups/index.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Fleet resource limits: `GET /v1/cgroups/config` and `PATCH /v1/cgroups/config`.
 *
 * THIS MOUNT IS WHAT MAKES THE SETTINGS PANEL REAL. The protocol declared both shapes, the client
 * dialled both addresses and the browser shipped a complete editor for them, while the daemon
 * answered `unknown_route` to each — two lines on the route-agreement allowlist saying exactly that.
 * The capability the product claimed to have did not exist, and both of those lines leave with this
 * change.
 *
 * WHY THE `fleet` CAPABILITY RATHER THAN A NEW ONE. This is a machine-wide setting about the agents
 * this daemon runs, which is precisely what `fleet` already governs — and the capability set is
 * CLOSED on purpose, agreed across three packages. Reading effective limits is `use`; changing them
 * is `configure`, because a remote caller who could lower the aggregate could throttle the whole
 * fleet from a phone.
 *
 * `noStore` on both. A cached read shows an operator the limits their last save replaced, and the
 * PATCH answer is a measurement of the host taken at the moment it was applied.
 */

/** The surface the routes require. Narrow on purpose: a test answers the routes without a host
 *  manager, a `/proc` reader and a registration ledger behind it. */
export interface CgroupSubsystem {
  config(): Promise<CgroupConfigView>;
  updateConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView>;
}

const REFUSALS: Readonly<Record<CgroupFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  // 409 rather than 400: nothing is wrong with the request — an operator asking for enforcement is
  // asking for something reasonable. It is this HOST that cannot provide it, and the client's own
  // unsupported presentation is keyed off that distinction.
  unsupported: { status: 409, code: 'cgroups_unsupported' },
  failed: { status: 500, code: 'cgroup_apply_failed' },
};

/** Restates a domain refusal in the HTTP vocabulary, and lets a genuine defect stay a 500. */
function refuse(error: unknown): never {
  if (error instanceof CgroupError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/**
 * A configuration change.
 *
 * The body is REQUIRED and must ask for something. `CgroupConfigPatchSchema` is strict, so a field
 * that does not exist is refused with its name rather than dropped — but strictness alone still
 * accepts `{}` and `{"fleet":{}}`, and answering either with the unchanged configuration would
 * report a save that did not happen. The merged result is then validated as a WHOLE document by the
 * domain, so a patch that is individually legal and jointly impossible — a per-agent share above the
 * fleet aggregate it must fit inside — is refused rather than persisted.
 */
async function patchConfig(subsystem: CgroupSubsystem, context: RouteContext): Promise<ApiResponse> {
  const patch = await parseBody(context.request, CgroupConfigPatchSchema);
  if (isEmptyCgroupConfigPatch(patch))
    throw new ApiError(400, 'a resource-limit change must state at least one value', 'empty_patch');
  return jsonResponse(await subsystem.updateConfig(patch).catch(refuse));
}

export function cgroupRoutes(subsystem: CgroupSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/cgroups/config',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await subsystem.config().catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/cgroups/config',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => await patchConfig(subsystem, context),
    },
  ];
}
