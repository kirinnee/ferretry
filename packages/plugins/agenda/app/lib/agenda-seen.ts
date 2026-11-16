/**
 * THE MACHINE'S SEEN MARK for one opened ask (`POST /v1/push/seen`): the route is Agenda's, so Agenda makes the call and
 * hands it to whoever closes the alert lines (`agenda.item-opened`, contract/app-hooks.ts), which decides when to make
 * it. A refusal or a dropped call rejects, as every call does; the one who holds it treats that as "not told".
 */

import type { AgendaSeenMark } from '../../contract/app-hooks.ts';
import { PushSeenRequestSchema, PushSeenResponseSchema } from '../../contract/wire.ts';
import { type AgendaCall, agendaCall, requestIdHeaders } from './agenda-call.ts';
import { PUSH_SEEN } from './agenda-wire.ts';

/** The seen mark of `ask` on `ferret`'s board, over this half's client. */
export const seenMarkOf =
  (client: AgendaCall, ferret: string, ask: string): AgendaSeenMark =>
  async () =>
    PushSeenResponseSchema.parse(
      await agendaCall(client, PUSH_SEEN, {
        body: PushSeenRequestSchema.parse({ sessionId: ferret, agendaId: ask }),
        headers: requestIdHeaders(),
      }),
    );
