import { type FuzzyField, scoreFields } from './palette-ranking.ts';

/**
 * THE COMMAND BAR'S MODEL, feature-free: entries, groups, ranking and the keyboard rules. Copied from today's
 * `shell/palette-model.ts`, keeping only what the bar itself needs; what the bar LISTS is contributed — the shell's own
 * destinations and layout commands now, plugins' entries later — as {@link CommandBarSource}s.
 */

export interface CommandBarEntry {
  /** Unique within its source; becomes the option's DOM id. */
  readonly id: string;
  /** The heading it is listed under (`Go to`, `Layout`, …). Groups show in the order their first entry arrives. */
  readonly group: string;
  readonly label: string;
  readonly description?: string;
  /** Extra words it is found by. */
  readonly keywords?: readonly string[];
  /** Shown with no query typed. */
  readonly resting?: boolean;
  readonly run: () => void;
}

/** One contributor: answers its entries for a query (it may ignore the query and let the bar rank). */
export type CommandBarSource = (query: string) => readonly CommandBarEntry[];

export interface CommandBarGroup {
  readonly heading: string;
  readonly entries: readonly CommandBarEntry[];
  /** Where the group's first entry sits in the flat result list. */
  readonly offset: number;
}

export interface CommandBarResults {
  readonly groups: readonly CommandBarGroup[];
  readonly results: readonly CommandBarEntry[];
}

/** Longest list a group shows; the bar is for jumping, not browsing. */
export const MAX_GROUP_RESULTS = 8;

const fieldsOf = (entry: CommandBarEntry): FuzzyField[] => [
  { value: entry.label, weight: 1 },
  ...(entry.keywords ?? []).map(value => ({ value, weight: 0.8 })),
  ...(entry.description === undefined ? [] : [{ value: entry.description, weight: 0.4 }]),
];

/**
 * Collects, ranks and groups. With no query only `resting` entries show, in source order; with one, every entry that
 * scores, best first within its group. A source that throws costs only its own entries.
 */
export function commandBarResults(sources: readonly CommandBarSource[], query: string): CommandBarResults {
  const searching = query.trim() !== '';
  const byGroup = new Map<string, { entry: CommandBarEntry; score: number; order: number }[]>();
  let order = 0;
  for (const source of sources) {
    let entries: readonly CommandBarEntry[];
    try {
      entries = source(query);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const score = searching ? scoreFields(fieldsOf(entry), query) : entry.resting === true ? 1 : 0;
      order += 1;
      if (score <= 0) continue;
      const list = byGroup.get(entry.group) ?? [];
      list.push({ entry, score, order });
      byGroup.set(entry.group, list);
    }
  }
  const groups: CommandBarGroup[] = [];
  const results: CommandBarEntry[] = [];
  for (const [heading, list] of byGroup) {
    const ranked = list
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, MAX_GROUP_RESULTS)
      .map(item => item.entry);
    groups.push({ heading, entries: ranked, offset: results.length });
    results.push(...ranked);
  }
  return { groups, results };
}

/** The option id for one entry. */
export const commandBarOptionId = (entry: CommandBarEntry): string =>
  `fy-command-bar-option-${entry.id.replaceAll(/[^A-Za-z0-9_-]/gu, '-')}`;

export const COMMAND_BAR_IDS = {
  panel: 'fy-command-bar',
  input: 'fy-command-bar-input',
  listbox: 'fy-command-bar-listbox',
} as const;

export const clampActiveIndex = (active: number, count: number): number =>
  count === 0 ? -1 : Math.min(Math.max(active, 0), count - 1);

/**
 * Where an arrow, Home or End key moves the active row. Wrapping is deliberate: a list shorter than the reader
 * expected returns to the top rather than stop dead at the bottom. `null` means the key is not one this list answers
 * to and the event must be left alone.
 */
export const nextActiveIndex = (active: number, count: number, key: string): number | null => {
  if (count === 0) return null;
  const from = Math.min(Math.max(active, 0), count - 1);
  switch (key) {
    case 'ArrowDown':
      return (from + 1) % count;
    case 'ArrowUp':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
};

export const commandBarCountLabel = (count: number): string =>
  count === 0 ? 'No results' : `${count} result${count === 1 ? '' : 's'}`;

/**
 * Where focus goes when the bar opens. A touch-affected reader gets the dialog container focused and NOT the text
 * box: autofocusing an input on a phone summons the on-screen keyboard over the results. A keyboard reader gets the
 * box, because typing is why they pressed the shortcut.
 */
export const commandBarFocusPolicy = (
  touchAffected: boolean,
): { readonly dialogAutoFocus: boolean; readonly inputAutoFocus: boolean } => ({
  dialogAutoFocus: touchAffected,
  inputAutoFocus: !touchAffected,
});
