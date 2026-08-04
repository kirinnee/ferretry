import { describe, it } from 'bun:test';
import should from 'should';
import { headroom, quotaExhaustionReason, snapshotRefusal } from '../../../src/lib/quota-failover/index.ts';
import { healthyRow, spentRow, usageRow } from './fixtures.ts';

describe('quotaExhaustionReason', () => {
  it('should quote the measurement when the feed says the account is at its limit', () => {
    // Act
    const reason = quotaExhaustionReason(spentRow('agent-a', { fiveHourPercent: 100, weeklyPercent: 82 }));

    // Assert — a human reading that a session moved must be able to see the reading it moved on
    should(reason).equal('the usage feed measured agent-a at its limit (5h 100%, weekly 82%)');
  });

  it('should still report a limit the feed could not put a number on', () => {
    // Act
    const reason = quotaExhaustionReason(usageRow('agent-a', { ok: true, authOk: true, atLimit: true }));

    // Assert
    should(reason).equal('the usage feed measured agent-a at its limit');
  });

  it.each([
    { label: 'a cooling-down provider', why: 'cooldown' as const, phrase: 'cooldown' },
    { label: 'a spend limit', why: 'spend_limit' as const, phrase: 'spend limit' },
  ])('should treat $label as running out of tokens', ({ why, phrase }) => {
    // Arrange
    const row = usageRow('agent-a', { ok: true, authOk: true, unavailable: true, unavailableReason: why });

    // Act / Assert
    should(quotaExhaustionReason(row)).equal(`the provider reports agent-a unavailable for ${phrase}`);
  });

  it('should say nothing when the account has no feed row at all', () => {
    // Arrange / Act / Assert — the account may be perfectly fine and simply unlisted
    should(quotaExhaustionReason(undefined)).be.undefined();
  });

  it('should say nothing when the probe itself failed', () => {
    // Arrange — a transport error makes every other field unknown, not bad; migrating on it would
    // destroy a pane over a collector outage
    const row = usageRow('agent-a', { ok: false, atLimit: true });

    // Act / Assert
    should(quotaExhaustionReason(row)).be.undefined();
  });

  it('should say nothing when the credentials were rejected', () => {
    // Arrange — a human has to log in; moving the session hides the account that needs attention
    const row = usageRow('agent-a', { ok: true, authOk: false, atLimit: true });

    // Act / Assert
    should(quotaExhaustionReason(row)).be.undefined();
  });

  it.each([{ why: 'auth' as const }, { why: 'provider' as const }, { why: 'no_credentials' as const }])(
    'should not treat a provider that is down for $why as out of tokens',
    ({ why }) => {
      // Arrange
      const row = usageRow('agent-a', { ok: true, authOk: true, unavailable: true, unavailableReason: why });

      // Act / Assert
      should(quotaExhaustionReason(row)).be.undefined();
    },
  );

  it('should say nothing about an account the feed scored as healthy', () => {
    // Arrange / Act / Assert
    should(quotaExhaustionReason(healthyRow('agent-a', 12))).be.undefined();
  });

  it('should say nothing when the provider is unavailable for no stated reason', () => {
    // Arrange — an unexplained outage is not evidence about tokens
    const row = usageRow('agent-a', { ok: true, authOk: true, unavailable: true });

    // Act / Assert
    should(quotaExhaustionReason(row)).be.undefined();
  });
});

describe('headroom', () => {
  it('should confirm an account the feed positively scored below the ceiling', () => {
    // Act
    const verdict = headroom(healthyRow('agent-b', 20), 80);

    // Assert
    should(verdict).deepEqual({ confirmed: true, spentPercent: 20 });
  });

  it('should refuse an account the feed has never scored', () => {
    // Arrange / Act
    const verdict = headroom(undefined, 80);

    // Assert — moving into an unscored account is how a session lands on a second exhausted one
    should(verdict).deepEqual({ confirmed: false, reason: 'the usage feed has no reading for this account' });
  });

  it('should refuse an account whose atLimit was never stated, not merely one that is at its limit', () => {
    // Arrange — `confirmedUsableAccount` demands an EXPLICIT false, so silence fails
    const verdict = headroom(usageRow('agent-b', { ok: true, authOk: true, fiveHourPercent: 5 }), 80);

    // Act / Assert
    should(verdict).deepEqual({
      confirmed: false,
      reason: 'the usage feed has not confirmed this account can take work',
    });
  });

  it('should refuse an account with a stated problem in the words a fleet operator can act on', () => {
    // Arrange / Act
    const verdict = headroom(usageRow('agent-b', { ok: true, authOk: false, atLimit: false }), 80);

    // Assert
    should(verdict).deepEqual({ confirmed: false, reason: 'the account is not authenticated' });
  });

  it('should refuse an account whose consumption is simply unknown', () => {
    // Arrange — an unmeasured account used to sort ahead of every measured one because absence read
    // as zero; unknown must fail even though nothing says the account is bad
    const verdict = headroom(usageRow('agent-b', { ok: true, authOk: true, atLimit: false }), 80);

    // Act / Assert
    should(verdict).deepEqual({
      confirmed: false,
      reason: 'the usage feed reports no measured consumption for this account',
    });
  });

  it('should refuse an account that is under its limit but above the ceiling', () => {
    // Arrange — 97% is minutes from being the next exhausted account
    const verdict = headroom(healthyRow('agent-b', 97), 80);

    // Act / Assert
    should(verdict).deepEqual({
      confirmed: false,
      reason: 'measured at 97% of its tighter window, which is not below the 80% headroom ceiling',
    });
  });

  it('should refuse an account measured exactly at the ceiling', () => {
    // Arrange / Act / Assert — the ceiling is a floor to be strictly below
    should(headroom(healthyRow('agent-b', 80), 80).confirmed).be.false();
  });
});

describe('snapshotRefusal', () => {
  it('should accept a snapshot inside the freshness ceiling', () => {
    // Arrange / Act / Assert
    should(snapshotRefusal(1_000, 6_000, 10_000)).be.undefined();
  });

  it('should refuse a feed that has never collected anything', () => {
    // Arrange / Act — absent is not "now": nothing has ever been read
    const refusal = snapshotRefusal(undefined, 6_000, 10_000);

    // Assert
    should(refusal).equal(
      'the usage feed has never collected a snapshot, so no account can be shown to be out of tokens',
    );
  });

  it('should refuse a snapshot past the ceiling, and say how old it is', () => {
    // Arrange / Act
    const refusal = snapshotRefusal(0, 61_000, 60_000);

    // Assert
    should(refusal).equal('the usage snapshot is 61s old, past the 60s freshness ceiling');
  });

  it('should accept a snapshot exactly at the ceiling', () => {
    // Arrange / Act / Assert
    should(snapshotRefusal(0, 60_000, 60_000)).be.undefined();
  });
});
