/**
 * THE ATTENTION PAGE'S LIST, as pure decisions: how the open items are grouped by the conversation that
 * raised them, what each row is headed by, which ones a machine filter or a search keeps, and which item
 * is selected after the selected one leaves the list.
 *
 * A ROW IS HEADED BY ITS ITEM, never by its conversation. Ten items from one ferret used to read as ten
 * rows all titled with the project's name; the conversation is said once, on its group's header.
 */

import { attentionTitle, type SessionView } from '@ferretry/protocol';
import { sessionsBarNames } from '../shell/sessions-bar-model.ts';
import type { InboxCard, InboxResolved } from './attention-inbox.ts';
import { visibleWhy } from './attention-inbox.ts';
import type { DaemonId } from './daemon-connection.ts';

/** One conversation's open items, under one collapsible header. */
export interface InboxGroup {
  /** `(daemonId, sessionId)`, collision-safe. */
  readonly key: string;
  /** What the conversation is working on, else the ferret's name. */
  readonly title: string;
  /** The ferret, when the title is not already its name. */
  readonly ferret: string | null;
  readonly machineName: string;
  readonly cards: readonly InboxCard[];
}

const inboxGroupKey = (daemonId: DaemonId, sessionId: string): string => JSON.stringify([daemonId, sessionId]);

/** The words a group header says: "diene-migrate · Johnnie". */
const groupNames = (view: SessionView): { readonly title: string; readonly ferret: string | null } =>
  sessionsBarNames(view);

/**
 * The cards grouped by conversation. The groups keep the order of their first card, so the group with
 * the newest item leads; inside a group the cards keep their order (newest first).
 */
export const inboxGroups = (cards: readonly InboxCard[]): readonly InboxGroup[] => {
  const groups = new Map<string, { readonly head: InboxCard; readonly cards: InboxCard[] }>();
  for (const card of cards) {
    const key = inboxGroupKey(card.daemonId, card.view.config.id);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { head: card, cards: [card] });
    else group.cards.push(card);
  }
  return [...groups.entries()].map(([key, { head, cards: members }]) => {
    const names = groupNames(head.view);
    return { key, title: names.title, ferret: names.ferret, machineName: head.machineName, cards: members };
  });
};

/** The row's headline: the item's own title, else the start of its ask. Never the conversation's name. */
export const inboxRowTitle = (item: InboxCard['item']): string => attentionTitle(item);

/**
 * The row's second line: the ask, when the headline is not already all of it; else why it is asked;
 * else nothing.
 */
export const inboxRowAsk = (item: InboxCard['item']): string | null => {
  const ask = item.subject.trim();
  return ask !== inboxRowTitle(item).trim() ? ask : visibleWhy(item);
};

/** A machine the filter can narrow to. */
export interface InboxMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
}

/** Every machine that has an open or resolved row, in the order they first appear. */
export const inboxMachines = (
  cards: readonly Pick<InboxCard, 'daemonId' | 'machineName'>[],
  resolved: readonly Pick<InboxResolved, 'daemonId' | 'machineName'>[] = [],
): readonly InboxMachine[] => {
  const seen = new Map<DaemonId, string>();
  for (const row of [...cards, ...resolved]) if (!seen.has(row.daemonId)) seen.set(row.daemonId, row.machineName);
  return [...seen.entries()].map(([daemonId, name]) => ({ daemonId, name }));
};

/** What the header narrows the list to: one machine (or all), and the words typed into Find. */
export interface InboxListFilter {
  readonly machine: DaemonId | null;
  readonly query: string;
}

export const NO_FILTER: InboxListFilter = { machine: null, query: '' };

const folded = (text: string): string => text.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();

/** Whether every word of `query` appears somewhere in `haystack`, case-insensitively. */
const matchesWords = (haystack: readonly (string | null | undefined)[], query: string): boolean => {
  const words = folded(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const text = folded(haystack.filter((part): part is string => typeof part === 'string').join(' \u0000 '));
  return words.every(word => text.includes(word));
};

/** The facts Find searches on a row: its item's words, its reference, its conversation and its machine. */
const searchable = (
  view: SessionView,
  machineName: string,
  item: Pick<InboxCard['item'], 'id' | 'subject' | 'why'> & { readonly title?: string | undefined },
): readonly (string | undefined)[] => {
  const names = groupNames(view);
  return [
    item.title,
    item.subject,
    item.why,
    item.id,
    `!${item.id}`,
    names.title,
    names.ferret ?? undefined,
    machineName,
  ];
};

/** The open cards the header's machine filter and Find keep, in their order. */
export const filterInboxCards = (cards: readonly InboxCard[], filter: InboxListFilter): readonly InboxCard[] =>
  cards.filter(
    card =>
      (filter.machine === null || card.daemonId === filter.machine) &&
      matchesWords(searchable(card.view, card.machineName, card.item), filter.query),
  );

/** The resolved rows the same filter keeps, in their order. */
export const filterInboxResolved = (
  rows: readonly InboxResolved[],
  filter: InboxListFilter,
): readonly InboxResolved[] =>
  rows.filter(
    row =>
      (filter.machine === null || row.daemonId === filter.machine) &&
      matchesWords(searchable(row.view, row.machineName, row.record), filter.query),
  );

/** The selection past the last item: "You skipped N — review them?" rather than a jump back to the top. */
export const QUEUE_END = '\u0000end';

/**
 * Which item is selected now, given the order the list had when `chosen` was picked and the order it has
 * now. THE QUEUE ONLY MOVES FORWARD: the chosen item while it is still listed; once it leaves (answered,
 * dismissed, filtered out) the item that came after it; and past the last one {@link QUEUE_END} — never
 * back to the first, so answering the sixth after skipping five does not deal the first again. `null`
 * only when nothing is listed.
 */
export const nextSelection = (
  before: readonly string[],
  chosen: string | null,
  now: readonly string[],
): string | null => {
  if (now.length === 0) return null;
  if (chosen === null) return now[0] ?? null;
  if (chosen === QUEUE_END || now.includes(chosen)) return chosen;
  const at = before.indexOf(chosen);
  if (at < 0) return now[0] ?? null;
  const listed = new Set(now);
  return before.slice(at + 1).find(key => listed.has(key)) ?? QUEUE_END;
};

/** Skip: the item after `current`, or {@link QUEUE_END} past the last one. Several in a row is fine. */
export const skipSelection = (order: readonly string[], current: string | null): string => {
  const at = current === null ? -1 : order.indexOf(current);
  return at < 0 ? (order[0] ?? QUEUE_END) : (order[at + 1] ?? QUEUE_END);
};

/** The key one step `by` from `current` in `order`, clamped at both ends; the first when none is current. */
export const stepSelection = (order: readonly string[], current: string | null, by: 1 | -1): string | null => {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[0] ?? null;
  return order[Math.min(order.length - 1, Math.max(0, at + by))] ?? null;
};
