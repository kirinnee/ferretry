/**
 * The Agents tab: how agents behave on this machine, in the order a person reaches for it — what they may
 * do (permissions, what they may control), who supervises them (the Warden), and how they come back
 * (auto-resume, agenda mode, conversations).
 *
 * The settings themselves are `settings-tab.tsx`'s sections, so onboarding and this tab share one
 * implementation. The Warden and the learning and pack panels are the daemon's own panels, asked of the panel
 * frame as groups (`machine-panels.ts`) so each sits on the tab it belongs to.
 */

import type { ReactNode } from 'react';
import { useSettingsFlow } from '../setup/settings-route.ts';
import { useSetupAccess } from '../setup/setup-access.ts';
import type { PanelGroupId } from '../shell/machine-panels.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import {
  AgendaModeSection,
  AgentControlSection,
  AgentPermissionsSection,
  AutoResumeSection,
  ConversationsSection,
} from './settings-tab.tsx';

export function AgentsTab(props: MachineTabProps & { readonly browser?: Window }) {
  const { machine, machineName, checking, connection, createClient, onRetry, daemonPanels, browser } = props;
  const onSaved = props.onRefresh ?? onRetry;
  const route = useSettingsFlow(machineName, browser, 'agents');
  const access = useSetupAccess({ connection, createClient });
  const group = (id: PanelGroupId): ReactNode => daemonPanels?.(undefined, route.openPanel, id);

  // A panel is a page of its own, so a link to one shows it even while the machine is not answering.
  if (route.panel !== null && daemonPanels !== undefined) return daemonPanels(route.panel, route.openPanel);

  if (machine === null)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <p role="status" className="m-0 text-cell text-muted" data-agents-waiting="">
          {checking ? `Checking ${machineName}…` : `${machineName}’s agent settings show once it answers.`}
        </p>
        {group('supervision')}
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-agents-tab="">
      <AgentPermissionsSection
        key={machine.agentPermissions}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <AgentControlSection
        key={Object.values(machine.agentControl).join(',')}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      {group('supervision')}
      <AutoResumeSection
        key={String(machine.autoResume)}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <AgendaModeSection
        key={`agenda-${String(machine.agendaMode)}`}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <ConversationsSection daemonId={connection.daemonId} access={access} />
      {group('agent-settings')}
    </div>
  );
}
