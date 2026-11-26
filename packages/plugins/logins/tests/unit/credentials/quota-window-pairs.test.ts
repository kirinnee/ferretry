import { describe, expect, it } from 'bun:test';
import { usageBars, usageBarText } from '../../../app/lib/logins-view.ts';
import { parseCodexRateLimits, parseCodexUsageBody } from '../../../daemon/lib/credentials/quota.ts';
import { login } from '../cli/fakes.ts';

/** What a source says about one window's length. */
type Kind = 'long' | 'short' | 'unknown' | 'absent';
const KINDS: readonly Kind[] = ['long', 'short', 'unknown', 'absent'];

/** Who ends up in each slot, by NAME of the source window (the percent identifies it: primary 11, secondary 22). */
type Who = 'primary' | 'secondary' | undefined;
const EXPECTED: Record<string, readonly [short: Who, long: Who]> = {
  'long+long': [undefined, 'primary'],
  'long+short': ['secondary', 'primary'],
  'long+unknown': ['secondary', 'primary'],
  'long+absent': [undefined, 'primary'],
  'short+long': ['primary', 'secondary'],
  'short+short': ['primary', undefined],
  'short+unknown': ['primary', 'secondary'],
  'short+absent': ['primary', undefined],
  'unknown+long': ['primary', 'secondary'],
  'unknown+short': ['secondary', 'primary'],
  'unknown+unknown': ['primary', 'secondary'],
  'unknown+absent': ['primary', undefined],
  'absent+long': [undefined, 'secondary'],
  'absent+short': ['secondary', undefined],
  'absent+unknown': [undefined, 'secondary'],
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
        expect(text).toEqual([five, week]);
      });
    }
  }

  it('should name the base mislabel: a known weekly primary beside a window with no length is never the 5h bar', () => {
    // Act
    const reading = parseCodexRateLimits({
      primary: { used_percent: 40, window_minutes: 10_080, resets_at: RESET },
      secondary: { used_percent: 3, resets_at: RESET },
    });

    // Assert
    expect(reading.longWindow?.usedPercent).toBe(40);
    expect(reading.shortWindow?.usedPercent).toBe(3);
  });
});
