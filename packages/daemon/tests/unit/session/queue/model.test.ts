import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import { canMove, foldQueue, isFinal, type QueueEvent, QueueEventSchema } from '../../../../src/lib/index.ts';

/**
 * A session's queue is the fold of its log. These pin what each event may change, from where the message
 * stands — so a replayed, reordered or stale line never moves a message somewhere it cannot go.
 */

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 30, 13, 0, seconds)).toISOString();

function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    v: 1,
    id: 'm1',
    sender: 'human',
    text: 'ship it',
    attachmentIds: [],
    enqueuedAt: at(0),
    state: 'queued',
    stateAt: at(0),
    revision: 1,
    ...overrides,
  };
}

const enqueued = (overrides: Partial<QueuedMessage> = {}): QueueEvent => ({
  v: 1,
  kind: 'enqueued',
  at: overrides.enqueuedAt ?? at(0),
  message: message(overrides),
});
const moved = (id: string, state: QueuedMessage['state'], seconds: number, failure?: string): QueueEvent => ({
  v: 1,
  kind: 'moved',
  at: at(seconds),
  id,
  state,
  ...(failure === undefined ? {} : { failure }),
});

describe('foldQueue', () => {
  it('should answer an empty queue for an empty log', () => {
    should(foldQueue([])).be.empty();
  });

  it('should keep the first message for an id, so a retried request changes nothing', () => {
    const folded = foldQueue([enqueued(), enqueued({ text: 'a different retry' })]);

    should(folded).deepEqual([message()]);
  });

  it('should keep messages in the order they were accepted', () => {
    const folded = foldQueue([enqueued({ id: 'b' }), enqueued({ id: 'a' })]);

    should(folded.map(entry => entry.id)).eql(['b', 'a']);
  });

  it('should ignore an event for a message it never accepted', () => {
    should(foldQueue([moved('ghost', 'typing', 1)])).be.empty();
  });

  it('should walk a message through every tick, stamping each state', () => {
    const folded = foldQueue([
      enqueued(),
      moved('m1', 'typing', 1),
      moved('m1', 'delivered', 2),
      moved('m1', 'read', 3),
    ]);

    should(folded).deepEqual([message({ state: 'read', stateAt: at(3) })]);
  });

  it('should not move a message where it cannot go, whatever order the lines are in', () => {
    const folded = foldQueue([enqueued(), moved('m1', 'delivered', 1), moved('m1', 'read', 2)]);

    should(folded[0]?.state).equal('queued');
  });

  it('should end a wait on every move, and say why a message failed', () => {
    const waiting: QueueEvent = { v: 1, kind: 'waiting', at: at(1), id: 'm1', reason: 'draft' };
    const backAgain = foldQueue([enqueued(), waiting, moved('m1', 'typing', 2), moved('m1', 'queued', 3)]);
    const failed = foldQueue([enqueued({ waitReason: 'busy' }), moved('m1', 'failed', 4, 'the session ended')]);
    const failedQuietly = foldQueue([enqueued(), moved('m1', 'failed', 4)]);

    should(backAgain[0]).deepEqual(message({ state: 'queued', stateAt: at(3) }));
    should(failed[0]).deepEqual(message({ state: 'failed', stateAt: at(4), failure: 'the session ended' }));
    should(failedQuietly[0]).not.have.property('failure');
  });

  it('should drop the wait reason when the message moves on', () => {
    const folded = foldQueue([enqueued({ waitReason: 'unreadable' }), moved('m1', 'typing', 1)]);
    const back = foldQueue([enqueued({ waitReason: 'unreadable' }), moved('m1', 'cancelled', 1)]);

    should(folded[0]).not.have.property('waitReason');
    should(back[0]).not.have.property('waitReason');
    should(foldQueue([enqueued({ waitReason: 'unreadable' }), moved('m1', 'failed', 1)])[0]).not.have.property(
      'waitReason',
    );
  });

  it('should set and clear a wait reason only while the message waits', () => {
    const set: QueueEvent = { v: 1, kind: 'waiting', at: at(1), id: 'm1', reason: 'question' };
    const cleared: QueueEvent = { v: 1, kind: 'waiting', at: at(2), id: 'm1' };

    should(foldQueue([enqueued(), set])[0]?.waitReason).equal('question');
    should(foldQueue([enqueued(), set, cleared])[0]).not.have.property('waitReason');
    should(foldQueue([enqueued(), moved('m1', 'typing', 1), set])[0]).not.have.property('waitReason');
  });

  it('should apply an edit only to a waiting message, and only as the next revision', () => {
    const edit = (revision: number, text: string): QueueEvent => ({
      v: 1,
      kind: 'edited',
      at: at(1),
      id: 'm1',
      text,
      revision,
    });

    should(foldQueue([enqueued(), edit(2, 'ship it now')])[0]).containEql({ text: 'ship it now', revision: 2 });
    should(foldQueue([enqueued(), edit(3, 'skipped a revision')])[0]).containEql({ text: 'ship it', revision: 1 });
    should(foldQueue([enqueued(), moved('m1', 'typing', 1), edit(2, 'too late')])[0]?.text).equal('ship it');
  });
});

describe('the transitions a message may make', () => {
  it('should type only from queued, and go back only from a typing that typed nothing', () => {
    should(canMove('queued', 'typing')).be.true();
    should(canMove('typing', 'queued')).be.true();
    should(canMove('delivered', 'queued')).be.false();
    should(canMove('queued', 'delivered')).be.false();
  });

  it('should treat read, cancelled and failed as final', () => {
    should(['read', 'cancelled', 'failed'].every(state => isFinal(state as QueuedMessage['state']))).be.true();
    should(isFinal('queued')).be.false();
    should(isFinal('delivered')).be.false();
  });
});

describe('a queue line on disk', () => {
  it('should parse each event kind, and refuse a line that is not one', () => {
    const lines = [
      enqueued(),
      moved('m1', 'typing', 1),
      { v: 1, kind: 'waiting', at: at(1), id: 'm1', reason: 'busy' },
    ];

    for (const line of lines) should(QueueEventSchema.safeParse(JSON.parse(JSON.stringify(line))).success).be.true();
    should(
      QueueEventSchema.safeParse({ v: 1, kind: 'moved', at: at(1), id: 'm1', state: 'sideways' }).success,
    ).be.false();
    should(
      QueueEventSchema.safeParse({ v: 1, kind: 'edited', at: at(1), id: 'm1', text: 'x', revision: 1 }).success,
    ).be.false();
  });
});
