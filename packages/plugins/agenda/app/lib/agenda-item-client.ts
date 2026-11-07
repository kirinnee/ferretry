import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  type AgendaId,
  type AgendaReadItem,
  AgendaReadItemSchema,
  isMachineAgendaId,
} from '../wire/index.ts';
import type { DaemonConnection } from '../shell.ts';
import type { DaemonSessionScope } from '../shell.ts';
import { daemonRequest } from '../shell.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../shell.ts';

/** A complete document is read only when its list header is opened, through the same daemon transport. */
export const fetchAgendaItem = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaReadItem> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('agenda scope must belong to the requested daemon');
  const init = {
    method: 'GET',
    headers: { [AGENDA_CHANNEL_HEADER]: AGENDA_CHANNEL_VERSION },
  };
  const request = isMachineAgendaId(scope.sessionId)
    ? daemonRequest(daemon, `/v1/machine/agenda/${encodeURIComponent(id)}`, init)
    : daemonRequest(
        daemon,
        `/v1/ferrets/${encodeURIComponent(scope.sessionId)}/agenda/${encodeURIComponent(id)}`,
        init,
      );
  const response = await fetcher(request.url, request.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    throw new DaemonResponseError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  const item = AgendaReadItemSchema.parse(await response.json());
  if (item.id !== id) throw new DaemonResponseError(502, 'daemon returned another agenda item');
  return item;
};
