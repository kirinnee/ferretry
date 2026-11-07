import type { AccountChange, MachineView } from '../../../../contract/index.ts';

type MachineSettingsChange = Extract<AccountChange, { kind: 'machine.settings' }>;
type Edit = Partial<Omit<MachineSettingsChange, 'kind'>>;

/**
 * The things a `machine.settings` change always carries, unchanged unless the caller means to change one of them — so
 * a section that edits only one never clobbers the others (the wire takes them all together).
 */
export const machineSettings = (machine: MachineView, edit: Edit): MachineSettingsChange => ({
  kind: 'machine.settings',
  agentPermissions: machine.agentPermissions,
  defaultRuntime: machine.defaultRuntime,
  agentControl: machine.agentControl,
  browserMode: machine.browserMode,
  browserProxy: machine.browserProxy,
  browserPorts: machine.browserPorts,
  browserFirewallFailure: machine.browserFirewallFailure,
  autoResume: machine.autoResume,
  agendaMode: machine.agendaMode,
  publicUsageFeed: machine.publicUsageFeed,
  ...edit,
});
