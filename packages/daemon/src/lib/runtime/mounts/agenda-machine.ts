import { type AgendaErrorCode, AgendaActionRequestSchema, MACHINE_AGENDA_ID } from '@ferretry/protocol';
import type { AgendaActor, AgendaService } from '../../agenda/index.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { agendaActor, pathItemId, servedAgendaListSnapshot, servedAgendaSnapshot } from './agenda.ts';

const STATUS: Readonly<Record<AgendaErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'not-found': 404,
  forbidden: 403,
  'rate-limited': 429,
  'read-only': 409,
  full: 409,
  corrupt: 500,
  use_input_form: 400,
  ask_changed: 409,
  stale: 409,
};

const OWNER_ONLY = 'only the owner answers the machine agenda';

/**
 * The owner's view of the MACHINE AGENDA (docs/agenda.md § The machine agenda): notices that belong to no live
 * ferret. `GET` reads it; `POST` takes the owner's few verbs on it — dismiss (the app's Clear), snooze, unsnooze and resolve without a reply. Owner only, decided
 * from the actor the authorization boundary resolved (the same axis as `clear-agents`, docs/grants.md): a ferret's
 * credential is refused. Raising, editing and every other verb are the daemon's own and have no route, and the
 * session agenda routes never name this ledger.
 */
export function agendaMachineRoutes(machine: AgendaService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/machine/agenda',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        if (agendaActor(context.actor).kind !== 'human') throw new ApiError(403, OWNER_ONLY, 'forbidden');
        const listed = await machine.list(MACHINE_AGENDA_ID);
        if (!listed.ok) throw new ApiError(STATUS[listed.error.code], listed.error.message, listed.error.code);
        return jsonResponse(servedAgendaListSnapshot(context, listed.value));
      },
    },
    {
      method: 'GET',
      path: '/v1/machine/agenda/:id',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        if (agendaActor(context.actor).kind !== 'human') throw new ApiError(403, OWNER_ONLY, 'forbidden');
        const listed = await machine.list(MACHINE_AGENDA_ID);
        if (!listed.ok) throw new ApiError(STATUS[listed.error.code], listed.error.message, listed.error.code);
        const snapshot = servedAgendaSnapshot(context, listed.value);
        const id = pathItemId(context);
        const item = snapshot.items.find(item => item.id === id) ?? snapshot.resolved.find(item => item.id === id);
        if (item === undefined) throw new ApiError(404, 'agenda item not found', 'not-found');
        return jsonResponse(item);
      },
    },
    {
      method: 'POST',
      path: '/v1/machine/agenda',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const actor: AgendaActor = agendaActor(context.actor);
        if (actor.kind !== 'human') throw new ApiError(403, OWNER_ONLY, 'forbidden');
        const request = await parseBody(context.request, AgendaActionRequestSchema);
        const mutation = await (request.action === 'dismiss'
          ? machine.dismiss(MACHINE_AGENDA_ID, request.id, actor, request.note)
          : request.action === 'snooze'
            ? machine.snooze(MACHINE_AGENDA_ID, request.id, request.until, actor)
            : request.action === 'unsnooze'
              ? machine.unsnooze(MACHINE_AGENDA_ID, request.id, actor)
              : request.action === 'resolve' && request.response === undefined
                ? machine.resolve(MACHINE_AGENDA_ID, request.id, actor, request.note)
                : undefined);
        if (mutation === undefined) {
          throw new ApiError(
            400,
            'the machine agenda takes only dismiss, snooze, unsnooze and resolve (without a reply)',
            'invalid',
          );
        }
        if (!mutation.ok) throw new ApiError(STATUS[mutation.error.code], mutation.error.message, mutation.error.code);
        return jsonResponse(servedAgendaSnapshot(context, mutation.snapshot));
      },
    },
  ];
}
