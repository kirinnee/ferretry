/**
 * Where a Machines page is, as a linkable address (docs/design/account-model.md §4.2, O1).
 *
 * Two kinds of address, and they never mix:
 *
 * - a page INSIDE a tab (one runtime, one profile) is the hash `#machines/<machine>/<tab>/<item>` — the tab reads
 *   it when it mounts and when it changes, so Back works and a copied link reads as the page it was looking at;
 * - another TAB is a path on the daemon's Settings page, from the app's `daemonSettingsHref`: Runtimes' own three
 *   tabs are `settings/runtimes/<tab>`, Sign-ins is Logins' tab. The item's hash rides on it, so the tab that mounts
 *   opens the page.
 */

import { daemonSettingsHref } from '@ferretry/app';
import type { MouseEvent } from 'react';

/** The tabs this half names in a link. */
export type MachineTabId = 'runtimes' | 'profiles' | 'model-sets' | 'sign-ins';

/** The Settings section id that owns the Machines pages, and the first word of its hash. */
export const MACHINES_SECTION = 'machines';

/** The hash for one machine's tab. */
export const machineHash = (machine: string, tab: MachineTabId): string =>
  `#${MACHINES_SECTION}/${encodeURIComponent(machine)}/${tab}`;

/** The plugin that draws each tab on the Settings page, and the tab's own id there. */
const TAB_HOMES: Readonly<Record<MachineTabId, readonly [plugin: string, tab: string]>> = {
  runtimes: ['runtimes', 'runtimes'],
  profiles: ['runtimes', 'profiles'],
  'model-sets': ['runtimes', 'model-sets'],
  'sign-ins': ['logins', 'logins'],
};

/**
 * The address of a tab, or of one page on it. `daemon` is the daemon the page is for (`currentDaemon()`); outside the
 * app's `/d/<daemon>` pages there is no Settings page to name, and the link is the hash alone.
 */
export const tabHref = (daemon: string | null, machine: string, tab: MachineTabId, item?: string): string => {
  const hash = machineHash(machine, tab);
  const detail = item === undefined ? hash : `${hash}/${encodeURIComponent(item)}`;
  if (daemon === null) return detail;
  const [plugin, id] = TAB_HOMES[tab];
  return `${daemonSettingsHref(daemon, plugin, id)}${detail}`;
};

/** The Settings page of the plugin that owns a harness (`claude-code`, `codex`), where it is installed and checked. */
export const harnessHref = (daemon: string | null, harness: string): string =>
  daemon === null ? `#${harness}` : daemonSettingsHref(daemon, harness);

/** The daemon this page is for: the app serves one daemon's screens under `/d/<daemon>`. */
export const currentDaemon = (browser: Window = window): string | null => {
  const match = /^\/d\/([^/]+)/u.exec(browser.location.pathname);
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

/**
 * Moves inside the app without a reload: the app's router follows the browser's history. A plain click on an address
 * of the app (a path) is followed here; a modifier click, a middle click and a hash-only link are the browser's.
 */
export const followInApp = (event: MouseEvent<HTMLAnchorElement>, browser: Window = window): void => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  const href = event.currentTarget.getAttribute('href') ?? '';
  if (!href.startsWith('/')) return;
  event.preventDefault();
  browser.history.pushState({}, '', href);
  browser.dispatchEvent(new PopStateEvent('popstate'));
};
