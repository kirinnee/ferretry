import type { SessionView } from '@ferretry/protocol';

type Quota = NonNullable<SessionView['state']['quota']>;

export interface QuotaReadoutProps {
  /** The daemon's own account reading for this session; never infer it globally. */
  readonly quota?: Quota | null;
  /** Table and list cells reserve this space, so absence must be visible rather than read as zero. */
  readonly showUnknown?: boolean;
  readonly className?: string;
}

const displayPercent = (value: number | undefined): string => (value === undefined ? '—' : `${Math.round(value)}%`);

const quotaTone = (value: number | undefined, atLimit: boolean): string => {
  if (atLimit || (value ?? 0) >= 90) return ' fy-quota-error';
  if ((value ?? 0) >= 75) return ' fy-quota-warning';
  return '';
};

/**
 * The original fleet list makes account use explicit: unknown is not 0%, and
 * an authentication failure is not a quota limit. This receives a session's
 * daemon-owned reading, so identically named sessions cannot borrow another
 * paired daemon's account state.
 */
export function QuotaReadout({ quota, showUnknown = false, className = '' }: QuotaReadoutProps) {
  const classes = `fy-quota-readout${className ? ` ${className}` : ''}`;
  if (!quota) {
    return showUnknown ? <span className={`${classes} fy-quota-muted`}>quota —</span> : null;
  }
  if (quota.authOk === false) {
    return (
      <span
        className={`${classes} fy-quota-warning`}
        title="This wrapper is not logged in — account usage is unavailable. Sign it in on this daemon’s Accounts panel, under Settings › Daemons › Fleet."
      >
        quota auth!
      </span>
    );
  }

  const five = quota.fiveHourPercent;
  const week = quota.weeklyPercent;
  const atLimit = quota.atLimit === true;
  if (five === undefined && week === undefined && !atLimit) {
    return showUnknown ? <span className={`${classes} fy-quota-muted`}>quota —</span> : null;
  }
  const title = [
    five === undefined ? null : `5-hour window ${displayPercent(five)} used`,
    week === undefined ? null : `weekly window ${displayPercent(week)} used`,
    atLimit ? 'This account is at limit — work is blocked until its quota resets' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={classes} title={title}>
      {five === undefined ? null : <span className={quotaTone(five, atLimit)}>5h {displayPercent(five)}</span>}
      {five !== undefined && week !== undefined ? <span className="fy-quota-divider">·</span> : null}
      {week === undefined ? null : <span className={quotaTone(week, atLimit)}>wk {displayPercent(week)}</span>}
      {atLimit ? <span className="fy-quota-limit">at limit</span> : null}
    </span>
  );
}
