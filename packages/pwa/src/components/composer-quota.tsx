import type { ResolvedQuota } from '../lib/usage.ts';

/** The fields a quota readout needs; a resolved feed row and a session's own reading both carry them. */
type Quota = Pick<ResolvedQuota, 'fiveHourPercent' | 'weeklyPercent' | 'atLimit' | 'authOk'>;

export interface ComposerQuotaProps {
  /** Account use supplied by this session's paired daemon; it is never global. `null` is unknown. */
  readonly quota?: Quota | null;
}

/** Display form for one known quota window. */
export const composerQuotaPercent = (value: number): string => `${Math.max(0, Math.min(100, Math.round(value)))}%`;

/** A window's value only when the daemon actually reported a finite number for it. */
const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

const quotaTone = (value: number, atLimit: boolean): string => {
  if (atLimit || value >= 90) return ' fy-quota-error';
  if (value >= 75) return ' fy-quota-warning';
  return '';
};

export const composerQuotaSpoken = (quota?: Quota | null): string => {
  if (quota?.authOk === false) return 'Account usage unavailable: this wrapper needs logging in.';
  const five = quota?.fiveHourPercent;
  const week = quota?.weeklyPercent;
  const limit = quota?.atLimit === true ? ' Account is at limit; work is blocked until the window resets.' : '';
  if (!known(five) && !known(week))
    return `Account usage unknown: the daemon has no reading for this account yet.${limit}`;
  const fiveCopy = known(five) ? `${composerQuotaPercent(five)} used` : 'unknown';
  const weekCopy = known(week) ? `${composerQuotaPercent(week)} used` : 'unknown';
  return `Account usage: 5-hour window ${fiveCopy}; weekly window ${weekCopy}.${limit}`;
};

/**
 * The account's quota on the composer's context row.
 *
 * ONLY WHAT IS KNOWN IS DRAWN. A window the daemon has no number for is left out rather than drawn as
 * `—`: a dash beside a label reads as "nothing used", the one confident claim nobody made. With no
 * number for either window the row says so in words — `usage unknown` — and the spoken form says why.
 */
export function ComposerQuota({ quota }: ComposerQuotaProps) {
  const authFailed = quota?.authOk === false;
  const atLimit = !authFailed && quota?.atLimit === true;
  const five = authFailed ? undefined : quota?.fiveHourPercent;
  const week = authFailed ? undefined : quota?.weeklyPercent;
  const spoken = composerQuotaSpoken(quota);
  const windows = [
    ...(known(five) ? [{ key: '5h', value: five }] : []),
    ...(known(week) ? [{ key: 'wk', value: week }] : []),
  ];

  return (
    <span
      className="fy-composer-quota"
      data-quota={authFailed ? 'auth' : windows.length === 0 ? 'unknown' : 'known'}
      title={spoken}
    >
      <span className="sr-only">{spoken}</span>
      {authFailed ? (
        <span aria-hidden="true" className="fy-quota-warning">
          quota auth!
        </span>
      ) : windows.length === 0 ? (
        <span aria-hidden="true" className={atLimit ? 'fy-quota-error' : 'text-faint'}>
          {atLimit ? 'at limit' : 'usage unknown'}
        </span>
      ) : (
        <span aria-hidden="true">
          {windows.map((entry, index) => (
            <span key={entry.key}>
              {index === 0 ? null : <span className="fy-quota-divider">·</span>}
              <span className={quotaTone(entry.value, atLimit)}>
                {`${entry.key} ${composerQuotaPercent(entry.value)}`}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
