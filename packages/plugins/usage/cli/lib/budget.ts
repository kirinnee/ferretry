/**
 * `fy login budget <id>` (docs/budgets.md): the words and the edit. A budget is the login's entry in the `budgets` key of
 * `usage.yaml`; this edits that one key through the daemon's checked config write, so every other key and every comment the
 * owner wrote survives, and adding or lowering a limit applies at once while raising or removing one is held for the owner.
 *
 * Pure: text in, text out.
 */
import { type Budget, type BudgetLimit, BudgetSchema, usdWords } from '../../contract/index.ts';
import { readConfigText, setConfigKey } from '@ferretry/std/yaml';

/** One level as typed: dollars, `off` to remove it, or not given. */
type LevelInput = number | 'off' | undefined;

export interface BudgetEdit {
  readonly dailyTrigger?: LevelInput;
  readonly dailyHard?: LevelInput;
  readonly weeklyTrigger?: LevelInput;
  readonly weeklyHard?: LevelInput;
  readonly clear?: boolean;
}

/** A refusal said in a sentence the verb prints. */
export class BudgetEditError extends Error {}

/** A level flag's value: a positive dollar amount, or `off`. */
export function parseLevel(flag: string, text: string): number | 'off' {
  if (text.trim().toLowerCase() === 'off') return 'off';
  const amount = Number(text.replace(/^\$/u, ''));
  if (!Number.isFinite(amount) || amount <= 0)
    throw new BudgetEditError(`--${flag} takes a dollar amount above 0 (40, 12.50) or "off"; "${text}" is neither.`);
  return amount;
}

const level = (current: number | undefined, input: LevelInput): number | undefined =>
  input === undefined ? current : input === 'off' ? undefined : input;

const limitOf = (trigger: number | undefined, hard: number | undefined): BudgetLimit | undefined =>
  trigger === undefined && hard === undefined
    ? undefined
    : { ...(trigger === undefined ? {} : { trigger }), ...(hard === undefined ? {} : { hard }) };

/** The budget after `edit`, from `current`; `undefined` is no budget at all. Not yet validated. */
export function editedBudget(current: Budget | undefined, edit: BudgetEdit): Budget | undefined {
  if (edit.clear === true) return undefined;
  const daily = limitOf(level(current?.daily?.trigger, edit.dailyTrigger), level(current?.daily?.hard, edit.dailyHard));
  const weekly = limitOf(
    level(current?.weekly?.trigger, edit.weeklyTrigger),
    level(current?.weekly?.hard, edit.weeklyHard),
  );
  return daily === undefined && weekly === undefined
    ? undefined
    : { ...(daily === undefined ? {} : { daily }), ...(weekly === undefined ? {} : { weekly }) };
}

const limitWords = (name: string, limit: BudgetLimit | undefined): string[] =>
  limit === undefined
    ? []
    : [
        `${name}: ${[
          ...(limit.trigger === undefined ? [] : [`trigger ${usdWords(limit.trigger)}`]),
          ...(limit.hard === undefined ? [] : [`hard ${usdWords(limit.hard)}`]),
        ].join(', ')}`,
      ];

/** "daily: trigger $40.00, hard $60.00 · weekly: hard $200.00", or "no budget". */
export function budgetWords(budget: Budget | undefined): string {
  const parts = [...limitWords('daily', budget?.daily), ...limitWords('weekly', budget?.weekly)];
  return parts.length === 0 ? 'no budget' : parts.join(' · ');
}

export const sameBudget = (left: Budget | undefined, right: Budget | undefined): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The budget `usage.yaml` holds for `login`, or `undefined`; `null` when the file does not parse. */
export function budgetInFile(text: string, login: string): Budget | undefined | null {
  const read = readConfigText(text);
  const value = read.ok ? read.read.value : null;
  if (value === null || typeof value !== 'object') return null;
  const budgets = (value as { readonly budgets?: unknown }).budgets;
  if (typeof budgets !== 'object' || budgets === null) return undefined;
  const entry = (budgets as Record<string, unknown>)[login];
  if (entry === undefined) return undefined;
  const parsed = BudgetSchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

/** `usage.yaml` with `login`'s entry in `budgets` made `budget` (or removed when `undefined`). Throws when it cannot be edited. */
export function withLoginBudget(text: string, login: string, budget: Budget | undefined): string {
  const read = readConfigText(text);
  const value = read.ok ? read.read.value : null;
  if (value === null || typeof value !== 'object')
    throw new BudgetEditError('usage.yaml does not parse; fix it first.');
  const current = (value as { readonly budgets?: unknown }).budgets;
  const others = typeof current === 'object' && current !== null ? { ...(current as Record<string, unknown>) } : {};
  delete others[login];
  const next = budget === undefined ? others : { ...others, [login]: budget };
  return setConfigKey(text, 'budgets', Object.keys(next).length === 0 ? undefined : next);
}

/** `usage.yaml` with `timeZone` set to `zone`. */
export const withTimeZone = (text: string, zone: string): string => setConfigKey(text, 'timeZone', zone);
