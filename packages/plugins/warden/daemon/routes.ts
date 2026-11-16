import {
  ApiError,
  type CallContext,
  jsonResponse,
  type PlainApiResponse,
  textResponse,
} from '@ferretry/kernel/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import { ferretOf, isFerretCall, OWNER_ONLY_CODE } from '@ferretry/core-gate/contract';
import {
  WardenSettingsPatchSchema,
  WardenInvestigateRequestSchema,
  WardenLeaveRequestSchema,
  WardenRunRequestSchema,
} from '../contract/index.ts';
import { parseBody, parseOptionalBody } from './lib/body.ts';
import { WardenConfigHeld, WardenConfigMoved, WardenConfigRefused } from './adapters/index.ts';
import type { WardenSubsystem } from './subsystem.ts';
import { WardenRequestError, type WardenRequestFailure } from './lib/index.ts';
import {
  ferretAgendaView,
  ferretRunView,
  ferretStatusView,
  ferretVerdictsView,
  type WardenReadScope,
} from './lib/index.ts';
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

/** What a ferret is told when it asks for a report: why not, and where its own verdicts are. */
const FERRET_REPORT_SENTENCE =
  'The Warden’s reports are for the owner. Your own verdicts are at GET /v1/warden/verdicts.';

const first = (call: CallContext, name: string): string | undefined => call.request.query.get(name)?.[0];

/**
 * The nine routes, field for field today's `warden` mount. Reads of text a pane produced (status, verdicts, report,
 * agenda, run) declare `guard: 'secrets'` in the manifest, so the host redacts their bodies; the sweep also scrubs what
 * it sends to a model.
 */
export function wardenRoutes(subsystem: WardenSubsystem, ferrets: Pick<FerretsApi, 'mayTouch'>) {
  // The owner and a person read the whole fleet. A FERRET reads its own lineage (itself and its helpers, `mayTouch`):
  // the scope narrows every list at its source, before its cut, and the answer is then built by the ONE deny-by-default
  // projection of `ferret-view.ts`, which a ferret's reply never skips: every route below that a ferret can call
  // (`status`, `verdicts`, `report`, `agenda`, `run`) answers through it. `config` is the owner's static settings,
  // which a ferret may read; `investigate`, `leave` and `PATCH config` are person-only and refuse a ferret at Gate.
  const scopeOf = (call: CallContext): WardenReadScope | undefined => {
    const caller = ferretOf(call);
    return caller === undefined ? undefined : { mayRead: ferret => ferrets.mayTouch(caller, ferret as FerretId) };
  };
  return {
    'GET /v1/warden/status': guarded(async call => {
      const scope = scopeOf(call);
      const owner = toWireStatus(await subsystem.status(scope));
      return jsonResponse(scope === undefined ? owner : ferretStatusView(owner, scope));
    }),
    'GET /v1/warden/verdicts': guarded(async call => {
      const scope = scopeOf(call);
      const owner = toWireVerdicts(await subsystem.verdicts(scope));
      return jsonResponse(scope === undefined ? owner : ferretVerdictsView(owner, scope));
    }),
    // A report is a model's prose and proving whose subject each sentence is cannot be done reliably, so a FERRET is never
    // served one, its own included: 404 (never 403, so no report's existence is confirmed) for a fleet or an assigned
    // credential alike, before any file is opened. The owner and a person read it as before.
    'GET /v1/warden/report': guarded(async call => {
      if (scopeOf(call) !== undefined) throw new ApiError(404, FERRET_REPORT_SENTENCE, 'warden_report_not_found');
      const reportPath = first(call, 'path');
      if (reportPath === undefined || reportPath.trim() === '')
        throw new ApiError(400, 'a warden report path is required', 'invalid_request');
      const body = await subsystem.report(reportPath);
      if (body === undefined) throw new ApiError(404, 'warden report not found', 'warden_report_not_found');
      return textResponse(body);
    }),
    'GET /v1/warden/agenda': guarded(async call => {
      const scope = scopeOf(call);
      const owner = toWireAgenda(await subsystem.agenda(scope));
      return jsonResponse(scope === undefined ? owner : ferretAgendaView(owner, scope));
    }),
    'POST /v1/warden/run': guarded(async call => {
      const request = await parseOptionalBody(call.request, WardenRunRequestSchema);
      // A sweep that may SPAWN investigators starts warden sessions with no parent, so only a person asks for one; a
      // ferret may still ask for a sweep that only looks. No ferret starts a session that is not its own child.
      if (request.spawn === true && isFerretCall(call))
        throw new ApiError(403, 'a ferret cannot start Warden investigators; ask the owner', OWNER_ONLY_CODE);
      const scope = scopeOf(call);
      const owner = toWireRun(await subsystem.run(request.spawn === true));
      return jsonResponse(scope === undefined ? owner : ferretRunView(owner, scope));
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
      return jsonResponse(await subsystem.updateConfig(await parseBody(call.request, WardenSettingsPatchSchema)));
    }),
  };
}
