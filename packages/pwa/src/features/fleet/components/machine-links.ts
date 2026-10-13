/**
 * Links between the Machines tabs' pages: `#machines/<machine>/<tab>/<item>`.
 *
 * The shell's address names a machine and a tab; a fourth segment names one page on that tab — a
 * runtime, a credential, a profile or a component (`<kind>/<name>`, encoded as one segment). The shell
 * reads only the first three, so the Settings page still switches tab, and the tab that mounts opens
 * the item. A runtime's page links its profile this way, and a profile's page links its runtimes.
 */

import { useEffect, useRef } from 'react';
import { machineHash, type MachineTabId, MACHINES_SECTION } from '../shell/machine-route.ts';

/** The page a link opens on this tab, or `undefined` when the hash names none (or another tab). */
export function itemFromHash(hash: string, tab: MachineTabId): string | undefined {
  const [section, , tabSegment, item] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION || tabSegment !== tab || item === undefined || item === '') return undefined;
  try {
    return decodeURIComponent(item);
  } catch {
    return undefined;
  }
}

/** The address of one page on a tab. */
export const itemHref = (machineName: string, tab: MachineTabId, item: string): string =>
  `${machineHash(machineName, tab)}/${encodeURIComponent(item)}`;

/** Opens the page the address names: once when the tab mounts, and again whenever the hash changes. */
export function useHashItem(tab: MachineTabId, onItem: (item: string) => void): void {
  const latest = useRef(onItem);
  latest.current = onItem;
  useEffect(() => {
    const follow = (): void => {
      const item = itemFromHash(window.location.hash, tab);
      if (item !== undefined) latest.current(item);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [tab]);
}
