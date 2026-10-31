/**
 * Where each budgeted login stands, from what the meter counted (docs/budgets.md). Pure.
 */
import {
  type AccountModel,
  type Budget,
  type BudgetHold,
  type BudgetLevel,
  type BudgetLimit,
  type BudgetPeriod,
  type BudgetSpan,
  BUDGET_PERIODS,
  budgetLevel,
  budgetSpan,
  type FleetManifest,
  manifestRuntimes,
  periodHold,
  runtimeHarness,
  strongerHold,
  switchedOff,
  worseBudgetLevel,
  wrapperNameOf,
} from '@ferretry/fleet';
import type { FleetBudgetPeriodView, FleetCredentialBudget } from '@ferretry/protocol';
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
  readonly hold?: BudgetHold;
}

/**
 * Every login with a budget, with the runtimes on it as the published manifest names them — the name a
 * session records it ran as. A login no apply has published a runtime for has no sessions to count yet.
 */
export function budgetedLogins(model: AccountModel, manifest: FleetManifest | undefined): readonly BudgetedLogin[] {
  const runtimes = manifest === undefined ? [] : manifestRuntimes(manifest);
  return Object.entries(model.credentials)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .flatMap(([id, credential]) =>
      credential.budget === undefined
        ? []
        : [
            {
              id,
              budget: credential.budget,
              agents: runtimes
                .filter(runtime => runtime.credential === id)
                .map(runtime => wrapperNameOf(runtime.wrapper)),
            },
          ],
    );
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
  let hold: BudgetHold | undefined;
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
    hold = strongerHold(hold, periodHold(period, limit, spentUsd, span, timeZone));
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

const periodView = (state: BudgetPeriodState): FleetBudgetPeriodView => ({
  ...(state.limit.trigger === undefined ? {} : { trigger: state.limit.trigger }),
  ...(state.limit.hard === undefined ? {} : { hard: state.limit.hard }),
  // Rounded to the cent the bill shows, so a view never carries float noise.
  spentUsd: Math.round(state.spentUsd * 100) / 100,
  level: state.level,
  startsAt: new Date(state.span.startMs).toISOString(),
  resetsAt: new Date(state.span.endMs).toISOString(),
});

/** A login's standing as the credentials view shows it. */
export function budgetView(state: LoginBudgetState, measured: boolean): FleetCredentialBudget {
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
export function holdsKey(holds: Readonly<Record<string, BudgetHold>>): string {
  return JSON.stringify(
    Object.entries(holds)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([id, hold]) => [id, hold.period, hold.level, hold.limitUsd, hold.resetsAtMs, hold.timeZone]),
  );
}

/**
 * An agent runtime of the same kind as one on `login`, on a login that is on and that no budget holds —
 * what the hard-limit notice suggests for `fy migrate`. `undefined` when there is none.
 */
export function budgetAlternative(
  model: AccountModel,
  login: string,
  nowMs: number,
  holds: Readonly<Record<string, BudgetHold>>,
): string | undefined {
  const runtimes = Object.entries(model.runtimes).toSorted(([left], [right]) => (left < right ? -1 : 1));
  const kinds = new Set(
    runtimes
      .filter(([, runtime]) => runtime.credential === login && runtime.agent)
      .map(([, runtime]) => runtimeHarness(model, runtime)),
  );
  return runtimes.find(
    ([, runtime]) =>
      runtime.agent &&
      runtime.credential !== login &&
      kinds.has(runtimeHarness(model, runtime)) &&
      !switchedOff(model, runtime, nowMs, holds),
  )?.[0];
}
