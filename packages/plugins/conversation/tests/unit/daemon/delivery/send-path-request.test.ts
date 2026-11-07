import { describe, it } from 'bun:test';
import type { QueuedMessage } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import { requestOf } from '../../../../daemon/queue/adapters/send-path-delivery.ts';
import { at } from '../../../support/instant.ts';

/** How a queue delivery becomes the one request the send path takes: a single message as it is, a batch folded together. */

const message = (id: string, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'agent',
  from: `session-${id}`,
  text: `text ${id}`,
  attachmentIds: [],
  enqueuedAt: at('2026-08-01T12:00:00.000Z'),
  state: 'queued',
  stateAt: at('2026-08-01T12:00:00.000Z'),
  revision: 1,
  ...over,
});

describe('the send path request for a queue delivery', () => {
  it('sends one message as it is, under its own id, with its label and no parts', () => {
    const request = requestOf({ sendId: 'a', members: [message('a', { label: 'blocker', replyExpected: true })] });
    should(request).eql({
      sendId: 'a',
      message: 'text a',
      replyExpected: true,
      label: 'blocker',
      senderReference: 'session-a',
    });
  });

  it('keeps the person and the daemon unlabelled, and passes an interrupt on', () => {
    should(requestOf({ sendId: 'p', members: [message('p', { sender: 'human', interrupt: true })] })).eql({
      sendId: 'p',
      message: 'text p',
      now: true,
    });
    should(requestOf({ sendId: 'd', members: [message('d', { sender: 'daemon' })] })).eql({
      sendId: 'd',
      message: 'text d',
      origin: 'daemon',
    });
  });

  it('folds a batch into one request under the oldest id, one part per member in order', () => {
    const request = requestOf({
      sendId: 'a',
      members: [message('a', { label: 'action' }), message('b', { replyExpected: true, label: 'blocker' })],
    });
    should(request.sendId).equal('a');
    should(request.message).equal('text a\n\ntext b');
    should(request.parts).eql([
      { queueId: 'a', senderReference: 'session-a', text: 'text a', replyExpected: false, label: 'action' },
      { queueId: 'b', senderReference: 'session-b', text: 'text b', replyExpected: true, label: 'blocker' },
    ]);
    should(request.replyExpected).equal(true);
    should(request.now).be.undefined();
  });

  it('interrupts when any member does, and takes the union of attachments once each', () => {
    const request = requestOf({
      sendId: 'a',
      members: [
        message('a', { attachmentIds: ['f1', 'f2'] }),
        message('b', { interrupt: true, attachmentIds: ['f2', 'f3'] }),
      ],
    });
    should(request.now).equal(true);
    should(request.attachmentIds).eql(['f1', 'f2', 'f3']);
  });

  it('refuses an empty delivery', () => {
    should(() => requestOf({ sendId: 'a', members: [] })).throw();
  });
});
