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

/** Every item's settings merged, in the order of the items' names. */
export function settingsDocument(items: ReadonlyMap<string, SettingsItem>): Record<string, unknown> {
  let document: Record<string, unknown> = {};
  for (const [, item] of [...items].toSorted(([left], [right]) => left.localeCompare(right)))
    document = deepMergeSettings(document, item.settings);
  return document;
}
