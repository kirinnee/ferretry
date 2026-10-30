import { describe, it } from 'bun:test';
import should from 'should';
import { quotaOf, quotaReason, shortInstant } from '../../../src/lib/pack/quota.ts';
import { credential } from './support.ts';

const NOW = '2026-10-22T12:00:00.000Z';

describe('quotaOf', () => {
  it('should read no credential, and a credential nobody measured, as unknown — never full or empty', () => {
    // Act
    const none = quotaOf(undefined, NOW);
    const unmeasured = quotaOf(credential('a'), NOW);

    // Assert
    should(none).deepEqual({ state: 'unknown', windows: [], summary: 'not measured' });
    should(unmeasured).deepEqual({ state: 'unknown', windows: [], summary: 'not measured' });
  });

  it('should band by the tightest window and word it as the app does', () => {
    // Arrange
    const usage = (fiveHour: number, weekly: number) =>
      credential('a', {
        usage: {
          fiveHour: { usedPercent: fiveHour, resetsAt: '2026-10-22T18:00:00.000Z' },
          weekly: { usedPercent: weekly, resetsAt: '2026-10-25T00:00:00.000Z' },
          at: '2026-10-22T11:00:00.000Z',
        },
      });

    // Act
    const plenty = quotaOf(usage(2, 46), NOW);
    const some = quotaOf(usage(10, 60), NOW);
    const low = quotaOf(usage(10, 91), NOW);

    // Assert
    should(plenty).deepEqual({
      state: 'plenty',
      leftPercent: 54,
      tightest: 'week',
      windows: [
        { label: '5h', usedPercent: 2, leftPercent: 98, resetsAt: '2026-10-22T18:00:00.000Z' },
        { label: 'week', usedPercent: 46, leftPercent: 54, resetsAt: '2026-10-25T00:00:00.000Z' },
      ],
      measuredAt: '2026-10-22T11:00:00.000Z',
      summary: '5h 2% · wk 46%',
    });
    should(some.state).equal('some');
    should(low.state).equal('low');
    should(low.leftPercent).equal(9);
  });

  it('should read a full window as exhausted until it resets, and fresh once its reset time has passed', () => {
    // Arrange
    const full = credential('a', {
      usage: { fiveHour: { usedPercent: 100, resetsAt: '2026-10-22T18:00:00.000Z' }, weekly: { usedPercent: 40 } },
    });

    // Act
    const before = quotaOf(full, NOW);
    const after = quotaOf(full, '2026-10-22T18:00:01.000Z');

    // Assert
    should(before.state).equal('exhausted');
    should(before.summary).equal('out of quota until 18:00Z');
    should(after.state).equal('plenty');
    should(after.windows[0]).deepEqual({ label: '5h', usedPercent: 0, leftPercent: 100, reset: true });
  });

  it('should assume no reset without a time to judge it by', () => {
    // Arrange
    const full = credential('a', {
      usage: { fiveHour: { usedPercent: 100, resetsAt: '2000-01-01T00:00:00.000Z' }, weekly: {} },
    });

    // Act + Assert
    should(quotaOf(full, undefined).state).equal('exhausted');
  });

  it("should hold the provider's own no until a window it reported has reset, and add its other windows once", () => {
    // Arrange
    const provider = (resetsAt: string) =>
      credential('a', {
        usage: {
          fiveHour: {},
          weekly: {},
          provider: {
            source: 'zai-coding-plan',
            via: 'endpoint',
            windows: [
              { label: '5h', usedPercent: 30 },
              { label: 'month', usedPercent: 100, resetsAt },
            ],
            exhausted: true,
            unverified: false,
            at: '2026-10-22T11:00:00.000Z',
          },
        },
      });

    // Act
    const held = quotaOf(provider('2026-11-01T00:00:00.000Z'), NOW);
    const lifted = quotaOf(provider('2026-10-22T06:00:00.000Z'), NOW);

    // Assert
    should(held.state).equal('exhausted');
    should(held.summary).equal('out of quota until Nov 1 00:00Z');
    should(held.windows.map(window => window.label)).deepEqual(['5h', 'month']);
    should(held.measuredAt).equal('2026-10-22T11:00:00.000Z');
    should(lifted.state).equal('plenty');
    should(lifted.summary).equal('5h 30% · mo 0%');
  });

  it('should word an exhaustion with no reset time plainly', () => {
    // Arrange
    const full = credential('a', { usage: { fiveHour: {}, weekly: { usedPercent: 120 } } });

    // Act + Assert
    should(quotaOf(full, NOW)).deepEqual({
      state: 'exhausted',
      leftPercent: 0,
      tightest: 'week',
      windows: [{ label: 'week', usedPercent: 120, leftPercent: 0 }],
      summary: 'out of quota',
    });
  });
});

describe('quotaReason', () => {
  it('should name the runtime and its tightest window, with its reset', () => {
    // Arrange
    const quota = quotaOf(
      credential('a', {
        usage: { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: 91, resetsAt: '2026-10-22T18:00:00.000Z' } },
      }),
      NOW,
    );

    // Act + Assert
    should(quotaReason('claude-kirin', quota, NOW)).equal('claude-kirin, 91% of the week used, resets 18:00Z');
    should(quotaReason('claude-x', { state: 'unknown', windows: [], summary: 'not measured' })).equal(
      'claude-x, not measured',
    );
  });
});

describe('shortInstant', () => {
  it('should give the time alone for today, the day too for another, and an unreadable instant as it is', () => {
    // Assert
    should(shortInstant('2026-10-22T18:00:00.000Z', NOW)).equal('18:00Z');
    should(shortInstant('2026-10-23T08:05:00.000Z', NOW)).equal('Oct 23 08:05Z');
    should(shortInstant('soon', NOW)).equal('soon');
  });
});

describe('quotaOf with a limit a pane proved', () => {
  it('should call the login exhausted until the reset, and say why', () => {
    // Act
    const quota = quotaOf(credential('a'), NOW, {
      notice: 'n',
      spend: true,
      retryAt: Date.parse('2026-11-01T00:00:00.000Z'),
    });

    // Assert
    should(quota.state).equal('exhausted');
    should(quota.summary).startWith('hit its spend limit until');
  });

  it('should call a limit with no time exhausted, and ignore one that has already reset', () => {
    // Act
    const open = quotaOf(credential('a'), NOW, { notice: 'n', spend: false });
    const over = quotaOf(credential('a'), NOW, {
      notice: 'n',
      spend: true,
      retryAt: Date.parse('2026-10-22T11:00:00.000Z'),
    });

    // Assert
    should(open.state).equal('exhausted');
    should(open.summary).equal('hit its usage limit');
    should(over.state).equal('unknown');
  });
});
