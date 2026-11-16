import type { AsksApi } from '@ferretry/core-asks/contract';
import type { ArchiveKeepSource } from '@ferretry/core-ferrets/contract';

/**
 * Agenda's half of `session.archive-keeps`: whether a ferret's OWN agenda board holds an item that is still open.
 *
 * Today's rule (fyd.ts `hasOpenAgendaItem`), copied: the ferret's board, any entry still `active` — an unanswered ask, a
 * parked item and an open notice alike. 5.0's board snapshot lists exactly those as its `items`, so one item is enough.
 *
 * FAIL SAFE, because the answer gates archiving: anything this cannot read REJECTS, and Ferrets reads a rejection as
 * "the agenda is unreadable" and keeps that ferret live. That covers a board that cannot be read, an answer that is not
 * this ferret's own board (never another ferret's items standing in), and a board with entries that did not parse
 * (one of them may have been an open item; today they were skipped, here they keep).
 */
export const agendaArchiveKeeps = (asks: Pick<AsksApi, 'snapshots'>): ArchiveKeepSource => ({
  kind: 'agenda',
  hasOpenItem: async ferret => {
    const own = (await asks.snapshots({ ferret })).filter(board => board.sessionId === ferret);
    if (own.length === 0) throw new Error(`no agenda board answered for ${ferret}`);
    if (own.some(board => board.items.length > 0)) return true;
    if (own.some(board => board.parseErrors > 0)) throw new Error(`part of ${ferret}'s agenda board could not be read`);
    return false;
  },
});
