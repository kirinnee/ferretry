/**
 * WHERE A FERRET'S AGENDA LIVES on the daemon, spelled once. Every machine this app talks to offers the whole agenda,
 * so nothing here asks a machine what it can do first.
 *
 * One literal per route, spelled out: `scripts/validate/route-agreement.ts` reads client dials lexically, and a path
 * assembled from a variable segment is a path nothing checks against the daemon.
 */

import type { SessionState } from '../shell.ts';
import type { SessionAgendaSummary } from '../wire/index.ts';

/** `GET`/`POST` the ferret's board. */
export const sessionAgendaPath = (sessionId: string): string => `/v1/ferrets/${encodeURIComponent(sessionId)}/agenda`;

/** `POST` "send now" for the answers the daemon is holding. */
export const sessionAgendaRepliesPath = (sessionId: string): string =>
  `/v1/ferrets/${encodeURIComponent(sessionId)}/agenda/replies`;

/** The ferret's open-items summary. EVERY reader of the summary goes through this. */
export const sessionAgendaSummary = (state: Pick<SessionState, 'agenda'>): SessionAgendaSummary | undefined =>
  state.agenda;
