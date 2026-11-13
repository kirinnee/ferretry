/**
 * WHERE A FERRET'S AGENDA LIVES on the daemon, spelled once as the route keys this half calls through its client.
 * Every machine this app talks to offers the whole agenda, so nothing here asks a machine what it can do first.
 *
 * One literal per route: the client refuses a key no compiled manifest declares, and the shell's manifest-match test
 * reads these against the Asks and Agenda manifests.
 */

import { type SessionAgendaSummary } from '../../contract/wire.ts';
import type { FerretState } from './ferret-view.ts';

/** `GET`/`POST` the ferret's board. */
export const SESSION_AGENDA_READ = 'GET /v1/ferrets/:ferretId/agenda';
export const SESSION_AGENDA_ACT = 'POST /v1/ferrets/:ferretId/agenda';
/** `POST` "send now" for the answers the daemon is holding. */
export const SESSION_AGENDA_REPLIES = 'POST /v1/ferrets/:ferretId/agenda/replies';
/** One whole item, its kept versions, one version, its stored conversation and this device's seen mark. */
export const SESSION_AGENDA_ITEM = 'GET /v1/ferrets/:ferretId/agenda/:id';
export const SESSION_AGENDA_VERSIONS = 'GET /v1/ferrets/:ferretId/agenda/:id/versions';
export const SESSION_AGENDA_VERSION = 'GET /v1/ferrets/:ferretId/agenda/:id/versions/:version';
export const SESSION_AGENDA_CONVERSATION = 'GET /v1/ferrets/:ferretId/agenda/:id/conversation';
export const SESSION_AGENDA_SEEN = 'PUT /v1/ferrets/:ferretId/agenda/:id/seen';
/** The machine's own agenda: its list, its owner actions and one notice. */
export const MACHINE_AGENDA_READ = 'GET /v1/machine/agenda';
export const MACHINE_AGENDA_ACT = 'POST /v1/machine/agenda';
export const MACHINE_AGENDA_ITEM = 'GET /v1/machine/agenda/:id';
/** Every ferret's open and parked items, paged. */
export const AGENDA_OPEN = 'GET /v1/agenda/open';
/** Dismiss the agent ferrets' backlog. */
export const AGENDA_CLEAR_AGENTS = 'POST /v1/agenda/clear-agents';
/** One ferret's Agenda mode switch. */
export const AGENDA_MODE = 'PATCH /v1/ferrets/:ferretId/agenda-mode';
/** The owner opened an ask: its buzz is spent on every device. */
export const PUSH_SEEN = 'POST /v1/push/seen';
/** The ferrets of this machine (Ferrets', a need of Agenda). */
export const FERRETS_LIST = 'GET /v1/ferrets';

/** The routes a machine-agenda scope may use; any other is refused before it is sent. */
export const MACHINE_AGENDA_ROUTES: ReadonlySet<string> = new Set([MACHINE_AGENDA_READ, MACHINE_AGENDA_ACT]);

/** The ferret's open-items summary. EVERY reader of the summary goes through this. */
export const sessionAgendaSummary = (state: Pick<FerretState, 'agenda'>): SessionAgendaSummary | undefined =>
  state.agenda;
