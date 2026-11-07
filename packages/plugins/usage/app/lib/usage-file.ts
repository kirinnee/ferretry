/**
 * THE BUDGETS AS FILE TEXT (docs/budgets.md): the `budgets` key of `usage.yaml` (one entry per login id) and its
 * `timeZone`, which a first budget save writes from the owner's device — edited one key at a time, the same way
 * `fy login budget` edits them, so every other key and every comment the owner wrote survives byte for byte.
 *
 * Pure: text in, text out. `null` means the file cannot be edited here — it does not parse, or it is not a
 * mapping of keys — which a person fixes by hand; a verb never overwrites it.
 */

import { readConfigValue, setConfigKey } from './config-text.ts';
import type { BudgetLimits } from './budget-model.ts';

const editKey = (text: string, key: string, value: unknown): string | null => {
  try {
    return setConfigKey(text, key, value);
  } catch {
    return null;
  }
};

const budgetsOf = (text: string): Readonly<Record<string, unknown>> | null => {
  const value = readConfigValue(text);
  if (value === null || typeof value !== 'object') return null;
  const budgets = (value as { readonly budgets?: unknown }).budgets;
  return typeof budgets === 'object' && budgets !== null ? (budgets as Record<string, unknown>) : {};
};

/** `usage.yaml` with `login`'s entry in `budgets` made `limits` — or removed when `limits` is `undefined`. */
export const withLoginBudget = (text: string, login: string, limits: BudgetLimits | undefined): string | null => {
  const current = budgetsOf(text);
  if (current === null) return null;
  const { [login]: _removed, ...others } = current;
  const next = limits === undefined ? others : { ...others, [login]: limits };
  return editKey(text, 'budgets', Object.keys(next).length === 0 ? undefined : next);
};

/** `usage.yaml` with `timeZone` set to `zone`. Like any zone change it is held for the owner (docs/budgets.md). */
export const withMachineTimeZone = (text: string, zone: string): string | null => editKey(text, 'timeZone', zone);

/**
 * The zone `usage.yaml` names: `undefined` when it names none (budgets then count in the host's own zone),
 * `null` when the file does not parse.
 */
export const readMachineTimeZone = (text: string): string | undefined | null => {
  const value = readConfigValue(text);
  if (value === null || typeof value !== 'object') return null;
  const zone = (value as { readonly timeZone?: unknown }).timeZone;
  return typeof zone === 'string' && zone !== '' ? zone : undefined;
};
