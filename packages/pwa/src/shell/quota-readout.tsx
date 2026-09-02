/**
 * Account quota (5-hour + weekly window) for the wrapper a session runs under.
 * Ported from kteam `ui/src/components/QuotaBadge.tsx`.
 *
 * One rendering, used by the chat header, the fleet table, the session card and
 * the folder sidebar, because "how much of this account is left" is the same
 * fact everywhere. Numbers are percent USED — same polarity as context, so
 * higher is worse.
 *
 * Three rules the daemon side already enforces and this must not undo:
 *   - unknown is not zero. A wrapper with no usage record renders an explicit
 *     "quota —", never a confident "0%".
 *   - an auth failure is not a quota. `authOk === false` means the wrapper
 *     needs logging in, which is a different problem and says so.
 *   - AT LIMIT is not merely "100%". It is the state that stops work, so it
 *     takes the one piece of real colour and weight in this component.
 *
 * Muted by default: this is reference information, not an alert. It only takes
 * colour once a window is actually running out.
 */

import type { SessionState } from '@ferretry/protocol';
import { cn } from '../lib/class-names.ts';

/** The daemon's per-wrapper quota record, as it rides on session state. */
export type Quota = NonNullable<SessionState['quota']>;

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

function tone(percent: number): string {
  return percent >= 90 ? 'text-err' : percent >= 75 ? 'text-warn' : '';
}

function Unknown({ className }: { readonly className: string }) {
  return (
    <span
      className={cn('mono shrink-0 text-faint', className)}
      title="the fleet reports no usage for this wrapper (API-key accounts have no quota window)"
    >
      quota —
    </span>
  );
}

export interface QuotaReadoutProps {
  readonly quota: Quota | null;
  readonly className?: string;
  readonly showUnknown?: boolean;
  /**
   * Injected rather than read from the clock inside the component: the reset
   * copy is rendered output, and output a test cannot pin is output the 100%
   * ledger cannot prove.
   */
  readonly now?: number;
}

/**
 * `quota` null means nothing is known about this wrapper.
 *
 * `showUnknown` decides what that means HERE. In a table cell or a sidebar row
 * the column exists either way, so an explicit em-dash is the honest fill; in
 * the chat header an absent readout should simply take no space.
 */
export function QuotaReadout({ quota, className = '', showUnknown = false, now = Date.now() }: QuotaReadoutProps) {
  if (!quota) return showUnknown ? <Unknown className={className} /> : null;

  if (quota.authOk === false) {
    return (
      <span
        className={cn('mono shrink-0 text-warn', className)}
        title="this wrapper is not logged in — the fleet reports no usage. Sign it in on this daemon’s Accounts panel, under Settings › Daemons › Fleet."
      >
        quota auth!
      </span>
    );
  }

  const five = quota.fiveHourPercent;
  const week = quota.weeklyPercent;
  // At-limit with no percentages is still the most important thing to say, so
  // it is not folded into the unknown case.
  if (five == null && week == null && quota.atLimit !== true) {
    return showUnknown ? <Unknown className={className} /> : null;
  }

  const fiveIn = quotaResetsIn(quota.fiveHourResetAt, now);
  const weekIn = quotaResetsIn(quota.weeklyResetAt, now);
  const title = [
    five == null ? null : `5-hour window ${five}% used${fiveIn ? ` · resets in ${fiveIn}` : ''}`,
    week == null ? null : `weekly window ${week}% used${weekIn ? ` · resets in ${weekIn}` : ''}`,
    quota.atLimit ? 'this account is AT LIMIT — work is blocked until the window resets' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={cn('mono inline-flex shrink-0 items-center gap-1', className)} title={title}>
      {five != null && <span className={tone(five)}>5h {five}%</span>}
      {five != null && week != null && <span className="text-border">·</span>}
      {week != null && <span className={tone(week)}>wk {week}%</span>}
      {quota.atLimit && <span className="kt-label rounded-badge bg-err-bg px-1 text-err">at limit</span>}
    </span>
  );
}
