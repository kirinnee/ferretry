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
