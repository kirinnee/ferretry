import type { AccountUsage } from '@ferretry/protocol';
import type { UsageSnapshot } from '../usage/types.ts';

/**
 * Prometheus text rendering for the account-usage feed.
 *
 * This is the surface the host's metrics agent scrapes, so it is a contract with something outside
 * the repository. Everything here is a pure function of a snapshot and the current instant; the
 * feed does the collecting and a scrape never triggers one.
 */

const PREFIX = 'ferretry';

/** Escapes a label value per the exposition format: backslash, double quote and newline. Carriage
 *  returns are escaped too — the format has no literal control characters in a label, and the
 *  source's escaper let a `\r` through and corrupted the line for the scraper. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Renders a float the way the exposition format wants it: no exponent surprises, no `NaN`. */
function renderNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'NaN';
}

interface Family {
  readonly name: string;
  readonly help: string;
  readonly samples: readonly string[];
}

function renderFamily(family: Family): readonly string[] {
  return [`# HELP ${PREFIX}_${family.name} ${family.help}`, `# TYPE ${PREFIX}_${family.name} gauge`, ...family.samples];
}

function labelsFor(account: AccountUsage): string {
  return `agent="${escapeLabel(account.agent)}",provider="${escapeLabel(account.provider ?? '')}"`;
}

/**
 * Drops accounts that would produce a duplicate label set, keeping the first.
 *
 * Prometheus rejects an ENTIRE scrape that repeats a series, so two accounts sharing an agent name
 * and provider would have silently blanked every fleet metric. The source never deduplicated.
 */
function distinctAccounts(accounts: readonly AccountUsage[]): readonly AccountUsage[] {
  const seen = new Set<string>();
  const kept: AccountUsage[] = [];
  for (const account of accounts) {
    const labels = labelsFor(account);
    if (seen.has(labels)) continue;
    seen.add(labels);
    kept.push(account);
  }
  return kept;
}

/** A gauge sample per account, emitted only where `value` yields a number. */
function perAccount(accounts: readonly AccountUsage[], value: (account: AccountUsage) => number | undefined) {
  return (name: string, help: string): Family => ({
    name,
    help,
    samples: accounts.flatMap(account => {
      const sample = value(account);
      return sample === undefined ? [] : [`${PREFIX}_${name}{${labelsFor(account)}} ${renderNumber(sample)}`];
    }),
  });
}

const flag = (value: boolean | undefined): number | undefined => (value === undefined ? undefined : value ? 1 : 0);

/** Windowed percentages and reset instants are only meaningful when the probe succeeded; a failed
 *  probe must publish nothing rather than a stale or invented zero. */
const whenProbed = (account: AccountUsage, value: number | null | undefined): number | undefined =>
  account.ok === true && typeof value === 'number' ? value : undefined;

/** Reset instants are epoch MILLISECONDS on the wire and epoch SECONDS in Prometheus. */
const asEpochSeconds = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value / 1_000);

/**
 * Renders the whole `/metrics` document.
 *
 * `snapshot` is `undefined` when the feed has never completed a collection. That case publishes the
 * families with no samples and an age of -1 rather than omitting them: a scraper that suddenly sees
 * a metric disappear reports a gap, while a documented -1 is a signal it can alert on.
 */
export function renderUsageMetrics(snapshot: UsageSnapshot | undefined, nowMs: number): string {
  const accounts = distinctAccounts(snapshot?.accounts ?? []);
  const families: readonly Family[] = [
    {
      name: 'usage_feed_ready',
      help: 'Whether the usage feed has ever completed a collection (1) or not (0).',
      samples: [`${PREFIX}_usage_feed_ready ${snapshot === undefined ? 0 : 1}`],
    },
    {
      name: 'usage_snapshot_age_seconds',
      help: 'Seconds since the usage feed last completed a collection (-1 = never).',
      samples: [
        `${PREFIX}_usage_snapshot_age_seconds ${
          snapshot === undefined ? -1 : Math.max(0, Math.round((nowMs - snapshot.at) / 1_000))
        }`,
      ],
    },
    {
      name: 'accounts_total',
      help: 'Accounts in the most recent usage snapshot.',
      samples: [`${PREFIX}_accounts_total ${accounts.length}`],
    },
    perAccount(accounts, account => flag(account.usageBased))(
      'account_usage_based',
      'Whether the account is a usage-windowed subscription (1) or not (0).',
    ),
    perAccount(accounts, account => flag(account.ok))(
      'account_usage_ok',
      'Whether the last usage probe for this account succeeded (1) or failed (0).',
    ),
    perAccount(accounts, account => flag(account.authOk))(
      'account_auth_ok',
      'Whether the account holds valid credentials (1) or not (0). Absent when undeterminable.',
    ),
    perAccount(accounts, account => flag(account.atLimit))(
      'account_at_limit',
      'Whether the account is exhausted in either window (1) or not (0).',
    ),
    perAccount(accounts, account =>
      account.availability === undefined ? undefined : account.availability === 'available' ? 1 : 0,
    )('account_available', 'Whether the account is currently usable (1) or not (0).'),
    perAccount(accounts, account => whenProbed(account, account.fiveHourPercent))(
      'account_usage_5h_percent',
      'Utilization of the five-hour window (0-100).',
    ),
    perAccount(accounts, account => whenProbed(account, account.weeklyPercent))(
      'account_usage_weekly_percent',
      'Utilization of the weekly window (0-100).',
    ),
    perAccount(accounts, account => asEpochSeconds(whenProbed(account, account.fiveHourResetAt)))(
      'account_usage_5h_reset_seconds',
      'Unix time at which the five-hour window resets.',
    ),
    perAccount(accounts, account => asEpochSeconds(whenProbed(account, account.weeklyResetAt)))(
      'account_usage_weekly_reset_seconds',
      'Unix time at which the weekly window resets.',
    ),
    perAccount(accounts, account => asEpochSeconds(whenProbed(account, account.retryAt)))(
      'account_retry_at_seconds',
      'Unix time after which an unavailable account may be retried.',
    ),
  ];
  return `${families.flatMap(renderFamily).join('\n')}\n`;
}
