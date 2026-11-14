/**
 * THE CARD'S AGENDA ASKS, joined to the agenda (v4 parity: the card sheet's "Agenda asks" section).
 *
 * A card never asks (#1552): its asks live in the Agenda. The card says WHICH asks are open (`openAsks`) and the
 * ferret's agenda says what each one is; an answered or dismissed ask is kept only in that agenda's ledger. This file
 * is the pure join of the two, the reading is `board-client.ts`'s (`agenda`) and the drawing is the detail's.
 */

import type { AskListSnapshot } from '@ferretry/core-asks/contract';
import type { CardView } from '../../contract/index.ts';

type OpenItem = AskListSnapshot['items'][number];
type ResolvedItem = AskListSnapshot['resolved'][number];

/** One ferret's agenda, as read: `null` until it has been (or when the daemon would not say). */
export interface SessionAgenda {
  readonly sessionId: string;
  readonly snapshot: AskListSnapshot | null;
}

interface OpenAskRow {
  readonly ferret: string;
  readonly id: string;
  /** `null` while the ferret's agenda is still being read, or when it no longer lists the ask. */
  readonly item: OpenItem | null;
  /** The ask stops the ferret until the owner answers. */
  readonly blocking: boolean;
}

/** An answered or dismissed ask, with the ferret whose ledger keeps it: the agenda item a click opens is its. */
interface ResolvedAskRow {
  readonly sessionId: string;
  readonly item: ResolvedItem;
}

export interface CardAsks {
  readonly open: readonly OpenAskRow[];
  /** Asks about this card that are answered or dismissed, newest first. */
  readonly resolved: readonly ResolvedAskRow[];
  /** The agendas are still being read: an empty list is not yet "no asks". */
  readonly reading: boolean;
}

/** An agenda item's one line: its own title when it has one, else its subject. */
export const askHeading = (item: { readonly subject: string; readonly title?: string | undefined }): string =>
  (item.title ?? '').trim() === '' ? item.subject.trim() : (item.title as string).trim();

/**
 * The card's open asks (from its own `openAsks`, so none is missed) and its resolved ones (the agenda's ledger, the
 * only place an answered ask is kept), blocking first.
 */
export const collectAsks = (card: CardView, agendas: readonly SessionAgenda[]): CardAsks => {
  const itemOf = (ferret: string, id: string): OpenItem | null =>
    agendas.find(entry => entry.sessionId === ferret)?.snapshot?.items.find(item => item.id === id) ?? null;
  const resolved = agendas
    .flatMap(entry => (entry.snapshot?.resolved ?? []).map(item => ({ sessionId: entry.sessionId, item })))
    .filter(({ item }) => item.task?.id === card.id)
    .sort((a, b) => b.item.resolvedAt.localeCompare(a.item.resolvedAt));
  const open = card.openAsks.map(ref => {
    const item = itemOf(ref.ferret, ref.id);
    return { ferret: ref.ferret, id: ref.id, item, blocking: item?.blockingNow === true };
  });
  return {
    open: [...open].sort((a, b) => Number(b.blocking) - Number(a.blocking)),
    resolved,
    reading: agendas.some(entry => entry.snapshot === null),
  };
};

/** The ferrets whose agendas can hold this card's asks: the ones that raised an open ask, the owner, the assignee. */
export const askSessions = (card: Pick<CardView, 'openAsks' | 'owner' | 'assignee'>): readonly string[] => [
  ...new Set([...card.openAsks.map(ask => ask.ferret), card.owner, ...(card.assignee === null ? [] : [card.assignee])]),
];
