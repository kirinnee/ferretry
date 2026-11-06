/**
 * THE MERGE GATE (docs/design/clash-queue.md § The merge gate): whether a PR may merge as far as the board's queue
 * goes. Decided from ONE read of the board, so a card that moves while it is asked cannot slip between pages.
 *
 * A PR ships a MERGE UNIT: the open cards linking it, and their open sub-cards that link no PR of their own (a helper's
 * work ships in its lead's PR). The PR waits while any card of the unit waits on a card OUTSIDE it that is not done —
 * a card inside the unit, or one linking the same PR, ships in the same merge and never holds it.
 */
import {
  type BoardMergeGateResponse,
  type BoardMergeWait,
  type BoardTask,
  categoryOf,
  type PrLink,
  prUrlParts,
} from '@ferretry/protocol';
import { type BoardIndex, blockedBy, type LaneSets } from './graph.ts';

/** Whether a PR link names this PR: the same repository (any case) and number. */
const samePr =
  (pr: { readonly repo: string; readonly number: number }) =>
  (link: Pick<PrLink, 'repo' | 'number'>): boolean =>
    link.repo.toLowerCase() === pr.repo.toLowerCase() && link.number === pr.number;

/** Not dropped and not in a closed lane. A card whose board's lanes are unknown counts as open: it may still hold. */
const isOpen = (card: BoardTask, laneSets: LaneSets): boolean => {
  if (card.dropped !== null) return false;
  const laneSet = laneSets.get(card.projectId);
  if (laneSet === undefined) return true;
  const category = categoryOf(laneSet, card.laneId);
  return !category.ok || category.value !== 'closed';
};

/** The cards that ship in this PR (see the module doc), in store order of discovery. */
const mergeUnit = (
  linksPr: (card: BoardTask) => boolean,
  index: BoardIndex,
  laneSets: LaneSets,
): readonly BoardTask[] => {
  const unit = new Map<string, BoardTask>();
  const pending = index.cards.filter(card => linksPr(card) && isOpen(card, laneSets));
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (unit.has(next.id)) continue;
    unit.set(next.id, next);
    for (const child of index.children(next.id)) {
      if (child.links.prs.length === 0 && isOpen(child, laneSets)) pending.push(child);
    }
  }
  return [...unit.values()];
};

/**
 * The gate's answer for a PR URL, from one board read: its merge unit, the unit's waits on cards outside it, and the
 * cards that could not be read (any of them might link the PR). `null` when the URL is not a GitHub PR.
 */
export const mergeGateOf = (
  url: string,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets; readonly unreadable: readonly string[] },
): BoardMergeGateResponse | null => {
  const pr = prUrlParts(url);
  if (pr === null) return null;
  const linksPr = (card: BoardTask): boolean => card.links.prs.some(samePr(pr));
  const unit = mergeUnit(linksPr, board.index, board.laneSets);
  const inUnit = new Set(unit.map(card => card.id));
  const waits = unit.flatMap(card =>
    blockedBy(card, board.index, board.laneSets).flatMap((on): BoardMergeWait[] => {
      const blocker = board.index.get(on);
      if (inUnit.has(on.id) || (blocker !== undefined && linksPr(blocker))) return [];
      const until = card.dependsOn.find(dependency => dependency.task.id === on.id)?.until ?? 'shipped';
      return [{ task: { id: card.id }, on, until }];
    }),
  );
  return {
    pr: url,
    unit: unit.map(card => ({ id: card.id })),
    waits,
    unreadable: [...board.unreadable] as BoardMergeGateResponse['unreadable'],
  };
};
