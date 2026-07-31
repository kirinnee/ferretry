import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { renderUsageMetrics } from '../../../src/lib/api/index.ts';

const NOW = 1_700_000_000_000;

const lines = (text: string): readonly string[] => text.split('\n');
const sample = (text: string, name: string): readonly string[] =>
  lines(text).filter(line => line.startsWith(`${name} `) || line.startsWith(`${name}{`));

describe('renderUsageMetrics with no snapshot', () => {
  const rendered = renderUsageMetrics(undefined, NOW);

  it('should report the feed as not ready', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_usage_feed_ready')).deepEqual(['ferretry_usage_feed_ready 0']);
  });

  it('should report an age of -1 rather than dropping the series', () => {
    // A metric that disappears reads as a scrape gap; a documented -1 is something to alert on.
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_usage_snapshot_age_seconds')).deepEqual([
      'ferretry_usage_snapshot_age_seconds -1',
    ]);
  });

  it('should still declare every family so nothing vanishes between scrapes', () => {
    // Arrange / Act / Assert
    should(lines(rendered).filter(line => line.startsWith('# HELP'))).have.length(13);
    should(lines(rendered).filter(line => line.startsWith('# TYPE'))).have.length(13);
  });

  it('should report zero accounts', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_accounts_total')).deepEqual(['ferretry_accounts_total 0']);
  });

  it('should end with exactly one trailing newline', () => {
    // A scraper rejects a document whose last line is unterminated.
    // Arrange / Act / Assert
    should(rendered.endsWith('\n')).be.true();
    should(rendered.endsWith('\n\n')).be.false();
  });
});

describe('renderUsageMetrics with a snapshot', () => {
  const account: AccountUsage = {
    agent: 'auto-loge',
    provider: 'anthropic',
    ok: true,
    usageBased: true,
    availability: 'available',
    atLimit: false,
    authOk: true,
    fiveHourPercent: 42,
    weeklyPercent: 7.5,
    fiveHourResetAt: NOW + 3_600_000,
    weeklyResetAt: NOW + 86_400_000,
    retryAt: null,
  };
  const rendered = renderUsageMetrics({ at: NOW - 30_000, accounts: [account] }, NOW);

  it('should report the age of the snapshot in seconds', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_usage_snapshot_age_seconds')).deepEqual([
      'ferretry_usage_snapshot_age_seconds 30',
    ]);
  });

  it('should label every per-account series by agent and provider', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_account_usage_based')).deepEqual([
      'ferretry_account_usage_based{agent="auto-loge",provider="anthropic"} 1',
    ]);
  });

  it('should publish the windowed utilizations', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_account_usage_5h_percent')).deepEqual([
      'ferretry_account_usage_5h_percent{agent="auto-loge",provider="anthropic"} 42',
    ]);
    should(sample(rendered, 'ferretry_account_usage_weekly_percent')).deepEqual([
      'ferretry_account_usage_weekly_percent{agent="auto-loge",provider="anthropic"} 7.5',
    ]);
  });

  it('should convert reset instants from milliseconds to Unix seconds', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_account_usage_5h_reset_seconds')).deepEqual([
      `ferretry_account_usage_5h_reset_seconds{agent="auto-loge",provider="anthropic"} ${(NOW + 3_600_000) / 1_000}`,
    ]);
  });

  it('should publish availability as a gauge', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_account_available')).deepEqual([
      'ferretry_account_available{agent="auto-loge",provider="anthropic"} 1',
    ]);
  });

  it('should omit a null reset instant rather than publishing zero', () => {
    // Arrange / Act / Assert
    should(sample(rendered, 'ferretry_account_retry_at_seconds')).deepEqual([]);
  });

  it('should never report a negative age when the clock moves backwards', () => {
    // Arrange / Act
    const skewed = renderUsageMetrics({ at: NOW + 5_000, accounts: [] }, NOW);

    // Assert
    should(sample(skewed, 'ferretry_usage_snapshot_age_seconds')).deepEqual(['ferretry_usage_snapshot_age_seconds 0']);
  });
});

describe('renderUsageMetrics field handling', () => {
  it('should publish nothing windowed for an account whose probe failed', () => {
    // A failed probe must not publish a stale or invented number.
    // Arrange
    const failed: AccountUsage = { agent: 'a', ok: false, fiveHourPercent: 99, weeklyPercent: 99 };

    // Act
    const rendered = renderUsageMetrics({ at: NOW, accounts: [failed] }, NOW);

    // Assert
    should(sample(rendered, 'ferretry_account_usage_5h_percent')).deepEqual([]);
    should(sample(rendered, 'ferretry_account_usage_ok')).deepEqual([
      'ferretry_account_usage_ok{agent="a",provider=""} 0',
    ]);
  });

  it('should omit a flag the upstream did not report at all', () => {
    // Arrange
    const sparse: AccountUsage = { agent: 'a' };

    // Act
    const rendered = renderUsageMetrics({ at: NOW, accounts: [sparse] }, NOW);

    // Assert
    should(sample(rendered, 'ferretry_account_auth_ok')).deepEqual([]);
    should(sample(rendered, 'ferretry_account_at_limit')).deepEqual([]);
    should(sample(rendered, 'ferretry_account_available')).deepEqual([]);
  });

  it('should render an unavailable account as zero, not as absent', () => {
    // Arrange
    const blocked: AccountUsage = { agent: 'a', availability: 'unavailable', atLimit: true };

    // Act
    const rendered = renderUsageMetrics({ at: NOW, accounts: [blocked] }, NOW);

    // Assert
    should(sample(rendered, 'ferretry_account_available')).deepEqual([
      'ferretry_account_available{agent="a",provider=""} 0',
    ]);
    should(sample(rendered, 'ferretry_account_at_limit')).deepEqual([
      'ferretry_account_at_limit{agent="a",provider=""} 1',
    ]);
  });

  it('should escape a label value that would otherwise break the line', () => {
    // Arrange
    const hostile: AccountUsage = { agent: 'a"b\\c\nd\re', usageBased: false };

    // Act
    const rendered = renderUsageMetrics({ at: NOW, accounts: [hostile] }, NOW);

    // Assert
    should(sample(rendered, 'ferretry_account_usage_based')).deepEqual([
      'ferretry_account_usage_based{agent="a\\"b\\\\c\\nd\\re",provider=""} 0',
    ]);
  });

  it('should drop a duplicate label set, which would otherwise void the whole scrape', () => {
    // Prometheus rejects an entire scrape that repeats a series; the source never deduplicated.
    // Arrange
    const accounts: readonly AccountUsage[] = [
      { agent: 'a', provider: 'p', usageBased: true },
      { agent: 'a', provider: 'p', usageBased: false },
      { agent: 'a', provider: 'q', usageBased: false },
    ];

    // Act
    const rendered = renderUsageMetrics({ at: NOW, accounts }, NOW);

    // Assert
    should(sample(rendered, 'ferretry_account_usage_based')).deepEqual([
      'ferretry_account_usage_based{agent="a",provider="p"} 1',
      'ferretry_account_usage_based{agent="a",provider="q"} 0',
    ]);
    should(sample(rendered, 'ferretry_accounts_total')).deepEqual(['ferretry_accounts_total 2']);
  });
});
