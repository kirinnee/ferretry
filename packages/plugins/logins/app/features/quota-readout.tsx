/**
 * Account quota (5-hour + weekly window), one line per login, in the shell's status area (today's `QuotaReadout`,
 * ported over `login.usage`). Numbers are percent USED — higher is worse.
 *
 * Three rules the daemon side already enforces and this must not undo:
 *   - unknown is not zero. A login with no usage reading renders an explicit "quota —", never a confident "0%" — and a
 *     login nobody has checked yet (`checking`, `refresh_due`) is not "ready" either.
 *   - an auth failure is not a quota. A login that needs sign-in says so, which is a different problem.
 *   - AT LIMIT is not merely "100%". It is the state that stops work, so it takes the one piece of real colour.
 *
 * Muted by default: reference information, not an alert. It only takes colour once a window is running out.
 */

import { useEffect, useState } from 'react';
import type { LoginList, LoginView } from '../../contract/index.ts';
import { AccountStatus } from '../components/account-status.tsx';
import type { LoginsClient } from '../lib/client.ts';
import { readLogins } from '../lib/logins-api.ts';
import { loginName } from '../lib/logins-view.ts';
import { quotaMoneyText, quotaResetsIn } from '../lib/quota-text.ts';
import { cn } from '../ui.ts';

/** What the readout draws for one login. Every field is present only when something measured it. */
export interface LoginQuotaFacts {
  /** `false`: the login needs signing in, so there is no usage to report. */
  readonly authOk?: boolean;
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly fiveHourResetAt?: number;
  readonly weeklyResetAt?: number;
  readonly atLimit?: boolean;
  readonly balance?: { readonly amount: number; readonly currency: string };
  readonly spendUsd?: number;
}

const whole = (percent: number | undefined): number | undefined =>
  percent === undefined ? undefined : Math.round(percent);
const instantMs = (at: string | undefined): number | undefined => {
  if (at === undefined) return undefined;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
};

/** What a login's usage says, in the readout's terms. Nothing is invented: an unmeasured field is left out. */
export function quotaOf(login: LoginView): LoginQuotaFacts | null {
  if (login.status.word === 'needs_sign_in') return { authOk: false };
  const { fiveHour, weekly, provider } = login.usage;
  const five = whole(fiveHour.usedPercent);
  const week = whole(weekly.usedPercent);
  const fiveReset = instantMs(fiveHour.resetsAt);
  const weekReset = instantMs(weekly.resetsAt);
  const windows = provider?.windows ?? [];
  const providerFive = windows.find(window => window.label === '5h');
  const providerWeek = windows.find(window => window.label === 'week');
  const fivePercent = five ?? whole(providerFive?.usedPercent);
  const weekPercent = week ?? whole(providerWeek?.usedPercent);
  const atLimit =
    provider?.exhausted === true ||
    (fivePercent !== undefined && fivePercent >= 100) ||
    (weekPercent !== undefined && weekPercent >= 100);
  const spend = provider?.spend?.amountUsd;
  const facts: LoginQuotaFacts = {
    ...(fivePercent === undefined ? {} : { fiveHourPercent: fivePercent }),
    ...(weekPercent === undefined ? {} : { weeklyPercent: weekPercent }),
    ...(fiveReset === undefined ? {} : { fiveHourResetAt: fiveReset }),
    ...(weekReset === undefined ? {} : { weeklyResetAt: weekReset }),
    ...(atLimit ? { atLimit: true } : {}),
    ...(provider?.balance === undefined ? {} : { balance: provider.balance }),
    ...(spend === undefined ? {} : { spendUsd: spend }),
  };
  return Object.keys(facts).length === 0 ? null : facts;
}

const tone = (percent: number): string => (percent >= 90 ? 'text-err' : percent >= 75 ? 'text-warn' : '');

function Unknown({ className, note }: { readonly className: string; readonly note: string }) {
  return (
    <span className={cn('mono shrink-0 text-faint', className)} title={note}>
      quota —
    </span>
  );
}

export interface LoginQuotaProps {
  readonly quota: LoginQuotaFacts | null;
  readonly className?: string;
  readonly showUnknown?: boolean;
  /** Injected, so the reset copy is output a test can pin. */
  readonly now?: number;
}

/** `quota` null means nothing is known about this login. */
export function LoginQuota({ quota, className = '', showUnknown = false, now = Date.now() }: LoginQuotaProps) {
  const nothing = 'nothing has measured this login’s usage yet (an API-key login has no quota window)';
  if (!quota) return showUnknown ? <Unknown className={className} note={nothing} /> : null;

  if (quota.authOk === false) {
    return (
      <span
        className={cn('mono shrink-0 text-warn', className)}
        title="this login needs sign-in — no usage is reported. Sign it in under Settings › Logins."
      >
        quota auth!
      </span>
    );
  }

  const five = quota.fiveHourPercent;
  const week = quota.weeklyPercent;
  const money = quotaMoneyText(quota);
  if (five === undefined && week === undefined && quota.atLimit !== true) {
    if (money !== null) {
      return (
        <span className={cn('mono shrink-0 text-muted', className)} title={`login usage: ${money}`}>
          {money}
        </span>
      );
    }
    return showUnknown ? <Unknown className={className} note={nothing} /> : null;
  }

  const fiveIn = quotaResetsIn(quota.fiveHourResetAt, now);
  const weekIn = quotaResetsIn(quota.weeklyResetAt, now);
  const title = [
    five === undefined ? null : `5-hour window ${String(five)}% used${fiveIn ? ` · resets in ${fiveIn}` : ''}`,
    week === undefined ? null : `weekly window ${String(week)}% used${weekIn ? ` · resets in ${weekIn}` : ''}`,
    quota.atLimit ? 'this login is AT LIMIT — work is blocked until the window resets' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span className={cn('mono inline-flex shrink-0 items-center gap-1', className)} title={title}>
      {five !== undefined && <span className={tone(five)}>5h {five}%</span>}
      {five !== undefined && week !== undefined && <span className="text-border">·</span>}
      {week !== undefined && <span className={tone(week)}>wk {week}%</span>}
      {quota.atLimit && <span className="kt-label rounded-badge bg-err-bg px-1 text-err">at limit</span>}
    </span>
  );
}

/** The word a login shows beside its quota while it has not settled: never "ready" before someone checked. */
const UNSETTLED: Readonly<Record<string, string>> = { checking: 'checking', refresh_due: 'refresh due' };

/** One login's line: its status mark, its name, and its quota or the honest reason there is none. */
function LoginQuotaLine({ login, now }: { readonly login: LoginView; readonly now?: number }) {
  const unsettled = UNSETTLED[login.status.word];
  return (
    <span className="inline-flex items-center gap-1" data-quota-login={login.id}>
      <AccountStatus word={login.status.word} />
      <span className="text-muted">{loginName(login)}</span>
      {unsettled === undefined ? (
        <LoginQuota quota={quotaOf(login)} showUnknown {...(now === undefined ? {} : { now })} />
      ) : (
        <span className="mono shrink-0 text-faint" data-quota-unsettled="">
          {unsettled}
        </span>
      )}
    </span>
  );
}

export function QuotaReadout({ client, now }: { readonly client: LoginsClient; readonly now?: number }) {
  const [list, setList] = useState<LoginList | null>(null);
  useEffect(() => {
    let alive = true;
    readLogins(client).then(
      read => {
        if (alive) setList(read);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client]);
  if (list === null) return null;
  if (list.logins.length === 0)
    return (
      <span className="text-meta text-muted" data-quota-readout="">
        No logins
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted" data-quota-readout="">
      {list.logins.map(login => (
        <LoginQuotaLine key={login.id} login={login} {...(now === undefined ? {} : { now })} />
      ))}
    </span>
  );
}
