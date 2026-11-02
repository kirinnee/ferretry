/**
 * Where the Machines surface is, as a linkable address (docs/design/account-model.md §4.2, O1).
 *
 * The surface is one Settings section, so its address is the Settings page's hash:
 * `#machines/<machine>/<tab>`. `<machine>` is the name this browser shows for the pairing — the
 * same words on the switcher — so a link a person copies reads as the machine they were looking at.
 * The PATH still decides which daemon answers (`/d/<id>/settings`); a hash naming a different paired
 * machine is a request to switch to it, never a way to read one daemon's setup under another's name.
 */

import { panelTab } from './machine-panels.ts';

/**
 * The six tabs, grouped by what a person comes looking for. The ids are the words in the link.
 *
 * THIS IS THE ONE PLACE A TAB IS NAMED: every label a reader sees for a machine view comes from here, so
 * renaming one is a one-line change. Which of the daemon's own panels each tab opens is
 * `machine-panels.ts`; the addresses these tabs replaced are `redirectLegacyMachineHash`, below.
 */
export const MACHINE_TABS = [
  { id: 'runtimes', label: 'Runtimes', description: 'What agents run on: the default, and each runtime.' },
  {
    id: 'agents',
    label: 'Agents',
    description: 'How agents behave: permissions, what they may control, the Warden and resuming.',
  },
  {
    id: 'sign-ins',
    label: 'Sign-ins',
    description: 'AI logins, site accounts, secrets and values moved without a ferret seeing them.',
  },
  {
    id: 'profiles',
    label: 'Profiles',
    description: 'Layered setups a runtime uses, and the components they are built from.',
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'The shared browser: its mode, its proxy (with a test) and whether it is running.',
  },
  {
    id: 'machine',
    label: 'Machine',
    description: 'Who reaches this computer, its health, its tools, setup and version.',
  },
] as const;

export type MachineTabId = (typeof MACHINE_TABS)[number]['id'];

export const DEFAULT_MACHINE_TAB: MachineTabId = 'runtimes';

/** The Settings section id that owns this surface, and the first word of its hash. */
export const MACHINES_SECTION = 'machines';

export interface MachineRoute {
  /** The machine the link names; absent means "the one this page is for". */
  readonly machine?: string;
  readonly tab: MachineTabId;
}

/**
 * Tabs that no longer exist, and where their address lives now. Credentials became Sign-ins and
 * Components became a section of Profiles; the item after the tab (a login, a component) is kept.
 */
const RENAMED_TABS: Readonly<Record<string, MachineTabId>> = { credentials: 'sign-ins', components: 'profiles' };

const MACHINE_TAB_IDS: ReadonlySet<string> = new Set(MACHINE_TABS.map(tab => tab.id));

export const isMachineTabId = (value: string): value is MachineTabId => MACHINE_TAB_IDS.has(value);

/**
 * The current address for one written before the regroup, or `null` when it needs no rewrite: the old
 * Credentials and Components tabs, and a Machine-tab panel (`…/machine/warden`) that now opens from
 * another tab. A bookmark, a notice's link or an `fy` message printed earlier keeps landing where it meant to.
 */
export const redirectLegacyMachineHash = (hash: string): string | null => {
  const segments = hash.replace(/^#/u, '').split('/');
  const [section, , tab, item] = segments;
  if (section !== MACHINES_SECTION || tab === undefined) return null;
  const renamed = RENAMED_TABS[tab];
  if (renamed !== undefined) return `#${[...segments.slice(0, 2), renamed, ...segments.slice(3)].join('/')}`;
  const home = tab === 'machine' && item !== undefined ? panelTab(decode(item) ?? '') : undefined;
  if (home === undefined || home === 'machine') return null;
  return `#${[...segments.slice(0, 2), home, ...segments.slice(3)].join('/')}`;
};

const decode = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * Reads a Settings hash. `null` means the hash is not this surface's at all. An unknown tab or an
 * undecodable machine segment still opens the surface — on its default tab, for the current machine —
 * because a stale link should land somewhere sensible rather than on another section.
 */
export const parseMachineHash = (hash: string): MachineRoute | null => {
  const [section, machineSegment, tabSegment] = (redirectLegacyMachineHash(hash) ?? hash).replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION) return null;
  const machine = machineSegment ? decode(machineSegment) : undefined;
  const tab = tabSegment && isMachineTabId(tabSegment) ? tabSegment : DEFAULT_MACHINE_TAB;
  return machine ? { machine, tab } : { tab };
};

/** The hash for one machine's tab. */
export const machineHash = (machine: string, tab: MachineTabId): string =>
  `#${MACHINES_SECTION}/${encodeURIComponent(machine)}/${tab}`;
