/**
 * The Agents tab: how agents behave on this machine, in the order a person reaches for it — what they may
 * do (permissions, what they may control), then one "More" list: who supervises them (the Warden), how they
 * come back (auto-resume, agenda mode, conversations), and the learning and pack panels.
 *
 * The settings themselves are `settings-tab.tsx`'s sections and rows, so onboarding and this tab share one
 * implementation. The Warden and the learning and pack panels are the daemon's own panels, asked of the panel
 * frame as one group (`machine-panels.ts`) whose list starts with this tab's switch rows.
 */

import type { ReactNode } from 'react';
import { useSettingsFlow } from '../setup/settings-route.ts';
import { useSetupAccess } from '../setup/setup-access.ts';
import { type PanelGroupId, panelGroup } from '../shell/machine-panels.ts';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import {
  AgendaModeRows,
  AgentControlSection,
  AgentPermissionsSection,
  AutoResumeRows,
  ConversationsRows,
} from './settings-tab.tsx';

export function AgentsTab(props: MachineTabProps & { readonly browser?: Window }) {
  const { machine, machineName, checking, connection, createClient, onRetry, daemonPanels, browser } = props;
  const onSaved = props.onRefresh ?? onRetry;
  const route = useSettingsFlow(machineName, browser, 'agents');
  const access = useSetupAccess({ connection, createClient });
  const group = (id: PanelGroupId, lead?: ReactNode): ReactNode => daemonPanels?.(undefined, route.openPanel, id, lead);
  // With no panel frame (a test, a harness) the tab draws the same one list itself, so the switches are never missing.
  const more = (lead: ReactNode): ReactNode =>
    daemonPanels === undefined ? (
      <section className="flex min-w-0 flex-col gap-2" data-setup-section="more">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">{panelGroup('more').label}</h4>
        <ul className="kt-groupcard m-0 list-none p-0" aria-label={`${machineName} more`}>
          {lead}
        </ul>
      </section>
    ) : (
      group('more', lead)
    );

  // A panel is a page of its own, so a link to one shows it even while the machine is not answering.
  if (route.panel !== null && daemonPanels !== undefined) return daemonPanels(route.panel, route.openPanel);

  if (machine === null)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <p role="status" className="m-0 text-cell text-muted" data-agents-waiting="">
          {checking ? `Checking ${machineName}…` : `${machineName}’s agent settings show once it answers.`}
        </p>
        {group('more')}
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
      {more(
        <>
          <AutoResumeRows
            key={String(machine.autoResume)}
            machine={machine}
            machineName={machineName}
            access={access}
            onSaved={onSaved}
          />
          <AgendaModeRows
            key={`agenda-${String(machine.agendaMode)}`}
            machine={machine}
            machineName={machineName}
            access={access}
            onSaved={onSaved}
          />
          <ConversationsRows daemonId={connection.daemonId} access={access} />
        </>,
      )}
    </div>
  );
}
