/**
 * What the Budgets tab SAYS — the pure half (docs/budgets.md). Today's budget functions of the Sign-ins tab's
 * `credentials-model.ts`, over the Logins contract's budget views. Every sentence a person reads is pinned by a
 * test, so the editor, the meter and the chip cannot word one budget two ways.
 */

import type { LoginBudget, LoginBudgetLevel, LoginBudgetPeriodView } from '@ferretry/plugin-logins/contract';
import { usdWords } from '../../contract/index.ts';

export { usdWords };

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/**
 * `resets Sat` — a reset in the zone the budget is counted in, never the reader's. A budget resets at local
 * midnight, so the time is said only when it is not midnight (a zone whose clocks skip it): `resets Sun 01:00`.
 */
export const budgetResetWords = (resetsAt: string, zone: string): string =>
  `resets ${new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(Date.parse(resetsAt))
    .replace(/ 00:00$/u, '')}`;

/**
 * The two periods, as a meter labels them: short enough for the label column the 5h/Week quota bars use, so
 * a login's budget bars start and end exactly where its quota bars do, and marked as money beside them.
 */
const BUDGET_PERIOD_LABELS = { daily: '$/day', weekly: '$/week' } as const;
type BudgetPeriodKey = keyof typeof BUDGET_PERIOD_LABELS;

/**
 * How far past the higher limit a budget bar reaches. A fifth beyond it keeps the hard limit's mark INSIDE
 * the bar, where it can be seen: a mark at the very end of a clipped bar is a mark nobody sees.
 */
const BUDGET_BAR_HEADROOM = 1.2;

/** One period of a budget, as the meter draws it. */
export interface BudgetMeterRow {
  /** "$/day", "$/week". */
  readonly label: string;
  /** "$12.40 of $40.00 · resets Sat". */
  readonly words: string;
  /** The spend as a whole percent of the bar, which reaches a fifth past the higher limit. */
  readonly fillPercent: number;
  /** The trigger on that same scale, when the period has one. */
  readonly triggerPercent: number | null;
  /** The hard limit on that same scale, when the period has one. */
  readonly hardPercent: number | null;
  readonly level: LoginBudgetLevel;
}

const meterRow = (period: BudgetPeriodKey, view: LoginBudgetPeriodView, zone: string): BudgetMeterRow => {
  // A period always has at least one of the two levels; the bar reaches a fifth past the higher one.
  const scale = Math.max(view.trigger ?? 0, view.hard ?? 0) * BUDGET_BAR_HEADROOM;
  const percent = (amount: number): number => Math.min(100, Math.round((amount / scale) * 100));
  const ofWords =
    view.trigger === undefined ? `of ${usdWords(view.hard as number)} hard` : `of ${usdWords(view.trigger)}`;
  return {
    label: BUDGET_PERIOD_LABELS[period],
    words: `${usdWords(view.spentUsd)} ${ofWords} · ${budgetResetWords(view.resetsAt, zone)}`,
    fillPercent: percent(view.spentUsd),
    triggerPercent: view.trigger === undefined ? null : percent(view.trigger),
    hardPercent: view.hard === undefined ? null : percent(view.hard),
    level: view.level,
  };
};

/** A budget's periods, one bar each, in the order they reset: today, then this week. */
export const budgetMeterRows = (budget: LoginBudget): readonly BudgetMeterRow[] =>
  (Object.keys(BUDGET_PERIOD_LABELS) as readonly BudgetPeriodKey[]).flatMap(period =>
    budget[period] === undefined ? [] : [meterRow(period, budget[period] as LoginBudgetPeriodView, budget.timeZone)],
  );

/** The badge a budget holds a login under, or `null` while it is within every one of its budgets. */
export const budgetChip = (
  budget: LoginBudget | undefined,
): { readonly label: string; readonly tone: 'warn' | 'err' } | null => {
  if (budget === undefined || budget.level === 'ok') return null;
  // The words are the two holds of docs/budgets.md: what each level stops.
  return budget.level === 'over_hard'
    ? { label: 'Hard limit — ferrets stopped', tone: 'err' }
    : { label: 'Over budget — not routing', tone: 'warn' };
};

/**
 * What the spend IS and IS NOT, under the bars: this machine's only, the requests no price covers,
 * and whether the meter has counted this login's sessions yet.
 */
export const budgetScopeNote = (budget: LoginBudget, machineName: string): string =>
  [
    `Spent on ${machineName} only`,
    ...(budget.unpriced > 0 ? [`${plural(budget.unpriced, 'request')} without a price`] : []),
    ...(budget.measured ? [] : ['Counting…']),
    // A transcript too large to read back to the period's start: what came before is not in the amount.
    ...(budget.partial === true ? ['may be low: a transcript is too large to read in full'] : []),
  ].join(' · ');

/**
 * Where a budget's days are counted, and where THAT comes from: the zone `usage.yaml` names, or
 * this machine's own — which is what saving from here replaces with `deviceZone` (docs/budgets.md).
 */
export const budgetZoneWords = (budget: LoginBudget | undefined, deviceZone: string): string => {
  if (budget === undefined)
    return `Days reset at midnight, weeks on Monday — counted in your zone (${deviceZone}) once you save; it is written to usage.yaml.`;
  return budget.timeZoneSet
    ? `Days reset at midnight, weeks on Monday, in ${budget.timeZone} (written in usage.yaml).`
    : `Days reset at midnight, weeks on Monday, in ${budget.timeZone} — this machine’s own zone. Saving here writes yours (${deviceZone}).`;
};

/** One level of the editor: the text of a dollar amount, empty for no limit. */
export interface BudgetDraft {
  readonly dailyTrigger: string;
  readonly dailyHard: string;
  readonly weeklyTrigger: string;
  readonly weeklyHard: string;
}

/** A budget as it is written to the login's file: one or two periods, each with at least one level. */
export interface BudgetLimits {
  readonly daily?: { readonly trigger?: number; readonly hard?: number };
  readonly weekly?: { readonly trigger?: number; readonly hard?: number };
}

const amountText = (amount: number | undefined): string => (amount === undefined ? '' : String(amount));

/** The editor's fields from the budget the daemon last reported; all empty when there is none. */
export const budgetDraft = (budget: LoginBudget | undefined): BudgetDraft => ({
  dailyTrigger: amountText(budget?.daily?.trigger),
  dailyHard: amountText(budget?.daily?.hard),
  weeklyTrigger: amountText(budget?.weekly?.trigger),
  weeklyHard: amountText(budget?.weekly?.hard),
});

/** A field's dollars: `undefined` when empty, `NaN` when it is not a positive amount. Takes a `$`. */
export const parseBudgetAmount = (text: string): number | undefined => {
  const trimmed = text.trim().replace(/^\$/u, '');
  if (trimmed === '') return undefined;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : Number.NaN;
};

/**
 * One period of a draft as typed numbers, `undefined` where a field is empty. A field that is not a
 * positive amount stays `NaN` here; {@link budgetDraftProblem} is what says it cannot be saved.
 */
const draftLevels = (
  draft: BudgetDraft,
  period: BudgetPeriodKey,
): { readonly trigger?: number; readonly hard?: number } => {
  const trigger = parseBudgetAmount(period === 'daily' ? draft.dailyTrigger : draft.weeklyTrigger);
  const hard = parseBudgetAmount(period === 'daily' ? draft.dailyHard : draft.weeklyHard);
  if (trigger === undefined && hard === undefined) return {};
  return { ...(trigger === undefined ? {} : { trigger }), ...(hard === undefined ? {} : { hard }) };
};

/** Why the editor cannot save this draft, or `null` when it can. All four empty is a removal, not a problem. */
export const budgetDraftProblem = (draft: BudgetDraft): string | null => {
  for (const period of ['daily', 'weekly'] as const) {
    const { trigger, hard } = draftLevels(draft, period);
    if (trigger !== undefined && Number.isNaN(trigger)) return 'Give every limit as dollars above 0, like 40 or 12.50.';
    if (hard !== undefined && Number.isNaN(hard)) return 'Give every limit as dollars above 0, like 40 or 12.50.';
    if (trigger !== undefined && hard !== undefined && hard < trigger)
      return `The ${period} hard limit must not be below its trigger.`;
  }
  return null;
};

/** The draft as the login's `budget` key: `undefined` removes the budget, an empty period leaves it out. */
export const budgetOfDraft = (draft: BudgetDraft): BudgetLimits | undefined => {
  const daily = draftLevels(draft, 'daily');
  const weekly = draftLevels(draft, 'weekly');
  const empty = (levels: { readonly trigger?: number; readonly hard?: number }): boolean =>
    levels.trigger === undefined && levels.hard === undefined;
  return empty(daily) && empty(weekly)
    ? undefined
    : { ...(empty(daily) ? {} : { daily }), ...(empty(weekly) ? {} : { weekly }) };
};

/** A budget view as `budgetOfDraft` would write it, so a draft can be compared with what is in effect. */
const budgetLimitsOfView = (budget: LoginBudget | undefined): BudgetLimits | undefined =>
  budget === undefined ? undefined : budgetOfDraft(budgetDraft(budget));

/** Whether the draft differs from the budget the daemon last reported. */
export const budgetDraftChanged = (draft: BudgetDraft, budget: LoginBudget | undefined): boolean =>
  JSON.stringify(budgetOfDraft(draft) ?? null) !== JSON.stringify(budgetLimitsOfView(budget) ?? null);
