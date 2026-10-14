/**
 * The Machine tab's flows and panels as linkable addresses (docs/design/account-model.md §4.2, §4.3, §4.7).
 *
 * The shell's address is `#machines/<machine>/<tab>`; something the Machine tab opens adds one word:
 * `#machines/<machine>/machine/setup` is the first run (the Runtimes tab links here when a machine
 * is not set up), `/import` is Import again, `/clone` is Clone from another machine, and
 * `/install-claude` or `/install-codex` installs one tool. Any other word names one of the paired
 * daemon's own panels — `/security`, `/warden`, `/devices` — which used to be a separate Daemons section.
 * The shell ignores the extra word, so it stays on the Machine tab while the tab reads it itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { MACHINES_SECTION, type MachineTabId, machineHash } from '../shell/machine-route.ts';

export const SETTINGS_FLOWS = ['setup', 'import', 'clone', 'install-claude', 'install-codex'] as const;

export type SettingsFlow = (typeof SETTINGS_FLOWS)[number];

const FLOWS: ReadonlySet<string> = new Set(SETTINGS_FLOWS);

/** `#machines/<machine>/<tab>/<item>`: one thing on one tab. */
export const machineItemHash = (machine: string, tab: MachineTabId, item?: string): string =>
  item === undefined ? machineHash(machine, tab) : `${machineHash(machine, tab)}/${encodeURIComponent(item)}`;

/** The word after the Machine tab, or `null` for the tab itself (or any other address). */
const machineTabItem = (hash: string): string | null => {
  const [section, , tab, item] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION || tab !== 'machine' || !item) return null;
  try {
    return decodeURIComponent(item);
  } catch {
    return null;
  }
};

/** The flow a Settings hash names, or `null` for the tab itself (or any other address). */
export const settingsFlowFromHash = (hash: string): SettingsFlow | null => {
  const item = machineTabItem(hash);
  return item !== null && FLOWS.has(item) ? (item as SettingsFlow) : null;
};

/** The daemon panel a Settings hash names: any word on the Machine tab that is not a flow. */
export const machinePanelFromHash = (hash: string): string | null => {
  const item = machineTabItem(hash);
  return item === null || FLOWS.has(item) ? null : item;
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
export function useSettingsFlow(machineName: string, browser: Window = window): SettingsFlowRoute {
  const [hash, setHash] = useState(() => browser.location.hash);
  useEffect(() => {
    const read = (): void => setHash(browser.location.hash);
    read();
    browser.addEventListener('hashchange', read);
    return () => browser.removeEventListener('hashchange', read);
  }, [browser]);
  const move = useCallback(
    (item: string | null): void => {
      browser.location.hash = machineItemHash(machineName, 'machine', item ?? undefined);
      setHash(browser.location.hash);
    },
    [browser, machineName],
  );
  const goTo = useCallback(
    (tab: MachineTabId): void => {
      browser.location.hash = machineHash(machineName, tab);
    },
    [browser, machineName],
  );
  return {
    flow: settingsFlowFromHash(hash),
    panel: machinePanelFromHash(hash),
    open: move,
    openPanel: move,
    goTo,
  };
}
