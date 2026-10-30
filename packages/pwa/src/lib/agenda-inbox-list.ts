/**
 * THE INBOX'S LIST, as pure decisions: how the open items are grouped by the FERRET that holds them, which
 * of three sections each group sits in, what a row is headed by, which rows a machine filter, Find or the
 * Warden chip keep, and which item is selected after the selected one leaves the list.
 *
 * A GROUP IS A FERRET (a conversation on a machine), said once on its header. A ROW IS HEADED BY ITS ITEM,
 * never by its conversation: ten items from one ferret used to read as ten rows all titled with the
 * project's name.
 *
 * THREE SECTIONS, in the order the owner should look: "Stopped on you" (the ferret is idle until the owner
 * answers — the daemon's `stopped`), "Needs you" (items on the owner's turn), then "With ferrets" (items on
 * the ferret's turn, nothing for the owner to do). A ferret sits in ONE of the first two, never both; it may
 * ALSO sit in "With ferrets" for the items it holds.
 */

import { type AgendaItem, agendaTitle, type SessionView } from '@ferretry/protocol';
import { sessionsBarNames } from '../shell/sessions-bar-model.ts';
import { sortAgenda } from './agenda-status.ts';
import { sessionAgendaSummary } from './agenda-wire.ts';
import type { InboxCard, InboxResolved } from './agenda-inbox.ts';
import { visibleWhy } from './agenda-inbox.ts';
import type { DaemonId } from './daemon-connection.ts';

/** One ferret's open items on one machine, under one header. */
export interface FerretGroup {
  /** `(daemonId, sessionId)`, collision-safe. */
  readonly key: string;
  readonly daemonId: DaemonId;
  readonly view: SessionView;
  /** The ferret's name: what a group is scanned by. */
  readonly ferret: string;
  /** What the conversation is working on, when that is not just the ferret's name. */
  readonly task: string | null;
  readonly machineName: string;
  /** The ferret is idle until the owner answers. */
  readonly stopped: boolean;
  /** Agenda items (not plain notifications), in the agenda's order. */
  readonly items: readonly InboxCard[];
  /** Plain notifications: a line and a time, nothing to answer. Newest first. */
  readonly notices: readonly InboxCard[];
}

const groupKey = (daemonId: DaemonId, sessionId: string): string => JSON.stringify([daemonId, sessionId]);

const isNoticeCard = (card: InboxCard): boolean => card.item.notice === true;

/** The cards grouped by ferret. Each group's items are in the agenda's order; its notices keep their (newest-first) order. */
const buildGroups = (cards: readonly InboxCard[]): readonly FerretGroup[] => {
  const grouped = new Map<string, InboxCard[]>();
  for (const card of cards) {
    const key = groupKey(card.daemonId, card.view.config.id);
    const members = grouped.get(key);
    if (members === undefined) grouped.set(key, [card]);
    else members.push(card);
  }
  const groups = [...grouped.entries()].map(([key, members]): FerretGroup => {
    const head = members[0] as InboxCard;
    const names = sessionsBarNames(head.view);
    const ordered = sortAgenda(members.filter(card => !isNoticeCard(card)).map(card => card.item));
    const byItem = new Map(members.map(card => [card.item, card] as const));
    return {
      key,
      daemonId: head.daemonId,
      view: head.view,
      ferret: names.ferret ?? names.title,
      task: names.ferret === null ? null : names.title,
      machineName: head.machineName,
      stopped: sessionAgendaSummary(head.view.state)?.stopped === true,
      items: ordered.flatMap(item => byItem.get(item) ?? []),
      notices: members.filter(isNoticeCard),
    };
  });
  // The group whose first row is the most urgent leads: blocking, then the nearest deadline, then longest waiting.
  const lead = (group: FerretGroup): AgendaItem | undefined => (group.items[0] ?? group.notices[0])?.item;
  const rank = new Map<AgendaItem, FerretGroup>();
  for (const group of groups) {
    const item = lead(group);
    if (item !== undefined) rank.set(item, group);
  }
  return sortAgenda([...rank.keys()]).flatMap(item => rank.get(item) ?? []);
};

/** The inbox's three sections. */
export interface InboxSections {
  readonly stopped: readonly FerretGroup[];
  readonly needsYou: readonly FerretGroup[];
  readonly withFerrets: readonly FerretGroup[];
}

/**
 * `ownerCards` (on the owner's turn) and `ferretCards` (on the ferret's turn) sorted into the three sections.
 * A ferret that is stopped heads the first; one with anything else on the owner's turn is in the second.
 */
export const inboxSections = (ownerCards: readonly InboxCard[], ferretCards: readonly InboxCard[]): InboxSections => {
  const owners = buildGroups(ownerCards);
  return {
    stopped: owners.filter(group => group.stopped),
    needsYou: owners.filter(group => !group.stopped),
    withFerrets: buildGroups(ferretCards).map(group => ({ ...group, stopped: false })),
  };
};

/** Every card of a set of groups, in the order the page draws them: the keyboard's order. */
export const groupCards = (groups: readonly FerretGroup[]): readonly InboxCard[] =>
  groups.flatMap(group => [...group.items, ...group.notices]);

/** The row's headline: the item's own title, else the start of its ask. Never the conversation's name. */
export const inboxRowTitle = (item: InboxCard['item']): string => agendaTitle(item);

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

/** Where a filtered Inbox keeps to: only what the machine's Warden raised. */
export type InboxSource = 'warden';

/** What the header narrows the list to: one machine (or all), the words typed into Find, and where it came from. */
export interface InboxListFilter {
  readonly machine: DaemonId | null;
  readonly query: string;
  /** `/inbox?from=warden`: only what the Warden raised. */
  readonly from?: InboxSource | null;
}

export const NO_FILTER: InboxListFilter = { machine: null, query: '' };

/** The `?from=` value an Inbox link names, or `null` for none or one this app does not know. */
export const inboxSourceFromSearch = (search: string): InboxSource | null =>
  new URLSearchParams(search).get('from') === 'warden' ? 'warden' : null;

/**
 * Whether the Warden raised this: the daemon's own hand AND a `warden:` source (`warden:ask:<kind>`,
 * `warden:ask:fleet:<kind>:<key>`). Both, so a ferret that merely names a Warden in its text is not one.
 */
export const isFromWarden = (item: Pick<AgendaItem, 'raisedBy' | 'sourceRef'>): boolean =>
  item.raisedBy === 'daemon' && (item.sourceRef ?? '').startsWith('warden:');

const fromKept = (filter: InboxListFilter, item: Pick<AgendaItem, 'raisedBy' | 'sourceRef'>): boolean =>
  filter.from !== 'warden' || isFromWarden(item);

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
  const names = sessionsBarNames(view);
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
      fromKept(filter, card.item) &&
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
      fromKept(filter, row.record) &&
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
