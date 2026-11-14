import { SETTINGS_GROUPS } from '@ferretry/kernel/manifest';

/**
 * WHICH SETTINGS TAB AN ADDRESS NAMES. `/d/<daemon>/settings/<plugin>` is that plugin's first tab,
 * `/d/<daemon>/settings/<plugin>/<tab>` one of its tabs, and a bare `/d/<daemon>/settings/<tab>` the tab of that id
 * (what a person types, since a tab's name is what the strip shows). A name nothing answers to is `missing`: the page
 * says so, because opening the first tab for it (v4 had no such address) looked like a bug that hid the typo.
 */
export interface SettingsTabEntry {
  readonly plugin: string;
  readonly id: string;
}

export type SettingsTabChoice<T extends SettingsTabEntry> =
  | { readonly kind: 'tab'; readonly tab: T }
  | { readonly kind: 'missing'; readonly name: string }
  | { readonly kind: 'none' };

export function resolveSettingsTab<T extends SettingsTabEntry>(
  tabs: readonly T[],
  tab: string | undefined,
  tabId: string | undefined,
): SettingsTabChoice<T> {
  if (tabs.length === 0) return { kind: 'none' };
  if (tab === undefined) return { kind: 'tab', tab: tabs[0] as T };
  const found =
    tabs.find(candidate => candidate.plugin === tab && (tabId === undefined || candidate.id === tabId)) ??
    (tabId === undefined ? tabs.find(candidate => candidate.id === tab) : undefined);
  return found === undefined
    ? { kind: 'missing', name: tabId === undefined ? tab : `${tab}/${tabId}` }
    : { kind: 'tab', tab: found };
}

/** What the Settings page needs of a tab to list it: its group is the heading it sits under. */
export interface GroupableTab extends SettingsTabEntry {
  readonly order: number;
  readonly group?: string;
}

export interface SettingsTabGroup<T extends GroupableTab> {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly T[];
}

/** The heading for a tab that names no group the shell knows (a plugin newer than this shell): listed last, never dropped. */
const OTHER_GROUP = { id: 'more', label: 'More' } as const;

/**
 * THE TABS AS TITLED GROUPS: each group the shell knows, in its order, holding its tabs in theirs (`order`, then the
 * plugin's id); a tab whose group is missing or unknown is collected last under "More" rather than lost. Empty groups
 * are not listed. The shell names no plugin: a group is whatever tab declared it.
 */
export function groupSettingsTabs<T extends GroupableTab>(tabs: readonly T[]): readonly SettingsTabGroup<T>[] {
  const known = new Set<string>(SETTINGS_GROUPS.map(group => group.id));
  const byOrder = (a: T, b: T): number => a.order - b.order || a.plugin.localeCompare(b.plugin);
  const grouped = [...SETTINGS_GROUPS, OTHER_GROUP].map(group => ({
    id: group.id,
    label: group.label,
    tabs: tabs
      .filter(candidate =>
        group.id === OTHER_GROUP.id
          ? candidate.group === undefined || !known.has(candidate.group)
          : candidate.group === group.id,
      )
      .sort(byOrder),
  }));
  return grouped.filter(group => group.tabs.length > 0);
}
