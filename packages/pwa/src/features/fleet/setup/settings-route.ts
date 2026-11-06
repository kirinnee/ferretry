/**
 * The Machine tab's flows, and the daemon panels every tab opens, as linkable addresses
 * (docs/design/account-model.md §4.2, §4.3, §4.7).
 *
 * The shell's address is `#machines/<machine>/<tab>`; something a tab opens adds one word:
 * `#machines/<machine>/machine/setup` is the first run (the Runtimes tab links here when a machine
 * is not set up), `/import` is Import again, `/clone` is Copy settings from another machine, `/export`
 * is Export settings, and
 * `/install-claude` or `/install-codex` installs one tool. A panel word names one of the paired
 * daemon's own panels on the tab it belongs to — `agents/warden`, `sign-ins/secrets`, `machine/security`
 * (`machine-panels.ts` says which is where). The shell ignores the extra word, so it stays on the tab
 * while the tab reads it itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { panelTab } from '../shell/machine-panels.ts';
import { MACHINES_SECTION, type MachineTabId, machineHash } from '../shell/machine-route.ts';

const SETTINGS_FLOWS = ['setup', 'import', 'clone', 'export', 'install-claude', 'install-codex'] as const;

export type SettingsFlow = (typeof SETTINGS_FLOWS)[number];

const FLOWS: ReadonlySet<string> = new Set(SETTINGS_FLOWS);

/** `#machines/<machine>/<tab>/<item>`: one thing on one tab. */
export const machineItemHash = (machine: string, tab: MachineTabId, item?: string): string =>
  item === undefined ? machineHash(machine, tab) : `${machineHash(machine, tab)}/${encodeURIComponent(item)}`;

/** The word after one tab, or `null` for the tab itself (or any other address). */
const tabItem = (hash: string, wanted: MachineTabId): string | null => {
  const [section, , tab, item] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION || tab !== wanted || !item) return null;
  try {
    return decodeURIComponent(item);
  } catch {
    return null;
  }
};

/** The flow a Settings hash names, or `null` for the tab itself (or any other address). */
export const settingsFlowFromHash = (hash: string): SettingsFlow | null => {
  const item = tabItem(hash, 'machine');
  return item !== null && FLOWS.has(item) ? (item as SettingsFlow) : null;
};

/**
 * The daemon panel a Settings hash names on this tab: the word after the tab when it is a panel that
 * tab opens. A login's or a profile's name is also a word after a tab, so a word no panel owns is never one.
 */
export const machinePanelFromHash = (hash: string, tab: MachineTabId = 'machine'): string | null => {
  const item = tabItem(hash, tab);
  return item === null || FLOWS.has(item) || panelTab(item) !== tab ? null : item;
};

export interface SettingsFlowRoute {
  readonly flow: SettingsFlow | null;
  /** The daemon panel the address opens, or `null` for none. */
  readonly panel: string | null;
  /** Open a flow, or close it (`null`) and return to the tab. */
  readonly open: (flow: SettingsFlow | null) => void;
  /** Open one of the daemon's panels, or go back to the tab (`null`). */
  readonly openPanel: (panel: string | null) => void;
  /** Go to another tab on this machine. */
  readonly goTo: (tab: MachineTabId) => void;
}

/** The flow or panel in the address bar, followed as it changes. */
export function useSettingsFlow(
  machineName: string,
  browser: Window = window,
  tab: MachineTabId = 'machine',
): SettingsFlowRoute {
  const [hash, setHash] = useState(() => browser.location.hash);
  useEffect(() => {
    const read = (): void => setHash(browser.location.hash);
    read();
    browser.addEventListener('hashchange', read);
    return () => browser.removeEventListener('hashchange', read);
  }, [browser]);
  const move = useCallback(
    (item: string | null): void => {
      browser.location.hash = machineItemHash(machineName, tab, item ?? undefined);
      setHash(browser.location.hash);
    },
    [browser, machineName, tab],
  );
  const goTo = useCallback(
    (tab: MachineTabId): void => {
      browser.location.hash = machineHash(machineName, tab);
    },
    [browser, machineName],
  );
  return {
    flow: tab === 'machine' ? settingsFlowFromHash(hash) : null,
    panel: machinePanelFromHash(hash, tab),
    open: move,
    openPanel: move,
    goTo,
  };
}
