/**
 * THE MERGE GATE (docs/design/clash-queue.md § The merge gate): whether a PR may merge as far as the board's queue
 * goes. Decided from ONE read of the board, so a card that moves while it is asked cannot slip between pages.
 *
 * A PR ships a MERGE UNIT: every card not dropped that links it, and every card not dropped that rides one of those
 * cards' shipping units (`ShippingUnits`: a helper of a linking card, finished or not, and an umbrella lead above one).
 * The PR waits while any card of the unit waits on a card OUTSIDE it that is not done — a card inside the unit, or one
 * linking the same PR, ships in the same merge and never holds it.
 */
import {
  type BoardMergeGateResponse,
  type BoardMergeWait,
  type BoardTask,
  type PrLink,
  prUrlParts,
  type TaskRef,
} from '@ferretry/protocol';
import { type BoardIndex, blockedBy, type LaneSets } from './graph.ts';
import { ShippingUnits } from './shipping-unit.ts';

/** Whether a PR link names this PR: the same repository (any case) and number. */
const samePr =
  (pr: { readonly repo: string; readonly number: number }) =>
  (link: Pick<PrLink, 'repo' | 'number'>): boolean =>
    link.repo.toLowerCase() === pr.repo.toLowerCase() && link.number === pr.number;

/** Whether two refs name the same card: the same id, both on this machine or both on the same other one. */
const sameRef = (index: BoardIndex, left: TaskRef, right: TaskRef): boolean =>
  left.id === right.id &&
  (index.isLocal(left) ? index.isLocal(right) : !index.isLocal(right) && left.machineId === right.machineId);

/** The cards that ship in this PR (see the module doc), in store order. */
const mergeUnit = (linksPr: (card: BoardTask) => boolean, index: BoardIndex): readonly BoardTask[] => {
  const live = index.cards.filter(card => card.dropped === null);
  const linking = new Set(live.filter(linksPr).map(card => card.id));
  if (linking.size === 0) return [];
  const units = new ShippingUnits(index);
  return live.filter(card => linking.has(card.id) || [...units.rides(card)].some(key => linking.has(key)));
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
  const unit = mergeUnit(linksPr, board.index);
  const inUnit = new Set(unit.map(card => card.id));
  const waits = unit.flatMap(card =>
    blockedBy(card, board.index, board.laneSets).flatMap((on): BoardMergeWait[] => {
      // `get` answers only for a card on this machine, so a remote card that shares an id is never "inside".
      const blocker = board.index.get(on);
      if (blocker !== undefined && (inUnit.has(blocker.id) || linksPr(blocker))) return [];
      const until = card.dependsOn.find(dependency => sameRef(board.index, dependency.task, on))?.until ?? 'shipped';
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
