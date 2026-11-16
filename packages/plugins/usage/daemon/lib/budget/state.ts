/**
 * Where each budgeted login stands, from what the meter counted (docs/budgets.md). Pure.
 */
import {
  type Budget,
  BUDGET_PERIODS,
  type BudgetLimit,
  type BudgetPeriod,
  type BudgetSpan,
  budgetLevel,
  budgetSpan,
  type BudgetLevel,
  type LoginBudget,
  type LoginBudgetPeriodView,
  type Pause,
  periodPause,
  strongerPause,
  worseBudgetLevel,
} from '../../../contract/index.ts';
import { instantFromEpochMs } from '@ferretry/std';
import type { MeteredSpend } from './meter.ts';

/** One login with a budget, and the runtimes on it by executable name — what its sessions run as. */
export interface BudgetedLogin {
  readonly id: string;
  readonly budget: Budget;
  readonly agents: readonly string[];
}

interface BudgetPeriodState {
  readonly limit: BudgetLimit;
  readonly span: BudgetSpan;
  readonly spentUsd: number;
  readonly unpriced: number;
  /** A transcript on the login could not be read from the period's start: the amount may be low. */
  readonly partial: boolean;
  readonly level: BudgetLevel;
}

export interface LoginBudgetState {
  readonly id: string;
  readonly agents: readonly string[];
  readonly timeZone: string;
  readonly timeZoneSet: boolean;
  readonly periods: Partial<Readonly<Record<BudgetPeriod, BudgetPeriodState>>>;
  readonly level: BudgetLevel;
  /** What holds the login, when anything does: the worse period, the longer one on a tie. */
  readonly hold?: Pause;
}

/**
 * Every login with a budget (`usage.yaml`). The meter books spend per login, so a login is its own "agent": the key a
 * ferret on it is counted under.
 */
export function budgetedLogins(budgets: Readonly<Record<string, Budget>>): readonly BudgetedLogin[] {
  return Object.entries(budgets)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([id, budget]) => ({ id, budget, agents: [id] }));
}

/** The instant the meter must read from so every period of every budget is covered: this week's start. */
export const meterSinceMs = (nowMs: number, timeZone: string): number => budgetSpan('weekly', nowMs, timeZone).startMs;

/** One login's standing at `nowMs`. */
export function loginBudgetState(
  login: BudgetedLogin,
  spent: (agents: ReadonlySet<string>, span: BudgetSpan) => MeteredSpend,
  nowMs: number,
  timeZone: string,
  timeZoneSet: boolean,
): LoginBudgetState {
  const agents = new Set(login.agents);
  const periods: Partial<Record<BudgetPeriod, BudgetPeriodState>> = {};
  let level: BudgetLevel = 'ok';
  let hold: Pause | undefined;
  for (const period of BUDGET_PERIODS) {
    const limit = login.budget[period];
    if (limit === undefined) continue;
    const span = budgetSpan(period, nowMs, timeZone);
    const counted = spent(agents, span);
    const spentUsd = counted.usdMicros / 1_000_000;
    const periodLevel = budgetLevel(limit, spentUsd);
    periods[period] = {
      limit,
      span,
      spentUsd,
      unpriced: counted.unpriced,
      partial: counted.partial,
      level: periodLevel,
    };
    level = worseBudgetLevel(level, periodLevel);
    hold = strongerPause(hold, periodPause(period, limit, spentUsd, span, timeZone));
  }
  return {
    id: login.id,
    agents: login.agents,
    timeZone,
    timeZoneSet,
    periods,
    level,
    ...(hold === undefined ? {} : { hold }),
  };
}

const periodView = (state: BudgetPeriodState): LoginBudgetPeriodView => ({
  ...(state.limit.trigger === undefined ? {} : { trigger: state.limit.trigger }),
  ...(state.limit.hard === undefined ? {} : { hard: state.limit.hard }),
  // Rounded to the cent the bill shows, so a view never carries float noise.
  spentUsd: Math.round(state.spentUsd * 100) / 100,
  level: state.level,
  startsAt: instantFromEpochMs(state.span.startMs),
  resetsAt: instantFromEpochMs(state.span.endMs),
});

/** A login's standing as the credentials view shows it. */
export function budgetView(state: LoginBudgetState, measured: boolean): LoginBudget {
  const { daily, weekly } = state.periods;
  return {
    timeZone: state.timeZone,
    timeZoneSet: state.timeZoneSet,
    ...(daily === undefined ? {} : { daily: periodView(daily) }),
    ...(weekly === undefined ? {} : { weekly: periodView(weekly) }),
    level: state.level,
    unpriced: Math.max(daily?.unpriced ?? 0, weekly?.unpriced ?? 0),
    ...(daily?.partial === true || weekly?.partial === true ? { partial: true } : {}),
    measured,
  };
}

/** A stable key for a set of holds: the fleet is republished only when it moves. */
export function holdsKey(holds: Readonly<Record<string, Pause>>): string {
  return JSON.stringify(
    Object.entries(holds)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, hold]) => [id, hold.period, hold.level, hold.limitUsd, hold.resetsAtMs, hold.timeZone]),
  );
}

/**
 * Another login that is on and that no pause holds — what the hard-limit notice suggests starting the work on.
 * `undefined` when there is none. `logins` are the ids Logins lists as usable.
 */
export function budgetAlternative(
  logins: readonly string[],
  login: string,
  nowMs: number,
  pauses: Readonly<Record<string, Pause>>,
): string | undefined {
  return logins
    .toSorted((left, right) => (left < right ? -1 : 1))
    .find(
      candidate => candidate !== login && !(pauses[candidate] !== undefined && pauses[candidate].resetsAtMs > nowMs),
    );
}
