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
  /**
   * Where it sits among its group's entries when scores tie (and at rest, where every score ties): lower first, as the
   * nav orders its places. An entry with none follows those with one, in source order.
   */
  readonly order?: number;
  /** A line under the description (a card's project, an ask's owner), drawn quieter than it (S11). */
  readonly detail?: string;
  /** Drawn faded, not hidden: closed work is still the answer to "did we already do this?" (S11). */
  readonly muted?: boolean;
  readonly run: () => void;
}

/** One chip row a source offers: pick one option (the first is the resting one). The bar remembers the choice. */
export interface CommandBarFilter {
  readonly id: string;
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

/** What a source answers when it has more to say than entries: a line while it is still searching (S11). */
export interface CommandBarAnswer {
  readonly entries: readonly CommandBarEntry[];
  readonly pending?: string;
}

/**
 * One contributor. The plain function form (query → entries; it may ignore the query and let the bar rank) is still
 * accepted. The object form also offers filter chips and may answer a pending line (S11): `list` is asked with the
 * query AND the chosen option of every filter the bar holds, `{ [filter.id]: option.id }`.
 */
export type CommandBarSource = ((query: string) => readonly CommandBarEntry[]) | CommandBarListSource;

/** The object form of a source (S11): filter chips, and an answer that may carry a pending line. */
export interface CommandBarListSource {
  readonly list: (
    query: string,
    filters: Readonly<Record<string, string>>,
  ) => readonly CommandBarEntry[] | CommandBarAnswer;
  readonly filters?: readonly CommandBarFilter[];
}

/** The choices the bar holds, filter id → option id. A filter with no choice yet is at its first option. */
export type CommandBarChoices = Readonly<Record<string, string>>;

/** Every filter the sources offer, in source order; a repeated id is offered once. */
export const commandBarFilters = (sources: readonly CommandBarSource[]): readonly CommandBarFilter[] => {
  const seen = new Set<string>();
  return sources.flatMap(source =>
    typeof source === 'function'
      ? []
      : (source.filters ?? []).filter(filter => {
          if (seen.has(filter.id) || filter.options.length === 0) return false;
          seen.add(filter.id);
          return true;
        }),
  );
};

/** The option each filter is at: the person's choice when it is one of its options, else the first. */
export const resolveChoices = (
  filters: readonly CommandBarFilter[],
  chosen: CommandBarChoices,
): Readonly<Record<string, string>> => {
  const resolved: Record<string, string> = {};
  for (const filter of filters) {
    const pick = chosen[filter.id];
    const first = filter.options[0];
    if (first === undefined) continue;
    resolved[filter.id] = filter.options.some(option => option.id === pick) ? (pick as string) : first.id;
  }
  return resolved;
};

export interface CommandBarGroup {
  readonly heading: string;
  readonly entries: readonly CommandBarEntry[];
  /** Where the group's first entry sits in the flat result list. */
  readonly offset: number;
}

export interface CommandBarResults {
  readonly groups: readonly CommandBarGroup[];
  readonly results: readonly CommandBarEntry[];
  /** The first source's line while it is still searching, or `undefined`. */
  readonly pending?: string;
}

/** Longest list a group shows while searching; the bar is for jumping, not browsing. At rest a group shows what its sources rest. */
export const MAX_GROUP_RESULTS = 8;

const UNORDERED = Number.MAX_SAFE_INTEGER;

const fieldsOf = (entry: CommandBarEntry): FuzzyField[] => [
  { value: entry.label, weight: 1 },
  ...(entry.keywords ?? []).map(value => ({ value, weight: 0.8 })),
  ...(entry.description === undefined ? [] : [{ value: entry.description, weight: 0.4 }]),
];

/**
 * Collects, ranks and groups. With no query only `resting` entries show, in source order; with one, every entry that
 * scores, best first within its group. A source that throws costs only its own entries.
 */
export function commandBarResults(
  sources: readonly CommandBarSource[],
  query: string,
  chosen: CommandBarChoices = {},
): CommandBarResults {
  const searching = query.trim() !== '';
  const choices = resolveChoices(commandBarFilters(sources), chosen);
  let pending: string | undefined;
  type Item = { entry: CommandBarEntry; score: number; order: number };
  const byGroup = new Map<string, Item[]>();
  // An id is one place: when two sources offer it (the shell's plain nav entry and the owning plugin's, which says
  // more), the later source's entry replaces the earlier one where the earlier one stood.
  const byId = new Map<string, Item>();
  let order = 0;
  for (const source of sources) {
    let entries: readonly CommandBarEntry[];
    try {
      const answer = typeof source === 'function' ? source(query) : source.list(query, choices);
      if (Array.isArray(answer)) entries = answer;
      else {
        const full = answer as CommandBarAnswer;
        entries = full.entries;
        pending ??= full.pending;
      }
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const score = searching ? scoreFields(fieldsOf(entry), query) : entry.resting === true ? 1 : 0;
      order += 1;
      const held = byId.get(entry.id);
      if (held !== undefined) {
        held.entry = entry;
        held.score = score;
        continue;
      }
      const item: Item = { entry, score, order };
      byId.set(entry.id, item);
      const list = byGroup.get(entry.group) ?? [];
      list.push(item);
      byGroup.set(entry.group, list);
    }
  }
  const groups: CommandBarGroup[] = [];
  const results: CommandBarEntry[] = [];
  for (const [heading, all] of byGroup) {
    const list = all.filter(item => item.score > 0);
    if (list.length === 0) continue;
    const sorted = list.sort(
      (a, b) => b.score - a.score || (a.entry.order ?? UNORDERED) - (b.entry.order ?? UNORDERED) || a.order - b.order,
    );
    const ranked = (searching ? sorted.slice(0, MAX_GROUP_RESULTS) : sorted).map(item => item.entry);
    groups.push({ heading, entries: ranked, offset: results.length });
    results.push(...ranked);
  }
  return { groups, results, ...(pending === undefined ? {} : { pending }) };
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
