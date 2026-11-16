import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type HeldMessage,
  type QueueEvent,
  SegmentFold,
  type VersionedMessage,
} from '../../../../daemon/queue/lib/model.ts';
import {
  assertCarriable,
  CARRIED_HEADROOM_BYTES,
  mergeByOrder,
  QueueMessageTooLarge,
  ROTATE_EVENTS,
  rotationOf,
  segmentRecords,
  SealedShards,
  shardName,
  shardThrough,
} from '../../../../daemon/queue/lib/rotation.ts';

const AT = '2026-11-01T08:00:00.000Z' as Instant;

const enqueued = (id: string): QueueEvent => ({
  v: 1,
  kind: 'enqueued',
  at: AT,
  message: {
    v: 1,
    id,
    sender: 'human',
    text: id,
    attachmentIds: [],
    enqueuedAt: AT,
    state: 'queued',
    stateAt: AT,
    revision: 1,
  },
});
const moved = (id: string, state: VersionedMessage['state']): QueueEvent => ({
  v: 1,
  kind: 'moved',
  at: AT,
  id,
  state,
});
const held = (id: string, order: number): HeldMessage => ({
  order,
  message: { ...(enqueued(id) as Extract<QueueEvent, { kind: 'enqueued' }>).message, version: order + 1 },
});

describe('rotating a full segment', () => {
  it('should seal what has left the queue and carry what is open, saying where the next segment begins', () => {
    const fold = new SegmentFold();
    for (const event of [
      enqueued('a'),
      enqueued('b'),
      enqueued('c'),
      enqueued('d'),
      moved('a', 'cancelled'),
      moved('b', 'typing'),
      moved('b', 'delivered'),
      moved('c', 'typing'),
      moved('c', 'failed'),
    ])
      fold.apply(event);

    const rotation = rotationOf(fold);

    should(rotation.through).equal(9);
    should(rotation.sealed.map(entry => [entry.order, entry.message.id, entry.message.state])).eql([
      [0, 'a', 'cancelled'],
      [2, 'c', 'failed'],
    ]);
    should(rotation.header.base).equal(9);
    should(rotation.header.accepted).equal(4);
    should(rotation.header.carried).equal(2);
    should(rotation.carried.map(entry => [entry.order, entry.message.id, entry.message.state])).eql([
      [1, 'b', 'delivered'],
      [3, 'd', 'queued'],
    ]);
  });

  it('should rotate a segment of nothing but open messages into a shard of nothing', () => {
    const fold = new SegmentFold();
    fold.apply(enqueued('a'));

    should(rotationOf(fold).sealed).eql([]);
  });

  it('should rotate at a number of events that keeps a look cheap', () => {
    should(ROTATE_EVENTS).equal(2_000);
  });
});

describe('two lists in acceptance order', () => {
  it('should merge into one list in acceptance order, whichever list has the older message', () => {
    const merged = mergeByOrder([held('a', 0), held('c', 4)], [held('b', 1), held('d', 5), held('e', 6)]);

    should(merged.map(entry => entry.message.id)).eql(['a', 'b', 'c', 'd', 'e']);
    should(mergeByOrder([], [held('a', 0)]).map(entry => entry.message.id)).eql(['a']);
    should(mergeByOrder([held('a', 0)], [])).have.length(1);
  });
});

describe('a shard’s name', () => {
  it('should be the ferret and the position it reached, which sorts as the rotations happened', () => {
    should(shardName('f1', 2_000)).equal('f1~000000002000');
    should([shardName('f1', 10_000), shardName('f1', 2_000)].sort()).eql(['f1~000000002000', 'f1~000000010000']);
  });

  it('should read back the position, and only for a shard of that ferret', () => {
    should(shardThrough('f1', 'f1~000000002000')).equal(2_000);
    should(shardThrough('f1', 'f10~000000002000')).equal(undefined);
    should(shardThrough('f1', 'f1~2000')).equal(undefined);
    should(shardThrough('f1', 'f1~00000000200x')).equal(undefined);
  });
});

describe('the shards a segment may use', () => {
  it('should use only shards at or before its base, in acceptance order, and leave a later one out', () => {
    const shards = new Map([
      [4, [held('d', 3), held('a', 0)]],
      [8, [held('e', 5)]],
      [12, [held('z', 9)]],
    ]);

    const sealed = new SealedShards(8, shards);

    should(sealed.base).equal(8);
    should(sealed.ordered.map(entry => entry.message.id)).eql(['a', 'd', 'e']);
    should([...sealed.ids].sort()).eql(['a', 'd', 'e']);
  });

  it('should let the later shard win for a message in two, as a rewritten shard holds it again', () => {
    const first = held('a', 0);
    const later = { ...first, message: { ...first.message, version: 99 } };

    const sealed = new SealedShards(
      8,
      new Map([
        [4, [first]],
        [8, [later]],
      ]),
    );

    should(sealed.ordered.map(entry => entry.message.version)).eql([99]);
  });

  it('should make a new set around the old shards when a rotation seals one more', () => {
    const before = new SealedShards(4, new Map([[4, [held('a', 0)]]]));

    const after = before.with(9, [held('b', 2)]);

    should(after.base).equal(9);
    should(after.ordered.map(entry => entry.message.id)).eql(['a', 'b']);
    should(before.ordered.map(entry => entry.message.id)).eql(['a']);
  });
});

describe('the file a rotation leaves', () => {
  it('should be a header that counts the open messages, then one carried line for each', () => {
    const fold = new SegmentFold();
    for (const event of [enqueued('a'), enqueued('b'), moved('a', 'cancelled')]) fold.apply(event);

    const records = segmentRecords(rotationOf(fold));

    should(records.map(record => record.kind)).eql(['segment', 'carried']);
    should(records[0]).eql({ v: 1, kind: 'segment', base: 3, accepted: 2, carried: 1 });
    should(records[1]).containEql({ v: 1, kind: 'carried', order: 1 });
  });
});

describe('a message too long to carry', () => {
  const longer = (bytes: number): VersionedMessage => ({ ...held('big', 0).message, text: 'x'.repeat(bytes) });

  it('should be taken while its carried line fits a record with the headroom to spare, and refused past it', () => {
    const cap = 1 << 20;
    const envelope = 400;

    assertCarriable(longer(cap - CARRIED_HEADROOM_BYTES - envelope));
    should(() => assertCarriable(longer(cap - CARRIED_HEADROOM_BYTES))).throw(QueueMessageTooLarge);
  });

  it('should say which message, how big it would be and what is allowed', () => {
    let caught: unknown;
    try {
      assertCarriable(longer(1 << 20));
    } catch (error) {
      caught = error;
    }

    should(caught).be.instanceOf(QueueMessageTooLarge);
    const refused = caught as QueueMessageTooLarge;
    should(refused.messageId).equal('big');
    should(refused.bytes).be.above(refused.allowed);
    should(refused.message).match(/too long to queue/);
  });
});
