/**
 * THE NEEDS-YOU QUEUE AND THE RESTING LIST (docs/agenda.md § The Needs-you queue): one selector each, so the Inbox,
 * the badge, push and every count read the same list in the same order. Pure and total.
 */
import { type AgendaCardAsk, type AgendaParked, agendaWakeAt } from './agenda.ts';
import { hasOpenCardAsk } from './agenda-card-asks.ts';
import { agendaNeedsYouSince } from './agenda-stage.ts';
import { type AgendaRestSubState, type AgendaStateSource, agendaState } from './agenda-state.ts';

/** What the queue reads of an item. */
export interface AgendaQueueSource extends AgendaStateSource {
  readonly id: string;
  readonly waitingSince: string;
  readonly blockingNow?: true | undefined;
  readonly neededBy?: string | undefined;
  readonly parked?: AgendaParked | undefined;
  readonly cardAsks?: readonly Pick<AgendaCardAsk, 'answer'>[] | undefined;
}

/** A blocker goes first: the ferret said it is stuck now, or the agenda carries a card ask the owner has yet to answer. */
const isBlocker = (item: AgendaQueueSource): boolean => item.blockingNow === true || hasOpenCardAsk(item);

const byClock = (left: string, right: string): number => Date.parse(left) - Date.parse(right);

/**
 * THE NEEDS-YOU QUEUE: every item whose state is `needs-you`, each AT MOST ONCE (the first of any repeat of its
 * key wins), blockers first (`blockingNow`, or an open card ask), then by when each started needing the owner (`agendaNeedsYouSince`), then by key.
 * `keyOf` names an item across boards (the roll-up keys by session too); on one board its id is enough.
 */
export function needsYouQueue<Item extends AgendaQueueSource>(
  items: readonly Item[],
  keyOf: (item: Item) => string = item => item.id,
): Item[] {
  const seen = new Set<string>();
  const queue = items.filter(item => {
    if (agendaState(item).state !== 'needs-you') return false;
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return queue.sort(
    (left, right) =>
      Number(isBlocker(right)) - Number(isBlocker(left)) ||
      byClock(agendaNeedsYouSince(left), agendaNeedsYouSince(right)) ||
      keyOf(left).localeCompare(keyOf(right)),
  );
}

/** Where a Resting-list item sits: waiting on its ferret, then the ferret working, then snoozed. */
const RESTING_RANK: Readonly<Record<AgendaRestSubState | 'snoozed', number>> = {
  'waiting-on-ferret': 0,
  working: 1,
  snoozed: 2,
};

/**
 * THE RESTING LIST: every resting or snoozed item, each at most once — the ones waiting on their ferret first, then
 * the ones the ferret is working on, each oldest rest first, then the snoozed ones by when they wake.
 */
export function restingQueue<Item extends AgendaQueueSource>(
  items: readonly Item[],
  keyOf: (item: Item) => string = item => item.id,
): Item[] {
  const seen = new Set<string>();
  const ranked = items.flatMap(item => {
    const view = agendaState(item);
    const key = keyOf(item);
    if ((view.state !== 'resting' && view.state !== 'snoozed') || seen.has(key)) return [];
    seen.add(key);
    return view.state === 'resting'
      ? [{ item, key, rank: RESTING_RANK[view.sub], clock: view.since }]
      : [{ item, key, rank: RESTING_RANK.snoozed, clock: agendaWakeAt(item) ?? item.waitingSince }];
  });
  return ranked
    .sort(
      (left, right) => left.rank - right.rank || byClock(left.clock, right.clock) || left.key.localeCompare(right.key),
    )
    .map(each => each.item);
}
