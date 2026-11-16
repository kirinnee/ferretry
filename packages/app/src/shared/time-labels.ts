/** Words for a status and a time, shared by every surface that shows one (today's `session-screens.ts`, those functions). */

/** A status in words, for every surface that shows one: `rate_limited` reads "rate limited". */
export const statusLabel = (status: string): string => status.replaceAll('_', ' ');

export const relativeTime = (at: number | string | undefined, now = Date.now()): string => {
  if (!at) return '—';
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * An exact local timestamp, `yyyy-MM-dd HH:mm:ss`.
 *
 * A send-ledger row is evidence about when something was accepted, so it shows the instant rather than a relative
 * phrase that ages while you read it. An unparseable value is shown verbatim instead of being replaced by a dash: it
 * is data the daemon sent, and hiding it would hide the skew that produced it.
 */
export const absoluteTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};
