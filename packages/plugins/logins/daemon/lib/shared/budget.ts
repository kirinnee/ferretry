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
export const BudgetLimitSchema = z
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
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;

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
export type Budget = z.infer<typeof BudgetSchema>;

export const BUDGET_PERIODS = ['daily', 'weekly'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
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

const DAY_MS = 86_400_000;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  const known = formatters.get(zone);
  if (known !== undefined) return known;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  });
  formatters.set(zone, made);
  return made;
}

function localParts(ms: number, zone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(ms)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 0,
  };
}

/** How far `zone` is ahead of UTC at instant `ms`, in milliseconds (whole seconds). */
function zoneOffsetMs(ms: number, zone: string): number {
  const local = localParts(ms, zone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant the calendar day `year-month-day` begins in `zone`. Midnight usually exists; where a
 * transition skips it (a zone that moves its clocks at 00:00), the day begins at the first instant
 * that is on that date, which the second correction lands on.
 */
function localMidnightMs(year: number, month: number, day: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - zoneOffsetMs(wall, zone);
  guess = wall - zoneOffsetMs(guess, zone);
  const landed = localParts(guess, zone);
  // A skipped midnight: the guess fell on the previous day's last hour; the day starts an offset later.
  if (Date.UTC(landed.year, landed.month - 1, landed.day) < wall) {
    return guess + (DAY_MS - ((landed.hour * 60 + landed.minute) * 60 + landed.second) * 1000);
  }
  return guess;
}

/** The calendar date `days` after `year-month-day` (negative goes back). */
function addDays(year: number, month: number, day: number, days: number): [number, number, number] {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return [moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate()];
}

/** One period's span: the instant it began and the instant it resets, in milliseconds. */
export interface BudgetSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** The daily or weekly period `nowMs` falls in, in `zone`. DST-safe: a day may be 23 or 25 hours long. */
export function budgetSpan(period: BudgetPeriod, nowMs: number, zone: string): BudgetSpan {
  const local = localParts(nowMs, zone);
  const back = period === 'daily' ? 0 : local.weekday;
  const length = period === 'daily' ? 1 : 7;
  const start = addDays(local.year, local.month, local.day, -back);
  const end = addDays(...start, length);
  return { startMs: localMidnightMs(...start, zone), endMs: localMidnightMs(...end, zone) };
}

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────

/** Where a login stands against one period's limits, from best to worst. */
export const BUDGET_LEVELS = ['ok', 'over_trigger', 'over_hard'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/** The level `spentUsd` reaches against `limit`. Reaching a limit exactly counts as over it. */
export function budgetLevel(limit: BudgetLimit, spentUsd: number): BudgetLevel {
  if (limit.hard !== undefined && spentUsd >= limit.hard) return 'over_hard';
  if (limit.trigger !== undefined && spentUsd >= limit.trigger) return 'over_trigger';
  return 'ok';
}

/** The worse of two levels. */
export const worseBudgetLevel = (left: BudgetLevel, right: BudgetLevel): BudgetLevel =>
  BUDGET_LEVELS.indexOf(left) >= BUDGET_LEVELS.indexOf(right) ? left : right;

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
export const usdWords = (amount: number): string => `$${amount.toFixed(2)}`;

/** `Sat 00:00 (America/Los_Angeles)` — a reset time in the zone the budget is counted in. */
export function budgetResetWords(resetsAtMs: number, zone: string): string {
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

/** The hold one period puts on a login, or `undefined` when it is within that period's limits. */
export function periodHold(
  period: BudgetPeriod,
  limit: BudgetLimit,
  spentUsd: number,
  span: BudgetSpan,
  timeZone: string,
): BudgetHold | undefined {
  const level = budgetLevel(limit, spentUsd);
  if (level === 'ok') return undefined;
  const limitUsd = (level === 'over_hard' ? limit.hard : limit.trigger) as number;
  return { period, level, limitUsd, resetsAtMs: span.endMs, timeZone };
}

/**
 * The hold that speaks for a login: the worse level, and between two of the same level the one that
 * lasts longer — a ferret moved off a login over both budgets must not be told it is back tomorrow.
 */
export function strongerHold(left: BudgetHold | undefined, right: BudgetHold | undefined): BudgetHold | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.level !== right.level) return worseBudgetLevel(left.level, right.level) === left.level ? left : right;
  return right.resetsAtMs > left.resetsAtMs ? right : left;
}
