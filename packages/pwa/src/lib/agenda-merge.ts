/**
 * MERGING TWO AGENDAS, AND WHERE AN ITEM CAME FROM (docs/agenda.md § The item view, "Merge and split"). Pure decisions:
 * who may be offered "Merge with…", which open agendas it lists, the words of the confirm step that says what will
 * happen, and the reference lines an item shows for a merge or a split. The daemon decides every refusal; this only
 * keeps the button from offering what it would refuse.
 */

import { type AgendaId, type AgendaItem, agendaTitle } from '@ferretry/protocol';
import { isGateItem } from './gate-items.ts';

/** Whether the item is closed: a closed item is never merged into or from. */
const closed = (item: AgendaItem): boolean => (item as { readonly resolvedAt?: string }).resolvedAt !== undefined;

/**
 * Whether the item is a plain conversation, the only kind a merge joins. Gates, notices and every card the daemon
 * acts on (an input request, a plan, a configuration change, a phone approval…) are refused by the daemon, so they are
 * never offered here. Mirrors the daemon's `plainThread`.
 */
export const isPlainThread = (item: AgendaItem): boolean =>
  !isGateItem(item) &&
  item.notice !== true &&
  item.gateAttached === undefined &&
  item.confirms === undefined &&
  item.kind !== 'input' &&
  item.input === undefined &&
  item.taskPlan === undefined &&
  item.copyPlan === undefined &&
  item.signInRuleSuggestion === undefined &&
  item.twoFactorSeed === undefined &&
  item.phoneApproval === undefined;

/**
 * Whether "Merge with…" is offered on this item: the host can send it (the owner's own app, a board with this item
 * on it), and the item is an open plain conversation.
 */
export const mergeOffered = (input: { readonly hostMerges: boolean; readonly item: AgendaItem }): boolean =>
  input.hostMerges && !closed(input.item) && isPlainThread(input.item);

const numberOf = (id: AgendaId): number => Number(id.slice(1));

/** The open agendas this one can be merged with: every other open plain conversation on the board, oldest first. */
export const mergeCandidates = (item: AgendaItem, board: readonly AgendaItem[]): readonly AgendaItem[] =>
  board
    .filter(other => other.id !== item.id && !closed(other) && isPlainThread(other))
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));

/** Which agenda survives and which closes. */
export interface MergeChoice {
  readonly survivor: AgendaItem;
  readonly absorbed: AgendaItem;
}

/** The choice that keeps the item being viewed, or, flipped, the one picked from the list. */
export const mergeChoice = (viewed: AgendaItem, picked: AgendaItem, keepPicked: boolean): MergeChoice =>
  keepPicked ? { survivor: picked, absorbed: viewed } : { survivor: viewed, absorbed: picked };

/** The longest title the merge words quote before they cut it at a word with "…". */
const QUOTED_TITLE = 60;

const clipped = (title: string): string => {
  if (title.length <= QUOTED_TITLE) return title;
  const cut = title.slice(0, QUOTED_TITLE);
  const word = cut.lastIndexOf(' ');
  return `${(word > QUOTED_TITLE / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
};

/** What the picker asks. The open agenda is not named: its title is the head of the view the picker sits under. */
export const PICKER_LEAD = 'Merge this item with which open agenda?';

/** The checkbox that makes the other agenda the survivor. Short: the picker already showed its title. */
export const flipLabel = (picked: AgendaItem): string => `Keep !${picked.id} instead`;

/** The words of the confirm step: what is asked and what happens, then the button. No title is repeated. */
export interface MergeWords {
  readonly question: string;
  readonly outcome: string;
  readonly button: string;
}

/**
 * What the confirm step says, so "Merge" is never pressed without knowing what it does. The other agenda is named by its
 * id alone (the picker just showed its title) and the one open is "this item".
 */
export const mergeWords = (choice: MergeChoice, viewed: AgendaId): MergeWords => {
  const name = (item: AgendaItem): string => (item.id === viewed ? 'this item' : `!${item.id}`);
  const absorbed = name(choice.absorbed);
  const survivor = name(choice.survivor);
  const closes = `${absorbed} closes; ${survivor} keeps its ask. Both conversations and all cards are kept.`;
  return {
    question: `Merge ${absorbed} into ${survivor}?`,
    outcome: closes.charAt(0).toUpperCase() + closes.slice(1),
    button: 'Merge',
  };
};

/** A candidate in the picker: its reference and its title, so the owner picks by what it says. */
export const candidateLine = (item: AgendaItem): string => `!${item.id} ${agendaTitle(item)}`;

/** One reference line an item shows for where it came from or went. `text` is written for the one reference renderer. */
export interface LineageLine {
  readonly key: 'merged-into' | 'merged-from' | 'split-from' | 'split-into';
  readonly text: string;
}

/** Where the board holds an agenda, its title: the lineage lines say what a reference is, not only its number. */
export type LineageTitles = Readonly<Partial<Record<AgendaId, string>>>;

/** The titles of the agendas an item's lineage names, from the agendas on the board; the ones it does not hold are left out. */
export const lineageTitles = (
  item: Pick<AgendaItem, 'mergedInto' | 'mergedFrom' | 'splitFrom' | 'splitInto'>,
  board: readonly Pick<AgendaItem, 'id' | 'title' | 'subject'>[],
): LineageTitles => {
  const named = new Set<AgendaId>([
    ...(item.mergedInto === undefined ? [] : [item.mergedInto]),
    ...(item.mergedFrom ?? []),
    ...(item.splitFrom === undefined ? [] : [item.splitFrom]),
    ...(item.splitInto ?? []),
  ]);
  return Object.fromEntries(board.filter(other => named.has(other.id)).map(other => [other.id, agendaTitle(other)]));
};

/** `!A5 (the title)`, or `!A5` where the board does not hold it. */
const named = (id: AgendaId, titles: LineageTitles): string => {
  const title = titles[id];
  return title === undefined ? `!${id}` : `!${id} (${clipped(title)})`;
};

const list = (ids: readonly AgendaId[], titles: LineageTitles): string => ids.map(id => named(id, titles)).join(', ');

/**
 * The lines about an item's lineage, in the order they matter: a merged item says where it went first, and the
 * survivor, the original and the split-off item say what joined or left them. Nothing when the item has no lineage.
 * Each target carries its title when `titles` holds it.
 */
export const lineageLines = (
  item: Pick<AgendaItem, 'mergedInto' | 'mergedFrom' | 'splitFrom' | 'splitInto'>,
  titles: LineageTitles = {},
): readonly LineageLine[] => [
  ...(item.mergedInto === undefined
    ? []
    : [{ key: 'merged-into', text: `Merged into ${named(item.mergedInto, titles)}` } as const]),
  ...(item.mergedFrom === undefined
    ? []
    : [{ key: 'merged-from', text: `Merged in from ${list(item.mergedFrom, titles)}` } as const]),
  ...(item.splitFrom === undefined
    ? []
    : [{ key: 'split-from', text: `Split from ${named(item.splitFrom, titles)}` } as const]),
  ...(item.splitInto === undefined
    ? []
    : [{ key: 'split-into', text: `Split into ${list(item.splitInto, titles)}` } as const]),
];
