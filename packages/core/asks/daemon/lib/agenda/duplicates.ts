/**
 * DUPLICATE OWNER ASKS (docs/agenda.md § One ask per thing): the same thing asked of the owner twice. One pure read of
 * every open agenda that says which items are provably the same ask — the ones a sweep may close — and which only look
 * alike, which are reported and left alone.
 *
 * Provable, and closed — every rule within ONE lineage (the agendas that share a home), never across two:
 *
 * 1. one card with more than one open owner item (a gate item and a thread, or two threads);
 * 2. one `source` + `sourceRef` open on two agendas;
 * 3. identical titles (letters and digits only, case ignored), both raised by agents, with the same ask and body.
 *
 * Of each group the one KEPT is the OLDEST — the first ask stands, and the later one is the repeat — unless a newer one
 * is on the owner's turn: that one is what the owner sees, so it stays and the oldest of those is kept.
 * Closed only when both were raised by the SAME session: two voices asking alike is reported, not decided.
 * Never closed, however alike: a hands-on card, a gate the owner answered, an item the owner has begun a conversation on
 * (they asked for more, or the ferret was told something that never arrived). Those are reported instead.
 */
import type { AgendaId, AgendaItem } from '../protocol/agenda.ts';
import { handsOnItem } from './home.ts';

/** One open agenda, with the home of the lineage it belongs to. */
export interface DuplicateAgenda {
  readonly sessionId: string;
  /** The root of the agenda's lineage: where the daemon asks the owner for the whole lineage. */
  readonly home: string;
  readonly items: readonly AgendaItem[];
}

/** An item named by where it is open. */
interface DuplicateMember {
  readonly sessionId: string;
  readonly id: AgendaId;
}

type DuplicateKind = 'card' | 'source' | 'title';

/** An item to close, and the one it duplicates. */
interface DuplicateClosure extends DuplicateMember {
  readonly kind: DuplicateKind;
  readonly keep: DuplicateMember;
}

/** Items that look alike but are not provably the same ask: nothing is closed for them. */
interface PossibleDuplicate {
  readonly kind: DuplicateKind;
  readonly members: readonly DuplicateMember[];
  readonly why: string;
}

export interface DuplicateFindings {
  readonly closures: readonly DuplicateClosure[];
  readonly possible: readonly PossibleDuplicate[];
}

interface Entry {
  readonly agenda: DuplicateAgenda;
  readonly item: AgendaItem;
}

const ownerTurn = (item: AgendaItem): boolean => item.waitingOn === undefined && item.parked === undefined;

const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const keyOf = (entry: Entry): string => `${entry.agenda.sessionId}\u0000${entry.item.id}`;

const memberOf = (entry: Entry): DuplicateMember => ({ sessionId: entry.agenda.sessionId, id: entry.item.id });

/** Oldest first: the earlier raise, then the lower id, then the session id, so the order never depends on read order. */
const byOldest = (one: Entry, other: Entry): number =>
  Date.parse(one.item.waitingSince) - Date.parse(other.item.waitingSince) ||
  Number(one.item.id.slice(1)) - Number(other.item.id.slice(1)) ||
  (one.agenda.sessionId < other.agenda.sessionId ? -1 : one.agenda.sessionId > other.agenda.sessionId ? 1 : 0);

/** The one of a group to keep: the oldest, unless a newer one is on the owner's turn (then the oldest of those). */
const keeperOf = (group: readonly Entry[]): Entry => {
  const ranked = [...group].sort(byOldest);
  return ranked.find(entry => ownerTurn(entry.item)) ?? ranked[0]!;
};

/** Whether two items ask the same thing in the same words: the ask and every tab — the main tab too — as raised. */
const wordsOf = (item: AgendaItem): string =>
  JSON.stringify([
    item.ask ?? null,
    item.whereWeAre ?? null,
    item.questionAnswer ?? null,
    item.decided ?? null,
    item.stillOpen ?? null,
    item.body ?? null,
    item.tabs ?? null,
  ]);
const sameWords = (one: AgendaItem, other: AgendaItem): boolean => wordsOf(one) === wordsOf(other);

/** Why an item may not be closed, or `undefined` when it may. */
const protectedBecause = (entry: Entry): string | undefined => {
  const { item } = entry;
  if (handsOnItem(item)) return 'a hands-on card';
  // An agenda that carries a card's ask is the card's one ask: closing it as a duplicate would drop the ask.
  if ((item.cardAsks ?? []).length > 0) return "it carries a card's ask";
  if (item.history !== undefined || item.infoRequests !== undefined || item.undelivered !== undefined)
    return 'the owner has begun talking about it';
  return undefined;
};

const closable = (entry: Entry): boolean => entry.item.notice !== true;

/** What to close and what to report, across every open agenda. Pure and total. */
export const findDuplicates = (agendas: readonly DuplicateAgenda[]): DuplicateFindings => {
  const closures: DuplicateClosure[] = [];
  const possible: PossibleDuplicate[] = [];
  const closed = new Set<string>();
  const open = (): Entry[] =>
    agendas.flatMap(agenda =>
      agenda.items.map(item => ({ agenda, item })).filter(entry => closable(entry) && !closed.has(keyOf(entry))),
    );

  const settle = (kind: DuplicateKind, group: readonly Entry[]): void => {
    const keep = keeperOf(group);
    const left: { readonly entry: Entry; readonly why: string }[] = [];
    for (const entry of group) {
      if (entry === keep) continue;
      const why =
        protectedBecause(entry) ??
        (entry.item.raisedBySession === keep.item.raisedBySession ? undefined : 'raised by different sessions') ??
        (kind === 'title' && !sameWords(entry.item, keep.item) ? 'the same title, but a different ask' : undefined);
      if (why === undefined) {
        closed.add(keyOf(entry));
        closures.push({ ...memberOf(entry), kind, keep: memberOf(keep) });
      } else left.push({ entry, why });
    }
    if (left.length > 0) {
      possible.push({
        kind,
        members: [keep, ...left.map(each => each.entry)].map(memberOf),
        why: `not closed: ${left[0]!.why}`,
      });
    }
  };

  const grouped = (entries: readonly Entry[], keyOf: (entry: Entry) => string | undefined): Entry[][] => {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.values()];
  };

  // 1. One card, several owner items: its agents' threads (a hands-on card is no thread of the card).
  const cardOf = (entry: Entry): string | undefined => {
    const { item } = entry;
    if (item.task === undefined || item.task === null || handsOnItem(item)) return undefined;
    if (item.raisedBy !== 'agent') return undefined;
    return `${entry.agenda.home}\n${item.task.machineId ?? ''}/${item.task.id}`;
  };
  for (const group of grouped(open(), cardOf)) if (group.length > 1) settle('card', group);

  // 2. One source reference open on two agendas.
  const sourceOf = (entry: Entry): string | undefined =>
    entry.item.sourceRef === null || handsOnItem(entry.item)
      ? undefined
      : `${entry.agenda.home}\n${entry.item.source}\n${entry.item.sourceRef}`;
  for (const group of grouped(open(), sourceOf)) {
    if (new Set(group.map(entry => entry.agenda.sessionId)).size > 1) settle('source', group);
  }

  // 3. The same words, raised twice by agents in one lineage.
  const titleOf = (entry: Entry): string | undefined => {
    const title = normalized(entry.item.subject);
    return title === '' || handsOnItem(entry.item) ? undefined : `${entry.agenda.home}\n${title}`;
  };
  for (const group of grouped(open(), titleOf)) {
    if (group.length < 2) continue;
    const agents = group.filter(entry => entry.item.raisedBy === 'agent');
    if (agents.length === group.length) settle('title', group);
    else
      possible.push({
        kind: 'title',
        members: group.map(memberOf),
        why: 'the same title, but not all raised by agents',
      });
  }

  return { closures, possible };
};
