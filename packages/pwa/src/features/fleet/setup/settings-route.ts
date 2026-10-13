/**
 * The Settings tab's flows as linkable addresses (docs/design/account-model.md §4.2, §4.3, §4.7).
 *
 * The shell's address is `#machines/<machine>/<tab>`; a flow the Settings tab opens adds one word:
 * `#machines/<machine>/settings/setup` is the first run (the Runtimes tab links here when a machine
 * is not set up), `/import` is Import again, `/clone` is Clone from another machine, and
 * `/install-claude` or `/install-codex` installs one tool. The shell ignores the extra word, so it stays on the Settings tab while the tab reads the flow itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { MACHINES_SECTION, type MachineTabId, machineHash } from '../shell/machine-route.ts';

export const SETTINGS_FLOWS = ['setup', 'import', 'clone', 'install-claude', 'install-codex'] as const;

export type SettingsFlow = (typeof SETTINGS_FLOWS)[number];

const FLOWS: ReadonlySet<string> = new Set(SETTINGS_FLOWS);

/** `#machines/<machine>/<tab>/<item>`: one thing on one tab. */
export const machineItemHash = (machine: string, tab: MachineTabId, item?: string): string =>
  item === undefined ? machineHash(machine, tab) : `${machineHash(machine, tab)}/${encodeURIComponent(item)}`;

/** The flow a Settings hash names, or `null` for the tab itself (or any other address). */
export const settingsFlowFromHash = (hash: string): SettingsFlow | null => {
  const [section, , tab, flow] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION || tab !== 'settings' || flow === undefined) return null;
  return FLOWS.has(flow) ? (flow as SettingsFlow) : null;
};

export interface SettingsFlowRoute {
  readonly flow: SettingsFlow | null;
  /** Open a flow, or close it (`null`) and return to the tab. */
  readonly open: (flow: SettingsFlow | null) => void;
  /** Go to another tab on this machine. */
  readonly goTo: (tab: MachineTabId) => void;
}

/** The flow in the address bar, followed as it changes. */
export function useSettingsFlow(machineName: string, browser: Window = window): SettingsFlowRoute {
  const [flow, setFlow] = useState(() => settingsFlowFromHash(browser.location.hash));
  useEffect(() => {
    const read = (): void => setFlow(settingsFlowFromHash(browser.location.hash));
    read();
    browser.addEventListener('hashchange', read);
    return () => browser.removeEventListener('hashchange', read);
  }, [browser]);
  const open = useCallback(
    (next: SettingsFlow | null): void => {
      browser.location.hash = machineItemHash(machineName, 'settings', next ?? undefined);
      setFlow(next);
    },
    [browser, machineName],
  );
  const goTo = useCallback(
    (tab: MachineTabId): void => {
      browser.location.hash = machineHash(machineName, tab);
    },
    [browser, machineName],
  );
  return { flow, open, goTo };
}
