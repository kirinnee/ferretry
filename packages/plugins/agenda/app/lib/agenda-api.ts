/**
 * The browser's half of the Agenda switch (docs/agenda.md): whether one ferret is told to keep an agenda. One read and
 * one write, through this half's client by route key, so nothing here holds an address or a credential.
 */

import {
  type AgendaMode,
  type AgendaModePatchResult,
  AgendaModePatchResultSchema,
  AgendaModePatchSchema,
  AgendaModeSchema,
} from '../../contract/wire.ts';
import { type AgendaCall, agendaCall, requestIdHeaders } from './agenda-call.ts';
import { AGENDA_MODE } from './agenda-wire.ts';

/** The switch as it reads now. */
export const AGENDA_MODE_READ = 'GET /v1/ferrets/:ferretId/agenda-mode';

/** Reads whether one ferret is told to keep an agenda, and the daemon's sentence about it. */
export const readSessionAgenda = async (client: AgendaCall, ferret: string): Promise<AgendaMode> =>
  AgendaModeSchema.parse(await agendaCall(client, AGENDA_MODE_READ, { params: { ferretId: ferret } }));

/** Switches whether one ferret is told to keep an agenda; it takes effect at that ferret's next launch. */
export const patchSessionAgenda = async (
  client: AgendaCall,
  ferret: string,
  enabled: boolean,
): Promise<AgendaModePatchResult> =>
  AgendaModePatchResultSchema.parse(
    await agendaCall(client, AGENDA_MODE, {
      params: { ferretId: ferret },
      body: AgendaModePatchSchema.parse({ enabled }),
      headers: requestIdHeaders(),
    }),
  );
