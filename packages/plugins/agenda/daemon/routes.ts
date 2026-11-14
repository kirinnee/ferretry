import { AskOwnerActionError, type AskId, type AsksApi } from '@ferretry/core-asks/contract';
import { ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  type FerretId,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  AgendaClearAgentsRequestSchema,
  AgendaClearAgentsResultSchema,
  AgendaModePatchSchema,
  AgendaOpenPageSchema,
  AgendaOpenQuerySchema,
  DaemonAgendaActionSchema,
  DaemonAgendaSchema,
  PushSeenRequestSchema,
  PushSeenResponseSchema,
} from '../contract/index.ts';
import type { AccessBuzzApi } from './lib/access-buzz.ts';
import { parseBody } from './lib/body.ts';
import type { BuzzLedger } from './lib/buzz-service.ts';
import { waitingOnOwner } from './lib/buzz-policy.ts';
import type { AgendaAgentClearer } from './lib/clear-agents.ts';
import { AgendaModeError, type AgendaModeService } from './lib/agenda-mode.ts';
import { MachineAgendaError, type MachineAgendaView } from './lib/machine-agenda.ts';
import type { AgendaRollup } from './lib/rollup.ts';
import { markSeen, type SeenStore, tagsToClear } from './lib/seen.ts';

const OWNER_ONLY = 'only the owner answers the machine agenda';

/** What the routes are built from. */
export interface AgendaRouteParts {
  readonly rollup: AgendaRollup;
  readonly clearer: AgendaAgentClearer;
  readonly modes: AgendaModeService;
  readonly machine: MachineAgendaView;
  readonly asks: Pick<AsksApi, 'get' | 'open'>;
  readonly ferrets: Pick<FerretsApi, 'mayTouch'>;
  readonly ledger: Pick<BuzzLedger, 'forFerret'>;
  readonly seen: SeenStore;
  readonly access: () => Pick<AccessBuzzApi, 'clear'> | undefined;
  readonly now: () => Instant;
  readonly modeChanged: (ferret: string, enabled: boolean) => void;
}

/** Refuses a ferret's (or a warden's) credential on a route only the owner uses. Decided from the standing, never a header. */
function ownerOnly(call: CallContext, message: string): void {
  if (isFerretCall(call)) throw new ApiError(403, message, 'forbidden');
}

const ferretParam = (call: CallContext): string => {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
};

/** The device behind a call: the paired device whose credential made it, or `undefined` (the host, a ferret). */
const callerDevice = (call: CallContext): string | undefined =>
  call.credential?.tokenClass === 'device' ? String(call.credential.principal.holder) : undefined;

const queryOf = (call: CallContext) => {
  const input: Record<string, unknown> = {};
  const after = queryValue(call.request, 'after');
  if (after !== undefined && after !== '') input.after = after;
  const limit = queryValue(call.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = AgendaOpenQuerySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      `the page is not usable: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      'invalid',
    );
  }
  return parsed.data;
};

function machineFailure(error: unknown): never {
  if (error instanceof MachineAgendaError || error instanceof AskOwnerActionError) {
    const reason = error instanceof MachineAgendaError ? error.reason : error.code;
    const status =
      reason === 'not-found'
        ? 404
        : reason === 'forbidden'
          ? 403
          : ['read-only', 'full', 'ask_changed', 'stale'].includes(reason)
            ? 409
            : reason === 'rate-limited'
              ? 429
              : reason === 'corrupt'
                ? 500
                : 400;
    throw new ApiError(status, error.message, reason);
  }
  throw error;
}

/** The routes Agenda declares, one handler each (today's descriptors live in the manifest). */
export function agendaRoutes(parts: AgendaRouteParts) {
  const ferretMayTouch = (call: CallContext, target: string): void => {
    const caller = ferretOf(call);
    // G43: a ferret touches only its own agenda mode (a lead also its helpers'); the owner touches any.
    if (caller !== undefined && !parts.ferrets.mayTouch(caller, target as FerretId))
      throw new ApiError(403, 'a ferret may switch only its own agenda mode (a lead also its helpers’)', 'forbidden');
  };
  const modeFailure = (error: unknown): never => {
    if (error instanceof AgendaModeError) throw new ApiError(404, error.message, 'not-found');
    throw error;
  };

  return {
    'GET /v1/agenda/open': (async call => {
      const page = AgendaOpenPageSchema.parse(await parts.rollup.page(queryOf(call)));
      return jsonResponse(page);
    }) satisfies RouteHandler,

    'POST /v1/agenda/clear-agents': (async call => {
      ownerOnly(call, 'only the owner can clear the agent ferrets’ agenda items');
      const request = await parseBody(call.request, AgendaClearAgentsRequestSchema);
      const result = request.dryRun === true ? await parts.clearer.preview() : await parts.clearer.clear();
      return jsonResponse(AgendaClearAgentsResultSchema.parse(result));
    }) satisfies RouteHandler,

    'GET /v1/ferrets/:ferretId/agenda-mode': (async call => {
      const ferret = ferretParam(call);
      ferretMayTouch(call, ferret);
      return jsonResponse(await parts.modes.get(ferret).catch(modeFailure));
    }) satisfies RouteHandler,

    'PATCH /v1/ferrets/:ferretId/agenda-mode': (async call => {
      const ferret = ferretParam(call);
      ferretMayTouch(call, ferret);
      const request = await parseBody(call.request, AgendaModePatchSchema);
      const outcome = await parts.modes.set(ferret, request.enabled).catch(modeFailure);
      parts.modeChanged(ferret, request.enabled);
      return jsonResponse({ ferret, enabled: request.enabled, ...outcome });
    }) satisfies RouteHandler,

    'POST /v1/push/seen': (async call => {
      const body = await parseBody(call.request, PushSeenRequestSchema);
      const ask = await parts.asks.get({ ferret: body.sessionId, id: body.agendaId as AskId });
      if (ask === undefined) throw new ApiError(404, 'no ask with that id on that board', 'push_not_found');
      await markSeen(parts.seen, body.sessionId, body.agendaId, parts.now());
      const buzzes = await parts.ledger.forFerret(body.sessionId);
      const others = waitingOnOwner(
        await parts.asks.open({ ferret: body.sessionId as FerretId, state: 'open' }),
      ).filter(other => other.id !== body.agendaId);
      const tags = tagsToClear(body.sessionId, body.agendaId, {
        askBuzzed: buzzes.some(record => record.ask === body.agendaId),
        stopBuzzed: buzzes.some(record => record.kind === 'stopped'),
        othersWaiting: others.length > 0,
      });
      const clear = parts.access()?.clear;
      const told = tags.length > 0 && clear !== undefined ? await clear(tags, callerDevice(call)) : 0;
      return jsonResponse(PushSeenResponseSchema.parse({ cleared: told > 0, tags }));
    }) satisfies RouteHandler,

    'GET /v1/machine/agenda': (async call => {
      ownerOnly(call, OWNER_ONLY);
      return jsonResponse(DaemonAgendaSchema.parse(await parts.machine.list().catch(machineFailure)));
    }) satisfies RouteHandler,

    'GET /v1/machine/agenda/:id': (async call => {
      ownerOnly(call, OWNER_ONLY);
      const id = decodeParameter(call.params.get('id') ?? '');
      if (id === undefined || id === '') throw new ApiError(400, 'the ask id in the path is not usable', 'invalid');
      return jsonResponse(await parts.machine.find(id).catch(machineFailure));
    }) satisfies RouteHandler,

    'POST /v1/machine/agenda': (async call => {
      ownerOnly(call, OWNER_ONLY);
      const action = await parseBody(call.request, DaemonAgendaActionSchema);
      return jsonResponse(DaemonAgendaSchema.parse(await parts.machine.act(action).catch(machineFailure)));
    }) satisfies RouteHandler,
  } as const;
}
