import { describe, expect, test } from 'bun:test';
import { reviveOffer, reviveRuling } from '../../../../app/features/header/revive-offer.ts';

describe('reviveRuling', () => {
  test('a stopped ferret can come back, and says whether it had finished', () => {
    expect(reviveRuling({ state: 'stopped' })).toEqual({
      offered: true,
      reason: 'It was stopped. Resume relaunches its CLI on the same conversation.',
    });
    expect(reviveRuling({ state: 'stopped', finishedAt: '2026-01-01T00:00:00.000Z' as never }).reason).toBe(
      'It finished. Resume relaunches its CLI on the same conversation.',
    );
  });

  test('a ferret that is starting or running cannot', () => {
    expect(reviveRuling({ state: 'starting' })).toEqual({ offered: false, reason: 'It is starting.' });
    expect(reviveRuling({ state: 'working' })).toEqual({ offered: false, reason: 'It is still running.' });
    expect(reviveRuling({ state: 'idle' })).toEqual({ offered: false, reason: 'It is still running.' });
  });
});

describe('reviveOffer', () => {
  test('a connection that cannot change anything is never offered Resume, whatever the ferret says', () => {
    expect(reviveOffer({ state: 'stopped' }, false)).toEqual({
      offered: false,
      reason: 'This connection can look but not change anything.',
    });
  });

  test('a connection that can change things reads the ruling', () => {
    expect(reviveOffer({ state: 'stopped' }, true).offered).toBe(true);
    expect(reviveOffer({ state: 'idle' }, true).offered).toBe(false);
  });
});
