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
 *   trust it: for every other unit whose claims clash with this unit's, the unit that claimed FIRST merges first. Each
 *   unit has ONE rank: the earliest claim of any card riding it (an umbrella lead's counts for every unit under it),
 *   then the earliest claim of the cards riding only it, then its key. A rank never depends on the pair being
 *   compared, so the order is total and no set of PRs ever waits on each other in a circle through it. A unit
 *   whose shipping card has shipped or was dropped holds nothing, nor does an umbrella lead's own unit while one of
 *   its child units can still hold (it never ships by itself; its claims count through that unit). A lead waives one wait with
 *   `fy card undepend`.
 * - **The dependencies a person added** (not the daemon's own claim-time ones), on a card outside the unit that is not
 *   done. A card inside the unit, or one linking the same PR, ships in the same merge and never holds it.
 */
import {
  type BoardMergeGateResponse,
  type BoardMergeWait,
  type Card,
  type CardEvent,
  isBlockerDone,
  type PrLink,
  prUrlParts,
  type CardRef,
} from '../../../contract/index.ts';
import { claimsClash } from './clash-queue.ts';
import { type BoardIndex, blockedBy, cardCategory, type LaneSets } from './graph.ts';
import { ShippingUnits } from './shipping-unit.ts';

/** Whether a PR link names this PR: the same repository (any case) and number. */
const samePr =
  (pr: { readonly repo: string; readonly number: number }) =>
  (link: Pick<PrLink, 'repo' | 'number'>): boolean =>
    link.repo.toLowerCase() === pr.repo.toLowerCase() && link.number === pr.number;

/** Whether two refs name the same card: the same id, both on this machine or both on the same other one. */
const sameRef = (index: BoardIndex, left: CardRef, right: CardRef): boolean =>
  left.id === right.id &&
  (index.isLocal(left) ? index.isLocal(right) : !index.isLocal(right) && left.machineId === right.machineId);

/** One claim with the moment it was made: its last `file-claimed`, else the card's creation (a card born with it). */
interface Claim {
  readonly card: Card;
  readonly path: string;
  readonly atMs: number;
}

/** Each held spelling keeps its own moment: claiming `./x.ts` beside `x.ts` later never makes `x.ts` younger. */
const claimsOf = (card: Card): readonly Claim[] =>
  card.files.map(path => {
    const event = card.history.findLast(
      (entry): entry is Extract<CardEvent, { type: 'file-claimed' }> =>
        entry.type === 'file-claimed' && entry.path === path,
    );
    return { card, path, atMs: Date.parse(event?.at ?? card.createdAt) };
  });

const earliest = (claims: readonly Claim[]): number => Math.min(...claims.map(claim => claim.atMs));

/** A unit's place in the queue: earliest claim of any rider, earliest of its own riders, then its key. */
type Rank = readonly [number, number, string];

const compareRanks = (left: Rank, right: Rank): number =>
  left[0] - right[0] || left[1] - right[1] || (left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0);

/**
 * Whether the dependency was written by the daemon when a claim landed (its latest `depended` event is the daemon's):
 * the live clash order stands in for it, so the gate never weighs a stale one.
 */
const isClaimTimeWait = (card: Card, on: CardRef, index: BoardIndex): boolean => {
  const event = card.history.findLast(
    (entry): entry is Extract<CardEvent, { type: 'depended' }> =>
      entry.type === 'depended' && sameRef(index, entry.task, on),
  );
  return event?.actor.kind === 'daemon' && event.override === undefined;
};

/** Whether a card of the unit waived a wait on this card: it removed that dependency on purpose. */
const waived = (unit: readonly Card[], target: string, index: BoardIndex): boolean =>
  unit.some(card =>
    card.history.some(event => event.type === 'undepended' && event.task.id === target && index.isLocal(event.task)),
  );

/**
 * The live clash waits of a unit (see the module doc): one per other unit that clashes with it and claimed first,
 * named on the unit card whose claim clashes and on the other unit's shipping card.
 */
const clashWaits = (
  unit: readonly Card[],
  keys: ReadonlySet<string>,
  live: readonly Card[],
  units: ShippingUnits,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets },
): readonly BoardMergeWait[] => {
  const inUnit = new Set(unit.map(card => card.id));
  const others = new Map<string, Card[]>();
  for (const card of live) {
    if (inUnit.has(card.id) || card.files.length === 0) continue;
    for (const key of units.rides(card)) {
      if (!keys.has(key)) others.set(key, [...(others.get(key) ?? []), card]);
    }
  }
  // One rank per unit, never per pair, so the order is total (see the module doc).
  const anyRider = new Map<string, number>();
  const ownRider = new Map<string, number>();
  for (const card of live) {
    if (card.files.length === 0) continue;
    const first = earliest(claimsOf(card));
    const rides = units.rides(card);
    for (const key of rides) {
      anyRider.set(key, Math.min(anyRider.get(key) ?? Infinity, first));
      if (rides.size === 1) ownRider.set(key, Math.min(ownRider.get(key) ?? Infinity, first));
    }
  }
  const rankOf = (key: string): Rank => [anyRider.get(key) ?? Infinity, ownRider.get(key) ?? Infinity, key];
  const myRank = [...keys].map(rankOf).sort(compareRanks)[0] ?? rankOf('');
  const waits: BoardMergeWait[] = [];
  /** The unit's shipping card when that unit can still hold a merge: there, not dropped, and not shipped. */
  const holding = (key: string): Card | undefined => {
    const target = board.index.get({ id: key as Card['id'] });
    if (target === undefined || target.dropped !== null) return undefined;
    const category = cardCategory(target, board.laneSets);
    return category !== undefined && isBlockerDone(category, 'shipped') ? undefined : target;
  };
  for (const [key, cards] of others) {
    const target = holding(key);
    if (target === undefined) continue;
    // An umbrella lead never ships by itself while a child unit can: its claims count through that unit instead.
    if ([...units.rides(target)].some(other => other !== key && holding(other) !== undefined)) continue;
    // A card riding both units (an umbrella lead) belongs to neither side of this pair.
    const mine = unit.filter(card => !units.rides(card).has(key)).flatMap(claimsOf);
    const theirs = cards.flatMap(claimsOf);
    const clash = mine.find(claim =>
      theirs.some(other => other.card.projectId === claim.card.projectId && claimsClash(claim.path, other.path)),
    );
    if (clash === undefined) continue;
    const theyWereFirst = compareRanks(rankOf(key), myRank) < 0;
    if (!theyWereFirst || waived(unit, key, board.index)) continue;
    waits.push({ card: { id: clash.card.id }, on: { id: target.id }, until: 'shipped' });
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
  const linksPr = (card: Card): boolean => card.links.prs.some(samePr(pr));
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
      return [{ card: { id: card.id }, on, until }];
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
