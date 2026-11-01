import {
  type WardenAgendaView,
  WardenConfigPatchSchema,
  type WardenConfigView,
  type WardenInvestigateRequest,
  WardenInvestigateRequestSchema,
  type WardenInvestigateView,
  type WardenLeaveRequest,
  WardenLeaveRequestSchema,
  type WardenLeaveView,
  WardenRunRequestSchema,
  type WardenRunView,
  type WardenStatusView,
  type WardenVerdictsView,
} from '@ferretry/protocol';
import { type WardenRequestFailure, WardenRequestError } from '../../warden/sweep.ts';
import { isAgentCaller, OWNER_ONLY_CODE } from '../../api/agent-caller.ts';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, queryValue } from '../../api/http.ts';
import { jsonResponse, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Warden supervision: `/v1/warden/status`, `/v1/warden/run`, `/v1/warden/config`, a read of the
 * Warden's own Agenda cards at `/v1/warden/attention`, the owner's own request at `/v1/warden/investigate`, and the owner
 * leaving a ferret alone for longer at `/v1/warden/leave`.
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
  /** An empty index means this daemon has no reports. Read failures are
   * propagated so the PWA can call evidence unavailable rather than clean. */
  verdicts(): Promise<Readonly<WardenVerdictsView>>;
  /** Full evidence for a report index row. Missing and out-of-scope paths share
   * one result so the endpoint cannot disclose arbitrary filesystem state. */
  report(reportPath: string): Promise<string | undefined>;
  /** One sweep. `force` is the operator's `--spawn`: it bypasses the enabled flag, the spawn gap and
   *  the fingerprint suppression, and never the concurrency cap or account eligibility. */
  run(force: boolean): Promise<WardenRunView>;
  config(): Promise<WardenConfigView>;
  updateConfig(patch: unknown): Promise<WardenConfigView>;
  /** Every ferret that needs the owner, and why. */
  attention(): Promise<WardenAgendaView>;
  /**
   * The owner asks for an investigation of one ferret: it skips Jev, queues, and a sweep runs at once so
   * it starts if a slot is free. Refusals are {@link WardenRequestError}s.
   */
  investigate(request: WardenInvestigateRequest): Promise<WardenInvestigateView>;
  /**
   * The owner leaves a flagged or cleared ferret alone for longer than the Warden would. Refusals are
   * {@link WardenRequestError}s.
   */
  leave(request: WardenLeaveRequest): Promise<WardenLeaveView>;
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

/** An owner's request the Warden would not take: the ferret is missing (404), or it may not be investigated now (409). */
const REQUEST_REFUSALS: Readonly<Record<WardenRequestFailure, { readonly status: number; readonly code: string }>> = {
  off: { status: 409, code: 'warden_off' },
  not_found: { status: 404, code: 'not-found' },
  finished: { status: 409, code: 'session_finished' },
  cap: { status: 409, code: 'warden_cap_reached' },
  no_login: { status: 409, code: 'warden_no_login' },
  not_flagged: { status: 409, code: 'warden_nothing_flagged' },
};

/** Restates a warden refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof WardenError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof WardenRequestError) {
    const refusal = REQUEST_REFUSALS[error.failure];
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
  // A sweep that may SPAWN investigators starts warden sessions with no parent, so only a person asks for one; a
  // ferret may still ask for a sweep that only looks. No ferret starts a session that is not its own child.
  if (request.spawn === true && isAgentCaller(context))
    throw new ApiError(403, 'a ferret cannot start Warden investigators; ask the owner', OWNER_ONLY_CODE);
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
 * The owner asks for an investigation. The body is REQUIRED: it names the ferret, and there is no ferret
 * a missing body could safely mean.
 */
async function investigate(subsystem: WardenSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, WardenInvestigateRequestSchema);
  return jsonResponse(await subsystem.investigate(request).catch(refuse));
}

/**
 * The owner leaves a ferret alone for longer. The body is REQUIRED: it names the ferret and how long.
 */
async function leave(subsystem: WardenSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, WardenLeaveRequestSchema);
  return jsonResponse(await subsystem.leave(request).catch(refuse));
}

async function report(subsystem: WardenSubsystem, context: RouteContext): Promise<ApiResponse> {
  const reportPath = queryValue(context.request, 'path');
  if (reportPath === undefined || reportPath.trim() === '')
    throw new ApiError(400, 'a warden report path is required', 'invalid_request');
  const body = await subsystem.report(reportPath).catch(refuse);
  if (body === undefined) throw new ApiError(404, 'warden report not found', 'warden_report_not_found');
  return textResponse(body);
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
  // Shared by `/v1/warden/agenda` and its older `/v1/warden/attention` twin, so the two cannot differ.
  const handleAgenda: ApiRoute['handle'] = async () => jsonResponse(await subsystem.attention().catch(refuse));
  return [
    {
      method: 'GET',
      path: '/v1/warden/status',
      minimum: 'authenticated',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await subsystem.status().catch(refuse)),
    },
    {
      method: 'GET',
      path: '/v1/warden/verdicts',
      minimum: 'authenticated',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await subsystem.verdicts().catch(refuse)),
    },
    {
      method: 'GET',
      path: '/v1/warden/report',
      minimum: 'authenticated',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async context => await report(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/warden/run',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async context => await run(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/warden/agenda',
      minimum: 'authenticated',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: handleAgenda,
    },
    {
      method: 'GET',
      path: '/v1/warden/attention',
      minimum: 'authenticated',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      legacy: true,
      handle: handleAgenda,
    },
    // The OWNER's own request: it starts a warden session with no parent, so a ferret (or a warden) asking is
    // refused before the body is read — no ferret starts a session that is not its own child.
    {
      method: 'POST',
      path: '/v1/warden/investigate',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async context => await investigate(subsystem, context),
    },
    // CONFIGURE, not use: leaving a ferret alone switches the Warden's supervision of it off for a while,
    // which is how the Warden behaves on this host — and a remote warden can never reach it.
    {
      method: 'POST',
      path: '/v1/warden/leave',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'warden', axis: 'configure' },
      noStore: true,
      handle: async context => await leave(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/warden/config',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'warden', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await subsystem.config().catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/warden/config',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'warden', axis: 'configure' },
      noStore: true,
      handle: async context => await patchConfig(subsystem, context),
    },
  ];
}
