import { describe, it } from 'bun:test';
import should from 'should';
import * as queue from '../../src/lib/session-queue.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';

const oldMessage = {
  v: 1,
  id: 'm1',
  sender: 'agent',
  from: 'mvzy86cp-580b9904',
  fromName: 'Hadi',
  text: 'ship it',
  attachmentIds: [],
  enqueuedAt: INSTANT,
  state: 'queued',
  stateAt: INSTANT,
  revision: 1,
};

describe('a queued message', () => {
  it('should still parse when it carries none of the label, hold or batch fields', () => {
    // Act
    const parsed = queue.QueuedMessageSchema.parse(oldMessage);

    // Assert
    should(parsed.label).be.undefined();
    should(parsed.holdUntil).be.undefined();
    should(parsed.deliveredAs).be.undefined();
  });

  it('should keep a label, a hold and the id of the turn that carried it', () => {
    // Arrange
    const value = { ...oldMessage, label: 'fyi', holdUntil: LATER_INSTANT, deliveredAs: 'm0', state: 'delivered' };

    // Act
    const parsed = queue.QueuedMessageSchema.parse(value);

    // Assert
    should(parsed.label).equal('fyi');
    should(parsed.holdUntil).equal(LATER_INSTANT);
    should(parsed.deliveredAs).equal('m0');
  });

  it('should reject a label outside blocker, action and fyi', () => {
    should(queue.QueuedMessageSchema.safeParse({ ...oldMessage, label: 'urgent' }).success).be.false();
  });

  it('should reject an empty batch id', () => {
    should(queue.QueuedMessageSchema.safeParse({ ...oldMessage, deliveredAs: '' }).success).be.false();
  });
});
