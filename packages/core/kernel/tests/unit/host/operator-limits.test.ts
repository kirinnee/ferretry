/** The two operator variables `fyd` reads once at boot: the housekeeping delay and the watchdog's limit. */
import { expect, test } from 'bun:test';
import { DEFAULT_BACKGROUND_DELAY_MS } from '../../../host/jobs.ts';
import { DEFAULT_WATCHDOG_LIMIT_MS } from '../../../host/loop-health.ts';
import { operatorLimits } from '../../../host/operator-limits.ts';

test('with neither variable set, both are their defaults', () => {
  expect(operatorLimits({})).toEqual({
    ok: true,
    backgroundDelayMs: DEFAULT_BACKGROUND_DELAY_MS,
    watchdogLimitMs: DEFAULT_WATCHDOG_LIMIT_MS,
  });
});

test('each variable is read in whole seconds, and the watchdog can be switched off with 0', () => {
  expect(operatorLimits({ FYD_BACKGROUND_DELAY_SECONDS: '7', FYD_WATCHDOG_SECONDS: '0' })).toEqual({
    ok: true,
    backgroundDelayMs: 7_000,
    watchdogLimitMs: 0,
  });
});

test('a value that is not whole seconds refuses the boot with a sentence naming the variable', () => {
  expect(operatorLimits({ FYD_WATCHDOG_SECONDS: '5m' })).toEqual({
    ok: false,
    sentence: 'FYD_WATCHDOG_SECONDS must be a whole number of seconds: 5m',
  });
  const refused = operatorLimits({ FYD_BACKGROUND_DELAY_SECONDS: 'soon' });
  expect(refused.ok).toBe(false);
  expect(refused.ok ? '' : refused.sentence).toContain('FYD_BACKGROUND_DELAY_SECONDS');
});
