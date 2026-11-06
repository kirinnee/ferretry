/**
 * THE MERGE GATE (docs/design/clash-queue.md § The merge gate): whether a PR may merge as far as the board's queue
 * goes. Decided from ONE read of the board, so a card that moves while it is asked cannot slip between pages.
 *
 * A PR ships a MERGE UNIT: every card not dropped that links it, and every card not dropped that rides one of those
 * cards' shipping units (`ShippingUnits`: a helper of a linking card, finished or not, and an umbrella lead above one).
 *
 * The PR waits on two things, both read from the board as it is NOW:
 *
 * - **The clash order, derived live.** Shipping units change after a claim lands (a card links its PR, a helper
 *   finishes, a card is reparented), so the depends-on the daemon wrote at claim time can be stale. The gate does not
 *   trust it: for every other unit whose claims clash with this unit's, the unit that claimed FIRST merges first —
 *   comparing the earliest claim of the cards each unit has on its own (a card riding both, an umbrella lead, is left
 *   out of the pair). One rule decides both sides of every pair, so two PRs never wait on each other through it. A unit
 *   whose shipping card has shipped or was dropped holds nothing, nor does an umbrella lead's own unit once it has
 *   child units (it never ships by itself; its claims count through them). A lead waives one wait with
 *   `fy task undepend`.
 * - **The dependencies a person added** (not the daemon's own claim-time ones), on a card outside the unit that is not
 *   done. A card inside the unit, or one linking the same PR, ships in the same merge and never holds it.
 */
import {
  type BoardMergeGateResponse,
  type BoardMergeWait,
  type BoardTask,
  type BoardTaskEvent,
  isBlockerDone,
  type PrLink,
  prUrlParts,
  type TaskRef,
} from '@ferretry/protocol';
import { claimsClash, normaliseClaim } from './clash-queue.ts';
import { type BoardIndex, blockedBy, cardCategory, type LaneSets } from './graph.ts';
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

/** One claim with the moment it was made: its last `file-claimed`, else the card's creation (a card born with it). */
interface Claim {
  readonly card: BoardTask;
  readonly path: string;
  readonly atMs: number;
}

const claimsOf = (card: BoardTask): readonly Claim[] =>
  card.files.map(path => {
    const wanted = normaliseClaim(path);
    const event = card.history.findLast(
      (entry): entry is Extract<BoardTaskEvent, { type: 'file-claimed' }> =>
        entry.type === 'file-claimed' && normaliseClaim(entry.path) === wanted,
    );
    return { card, path, atMs: Date.parse(event?.at ?? card.createdAt) };
  });

const earliest = (claims: readonly Claim[]): number => Math.min(...claims.map(claim => claim.atMs));

/**
 * Whether the dependency was written by the daemon when a claim landed (its latest `depended` event is the daemon's):
 * the live clash order stands in for it, so the gate never weighs a stale one.
 */
const isClaimTimeWait = (card: BoardTask, on: TaskRef, index: BoardIndex): boolean => {
  const event = card.history.findLast(
    (entry): entry is Extract<BoardTaskEvent, { type: 'depended' }> =>
      entry.type === 'depended' && sameRef(index, entry.task, on),
  );
  return event?.actor.kind === 'daemon' && event.override === undefined;
};

/** Whether a card of the unit waived a wait on this card: it removed that dependency on purpose. */
const waived = (unit: readonly BoardTask[], target: string, index: BoardIndex): boolean =>
  unit.some(card =>
    card.history.some(event => event.type === 'undepended' && event.task.id === target && index.isLocal(event.task)),
  );

/**
 * The live clash waits of a unit (see the module doc): one per other unit that clashes with it and claimed first,
 * named on the unit card whose claim clashes and on the other unit's shipping card.
 */
const clashWaits = (
  unit: readonly BoardTask[],
  keys: ReadonlySet<string>,
  live: readonly BoardTask[],
  units: ShippingUnits,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets },
): readonly BoardMergeWait[] => {
  const inUnit = new Set(unit.map(card => card.id));
  const others = new Map<string, BoardTask[]>();
  for (const card of live) {
    if (inUnit.has(card.id) || card.files.length === 0) continue;
    for (const key of units.rides(card)) {
      if (!keys.has(key)) others.set(key, [...(others.get(key) ?? []), card]);
    }
  }
  const myKey = [...keys].sort()[0] ?? '';
  const waits: BoardMergeWait[] = [];
  for (const [key, cards] of others) {
    const target = board.index.get({ id: key as BoardTask['id'] });
    if (target === undefined || target.dropped !== null) continue;
    // An umbrella lead with child units never ships by itself: its claims already count through those units.
    if (units.rides(target).size > 1) continue;
    const category = cardCategory(target, board.laneSets);
    if (category !== undefined && isBlockerDone(category, 'shipped')) continue;
    // A card riding both units (an umbrella lead) belongs to neither side of this pair.
    const mine = unit.filter(card => !units.rides(card).has(key)).flatMap(claimsOf);
    const theirs = cards.flatMap(claimsOf);
    const clash = mine.find(claim =>
      theirs.some(other => other.card.projectId === claim.card.projectId && claimsClash(claim.path, other.path)),
    );
    if (clash === undefined) continue;
    const [myFirst, theirFirst] = [earliest(mine), earliest(theirs)];
    const theyWereFirst = theirFirst < myFirst || (theirFirst === myFirst && key < myKey);
    if (!theyWereFirst || waived(unit, key, board.index)) continue;
    waits.push({ task: { id: clash.card.id }, on: { id: target.id }, until: 'shipped' });
  }
  return waits;
};

/**
 * The gate's answer for a PR URL, from one board read: its merge unit, what the unit waits on (see the module doc), and
 * the cards that could not be read (any of them might link the PR). `null` when the URL is not a GitHub PR.
 */
export const mergeGateOf = (
  url: string,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets; readonly unreadable: readonly string[] },
): BoardMergeGateResponse | null => {
  const pr = prUrlParts(url);
  if (pr === null) return null;
  const linksPr = (card: BoardTask): boolean => card.links.prs.some(samePr(pr));
  const live = board.index.cards.filter(card => card.dropped === null);
  const linking = live.filter(linksPr);
  const units = new ShippingUnits(board.index);
  // Unit KEYS, not card ids: a linking card may share its unit (and so its key) with a card that links another PR too.
  const ids = new Set(linking.map(card => card.id));
  const keys = new Set(linking.map(card => units.key(card)));
  const unit =
    linking.length === 0
      ? []
      : live.filter(card => ids.has(card.id) || [...units.rides(card)].some(key => keys.has(key)));
  const inUnit = new Set(unit.map(card => card.id));
  const added = unit.flatMap(card =>
    blockedBy(card, board.index, board.laneSets).flatMap((on): BoardMergeWait[] => {
      // `get` answers only for a card on this machine, so a remote card that shares an id is never "inside".
      const blocker = board.index.get(on);
      if (blocker !== undefined && (inUnit.has(blocker.id) || linksPr(blocker))) return [];
      if (isClaimTimeWait(card, on, board.index)) return [];
      const until = card.dependsOn.find(dependency => sameRef(board.index, dependency.task, on))?.until ?? 'shipped';
      return [{ task: { id: card.id }, on, until }];
    }),
  );
  const clashes = unit.length === 0 ? [] : clashWaits(unit, keys, live, units, board);
  return {
    pr: url,
    unit: unit.map(card => ({ id: card.id })),
    waits: [...added, ...clashes],
    unreadable: [...board.unreadable] as BoardMergeGateResponse['unreadable'],
  };
};
