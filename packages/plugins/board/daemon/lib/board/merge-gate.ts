/**
 * THE MERGE GATE (docs/design/clash-queue.md § The merge gate): whether a PR may merge as far as the board's queue
 * goes. Decided from ONE read of the board, so a task that moves while it is asked cannot slip between pages.
 *
 * A PR ships a MERGE UNIT: every task not dropped that links it, and every task not dropped that rides one of those
 * tasks' shipping units (`ShippingUnits`: a helper of a linking task, finished or not, and an umbrella lead above one).
 *
 * The PR waits on two things, both read from the board as it is NOW:
 *
 * - **The clash order, derived live.** Shipping units change after a claim lands (a task links its PR, a helper
 *   finishes, a task is reparented), so the depends-on the daemon wrote at claim time can be stale. The gate does not
 *   trust it: for every other unit whose claims clash with this unit's, the unit that claimed FIRST merges first. Each
 *   unit has ONE rank: the earliest claim of any task riding it (an umbrella lead's counts for every unit under it),
 *   then the earliest claim of the tasks riding only it, then its key. A rank never depends on the pair being
 *   compared, so the order is total and no set of PRs ever waits on each other in a circle through it. A unit
 *   whose shipping task has shipped or was dropped holds nothing, nor does an umbrella lead's own unit while one of
 *   its child units can still hold (it never ships by itself; its claims count through that unit). A lead waives one wait with
 *   `fy task undepend`.
 * - **The dependencies a person added** (not the daemon's own claim-time ones), on a task outside the unit that is not
 *   done. A task inside the unit, or one linking the same PR, ships in the same merge and never holds it.
 */
import {
  type BoardMergeGateResponse,
  type BoardMergeWait,
  type Task,
  type TaskEvent,
  isBlockerDone,
  type PrLink,
  prUrlParts,
  type TaskRef,
} from '../../../contract/index.ts';
import { claimsClash } from './clash-queue.ts';
import { type BoardIndex, blockedBy, taskCategory, type LaneSets } from './graph.ts';
import { ShippingUnits } from './shipping-unit.ts';

/** Whether a PR link names this PR: the same repository (any case) and number. */
const samePr =
  (pr: { readonly repo: string; readonly number: number }) =>
  (link: Pick<PrLink, 'repo' | 'number'>): boolean =>
    link.repo.toLowerCase() === pr.repo.toLowerCase() && link.number === pr.number;

/** Whether two refs name the same task: the same id, both on this machine or both on the same other one. */
const sameRef = (index: BoardIndex, left: TaskRef, right: TaskRef): boolean =>
  left.id === right.id &&
  (index.isLocal(left) ? index.isLocal(right) : !index.isLocal(right) && left.machineId === right.machineId);

/** One claim with the moment it was made: its last `file-claimed`, else the task's creation (a task born with it). */
interface Claim {
  readonly card: Task;
  readonly path: string;
  readonly atMs: number;
}

/** Each held spelling keeps its own moment: claiming `./x.ts` beside `x.ts` later never makes `x.ts` younger. */
const claimsOf = (task: Task): readonly Claim[] =>
  task.files.map(path => {
    const event = task.history.findLast(
      (entry): entry is Extract<TaskEvent, { type: 'file-claimed' }> =>
        entry.type === 'file-claimed' && entry.path === path,
    );
    return { card: task, path, atMs: Date.parse(event?.at ?? task.createdAt) };
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
const isClaimTimeWait = (task: Task, on: TaskRef, index: BoardIndex): boolean => {
  const event = task.history.findLast(
    (entry): entry is Extract<TaskEvent, { type: 'depended' }> =>
      entry.type === 'depended' && sameRef(index, entry.task, on),
  );
  return event?.actor.kind === 'daemon' && event.override === undefined;
};

/** Whether a task of the unit waived a wait on this task: it removed that dependency on purpose. */
const waived = (unit: readonly Task[], target: string, index: BoardIndex): boolean =>
  unit.some(task =>
    task.history.some(event => event.type === 'undepended' && event.task.id === target && index.isLocal(event.task)),
  );

/**
 * The live clash waits of a unit (see the module doc): one per other unit that clashes with it and claimed first,
 * named on the unit task whose claim clashes and on the other unit's shipping task.
 */
const clashWaits = (
  unit: readonly Task[],
  keys: ReadonlySet<string>,
  live: readonly Task[],
  units: ShippingUnits,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets },
): readonly BoardMergeWait[] => {
  const inUnit = new Set(unit.map(task => task.id));
  const others = new Map<string, Task[]>();
  for (const task of live) {
    if (inUnit.has(task.id) || task.files.length === 0) continue;
    for (const key of units.rides(task)) {
      if (!keys.has(key)) others.set(key, [...(others.get(key) ?? []), task]);
    }
  }
  // One rank per unit, never per pair, so the order is total (see the module doc).
  const anyRider = new Map<string, number>();
  const ownRider = new Map<string, number>();
  for (const task of live) {
    if (task.files.length === 0) continue;
    const first = earliest(claimsOf(task));
    const rides = units.rides(task);
    for (const key of rides) {
      anyRider.set(key, Math.min(anyRider.get(key) ?? Infinity, first));
      if (rides.size === 1) ownRider.set(key, Math.min(ownRider.get(key) ?? Infinity, first));
    }
  }
  const rankOf = (key: string): Rank => [anyRider.get(key) ?? Infinity, ownRider.get(key) ?? Infinity, key];
  const myRank = [...keys].map(rankOf).sort(compareRanks)[0] ?? rankOf('');
  const waits: BoardMergeWait[] = [];
  /** The unit's shipping task when that unit can still hold a merge: there, not dropped, and not shipped. */
  const holding = (key: string): Task | undefined => {
    const target = board.index.get({ id: key as Task['id'] });
    if (target === undefined || target.dropped !== null) return undefined;
    const category = taskCategory(target, board.laneSets);
    return category !== undefined && isBlockerDone(category, 'shipped') ? undefined : target;
  };
  for (const [key, tasks] of others) {
    const target = holding(key);
    if (target === undefined) continue;
    // An umbrella lead never ships by itself while a child unit can: its claims count through that unit instead.
    if ([...units.rides(target)].some(other => other !== key && holding(other) !== undefined)) continue;
    // A task riding both units (an umbrella lead) belongs to neither side of this pair.
    const mine = unit.filter(task => !units.rides(task).has(key)).flatMap(claimsOf);
    const theirs = tasks.flatMap(claimsOf);
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
 * the tasks that could not be read (any of them might link the PR). `null` when the URL is not a GitHub PR.
 */
export const mergeGateOf = (
  url: string,
  board: { readonly index: BoardIndex; readonly laneSets: LaneSets; readonly unreadable: readonly string[] },
): BoardMergeGateResponse | null => {
  const pr = prUrlParts(url);
  if (pr === null) return null;
  const linksPr = (task: Task): boolean => task.links.prs.some(samePr(pr));
  const live = board.index.cards.filter(task => task.dropped === null);
  const linking = live.filter(linksPr);
  const units = new ShippingUnits(board.index);
  // Unit KEYS, not task ids: a linking task may share its unit (and so its key) with a task that links another PR too.
  const ids = new Set(linking.map(task => task.id));
  const keys = new Set(linking.map(task => units.key(task)));
  const unit =
    linking.length === 0
      ? []
      : live.filter(task => ids.has(task.id) || [...units.rides(task)].some(key => keys.has(key)));
  const inUnit = new Set(unit.map(task => task.id));
  const added = unit.flatMap(task =>
    blockedBy(task, board.index, board.laneSets).flatMap((on): BoardMergeWait[] => {
      // `get` answers only for a task on this machine, so a remote task that shares an id is never "inside".
      const blocker = board.index.get(on);
      if (blocker !== undefined && (inUnit.has(blocker.id) || linksPr(blocker))) return [];
      if (isClaimTimeWait(task, on, board.index)) return [];
      const until = task.dependsOn.find(dependency => sameRef(board.index, dependency.task, on))?.until ?? 'shipped';
      return [{ card: { id: task.id }, on, until }];
    }),
  );
  const clashes = unit.length === 0 ? [] : clashWaits(unit, keys, live, units, board);
  return {
    pr: url,
    unit: unit.map(task => ({ id: task.id })),
    waits: [...added, ...clashes],
    unreadable: [...board.unreadable] as BoardMergeGateResponse['unreadable'],
  };
};
