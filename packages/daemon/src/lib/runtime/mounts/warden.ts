import {
  WardenConfigPatchSchema,
  WardenRunRequestSchema,
  type WardenConfigView,
  type WardenRunView,
  type WardenStatusView,
} from '@ferretry/protocol';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Warden supervision: `/v1/warden/status`, `/v1/warden/run` and `/v1/warden/config`.
 *
 * THIS MOUNT IS WHY SIX MODULES ARE PRODUCTION CODE. `packages/daemon/src/lib/warden/` held the
 * anomaly detector, the sus classifiers, the fleet-wide concurrency gate, the blessing store, the
 * account failover engine and the verdict parser — all tested, four of them on the reachability
 * allowlist, none of them reachable. `world.wardenReports` was a factory nothing called. The daemon
 * answered `unknown_route` to every one of the four warden calls the client speaks, so the product
 * had no supervision at all: nothing produced a report, and PR #139's "no evidence rather than
 * healthy" display was showing the truth about a subsystem that never ran.
 *
 * WHY THE TIMER IS PART OF THE SUBSYSTEM RATHER THAN A ROUTE. A sweep must happen without anyone
 * asking, so the capability is a LOOP, and a loop with no route would be invisible to the
 * reachability gate — which is exactly how a background subsystem ships unmounted. The subsystem
 * therefore owns both: the routes an operator calls, and `arm()`, which the composition root invokes
 * once the daemon is serving.
 *
 * WHY EVERY WRITE IS SERIALIZED BY THE SUBSYSTEM. The periodic sweep and a manual `POST /run` mutate
 * the same durable state, and two overlapping sweeps would each read that state before the other
 * wrote it — so the second would resurrect a spawn gap the first had already spent, and the pair
 * could spawn two wardens against one cap. The chain lives with the timer because the timer is the
 * other caller.
 *
 * WHY `warden` SCOPE ON THE READ AND `admin` ON THE WRITES. A live warden reads its own status to
 * understand the fleet it was sent to triage, so the status is warden-readable. Running a sweep spends
 * agent sessions and changing the configuration decides how many, so both are admin: a warden that
 * could raise its own concurrency cap or force its own re-spawn is a warden that can escalate its own
 * authority.
 */

/** Why a warden call could not be served. */
export type WardenFailure =
  /** The request describes something the warden configuration cannot be. */
  | 'invalid'
  /** The sweep ran and the work it does — reading the fleet, writing its state — failed. */
  | 'failed';

/** A refusal raised by the composition root's warden handling, in a taxonomy `src/lib` may name. */
export class WardenError extends Error {
  constructor(
    readonly failure: WardenFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WardenError';
  }
}

/**
 * Warden supervision as this route table needs it.
 *
 * `arm` is the loop, and it returns its own disarm rather than taking a cleanup list: the composition
 * root registers releases as it makes them, so an acquisition that hands back its release cannot be
 * forgotten half-way through a boot that then fails.
 */
export interface WardenSubsystem {
  status(): Promise<WardenStatusView>;
  /** One sweep. `force` is the operator's `--spawn`: it bypasses the enabled flag, the spawn gap and
   *  the fingerprint suppression, and never the concurrency cap or account eligibility. */
  run(force: boolean): Promise<WardenRunView>;
  config(): Promise<WardenConfigView>;
  updateConfig(patch: unknown): Promise<WardenConfigView>;
  /** Arms the sweep timer and returns the disarm. */
  arm(): Promise<() => void>;
  /** The last completed sweep, for the daemon's own health report. `undefined` means no sweep has
   *  run — which must never be reported as a clean one. */
  lastSweepAt(): Promise<string | undefined>;
  /** The cadence the timer fires on, so the health report measures lateness against the period the
   *  daemon actually sweeps on. */
  intervalMs(): Promise<number>;
}

const REFUSALS: Readonly<Record<WardenFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  failed: { status: 500, code: 'warden_sweep_failed' },
};

/** Restates a warden refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof WardenError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/**
 * A sweep, on request.
 *
 * The body is OPTIONAL because `spawn` has a safe default of `false` on the wire: an operator asking
 * "what does the fleet look like" with no body gets the deterministic detection and no spend. Only an
 * explicit `{"spawn": true}` authorises a session.
 */
async function run(subsystem: WardenSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseOptionalBody(context.request, WardenRunRequestSchema);
  return jsonResponse(await subsystem.run(request.spawn).catch(refuse));
}

/**
 * A configuration change.
 *
 * The body is REQUIRED here, unlike the run's: an empty patch is not a safe default but a caller
 * mistake, and answering it with the unchanged configuration would report success for an operation
 * that did nothing.
 */
async function patchConfig(subsystem: WardenSubsystem, context: RouteContext): Promise<ApiResponse> {
  const patch = await parseBody(context.request, WardenConfigPatchSchema);
  return jsonResponse(await subsystem.updateConfig(patch).catch(refuse));
}

/**
 * Every path is under `/v1/warden`, which no other subsystem uses, so this table can neither shadow
 * nor be shadowed. All three are fixed literals, so their registration order among themselves cannot
 * matter either.
 *
 * `noStore` on all of them: the status is a measurement whose entire value is freshness — a cached
 * one is a struggling fleet reporting all-clear — the run's answer is the sweep that just happened,
 * and the configuration read is what a PATCH must be visible in immediately.
 */
export function wardenRoutes(subsystem: WardenSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/warden/status',
      scope: 'warden',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.status().catch(refuse)),
    },
    {
      method: 'POST',
      path: '/v1/warden/run',
      scope: 'admin',
      noStore: true,
      handle: async context => await run(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/warden/config',
      scope: 'admin',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.config().catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/warden/config',
      scope: 'admin',
      noStore: true,
      handle: async context => await patchConfig(subsystem, context),
    },
  ];
}
