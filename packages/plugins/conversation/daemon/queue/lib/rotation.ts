import type { QueueSegmentHeader } from '../../../contract/index.ts';
import { type HeldMessage, isFinal, type SegmentFold } from './model.ts';

/**
 * ROTATING A QUEUE'S LOG, as pure decisions. The store (`adapters/state-queue-store.ts`) does the IO.
 *
 * WHY. A queue's log was append-only and never compacted: one ferret's reached 29.5 MB (228,788 lines) for 1,727
 * messages, and every look read and folded all of it, several times, every five seconds. The log is now a short LIVE
 * SEGMENT plus immutable SEALED SHARDS: when the segment reaches {@link ROTATE_EVENTS} events, the messages that have
 * left the queue for good are sealed into a shard, the ones still open are carried into the next segment in a carry file,
 * and the segment starts over. A message keeps its `version` (a position over the WHOLE queue) and its `order`
 * (when it was first accepted) through any number of rotations, so nothing that keys on either notices.
 *
 * WHY 2,000. A message costs about six events (enqueued, waiting, typing, delivered, read, and the odd refusal), so a
 * segment holds a few hundred messages — a header and a live file of well under a megabyte, and a cold parse of a
 * few milliseconds (measured in the realworld timing test), which is all a look ever costs on a log that has seen
 * 200,000 events. A smaller number rotates, and so rewrites the carry file and a shard, ever more often for no
 * gain; a larger one gives back the cost this removes. A ferret that stays busy for a day rotates a few times.
 */
export const ROTATE_EVENTS = 2_000;

/** What a rotation of a full segment writes: the shard of messages that are final, and the next live segment. */
export interface Rotation {
  /** The position the queue has reached: the shard's `through` and the next segment's `base`. */
  readonly through: number;
  /** Messages that will never change again, in the order they were first accepted; may be none. */
  readonly sealed: readonly HeldMessage[];
  /** The next live segment's header, and the open messages its carry file holds, in the order they were first accepted. */
  readonly header: QueueSegmentHeader;
  readonly carried: readonly HeldMessage[];
}

/** Folds a segment into what is sealed and what is carried. Pure: the same segment always rotates the same way. */
export function rotationOf(fold: SegmentFold): Rotation {
  const held = fold.messages;
  const carried = held.filter(entry => !isFinal(entry.message.state));
  return {
    through: fold.position,
    sealed: held.filter(entry => isFinal(entry.message.state)),
    header: { v: 1, kind: 'segment', base: fold.position, accepted: fold.acceptedCount, carried: carried.length },
    carried,
  };
}

/** Two lists each in acceptance order, as one list in acceptance order. */
export function mergeByOrder(first: readonly HeldMessage[], second: readonly HeldMessage[]): readonly HeldMessage[] {
  const merged: HeldMessage[] = [];
  let a = 0;
  let b = 0;
  while (a < first.length || b < second.length) {
    const left = first[a];
    const right = second[b];
    if (right === undefined || (left !== undefined && left.order <= right.order)) {
      merged.push(left as HeldMessage);
      a += 1;
    } else {
      merged.push(right);
      b += 1;
    }
  }
  return merged;
}

/** A shard's file name: the ferret and the position it reached, which sorts as the rotations happened. */
export function shardName(ferret: string, through: number): string {
  return `${ferret}~${String(through).padStart(12, '0')}`;
}

/** The position a shard of `ferret` reached, or `undefined` for a name that is another ferret's or not a shard's. */
export function shardThrough(ferret: string, name: string): number | undefined {
  const prefix = `${ferret}~`;
  if (!name.startsWith(prefix)) return undefined;
  const digits = name.slice(prefix.length);
  return /^\d{12}$/u.test(digits) ? Number(digits) : undefined;
}

/**
 * The sealed shards a live segment may use: those whose `through` is not past its `base`. Immutable — a shard is
 * parsed once and a rotation makes a new set around it.
 */
export class SealedShards {
  /** The live `base` this set is complete for. */
  readonly base: number;
  /** Every sealed message in acceptance order, and the ids among them. */
  readonly ordered: readonly HeldMessage[];
  readonly ids: ReadonlySet<string>;

  constructor(base: number, shards: ReadonlyMap<number, readonly HeldMessage[]>) {
    this.base = base;
    const byId = new Map<string, HeldMessage>();
    // A shard rewritten by a later rotation holds the same finished messages: the later one wins.
    for (const through of [...shards.keys()].filter(at => at <= base).sort((a, b) => a - b))
      for (const entry of shards.get(through) ?? []) byId.set(entry.message.id, entry);
    this.ordered = [...byId.values()].sort((a, b) => a.order - b.order);
    this.ids = new Set(byId.keys());
    this.shards = shards;
  }

  private readonly shards: ReadonlyMap<number, readonly HeldMessage[]>;

  /** The same shards with one more, for the segment that begins at `through`. */
  with(through: number, sealed: readonly HeldMessage[]): SealedShards {
    return new SealedShards(through, new Map(this.shards).set(through, sealed));
  }
}
