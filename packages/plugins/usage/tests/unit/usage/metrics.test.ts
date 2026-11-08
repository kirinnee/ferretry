import { describe, expect, test } from 'bun:test';
import type { AccountUsage } from '../../../contract/index.ts';
import { renderUsageMetrics } from '../../../daemon/lib/usage/metrics.ts';

const NOW = 1_700_000_100_000;
const lines = (text: string): string[] => text.split('\n').filter(line => line !== '');
const samples = (text: string, name: string): string[] =>
  lines(text).filter(line => line.startsWith(`ferretry_${name}{`) || line.startsWith(`ferretry_${name} `));

describe('renderUsageMetrics', () => {
  test('before any collection: every family is there with no account samples, ready 0 and age -1', () => {
    const text = renderUsageMetrics(undefined, NOW);
    expect(text.endsWith('\n')).toBe(true);
    expect(samples(text, 'usage_feed_ready')).toEqual(['ferretry_usage_feed_ready 0']);
    expect(samples(text, 'usage_snapshot_age_seconds')).toEqual(['ferretry_usage_snapshot_age_seconds -1']);
    expect(samples(text, 'accounts_total')).toEqual(['ferretry_accounts_total 0']);
    expect(lines(text).filter(line => line.startsWith('# TYPE'))).toHaveLength(13);
    expect(text).toContain('# HELP ferretry_account_usage_ok ');
    expect(text).toContain('# TYPE ferretry_account_usage_ok gauge');
    expect(text).not.toContain('{agent=');
  });

  test('a snapshot publishes its age in whole seconds, never below zero', () => {
    expect(samples(renderUsageMetrics({ at: NOW - 90_400, accounts: [] }, NOW), 'usage_snapshot_age_seconds')).toEqual([
      'ferretry_usage_snapshot_age_seconds 90',
    ]);
    expect(samples(renderUsageMetrics({ at: NOW + 5_000, accounts: [] }, NOW), 'usage_snapshot_age_seconds')).toEqual([
      'ferretry_usage_snapshot_age_seconds 0',
    ]);
  });

  test('a probed account publishes its flags, windows and reset instants (milliseconds become seconds)', () => {
    const account: AccountUsage = {
      agent: 'claude-main',
      provider: 'anthropic',
      ok: true,
      usageBased: true,
      authOk: true,
      atLimit: false,
      availability: 'available',
      fiveHourPercent: 42,
      weeklyPercent: 7.5,
      fiveHourResetAt: 1_700_000_500_400,
      weeklyResetAt: 1_700_900_000_000,
      retryAt: 1_700_000_200_000,
    };
    const text = renderUsageMetrics({ at: NOW, accounts: [account] }, NOW);
    const label = '{agent="claude-main",provider="anthropic"}';
    expect(samples(text, 'accounts_total')).toEqual(['ferretry_accounts_total 1']);
    expect(samples(text, 'account_usage_based')).toEqual([`ferretry_account_usage_based${label} 1`]);
    expect(samples(text, 'account_usage_ok')).toEqual([`ferretry_account_usage_ok${label} 1`]);
    expect(samples(text, 'account_auth_ok')).toEqual([`ferretry_account_auth_ok${label} 1`]);
    expect(samples(text, 'account_at_limit')).toEqual([`ferretry_account_at_limit${label} 0`]);
    expect(samples(text, 'account_available')).toEqual([`ferretry_account_available${label} 1`]);
    expect(samples(text, 'account_usage_5h_percent')).toEqual([`ferretry_account_usage_5h_percent${label} 42`]);
    expect(samples(text, 'account_usage_weekly_percent')).toEqual([
      `ferretry_account_usage_weekly_percent${label} 7.5`,
    ]);
    expect(samples(text, 'account_usage_5h_reset_seconds')).toEqual([
      `ferretry_account_usage_5h_reset_seconds${label} 1700000500`,
    ]);
    expect(samples(text, 'account_usage_weekly_reset_seconds')).toEqual([
      `ferretry_account_usage_weekly_reset_seconds${label} 1700900000`,
    ]);
    expect(samples(text, 'account_retry_at_seconds')).toEqual([`ferretry_account_retry_at_seconds${label} 1700000200`]);
  });

  test('a failed probe publishes no window or reset, and an unavailable account reads 0', () => {
    const account: AccountUsage = {
      agent: 'codex-a',
      ok: false,
      availability: 'unavailable',
      fiveHourPercent: 99,
      weeklyPercent: null,
      fiveHourResetAt: 1_700_000_000_000,
      retryAt: 1_700_000_000_000,
    };
    const text = renderUsageMetrics({ at: NOW, accounts: [account] }, NOW);
    expect(samples(text, 'account_usage_ok')).toEqual(['ferretry_account_usage_ok{agent="codex-a",provider=""} 0']);
    expect(samples(text, 'account_available')).toEqual(['ferretry_account_available{agent="codex-a",provider=""} 0']);
    for (const name of [
      'account_usage_5h_percent',
      'account_usage_weekly_percent',
      'account_usage_5h_reset_seconds',
      'account_usage_weekly_reset_seconds',
      'account_retry_at_seconds',
      'account_usage_based',
      'account_auth_ok',
      'account_at_limit',
    ])
      expect(samples(text, name)).toEqual([]);
  });

  test('two accounts with the same labels publish once, the first kept, so a scrape is never rejected', () => {
    const text = renderUsageMetrics(
      {
        at: NOW,
        accounts: [
          { agent: 'same', provider: 'p', ok: true },
          { agent: 'same', provider: 'p', ok: false },
          { agent: 'other', provider: 'p', ok: true },
        ],
      },
      NOW,
    );
    expect(samples(text, 'accounts_total')).toEqual(['ferretry_accounts_total 2']);
    expect(samples(text, 'account_usage_ok')).toEqual([
      'ferretry_account_usage_ok{agent="same",provider="p"} 1',
      'ferretry_account_usage_ok{agent="other",provider="p"} 1',
    ]);
  });

  test('label values escape backslash, quote, newline and carriage return', () => {
    const text = renderUsageMetrics({ at: NOW, accounts: [{ agent: 'a\\b"c\nd\re', ok: true }] }, NOW);
    expect(samples(text, 'account_usage_ok')).toEqual([
      'ferretry_account_usage_ok{agent="a\\\\b\\"c\\nd\\re",provider=""} 1',
    ]);
    expect(text.split('\n').every(line => !line.includes('\r'))).toBe(true);
  });
});
