/**
 * How a provider quota reads in a login's detail page: money and the time until a window rolls over. Unknown is not
 * zero — a caller draws nothing for a window nobody measured.
 */

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
