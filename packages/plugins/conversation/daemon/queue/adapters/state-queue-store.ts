import type { StatePort } from '@ferretry/kernel/contract';
import {
  type QueueSegmentHeader,
  QueueSegmentHeaderSchema,
  type SegmentMessage,
} from '@ferretry/core-mailbox/contract';
import { QUEUE_CARRY_STATE, QUEUE_SHARD_STATE, QUEUE_STATE } from '../../../contract/index.ts';
import type { QueuedMessage } from '@ferretry/core-mailbox/contract';
import type { SessionId } from '../../seams/ferret-id.ts';
import {
  type HeldMessage,
  UNROTATED_SEGMENT,
  type QueueEvent,
  QueueEventSchema,
  SegmentFold,
} from '@ferretry/core-mailbox/contract';
import type { SessionQueueStore } from '../lib/ports.ts';
import { mergeByOrder, ROTATE_EVENTS, rotationOf, SealedShards, shardName, shardThrough } from '../lib/rotation.ts';

/** What the store tells whoever runs it when a rotation could not be written: once, until one succeeds again. */
export interface RotationFailure {
  readonly ferret: string;
  readonly error: unknown;
  /** Events in the live segment, which grows until a rotation succeeds. */
  readonly events: number;
  /** Bytes of the live file, when it could be measured. */
  readonly bytes: number | undefined;
}

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
 * shard and the ones still open to a carry file (`queue-carry/<ferret>~<base>.json`), both atomically (a); then the live
 * file is replaced with a header alone (b). Nothing a rotation writes is a record of a capped file, so no message however
 * long can stop one. A crash between (a) and (b) leaves the old segment whole and authoritative — a reader uses only
 * shards at or before the live segment's `base` and only the carry file of that `base` — and the next rotation replaces them.
 * A rotation that cannot be written (the disk) is reported once and tried again at the next append.
 *
 * ONE WRITER PER FERRET AT A TIME. Every append runs inside the ferret's queue lock (`SessionQueueStore`), which is what
 * lets a rotation read the live segment and replace it without an append in between, and lets an append trust the fold it kept.
 */
export class StateQueueStore implements SessionQueueStore {
  private readonly held = new Map<string, Held>();
  /** Every shard parsed so far, by name: a shard is immutable, so it is parsed once. */
  private readonly parsed = new Map<string, readonly HeldMessage[]>();
  /** The same for carry files. */
  private readonly carries = new Map<string, readonly SegmentMessage[]>();
  /** Ferrets whose last rotation failed and was reported, so a disk that stays down is said once. */
  private readonly failing = new Set<string>();

  constructor(
    private readonly state: StatePort,
    private readonly rotateEvents: number = ROTATE_EVENTS,
    private readonly rotationFailed: (failure: RotationFailure) => void = () => undefined,
  ) {}

  async messages(id: SessionId): Promise<readonly QueuedMessage[]> {
    const held = await this.current(id);
    held.answer ??= mergeByOrder(held.sealed.ordered, held.fold.messages).map(entry => entry.message);
    return held.answer;
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    const held = await this.current(id);
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
    await this.rotate(id, kept).then(
      () => void this.failing.delete(id),
      async (error: unknown) => {
        this.held.delete(id);
        if (this.failing.has(id)) return;
        this.failing.add(id);
        const bytes = (await this.state.version(QUEUE_STATE, id).catch(() => undefined))?.size;
        this.rotationFailed({ ferret: id, error, events: kept.fold.events, bytes });
      },
    );
  }

  /** The live segment and shards as they stand: what was kept when the file is unchanged, else read again. */
  private async current(id: SessionId): Promise<Held> {
    const version = await this.state.version(QUEUE_STATE, id);
    const kept = this.held.get(id);
    if (kept !== undefined && kept.etag === version?.etag) return kept;
    const { header, events } = await this.readLive(id);
    const carried = await this.carriedBy(id, header);
    const sealed = await this.sealedFor(id, header.base, kept?.sealed);
    const fold = new SegmentFold(header, carried, sealed.ids);
    for (const event of events) fold.apply(event);
    const held: Held = { etag: version?.etag, fold, sealed, answer: undefined };
    this.held.set(id, held);
    return held;
  }

  /** The live file: its header (the unrotated one when it has none) and the events after it. */
  private async readLive(id: SessionId): Promise<{ header: QueueSegmentHeader; events: QueueEvent[] }> {
    let header: QueueSegmentHeader | undefined;
    let first = true;
    const events: QueueEvent[] = [];
    for await (const line of this.state.lines<unknown>(QUEUE_STATE, id)) {
      // Only the first record that parses can be the header; a `segment` line anywhere else is not an event.
      const head = first ? QueueSegmentHeaderSchema.safeParse(line) : undefined;
      if (head?.success === true) {
        header = head.data;
        first = false;
        continue;
      }
      const parsed = QueueEventSchema.safeParse(line);
      if (parsed.success) {
        events.push(parsed.data);
        first = false;
      }
    }
    return { header: header ?? UNROTATED_SEGMENT, events };
  }

  /** The open messages a segment carries: its carry file, the one named for its `base`, parsed once. */
  private async carriedBy(id: SessionId, header: QueueSegmentHeader): Promise<readonly SegmentMessage[]> {
    if (header.carried === 0) return [];
    const name = shardName(id, header.base);
    const known = this.carries.get(name);
    if (known !== undefined) return known;
    const read = await this.state.read(QUEUE_CARRY_STATE, name);
    if (!read.ok) throw new Error(`queue carry file ${name} is unreadable: ${read.error.reason}`);
    const messages = read.value?.messages;
    // The header says how many open messages it carries: a file that is missing or holds another number is not its own.
    if (messages?.length !== header.carried)
      throw new Error(
        `queue carry file ${name} should hold ${header.carried} messages and holds ${messages?.length ?? 'none'}`,
      );
    this.carries.set(name, messages);
    return messages;
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

  /** Seals what is final into a shard and carries what is open in a file, then replaces the live file with the header alone. */
  private async rotate(id: SessionId, held: Held): Promise<void> {
    const rotation = rotationOf(held.fold);
    const { through, sealed, header, carried } = rotation;
    // A shard past the live base is a rotation that never finished: it is not part of the queue, and goes.
    for (const name of await this.shardNames(id))
      if ((shardThrough(id, name) as number) > held.fold.header.base) await this.state.remove(QUEUE_SHARD_STATE, name);
    const name = shardName(id, through);
    if (sealed.length > 0)
      await this.state.write(QUEUE_SHARD_STATE, { format: 1, through, messages: [...sealed] }, name);
    if (carried.length > 0)
      await this.state.write(QUEUE_CARRY_STATE, { format: 1, base: through, messages: [...carried] }, name);
    await this.state.write(QUEUE_STATE, [header] as never, id);
    if (sealed.length > 0) this.parsed.set(name, sealed);
    if (carried.length > 0) this.carries.set(name, carried);
    const shards = held.sealed.with(through, sealed);
    const version = await this.state.version(QUEUE_STATE, id);
    this.held.set(id, {
      etag: version?.etag,
      fold: new SegmentFold(header, carried, shards.ids),
      sealed: shards,
      answer: undefined,
    });
    // Housekeeping after the rotation stood: a file it could not remove is removed by the next one.
    await this.dropOtherCarries(id, name).catch(() => undefined);
  }

  /** Removes this ferret's carry files other than the live one's: the last segment's, or a rotation that never finished. */
  private async dropOtherCarries(id: SessionId, keep: string): Promise<void> {
    const names = (await this.state.list(QUEUE_CARRY_STATE)).filter(
      name => name !== keep && shardThrough(id, name) !== undefined,
    );
    for (const name of names) {
      this.carries.delete(name);
      await this.state.remove(QUEUE_CARRY_STATE, name);
    }
  }
}
