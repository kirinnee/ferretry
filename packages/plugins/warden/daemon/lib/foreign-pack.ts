/**
 * What the Move reads of the runtimes and their logins: the quota reading and the readiness refusal, copied from
 * today's `pack/quota.ts` and `pack/recommend.ts` (Packs owns them; Move is their second reader, and the two cannot
 * drift apart unnoticed). The fleet shapes are the smallest structural ones these functions touch.
 */
import { type PaneLimit, paneLimitHolds } from './foreign-pane-limit.ts';

export type PackQuotaState = 'plenty' | 'some' | 'low' | 'exhausted' | 'unknown';
export interface PackQuotaWindow {
  readonly label: '5h' | 'week' | 'month' | 'key' | 'tools';
  readonly usedPercent?: number;
  readonly leftPercent?: number;
  readonly resetsAt?: string;
  readonly reset?: true;
}
export interface PackQuota {
  readonly state: PackQuotaState;
  readonly windows: readonly PackQuotaWindow[];
  readonly leftPercent?: number;
  readonly tightest?: PackQuotaWindow['label'];
  readonly measuredAt?: string;
  readonly summary: string;
}
interface UsageWindow {
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: string | undefined;
}
export interface FleetCredentialView {
  readonly id: string;
  readonly harness?: string;
  readonly store?: string;
  readonly status: { readonly word?: string };
  readonly usage: {
    readonly at?: string;
    readonly fiveHour: UsageWindow;
    readonly weekly: UsageWindow;
    readonly provider?: {
      readonly at?: string;
      readonly exhausted?: boolean;
      readonly windows?: readonly (UsageWindow & { readonly label: PackQuotaWindow['label'] })[];
    };
  };
  readonly environment?: { readonly missingSecrets?: readonly string[] };
  readonly budget?: {
    readonly level: string;
    readonly weekly?: BudgetPeriod;
    readonly daily?: BudgetPeriod;
  };
}
interface BudgetPeriod {
  readonly level: string;
  readonly hard?: number;
  readonly trigger?: number;
  readonly spentUsd: number;
  readonly resetsAt: string;
}
export interface FleetRuntimeView {
  readonly name: string;
  readonly wrapper: string;
  readonly agent: boolean;
  readonly harness: 'claude' | 'codex';
  readonly credential: { readonly id: string; readonly status?: string; readonly store?: string };
  readonly disabled?: unknown;
  readonly launch: { readonly available: boolean; readonly reason?: string };
  readonly models?: {
    readonly choices: readonly { readonly id: string }[];
    readonly catalog: { readonly id: string; readonly customIds: boolean };
  };
  readonly modelSet: {
    readonly source: string;
    readonly models?: readonly { readonly id: string; readonly available: boolean }[];
  };
}
export interface FleetMachineTool {
  readonly harness: string;
  readonly label: string;
  readonly installed: boolean;
}
export interface PackRefusal {
  readonly code: string;
  readonly message: string;
  readonly remedy?: string;
}

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

/**
 * A credential's headroom now. No credential, or nothing measured: `unknown`, never full or empty.
 *
 * `limit` is what a session's pane proved about the login ("You've hit your org's monthly spend limit"):
 * the login is exhausted until the time the harness gave, whatever its windows last measured.
 */
export function quotaOf(
  credential: FleetCredentialView | undefined,
  now: string | undefined,
  limit?: PaneLimit,
): PackQuota {
  if (credential === undefined) return { state: 'unknown', windows: [], summary: 'not measured' };
  if (limit !== undefined && (now === undefined || paneLimitHolds(limit, Date.parse(now)))) {
    const until = limit.retryAt === undefined ? undefined : new Date(limit.retryAt).toISOString();
    const what = limit.spend ? 'its spend limit' : 'its usage limit';
    return {
      state: 'exhausted',
      windows: windowsOf(credential, now),
      summary: until === undefined ? `hit ${what}` : `hit ${what} until ${shortInstant(until, now)}`,
    };
  }
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

const usdWords = (amount: number): string => `$${amount.toFixed(2)}`;
export interface PackFleetFacts {
  readonly runtimes: readonly FleetRuntimeView[];
  readonly credentials: readonly FleetCredentialView[];
  readonly tools: readonly FleetMachineTool[];
  /**
   * Why a start would refuse to launch a runtime, by its wrapper name — the start's OWN resolution of
   * the published launcher, so "ready" here is a runtime `fy new` can actually launch. Absent: launchable.
   */
  readonly unlaunchable: Readonly<Record<string, string>>;
  /**
   * The logins whose sessions' panes say they are out of quota, by credential id. Absent: none are. Read
   * from the panes because a spend limit is something only the pane announces.
   */
  readonly paneLimits?: ReadonlyMap<string, PaneLimit>;
  /** Now, so a quota window whose reset time has passed counts as fresh. Absent: no reset is assumed. */
  readonly now?: string;
}

const refusal = (code: PackRefusal['code'], message: string, remedy?: string): PackRefusal => ({
  code,
  message,
  ...(remedy === undefined ? {} : { remedy }),
});

/** The quota headroom of a runtime's login now. */
/**
 * Why `runtime` cannot start a ferret on `model` now, or `undefined` when it can. Checked in the order
 * a person would fix them: the runtime, its CLI, its login, its quota, then the model.
 */
export function runtimeRefusal(
  runtime: FleetRuntimeView,
  model: string | undefined,
  facts: PackFleetFacts,
): PackRefusal | undefined {
  const name = runtime.name;
  if (!runtime.agent)
    return refusal(
      'not_agent',
      `${name} is for using its CLI yourself and cannot run sub-ferrets.`,
      'Pick an agent runtime.',
    );
  const tool = facts.tools.find(candidate => candidate.harness === runtime.harness);
  if (tool !== undefined && !tool.installed)
    return refusal(
      'cli_missing',
      `${tool.label} is not installed on this machine, so ${name} cannot start.`,
      `Install ${tool.label}, or pick another runtime.`,
    );
  const budget = overBudget(facts.credentials.find(candidate => candidate.id === runtime.credential.id));
  if (budget !== undefined)
    return refusal(
      'over_budget',
      `${name}'s login (${runtime.credential.id}) ${budget}`,
      'Pick another model; this one is back when the budget resets.',
    );
  const unlaunchable = facts.unlaunchable[runtime.wrapper];
  if (unlaunchable !== undefined)
    return refusal('cli_missing', `${name} cannot be launched: ${unlaunchable}`, 'Pick another runtime.');
  if (runtime.disabled !== undefined)
    return refusal(
      'disabled',
      `${name} cannot launch: ${runtime.launch.available ? 'it is disabled' : runtime.launch.reason}.`,
      'Pick another model.',
    );
  const credential = facts.credentials.find(candidate => candidate.id === runtime.credential.id);
  const missing = credential?.environment?.missingSecrets ?? [];
  if (missing.length > 0)
    return refusal(
      'not_logged_in',
      `${name}'s login needs ${missing.join(', ')}, which is not set.`,
      'Pick another model.',
    );
  if ((credential?.status.word ?? runtime.credential.status) === 'needs_sign_in')
    return refusal(
      'not_logged_in',
      `${name}'s login (${runtime.credential.id}) needs signing in.`,
      'Pick another model.',
    );
  const quota =
    credential === undefined ? undefined : quotaOf(credential, facts.now, facts.paneLimits?.get(runtime.credential.id));
  if (quota?.state === 'exhausted')
    return refusal(
      'out_of_quota',
      `${name}'s login (${runtime.credential.id}) is ${quota.summary}.`,
      'Pick another model.',
    );
  if (!runtime.launch.available)
    return refusal('not_logged_in', `${name} cannot launch: ${runtime.launch.reason}`, 'Pick another model.');
  if (model !== undefined && !offers(runtime, model))
    return refusal('model_unavailable', `${name} does not offer ${model}.`, '`recommend` lists the runtimes that do.');
  return undefined;
}

/**
 * "spent $41.20 of its $40.00 daily trigger on this machine; back at 2026-10-31T07:00:00.000Z" — or
 * `undefined` when the login's budget holds nothing. The worse period speaks; a tie goes to the longer.
 */
export function overBudget(credential: FleetCredentialView | undefined): string | undefined {
  const budget = credential?.budget;
  if (budget === undefined || budget.level === 'ok') return undefined;
  const periods = (['weekly', 'daily'] as const).flatMap(period => {
    const view = budget[period];
    return view === undefined || view.level === 'ok' ? [] : [{ period, view }];
  });
  const speaking = periods.find(entry => entry.view.level === budget.level) ?? periods[0];
  if (speaking === undefined) return undefined;
  const { period, view } = speaking;
  const hard = view.level === 'over_hard';
  const limit = (hard ? view.hard : view.trigger) ?? 0;
  return `spent ${usdWords(view.spentUsd)} of its ${usdWords(limit)} ${period} ${hard ? 'hard limit' : 'trigger'} on this machine; back at ${view.resetsAt}`;
}

/** Whether a runtime offers a model, from its catalog when its login reads one, else its model set. */
export function offers(runtime: FleetRuntimeView, model: string): boolean {
  if (runtime.models !== undefined)
    return runtime.models.choices.some(choice => choice.id === model) || runtime.models.catalog.customIds;
  return (
    runtime.modelSet.source === 'model-set' &&
    (runtime.modelSet.models ?? []).some(entry => entry.id === model && entry.available)
  );
}
