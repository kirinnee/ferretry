/**
 * Where each of the paired daemon's own panels (Warden, Secrets, Devices…) is reached from.
 *
 * They used to be one long list under the Machine tab. A person looks for a panel by what it is FOR, so
 * each now hangs off the tab for that: the Warden and its siblings under Agents, the site accounts and
 * secrets under Sign-ins, the rest under Machine. A group is one titled run of rows on one tab; the tab
 * asks the panel frame for exactly that group, so no panel is drawn under a tab it does not belong to.
 *
 * This is the one table of which panel is where. A link's tab and the redirect for an older address
 * (`machine-route.ts`) both read it, so a panel can move by editing one line here.
 */

import type { MachineTabId } from './machine-route.ts';

export interface PanelGroup {
  readonly id: string;
  /** The heading the tab draws, and the list's accessible name. */
  readonly label: string;
  readonly tab: MachineTabId;
  /** The panel ids in this group, in the order they are listed. */
  readonly panels: readonly string[];
}

const PANEL_GROUPS = [
  { id: 'supervision', label: 'Supervision', tab: 'agents', panels: ['warden'] },
  { id: 'agent-settings', label: 'More agent settings', tab: 'agents', panels: ['learning', 'pack'] },
  { id: 'site-sign-ins', label: 'Sites and secrets', tab: 'sign-ins', panels: ['accounts', 'secrets', 'secure-copy'] },
  {
    id: 'devices-access',
    label: 'Devices & access',
    tab: 'machine',
    panels: ['devices', 'grants', 'security', 'carrier', 'security-log'],
  },
  {
    id: 'health',
    label: 'Health',
    tab: 'machine',
    panels: ['doctor', 'host-checks', 'resource-limits', 'performance'],
  },
  { id: 'tools', label: 'Tools', tab: 'machine', panels: ['agent-clis'] },
  {
    id: 'advanced',
    label: 'Advanced',
    tab: 'machine',
    panels: ['files', 'terminals', 'speedups', 'model-pricing'],
  },
  { id: 'about', label: 'About', tab: 'machine', panels: ['about'] },
] as const satisfies readonly PanelGroup[];

export type PanelGroupId = (typeof PANEL_GROUPS)[number]['id'];

export const panelGroup = (id: PanelGroupId): PanelGroup => {
  const group = PANEL_GROUPS.find(candidate => candidate.id === id);
  if (group === undefined) throw new Error(`Unknown panel group: ${id}`);
  return group;
};

const PANEL_TABS: ReadonlyMap<string, MachineTabId> = new Map(
  PANEL_GROUPS.flatMap(group => group.panels.map(panel => [panel, group.tab] as const)),
);

/** Every panel id listed on a tab, in the order the tab draws them. */
export const panelsOnTab = (tab: MachineTabId): readonly string[] =>
  PANEL_GROUPS.filter(group => group.tab === tab).flatMap(group => group.panels);

/** The tab a panel is opened from, or `undefined` for a word that names no panel. */
export const panelTab = (panel: string): MachineTabId | undefined => PANEL_TABS.get(panel);

/**
 * The words on a panel's navigation row, where they differ from the panel's own title: the row says what
 * a person is looking for ("Passkeys"), the page it opens keeps the longer name.
 */
export const PANEL_NAMES: Readonly<Record<string, string>> = {
  security: 'Passkeys',
  carrier: 'Connection',
  'resource-limits': 'Ferret limits',
  'agent-clis': 'Agent tools',
  'security-log': 'Security log',
  terminals: 'Terminal slots',
  'model-pricing': 'Model pricing',
  files: 'Settings files',
  about: 'Version and updates',
};
