/**
 * A LOGIN'S BUDGET AS FILE TEXT (docs/budgets.md): the `budget` key of `logins/<id>.yaml`, and the
 * `timeZone` of `machine.yaml` that a first budget save writes from the owner's device — edited one
 * key at a time, the same way `fy login budget` edits them, so every other key and every comment the
 * owner wrote survives byte for byte.
 *
 * Pure: text in, text out. `null` means the file cannot be edited here — it does not parse, or it is
 * not a mapping of keys — which a person fixes in the Files panel; a verb never overwrites it.
 */

import { readConfigText, setConfigKey } from '@ferretry/fleet/config-text';
import { type BudgetLimits } from './credentials-model.ts';

const editKey = (text: string, key: string, value: unknown): string | null => {
  try {
    return setConfigKey(text, key, value);
  } catch {
    return null;
  }
};

/** The login's file with its `budget` made `limits` — or removed when `limits` is `undefined`. */
export const withLoginBudget = (text: string, limits: BudgetLimits | undefined): string | null =>
  editKey(text, 'budget', limits);

/** `machine.yaml` with `timeZone` set to `zone`. Like any zone change it is held for the owner (docs/budgets.md). */
export const withMachineTimeZone = (text: string, zone: string): string | null => editKey(text, 'timeZone', zone);

/**
 * The zone `machine.yaml` names: `undefined` when it names none (budgets then count in the host's
 * own zone), `null` when the file does not parse.
 */
export const readMachineTimeZone = (text: string): string | undefined | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const zone = (read.read.value as { readonly timeZone?: unknown }).timeZone;
  return typeof zone === 'string' && zone !== '' ? zone : undefined;
};
