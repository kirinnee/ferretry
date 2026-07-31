import type { SessionView } from '@ferretry/protocol';

type Quota = NonNullable<SessionView['state']['quota']>;

export interface ComposerQuotaProps {
  /** Account use supplied by this session's paired daemon; it is never global. */
  readonly quota?: Quota | null;
}

/** Honest display form for one daemon-reported quota window. */
export const composerQuotaPercent = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
};

const quotaTone = (value: number | undefined, atLimit: boolean): string => {
  if (atLimit || (value ?? 0) >= 90) return ' fy-quota-error';
  if ((value ?? 0) >= 75) return ' fy-quota-warning';
  return '';
};

export const composerQuotaSpoken = (quota?: Quota | null): string => {
  if (quota?.authOk === false) return 'Account usage unavailable: this wrapper needs logging in.';
  const five = quota?.fiveHourPercent;
  const week = quota?.weeklyPercent;
  const fiveCopy = five === undefined ? 'unknown' : `${composerQuotaPercent(five)} used`;
  const weekCopy = week === undefined ? 'unknown' : `${composerQuotaPercent(week)} used`;
  const limit = quota?.atLimit === true ? ' Account is at limit; work is blocked until the window resets.' : '';
  return `Account usage: 5-hour window ${fiveCopy}; weekly window ${weekCopy}.${limit}`;
};

/**
 * The composer context row is intentionally shape-stable: it always reserves
 * room for both windows, so a delayed quota response never makes it jump.
 */
export function ComposerQuota({ quota }: ComposerQuotaProps) {
  const authFailed = quota?.authOk === false;
  const atLimit = !authFailed && quota?.atLimit === true;
  const five = authFailed ? undefined : quota?.fiveHourPercent;
  const week = authFailed ? undefined : quota?.weeklyPercent;
  const spoken = composerQuotaSpoken(quota);

  return (
    <span className="fy-composer-quota" title={spoken}>
      <span className="sr-only">{spoken}</span>
      {authFailed ? (
        <span aria-hidden="true" className="fy-quota-warning">
          quota auth!
        </span>
      ) : (
        <span aria-hidden="true">
          <span className={quotaTone(five, atLimit)}>5h {composerQuotaPercent(five)}</span>
          <span className="fy-quota-divider">·</span>
          <span className={quotaTone(week, atLimit)}>wk {composerQuotaPercent(week)}</span>
        </span>
      )}
    </span>
  );
}
