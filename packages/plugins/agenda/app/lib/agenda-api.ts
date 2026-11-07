/**
 * The browser's half of the Agenda switch (docs/agenda.md): whether one ferret is told to keep an agenda. One read and
 * one write, through this half's client by route key, so nothing here holds an address or a credential.
 */

import {
  type SessionAgendaMode,
  type SessionAgendaModePatchResult,
  SessionAgendaModePatchResultSchema,
  SessionAgendaModePatchSchema,
  SessionAgendaModeSchema,
} from '../wire/index.ts';
import { type AgendaCall, agendaCall, requestIdHeaders } from './agenda-call.ts';
import { AGENDA_MODE } from './agenda-wire.ts';

/** The switch as it reads now. */
export const AGENDA_MODE_READ = 'GET /v1/ferrets/:ferretId/agenda-mode';

/** Reads whether one ferret is told to keep an agenda, and the daemon's sentence about it. */
export const readSessionAgenda = async (client: AgendaCall, ferret: string): Promise<SessionAgendaMode> =>
  SessionAgendaModeSchema.parse(await agendaCall(client, AGENDA_MODE_READ, { params: { ferretId: ferret } }));

/** Switches whether one ferret is told to keep an agenda; it takes effect at that ferret's next launch. */
export const patchSessionAgenda = async (
  client: AgendaCall,
  ferret: string,
  enabled: boolean,
): Promise<SessionAgendaModePatchResult> =>
  SessionAgendaModePatchResultSchema.parse(
    await agendaCall(client, AGENDA_MODE, {
      params: { ferretId: ferret },
      body: SessionAgendaModePatchSchema.parse({ enabled }),
      headers: requestIdHeaders(),
    }),
  );
