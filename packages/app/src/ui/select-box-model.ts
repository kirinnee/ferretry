import type { ReactNode } from 'react';

/**
 * THE SELECT BOX'S RULES WITHOUT ANY DOM (`select-box.tsx` draws them): what one option is, which options a query leaves,
 * how a list is cut into headed groups, and where the cursor may go. Pure, so each rule is asserted without a browser.
 */

/** One choice. `value` is what `onChange` receives (an empty string is a valid value: "the default"). */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** A second line of words a reader weighs the option by; searched as well as the label. */
  readonly hint?: string;
  /** A heading the option sits under. Consecutive options with the same group share one heading. */
  readonly group?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

/** Lower-cased, accents and combining marks removed: "Café" and "cafe", "CAFÉ" and "Cafe" are one word. */
export const foldText = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The options a query leaves, in their own order. Every word of the query must appear in the option's label or hint
 * (so "never writes" finds "Plan only · reads, never writes"); an empty query leaves all of them.
 */
export function filterOptions(options: readonly SelectOption[], query: string): readonly SelectOption[] {
  const words = foldText(query)
    .split(/\s+/u)
    .filter(word => word !== '');
  if (words.length === 0) return options;
  return options.filter(option => {
    const text = foldText(`${option.label} ${option.hint ?? ''}`);
    return words.every(word => text.includes(word));
  });
}

/** A run of options under one heading (`heading` is absent for options with no group). */
export interface SelectSection {
  readonly heading: string | undefined;
  /** `index` is the option's place in the list the sections were cut from (the cursor's address). */
  readonly items: readonly { readonly option: SelectOption; readonly index: number }[];
}

/** Cuts a list into runs of the same group, keeping the list's order so the keyboard walks what the eye reads. */
export function sectionOptions(options: readonly SelectOption[]): readonly SelectSection[] {
  const sections: { heading: string | undefined; items: { option: SelectOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const last = sections.at(-1);
    if (last !== undefined && last.heading === option.group) last.items.push({ option, index });
    else sections.push({ heading: option.group, items: [{ option, index }] });
  });
  return sections;
}

/** Whether a list is long enough to earn a search box when `searchable` is "auto". */
const AUTO_SEARCH_OVER = 7;

export type Searchable = 'auto' | 'always' | 'never';

export const isSearchable = (mode: Searchable, count: number): boolean =>
  mode === 'always' || (mode === 'auto' && count > AUTO_SEARCH_OVER);

/** The first enabled option at or after `from` going in `step` (1 or -1); `from` itself when nothing further is enabled. */
export function stepCursor(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  for (let at = from + step; at >= 0 && at < options.length; at += step) if (options[at]?.disabled !== true) return at;
  return from;
}

/** The first enabled option, or -1 when there is none. */
export const firstEnabled = (options: readonly SelectOption[]): number =>
  options.findIndex(option => option.disabled !== true);

/** The last enabled option, or -1 when there is none. */
export const lastEnabled = (options: readonly SelectOption[]): number =>
  options.findLastIndex(option => option.disabled !== true);

/** Where the cursor starts on open: the chosen option when it is enabled, else the first enabled one (-1: none). */
export function startCursor(options: readonly SelectOption[], value: string): number {
  const chosen = options.findIndex(option => option.value === value);
  return chosen !== -1 && options[chosen]?.disabled !== true ? chosen : firstEnabled(options);
}

/** A typed letter on a list with no search box: the next enabled option (after `from`, wrapping) whose label starts with it. */
export function typeahead(options: readonly SelectOption[], from: number, key: string): number {
  const letter = foldText(key);
  const count = options.length;
  for (let step = 1; step <= count; step += 1) {
    const at = (from + step) % count;
    const option = options[at];
    if (option !== undefined && option.disabled !== true && foldText(option.label).startsWith(letter)) return at;
  }
  return from;
}
