import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import { boardOnly, deliveryOrder, nextToDeliver } from '../../../../src/lib/index.ts';

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 30, 13, 0, seconds)).toISOString();

function message(
  id: string,
  sender: QueuedMessage['sender'],
  seconds: number,
  state: QueuedMessage['state'] = 'queued',
) {
  return {
    v: 1,
    id,
    sender,
    text: id,
    attachmentIds: [],
    enqueuedAt: at(seconds),
    state,
    stateAt: at(seconds),
    revision: 1,
  } satisfies QueuedMessage;
}

describe('who goes first', () => {
  it("should deliver the owner's message before any ferret's, and a ferret's before the daemon's", () => {
    // Nine Warden notices were typed ahead of the owner's message on 2026-10-30.
    const queue = [
      message('warden-1', 'daemon', 0),
      message('peer-1', 'agent', 1),
      message('warden-2', 'daemon', 2),
      message('owner-1', 'human', 3),
      message('peer-2', 'agent', 4),
    ];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql([
      'owner-1',
      'peer-1',
      'peer-2',
      'warden-1',
      'warden-2',
    ]);
  });

  it('should keep acceptance order within one sender, even for messages accepted in the same instant', () => {
    const queue = [message('b', 'human', 5), message('a', 'human', 5), message('c', 'human', 1)];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql(['c', 'b', 'a']);
  });

  it('should leave out every message that is not waiting', () => {
    const queue = [
      message('typing', 'human', 0, 'typing'),
      message('done', 'human', 0, 'delivered'),
      message('gone', 'human', 0, 'cancelled'),
      message('next', 'agent', 1),
    ];

    should(deliveryOrder(queue, 'auto').map(entry => entry.id)).eql(['next']);
  });
});

describe("the owner's own chat", () => {
  it('should never type a daemon notice into an interactive session', () => {
    const queue = [message('warden', 'daemon', 0), message('peer', 'agent', 1)];

    should(boardOnly(queue[0] as QueuedMessage, 'interactive')).be.true();
    should(boardOnly(queue[0] as QueuedMessage, 'auto')).be.false();
    should(boardOnly(queue[1] as QueuedMessage, 'interactive')).be.false();
    should(deliveryOrder(queue, 'interactive').map(entry => entry.id)).eql(['peer']);
  });

  it('should type a daemon notice made for the chat into it, as a message of its own', () => {
    const board = { ...message('board', 'daemon', 0), chat: true };

    should(boardOnly(board, 'interactive')).be.false();
    should(deliveryOrder([board], 'interactive').map(entry => entry.id)).eql(['board']);
  });
});

describe('one at a time', () => {
  it('should type nothing while another message is being typed', () => {
    const queue = [message('typing', 'agent', 0, 'typing'), message('owner', 'human', 1)];

    should(nextToDeliver(queue, 'auto')).be.undefined();
  });

  it('should hand over the first in order, or nothing when nothing waits', () => {
    const queue = [message('peer', 'agent', 0), message('owner', 'human', 1)];

    should(nextToDeliver(queue, 'auto')?.id).equal('owner');
    should(nextToDeliver([], 'auto')).be.undefined();
  });
});
