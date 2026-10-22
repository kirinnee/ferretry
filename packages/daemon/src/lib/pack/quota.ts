/**
 * QUOTA HEADROOM (docs/pack-mode.md § Quota): how much of a runtime's login is left, read from the
 * fleet's own usage readings — the same windows the app shows as "5h 2% · wk 46%" — and never fetched
 * here. `fy recommend` and `fy new --auto` use it to spread work so no login runs dry: a candidate whose
 * login is low is moved below one with headroom, the guide's order breaking every tie.
 *
 * A window whose reset time has passed since it was measured counts as fresh, so a login that ran out at
 * noon is offered again once its window resets, without anybody reading its usage again.
 *
 * Pure: a credential and the time in, a value out.
 */
import type { FleetCredentialView, PackQuota, PackQuotaState, PackQuotaWindow } from '@ferretry/protocol';

/** At or above this share left, a login has plenty; below {@link LOW_LEFT_PERCENT}, it is low. */
const PLENTY_LEFT_PERCENT = 50;
const LOW_LEFT_PERCENT = 20;

const WINDOW_WORDS: Readonly<Record<PackQuotaWindow['label'], string>> = {
  '5h': 'the 5h window',
  week: 'the week',
  month: 'the month',
  key: "the key's limit",
  tools: 'the tool allowance',
};

const SHORT_LABEL: Readonly<Record<PackQuotaWindow['label'], string>> = {
  '5h': '5h',
  week: 'wk',
  month: 'mo',
  key: 'key',
  tools: 'tools',
};

const round = (value: number): number => Math.round(value);

/** `18:00Z` for an instant today, `Oct 23 18:00Z` for another day, in UTC so every reader agrees. */
export function shortInstant(instant: string, now: string | undefined): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant;
  const time = at.toISOString().slice(11, 16);
  const sameDay = now !== undefined && now.slice(0, 10) === at.toISOString().slice(0, 10);
  if (sameDay) return `${time}Z`;
  const month = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${String(at.getUTCDate())} ${time}Z`;
}

/** One window, with its reset judged against `now`. */
function windowOf(
  label: PackQuotaWindow['label'],
  usedPercent: number | undefined,
  resetsAt: string | undefined,
  now: string | undefined,
): PackQuotaWindow {
  const reset =
    resetsAt !== undefined && now !== undefined && Date.parse(resetsAt) <= Date.parse(now) && usedPercent !== undefined;
  if (reset) return { label, usedPercent: 0, leftPercent: 100, reset: true };
  return {
    label,
    ...(usedPercent === undefined
      ? {}
      : { usedPercent: round(usedPercent), leftPercent: Math.max(0, 100 - round(usedPercent)) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Every window a credential's usage reports, the 5h and weekly first, each label once. */
function windowsOf(credential: FleetCredentialView, now: string | undefined): readonly PackQuotaWindow[] {
  const usage = credential.usage;
  const windows: PackQuotaWindow[] = [];
  const seen = new Set<string>();
  const add = (window: PackQuotaWindow): void => {
    if (seen.has(window.label) || (window.usedPercent === undefined && window.resetsAt === undefined)) return;
    seen.add(window.label);
    windows.push(window);
  };
  add(windowOf('5h', usage.fiveHour.usedPercent, usage.fiveHour.resetsAt, now));
  add(windowOf('week', usage.weekly.usedPercent, usage.weekly.resetsAt, now));
  for (const window of usage.provider?.windows ?? [])
    add(windowOf(window.label, window.usedPercent, window.resetsAt, now));
  return windows;
}

const stateOf = (left: number): PackQuotaState =>
  left <= 0 ? 'exhausted' : left < LOW_LEFT_PERCENT ? 'low' : left < PLENTY_LEFT_PERCENT ? 'some' : 'plenty';

/** A credential's headroom now. No credential, or nothing measured: `unknown`, never full or empty. */
export function quotaOf(credential: FleetCredentialView | undefined, now: string | undefined): PackQuota {
  if (credential === undefined) return { state: 'unknown', windows: [], summary: 'not measured' };
  const windows = windowsOf(credential, now);
  const measured = windows.filter(
    (window): window is PackQuotaWindow & { leftPercent: number } => window.leftPercent !== undefined,
  );
  const tightest = measured.toSorted((left, right) => left.leftPercent - right.leftPercent)[0];
  const measuredAt = credential.usage.at ?? credential.usage.provider?.at;
  const base = { windows, ...(measuredAt === undefined ? {} : { measuredAt }) };
  // The provider's own "no more work" holds until a window it reported has reset since.
  const providerSaysNo =
    credential.usage.provider?.exhausted === true && !windows.some(window => window.reset === true);
  const words = measured.map(window => `${SHORT_LABEL[window.label]} ${String(window.usedPercent ?? 0)}%`).join(' · ');
  if (providerSaysNo || (tightest !== undefined && tightest.leftPercent <= 0)) {
    const full = windows.filter(window => window.leftPercent === 0 && window.resetsAt !== undefined);
    const until = full.map(window => window.resetsAt as string).toSorted()[0];
    return {
      ...base,
      state: 'exhausted',
      ...(tightest === undefined ? {} : { leftPercent: tightest.leftPercent, tightest: tightest.label }),
      summary: until === undefined ? 'out of quota' : `out of quota until ${shortInstant(until, now)}`,
    };
  }
  if (tightest === undefined) return { ...base, state: 'unknown', summary: 'not measured' };
  return {
    ...base,
    state: stateOf(tightest.leftPercent),
    leftPercent: tightest.leftPercent,
    tightest: tightest.label,
    summary: words,
  };
}

/** How far a band sits from the top when candidates are re-ranked; `unknown` is not held against anyone. */
export const QUOTA_RANK: Readonly<Record<PackQuotaState, number>> = {
  plenty: 0,
  unknown: 0,
  some: 1,
  low: 2,
  exhausted: 3,
};

/** Why a candidate was moved down, in words: its tightest window ("91% of the week used"). */
export function quotaReason(runtime: string, quota: PackQuota, now?: string): string {
  const window = quota.windows.find(candidate => candidate.label === quota.tightest);
  if (window === undefined || window.usedPercent === undefined) return `${runtime}, ${quota.summary}`;
  const reset = window.resetsAt === undefined ? '' : `, resets ${shortInstant(window.resetsAt, now)}`;
  return `${runtime}, ${String(window.usedPercent)}% of ${WINDOW_WORDS[window.label]} used${reset}`;
}
