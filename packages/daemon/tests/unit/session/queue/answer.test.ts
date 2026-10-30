import { describe, it } from 'bun:test';
import should from 'should';
import { answerOf, type SendRecord } from '../../../../src/lib/index.ts';

const AT = '2026-10-30T17:00:00.000Z';
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
