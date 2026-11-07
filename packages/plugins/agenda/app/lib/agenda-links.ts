/**
 * WHERE AN AGENDA ROW LINKS TO, spelled by the shell's route table (`useScreenHref`) so this half hard-codes no other
 * plugin's screen: a ferret's chat is Conversation's `chat` screen, a card is Board's `card` screen, and the Agenda
 * page is this half's own. A screen no installed plugin declares answers the Agenda's own ask page (for a chat) or
 * nothing (for a card), so a link never points at a page that is not there. An ask's own page is this half's
 * (`agendaAskPath`).
 */

import { useScreenHref } from '../shell.ts';

/** The Agenda page (the manifest's `agenda` screen). */
export const AGENDA_PAGE_PATH = '/agenda';

export interface AgendaLinks {
  /** A ferret's chat; the Agenda page when Conversation is not installed. */
  readonly chat: (daemonId: string, ferret: string) => string;
  /** The Agenda page of a machine. */
  readonly agenda: (daemonId: string) => string;
  /** A card's page, when Board is installed. */
  readonly card: (daemonId: string, id: string) => string | undefined;
  /** A project's lane editor (Board's board page with its lanes open), when Board is installed. */
  readonly lanes: (daemonId: string, project: string) => string | undefined;
}

export const useAgendaLinks = (): AgendaLinks => {
  const href = useScreenHref();
  return {
    chat: (daemonId, ferret) => href(daemonId, 'conversation', 'chat', { ferret }) ?? AGENDA_PAGE_PATH,
    agenda: daemonId => href(daemonId, 'agenda', 'agenda') ?? AGENDA_PAGE_PATH,
    card: (daemonId, id) => href(daemonId, 'board', 'card', { id }),
    lanes: (daemonId, project) => {
      const board = href(daemonId, 'board', 'board', { project });
      return board === undefined ? undefined : `${board}?lanes=1`;
    },
  };
};
