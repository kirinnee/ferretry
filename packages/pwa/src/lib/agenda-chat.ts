/**
 * THE AGENDA AS THE CHAT SEES IT: which open items belong to it, what order they stand in, and what the one
 * line above the composer counts. Pure: the line, the drawer and the card draw these decisions.
 *
 * Plain notifications (`notice`) are the Inbox's, never the agenda's. An item's turn is `attentionTurn`:
 * the owner's, the ferret's, or done. Items that block now come first, then the rest of the owner's turn
 * (soonest deadline first), then the ferret's — which the drawer dims.
 */

import { type AttentionId, type AttentionItem, attentionTurn } from '@ferretry/protocol';

/** The items of an agenda: open, and not a plain notification. */
export const agendaItems = (items: readonly AttentionItem[]): readonly AttentionItem[] =>
  items.filter(item => item.notice !== true && attentionTurn(item) !== 'done');

const rank = (item: AttentionItem): number =>
  attentionTurn(item) === 'ferret' ? 2 : item.blockingNow === true ? 0 : 1;

const instant = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

const compare = (left: number, right: number): number => (left === right ? 0 : left < right ? -1 : 1);

/** Blocking now → needs you → with the ferret; within a group the nearest deadline, then the longest wait. */
export const sortAgenda = (items: readonly AttentionItem[]): readonly AttentionItem[] =>
  [...items].sort(
    (left, right) =>
      compare(rank(left), rank(right)) ||
      compare(instant(left.neededBy), instant(right.neededBy)) ||
      compare(instant(left.waitingSince), instant(right.waitingSince)) ||
      left.id.localeCompare(right.id),
  );

export interface AgendaCounts {
  /** Items on the owner's turn that block the ferret now. */
  readonly blocking: number;
  /** Items on the owner's turn (blocking ones included). */
  readonly needYou: number;
  /** Items on the ferret's turn. */
  readonly withFerret: number;
}

export const agendaCounts = (items: readonly AttentionItem[]): AgendaCounts => {
  const turns = items.map(item => ({ turn: attentionTurn(item), blocking: item.blockingNow === true }));
  const owner = turns.filter(entry => entry.turn === 'owner');
  return {
    blocking: owner.filter(entry => entry.blocking).length,
    needYou: owner.length,
    withFerret: turns.filter(entry => entry.turn === 'ferret').length,
  };
};

/** The words of the line, in segments: "2 blocking", "5 need you", "2 with Johnnie". Nothing needing you says so. */
export const agendaSegments = (counts: AgendaCounts, ferret: string): readonly string[] => {
  const segments: string[] = [];
  if (counts.blocking > 0) segments.push(`${counts.blocking} blocking`);
  if (counts.needYou > 0) segments.push(`${counts.needYou} need you`);
  else if (counts.withFerret > 0) segments.push('Nothing needs you');
  if (counts.withFerret > 0) segments.push(`${counts.withFerret} with ${ferret}`);
  return segments;
};

/** The owner-turn item after `from` in `order` (wrapping once), or `null` when none else needs the owner. */
export const nextOwnerItem = (order: readonly AttentionItem[], from: AttentionId): AttentionItem | null => {
  const at = order.findIndex(item => item.id === from);
  const after = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))];
  return after.find(item => item.id !== from && attentionTurn(item) === 'owner') ?? null;
};
