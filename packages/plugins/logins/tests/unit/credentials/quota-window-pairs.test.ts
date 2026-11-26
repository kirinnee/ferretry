import { describe, expect, it } from 'bun:test';
import { usageBars, usageBarText } from '../../../app/lib/logins-view.ts';
import { parseCodexRateLimits, parseCodexUsageBody } from '../../../daemon/lib/credentials/quota.ts';
import { login } from '../cli/fakes.ts';

/** What a source says about one window's length. */
type Kind = 'long' | 'short' | 'unknown' | 'absent';
const KINDS: readonly Kind[] = ['long', 'short', 'unknown', 'absent'];

/**
 * Who ends up in each slot, by NAME of the source window (the percent identifies it: primary 11, secondary 22).
 * A known length always wins; a window with no length is NEVER the long window, and only the primary may take the
 * short slot by position, when no known window has it. Anything else with no length is left out.
 */
type Who = 'primary' | 'secondary' | undefined;
const EXPECTED: Record<string, readonly [short: Who, long: Who]> = {
  'long+long': [undefined, 'primary'],
  'long+short': ['secondary', 'primary'],
  'long+unknown': [undefined, 'primary'],
  'long+absent': [undefined, 'primary'],
  'short+long': ['primary', 'secondary'],
  'short+short': ['primary', undefined],
  'short+unknown': ['primary', undefined],
  'short+absent': ['primary', undefined],
  'unknown+long': ['primary', 'secondary'],
  'unknown+short': ['secondary', undefined],
  'unknown+unknown': ['primary', undefined],
  'unknown+absent': ['primary', undefined],
  'absent+long': [undefined, 'secondary'],
  'absent+short': ['secondary', undefined],
  'absent+unknown': [undefined, undefined],
};

const PERCENT = { primary: 11, secondary: 22 } as const;
const RESET = 1_786_500_000;

/** A rollout `rate_limits` window: length in minutes. */
const rollout = (kind: Kind, percent: number): Record<string, unknown> | undefined =>
  kind === 'absent'
    ? undefined
    : {
        used_percent: percent,
        resets_at: RESET,
        ...(kind === 'long' ? { window_minutes: 10_080 } : kind === 'short' ? { window_minutes: 300 } : {}),
      };

/** The usage endpoint's window: length in seconds. */
const wham = (kind: Kind, percent: number): Record<string, unknown> | undefined =>
  kind === 'absent'
    ? undefined
    : {
        used_percent: percent,
        reset_at: RESET,
        ...(kind === 'long'
          ? { limit_window_seconds: 604_800 }
          : kind === 'short'
            ? { limit_window_seconds: 18_000 }
            : {}),
      };

const slotsOf = (reading: ReturnType<typeof parseCodexRateLimits>): [number | undefined, number | undefined] => [
  reading.shortWindow?.usedPercent,
  reading.longWindow?.usedPercent,
];

const percentOf = (who: Who): number | undefined => (who === undefined ? undefined : PERCENT[who]);

describe('every pair of Codex windows: a known length always beats position', () => {
  for (const primary of KINDS) {
    for (const secondary of KINDS) {
      const key = `${primary}+${secondary}`;
      const expected = EXPECTED[key];
      if (expected === undefined) continue;
      const [short, long] = expected;
      const wanted = [percentOf(short), percentOf(long)];

      it(`should slot a ${primary} primary beside a ${secondary} secondary by length (rollout)`, () => {
        // Act
        const reading = parseCodexRateLimits({
          primary: rollout(primary, PERCENT.primary),
          secondary: rollout(secondary, PERCENT.secondary),
        });

        // Assert
        expect(slotsOf(reading)).toEqual(wanted as [number | undefined, number | undefined]);
      });

      it(`should slot a ${primary} primary_window beside a ${secondary} secondary_window by length (usage body)`, () => {
        // Act
        const reading = parseCodexUsageBody(
          {
            rate_limit: {
              primary_window: wham(primary, PERCENT.primary),
              secondary_window: wham(secondary, PERCENT.secondary),
            },
          },
          1_000,
        );

        // Assert
        expect(slotsOf(reading)).toEqual(wanted as [number | undefined, number | undefined]);
      });

      it(`should label a ${primary} primary beside a ${secondary} secondary correctly on the page`, () => {
        // Arrange: the usage a login shows is exactly the two slots.
        const reading = parseCodexRateLimits({
          primary: rollout(primary, PERCENT.primary),
          secondary: rollout(secondary, PERCENT.secondary),
        });
        const view = login({
          usage: {
            fiveHour: reading.shortWindow ? { usedPercent: reading.shortWindow.usedPercent } : {},
            weekly: reading.longWindow ? { usedPercent: reading.longWindow.usedPercent } : {},
          },
        });

        // Act
        const text = (usageBars(view, 0) ?? []).map(usageBarText);

        // Assert
        const five = wanted[0] === undefined ? '5h: not measured yet' : `5h: ${wanted[0]}% used`;
        const week = wanted[1] === undefined ? 'Week: not measured yet' : `Week: ${wanted[1]}% used`;
        // Nothing measured at all is said in words by the page, not drawn as two empty bars.
        expect(text).toEqual(wanted.every(percent => percent === undefined) ? [] : [five, week]);
      });
    }
  }

  it('should never put a window with no length in the long slot, whatever it sits beside', () => {
    // Arrange: every pair, through both inputs, with the unknown window's percent searched for in the long slot.
    for (const primary of KINDS) {
      for (const secondary of KINDS) {
        const rollouts = parseCodexRateLimits({
          primary: rollout(primary, PERCENT.primary),
          secondary: rollout(secondary, PERCENT.secondary),
        });
        const usage = parseCodexUsageBody(
          {
            rate_limit: {
              primary_window: wham(primary, PERCENT.primary),
              secondary_window: wham(secondary, PERCENT.secondary),
            },
          },
          1_000,
        );

        // Assert
        for (const reading of [rollouts, usage]) {
          if (primary === 'unknown') expect(reading.longWindow?.usedPercent).not.toBe(PERCENT.primary);
          if (secondary === 'unknown') expect(reading.longWindow?.usedPercent).not.toBe(PERCENT.secondary);
        }
      }
    }
  });

  it('should name the base mislabel: a known 5h secondary pushed an unknown primary onto the Week bar', () => {
    // Act
    const reading = parseCodexRateLimits({
      primary: { used_percent: 40, resets_at: RESET },
      secondary: { used_percent: 3, window_minutes: 300, resets_at: RESET },
    });
    const view = login({
      usage: {
        fiveHour: reading.shortWindow ? { usedPercent: reading.shortWindow.usedPercent } : {},
        weekly: reading.longWindow ? { usedPercent: reading.longWindow.usedPercent } : {},
      },
    });

    // Assert: the page shows the 5h reading and no Week figure at all.
    expect((usageBars(view, 0) ?? []).map(usageBarText)).toEqual(['5h: 3% used', 'Week: not measured yet']);
  });

  it('should leave a lone window with no length off the Week bar', () => {
    // Act
    const reading = parseCodexRateLimits({ secondary: { used_percent: 30, resets_at: RESET } });

    // Assert
    expect(reading.longWindow).toBeUndefined();
    expect(reading.hasQuotaSignal).toBe(false);
  });
});
