import {
  type AgendaId,
  type AgendaReadItem,
  AgendaReadItemSchema,
  isMachineAgendaId,
} from '@ferretry/core-asks/contract';
import { AGENDA_READ_HEADERS, type AgendaCall, agendaCall, DaemonResponseError } from './agenda-call.ts';
import { MACHINE_AGENDA_ITEM, SESSION_AGENDA_ITEM } from './agenda-wire.ts';
import type { DaemonConnection, DaemonSessionScope } from './machine.ts';

/** A complete document is read only when its list header is opened, through the same client. */
export const fetchAgendaItem = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  client: AgendaCall,
): Promise<AgendaReadItem> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('agenda scope must belong to the requested daemon');
  const answer = isMachineAgendaId(scope.sessionId)
    ? await agendaCall(client, MACHINE_AGENDA_ITEM, { params: { id }, headers: AGENDA_READ_HEADERS })
    : await agendaCall(client, SESSION_AGENDA_ITEM, {
        params: { ferretId: scope.sessionId, id },
        headers: AGENDA_READ_HEADERS,
      });
  const item = AgendaReadItemSchema.parse(answer);
  if (item.id !== id) throw new DaemonResponseError(502, 'daemon returned another agenda item');
  return item;
};
