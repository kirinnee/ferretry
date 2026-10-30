/**
 * THE AGENDA AS THE CHAT SEES IT: which open items belong to it and what the one
 * line above the composer counts. Pure: the line, the drawer and the card draw these decisions. The order
 * and the next item to open are `agenda-status.ts`.
 *
 * Plain notifications (`notice`) are the Inbox's, never the agenda's.
 */

import { type AgendaItem, agendaTurn } from '@ferretry/protocol';

/** The items of an agenda: open, and not a plain notification. */
export const agendaItems = (items: readonly AgendaItem[]): readonly AgendaItem[] =>
  items.filter(item => item.notice !== true && agendaTurn(item) !== 'done' && item.parked === undefined);

export interface AgendaCounts {
  /** Items on the owner's turn that block the ferret now. */
  readonly blocking: number;
  /** Items on the owner's turn (blocking ones included). */
  readonly needYou: number;
  /** Items on the ferret's turn. */
  readonly withFerret: number;
}

export const agendaCounts = (items: readonly AgendaItem[]): AgendaCounts => {
  const turns = items.map(item => ({ turn: agendaTurn(item), blocking: item.blockingNow === true }));
  const owner = turns.filter(entry => entry.turn === 'owner');
  return {
    blocking: owner.filter(entry => entry.blocking).length,
    needYou: owner.length,
    withFerret: turns.filter(entry => entry.turn === 'ferret').length,
  };
};

export interface AgendaSegment {
  /** The number the line shows in bold; `null` for a segment that is only words. */
  readonly count: number | null;
  readonly words: string;
}

/** The line's segments: "2 blocking", "5 need you", "2 with Johnnie". Nothing needing you says so. */
export const agendaSegments = (counts: AgendaCounts, ferret: string): readonly AgendaSegment[] => {
  const segments: AgendaSegment[] = [];
  if (counts.blocking > 0) segments.push({ count: counts.blocking, words: 'blocking' });
  if (counts.needYou > 0) segments.push({ count: counts.needYou, words: 'need you' });
  else if (counts.withFerret > 0) segments.push({ count: null, words: 'Nothing needs you' });
  if (counts.withFerret > 0) segments.push({ count: counts.withFerret, words: `with ${ferret}` });
  return segments;
};
