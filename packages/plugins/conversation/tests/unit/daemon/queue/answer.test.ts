import { describe, it } from 'bun:test';
import should from 'should';
import { answerOf, type SendRecord } from '../../../../daemon/seams/index.ts';
import { at } from '../../../support/instant.ts';

const AT = at('2026-10-30T17:00:00.000Z');
const record = (overrides: Partial<SendRecord>): SendRecord => ({
  sendId: 'm1',
  acceptedAt: AT,
  acceptedTurn: 3,
  path: 'direct',
  message: 'ship it',
  fate: 'accepted',
  ...overrides,
});

describe('what a queued send is answered', () => {
  it('should say queued while the message still waits in the queue', () => {
    should(answerOf(undefined)).deepEqual({ disposition: 'queued', fate: 'accepted' });
  });

  it('should say what the hand-over did, as the direct path said it', () => {
    should(answerOf(record({}))).deepEqual({ disposition: 'delivered', fate: 'accepted' });
    should(answerOf(record({ path: 'native-inline', fate: 'queued' }))).deepEqual({
      disposition: 'queued',
      fate: 'queued',
    });
    should(answerOf(record({ path: 'native-inline' })).disposition).equal('sent');
    should(answerOf(record({ path: 'revive', held: true })).disposition).equal('queued-for-revive');
    should(answerOf(record({ fate: 'withdrawn' })).fate).equal('accepted');
  });
});

describe('B144: a message still in Ferretry’s queue says why', () => {
  it('should carry the queue’s reason, and the send of ours it waits behind', () => {
    should(answerOf(undefined, { state: 'queued', waitReason: 'draft', waitBehind: 'send-0' })).deepEqual({
      disposition: 'queued',
      fate: 'accepted',
      waitReason: 'draft',
      waitBehind: 'send-0',
    });
    should(answerOf(undefined, { state: 'queued', waitReason: 'question' })).deepEqual({
      disposition: 'queued',
      fate: 'accepted',
      waitReason: 'question',
    });
  });

  it('should say no reason once a key has gone, or while it is being typed', () => {
    should(answerOf(undefined, { state: 'typing' })).deepEqual({ disposition: 'queued', fate: 'accepted' });
    should(answerOf(record({}), { state: 'queued', waitReason: 'draft' })).deepEqual({
      disposition: 'delivered',
      fate: 'accepted',
    });
  });
});
