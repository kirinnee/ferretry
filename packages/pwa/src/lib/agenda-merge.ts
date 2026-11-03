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
 * Whether "Merge with…" is offered on this item: the machine says it merges (`agenda.conversation.1`), the host can
 * send it (the owner's own app, a board with this item on it), and the item is an open plain conversation. A machine
 * not yet read offers nothing.
 */
export const mergeOffered = (input: {
  readonly machineMerges: boolean | undefined;
  readonly hostMerges: boolean;
  readonly item: AgendaItem;
}): boolean => input.machineMerges === true && input.hostMerges && !closed(input.item) && isPlainThread(input.item);

const numberOf = (id: AgendaId): number => Number(id.slice(1));

/** The open agendas this one can be merged with: every other open plain conversation on the board, oldest first. */
export const mergeCandidates = (item: AgendaItem, board: readonly AgendaItem[]): readonly AgendaItem[] =>
  board
    .filter(other => other.id !== item.id && !closed(other) && isPlainThread(other))
    .sort((a, b) => numberOf(a.id) - numberOf(b.id));

/** Which agenda survives and which closes. */
export interface MergeChoice {
  readonly survivor: AgendaId;
  readonly absorbed: AgendaId;
}

/** The choice that keeps the item being viewed, or, flipped, the one picked from the list. */
export const mergeChoice = (viewed: AgendaId, picked: AgendaId, keepPicked: boolean): MergeChoice =>
  keepPicked ? { survivor: picked, absorbed: viewed } : { survivor: viewed, absorbed: picked };

/** The words of the confirm step: what is asked, what happens, and what is kept. */
export interface MergeWords {
  readonly question: string;
  readonly outcome: string;
  readonly kept: string;
  readonly button: string;
}

/** What the confirm step says, so "Merge" is never pressed without knowing what it does. */
export const mergeWords = (choice: MergeChoice): MergeWords => ({
  question: `Merge !${choice.absorbed} into !${choice.survivor}?`,
  outcome: `!${choice.absorbed} closes as merged into !${choice.survivor}. !${choice.survivor} keeps its ask and its place.`,
  kept: 'Both conversations and all cards are kept, and nothing is cut.',
  button: `Merge into !${choice.survivor}`,
});

/** A candidate in the picker: its reference and its title, so the owner picks by what it says. */
export const candidateLine = (item: AgendaItem): string => `!${item.id} ${agendaTitle(item)}`;

/** One reference line an item shows for where it came from or went. `text` is written for the one reference renderer. */
export interface LineageLine {
  readonly key: 'merged-into' | 'merged-from' | 'split-from' | 'split-into';
  readonly text: string;
}

const list = (ids: readonly AgendaId[]): string => ids.map(id => `!${id}`).join(', ');

/**
 * The lines about an item's lineage, in the order they matter: a merged item says where it went first, and the
 * survivor, the original and the split-off item say what joined or left them. Nothing when the item has no lineage.
 */
export const lineageLines = (
  item: Pick<AgendaItem, 'mergedInto' | 'mergedFrom' | 'splitFrom' | 'splitInto'>,
): readonly LineageLine[] => [
  ...(item.mergedInto === undefined ? [] : [{ key: 'merged-into', text: `Merged into !${item.mergedInto}` } as const]),
  ...(item.mergedFrom === undefined
    ? []
    : [{ key: 'merged-from', text: `Merged in from ${list(item.mergedFrom)}` } as const]),
  ...(item.splitFrom === undefined ? [] : [{ key: 'split-from', text: `Split from !${item.splitFrom}` } as const]),
  ...(item.splitInto === undefined ? [] : [{ key: 'split-into', text: `Split into ${list(item.splitInto)}` } as const]),
];
