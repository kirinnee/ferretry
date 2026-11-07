import type { BrowserMode, FleetAgentControl, FleetMachineView } from '@ferretry/protocol';

type AgentPermissions = FleetMachineView['agentPermissions'];

/** The things a `machine.settings` change always carries, unchanged unless the caller means
 *  to change one of them — so a section that edits only one never clobbers the other two. */
export const machineSettings = (
  machine: FleetMachineView,
  edit: Partial<{
    readonly agentPermissions: AgentPermissions;
    readonly defaultRuntime: string | null;
    readonly agentControl: FleetAgentControl;
    readonly browserMode: BrowserMode;
    readonly browserProxy: FleetMachineView['browserProxy'];
    readonly autoResume: boolean;
    readonly agendaMode: boolean;
  }>,
) => ({
  kind: 'machine.settings' as const,
  agentPermissions: machine.agentPermissions,
  defaultRuntime: machine.defaultRuntime,
  agentControl: machine.agentControl,
  // Sent only to a daemon that has the setting: an older one refuses a field it does not know.
  ...(machine.browserMode === undefined ? {} : { browserMode: machine.browserMode }),
  ...edit,
});
