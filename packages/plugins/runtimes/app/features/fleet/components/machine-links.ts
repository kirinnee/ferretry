/**
 * Links between the Machines tabs' pages: the Settings path of the tab (`tabHref`) plus the hash
 * `#machines/<machine>/<tab>/<item>`.
 *
 * The path names the tab; the hash's fourth segment names one page on it — a runtime, a credential, a
 * profile or a component (`<kind>/<name>`, encoded as one segment). Profiles and components share the
 * Profiles tab, and a component's slash is what tells them apart. The tab that mounts reads the hash and
 * opens the item. A runtime's page links its profile this way, and a profile's page links its runtimes.
 */

import { useEffect, useRef } from 'react';
import { currentDaemon, type MachineTabId, MACHINES_SECTION, tabHref } from '../shell/machine-route.ts';

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

/** True for a component's `<kind>/<name>` reference; a profile's name never has a slash. */
export const isComponentReference = (item: string): boolean => item.includes('/');

/** The address of one page on a tab: that tab's Settings path, with the page in the hash. */
export const itemHref = (machineName: string, tab: MachineTabId, item: string, daemon = currentDaemon()): string =>
  tabHref(daemon, machineName, tab, item);

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
