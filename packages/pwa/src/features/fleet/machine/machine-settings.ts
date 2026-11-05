import type { BrowserMode, FleetAgentControl, FleetMachineView } from '@ferretry/protocol';
import { createContext } from 'react';

type AgentPermissions = FleetMachineView['agentPermissions'];

/** What one section of the Machine tab changes in a `machine.settings` change. */
export type MachineSettingsEdit = Partial<{
  readonly agentPermissions: AgentPermissions;
  readonly defaultRuntime: string | null;
  readonly agentControl: FleetAgentControl;
  readonly browserMode: BrowserMode;
  readonly browserProxy: FleetMachineView['browserProxy'];
  readonly autoResume: boolean;
  readonly agendaMode: boolean;
}>;

/**
 * Where a section reports its unsaved edit (`null` once there is none) when the page around it saves
 * every section in one change — New machine setup's Agent controls. `null` in Settings, where each
 * section keeps its own Save.
 */
export const MachineEditContext = createContext<((key: string, edit: MachineSettingsEdit | null) => void) | null>(null);

/** The things a `machine.settings` change always carries, unchanged unless the caller means
 *  to change one of them — so a section that edits only one never clobbers the other two. */
export const machineSettings = (machine: FleetMachineView, edit: MachineSettingsEdit) => ({
  kind: 'machine.settings' as const,
  agentPermissions: machine.agentPermissions,
  defaultRuntime: machine.defaultRuntime,
  agentControl: machine.agentControl,
  // Sent only to a daemon that has the setting: an older one refuses a field it does not know.
  ...(machine.browserMode === undefined ? {} : { browserMode: machine.browserMode }),
  ...edit,
});
