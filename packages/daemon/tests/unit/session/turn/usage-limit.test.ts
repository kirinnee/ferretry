import { describe, it } from 'bun:test';
import type { HarnessDialog } from '@ferretry/protocol';
import should from 'should';
import {
  limitPatch,
  limitedQuota,
  parseContinueAt,
  usageLimitOf,
} from '../../../../src/lib/session/turn/usage-limit.ts';

/** A session parked on "You've hit your … limit" is a spent login — and nothing here ever picks an option. */

const NOW = new Date(2026, 9, 30, 6, 0).getTime();
const NOTICE = "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit";

const dialog = (over: Partial<HarnessDialog> = {}): HarnessDialog => ({
  id: '0123456789abcdef',
  harness: 'claude',
  selected: 1,
  kind: 'usage-limit',
  title: 'What do you want to do?',
  body: NOTICE,
  options: [
    { number: 1, label: 'Stop and wait for limit to reset', grantsTrust: false },
    { number: 2, label: 'Wait here, then continue automatically at Nov 1, 12am', grantsTrust: false },
    { number: 3, label: 'Ask your admin for more usage', grantsTrust: false },
  ],
  ...over,
});

describe('parseContinueAt', () => {
  it('should read the harness local-time label, midnight and noon included', () => {
    // Act / Assert
    should(parseContinueAt('continue automatically at Nov 1, 12am', NOW)).equal(new Date(2026, 10, 1, 0, 0).getTime());
    should(parseContinueAt('continue automatically at Nov 1, 12pm', NOW)).equal(new Date(2026, 10, 1, 12, 0).getTime());
    should(parseContinueAt('continue automatically at Nov 2, 3:30pm', NOW)).equal(
      new Date(2026, 10, 2, 15, 30).getTime(),
    );
  });

  it('should roll to next year when the date has passed, and tolerate any other text', () => {
    // Act / Assert
    should(parseContinueAt('continue automatically at Jan 5, 9am', NOW)).equal(new Date(2027, 0, 5, 9, 0).getTime());
    should(parseContinueAt('Stop and wait for limit to reset', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Nov 40, 12am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Xyz 1, 12am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Nov 1, 13am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Feb 31, 9am', NOW)).be.undefined();
  });
});

describe('usageLimitOf', () => {
  it('should carry the notice, the spend flag and the reset time', () => {
    // Act
    const limit = usageLimitOf(dialog(), NOW);

    // Assert
    should(limit).deepEqual({ notice: NOTICE, spend: true, retryAt: new Date(2026, 10, 1, 0, 0).getTime() });
  });

  it('should tolerate a missing time and a non-spend limit', () => {
    // Act
    const limit = usageLimitOf(
      dialog({ body: "You've hit your session limit", options: [{ number: 1, label: 'Stop', grantsTrust: false }] }),
      NOW,
    );

    // Assert
    should(limit).deepEqual({ notice: "You've hit your session limit", spend: false });
  });

  it('should read nothing from any other dialog', () => {
    should(usageLimitOf(dialog({ kind: 'other' }), NOW)).be.undefined();
    should(usageLimitOf(undefined, NOW)).be.undefined();
  });
});

describe('limitedQuota', () => {
  it('should mark a spend limit unavailable with its reason, keeping other quota fields', () => {
    // Act
    const quota = limitedQuota({ retryAt: 1 }, { notice: 'n', spend: true, retryAt: 99 });

    // Assert
    should(quota).deepEqual({
      atLimit: true,
      unavailable: true,
      unavailableReason: 'spend_limit',
      retryAt: 99,
      resetAt: 99,
    });
  });

  it('should only say at-limit for a usage window with no known reset', () => {
    should(limitedQuota(undefined, { notice: 'n', spend: false })).deepEqual({ atLimit: true });
  });
});

describe('limitPatch', () => {
  it('should rate limit a running session parked on the dialog', () => {
    // Act
    const patch = limitPatch({ status: 'running' }, dialog(), NOW);

    // Assert
    should(patch?.status).equal('rate_limited');
    should(patch?.quota?.atLimit).be.true();
    should(patch?.quota?.retryAt).equal(new Date(2026, 10, 1, 0, 0).getTime());
  });

  it('should release only a session it limited itself, once the dialog is gone', () => {
    // Arrange
    const limited = { status: 'rate_limited' as const, quota: { atLimit: true }, harnessDialog: dialog() };

    // Act
    const released = limitPatch(limited, undefined, NOW);
    const foreign = limitPatch({ status: 'rate_limited', quota: { atLimit: true } }, undefined, NOW);

    // Assert
    should(released).deepEqual({ status: 'running', quota: undefined });
    should(foreign).be.undefined();
  });

  it('should change nothing for an ordinary running session', () => {
    should(limitPatch({ status: 'running' }, undefined, NOW)).be.undefined();
  });
});
