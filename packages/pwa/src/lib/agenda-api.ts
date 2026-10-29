/**
 * The browser's half of the Agenda switch (docs/agenda.md): one write, through the fetch a
 * screen passes (`useDaemonFetch`), so a daemon only the relay reaches is reached and nothing here
 * carries a credential.
 */

import {
  FY_REQUEST_ID_HEADER,
  type SessionAgendaModePatchResult,
  SessionAgendaModePatchResultSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** The daemon's refusal, in its own words when it gave any. */
const refusal = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Switches whether one ferret is told to keep an agenda; it takes effect at that ferret's next launch. */
export const patchSessionAgenda = async (
  daemon: DaemonConnection,
  sessionId: string,
  enabled: boolean,
  fetcher: DaemonFetch,
): Promise<SessionAgendaModePatchResult> => {
  const request = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(sessionId)}/agenda-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    body: JSON.stringify({ enabled }),
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await refusal(response);
  return SessionAgendaModePatchResultSchema.parse(await response.json());
};
