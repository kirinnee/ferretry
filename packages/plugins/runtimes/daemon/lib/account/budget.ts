/**
 * A login's spend budget (docs/budgets.md): a daily and/or weekly amount in US dollars, each with a
 * TRIGGER and a HARD level.
 *
 * `budget: { daily: { trigger, hard }, weekly: { trigger, hard } }` on a `logins/<id>.yaml`. Past the
 * trigger the login is published UNAVAILABLE with a reason — exactly as a `disabled` block is — so nothing
 * new starts, resumes or is revived on it while ferrets already on it keep going. Past the hard level the
 * daemon also stops the ferrets running on it. The amount spent is this machine's own: what its sessions
 * on that login cost, priced from their transcripts.
 *
 * A day starts at local midnight and a week at Monday 00:00, both in the machine's `timeZone`.
 *
 * Pure: the clock, the zone and the spend are the caller's.
 */
import { z } from 'zod';

/** A budget amount: dollars, positive and finite. */
const BudgetAmountSchema = z.number().finite().positive();

/** One period's two levels. Either may be left out; when both are written the hard one is not below the trigger. */
const BudgetLimitSchema = z
  .strictObject({
    /** Spent at least this much in the period: stop routing to the login. */
    trigger: BudgetAmountSchema.optional(),
    /** Spent at least this much in the period: also stop the ferrets running on it. */
    hard: BudgetAmountSchema.optional(),
  })
  .check(ctx => {
    const { trigger, hard } = ctx.value;
    if (trigger === undefined && hard === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a budget period needs a "trigger", a "hard" limit, or both',
        input: ctx.value,
        path: [],
      });
    }
    if (trigger !== undefined && hard !== undefined && hard < trigger) {
      ctx.issues.push({
        code: 'custom',
        message: `the hard limit ($${String(hard)}) must not be below the trigger ($${String(trigger)})`,
        input: hard,
        path: ['hard'],
      });
    }
  });
export const BudgetSchema = z
  .strictObject({
    /** Resets at local midnight. */
    daily: BudgetLimitSchema.optional(),
    /** Resets at Monday 00:00 local. */
    weekly: BudgetLimitSchema.optional(),
  })
  .check(ctx => {
    if (ctx.value.daily === undefined && ctx.value.weekly === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a budget needs a "daily" or a "weekly" limit; remove "budget" to have none',
        input: ctx.value,
        path: [],
      });
    }
  });
const BUDGET_PERIODS = ['daily', 'weekly'] as const;
type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** Whether `zone` is an IANA time zone this runtime knows. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone (`Asia/Singapore`, `America/Los_Angeles`, `UTC`). */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .refine(isTimeZone, { message: 'write "timeZone" as an IANA time zone, such as America/Los_Angeles or UTC' });

// ── Periods ──────────────────────────────────────────────────────────────────────────────────────

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────

/** Where a login stands against one period's limits, from best to worst. */
const BUDGET_LEVELS = ['ok', 'over_trigger', 'over_hard'] as const;
type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/**
 * Why a login is held by its budget: the period that holds it, which limit it reached, and when it
 * resets. What the fleet publishes as the login's unavailable reason — so it carries NO running amount:
 * a figure that moved with every request would republish the fleet every minute. The amount spent is
 * on the credential's own view.
 */
export interface BudgetHold {
  readonly period: BudgetPeriod;
  readonly level: Exclude<BudgetLevel, 'ok'>;
  /** The limit reached: the hard limit when `level` is `over_hard`, the trigger otherwise. */
  readonly limitUsd: number;
  readonly resetsAtMs: number;
  readonly timeZone: string;
}

/** `$41.20` — two decimals, as a bill reads. */
const usdWords = (amount: number): string => `$${amount.toFixed(2)}`;

/** `Sat 00:00 (America/Los_Angeles)` — a reset time in the zone the budget is counted in. */
function budgetResetWords(resetsAtMs: number, zone: string): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(resetsAtMs);
  return `${text} (${zone})`;
}

/** "over its daily budget on this machine (its $40.00 trigger) until Sat 00:00 (UTC)". */
export function budgetHoldPhrase(hold: BudgetHold): string {
  const limit = hold.level === 'over_hard' ? 'hard limit' : 'trigger';
  return `over its ${hold.period} budget on this machine (its ${usdWords(hold.limitUsd)} ${limit}) until ${budgetResetWords(hold.resetsAtMs, hold.timeZone)}`;
}
