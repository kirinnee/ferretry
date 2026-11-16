import type { StatePort } from '@ferretry/kernel/contract';
import {
  QUEUE_SHARD_STATE,
  QUEUE_STATE,
  QueueCarriedLineSchema,
  type QueueSegmentHeader,
  QueueSegmentHeaderSchema,
  type SegmentMessage,
} from '../../../contract/index.ts';
import type { QueuedMessage } from '../../seams/protocol.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import { type HeldMessage, UNROTATED_SEGMENT, type QueueEvent, QueueEventSchema, SegmentFold } from '../lib/model.ts';
import type { SessionQueueStore } from '../lib/ports.ts';
import {
  assertCarriable,
  mergeByOrder,
  ROTATE_EVENTS,
  rotationOf,
  SealedShards,
  segmentRecords,
  shardName,
  shardThrough,
} from '../lib/rotation.ts';

/** What the store keeps of one ferret between calls: the live file as it was last read or written, and the shards. */
interface Held {
  /** The live file's `version()` etag when `fold` was current; `undefined` for a file that is not there. */
  etag: string | undefined;
  readonly fold: SegmentFold;
  readonly sealed: SealedShards;
  /** The answer for this fold and these shards; dropped when an event is applied. */
  answer: readonly QueuedMessage[] | undefined;
}

/**
 * A ferret's queue as a ROTATED log: a short live segment in its own state file (`state/conversation/<ferret>/queue.jsonl`)
 * and the messages that have left the queue sealed in immutable shards (`queue-shards/<ferret>~<through>.json`). See
 * {@link ROTATE_EVENTS} for why and `lib/rotation.ts` for what a rotation decides.
 *
 * DURABLE BEFORE IT ANSWERS: the state port's append is on disk when it resolves, because "accepted" is a promise
 * the message survives a daemon that goes down a moment later.
 *
 * PARSED AT THE BOUNDARY: a line that is not an event this daemon knows is skipped, so one odd line cannot hide every
 * message after it. The fold decides what each surviving event may change.
 *
 * READ ONCE, NOT EVERY LOOK. The live segment is kept folded and checked against the file's `version()` (one `lstat`):
 * unchanged, nothing is read; changed by somebody else, it is parsed again (at most {@link ROTATE_EVENTS} lines); and an
 * append this store made applies to the fold it kept instead of parsing the file again. A sealed shard never changes,
 * so each is parsed once and kept by name.
 *
 * ROTATION. Once the live segment holds `rotateEvents`, the messages that have left the queue for good are written to a
 * shard (a), then the live file is replaced with a header and a line for each message still open (b), both atomically. A crash
 * between the two leaves the old segment whole and authoritative — a reader uses only shards at or before the live
 * segment's `base` — and the next rotation rewrites that shard.
 *
 * ONE WRITER PER FERRET AT A TIME. Every append runs inside the ferret's queue lock (`SessionQueueStore`), which is what
 * lets a rotation read the live segment and replace it without an append in between, and lets an append trust the fold it kept.
 */
export class StateQueueStore implements SessionQueueStore {
  private readonly held = new Map<string, Held>();
  /** Every shard parsed so far, by name: a shard is immutable, so it is parsed once. */
  private readonly parsed = new Map<string, readonly HeldMessage[]>();

  constructor(
    private readonly state: StatePort,
    private readonly rotateEvents: number = ROTATE_EVENTS,
  ) {}

  async messages(id: SessionId): Promise<readonly QueuedMessage[]> {
    const held = await this.current(id);
    held.answer ??= mergeByOrder(held.sealed.ordered, held.fold.messages).map(entry => entry.message);
    return held.answer;
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    const held = await this.current(id);
    this.assertFits(held.fold, event);
    await this.state.append<unknown>(QUEUE_STATE, event, id);
    const version = await this.state.version(QUEUE_STATE, id);
    // Folded in only when nobody has replaced what was kept while this waited; otherwise it is read again.
    if (this.held.get(id) === held) {
      held.fold.apply(event);
      held.etag = version?.etag;
      held.answer = undefined;
    } else this.held.delete(id);
    // The event is durable: a rotation that fails must not fail the append, and is tried again at the next one.
    const kept = this.held.get(id);
    if (kept === undefined || kept.fold.events < this.rotateEvents) return;
    await this.rotate(id, kept).catch(() => this.held.delete(id));
  }

  /**
   * Refuses, before anything is written, an event that would leave a message too big to carry through a rotation as one
   * record. The messages it can make bigger are those it accepts and those it edits; nothing else grows one.
   */
  private assertFits(fold: SegmentFold, event: QueueEvent): void {
    if (event.kind === 'enqueued') assertCarriable(event.message);
    else if (event.kind === 'edited') {
      const held = fold.message(event.id);
      if (held !== undefined) assertCarriable({ ...held, text: event.text });
    }
  }

  /** The live segment and shards as they stand: what was kept when the file is unchanged, else read again. */
  private async current(id: SessionId): Promise<Held> {
    const version = await this.state.version(QUEUE_STATE, id);
    const kept = this.held.get(id);
    if (kept !== undefined && kept.etag === version?.etag) return kept;
    const { header, carried, events } = await this.readLive(id);
    const sealed = await this.sealedFor(id, header.base, kept?.sealed);
    const fold = new SegmentFold(header, carried, sealed.ids);
    for (const event of events) fold.apply(event);
    const held: Held = { etag: version?.etag, fold, sealed, answer: undefined };
    this.held.set(id, held);
    return held;
  }

  /** The live file: its header (the unrotated one when it has none), the messages it carries, and the events after them. */
  private async readLive(
    id: SessionId,
  ): Promise<{ header: QueueSegmentHeader; carried: SegmentMessage[]; events: QueueEvent[] }> {
    let header: QueueSegmentHeader | undefined;
    let first = true;
    let owed = 0;
    const carried: SegmentMessage[] = [];
    const events: QueueEvent[] = [];
    for await (const line of this.state.lines<unknown>(QUEUE_STATE, id)) {
      // Only the first record that parses can be the header; a `segment` line anywhere else is not an event.
      const head = first ? QueueSegmentHeaderSchema.safeParse(line) : undefined;
      if (head?.success === true) {
        header = head.data;
        owed = head.data.carried;
        first = false;
        continue;
      }
      // The header says how many carried lines follow it; a `carried` line past that count is not an event either.
      const kept = owed > 0 ? QueueCarriedLineSchema.safeParse(line) : undefined;
      if (kept?.success === true) {
        carried.push({ order: kept.data.order, message: kept.data.message });
        owed -= 1;
        continue;
      }
      const parsed = QueueEventSchema.safeParse(line);
      if (parsed.success) {
        events.push(parsed.data);
        first = false;
      }
    }
    return { header: header ?? UNROTATED_SEGMENT, carried, events };
  }

  /** The shards a segment starting at `base` may use; the ones already parsed are not parsed again. */
  private async sealedFor(id: SessionId, base: number, kept: SealedShards | undefined): Promise<SealedShards> {
    if (kept?.base === base) return kept;
    // A rotation always leaves a base past zero, so a log still at zero has no shard to look for.
    if (base === 0) return new SealedShards(0, new Map());
    const shards = new Map<number, readonly HeldMessage[]>();
    for (const name of await this.shardNames(id)) {
      const through = shardThrough(id, name) as number;
      if (through > base) continue;
      shards.set(through, await this.shard(name));
    }
    return new SealedShards(base, shards);
  }

  private async shardNames(id: SessionId): Promise<readonly string[]> {
    return (await this.state.list(QUEUE_SHARD_STATE)).filter(name => shardThrough(id, name) !== undefined);
  }

  private async shard(name: string): Promise<readonly HeldMessage[]> {
    const known = this.parsed.get(name);
    if (known !== undefined) return known;
    const read = await this.state.read(QUEUE_SHARD_STATE, name);
    if (!read.ok) throw new Error(`queue shard ${name} is unreadable: ${read.error.reason}`);
    const entries = (read.value?.messages ?? []) as readonly HeldMessage[];
    this.parsed.set(name, entries);
    return entries;
  }

  /** Seals what is final into a shard, then replaces the live file with a header and one line for each message still open. */
  private async rotate(id: SessionId, held: Held): Promise<void> {
    const rotation = rotationOf(held.fold);
    const { through, sealed, header } = rotation;
    // A shard past the live base is a rotation that never finished: it is not part of the queue, and goes.
    for (const name of await this.shardNames(id))
      if ((shardThrough(id, name) as number) > held.fold.header.base) await this.state.remove(QUEUE_SHARD_STATE, name);
    const name = shardName(id, through);
    if (sealed.length > 0)
      await this.state.write(QUEUE_SHARD_STATE, { format: 1, through, messages: [...sealed] }, name);
    await this.state.write(QUEUE_STATE, segmentRecords(rotation) as never, id);
    if (sealed.length > 0) this.parsed.set(name, sealed);
    const shards = held.sealed.with(through, sealed);
    const version = await this.state.version(QUEUE_STATE, id);
    this.held.set(id, {
      etag: version?.etag,
      fold: new SegmentFold(header, rotation.carried, shards.ids),
      sealed: shards,
      answer: undefined,
    });
  }
}
