import {
  ApiError,
  type CallContext,
  jsonResponse,
  type PlainApiResponse,
  textResponse,
} from '@ferretry/kernel/contract';
import { isFerretCall, OWNER_ONLY_CODE } from '@ferretry/core-gate/contract';
import {
  WardenConfigPatchSchema,
  WardenInvestigateRequestSchema,
  WardenLeaveRequestSchema,
  WardenRunRequestSchema,
} from '../contract/index.ts';
import { parseBody, parseOptionalBody } from './lib/body.ts';
import { WardenConfigHeld, WardenConfigMoved, WardenConfigRefused } from './adapters/index.ts';
import type { WardenSubsystem } from './subsystem.ts';
import { WardenRequestError, type WardenRequestFailure } from './lib/index.ts';
import {
  toWireAgenda,
  toWireInvestigate,
  toWireLeave,
  toWireRun,
  toWireStatus,
  toWireVerdicts,
} from './lib/wire-map.ts';

const REQUEST_REFUSALS: Readonly<Record<WardenRequestFailure, { readonly status: number; readonly code: string }>> = {
  off: { status: 409, code: 'warden_off' },
  not_found: { status: 404, code: 'not-found' },
  finished: { status: 409, code: 'ferret_stopped' },
  cap: { status: 409, code: 'warden_cap_reached' },
  no_login: { status: 409, code: 'warden_no_login' },
  not_flagged: { status: 409, code: 'warden_nothing_flagged' },
};

/** Restates the sweep's refusals in the HTTP vocabulary; anything else is left to the host's own 500. */
function refuse(error: unknown): never {
  if (error instanceof WardenRequestError) {
    const refusal = REQUEST_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof WardenConfigRefused) throw new ApiError(400, error.message, 'invalid_request');
  if (error instanceof WardenConfigHeld) throw new ApiError(409, error.message, 'config_held');
  if (error instanceof WardenConfigMoved) throw new ApiError(409, error.message, 'conflict');
  throw error;
}

/** Wraps a handler so every refusal the sweep can raise leaves as an `ApiError`. */
const guarded =
  (handler: (call: CallContext) => Promise<PlainApiResponse>) =>
  async (call: CallContext): Promise<PlainApiResponse> => {
    try {
      return await handler(call);
    } catch (error) {
      return refuse(error);
    }
  };

const first = (call: CallContext, name: string): string | undefined => call.request.query.get(name)?.[0];

/**
 * The nine routes, field for field today's `warden` mount. Reads of text a pane produced (status, verdicts, report,
 * agenda, run) declare `guard: 'secrets'` in the manifest, so the host redacts their bodies; the sweep also scrubs what
 * it sends to a model.
 */
export function wardenRoutes(subsystem: WardenSubsystem) {
  return {
    'GET /v1/warden/status': guarded(async () => jsonResponse(toWireStatus(await subsystem.status()))),
    'GET /v1/warden/verdicts': guarded(async () => jsonResponse(toWireVerdicts(await subsystem.verdicts()))),
    'GET /v1/warden/report': guarded(async call => {
      const reportPath = first(call, 'path');
      if (reportPath === undefined || reportPath.trim() === '')
        throw new ApiError(400, 'a warden report path is required', 'invalid_request');
      const body = await subsystem.report(reportPath);
      if (body === undefined) throw new ApiError(404, 'warden report not found', 'warden_report_not_found');
      return textResponse(body);
    }),
    'GET /v1/warden/agenda': guarded(async () => jsonResponse(toWireAgenda(await subsystem.agenda()))),
    'POST /v1/warden/run': guarded(async call => {
      const request = await parseOptionalBody(call.request, WardenRunRequestSchema);
      // A sweep that may SPAWN investigators starts warden sessions with no parent, so only a person asks for one; a
      // ferret may still ask for a sweep that only looks. No ferret starts a session that is not its own child.
      if (request.spawn === true && isFerretCall(call))
        throw new ApiError(403, 'a ferret cannot start Warden investigators; ask the owner', OWNER_ONLY_CODE);
      return jsonResponse(toWireRun(await subsystem.run(request.spawn === true)));
    }),
    'POST /v1/warden/investigate': guarded(async call => {
      const request = await parseBody(call.request, WardenInvestigateRequestSchema);
      return jsonResponse(toWireInvestigate(await subsystem.investigate(request.ferret, request.note)));
    }),
    'POST /v1/warden/leave': guarded(async call => {
      const request = await parseBody(call.request, WardenLeaveRequestSchema);
      return jsonResponse(toWireLeave(await subsystem.leave(request.ferret, request.duration)));
    }),
    'GET /v1/warden/config': guarded(async () => jsonResponse(await subsystem.config())),
    'PATCH /v1/warden/config': guarded(async call => {
      // The held sentences come back with THIS change's view, so two changes in flight never answer each other's.
      return jsonResponse(await subsystem.updateConfig(await parseBody(call.request, WardenConfigPatchSchema)));
    }),
  };
}
