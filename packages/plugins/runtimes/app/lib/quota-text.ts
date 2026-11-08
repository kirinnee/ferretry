/**
 * HOW A RUNTIME'S QUOTA READS in the account picker, from Usage's own contract rows (`UsageAccountView`).
 *
 * Usage owns the fact (what each login has left) and its screens; this module only words one row for a small chip on
 * a picker button. Three rules the feed already settles and this must not undo:
 *   - unknown is not zero: a row with nothing measured says nothing, never "0%";
 *   - an auth failure is not a quota: `authOk === false` says the login needs signing in;
 *   - AT LIMIT is the state that stops work, so it leads and takes the error tone.
 */

import type { UsageAccountView } from '@ferretry/plugin-usage/contract';

/** Money as a person reads it: "$12.34". An unknown currency code is written out. */
export function formatQuotaMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Humanised time until a window rolls over: "47m", "3h 10m", "2d". */
export function quotaResetsIn(at: number | undefined, now: number): string | null {
  if (at == null) return null;
  const ms = at - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours < 10 && minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type QuotaTone = 'muted' | 'warn' | 'err';

/** One fact of a runtime's quota: the words on the chip and, on hover, when it resets. */
export interface QuotaPart {
  readonly text: string;
  readonly tone: QuotaTone;
  readonly title?: string;
}

const percentTone = (percent: number): QuotaTone => (percent >= 90 ? 'err' : percent >= 75 ? 'warn' : 'muted');

const windowPart = (
  name: string,
  percent: number | undefined,
  resetAt: number | undefined,
  now: number,
): QuotaPart[] => {
  if (percent === undefined) return [];
  const resets = quotaResetsIn(resetAt, now);
  return [
    {
      text: `${name} ${String(Math.round(percent))}%`,
      tone: percentTone(percent),
      ...(resets === null ? {} : { title: `resets in ${resets}` }),
    },
  ];
};

/** The facts this row states, in reading order. Empty when it states none, and then nothing is drawn. */
export function quotaParts(row: UsageAccountView | null, now: number): readonly QuotaPart[] {
  if (row === null) return [];
  if (row.authOk === false) return [{ text: 'sign-in needed', tone: 'err' }];
  const parts: QuotaPart[] = [];
  if (row.atLimit === true) parts.push({ text: 'at limit', tone: 'err' });
  parts.push(
    ...windowPart('5h', row.fiveHourPercent, row.fiveHourResetAt, now),
    ...windowPart('wk', row.weeklyPercent, row.weeklyResetAt, now),
  );
  if (row.balance !== undefined) {
    parts.push({ text: `${formatQuotaMoney(row.balance.amount, row.balance.currency)} left`, tone: 'muted' });
  } else if (row.spendUsd !== undefined && parts.length === 0) {
    parts.push({ text: `${formatQuotaMoney(row.spendUsd, 'USD')} this month`, tone: 'muted' });
  }
  return parts;
}
