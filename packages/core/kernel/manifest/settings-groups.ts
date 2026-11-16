/**
 * THE GROUPS A DAEMON'S SETTINGS PAGE IS DRAWN IN. A person looks for a setting by what it is FOR, so the page lists
 * its tabs under these headings (v4's `machine-panels.ts` groups: Supervision, More agent settings, Sites and secrets,
 * Devices & access, Health, Tools, Advanced, About, and the Behaviour section). A plugin names its tab's group on the
 * tab (`settingsTab('warden', { group: 'supervision', … })`), so the shell never names a plugin: it knows only these
 * ids, their headings and their order. A tab that names none is listed last, under "More".
 */
export const SETTINGS_GROUPS = [
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'agents', label: 'Agents and logins' },
  { id: 'supervision', label: 'Supervision' },
  { id: 'agent-settings', label: 'More agent settings' },
  { id: 'sites', label: 'Sites and secrets' },
  { id: 'devices-access', label: 'Devices & access' },
  { id: 'health', label: 'Health' },
  { id: 'tools', label: 'Tools' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];
