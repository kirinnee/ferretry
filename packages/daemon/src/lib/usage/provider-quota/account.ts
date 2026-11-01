/**
 * A provider quota reading in the two shapes the rest of the daemon already speaks: the credential
 * row's 5-hour and weekly windows, and the usage feed's account row — so the composer chip, Info ›
 * Usage, the logins list, the Warden all read the one reading.
 *
 * Pure. A window the provider did not measure stays absent, never 0%.
 */
import type {
  AccountUsage,
  FleetCredentialUsage,
  FleetCredentialUsageWindow,
  ProviderQuotaReading,
} from '@ferretry/protocol';

const windowNamed = (reading: ProviderQuotaReading, label: '5h' | 'week') =>
  reading.windows.find(window => window.label === label);

function credentialWindow(reading: ProviderQuotaReading, label: '5h' | 'week'): FleetCredentialUsageWindow {
  const window = windowNamed(reading, label);
  return {
    ...(window?.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
    ...(window?.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

/**
 * A credential row's usage with its provider reading laid in: the reading itself, and — when the
 * row's own windows were never measured — the reading's 5-hour and weekly windows in their place.
 */
export function withProviderQuota(
  usage: FleetCredentialUsage,
  reading: ProviderQuotaReading | undefined,
): FleetCredentialUsage {
  if (reading === undefined) return usage;
  if (usage.source !== undefined) return { ...usage, provider: reading };
  return {
    fiveHour: credentialWindow(reading, '5h'),
    weekly: credentialWindow(reading, 'week'),
    ...(reading.via === 'endpoint' ? { source: 'provider-quota' as const } : {}),
    at: reading.at,
    provider: reading,
  };
}

const percent = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.min(100, value);

const epoch = (instant: string | undefined): number | undefined =>
  instant === undefined ? undefined : Date.parse(instant);

/**
 * The feed-row fields one reading states. Only what it states: a reading with no window says nothing
 * about the windows, and `atLimit` is said only when the provider itself answered.
 */
export function providerAccountFields(reading: ProviderQuotaReading): Partial<AccountUsage> {
  const five = windowNamed(reading, '5h');
  const week = windowNamed(reading, 'week');
  const fiveHourPercent = percent(five?.usedPercent);
  const weeklyPercent = percent(week?.usedPercent);
  const fiveHourResetAt = epoch(five?.resetsAt);
  const weeklyResetAt = epoch(week?.resetsAt);
  return {
    ...(fiveHourPercent === undefined ? {} : { fiveHourPercent }),
    ...(weeklyPercent === undefined ? {} : { weeklyPercent }),
    ...(fiveHourResetAt === undefined ? {} : { fiveHourResetAt }),
    ...(weeklyResetAt === undefined ? {} : { weeklyResetAt }),
    ...(reading.via === 'endpoint' ? { atLimit: reading.exhausted } : {}),
    ...(reading.balance === undefined ? {} : { balance: reading.balance }),
    ...(reading.spend === undefined ? {} : { spendUsd: reading.spend.amountUsd }),
  };
}
