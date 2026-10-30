/**
 * Where the Machines surface is, as a linkable address (docs/design/account-model.md §4.2, O1).
 *
 * The surface is one Settings section, so its address is the Settings page's hash:
 * `#machines/<machine>/<tab>`. `<machine>` is the name this browser shows for the pairing — the
 * same words on the switcher — so a link a person copies reads as the machine they were looking at.
 * The PATH still decides which daemon answers (`/d/<id>/settings`); a hash naming a different paired
 * machine is a request to switch to it, never a way to read one daemon's setup under another's name.
 */

/**
 * The six tabs, in the prototype's order plus Browser before Machine. The ids are the words in the link.
 *
 * THIS IS THE ONE PLACE A TAB IS NAMED: every label a reader sees for a machine view comes from here, so
 * renaming one is a one-line change. The last tab was "Settings" — a Settings inside Settings — and is
 * now "Machine", which is also where the paired daemon's connection and security panels live.
 */
export const MACHINE_TABS = [
  { id: 'runtimes', label: 'Runtimes', description: 'What you launch: a login plus a profile.' },
  { id: 'credentials', label: 'Credentials', description: 'The logins kept on this machine.' },
  { id: 'profiles', label: 'Profiles', description: 'Layered setups a runtime uses.' },
  { id: 'components', label: 'Components', description: 'The pieces profiles are built from.' },
  {
    id: 'browser',
    label: 'Browser',
    description: 'The shared browser: its mode, its proxy (with a test) and whether it is running.',
  },
  {
    id: 'machine',
    label: 'Machine',
    description: 'Connection, security, agent permissions, tools and setup for this machine.',
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

const MACHINE_TAB_IDS: ReadonlySet<string> = new Set(MACHINE_TABS.map(tab => tab.id));

export const isMachineTabId = (value: string): value is MachineTabId => MACHINE_TAB_IDS.has(value);

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
  const [section, machineSegment, tabSegment] = hash.replace(/^#/u, '').split('/');
  if (section !== MACHINES_SECTION) return null;
  const machine = machineSegment ? decode(machineSegment) : undefined;
  const tab = tabSegment && isMachineTabId(tabSegment) ? tabSegment : DEFAULT_MACHINE_TAB;
  return machine ? { machine, tab } : { tab };
};

/** The hash for one machine's tab. */
export const machineHash = (machine: string, tab: MachineTabId): string =>
  `#${MACHINES_SECTION}/${encodeURIComponent(machine)}/${tab}`;
