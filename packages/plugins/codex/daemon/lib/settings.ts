/**
 * The settings items (`config/codex/settings/<name>.yaml`) as one document, the way Claude Code's home takes its own
 * (`plugins/claude-code/daemon/lib/harness/settings.ts`): each item's `settings` merged in name order, the later item
 * winning; objects merge, arrays and scalars replace. A `${secret:NAME}` stays the reference it is written as: nothing
 * here reads, resolves or logs a value.
 */
import type { SettingsItem } from '../../contract/index.ts';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Objects merge; arrays, null and scalars replace. */
function deepMergeSettings(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = merged[key];
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(overlayValue)
        ? deepMergeSettings(baseValue, overlayValue)
        : overlayValue;
  }
  return merged;
}

const inNameOrder = (items: ReadonlyMap<string, SettingsItem>): readonly SettingsItem[] =>
  [...items].toSorted(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);

/**
 * The launch flags the selected settings items carry, item by item in name order (the order their settings merge in, so
 * the later item's flag comes later on the command line). Every word is its own argv word, whatever it holds.
 */
export const settingsFlags = (items: ReadonlyMap<string, SettingsItem>): readonly string[] =>
  inNameOrder(items).flatMap(item => item.flags ?? []);

/** Every item's settings merged, in the order of the items' names. */
export function settingsDocument(items: ReadonlyMap<string, SettingsItem>): Record<string, unknown> {
  let document: Record<string, unknown> = {};
  for (const item of inNameOrder(items)) document = deepMergeSettings(document, item.settings);
  return document;
}
